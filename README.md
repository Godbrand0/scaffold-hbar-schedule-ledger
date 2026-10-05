# Schedule Ledger

A [Scaffold-HBAR](https://docs.hedera.com/solutions/tools/scaffold-hbar) template for products built on
**scheduled payments**. It combines three pieces:

- A Solidity contract that escrows HBAR and pays itself out on a timer using the **Hedera Schedule Service**
  ([HIP-1215](https://hips.hedera.com/hip/hip-1215)), with no off-chain keeper.
- **USD-denominated plans** ("pay $10 of HBAR every week") priced at every run by the **Supra** oracle, which is
  what makes the dollar amount possible on a contract nobody is around to operate.
- A **Rust indexer** that follows the contract through the mirror node and records what happened to every run,
  including runs that failed.
- A **Next.js dashboard** that creates plans and shows their real status.

```bash
npm create scaffold-hbar@latest -- --template Godbrand0/scaffold-hbar-schedule-ledger
```

## Why this template exists

HSS makes "run this contract call later" a native feature, but it fails quietly:

- `scheduleCall` **never reverts**. When the network refuses a booking (for example because the target second is
  full) it returns a status code and a zero address. A contract that ignores that value silently stops paying.
- A scheduled execution can fail **after** the booking succeeded. Nothing on the contract side records that.
- HIP-1215 defines **no events**, so there is nothing to subscribe to.

A frontend that only reads contract state cannot tell a user "your payment failed, and here is why". This template
handles both layers: the contract turns every failure into an event and a recoverable state, and the indexer joins
those events with the mirror node's schedule and execution records.

If you are building payroll, subscriptions, rent, vesting or any recurring payout on Hedera, you can start from here
and change the contract's payout logic. The indexer and dashboard keep working as long as you keep the events.

## What is in the repository

| Package             | What it is                                                                          |
| ------------------- | ----------------------------------------------------------------------------------- |
| `packages/foundry`  | `RecurringPayments.sol`, mocks, Forge tests, deploy script                           |
| `packages/indexer`  | Rust service: mirror node poller, event decoder, SQLite store, HTTP API              |
| `packages/nextjs`   | Dashboard built on the Scaffold-HBAR frontend (wagmi, RainbowKit, DaisyUI)           |

## How it works

```
                 createPlan{value}                    scheduleCall(executeRun)
   user wallet ───────────────────▶ RecurringPayments ─────────────────────────▶ HSS (0x16b)
                                      │   ▲                                         │
                       events         │   └──────────── executeRun(planId) ◀────────┘
                                      ▼                  (network fires it at the booked second)
                           Hedera mirror node REST
        /contracts/{id}/results/logs · /schedules/{id} · /transactions?timestamp=
                                      │
                                      ▼
                    Rust indexer ── SQLite ── HTTP API :4000
                                      │
                                      ▼
                              Next.js dashboard
```

**The payment loop.** `createPlan` escrows `(amountPerRun + feeReservePerRun) × runs` and books the first run.
When HSS fires `executeRun`, the contract pays the recipient and books the next run, until the last run completes.

**The fee reserve.** The payer of a contract-scheduled call is the contract itself. Each run costs real network
fees (mostly for booking the *next* run, about 1.6M gas), and the network refuses to start a scheduled call unless
the payer holds `gasLimit × gasPrice`. The per-run `feeReservePerRun` is prepaid into the contract for this. It is
never paid to the recipient, and it is refunded only for runs that never fire (on `cancel`). Without it, the first
run fails with `INSUFFICIENT_PAYER_BALANCE` and the escrow is silently eaten by fees (observed on testnet).

**A plan is always in one of these states:**

| State             | Meaning                                                        | How it recovers                         |
| ----------------- | -------------------------------------------------------------- | --------------------------------------- |
| `active`          | A run is booked and funds are escrowed                         | n/a                                     |
| `needs_reschedule`| HSS refused to book the next run (`ScheduleFailed` event)       | anyone calls `rebook(planId)`           |
| `paused`          | The recipient rejected a payment (`PaymentFailed`), or a USD plan could not price the run (`PriceRejected`) | owner calls `resume(planId)` |
| `completed`       | Every run paid                                                 | terminal                                |
| `cancelled`       | Owner cancelled; unpaid escrow refunded                        | terminal                                |

A booking failure never rolls back a payment that already went out. `executeRun` is open to anyone once a run is
due, so a missed schedule can always be nudged by hand; the amount and recipient are fixed by the plan.

**What the indexer adds.** For every `ScheduleBooked` event it looks up the schedule on the mirror node and ends
up with one of `pending`, `executed`, `failed` (with the HAPI result code) or `deleted`. A plan is flagged
`needsAttention` when it is `needs_reschedule`, `paused`, has a failed schedule, or has a booked run that is still
unpaid well past its expiry (`overdue`).

## Pay in dollars: the Supra oracle integration

`createUsdPlan` takes a dollar amount instead of an HBAR amount. At every run the contract reads the HBAR/USD price
from [Supra](https://docs.supra.com/oracles/data-feeds/data-feeds-index) and pays `usdPerRun / price`. Remove the
oracle and the plan cannot work, because HBAR's price moves and nobody is online to reprice each run: the schedule
fires on its own, so the price must be read on-chain, inside that same call.

```
 createUsdPlan(recipient, usdPerRun, maxHbarPerRun, fee, interval, runs)
                │  escrows (maxHbarPerRun + fee) × runs
                ▼
   HSS fires executeRun ──▶ Supra storage.getSvalue(pair 432) ──▶ price, decimals, publish time (ms)
                │
                ├─ price fresh, payout ≤ cap ──▶ pay usd ÷ price, keep the unused cap as surplus
                └─ stale / missing / over cap ──▶ emit PriceRejected + PaymentFailed, plan pauses
```

| Detail | How it works |
| --- | --- |
| **Units** | USD has 8 decimals (`1e8` = $1), the same scale as tinybar, so `tinybar = usd × 10^oracleDecimals / price`. Supra prices have 18 decimals; the contract reads the decimals from the feed rather than assuming. |
| **The cap** | The owner escrows `maxHbarPerRun` per run, so the contract always holds enough. The dashboard suggests 2× today's conversion (a 50% price drop still pays). |
| **Surplus** | What a run did not need (`cap − payout`) accrues on the plan. The owner takes it with `claimSurplus(planId)` at any time, and `cancel` pays out whatever is left. |
| **Never a wrong amount** | A run is rejected, not approximated, when the oracle call reverts, the price is zero, the price is older than `MAX_PRICE_AGE` (default 3600 s), or the payout would exceed the cap. The plan pauses with a `PriceRejected` event naming the reason, and the owner resumes it once the price is healthy. |
| **Preview** | `quoteUsd(usdPerRun)` is a view that returns the payout the next run would make, the price, its publish time and the problem if any. The dashboard calls it live. |
| **Fixed-HBAR plans** | `createPlan` is unchanged and never touches the oracle. |

**Where Supra lives on Hedera**

| Network | Storage contract (what the contract reads) | HBAR/USD pair |
| --- | --- | --- |
| Testnet | `0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917` | 432 (HBAR_USDT is 75) |
| Mainnet | `0xD02cc7a670047b6b012556A88e275c685d25e0c9` | 432 |

`yarn foundry:deploy:testnet` passes these to the constructor. Override with `SUPRA_STORAGE`,
`SUPRA_HBAR_USD_PAIR` and `MAX_PRICE_AGE_SECONDS` when you deploy.

**Read this before relying on the freshness window.** On testnet the feed's publish timestamp did not change across
the roughly 20 minutes I observed it, so Supra's testnet update cadence is slower than a mainnet feed should be and
is not documented. A price older than `MAX_PRICE_AGE` pauses the plan by design. Pick the window for your use case:
long enough that normal update gaps do not pause plans, short enough that a stale price cannot misprice a payment.
Mainnet is untested.

## Quick start

A longer walkthrough with expected output and troubleshooting is in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

**Prerequisites:** Node 20.18.3+, Yarn, [Foundry](https://book.getfoundry.sh/getting-started/installation),
and [Rust](https://rustup.rs) (only for the indexer).

```bash
npm create scaffold-hbar@latest -- --template Godbrand0/scaffold-hbar-schedule-ledger my-app
cd my-app

yarn foundry:test                    # 47 contract tests, offline, mock Schedule Service and oracle
yarn foundry:account:generate        # create a deployer keystore
# fund the printed address at https://portal.hedera.com/faucet
yarn foundry:deploy:testnet          # deploys RecurringPayments, regenerates the frontend ABI

cp packages/indexer/.env.example packages/indexer/.env
# edit packages/indexer/.env: set CONTRACT_ADDRESS to the deployed address
yarn indexer:start                   # API on http://127.0.0.1:4000

cp packages/nextjs/.env.example packages/nextjs/.env
yarn next:dev                        # http://localhost:3000
```

The Schedule Service does **not** exist on Anvil or Hedera forks, so scheduling only works on testnet or mainnet.
Before the first deploy the dashboard shows setup steps instead of failing.

### Without Rust

`cargo` is only needed to run the indexer. If it is missing, `yarn lint`, `yarn indexer:build` and
`yarn indexer:test` print a warning and skip; `yarn indexer:start` stops with install instructions. Contracts and
the dashboard work without it, but the dashboard will have no data source.

## Configuration

| Where                       | Variable                      | Default                                  | Purpose                                              |
| --------------------------- | ----------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `packages/indexer/.env`     | `CONTRACT_ADDRESS` (required) | none                                     | Contract to follow: `0x` address or `0.0.N` ID        |
|                             | `MIRROR_NODE_URL`             | `https://testnet.mirrornode.hedera.com`  | Mirror node REST base URL                            |
|                             | `DATABASE_PATH`               | `indexer.db`                             | SQLite file                                          |
|                             | `BIND_ADDR`                   | `127.0.0.1:4000`                         | API listen address                                   |
|                             | `POLL_INTERVAL_SECS`          | `5`                                      | Seconds between polls                                |
|                             | `OVERDUE_GRACE_SECS`          | `60`                                     | Grace before an unpaid booked run counts as overdue  |
| `packages/nextjs/.env`      | `NEXT_PUBLIC_INDEXER_URL`     | `http://127.0.0.1:4000`                  | Where the dashboard reads plans from                 |
|                             | `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | bundled demo id                | WalletConnect                                        |
| `packages/foundry/.env`     | `HEDERA_RPC_URL`              | `https://testnet.hashio.io/api`          | JSON-RPC endpoint                                    |
| deploy-time (shell env)     | `SUPRA_STORAGE`               | Supra's address for the network          | Price storage contract the constructor reads         |
|                             | `SUPRA_HBAR_USD_PAIR`         | `432`                                    | HBAR/USD pair index in that contract                 |
|                             | `MAX_PRICE_AGE_SECONDS`       | `3600`                                   | A price older than this pauses USD plans             |

## Indexer API

All responses are JSON. Amounts are strings in tinybar.

| Route                       | Returns                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `GET /health`               | `lastSyncOkAt`, `secondsSinceSync`, `lastError`, `cursor`                    |
| `GET /plans`                | All plans with derived status, schedules, `needsAttention`, `overdue`        |
| `GET /plans/:id`            | One plan plus its events (404 if unknown)                                    |
| `GET /events?planId=&limit=`| Decoded contract events, newest first (`limit` 1–500, default 100)           |
| `GET /schedules?status=`    | Schedules, optionally filtered by `pending\|executed\|failed\|deleted`        |

**Delivery guarantees.** Events are keyed by consensus timestamp and log index, so re-reading is harmless. The
cursor and the derived state move in one SQLite transaction. If the mirror node is down, the cursor does not move
and the next poll retries. A log that cannot be decoded is skipped with a warning rather than blocking the indexer.
The data is as fresh as the mirror node (a few seconds behind consensus) plus the poll interval.

## Making it yours

1. **Change the payout logic** in `packages/foundry/contracts/RecurringPayments.sol` (a different split, a token
   instead of HBAR, another oracle pair such as HBAR_USDT, and so on). The Supra read is isolated in `quoteUsd`.
2. **Keep or extend the events.** If you add or change an event, update three places together:
   the `sol!` block in `packages/indexer/src/events.rs`, the `LedgerEvent` enum and `apply_to_state` in
   `packages/indexer/src/store.rs`, and the dashboard types in `packages/nextjs/utils/schedule-ledger/indexer.ts`.
3. **Extend the tests.** `test/RecurringPayments.t.sol` shows the mock-HSS pattern; `tests/pipeline.rs` shows how to
   feed encoded logs through a fake mirror node.

## Tests

| Command                | What it runs                                                        | Needs network |
| ---------------------- | ------------------------------------------------------------------- | ------------- |
| `yarn foundry:test`    | 47 Forge tests incl. fuzz tests on escrow accounting and the USD payout cap | no     |
| `yarn indexer:test`    | 18 unit tests and 16 end-to-end tests against a fake mirror node     | no            |
| `yarn next:test`       | 16 tests for HBAR/USD unit conversion and attention logic            | no            |
| `yarn test`            | all of the above                                                    | no            |
| `cd packages/indexer && cargo test --test live_testnet -- --ignored` | Pins the mirror node response shapes against real testnet | yes |

`yarn lint` runs ESLint, `the Foundry package lint and `cargo fmt --check` plus
`cargo clippy -D warnings`.

## Hedera details worth knowing

Items marked *(measured)* were observed on Hedera testnet while building this template; the mock-based tests could
not have found them.

- **Units** *(measured)*. Inside the EVM on Hedera, `msg.value` is in **tinybar** (1 HBAR = 1e8). Wallets and
  JSON-RPC use 18-decimal weibar (1 tinybar = 1e10 weibar) and Hedera converts. The contract takes tinybar; the
  dashboard converts with `tinybarToWeibar` for the transaction `value`. A plan paying `10000000` tinybar delivered
  exactly 0.1 HBAR to the recipient. `utils/schedule-ledger/units.ts` holds the helpers.
- **The contract pays its own scheduled calls** *(measured)*. The schedule's payer is the scheduling contract. With
  too little balance the schedule still fires, fails with `INSUFFICIENT_PAYER_BALANCE`, and charges a fee anyway.
  The contract emits nothing in that case, so only the indexer's mirror node lookup reveals it. Fund a reserve per
  run; the dashboard suggests 1.7 HBAR, which covers `RUN_GAS_LIMIT` (2M) × the testnet gas price (83 tinybar).
  Check the current price with `cast gas-price` and adjust `SUGGESTED_FEE_RESERVE_HBAR`.
- **Booking is expensive** *(measured)*. `createPlan`, `rebook` and `resume` each book a schedule, about 1.6M gas
  (roughly 1.3 HBAR at testnet prices). Send them with an explicit gas limit of at least 1.85M (the dashboard uses
  2M). The network also needs `value + gasLimit × gasPrice` available up front.
- **`block.timestamp` can trail the firing second** *(measured)*. HSS fired a run at consensus second `…226.03`
  while `block.timestamp` inside that call was earlier, so a strict "is it due?" check reverted the schedule's own
  call with `NotDue`. `executeRun` accepts runs up to `DUE_TOLERANCE_SECONDS` (10) early.
- **`forge script` cannot deploy to Hashio** *(measured)*. Forge 1.8.3 forks the chain with EIP-1898 block objects
  and Hashio answers `Invalid parameter 1`. `yarn foundry:deploy:testnet` therefore deploys with `forge create`
  (see `packages/foundry/scripts-js/deployCreate.js`) and writes the same `deployments/` and frontend files.
- **HSS never reverts**, so the contract checks `hasScheduleCapacity` first and probes a few seconds past the target
  when a second is full, as suggested in HIP-1215. If nothing has capacity it reports `CAPACITY_UNAVAILABLE` (`-1`).
- **Do not book from a `DELEGATECALL` frame.** There is an open network issue where such schedules fire and then
  fail with `INVALID_PAYER_SIGNATURE` ([hiero-consensus-node#27263](https://github.com/hiero-ledger/hiero-consensus-node/issues/27263)).
  This contract books directly.
- **Schedule IDs.** A schedule's EVM address is a long-zero address; the indexer converts it to `0.0.N` to query
  the mirror node.
- **The mirror node has no server-side `scheduled` filter**, so the indexer finds executions through each
  schedule's `executed_timestamp`.

## Testnet proof

> **Which build this covers.** These transactions were made against the build before USD plans and the Supra
> oracle were added. The fixed-HBAR path they exercise (`createPlan`, `executeRun`, `resume`, `cancel`) is unchanged.
> A live USD plan run has not been recorded yet, so USD plans are covered by the 47 contract tests and by checks of
> Supra's live testnet contract, not by a testnet execution.

Deployed to Hedera testnet with `yarn foundry:deploy:testnet`; contract
[`0.0.10861866`](https://hashscan.io/testnet/contract/0.0.10861866) (`0xFD70C4780318495fa11Ac6337c8125F041f6f302`). Everything below was
indexed live by `packages/indexer` while it ran.

| Scenario | What happened | Transactions |
| --- | --- | --- |
| **Chained runs, no keeper** (plan 1: 2 runs, 60 s apart) | Run 1 fired through HSS, paid the recipient and booked run 2 inside the same execution. Run 2 fired, paid and completed the plan. Both schedules ended `executed / SUCCESS`. | create [0xc8410ea2…](https://hashscan.io/testnet/transaction/0xc8410ea22c818f0cd47fc5a05b086942e52f4d778c480181fa8ad8c6d82a6ea1) · run 1 [0x8f162b67…](https://hashscan.io/testnet/transaction/0x8f162b6701b64e5fce5d3d173f5c5cba765d31216f518ca4b5c74204d6eebecc) ([0.0.10861887](https://hashscan.io/testnet/schedule/0.0.10861887)) · run 2 [0x586d5c96…](https://hashscan.io/testnet/transaction/0x586d5c964df8aba49a2f59d991343d13ca854d37e99c9e4af54b1836d3342d61) ([0.0.10861895](https://hashscan.io/testnet/schedule/0.0.10861895)) |
| **Failure and recovery** (plan 2: recipient contract rejects funds) | The run fired and the contract emitted `PaymentFailed` instead of reverting. The plan paused and the indexer flagged `needsAttention` ("recipient rejected payment for run 1"). After the recipient accepted funds, `resume` re-booked the run, which paid exactly 0.1 HBAR and completed the plan. | create [0x730f01a4…](https://hashscan.io/testnet/transaction/0x730f01a469d7640fb3bde5ccb9177772672da13e2b415befd624122339b06245) · failed run [0x35cab11a…](https://hashscan.io/testnet/transaction/0x35cab11a53b2064770e322c4ecf2ed4c52b2679843994743e2d07cf95f79fd21) ([0.0.10861911](https://hashscan.io/testnet/schedule/0.0.10861911)) · resume [0xf3e11e3f…](https://hashscan.io/testnet/transaction/0xf3e11e3f57288ea716d7f2435856d577e26ad310b75c0d83ed9e2c9308cd8cd2) · paid run [0xde10243b…](https://hashscan.io/testnet/transaction/0xde10243bb68a926299c1d0c8bb2ebbb93bba43f979ce2adbad09f04a1bf376e8) ([0.0.10861929](https://hashscan.io/testnet/schedule/0.0.10861929)) |
| **Cancel** (plan 3: first run one hour away) | `cancel` deleted the pending schedule (indexer status `deleted`) and refunded the full 3.6 HBAR escrow. | create [0x24108aab…](https://hashscan.io/testnet/transaction/0x24108aabbcf2f6a8f80c8207c933de03dcf950538281e33b6445b674fa2dbee3) · cancel [0xcd3fcb79…](https://hashscan.io/testnet/transaction/0xcd3fcb79f46e8eae4c31cb2aa7a11984375e23309fac4d01de133e1469845ca6) ([0.0.10861936](https://hashscan.io/testnet/schedule/0.0.10861936)) |

Deployment transaction: [0xce5c8093…](https://hashscan.io/testnet/transaction/0xce5c8093a89afe35608fed0cde60ed04a5d249f7c20bfc57410d8b98ccd28342). The recipient contract for
plan 2 (`RejectingReceiver`, a test mock) is [`0.0.10861909`](https://hashscan.io/testnet/contract/0.0.10861909).

Earlier runs against previous builds of this contract are what exposed the findings in
[Hedera details worth knowing](#hedera-details-worth-knowing): an `INSUFFICIENT_PAYER_BALANCE` failure and a
`CONTRACT_REVERT_EXECUTED` (`NotDue`) failure, both detected by the indexer from the mirror node alone.

## Status and limitations

- **Testnet proof:** see the section above.
- Verified on the live testnet: the mirror node response shapes (live tests), contract booking through HIP-1215,
  scheduled execution, the tinybar `msg.value` behaviour, and the indexer detecting two real on-chain failures
  (`INSUFFICIENT_PAYER_BALANCE` and `CONTRACT_REVERT_EXECUTED`) that the contract itself could not report.
- The Forge tests use a mock HSS, so they prove the contract's logic, not the network's. The findings above are
  covered by regression tests, but only the testnet can confirm them.
- Fee reserve left over after the final run stays in the contract (fees are only known after the fact). Set the
  reserve close to `gasLimit × gasPrice`.
- The recipient is fixed per plan. Plans pay HBAR only; for HTS tokens, replace the transfer in `executeRun`.
- USD plans depend on Supra keeping its feed fresh. See the freshness note in the Supra section.
- Mainnet is untested, including the Supra mainnet storage address.
- An existing indexer database from an older version must be deleted to re-index (`plans` gained a column).

## License

MIT. Original work, built on the MIT-licensed Scaffold-HBAR base (BuidlGuidl, hedera-dev). See [LICENSE](LICENSE).
