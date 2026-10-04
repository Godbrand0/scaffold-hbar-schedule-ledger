//! The sync loop: pull new logs, store them, then follow pending HSS schedules to their outcome.

use crate::config::Config;
use crate::events;
use crate::mirror::{parse_timestamp, MirrorClient, RawLog};
use crate::store::{Store, StoredEvent};
use alloy_primitives::B256;
use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::{debug, info, warn};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub new_events: usize,
    pub schedules_resolved: usize,
}

/// One full pass. Safe to call repeatedly; every step is idempotent.
pub async fn sync_once(cfg: &Config, mirror: &MirrorClient, store: &Store) -> Result<SyncReport> {
    let after = store.cursor()?;
    let logs = mirror.contract_logs(&cfg.contract, after).await?;

    let (stored, cursor) = decode_logs(&logs)?;
    let new_events = store.apply_batch(&stored, cursor)?;
    if new_events > 0 {
        info!(new_events, "stored new contract events");
    }

    let schedules_resolved = refresh_schedules(mirror, store).await?;
    Ok(SyncReport {
        new_events,
        schedules_resolved,
    })
}

/// Decode a page of logs. Logs that are not ours are skipped, and a log with a known signature but a
/// bad body is skipped with a warning instead of stalling the whole indexer. The returned cursor still
/// moves past every log so skipped ones are not refetched forever.
fn decode_logs(logs: &[RawLog]) -> Result<(Vec<StoredEvent>, Option<i64>)> {
    let mut stored = Vec::new();
    let mut cursor: Option<i64> = None;
    for log in logs {
        let ts = parse_timestamp(&log.timestamp)?;
        cursor = Some(cursor.map_or(ts, |c| c.max(ts)));
        match decode_log(log) {
            Ok(Some(event)) => stored.push(StoredEvent {
                consensus_ts: ts,
                log_index: log.index,
                tx_hash: log.transaction_hash.clone(),
                event,
            }),
            Ok(None) => debug!(timestamp = %log.timestamp, "ignoring log from an unknown event"),
            Err(err) => warn!(timestamp = %log.timestamp, index = log.index, error = %err, "skipping undecodable log"),
        }
    }
    Ok((stored, cursor))
}

fn decode_log(log: &RawLog) -> Result<Option<events::LedgerEvent>> {
    let topics = log
        .topics
        .iter()
        .map(|t| t.parse::<B256>().with_context(|| format!("bad topic {t}")))
        .collect::<Result<Vec<_>>>()?;
    let data = alloy_primitives::hex::decode(&log.data).context("bad log data hex")?;
    events::decode(&topics, &data)
}

/// Look up every pending schedule on the mirror node and record its outcome.
/// A schedule stays pending until the mirror node shows it executed or deleted.
async fn refresh_schedules(mirror: &MirrorClient, store: &Store) -> Result<usize> {
    let mut resolved = 0;
    for pending in store.pending_schedules()? {
        let Some(info) = mirror.schedule(&pending.schedule_id).await? else {
            debug!(schedule = %pending.schedule_id, "schedule not visible on the mirror node yet");
            continue;
        };
        if info.deleted {
            store.resolve_schedule(&pending.schedule_id, "deleted", None, None)?;
            resolved += 1;
        } else if let Some(executed) = info.executed_timestamp {
            let Some(tx) = mirror.scheduled_transaction(&executed).await? else {
                debug!(schedule = %pending.schedule_id, "execution record not visible yet");
                continue;
            };
            let status = if tx.result == "SUCCESS" { "executed" } else { "failed" };
            if status == "failed" {
                warn!(schedule = %pending.schedule_id, result = %tx.result, "scheduled execution failed");
            }
            store.resolve_schedule(
                &pending.schedule_id,
                status,
                Some(parse_timestamp(&executed)?),
                Some(&tx.result),
            )?;
            resolved += 1;
        }
    }
    Ok(resolved)
}

/// Run forever (until `shutdown` resolves), recording success or the last error in `meta`
/// so `/health` can report staleness.
pub async fn run(
    cfg: Arc<Config>,
    mirror: MirrorClient,
    store: Arc<Store>,
    shutdown: impl std::future::Future<Output = ()>,
) {
    tokio::pin!(shutdown);
    loop {
        match sync_once(&cfg, &mirror, &store).await {
            Ok(_) => {
                let _ = store.set_meta("last_sync_ok", &now_secs().to_string());
                let _ = store.set_meta("last_error", "");
            }
            Err(err) => {
                warn!(error = %err, "sync failed, will retry");
                let _ = store.set_meta("last_error", &format!("{err:#}"));
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(cfg.poll_interval) => {}
            _ = &mut shutdown => break,
        }
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
