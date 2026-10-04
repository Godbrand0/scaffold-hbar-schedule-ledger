import { PlanView, attentionMessage } from "./indexer";
import { describe, expect, it } from "vitest";

const plan = (overrides: Partial<PlanView> = {}): PlanView => ({
  planId: 1,
  owner: "0xowner",
  recipient: "0xrecipient",
  amountPerRun: "100",
  intervalSeconds: 3600,
  totalRuns: 3,
  completedRuns: 0,
  status: "active",
  nextRunAt: null,
  lastError: null,
  needsAttention: false,
  overdue: false,
  createdTimestamp: "1.0",
  schedules: [],
  ...overrides,
});

describe("attentionMessage", () => {
  it("is null for a healthy plan", () => {
    expect(attentionMessage(plan())).toBeNull();
  });

  it("offers re-book when HSS refused the next run", () => {
    const result = attentionMessage(plan({ status: "needs_reschedule", needsAttention: true, lastError: "busy" }));
    expect(result).toEqual({ message: "busy", action: "rebook" });
  });

  it("offers resume when the recipient rejected a payment", () => {
    const result = attentionMessage(plan({ status: "paused", needsAttention: true }));
    expect(result?.action).toBe("resume");
  });

  it("explains an on-chain failure without offering an action", () => {
    const result = attentionMessage(
      plan({
        needsAttention: true,
        schedules: [
          {
            scheduleId: "0.0.1",
            planId: 1,
            runIndex: 2,
            expirySecond: 1,
            status: "failed",
            executedTimestamp: "1.0",
            result: "CONTRACT_REVERT_EXECUTED",
          },
        ],
      }),
    );
    expect(result?.action).toBeNull();
    expect(result?.message).toContain("Run 2");
    expect(result?.message).toContain("CONTRACT_REVERT_EXECUTED");
  });

  it("falls back to the overdue message", () => {
    const result = attentionMessage(plan({ needsAttention: true, overdue: true }));
    expect(result?.message).toContain("overdue");
  });
});
