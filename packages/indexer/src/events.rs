//! Decoding of `RecurringPayments` logs. The `sol!` block must match the contract's events exactly.

use alloy_primitives::{Address, B256};
use alloy_sol_types::{sol, SolEvent};
use anyhow::{Context, Result};
use serde_json::{json, Value};

sol! {
    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        address indexed recipient,
        uint256 amountPerRun,
        uint32 intervalSeconds,
        uint32 totalRuns
    );
    event ScheduleBooked(uint256 indexed planId, uint32 runIndex, address scheduleAddress, uint256 expirySecond);
    event ScheduleFailed(uint256 indexed planId, uint32 runIndex, int64 responseCode, uint256 expirySecond);
    event PaymentExecuted(uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount);
    event PaymentFailed(uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount);
    event PlanResumed(uint256 indexed planId);
    event PlanCompleted(uint256 indexed planId);
    event PlanCancelled(uint256 indexed planId, uint256 refunded);
}

/// A decoded contract event, reduced to the fields the indexer stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerEvent {
    PlanCreated {
        plan_id: u64,
        owner: Address,
        recipient: Address,
        amount_per_run: String,
        interval_seconds: u32,
        total_runs: u32,
    },
    ScheduleBooked {
        plan_id: u64,
        run_index: u32,
        schedule_address: Address,
        expiry_second: u64,
    },
    ScheduleFailed {
        plan_id: u64,
        run_index: u32,
        response_code: i64,
        expiry_second: u64,
    },
    PaymentExecuted {
        plan_id: u64,
        run_index: u32,
        recipient: Address,
        amount: String,
    },
    PaymentFailed {
        plan_id: u64,
        run_index: u32,
        recipient: Address,
        amount: String,
    },
    PlanResumed {
        plan_id: u64,
    },
    PlanCompleted {
        plan_id: u64,
    },
    PlanCancelled {
        plan_id: u64,
        refunded: String,
    },
}

impl LedgerEvent {
    pub fn plan_id(&self) -> u64 {
        match self {
            Self::PlanCreated { plan_id, .. }
            | Self::ScheduleBooked { plan_id, .. }
            | Self::ScheduleFailed { plan_id, .. }
            | Self::PaymentExecuted { plan_id, .. }
            | Self::PaymentFailed { plan_id, .. }
            | Self::PlanResumed { plan_id }
            | Self::PlanCompleted { plan_id }
            | Self::PlanCancelled { plan_id, .. } => *plan_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::PlanCreated { .. } => "PlanCreated",
            Self::ScheduleBooked { .. } => "ScheduleBooked",
            Self::ScheduleFailed { .. } => "ScheduleFailed",
            Self::PaymentExecuted { .. } => "PaymentExecuted",
            Self::PaymentFailed { .. } => "PaymentFailed",
            Self::PlanResumed { .. } => "PlanResumed",
            Self::PlanCompleted { .. } => "PlanCompleted",
            Self::PlanCancelled { .. } => "PlanCancelled",
        }
    }

    pub fn run_index(&self) -> Option<u32> {
        match self {
            Self::ScheduleBooked { run_index, .. }
            | Self::ScheduleFailed { run_index, .. }
            | Self::PaymentExecuted { run_index, .. }
            | Self::PaymentFailed { run_index, .. } => Some(*run_index),
            _ => None,
        }
    }

    /// Event fields as JSON for the API. Amounts are strings (they are uint256 in the contract).
    pub fn to_json(&self) -> Value {
        match self {
            Self::PlanCreated {
                owner,
                recipient,
                amount_per_run,
                interval_seconds,
                total_runs,
                ..
            } => json!({
                "owner": owner.to_string(), "recipient": recipient.to_string(), "amountPerRun": amount_per_run,
                "intervalSeconds": interval_seconds, "totalRuns": total_runs,
            }),
            Self::ScheduleBooked {
                schedule_address,
                expiry_second,
                ..
            } => json!({
                "scheduleAddress": schedule_address.to_string(), "expirySecond": expiry_second,
            }),
            Self::ScheduleFailed {
                response_code,
                expiry_second,
                ..
            } => json!({
                "responseCode": response_code, "expirySecond": expiry_second,
            }),
            Self::PaymentExecuted { recipient, amount, .. } | Self::PaymentFailed { recipient, amount, .. } => json!({
                "recipient": recipient.to_string(), "amount": amount,
            }),
            Self::PlanCancelled { refunded, .. } => json!({ "refunded": refunded }),
            Self::PlanResumed { .. } | Self::PlanCompleted { .. } => json!({}),
        }
    }
}

