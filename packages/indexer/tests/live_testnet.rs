//! Contract tests against the real Hedera testnet mirror node. They need network access, so they are
//! ignored by default: `cargo test --test live_testnet -- --ignored`.
//!
//! They pin the response shapes the indexer depends on, using a schedule that already executed on testnet.

use schedule_ledger_indexer::mirror::{format_timestamp, MirrorClient};

const MIRROR: &str = "https://testnet.mirrornode.hedera.com";
// An executed (non-contract) schedule on testnet, used only to pin the response shapes.
const EXECUTED_SCHEDULE: &str = "0.0.10860318";
const EXECUTED_AT: &str = "1791136538.321055105";

#[tokio::test]
#[ignore = "needs network access"]
async fn schedule_and_scheduled_transaction_shapes_match() {
    let client = MirrorClient::new(MIRROR).unwrap();

    let schedule = client
        .schedule(EXECUTED_SCHEDULE)
        .await
        .unwrap()
        .expect("schedule exists on testnet");
    assert!(!schedule.deleted);
    assert_eq!(schedule.executed_timestamp.as_deref(), Some(EXECUTED_AT));

    let tx = client
        .scheduled_transaction(EXECUTED_AT)
        .await
        .unwrap()
        .expect("execution record exists");
    assert!(tx.scheduled);
    assert_eq!(tx.result, "SUCCESS");
}

#[tokio::test]
#[ignore = "needs network access"]
async fn unknown_schedules_are_none_not_errors() {
    let client = MirrorClient::new(MIRROR).unwrap();
    assert!(client.schedule("0.0.999999999").await.unwrap().is_none());
}

#[tokio::test]
#[ignore = "needs network access"]
async fn contract_log_pages_deserialize() {
    let client = MirrorClient::new(MIRROR).unwrap();
    // Recent window of a busy contract keeps the page count small while exercising real log JSON.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let after = (now - 120) * 1_000_000_000;
    let logs = client.contract_logs("0.0.9861213", Some(after)).await.unwrap();
    for log in &logs {
        assert!(
            log.topics.iter().all(|t| t.starts_with("0x") && t.len() == 66),
            "bad topic in {log:?}"
        );
        assert!(log.data.starts_with("0x"));
    }
    // Logs come back oldest first.
    let stamps: Vec<_> = logs.iter().map(|l| l.timestamp.clone()).collect();
    let mut sorted = stamps.clone();
    sorted.sort_by_key(|s| schedule_ledger_indexer::mirror::parse_timestamp(s).unwrap());
    assert_eq!(stamps, sorted);
    let _ = format_timestamp(after);
}
