export const INDEXER_URL = (process.env.NEXT_PUBLIC_INDEXER_URL || "http://127.0.0.1:4000").replace(/\/$/, "");

export type PlanStatus = "active" | "needs_reschedule" | "paused" | "completed" | "cancelled";
export type ScheduleStatus = "pending" | "executed" | "failed" | "deleted";

export type ScheduleView = {
  scheduleId: string;
  planId: number;
  runIndex: number;
  expirySecond: number;
  status: ScheduleStatus;
  executedTimestamp: string | null;
  result: string | null;
};

export type PlanView = {
  planId: number;
  owner: string;
  recipient: string;
  amountPerRun: string;
  intervalSeconds: number;
  totalRuns: number;
  completedRuns: number;
  status: PlanStatus;
  nextRunAt: number | null;
  lastError: string | null;
  needsAttention: boolean;
  overdue: boolean;
  createdTimestamp: string;
  schedules: ScheduleView[];
};

export type Health = {
  status: string;
  secondsSinceSync: number | null;
  lastError: string | null;
  cursor: string | null;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${INDEXER_URL}${path}`);
  if (!response.ok) throw new Error(`Indexer returned ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}

export const fetchPlans = async () => (await getJson<{ plans: PlanView[] }>("/plans")).plans;
export const fetchHealth = () => getJson<Health>("/health");

/** Human-readable reason a plan needs attention, with the action that fixes it. */
export function attentionMessage(plan: PlanView): { message: string; action: "rebook" | "resume" | null } | null {
  if (!plan.needsAttention) return null;
  if (plan.status === "needs_reschedule") {
    return { message: plan.lastError ?? "The Schedule Service refused the next run.", action: "rebook" };
  }
  if (plan.status === "paused") {
    return { message: plan.lastError ?? "The last payment could not be delivered.", action: "resume" };
  }
  const failed = plan.schedules.find(s => s.status === "failed");
  if (failed) {
    return { message: `Run ${failed.runIndex} executed but failed on-chain (${failed.result}).`, action: null };
  }
  return { message: "A booked run is overdue. Anyone can trigger it once it is due.", action: null };
}
