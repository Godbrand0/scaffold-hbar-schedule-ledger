//! End-to-end tests: a fake mirror node (real HTTP, real JSON) feeds the real sync loop, SQLite store
//! and HTTP API. Logs are produced by ABI-encoding the contract's events with the same `sol!` types.

use alloy_primitives::{address, hex, Address, U256};
use alloy_sol_types::SolEvent;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use http_body_util::BodyExt;
use schedule_ledger_indexer::api::{router, AppState};
use schedule_ledger_indexer::config::Config;
use schedule_ledger_indexer::events::*;
use schedule_ledger_indexer::mirror::MirrorClient;
use schedule_ledger_indexer::store::Store;
use schedule_ledger_indexer::sync::{sync_once, SyncReport};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const OWNER: Address = address!("00000000000000000000000000000000000000a1");
const RECIPIENT: Address = address!("00000000000000000000000000000000000000b2");
// Long-zero address of schedule 0.0.1000.
const SCHEDULE_ADDR: Address = address!("00000000000000000000000000000000000003e8");
const PAGE_SIZE: usize = 2;

#[derive(Default)]
struct Mirror {
    logs: Vec<Value>,
    schedules: HashMap<String, Value>,
    transactions: HashMap<String, Value>,
    fail_logs: bool,
}

type Shared = Arc<Mutex<Mirror>>;

fn log(ts: &str, index: u32, e: &impl SolEvent) -> Value {
    let data = e.encode_log_data();
    json!({
        "timestamp": ts,
        "index": index,
        "topics": data.topics().iter().map(hex::encode_prefixed).collect::<Vec<_>>(),
        "data": hex::encode_prefixed(&data.data),
        "transaction_hash": format!("0xhash{ts}"),
    })
}

fn plan_created(ts: &str) -> Value {
    log(
        ts,
        0,
        &PlanCreated {
            planId: U256::from(1),
            owner: OWNER,
            recipient: RECIPIENT,
            amountPerRun: U256::from(500),
            usdPerRun: U256::from(0),
            feeReservePerRun: U256::from(250),
            intervalSeconds: 3600,
            totalRuns: 3,
        },
    )
}

fn booked(ts: &str, run: u32, expiry: u64) -> Value {
    log(
        ts,
        1,
        &ScheduleBooked {
            planId: U256::from(1),
            runIndex: run,
            scheduleAddress: SCHEDULE_ADDR,
            expirySecond: U256::from(expiry),
        },
    )
}

