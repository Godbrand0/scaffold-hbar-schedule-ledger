"use client";

import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { zeroAddress } from "viem";
import { useAccount } from "wagmi";
import { CreatePlanCard } from "~~/components/schedule-ledger/CreatePlanCard";
import { PlanCard } from "~~/components/schedule-ledger/PlanCard";
import { useDeployedContractInfo } from "~~/hooks/scaffold-hbar";
import { INDEXER_URL, fetchHealth, fetchPlans } from "~~/utils/schedule-ledger/indexer";

const REFRESH_MS = 5_000;
const STALE_AFTER_SECONDS = 60;

const SetupSteps = ({ deployed, indexerUp }: { deployed: boolean; indexerUp: boolean }) => (
  <div className="card bg-base-100 shadow-md">
    <div className="card-body">
      <h2 className="card-title">Setup</h2>
      <ol className="m-0 space-y-2 pl-5 text-sm">
        <li className={deployed ? "line-through opacity-60" : ""}>
          Deploy the contract: <code>yarn foundry:deploy:testnet</code>
        </li>
        <li className={indexerUp ? "line-through opacity-60" : ""}>
          Put the deployed address in <code>packages/indexer/.env</code> as <code>CONTRACT_ADDRESS</code>, then run{" "}
          <code>yarn indexer:start</code> (API at {INDEXER_URL})
        </li>
      </ol>
    </div>
  </div>
);

const Home: NextPage = () => {
  const { address, isConnected } = useAccount();
  const { data: contract, isLoading: contractLoading } = useDeployedContractInfo({ contractName: "RecurringPayments" });
  const deployed = !!contract && contract.address !== zeroAddress;

  const plans = useQuery({ queryKey: ["plans"], queryFn: fetchPlans, refetchInterval: REFRESH_MS, retry: false });
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: REFRESH_MS, retry: false });
  const indexerUp = !plans.isError && !!plans.data;
  const refresh = () => {
    void plans.refetch();
    void health.refetch();
  };

  const stale = (health.data?.secondsSinceSync ?? 0) > STALE_AFTER_SECONDS;
  const attentionCount = plans.data?.filter(p => p.needsAttention).length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-8">
      <header>
        <h1 className="m-0 text-3xl font-bold">Schedule Ledger</h1>
        <p className="mt-2 text-base-content/70">
          Escrowed HBAR payments that pay themselves through the Hedera Schedule Service. The Rust indexer shows what
          happened to every run, including the ones that failed.
        </p>
      </header>

      {!contractLoading && (!deployed || !indexerUp) && <SetupSteps deployed={deployed} indexerUp={indexerUp} />}

      {plans.isError && (
        <div role="alert" className="alert alert-error text-sm">
          Cannot reach the indexer at {INDEXER_URL}. Is <code>yarn indexer:start</code> running?
        </div>
      )}
      {indexerUp && (stale || health.data?.lastError) && (
        <div role="alert" className="alert alert-warning text-sm">
          The indexer is behind the network
          {health.data?.lastError
            ? `: ${health.data.lastError}`
            : ` (last synced ${health.data?.secondsSinceSync}s ago)`}
          . Data below may be out of date.
        </div>
      )}
      {attentionCount > 0 && (
        <div role="alert" className="alert alert-warning text-sm">
          {attentionCount} plan{attentionCount === 1 ? "" : "s"} need attention.
        </div>
      )}

      {deployed && isConnected && <CreatePlanCard onCreated={refresh} />}
      {deployed && !isConnected && <p className="text-sm text-base-content/70">Connect a wallet to create a plan.</p>}

      <section className="flex flex-col gap-4" aria-label="Plans">
        <h2 className="m-0 text-xl font-semibold">Plans</h2>
        {plans.data?.length === 0 && <p className="text-sm text-base-content/70">No plans indexed yet.</p>}
        {plans.data?.map(plan => (
          <PlanCard
            key={plan.planId}
            plan={plan}
            isConnected={isConnected}
            isOwner={!!address && address.toLowerCase() === plan.owner.toLowerCase()}
            onChanged={refresh}
          />
        ))}
      </section>
    </div>
  );
};

export default Home;
