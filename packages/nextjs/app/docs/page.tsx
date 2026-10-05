import type { ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { LIVE_CONTRACT, PROOF, hashscanUrl } from "~~/utils/schedule-ledger/deployment";

export const metadata: Metadata = {
  title: "Docs | Schedule Ledger",
  description: "How to run Schedule Ledger and its Rust indexer, what the indexer does, and what is live on testnet.",
};

const SECTIONS = [
  ["live", "What is live now"],
  ["quickstart", "Quick start"],
  ["how-it-works", "How it works"],
  ["usd", "Pay in dollars (Supra)"],
  ["indexer", "The indexer"],
  ["run-indexer", "Run the indexer"],
  ["api", "Indexer API"],
  ["dashboard", "Using the dashboard"],
  ["troubleshooting", "When something goes wrong"],
  ["hedera", "Hedera details"],
  ["customize", "Make it your own"],
  ["faq", "Troubleshooting"],
] as const;

const Code = ({ children }: { children: string }) => (
  <pre className="m-0 overflow-x-auto rounded-lg bg-base-300 p-4 text-sm leading-relaxed">
    <code>{children}</code>
  </pre>
);

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section id={id} className="scroll-mt-24 flex flex-col gap-3">
    <h2 className="m-0 border-b border-base-300 pb-2 text-2xl font-bold">{title}</h2>
    {children}
  </section>
);

const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto">
    <table className="table table-sm">
      <thead>
        <tr>
          {head.map(h => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} className="align-top">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const P = ({ children }: { children: ReactNode }) => <p className="m-0 leading-relaxed">{children}</p>;
const Note = ({ children }: { children: ReactNode }) => (
  <div className="rounded-lg border border-base-300 bg-base-200 p-4 text-sm leading-relaxed">{children}</div>
);
const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="link link-primary">
    {children}
  </a>
);