async fn fake_logs(
    State(m): State<Shared>,
    Path(_c): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, StatusCode> {
    let m = m.lock().unwrap();
    if m.fail_logs {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let after = q["timestamp"].trim_start_matches("gt:").to_string();
    let after_nanos = nanos(&after);
    let all: Vec<&Value> = m
        .logs
        .iter()
        .filter(|l| nanos(l["timestamp"].as_str().unwrap()) > after_nanos)
        .collect();
    let offset: usize = q.get("offset").and_then(|o| o.parse().ok()).unwrap_or(0);
    let page: Vec<&Value> = all.iter().skip(offset).take(PAGE_SIZE).copied().collect();
    let next = (offset + PAGE_SIZE < all.len()).then(|| {
        format!(
            "/api/v1/contracts/x/results/logs?order=asc&limit={PAGE_SIZE}&timestamp=gt:{after}&offset={}",
            offset + PAGE_SIZE
        )
    });
    Ok(Json(json!({ "logs": page, "links": { "next": next } })))
}

fn nanos(ts: &str) -> i64 {
    schedule_ledger_indexer::mirror::parse_timestamp(ts).unwrap()
}

async fn fake_schedule(State(m): State<Shared>, Path(id): Path<String>) -> Result<Json<Value>, StatusCode> {
    m.lock()
        .unwrap()
        .schedules
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn fake_transactions(State(m): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let txs: Vec<Value> = m
        .lock()
        .unwrap()
        .transactions
        .get(&q["timestamp"])
        .cloned()
        .into_iter()
        .collect();
    Json(json!({ "transactions": txs }))
}

struct Harness {
    mirror: Shared,
    client: MirrorClient,
    store: Arc<Store>,
    cfg: Config,
}

impl Harness {
    async fn new() -> Self {
        let mirror: Shared = Arc::default();
        let app = Router::new()
            .route("/api/v1/contracts/:contract/results/logs", get(fake_logs))
            .route("/api/v1/schedules/:id", get(fake_schedule))
            .route("/api/v1/transactions", get(fake_transactions))
            .with_state(mirror.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let cfg = Config::from_lookup(|k| match k {
            "CONTRACT_ADDRESS" => Some("0.0.1234".into()),
            "MIRROR_NODE_URL" => Some(base.clone()),
            _ => None,
        })
        .unwrap();
        Self {
            client: MirrorClient::new(&base).unwrap(),
            store: Arc::new(Store::open_in_memory().unwrap()),
            mirror,
            cfg,
        }
    }

    fn push_logs(&self, logs: Vec<Value>) {
        self.mirror.lock().unwrap().logs.extend(logs);
    }

    fn set_schedule(&self, id: &str, deleted: bool, executed: Option<&str>) {
        self.mirror
            .lock()
            .unwrap()
            .schedules
            .insert(id.into(), json!({ "deleted": deleted, "executed_timestamp": executed }));
    }

    fn set_transaction(&self, ts: &str, result: &str) {
        self.mirror.lock().unwrap().transactions.insert(
            ts.into(),
            json!({ "name": "CONTRACTCALL", "result": result, "scheduled": true }),
        );
    }

    async fn sync(&self) -> SyncReport {
        sync_once(&self.cfg, &self.client, &self.store).await.unwrap()
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let app = router(AppState {
            store: self.store.clone(),
            overdue_grace_secs: 60,
        });
        let res = app
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn follows_a_plan_from_creation_to_a_successful_run() {
    let h = Harness::new().await;
    h.push_logs(vec![
        plan_created("2000.000000001"),
        booked("2000.000000001", 1, 5_000_000_000),
    ]);
    h.set_schedule("0.0.1000", false, None);

    let report = h.sync().await;
    assert_eq!(report.new_events, 2);

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "active");
    assert_eq!(plan["amountPerRun"], "500");
    assert_eq!(plan["feeReservePerRun"], "250");
    assert_eq!(plan["usdPerRun"], "0");
    assert_eq!(plan["schedules"][0]["status"], "pending");
    assert_eq!(plan["schedules"][0]["scheduleId"], "0.0.1000");

    // HSS fires the run: the mirror node shows the execution, the contract emits PaymentExecuted.
    h.set_schedule("0.0.1000", false, Some("5000.000000001"));
    h.set_transaction("5000.000000001", "SUCCESS");
    h.push_logs(vec![log(
        "5000.000000001",
        0,
        &PaymentExecuted {
            planId: U256::from(1),
            runIndex: 1,
            recipient: RECIPIENT,
            amount: U256::from(500),
            hbarUsdPrice: U256::from(0),
        },
    )]);
    let report = h.sync().await;
    assert_eq!(
        report,
        SyncReport {
            new_events: 1,
            schedules_resolved: 1
        }
    );

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["completedRuns"], 1);
    assert_eq!(plan["schedules"][0]["status"], "executed");
    assert_eq!(plan["schedules"][0]["result"], "SUCCESS");
    assert_eq!(plan["needsAttention"], false);
    assert_eq!(plan["events"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn syncing_twice_is_idempotent_and_pages_through_all_logs() {
    let h = Harness::new().await;
    // 5 logs with PAGE_SIZE 2 forces three pages.
    let mut logs = vec![plan_created("2000.000000001")];
    for i in 1..=4u32 {
        logs.push(log(
            &format!("{}.000000001", 2000 + i),
            0,
            &PlanResumed { planId: U256::from(1) },
        ));
    }
    h.push_logs(logs);

    assert_eq!(h.sync().await.new_events, 5);
    assert_eq!(h.sync().await.new_events, 0);

    let (_, events) = h.get("/events").await;
    assert_eq!(events["events"].as_array().unwrap().len(), 5);
    let (_, health) = h.get("/health").await;
    assert_eq!(health["cursor"], "2004.000000001");
}

#[tokio::test]
async fn a_failed_scheduled_execution_flags_the_plan() {
    let h = Harness::new().await;
    h.push_logs(vec![
        plan_created("2000.000000001"),
        booked("2000.000000001", 1, 5_000_000_000),
    ]);
    h.set_schedule("0.0.1000", false, Some("5000.000000001"));
    h.set_transaction("5000.000000001", "CONTRACT_REVERT_EXECUTED");

    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["schedules"][0]["status"], "failed");
    assert_eq!(plan["schedules"][0]["result"], "CONTRACT_REVERT_EXECUTED");
    assert_eq!(plan["needsAttention"], true);
    let (_, failed) = h.get("/schedules?status=failed").await;
    assert_eq!(failed["schedules"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn deleted_schedules_are_recorded_after_a_cancel() {
    let h = Harness::new().await;
    h.push_logs(vec![
        plan_created("2000.000000001"),
        booked("2000.000000001", 1, 5_000_000_000),
        log(
            "2100.000000001",
            0,
            &PlanCancelled {
                planId: U256::from(1),
                refunded: U256::from(1500),
            },
        ),
    ]);
    h.set_schedule("0.0.1000", true, None);

    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "cancelled");
    assert_eq!(plan["schedules"][0]["status"], "deleted");
    assert_eq!(plan["needsAttention"], false);
}

#[tokio::test]
async fn contract_level_failures_need_attention() {
    let h = Harness::new().await;
    h.push_logs(vec![
        plan_created("2000.000000001"),
        log(
            "3000.000000001",
            0,
            &ScheduleFailed {
                planId: U256::from(1),
                runIndex: 1,
                responseCode: -1,
                expirySecond: U256::from(9),
            },
        ),
    ]);
    h.sync().await;
    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "needs_reschedule");
    assert_eq!(plan["needsAttention"], true);
    assert!(plan["lastError"].as_str().unwrap().contains("-1"));

    h.push_logs(vec![booked("3500.000000001", 1, 9_000_000_000)]);
    h.set_schedule("0.0.1000", false, None);
    h.sync().await;
    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "active");
    assert_eq!(plan["lastError"], Value::Null);

    h.push_logs(vec![log(
        "4000.000000001",
        0,
        &PaymentFailed {
            planId: U256::from(1),
            runIndex: 1,
            recipient: RECIPIENT,
            amount: U256::from(500),
        },
    )]);
    h.sync().await;
    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "paused");
    assert_eq!(plan["needsAttention"], true);
}

#[tokio::test]
async fn a_pending_run_long_past_its_expiry_is_overdue() {
    let h = Harness::new().await;
    // Expiry is in 1970, so it is far past the grace period.
    h.push_logs(vec![plan_created("2000.000000001"), booked("2000.000000001", 1, 10)]);
    h.set_schedule("0.0.1000", false, None);
    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["overdue"], true);
    assert_eq!(plan["needsAttention"], true);
}

#[tokio::test]
async fn a_schedule_the_mirror_node_does_not_know_yet_stays_pending() {
    let h = Harness::new().await;
    h.push_logs(vec![
        plan_created("2000.000000001"),
        booked("2000.000000001", 1, u64::MAX / 2),
    ]);
    // No schedule registered: the fake mirror answers 404.
    let report = h.sync().await;
    assert_eq!(report.schedules_resolved, 0);
    let (_, pending) = h.get("/schedules?status=pending").await;
    assert_eq!(pending["schedules"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn mirror_outage_does_not_advance_the_cursor_and_recovers() {
    let h = Harness::new().await;
    h.push_logs(vec![plan_created("2000.000000001")]);
    h.mirror.lock().unwrap().fail_logs = true;
    assert!(sync_once(&h.cfg, &h.client, &h.store).await.is_err());
    assert_eq!(h.store.cursor().unwrap(), None);

    h.mirror.lock().unwrap().fail_logs = false;
    assert_eq!(h.sync().await.new_events, 1);
}

#[tokio::test]
async fn undecodable_and_foreign_logs_are_skipped_but_the_cursor_moves_on() {
    let h = Harness::new().await;
    let mut broken = log("2500.000000001", 0, &PlanResumed { planId: U256::from(1) });
    broken["data"] = json!("0xzz"); // not hex
    let foreign = json!({
        "timestamp": "2600.000000001", "index": 0,
        "topics": [hex::encode_prefixed([0x11u8; 32])], "data": "0x", "transaction_hash": "0xforeign",
    });
    h.push_logs(vec![plan_created("2000.000000001"), broken, foreign]);

    assert_eq!(h.sync().await.new_events, 1);
    let (_, health) = h.get("/health").await;
    assert_eq!(health["cursor"], "2600.000000001");
}

#[tokio::test]
async fn api_validates_input_and_reports_missing_plans() {
    let h = Harness::new().await;
    assert_eq!(h.get("/plans/99").await.0, StatusCode::NOT_FOUND);
    assert_eq!(h.get("/plans/not-a-number").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(h.get("/events?limit=0").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(h.get("/events?limit=501").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(h.get("/schedules?status=banana").await.0, StatusCode::BAD_REQUEST);
    let (status, plans) = h.get("/plans").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(plans["plans"], json!([]));
}

#[tokio::test]
async fn events_can_be_filtered_by_plan() {
    let h = Harness::new().await;
    let other = log("2100.000000001", 0, &PlanResumed { planId: U256::from(2) });
    h.push_logs(vec![plan_created("2000.000000001"), other]);
    h.sync().await;
    let (_, all) = h.get("/events").await;
    let (_, one) = h.get("/events?planId=2").await;
    assert_eq!(all["events"].as_array().unwrap().len(), 2);
    assert_eq!(one["events"].as_array().unwrap().len(), 1);
    assert_eq!(one["events"][0]["kind"], "PlanResumed");
}

/// Observed on Hedera testnet: the contract is the payer of its own scheduled call, and when its balance is
/// below gasLimit * gasPrice the network executes the schedule and fails it with INSUFFICIENT_PAYER_BALANCE.
/// The contract emits nothing in that case, so only the mirror node record reveals it.
#[tokio::test]
async fn an_underfunded_payer_failure_is_surfaced_even_though_the_contract_emits_nothing() {
    let h = Harness::new().await;
    h.push_logs(vec![
        plan_created("2000.000000001"),
        booked("2000.000000001", 1, 5_000_000_000),
    ]);
    h.set_schedule("0.0.1000", false, Some("5000.000000001"));
    h.set_transaction("5000.000000001", "INSUFFICIENT_PAYER_BALANCE");

    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "active"); // the contract never learned about the failure
    assert_eq!(plan["completedRuns"], 0);
    assert_eq!(plan["schedules"][0]["result"], "INSUFFICIENT_PAYER_BALANCE");
    assert_eq!(plan["needsAttention"], true);
}

fn usd_plan_created(ts: &str) -> Value {
    log(
        ts,
        0,
        &PlanCreated {
            planId: U256::from(1),
            owner: OWNER,
            recipient: RECIPIENT,
            amountPerRun: U256::from(15_000_000_000u64),
            usdPerRun: U256::from(1_000_000_000u64),
            feeReservePerRun: U256::from(170_000_000u64),
            intervalSeconds: 60,
            totalRuns: 2,
        },
    )
}

/// What the contract emits when a USD plan cannot price a run: `PriceRejected`, then `PaymentFailed` with amount 0.
fn price_rejected_logs(ts: &str, problem: u8) -> Vec<Value> {
    vec![
        log(
            ts,
            0,
            &PriceRejected {
                planId: U256::from(1),
                runIndex: 1,
                problem,
                price: U256::from(103_310_000_000_000_000u64),
                updatedAtMs: U256::from(1_000u64),
            },
        ),
        log(
            ts,
            1,
            &PaymentFailed {
                planId: U256::from(1),
                runIndex: 1,
                recipient: RECIPIENT,
                amount: U256::from(0),
            },
        ),
    ]
}

#[tokio::test]
async fn a_usd_plan_exposes_its_dollar_amount_and_the_price_each_payout_used() {
    let h = Harness::new().await;
    h.push_logs(vec![
        usd_plan_created("2000.000000001"),
        booked("2000.000000001", 1, 9_000_000_000),
    ]);
    h.set_schedule("0.0.1000", false, None);
    h.sync().await;
    h.push_logs(vec![log(
        "3000.000000001",
        0,
        &PaymentExecuted {
            planId: U256::from(1),
            runIndex: 1,
            recipient: RECIPIENT,
            amount: U256::from(9_680_000_000u64),
            hbarUsdPrice: U256::from(103_310_000_000_000_000u64),
        },
    )]);
    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["usdPerRun"], "1000000000");
    assert_eq!(plan["completedRuns"], 1);
    let (_, events) = h.get("/events?planId=1").await;
    let paid = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "PaymentExecuted")
        .unwrap();
    assert_eq!(paid["data"]["amount"], "9680000000");
    assert_eq!(paid["data"]["hbarUsdPrice"], "103310000000000000");
}

#[tokio::test]
async fn a_price_rejection_pauses_the_plan_and_says_why_not_that_the_recipient_rejected() {
    let h = Harness::new().await;
    h.push_logs(vec![
        usd_plan_created("2000.000000001"),
        booked("2000.000000001", 1, 9_000_000_000),
    ]);
    h.set_schedule("0.0.1000", false, None);
    h.sync().await;
    h.push_logs(price_rejected_logs("4000.000000001", 3));
    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "paused");
    assert_eq!(plan["needsAttention"], true);
    let reason = plan["lastError"].as_str().unwrap();
    assert!(
        reason.contains("Supra") && reason.contains("stale"),
        "unexpected reason: {reason}"
    );
    assert!(!reason.contains("recipient"), "must not blame the recipient: {reason}");
}

#[tokio::test]
async fn every_price_problem_gets_its_own_explanation() {
    let expected = [
        (1u8, "oracle call failed"),
        (2, "no usable price"),
        (3, "stale"),
        (4, "exceed the per-run cap"),
    ];
    for (problem, fragment) in expected {
        let h = Harness::new().await;
        h.push_logs(vec![
            usd_plan_created("2000.000000001"),
            booked("2000.000000001", 1, 9_000_000_000),
        ]);
        h.set_schedule("0.0.1000", false, None);
        h.sync().await;
        h.push_logs(price_rejected_logs("4000.000000001", problem));
        h.sync().await;
        let (_, plan) = h.get("/plans/1").await;
        let reason = plan["lastError"].as_str().unwrap().to_string();
        assert!(reason.contains(fragment), "problem {problem}: {reason}");
    }
}

#[tokio::test]
async fn resuming_after_a_price_rejection_clears_the_reason() {
    let h = Harness::new().await;
    h.push_logs(vec![
        usd_plan_created("2000.000000001"),
        booked("2000.000000001", 1, 9_000_000_000),
    ]);
    h.set_schedule("0.0.1000", false, None);
    h.sync().await;
    h.push_logs(price_rejected_logs("4000.000000001", 3));
    h.sync().await;
    h.push_logs(vec![log("5000.000000001", 0, &PlanResumed { planId: U256::from(1) })]);
    h.sync().await;

    let (_, plan) = h.get("/plans/1").await;
    assert_eq!(plan["status"], "active");
    assert_eq!(plan["lastError"], Value::Null);
}
