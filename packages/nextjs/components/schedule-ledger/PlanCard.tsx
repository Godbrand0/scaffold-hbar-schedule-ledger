"use client";

import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";
import { BOOKING_GAS_LIMIT } from "~~/utils/schedule-ledger/gas";
import { PlanStatus, PlanView, attentionMessage } from "~~/utils/schedule-ledger/indexer";
import { formatInterval, formatUsd, tinybarToHbar } from "~~/utils/schedule-ledger/units";

const STATUS_STYLE: Record<PlanStatus, string> = {
  active: "badge-success",
  needs_reschedule: "badge-warning",
  paused: "badge-warning",
  completed: "badge-info",
  cancelled: "badge-ghost",
};

const hashscanSchedule = (id: string) => `https://hashscan.io/testnet/schedule/${id}`;

/** USD plans escrow a per-run cap; what a run does not need accrues as surplus the owner can take back at any time. */
const SurplusClaim = ({ planId, onChanged }: { planId: number; onChanged: () => void }) => {
  const { data: onChain, refetch } = useScaffoldReadContract({
    contractName: "RecurringPayments",
    functionName: "getPlan",
    args: [BigInt(planId)],
  });
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "RecurringPayments" });
  const surplus = onChain?.surplus ?? 0n;
  if (surplus === 0n) return null;

  const claim = async () => {
    await writeContractAsync({ functionName: "claimSurplus", args: [BigInt(planId)] });
    void refetch();
    onChanged();
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-base-200 p-3 text-sm">
      <span>Unused cap you can claim back: {tinybarToHbar(surplus)} HBAR</span>
      <button className="btn btn-sm" disabled={isMining} onClick={claim}>
        Claim surplus
      </button>
    </div>
  );
};

type PlanCardProps = {
  plan: PlanView;
  isConnected: boolean;
  /** Cancel and resume are owner-only in the contract; re-booking is open to anyone. */
  isOwner: boolean;
  onChanged: () => void;
};

export const PlanCard = ({ plan, isConnected, isOwner, onChanged }: PlanCardProps) => {
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "RecurringPayments" });
  const attention = attentionMessage(plan);
  const isUsd = plan.usdPerRun !== "0";
  const isOpen = plan.status !== "completed" && plan.status !== "cancelled";

  const run = async (functionName: "cancel" | "rebook" | "resume") => {
    // rebook and resume book a new schedule, which needs an explicit gas limit (see utils/schedule-ledger/gas.ts).
    const gas = functionName === "cancel" ? undefined : BOOKING_GAS_LIMIT;
    await writeContractAsync({ functionName, args: [BigInt(plan.planId)], gas });
    onChanged();
  };

  return (
    <div className="card bg-base-100 shadow-md" data-testid={`plan-${plan.planId}`}>
      <div className="card-body gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="card-title m-0">Plan #{plan.planId}</h3>
          <span className={`badge ${STATUS_STYLE[plan.status]}`}>{plan.status.replace("_", " ")}</span>
        </div>
        <p className="m-0 text-sm break-all">
          {isUsd ? `${formatUsd(plan.usdPerRun)} of HBAR` : `${tinybarToHbar(plan.amountPerRun)} HBAR`} every{" "}
          {formatInterval(plan.intervalSeconds)} to {plan.recipient}
        </p>
        {isUsd && (
          <p className="m-0 text-xs text-base-content/70">
            Priced in HBAR at each run using Supra&apos;s HBAR/USD oracle. Per-run cap:{" "}
            {tinybarToHbar(plan.amountPerRun)} HBAR. The run pauses instead of paying if the price is stale or would
            exceed the cap.
          </p>
        )}
        <p className="m-0 text-xs text-base-content/70">
          Network fee reserve: {tinybarToHbar(plan.feeReservePerRun)} HBAR per run
        </p>
        <progress className="progress progress-primary w-full" value={plan.completedRuns} max={plan.totalRuns} />
        <p className="m-0 text-xs text-base-content/70">
          {plan.completedRuns} of {plan.totalRuns} runs paid
          {plan.nextRunAt && isOpen ? ` · next run ${new Date(plan.nextRunAt * 1000).toLocaleString()}` : ""}
        </p>

        {attention && (
          <div role="alert" className="alert alert-warning text-sm">
            <span>{attention.message}</span>
            {attention.action && (isOwner || (isConnected && attention.action === "rebook")) && (
              <button className="btn btn-sm" disabled={isMining} onClick={() => run(attention.action!)}>
                {attention.action === "rebook" ? "Re-book" : "Resume"}
              </button>
            )}
          </div>
        )}

        {plan.schedules.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer">Schedule history ({plan.schedules.length})</summary>
            <ul className="m-0 mt-2 list-none p-0 space-y-1">
              {plan.schedules.map(s => (
                <li key={s.scheduleId}>
                  Run {s.runIndex}:{" "}
                  <a className="link" href={hashscanSchedule(s.scheduleId)} target="_blank" rel="noreferrer">
                    {s.scheduleId}
                  </a>{" "}
                  — {s.status}
                  {s.result && s.result !== "SUCCESS" ? ` (${s.result})` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}

        {isOwner && isUsd && <SurplusClaim planId={plan.planId} onChanged={onChanged} />}

        {isOwner && isOpen && (
          <div className="card-actions justify-end">
            <button className="btn btn-outline btn-error btn-sm" disabled={isMining} onClick={() => run("cancel")}>
              Cancel and refund
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
