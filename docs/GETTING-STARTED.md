# Getting started

A step-by-step guide from an empty folder to a scheduled payment running on Hedera testnet. Every command below was
run against testnet while building this template.

**Time:** about 15 minutes, plus a few minutes of Rust compile time on the first indexer start.

## 0. Prerequisites

| Tool | Why | Check |
| --- | --- | --- |
| Node 20.18.3 or later, and Yarn | scaffolding, frontend | `node -v` |
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | compile, test and deploy the contract | `forge --version` |
| [Rust](https://rustup.rs) | the indexer only | `cargo --version` |
| A Hedera testnet account with HBAR | deploying and paying fees | see step 4 |

Without Rust you can still do steps 1 to 5 and use the dashboard's create form, but nothing will show the plans
until the indexer runs (step 6).

## 1. Scaffold your project

```bash
npm create scaffold-hbar@latest -- --template Godbrand0/scaffold-hbar-schedule-ledger my-app
cd my-app
```

Accept the defaults when prompted (Next.js frontend, Foundry, Yarn). The CLI installs the Foundry libraries for you.

```bash
yarn install
```

## 2. Run the tests

```bash
yarn foundry:test
```

You should see 28 passing tests. They run offline against a mock Schedule Service, so they check the contract's
logic but not the network's behaviour. Step 5 is where you check the network.

## 3. Understand what you got

| Folder | Role | You will probably change |
| --- | --- | --- |
| `packages/foundry/contracts/RecurringPayments.sol` | Escrow, scheduling, failure handling | the payout logic |
| `packages/indexer` | Reads the mirror node, tracks every run | the event decoder, if you change events |
| `packages/nextjs` | Dashboard | the UI |

Read the "How it works" section of the root [README](../README.md#how-it-works) once. The main thing to know: the
contract pays the network fee for its own scheduled runs, so every plan prepays a **fee reserve** per run.

## 4. Get a funded testnet account

```bash
yarn foundry:account:generate
```

It asks for a keystore name and a password, then prints the new account's address. Send testnet HBAR to that
address from the
[Hedera faucet](https://portal.hedera.com/faucet). Budget about **2 HBAR to deploy** and **about 1.3 HBAR in gas
each time a plan, `rebook` or `resume` books a schedule**, plus the plan's escrow (see step 7).

Check the balance:

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/accounts/<your-0x-address> | grep -o '"balance":[0-9]*' | tail -1
```

The balance is in tinybar (1 HBAR = 100,000,000).

## 5. Deploy to testnet

```bash
yarn foundry:deploy:testnet
```

Pick your keystore when asked and enter its password. The script prints the contract address and writes it to
`packages/foundry/deployments/296.json`. It also regenerates `packages/nextjs/contracts/deployedContracts.ts`, so the
dashboard knows the address.

> The deploy uses `forge create` rather than `forge script`, because `forge script` cannot fork Hashio.

Find the contract's Hedera ID (you need it for the indexer):

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/<contract-0x-address> | grep -o '"contract_id":"[0-9.]*"'
```

## 6. Start the indexer

```bash
cp packages/indexer/.env.example packages/indexer/.env
```

Edit `packages/indexer/.env` and set `CONTRACT_ADDRESS` to the contract ID from step 5 (for example `0.0.10861866`).
Then:

```bash
yarn indexer:start
```

The first run compiles the crate, then logs `api listening` on `127.0.0.1:4000`. Check it:

```bash
curl -s http://127.0.0.1:4000/health
curl -s http://127.0.0.1:4000/plans
```

`/plans` is empty until you create one.

## 7. Create your first plan

**From the dashboard:**

```bash
cp packages/nextjs/.env.example packages/nextjs/.env
yarn next:dev
```

Open http://localhost:3000, connect a wallet funded with testnet HBAR, and fill in the form. The defaults are sensible:
the form suggests a 1.7 HBAR fee reserve per run, which covers the network's fee requirement at current testnet
prices.

**Or from the command line:**

```bash
cast send <contract-0x-address> \
  "createPlan(address,uint256,uint256,uint32,uint32)" \
  <recipient-0x-address> 10000000 170000000 60 2 \
  --value 3.6ether \
  --rpc-url https://testnet.hashio.io/api \
  --account <your-keystore> --legacy --gas-limit 2000000
```

The arguments are, in order: recipient, payment per run, fee reserve per run, interval in seconds, number of runs.

| Rule | Why |
| --- | --- |
| Amounts are in **tinybar** (`10000000` = 0.1 HBAR) | that is what the EVM sees on Hedera |
| `--value` must equal `(payment + reserve) × runs` | the contract rejects any other escrow |
| `--value` is in 18-decimal units (`3.6ether` = 3.6 HBAR) | wallets and Hashio convert it to tinybar |
| Interval is at least 60 seconds | contract minimum |
| Always set `--gas-limit` to about 2,000,000 | booking a schedule costs about 1.6M gas |

### Or pay a dollar amount (Supra oracle)

A USD plan pays `usd ÷ price` in HBAR at each run, using Supra's HBAR/USD price. First see what the oracle says now:

```bash
cast call <contract-0x-address> "quoteUsd(uint256)(uint256,uint256,uint256,uint8)" 25000000 \
  --rpc-url https://testnet.hashio.io/api
```

The argument is dollars with 8 decimals (`25000000` = $0.25). It returns the HBAR payout in tinybar, Supra's price
(18 decimals), the time the price was published (unix milliseconds), and a problem code (`0` means usable). Then:

```bash
cast send <contract-0x-address> \
  "createUsdPlan(address,uint256,uint256,uint256,uint32,uint32)(uint256)" \
  <recipient-0x-address> 25000000 500000000 170000000 60 2 \
  --value 13.4ether \
  --rpc-url https://testnet.hashio.io/api \
  --account <your-keystore> --legacy --gas-limit 2000000
```

Arguments: recipient, USD per run, **max HBAR per run (the escrowed cap)**, fee reserve per run, interval, runs.
`--value` is `(cap + fee reserve) × runs`, here `(5 + 1.7) × 2 = 13.4` HBAR. Pick a cap with headroom, about twice
the quote, so a price drop does not push a run over it. A run that is over the cap, or whose price is stale or
missing, pauses the plan instead of paying a wrong amount. What a run does not need stays yours:

```bash
cast send <contract-0x-address> "claimSurplus(uint256)" <plan-id> --rpc-url https://testnet.hashio.io/api \
  --account <your-keystore> --legacy --gas-limit 200000
```

In the dashboard this is the **USD (Supra price)** tab on the create form, which previews the live quote and
suggests the cap.

## 8. Watch it run

```bash
watch -n 5 'curl -s http://127.0.0.1:4000/plans | python3 -m json.tool'
```

Or just refresh the dashboard. With a 60 second interval you will see, in order:

1. The plan `active`, with run 1's schedule `pending`.
2. After about a minute, run 1 `executed` with result `SUCCESS`, `completedRuns` at 1, and run 2's schedule `pending`.
   Run 1's execution booked run 2 by itself.
3. After another minute, run 2 `executed`, the plan `completed`.

## 9. When something goes wrong

The dashboard shows a warning on any plan that needs attention.

| What you see | Meaning | What to do |
| --- | --- | --- |
| Plan `needs_reschedule` | The network refused to book the next run | Anyone can call `rebook(planId)`; the dashboard has a button |
| Plan `paused` | The recipient rejected a payment | Fix the recipient, then the owner calls `resume(planId)` |
| A schedule `failed` with `INSUFFICIENT_PAYER_BALANCE` | The fee reserve was too small for the network's fee requirement | Cancel and recreate with a larger reserve |
| Plan `paused` with "Supra's price is stale" | A USD plan's oracle price was older than the allowed age | Wait for Supra to update (`quoteUsd` returns problem code `0` again), then the owner calls `resume(planId)` |
| Plan `paused` with "exceed the per-run cap" | HBAR's price fell far enough that the dollar amount needs more than the escrowed cap | Cancel and recreate with a higher cap, or resume if the price recovers |
| A schedule still `pending` well past its time (`overdue`) | The network did not fire it | Anyone can call `executeRun(planId)` once the run is due |
| `cancel(planId)` | Stop a plan | Refunds the escrow of runs that have not fired and deletes the pending schedule |

## 10. Make it your own

1. **Change the payout** in `RecurringPayments.sol`. Keep emitting the events.
2. **If you add or change an event**, update `packages/indexer/src/events.rs`, the `LedgerEvent` handling in
   `packages/indexer/src/store.rs`, and `packages/nextjs/utils/schedule-ledger/indexer.ts`. Add a test in each place.
3. **Run everything** before you commit:

```bash
yarn lint
yarn test
```

See [AGENTS.md](../AGENTS.md) for the rules that are easy to get wrong, and the README's
[Hedera details](../README.md#hedera-details-worth-knowing) for what was measured on the network.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Insufficient funds for transfer` when creating a plan | The account needs `value + gasLimit × gasPrice` available up front. Fund it, or lower `--gas-limit` toward 1.85M. |
| `INSUFFICIENT_GAS` on `createPlan` | The gas limit is too low. Use about 2,000,000. |
| `forge script` fails with `Invalid parameter 1` | Use `yarn foundry:deploy:testnet`; it avoids `forge script`. |
| Dashboard says it cannot reach the indexer | Start it with `yarn indexer:start` and check `NEXT_PUBLIC_INDEXER_URL`. |
| Dashboard shows "not deployed" | Run step 5; it regenerates `deployedContracts.ts`. |
| `cargo` not found | Install Rust from https://rustup.rs. `yarn lint` and `yarn test` skip the indexer without it. |
| Indexer `/health` shows a `lastError` | The mirror node was unreachable or rate limiting. It retries every poll and loses nothing. |
