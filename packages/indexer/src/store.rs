//! SQLite storage. Events are the source of truth; `plans` is derived from them as they are applied.
//! Writes are idempotent: the primary key is the log's (consensus timestamp, log index).

use crate::events::{price_problem, schedule_id_from_address, LedgerEvent};
use crate::mirror::format_timestamp;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Mutex;

pub struct StoredEvent {
    pub consensus_ts: i64,
    pub log_index: u32,
    pub tx_hash: String,
    pub event: LedgerEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSchedule {
    pub schedule_id: String,
}

pub struct Store {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
    consensus_ts INTEGER NOT NULL,
    log_index    INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    plan_id      INTEGER NOT NULL,
    run_index    INTEGER,
    payload      TEXT    NOT NULL,
    tx_hash      TEXT    NOT NULL,
    PRIMARY KEY (consensus_ts, log_index)
);
CREATE INDEX IF NOT EXISTS events_by_plan ON events (plan_id, consensus_ts, log_index);
CREATE TABLE IF NOT EXISTS plans (
    plan_id          INTEGER PRIMARY KEY,
    owner            TEXT    NOT NULL,
    recipient        TEXT    NOT NULL,
    amount_per_run   TEXT    NOT NULL,
    usd_per_run      TEXT    NOT NULL,
    fee_reserve_per_run TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    total_runs       INTEGER NOT NULL,
    completed_runs   INTEGER NOT NULL DEFAULT 0,
    status           TEXT    NOT NULL,
    next_run_at      INTEGER,
    last_error       TEXT,
    created_ts       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
    schedule_id   TEXT PRIMARY KEY,
    plan_id       INTEGER NOT NULL,
    run_index     INTEGER NOT NULL,
    expiry_second INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    executed_ts   INTEGER,
    result        TEXT
);
CREATE INDEX IF NOT EXISTS schedules_by_plan ON schedules (plan_id, run_index);
";

impl Store {
    pub fn open(path: &str) -> Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A poisoned lock only means another thread panicked mid-query; the data is still consistent
        // because every write below runs inside a SQLite transaction.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn cursor(&self) -> Result<Option<i64>> {
        Ok(self.meta("cursor")?.and_then(|v| v.parse().ok()))
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Store events, update derived state and advance the cursor in one transaction.
    /// Returns how many events were new. Replaying an event is a no-op.
    pub fn apply_batch(&self, events: &[StoredEvent], new_cursor: Option<i64>) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut inserted = 0;
        for e in events {
            let changed = tx.execute(
                "INSERT OR IGNORE INTO events (consensus_ts, log_index, kind, plan_id, run_index, payload, tx_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    e.consensus_ts,
                    e.log_index,
                    e.event.kind(),
                    e.event.plan_id() as i64,
                    e.event.run_index(),
                    e.event.to_json().to_string(),
                    e.tx_hash
                ],
            )?;
            if changed == 1 {
                inserted += 1;
                apply_to_state(&tx, e)?;
            }
        }
        if let Some(cursor) = new_cursor {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('cursor', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value
                 WHERE CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER)",
                [cursor.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(inserted)
    }

    pub fn pending_schedules(&self) -> Result<Vec<PendingSchedule>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT schedule_id FROM schedules WHERE status = 'pending' ORDER BY expiry_second")?;
        let rows = stmt.query_map([], |r| Ok(PendingSchedule { schedule_id: r.get(0)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn resolve_schedule(
        &self,
        schedule_id: &str,
        status: &str,
        executed_ts: Option<i64>,
        result: Option<&str>,
    ) -> Result<()> {
        self.conn().execute(
            "UPDATE schedules SET status = ?2, executed_ts = ?3, result = ?4 WHERE schedule_id = ?1",
            params![schedule_id, status, executed_ts, result],
        )?;
        Ok(())
    }

    pub fn list_plans(&self, now_secs: i64, grace_secs: i64) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT plan_id FROM plans ORDER BY plan_id DESC")?;
        let ids: Vec<i64> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        ids.into_iter()
            .filter_map(|id| plan_json(&conn, id, now_secs, grace_secs).transpose())
            .collect()
    }

    pub fn get_plan(&self, plan_id: i64, now_secs: i64, grace_secs: i64) -> Result<Option<Value>> {
        plan_json(&self.conn(), plan_id, now_secs, grace_secs)
    }

    pub fn events(&self, plan_id: Option<i64>, limit: i64) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT consensus_ts, log_index, kind, plan_id, run_index, payload, tx_hash FROM events
             WHERE (?1 IS NULL OR plan_id = ?1) ORDER BY consensus_ts DESC, log_index DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![plan_id, limit], |r| {
            let payload: String = r.get(5)?;
            Ok(json!({
                "consensusTimestamp": format_timestamp(r.get(0)?),
                "logIndex": r.get::<_, i64>(1)?,
                "kind": r.get::<_, String>(2)?,
                "planId": r.get::<_, i64>(3)?,
                "runIndex": r.get::<_, Option<i64>>(4)?,
                "data": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
                "transactionHash": r.get::<_, String>(6)?,
            }))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn schedules(&self, plan_id: Option<i64>, status: Option<&str>) -> Result<Vec<Value>> {
        schedules_json(&self.conn(), plan_id, status)
    }
}

fn apply_to_state(tx: &rusqlite::Transaction<'_>, e: &StoredEvent) -> Result<()> {
    let plan_id = e.event.plan_id() as i64;
    match &e.event {
        LedgerEvent::PlanCreated {
            owner,
            recipient,
            amount_per_run,
            usd_per_run,
            fee_reserve_per_run,
            interval_seconds,
            total_runs,
            ..
        } => {
            tx.execute(
                "INSERT OR IGNORE INTO plans (plan_id, owner, recipient, amount_per_run, usd_per_run, fee_reserve_per_run, interval_seconds, total_runs, status, created_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9)",
                params![
                    plan_id,
                    owner.to_string(),
                    recipient.to_string(),
                    amount_per_run,
                    usd_per_run,
                    fee_reserve_per_run,
                    interval_seconds,
                    total_runs,
                    e.consensus_ts
                ],
            )?;
        }
        LedgerEvent::ScheduleBooked {
            run_index,
            schedule_address,
            expiry_second,
            ..
        } => {
            tx.execute(
                "UPDATE plans SET status = 'active', next_run_at = ?2, last_error = NULL WHERE plan_id = ?1",
                params![plan_id, *expiry_second as i64],
            )?;
            if let Some(schedule_id) = schedule_id_from_address(schedule_address) {
                tx.execute(
                    "INSERT OR IGNORE INTO schedules (schedule_id, plan_id, run_index, expiry_second) VALUES (?1, ?2, ?3, ?4)",
                    params![schedule_id, plan_id, run_index, *expiry_second as i64],
                )?;
            }
        }
        LedgerEvent::ScheduleFailed { response_code, .. } => {
            tx.execute(
                "UPDATE plans SET status = 'needs_reschedule', last_error = ?2 WHERE plan_id = ?1",
                params![
                    plan_id,
                    format!("HSS refused to book the next run (code {response_code})")
                ],
            )?;
        }
        LedgerEvent::PaymentExecuted { run_index, .. } => {
            tx.execute(
                "UPDATE plans SET completed_runs = ?2 WHERE plan_id = ?1",
                params![plan_id, run_index],
            )?;
        }
        // A USD plan that cannot price a run emits `PriceRejected` (which explains why) and then `PaymentFailed` with
        // amount 0. Only a real transfer failure carries an amount, so only that one writes the recipient message.
        LedgerEvent::PaymentFailed { run_index, amount, .. } => {
            if amount == "0" {
                tx.execute("UPDATE plans SET status = 'paused' WHERE plan_id = ?1", [plan_id])?;
            } else {
                tx.execute(
                    "UPDATE plans SET status = 'paused', last_error = ?2 WHERE plan_id = ?1",
                    params![plan_id, format!("recipient rejected payment for run {run_index}")],
                )?;
            }
        }
        LedgerEvent::PriceRejected {
            run_index,
            problem,
            price,
            ..
        } => {
            let why = match price_problem(*problem) {
                "OracleReverted" => "the Supra oracle call failed".to_string(),
                "ZeroPrice" => "Supra returned no usable price".to_string(),
                "Stale" => format!("Supra's price is stale (last {price})"),
                "AboveCap" => format!("the payout would exceed the per-run cap at price {price}"),
                other => format!("price rejected ({other})"),
            };
            tx.execute(
                "UPDATE plans SET status = 'paused', last_error = ?2 WHERE plan_id = ?1",
                params![plan_id, format!("run {run_index} paused: {why}")],
            )?;
        }
        LedgerEvent::SurplusClaimed { .. } => {}
        LedgerEvent::PlanResumed { .. } => {
            tx.execute(
                "UPDATE plans SET status = 'active', last_error = NULL WHERE plan_id = ?1",
                [plan_id],
            )?;
        }
        LedgerEvent::PlanCompleted { .. } => {
            tx.execute(
                "UPDATE plans SET status = 'completed', next_run_at = NULL WHERE plan_id = ?1",
                [plan_id],
            )?;
        }
        LedgerEvent::PlanCancelled { .. } => {
            tx.execute(
                "UPDATE plans SET status = 'cancelled', next_run_at = NULL WHERE plan_id = ?1",
                [plan_id],
            )?;
        }
    }
    Ok(())
}

fn schedules_json(conn: &Connection, plan_id: Option<i64>, status: Option<&str>) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT schedule_id, plan_id, run_index, expiry_second, status, executed_ts, result FROM schedules
         WHERE (?1 IS NULL OR plan_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY plan_id, run_index, expiry_second",
    )?;
    let rows = stmt.query_map(params![plan_id, status], |r| {
        Ok(json!({
            "scheduleId": r.get::<_, String>(0)?,
            "planId": r.get::<_, i64>(1)?,
            "runIndex": r.get::<_, i64>(2)?,
            "expirySecond": r.get::<_, i64>(3)?,
            "status": r.get::<_, String>(4)?,
            "executedTimestamp": r.get::<_, Option<i64>>(5)?.map(format_timestamp),
            "result": r.get::<_, Option<String>>(6)?,
        }))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn plan_json(conn: &Connection, plan_id: i64, now_secs: i64, grace_secs: i64) -> Result<Option<Value>> {
    let row = conn
        .query_row(
            "SELECT owner, recipient, amount_per_run, usd_per_run, fee_reserve_per_run, interval_seconds, total_runs,
                    completed_runs, status, next_run_at, last_error, created_ts
             FROM plans WHERE plan_id = ?1",
            [plan_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                    r.get::<_, Option<String>>(10)?,
                    r.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()?;
    let Some((
        owner,
        recipient,
        amount,
        usd,
        fee_reserve,
        interval,
        total,
        completed,
        status,
        next_run_at,
        last_error,
        created_ts,
    )) = row
    else {
        return Ok(None);
    };

    let schedules = schedules_json(conn, Some(plan_id), None)?;
    let failed_schedule = schedules.iter().any(|s| s["status"] == "failed");
    // A booked run that was never paid and is well past its expiry means HSS did not fire it.
    let overdue = status == "active"
        && schedules.iter().any(|s| {
            s["status"] == "pending"
                && s["runIndex"].as_i64().unwrap_or(0) > completed
                && s["expirySecond"].as_i64().unwrap_or(i64::MAX) + grace_secs < now_secs
        });
    let needs_attention = matches!(status.as_str(), "needs_reschedule" | "paused") || failed_schedule || overdue;

    Ok(Some(json!({
        "planId": plan_id,
        "owner": owner,
        "recipient": recipient,
        "amountPerRun": amount,
        "usdPerRun": usd,
        "feeReservePerRun": fee_reserve,
        "intervalSeconds": interval,
        "totalRuns": total,
        "completedRuns": completed,
        "status": status,
        "nextRunAt": next_run_at,
        "lastError": last_error,
        "needsAttention": needs_attention,
        "overdue": overdue,
        "createdTimestamp": format_timestamp(created_ts),
        "schedules": schedules,
    })))
}