fn narrow(value: alloy_primitives::U256, what: &str) -> Result<u64> {
    u64::try_from(value).with_context(|| format!("{what} does not fit in u64"))
}

/// Decode one log. `Ok(None)` means the log is not one of this contract's events (ignored on purpose).
pub fn decode(topics: &[B256], data: &[u8]) -> Result<Option<LedgerEvent>> {
    let Some(&sig) = topics.first() else {
        return Ok(None);
    };
    let t = || topics.iter().copied();

    let event = if sig == PlanCreated::SIGNATURE_HASH {
        let e = PlanCreated::decode_raw_log(t(), data)?;
        LedgerEvent::PlanCreated {
            plan_id: narrow(e.planId, "planId")?,
            owner: e.owner,
            recipient: e.recipient,
            amount_per_run: e.amountPerRun.to_string(),
            interval_seconds: e.intervalSeconds,
            total_runs: e.totalRuns,
        }
    } else if sig == ScheduleBooked::SIGNATURE_HASH {
        let e = ScheduleBooked::decode_raw_log(t(), data)?;
        LedgerEvent::ScheduleBooked {
            plan_id: narrow(e.planId, "planId")?,
            run_index: e.runIndex,
            schedule_address: e.scheduleAddress,
            expiry_second: narrow(e.expirySecond, "expirySecond")?,
        }
    } else if sig == ScheduleFailed::SIGNATURE_HASH {
        let e = ScheduleFailed::decode_raw_log(t(), data)?;
        LedgerEvent::ScheduleFailed {
            plan_id: narrow(e.planId, "planId")?,
            run_index: e.runIndex,
            response_code: e.responseCode,
            expiry_second: narrow(e.expirySecond, "expirySecond")?,
        }
    } else if sig == PaymentExecuted::SIGNATURE_HASH {
        let e = PaymentExecuted::decode_raw_log(t(), data)?;
        LedgerEvent::PaymentExecuted {
            plan_id: narrow(e.planId, "planId")?,
            run_index: e.runIndex,
            recipient: e.recipient,
            amount: e.amount.to_string(),
        }
    } else if sig == PaymentFailed::SIGNATURE_HASH {
        let e = PaymentFailed::decode_raw_log(t(), data)?;
        LedgerEvent::PaymentFailed {
            plan_id: narrow(e.planId, "planId")?,
            run_index: e.runIndex,
            recipient: e.recipient,
            amount: e.amount.to_string(),
        }
    } else if sig == PlanResumed::SIGNATURE_HASH {
        LedgerEvent::PlanResumed {
            plan_id: narrow(PlanResumed::decode_raw_log(t(), data)?.planId, "planId")?,
        }
    } else if sig == PlanCompleted::SIGNATURE_HASH {
        LedgerEvent::PlanCompleted {
            plan_id: narrow(PlanCompleted::decode_raw_log(t(), data)?.planId, "planId")?,
        }
    } else if sig == PlanCancelled::SIGNATURE_HASH {
        let e = PlanCancelled::decode_raw_log(t(), data)?;
        LedgerEvent::PlanCancelled {
            plan_id: narrow(e.planId, "planId")?,
            refunded: e.refunded.to_string(),
        }
    } else {
        return Ok(None);
    };
    Ok(Some(event))
}

