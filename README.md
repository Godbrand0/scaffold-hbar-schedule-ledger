# scaffold-hbar-schedule-ledger

A [Scaffold-HBAR](https://docs.hedera.com/solutions/tools/scaffold-hbar) template for products built on
scheduled payments. It pairs a HIP-1215 scheduling contract with a Rust indexer, so your app can show which
payments are pending, executed, failed or cancelled.

> **Status: work in progress.** This repository currently holds the design and the research behind it.
> The sections marked *Planned* describe what the template will contain, not what exists today.
> Nothing here has been deployed yet.

## The problem

Hedera's Schedule Service (HSS) can run contract calls at a future time with no off-chain bot
([HIP-1215](https://hips.hedera.com/hip/hip-1215)). But `scheduleCall` never reverts. On failure it returns a
status code, and a scheduled execution can fail later, after the schedule was created successfully.
A frontend that reads only contract state cannot tell a user "your payment failed, here is why."

Hedera also has no hosted indexing option for this data (The Graph's hosted service is unavailable on Hedera),
so teams end up writing their own.

## What this template gives you

*Planned:*

- **`packages/contracts`** (Hardhat): a recurring-payment contract that books schedules through the HSS system
  contract, checks `hasScheduleCapacity` first, and emits its own events for created, scheduling-failed,
  executed and cancelled payments. HIP-1215 defines no events, so the contract must emit them.
- **`packages/indexer`** (Rust): polls the testnet mirror node, joins contract logs with schedule records and
  execution results, stores them in SQLite, and serves them over a small HTTP API.
- **`packages/frontend`** (Next.js): a dashboard for schedule status and history, backed by the indexer API.
- **Docs:** `README.md` and `AGENTS.md` covering setup, architecture and how to adapt the contract and decoder.

## How the indexer works (design)

```
Hedera testnet mirror node
  ├─ /api/v1/contracts/{id}/results/logs   contract events
  ├─ /api/v1/schedules                     schedule state, executed_timestamp, deleted
  └─ /api/v1/transactions                  execution result at executed_timestamp (scheduled: true)
        │
        ▼
  Rust indexer: poll from a saved consensus-timestamp cursor, decode logs from the ABI,
  write idempotently (unique key: timestamp + log index), expose /events /schedules /health
        │
        ▼
  Next.js dashboard
```

## What has been verified

Checked against the live testnet mirror node and the HIP text:

- `/api/v1/schedules` returns `executed_timestamp`, `deleted` and `expiration_time` per schedule.
- The transaction at a schedule's `executed_timestamp` appears in `/api/v1/transactions` with
  `scheduled: true` and a `result`.
- Failed transactions with `scheduled: true` exist on testnet.
- HIP-1215 `scheduleCall` variants return a zero address plus a status code instead of reverting, and define no events.

## What has not been verified

- That a failed HIP-1215 *contract-call* schedule is recorded the same way as the plain transfers observed,
  and what its error message looks like.
- Whether `executed_timestamp` is set when the execution fails.
- The mirror node rejects `scheduled=true` as a query parameter, so the indexer must filter the `scheduled`
  field client-side or find executions through each schedule's `executed_timestamp`.
- Known issue: schedules booked from a `DELEGATECALL` frame fire and then fail with `INVALID_PAYER_SIGNATURE`
  ([hiero-consensus-node#27263](https://github.com/hiero-ledger/hiero-consensus-node/issues/27263)).
  Book schedules directly from the contract.

## Requirements (planned)

- Node 20.18.3 or later, and yarn or pnpm
- Rust toolchain (`cargo`) for the indexer
- A funded Hedera testnet account (faucet: Hedera Portal)

## Usage (planned)

```bash
npm create scaffold-hbar@latest -- --template Godbrand0/scaffold-hbar-schedule-ledger
```

## Bounty checklist

Mapped to the [Scaffold-HBAR Template Bounty](https://hedera.com/blog/scaffold-hbar-template-bounty/) gate:

- [ ] Scaffolds cleanly with the command above
- [ ] Valid `template.json`
- [ ] `README.md` and `AGENTS.md`
- [ ] Install, lint and build succeed from a fresh scaffold
- [ ] App boots and core routes return OK
- [ ] Testnet transaction proof (Hashscan link) for an HSS schedule
- [ ] No committed secrets or `.env` files
- [x] MIT license

## License

MIT
