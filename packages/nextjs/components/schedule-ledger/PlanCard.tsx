"use client";

import { useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";
import { PlanStatus, PlanView, attentionMessage } from "~~/utils/schedule-ledger/indexer";
import { formatInterval, tinybarToHbar } from "~~/utils/schedule-ledger/units";

const STATUS_STYLE: Record<PlanStatus, string> = {
  active: "badge-success",
  needs_reschedule: "badge-warning",
  paused: "badge-warning",
  completed: "badge-info",
  cancelled: "badge-ghost",
};

const hashscanSchedule = (id: string) => `https://hashscan.io/testnet/schedule/${id}`;

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
  const isOpen = plan.status !== "completed" && plan.status !== "cancelled";

  const run = async (functionName: "cancel" | "rebook" | "resume") => {
    await writeContractAsync({ functionName, args: [BigInt(plan.planId)] });
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
          {tinybarToHbar(plan.amountPerRun)} HBAR every {formatInterval(plan.intervalSeconds)} to {plan.recipient}
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
