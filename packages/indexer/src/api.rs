//! Read-only HTTP API consumed by the Next.js dashboard.

use crate::store::Store;
use crate::sync::now_secs;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

const MAX_EVENTS: i64 = 500;
const DEFAULT_EVENTS: i64 = 100;
const SCHEDULE_STATUSES: [&str; 4] = ["pending", "executed", "failed", "deleted"];

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub overdue_grace_secs: i64,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/plans", get(plans))
        .route("/plans/:id", get(plan))
        .route("/events", get(events))
        .route("/schedules", get(schedules))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

enum ApiError {
    NotFound(&'static str),
    BadRequest(String),
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self::Internal(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m.to_string()),
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            Self::Internal(e) => {
                tracing::error!(error = %e, "request failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

type ApiResult = Result<Json<Value>, ApiError>;

async fn health(State(s): State<AppState>) -> ApiResult {
    let last_ok = s.store.meta("last_sync_ok")?.and_then(|v| v.parse::<i64>().ok());
    let last_error = s.store.meta("last_error")?.filter(|e| !e.is_empty());
    Ok(Json(json!({
        "status": "ok",
        "lastSyncOkAt": last_ok,
        "secondsSinceSync": last_ok.map(|t| now_secs() - t),
        "lastError": last_error,
        "cursor": s.store.cursor()?.map(crate::mirror::format_timestamp),
    })))
}

async fn plans(State(s): State<AppState>) -> ApiResult {
    Ok(Json(
        json!({ "plans": s.store.list_plans(now_secs(), s.overdue_grace_secs)? }),
    ))
}

async fn plan(State(s): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let mut plan = s
        .store
        .get_plan(id, now_secs(), s.overdue_grace_secs)?
        .ok_or(ApiError::NotFound("plan not found"))?;
    plan["events"] = json!(s.store.events(Some(id), MAX_EVENTS)?);
    Ok(Json(plan))
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(rename = "planId")]
    plan_id: Option<i64>,
    limit: Option<i64>,
}

async fn events(State(s): State<AppState>, Query(q): Query<EventsQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(DEFAULT_EVENTS);
    if !(1..=MAX_EVENTS).contains(&limit) {
        return Err(ApiError::BadRequest(format!(
            "limit must be between 1 and {MAX_EVENTS}"
        )));
    }
    Ok(Json(json!({ "events": s.store.events(q.plan_id, limit)? })))
}

#[derive(Deserialize)]
struct SchedulesQuery {
    status: Option<String>,
}

async fn schedules(State(s): State<AppState>, Query(q): Query<SchedulesQuery>) -> ApiResult {
    if let Some(status) = &q.status {
        if !SCHEDULE_STATUSES.contains(&status.as_str()) {
            return Err(ApiError::BadRequest(format!(
                "status must be one of {}",
                SCHEDULE_STATUSES.join(", ")
            )));
        }
    }
    Ok(Json(
        json!({ "schedules": s.store.schedules(None, q.status.as_deref())? }),
    ))
}
