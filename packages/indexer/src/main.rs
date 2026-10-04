use anyhow::{Context, Result};
use schedule_ledger_indexer::{api, config::Config, mirror::MirrorClient, store::Store, sync};
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    load_dotenv();

    let cfg = Arc::new(Config::from_env()?);
    let store = Arc::new(Store::open(&cfg.database_path).with_context(|| format!("opening {}", cfg.database_path))?);
    let mirror = MirrorClient::new(&cfg.mirror_url)?;

    info!(contract = %cfg.contract, mirror = %cfg.mirror_url, db = %cfg.database_path, "starting indexer");

    let syncer = tokio::spawn(sync::run(cfg.clone(), mirror, store.clone(), shutdown_signal()));

    let app = api::router(api::AppState {
        store,
        overdue_grace_secs: cfg.overdue_grace_secs,
    });
    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr)
        .await
        .with_context(|| format!("binding {}", cfg.bind_addr))?;
    info!(addr = %cfg.bind_addr, "api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    syncer.await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Minimal `.env` loader (KEY=VALUE lines) so the indexer needs no extra dependency.
/// Variables already set in the environment win.
fn load_dotenv() {
    let Ok(contents) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, value.trim().trim_matches('"'));
            }
        }
    }
}