/// Hedera schedule IDs map to long-zero EVM addresses: 12 zero bytes followed by the entity number.
/// Returns `None` for any other address shape (e.g. the zero address on a failed booking).
pub fn schedule_id_from_address(address: &Address) -> Option<String> {
    let bytes = address.as_slice();
    if bytes[..12].iter().any(|b| *b != 0) {
        return None;
    }
    let num = u64::from_be_bytes(bytes[12..].try_into().ok()?);
    (num != 0).then(|| format!("0.0.{num}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, U256};

    fn roundtrip<E: SolEvent>(e: &E) -> (Vec<B256>, Vec<u8>) {
        let log = e.encode_log_data();
        (log.topics().to_vec(), log.data.to_vec())
    }

    const OWNER: Address = address!("00000000000000000000000000000000000000a1");
    const RECIPIENT: Address = address!("00000000000000000000000000000000000000b2");

    #[test]
    fn decodes_plan_created() {
        let (topics, data) = roundtrip(&PlanCreated {
            planId: U256::from(7),
            owner: OWNER,
            recipient: RECIPIENT,
            amountPerRun: U256::from(1_000_000u64),
            intervalSeconds: 3600,
            totalRuns: 3,
        });
        let e = decode(&topics, &data).unwrap().unwrap();
        assert_eq!(
            e,
            LedgerEvent::PlanCreated {
                plan_id: 7,
                owner: OWNER,
                recipient: RECIPIENT,
                amount_per_run: "1000000".into(),
                interval_seconds: 3600,
                total_runs: 3
            }
        );
        assert_eq!(e.kind(), "PlanCreated");
        assert_eq!(e.plan_id(), 7);
        assert_eq!(e.run_index(), None);
    }

    #[test]
    fn decodes_schedule_events_with_run_index() {
        let sched = address!("0000000000000000000000000000000000a5c0de");
        let (topics, data) = roundtrip(&ScheduleBooked {
            planId: U256::from(1),
            runIndex: 2,
            scheduleAddress: sched,
            expirySecond: U256::from(1_791_000_000u64),
        });
        let e = decode(&topics, &data).unwrap().unwrap();
        assert_eq!(e.run_index(), Some(2));
        assert!(
            matches!(e, LedgerEvent::ScheduleBooked { schedule_address, expiry_second: 1_791_000_000, .. } if schedule_address == sched)
        );

        let (topics, data) = roundtrip(&ScheduleFailed {
            planId: U256::from(1),
            runIndex: 2,
            responseCode: -1,
            expirySecond: U256::from(5),
        });
        assert!(matches!(
            decode(&topics, &data).unwrap().unwrap(),
            LedgerEvent::ScheduleFailed { response_code: -1, .. }
        ));
    }

    #[test]
    fn decodes_payment_and_lifecycle_events() {
        let (t, d) = roundtrip(&PaymentExecuted {
            planId: U256::from(3),
            runIndex: 1,
            recipient: RECIPIENT,
            amount: U256::from(9),
        });
        assert_eq!(decode(&t, &d).unwrap().unwrap().kind(), "PaymentExecuted");
        let (t, d) = roundtrip(&PaymentFailed {
            planId: U256::from(3),
            runIndex: 1,
            recipient: RECIPIENT,
            amount: U256::from(9),
        });
        assert_eq!(decode(&t, &d).unwrap().unwrap().kind(), "PaymentFailed");
        let (t, d) = roundtrip(&PlanResumed { planId: U256::from(3) });
        assert_eq!(decode(&t, &d).unwrap().unwrap().kind(), "PlanResumed");
        let (t, d) = roundtrip(&PlanCompleted { planId: U256::from(3) });
        assert_eq!(decode(&t, &d).unwrap().unwrap().kind(), "PlanCompleted");
        let (t, d) = roundtrip(&PlanCancelled {
            planId: U256::from(3),
            refunded: U256::from(42),
        });
        assert!(
            matches!(decode(&t, &d).unwrap().unwrap(), LedgerEvent::PlanCancelled { refunded, .. } if refunded == "42")
        );
    }

    #[test]
    fn ignores_unknown_events_and_empty_topics() {
        let unknown = B256::repeat_byte(0x11);
        assert_eq!(decode(&[unknown], &[]).unwrap(), None);
        assert_eq!(decode(&[], &[]).unwrap(), None);
    }

    #[test]
    fn errors_on_malformed_data() {
        let (topics, _) = roundtrip(&ScheduleBooked {
            planId: U256::from(1),
            runIndex: 1,
            scheduleAddress: OWNER,
            expirySecond: U256::from(1),
        });
        assert!(decode(&topics, &[1, 2, 3]).is_err());
    }

    #[test]
    fn rejects_plan_ids_that_overflow_u64() {
        let (topics, data) = roundtrip(&PlanResumed { planId: U256::MAX });
        assert!(decode(&topics, &data).is_err());
    }

    #[test]
    fn maps_long_zero_addresses_to_schedule_ids() {
        assert_eq!(
            schedule_id_from_address(&address!("0000000000000000000000000000000000a5c0de")).as_deref(),
            Some("0.0.10862814")
        );
        assert_eq!(schedule_id_from_address(&Address::ZERO), None);
        assert_eq!(
            schedule_id_from_address(&address!("1000000000000000000000000000000000000001")),
            None
        );
    }
}