const Docs = () => (
  <div className="mx-auto flex w-full max-w-6xl gap-10 px-5 py-8">
    <aside className="sticky top-24 hidden h-fit w-56 shrink-0 lg:block">
      <p className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">On this page</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
        {SECTIONS.map(([id, label]) => (
          <li key={id}>
            <a href={`#${id}`} className="link link-hover">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </aside>

    <article className="flex min-w-0 flex-1 flex-col gap-10">
      <header className="flex flex-col gap-3">
        <h1 className="m-0 text-4xl font-bold">Schedule Ledger docs</h1>
        <P>
          Schedule Ledger escrows HBAR and pays a recipient on a schedule, with no off-chain keeper. A smart contract
          books each payment through the Hedera Schedule Service (HIP-1215), and a Rust indexer shows what happened to
          every run, including the ones that failed. This page covers how to run it, what the indexer does, and what is
          live today.
        </P>
        <div className="flex gap-3">
          <Link href="/" className="btn btn-primary btn-sm">
            Open the dashboard
          </Link>
          <a
            href="https://github.com/Godbrand0/scaffold-hbar-schedule-ledger"
            target="_blank"
            rel="noreferrer"
            className="btn btn-outline btn-sm"
          >
            Source on GitHub
          </a>
        </div>
      </header>

      <Section id="live" title="What is live now">
        <P>
          A reference deployment is running on Hedera testnet and has completed every scenario below. Each row links to
          the transactions on Hashscan, so you can check it yourself.
        </P>
        <Table
          head={["Item", "Value"]}
          rows={[
            [
              "Contract",
              <A key="c" href={hashscanUrl("contract", LIVE_CONTRACT.id)}>
                {LIVE_CONTRACT.id}
              </A>,
            ],
            ["EVM address", <code key="a">{LIVE_CONTRACT.evmAddress}</code>],
            ["Network", LIVE_CONTRACT.network],
            ["Contract tests", "50 Forge tests, offline, against a mock Schedule Service and a mock Supra oracle"],
            ["Indexer tests", "18 unit and 16 end-to-end tests against a fake mirror node"],
          ]}
        />
        <Table
          head={["Scenario proven on testnet", "What happened", "Evidence"]}
          rows={PROOF.map(p => [
            p.scenario,
            p.outcome,
            <div key={p.scenario} className="flex flex-wrap gap-x-3 gap-y-1">
              {p.links.map(l => (
                <A key={l.id} href={hashscanUrl(l.kind, l.id)}>
                  {l.label}
                </A>
              ))}
            </div>,
          ])}
        />
        <Note>
          <strong>Earlier proof.</strong> The earlier fixed-HBAR transactions (chained runs, failure and recovery,
          cancel) were made on contract <A href={hashscanUrl("contract", "0.0.10861866")}>0.0.10861866</A>, before USD
          plans existed. The table above is the current contract, which also covers the Supra USD path.
        </Note>
        <Note>
          <strong>The indexer is not hosted.</strong> It is a process you run on your own machine, so the dashboard
          shows &quot;Cannot reach the indexer&quot; until you start it (see <a href="#run-indexer">Run the indexer</a>
          ). The chain history above stays readable on Hashscan either way. This template ships a placeholder contract
          address until you deploy your own with <code>yarn foundry:deploy:testnet</code>.
        </Note>
      </Section>

      <Section id="quickstart" title="Quick start">
        <P>
          You need Node 20.18.3 or later with Yarn,{" "}
          <A href="https://book.getfoundry.sh/getting-started/installation">Foundry</A>, and{" "}
          <A href="https://rustup.rs">Rust</A> for the indexer.
        </P>
        <ol className="m-0 flex flex-col gap-4 pl-5">
          <li>
            <P>Scaffold the project and install dependencies.</P>
            <Code>{`npm create scaffold-hbar@latest -- --template Godbrand0/scaffold-hbar-schedule-ledger my-app
cd my-app
yarn install`}</Code>
          </li>
          <li>
            <P>Run the offline tests. You should see 28 pass.</P>
            <Code>{`yarn foundry:test`}</Code>
          </li>
          <li>
            <P>
              Create a deployer account. It asks for a keystore name and a password, then prints the address. Fund it
              from the <A href="https://portal.hedera.com/faucet">Hedera faucet</A>. Budget about 2 HBAR to deploy, plus
              about 1.3 HBAR of gas each time a plan, <code>rebook</code> or <code>resume</code> books a schedule, plus
              the plan&apos;s escrow.
            </P>
            <Code>{`yarn foundry:account:generate`}</Code>
          </li>
          <li>
            <P>
              Deploy. This writes the address to <code>packages/foundry/deployments/296.json</code> and regenerates the
              frontend&apos;s contract file.
            </P>
            <Code>{`yarn foundry:deploy:testnet`}</Code>
          </li>
          <li>
            <P>Start the indexer (full instructions below), then the dashboard.</P>
            <Code>{`yarn indexer:start      # terminal 1
yarn next:dev           # terminal 2, then open http://localhost:3000`}</Code>
          </li>
          <li>
            <P>Connect a funded wallet and create a plan from the form on the home page.</P>
          </li>
        </ol>
        <P>
          A longer walkthrough with expected output is in{" "}
          <A href="https://github.com/Godbrand0/scaffold-hbar-schedule-ledger/blob/main/docs/GETTING-STARTED.md">
            docs/GETTING-STARTED.md
          </A>
          .
        </P>
      </Section>

      <Section id="how-it-works" title="How it works">
        <P>
          <code>RecurringPayments</code> is the only contract. Creating a plan escrows the money up front, so a payment
          cannot fail for lack of funds later.
        </P>
        <ol className="m-0 flex flex-col gap-2 pl-5">
          <li>
            <code>createPlan(recipient, amountPerRun, feeReservePerRun, intervalSeconds, runs)</code> escrows{" "}
            <code>(amountPerRun + feeReservePerRun) × runs</code> and books the first run through the Schedule Service.
          </li>
          <li>
            At the booked second the network calls <code>executeRun</code>. The contract pays the recipient, then books
            the next run from inside that same call. That is the chain that needs no keeper.
          </li>
          <li>
            After the last run the plan is <code>completed</code>.
          </li>
        </ol>
        <P>
          A payment that cannot be delivered does not revert. The contract emits <code>PaymentFailed</code> and pauses
          the plan, so one bad recipient never traps a schedule in a retry loop and the owner can fix it and resume.
        </P>
        <Table
          head={["Function", "Who", "What it does"]}
          rows={[
            [<code key="1">createPlan</code>, "Anyone", "Escrow funds and book the first run"],
            [
              <code key="2">executeRun</code>,
              "The network (or anyone, once due)",
              "Pay the recipient and book the next run",
            ],
            [<code key="3">rebook</code>, "Anyone", "Book again when the network refused to schedule the next run"],
            [<code key="4">resume</code>, "Plan owner", "Retry a paused plan after the recipient is fixed"],
            [
              <code key="5">cancel</code>,
              "Plan owner",
              "Delete the pending schedule and refund runs that have not fired",
            ],
          ]}
        />
        <Note>
          <strong>The fee reserve.</strong> The contract is the payer of its own scheduled calls. Each run costs network
          fees (mostly for booking the next run), and the network will not start a scheduled call unless the payer holds
          its gas limit times the gas price. Each plan therefore prepays <code>feeReservePerRun</code>. It is never paid
          to the recipient and is refunded only for runs that never fire. Without it, the run fails with{" "}
          <code>INSUFFICIENT_PAYER_BALANCE</code> and the fees are lost. The dashboard suggests 2.3 HBAR per run.
        </Note>
      </Section>

      <Section id="usd" title="Pay in dollars (Supra)">
        <P>
          <code>createUsdPlan</code> takes a dollar amount instead of an HBAR amount. At every run the contract reads
          the HBAR/USD price from <A href="https://docs.supra.com/oracles/data-feeds/data-feeds-index">Supra</A> and
          pays <code>usdPerRun ÷ price</code>. The oracle is load-bearing: the schedule fires with nobody online, so the
          price has to be read on-chain, inside the same call that pays.
        </P>
        <Code>{`createUsdPlan(recipient, usdPerRun, maxHbarPerRun, feeReservePerRun, intervalSeconds, runs)
//   usdPerRun      8 decimals (1e8 = $1)
//   maxHbarPerRun  tinybar, escrowed per run as the cap
//   escrow         (maxHbarPerRun + feeReservePerRun) × runs`}</Code>
        <Table
          head={["Detail", "How it works"]}
          rows={[
            [
              "Conversion",
              "tinybar = usd × 10^decimals ÷ price. Supra prices have 18 decimals and the contract reads the decimals from the feed.",
            ],
            [
              "The cap",
              "The owner escrows a per-run HBAR cap so the contract always holds enough. The create form suggests twice today's conversion.",
            ],
            [
              "Surplus",
              "What a run does not need (cap minus payout) accrues on the plan. The owner takes it with claimSurplus(planId); cancel pays out what is left.",
            ],
            [
              "Never a wrong amount",
              "A run is rejected, not approximated, if the oracle call reverts, the price is zero or stale (older than MAX_PRICE_AGE, default 7200 s), or the payout would exceed the cap. The plan pauses and emits PriceRejected with the reason.",
            ],
            [
              "Preview",
              "quoteUsd(usdPerRun) is a view returning the payout, the price, when it was published, and a problem code. The create form calls it live.",
            ],
          ]}
        />
        <Table
          head={["Network", "Supra storage contract", "HBAR/USD pair"]}
          rows={[
            ["Testnet", <code key="t">0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917</code>, "432"],
            ["Mainnet", <code key="m">0xD02cc7a670047b6b012556A88e275c685d25e0c9</code>, "432"],
          ]}
        />
        <Note>
          <strong>Check the freshness window for your use.</strong> Supra&apos;s testnet HBAR/USD price updates about
          once an hour (its publish time moved from 1791190979 to 1791194579, exactly 3600 s apart), so a 1-hour window
          would pause plans just before each update and the default is 7200 s. A price older than the window pauses the
          plan on purpose. Mainnet is untested.
        </Note>
        <P>
          In the dashboard, use the <strong>USD (Supra price)</strong> tab on the create form. From the command line,
          see the{" "}
          <A href="https://github.com/Godbrand0/scaffold-hbar-schedule-ledger/blob/main/docs/GETTING-STARTED.md">
            getting-started guide
          </A>
          .
        </P>
      </Section>

      <Section id="indexer" title="The indexer">
        <P>
          The contract can only report what happens <em>inside</em> it. Some failures happen outside it: the network
          fires a scheduled call and it fails before the contract runs at all, or the network never fires it. The
          contract emits nothing in those cases, so a dashboard that read only contract events would show a healthy plan
          that is silently stuck. The indexer closes that gap.
        </P>
        <P>
          It is a small Rust service that polls the Hedera mirror node, stores everything in SQLite, and serves a JSON
          API that the dashboard reads. It does three things:
        </P>
        <ol className="m-0 flex flex-col gap-2 pl-5">
          <li>
            <strong>Reads contract events.</strong> It pulls the contract&apos;s logs from the mirror node and decodes{" "}
            <code>PlanCreated</code>, <code>ScheduleBooked</code>, <code>PaymentExecuted</code>,{" "}
            <code>PaymentFailed</code>, <code>PlanResumed</code>, <code>PlanCompleted</code> and{" "}
            <code>PlanCancelled</code>, plus <code>PriceRejected</code> and <code>SurplusClaimed</code> for USD plans,
            into plan state.
          </li>
          <li>
            <strong>Checks every booked schedule.</strong> For each schedule the contract booked, it asks the mirror
            node whether the network executed it, deleted it, or left it pending, and records the result code. This is
            how it catches failures like <code>INSUFFICIENT_PAYER_BALANCE</code> and{" "}
            <code>CONTRACT_REVERT_EXECUTED</code>.
          </li>
          <li>
            <strong>Flags what needs attention.</strong> A plan gets <code>needsAttention</code> when it is paused or
            needs rebooking, when a schedule failed, or when a run is overdue (booked, past its time plus a grace
            period, and never paid).
          </li>
        </ol>
        <P>
          It is safe to stop and restart. It keeps a cursor, ignores events it has already stored, and rebuilds any plan
          state from the event log, so a crash or a mirror node outage loses nothing.
        </P>
      </Section>

      <Section id="run-indexer" title="Run the indexer">
        <ol className="m-0 flex flex-col gap-4 pl-5">
          <li>
            <P>
              Get the contract&apos;s Hedera ID from its EVM address. For the reference deployment it is{" "}
              <code>{LIVE_CONTRACT.id}</code>.
            </P>
            <Code>{`curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/<contract-0x-address> | grep -o '"contract_id":"[0-9.]*"'`}</Code>
          </li>
          <li>
            <P>Copy the example config and set the contract. A 0x address or a 0.0.N ID both work.</P>
            <Code>{`cp packages/indexer/.env.example packages/indexer/.env
# then edit packages/indexer/.env:
CONTRACT_ADDRESS=${LIVE_CONTRACT.id}`}</Code>
          </li>
          <li>
            <P>Start it. The first run compiles the Rust crate, which takes a few minutes.</P>
            <Code>{`yarn indexer:start`}</Code>
          </li>
          <li>
            <P>
              Wait for <code>api listening</code> in the log, then check it. <code>status: ok</code> and a small{" "}
              <code>secondsSinceSync</code> mean it is following the chain.
            </P>
            <Code>{`curl -s http://127.0.0.1:4000/health
curl -s http://127.0.0.1:4000/plans`}</Code>
          </li>
        </ol>
        <Table
          head={["Variable", "Default", "Meaning"]}
          rows={[
            [<code key="1">CONTRACT_ADDRESS</code>, "required", "The contract to follow (0x address or 0.0.N ID)"],
            [
              <code key="2">MIRROR_NODE_URL</code>,
              "testnet mirror node",
              "Use https://mainnet.mirrornode.hedera.com for mainnet",
            ],
            [
              <code key="3">DATABASE_PATH</code>,
              "indexer.db",
              "Where the SQLite file lives. Delete it to re-index from scratch",
            ],
            [<code key="4">BIND_ADDR</code>, "127.0.0.1:4000", "Where the HTTP API listens"],
            [<code key="5">POLL_INTERVAL_SECS</code>, "5", "Seconds between mirror node polls"],
            [<code key="6">OVERDUE_GRACE_SECS</code>, "60", "How long after a run's time before it counts as overdue"],
          ]}
        />
        <Note>
          If you point it at a different contract, use a new <code>DATABASE_PATH</code> (or delete the old file).
          Otherwise it keeps the old contract&apos;s cursor and shows that contract&apos;s plans. The dashboard reads
          the indexer at <code>NEXT_PUBLIC_INDEXER_URL</code> (default <code>http://127.0.0.1:4000</code>).
        </Note>
      </Section>

      <Section id="api" title="Indexer API">
        <P>All responses are JSON. Amounts are strings in tinybar, because they are uint256 on chain.</P>
        <Table
          head={["Endpoint", "Returns"]}
          rows={[
            [
              <code key="1">GET /health</code>,
              "Sync status, the cursor, the last error, and seconds since the last successful sync",
            ],
            [
              <code key="2">GET /plans</code>,
              "Every plan with its schedules, status, next run time and attention flags",
            ],
            [<code key="3">GET /plans/:id</code>, "One plan, with its full event history"],
            [
              <code key="4">GET /events?planId=1&amp;limit=50</code>,
              "Decoded contract events, newest first. Both parameters are optional",
            ],
            [
              <code key="5">GET /schedules?status=failed</code>,
              "Booked schedules and their mirror node result. Status is pending, executed, failed or deleted",
            ],
          ]}
        />
        <P>Example plan record:</P>
        <Code>{`{
  "planId": 1,
  "status": "completed",
  "completedRuns": 2,
  "totalRuns": 2,
  "amountPerRun": "10000000",
  "feeReservePerRun": "170000000",
  "needsAttention": false,
  "schedules": [
    { "runIndex": 1, "scheduleId": "0.0.10861887", "status": "executed", "result": "SUCCESS" },
    { "runIndex": 2, "scheduleId": "0.0.10861895", "status": "executed", "result": "SUCCESS" }
  ]
}`}</Code>
      </Section>

      <Section id="dashboard" title="Using the dashboard">
        <P>
          The home page shows setup steps until the contract is deployed and the indexer is reachable, then the plan
          list and a create form.
        </P>
        <ul className="m-0 flex flex-col gap-2 pl-5">
          <li>
            <strong>Create a plan.</strong> Enter the recipient, HBAR per run, the fee reserve per run, the interval in
            seconds (at least 60) and the number of runs. The form shows the total you escrow. Creating a plan books a
            schedule, so it sends an explicit 2,000,000 gas limit.
          </li>
          <li>
            <strong>Watch a plan.</strong> Each card shows its status, progress, and every schedule with the
            network&apos;s result code. A warning appears on any plan that needs attention.
          </li>
          <li>
            <strong>Act on a plan.</strong> Buttons appear only when they apply: re-book, resume (owner only) and cancel
            (owner only).
          </li>
        </ul>
        <P>Amounts you type are in HBAR. The contract works in tinybar, and the dashboard converts for you.</P>
      </Section>

      <Section id="troubleshooting" title="When something goes wrong">
        <Table
          head={["What you see", "Meaning", "What to do"]}
          rows={[
            [
              <code key="1">needs_reschedule</code>,
              "The network refused to book the next run",
              "Anyone calls rebook(planId), or press re-book",
            ],
            [
              <code key="2">paused</code>,
              "The recipient rejected a payment, or a USD plan could not price the run (stale or missing Supra price, or over the cap)",
              "Fix the recipient or wait for a healthy price, then the owner calls resume(planId)",
            ],
            [
              <code key="3">INSUFFICIENT_PAYER_BALANCE</code>,
              "The contract's balance was below the network's fee requirement",
              "Cancel and recreate with a larger fee reserve",
            ],
            [
              <code key="4">overdue</code>,
              "Booked, past its time, and never paid",
              "Anyone calls executeRun(planId) once the run is due",
            ],
            [
              <code key="5">cancel</code>,
              "Stop a plan",
              "Refunds runs that have not fired and deletes the pending schedule",
            ],
          ]}
        />
      </Section>

      <Section id="hedera" title="Hedera details">
        <P>
          These were measured on testnet while building this template. The mock-based tests could not have found them.
        </P>
        <ul className="m-0 flex flex-col gap-2 pl-5">
          <li>
            <strong>Units.</strong> Inside the EVM on Hedera, <code>msg.value</code> is in <strong>tinybar</strong> (1
            HBAR = 10^8). Wallets and JSON-RPC use 18-decimal units and Hedera converts. A plan paying 10000000 tinybar
            delivered exactly 0.1 HBAR.
          </li>
          <li>
            <strong>The contract pays its own scheduled calls.</strong> With too little balance the schedule still
            fires, fails with <code>INSUFFICIENT_PAYER_BALANCE</code>, and charges a fee anyway.
          </li>
          <li>
            <strong>Booking is expensive.</strong> <code>createPlan</code>, <code>rebook</code> and <code>resume</code>{" "}
            each cost about 1.6M gas. Send them with an explicit gas limit of at least 1.85M.
          </li>
          <li>
            <strong>Paying a brand-new address costs about 650k gas.</strong> The first payment to an address with no
            account makes Hedera create the account inside the transfer, so a 100k payout limit failed. The payout limit
            is now 800k and each scheduled run gets 2.6M gas.
          </li>
          <li>
            <strong>
              <code>block.timestamp</code> can trail the firing second.
            </strong>{" "}
            A strict &quot;is it due?&quot; check made the schedule&apos;s own call revert, so <code>executeRun</code>{" "}
            accepts runs up to 10 seconds early.
          </li>
          <li>
            <strong>
              <code>forge script</code> cannot deploy to Hashio.
            </strong>{" "}
            It forks the chain with block objects Hashio rejects, so <code>yarn foundry:deploy:testnet</code> uses{" "}
            <code>forge create</code>.
          </li>
        </ul>
      </Section>

      <Section id="customize" title="Make it your own">
        <ol className="m-0 flex flex-col gap-2 pl-5">
          <li>
            Change the payout logic in <code>packages/foundry/contracts/RecurringPayments.sol</code>. Keep emitting the
            events.
          </li>
          <li>
            If you add or change an event, update the decoder in <code>packages/indexer/src/events.rs</code>, the state
            handling in <code>packages/indexer/src/store.rs</code>, and the types in{" "}
            <code>packages/nextjs/utils/schedule-ledger/indexer.ts</code>. Add a test in each place.
          </li>
          <li>
            Before you commit, run <code>yarn lint</code> and <code>yarn test</code>.
          </li>
        </ol>
      </Section>

      <Section id="faq" title="Troubleshooting">
        <Table
          head={["Symptom", "Cause and fix"]}
          rows={[
            [
              <code key="1">Insufficient funds for transfer</code>,
              "The account needs value plus gas limit times gas price up front. Fund it, or lower the gas limit toward 1.85M.",
            ],
            [
              <code key="2">forge script</code>,
              "Fails with Invalid parameter 1. Use yarn foundry:deploy:testnet instead.",
            ],
            [
              "Dashboard says it cannot reach the indexer",
              "Start it with yarn indexer:start and check NEXT_PUBLIC_INDEXER_URL.",
            ],
            ["Dashboard shows setup steps", "The contract is not deployed yet. Run yarn foundry:deploy:testnet."],
            [
              "Indexer health shows a lastError",
              "The mirror node was unreachable or rate limiting. It retries every poll and loses nothing.",
            ],
            ["cargo not found", "Install Rust from https://rustup.rs."],
          ]}
        />
      </Section>
    </article>
  </div>
);

export default Docs;
