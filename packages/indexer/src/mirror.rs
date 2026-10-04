//! Thin client for the Hedera mirror node REST API (`/api/v1`).

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::time::Duration;

const PAGE_LIMIT: u32 = 100;
/// Safety valve so a misbehaving `links.next` can never loop forever.
const MAX_PAGES: usize = 1_000;

/// One contract log as returned by `/contracts/{id}/results/logs`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawLog {
    pub timestamp: String,
    pub index: u32,
    pub topics: Vec<String>,
    pub data: String,
    pub transaction_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScheduleInfo {
    pub deleted: bool,
    pub executed_timestamp: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransactionInfo {
    pub name: String,
    pub result: String,
    #[serde(default)]
    pub scheduled: bool,
}

#[derive(Deserialize)]
struct LogsPage {
    logs: Vec<RawLog>,
    links: Option<Links>,
}

#[derive(Deserialize)]
struct Links {
    next: Option<String>,
}

#[derive(Deserialize)]
struct TransactionsPage {
    transactions: Vec<TransactionInfo>,
}

#[derive(Clone)]
pub struct MirrorClient {
    http: reqwest::Client,
    base: String,
}

impl MirrorClient {
    pub fn new(base: &str) -> Result<Self> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
        })
    }

    /// All logs emitted by `contract` strictly after `after` (nanoseconds since epoch), oldest first.
    pub async fn contract_logs(&self, contract: &str, after: Option<i64>) -> Result<Vec<RawLog>> {
        let after = after.unwrap_or(0);
        let mut url = format!(
            "{}/api/v1/contracts/{contract}/results/logs?order=asc&limit={PAGE_LIMIT}&timestamp=gt:{}",
            self.base,
            format_timestamp(after)
        );
        let mut logs = Vec::new();
        for _ in 0..MAX_PAGES {
            let page: LogsPage = self
                .get_json(&url)
                .await?
                .context("mirror node returned 404 for contract logs")?;
            logs.extend(page.logs);
            match page.links.and_then(|l| l.next) {
                Some(next) => url = format!("{}{next}", self.base),
                None => return Ok(logs),
            }
        }
        bail!("gave up after {MAX_PAGES} pages of logs")
    }

    /// `None` when the mirror node does not know the schedule (yet, or any more).
    pub async fn schedule(&self, schedule_id: &str) -> Result<Option<ScheduleInfo>> {
        self.get_json(&format!("{}/api/v1/schedules/{schedule_id}", self.base))
            .await
    }

    /// The scheduled transaction that executed at `timestamp`, if the mirror node has it.
    pub async fn scheduled_transaction(&self, timestamp: &str) -> Result<Option<TransactionInfo>> {
        let page: Option<TransactionsPage> = self
            .get_json(&format!("{}/api/v1/transactions?timestamp={timestamp}", self.base))
            .await?;
        Ok(page.and_then(|p| {
            let mut txs = p.transactions;
            let pos = txs.iter().position(|t| t.scheduled).unwrap_or(0);
            (!txs.is_empty()).then(|| txs.swap_remove(pos))
        }))
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<Option<T>> {
        let response = self.http.get(url).send().await.with_context(|| format!("GET {url}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(anyhow!("GET {url} returned {status}"));
        }
        Ok(Some(
            response
                .json()
                .await
                .with_context(|| format!("decoding response from {url}"))?,
        ))
    }
}

/// `"1791136526.254117957"` -> nanoseconds since epoch.
pub fn parse_timestamp(ts: &str) -> Result<i64> {
    let (secs, nanos) = ts.split_once('.').unwrap_or((ts, "0"));
    if nanos.len() > 9 {
        bail!("timestamp has more than 9 fractional digits: {ts}");
    }
    let secs: i64 = secs.parse().with_context(|| format!("bad timestamp: {ts}"))?;
    let nanos: i64 = format!("{nanos:0<9}")
        .parse()
        .with_context(|| format!("bad timestamp: {ts}"))?;
    secs.checked_mul(1_000_000_000)
        .and_then(|s| s.checked_add(nanos))
        .ok_or_else(|| anyhow!("timestamp out of range: {ts}"))
}

pub fn format_timestamp(nanos: i64) -> String {
    format!("{}.{:09}", nanos / 1_000_000_000, nanos % 1_000_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_timestamps() {
        let n = parse_timestamp("1791136526.254117957").unwrap();
        assert_eq!(n, 1_791_136_526_254_117_957);
        assert_eq!(format_timestamp(n), "1791136526.254117957");
    }

    #[test]
    fn pads_short_fractions_and_accepts_bare_seconds() {
        assert_eq!(parse_timestamp("5.5").unwrap(), 5_500_000_000);
        assert_eq!(parse_timestamp("7").unwrap(), 7_000_000_000);
        assert_eq!(format_timestamp(1), "0.000000001");
    }

    #[test]
    fn rejects_garbage_timestamps() {
        assert!(parse_timestamp("abc").is_err());
        assert!(parse_timestamp("1.1234567891").is_err());
        assert!(parse_timestamp("99999999999999999999.0").is_err());
    }

    #[test]
    fn ordering_survives_the_round_trip() {
        let a = parse_timestamp("9.999999999").unwrap();
        let b = parse_timestamp("10.000000000").unwrap();
        assert!(a < b); // string comparison would get this wrong
    }
}
