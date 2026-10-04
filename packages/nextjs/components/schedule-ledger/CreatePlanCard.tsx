"use client";

import { useState } from "react";
import { isAddress } from "viem";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";
import { BOOKING_GAS_LIMIT, SUGGESTED_FEE_RESERVE_HBAR } from "~~/utils/schedule-ledger/gas";
import { hbarToTinybar, tinybarToHbar, tinybarToWeibar } from "~~/utils/schedule-ledger/units";

const MIN_INTERVAL_SECONDS = 60;
const MAX_RUNS = 1000;

export const CreatePlanCard = ({ onCreated }: { onCreated: () => void }) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [feeReserve, setFeeReserve] = useState(SUGGESTED_FEE_RESERVE_HBAR);
  const [interval, setInterval] = useState("3600");
  const [runs, setRuns] = useState("3");
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "RecurringPayments" });

  const tinybar = hbarToTinybar(amount);
  const feeTinybar = hbarToTinybar(feeReserve);
  const intervalSeconds = Number(interval);
  const runCount = Number(runs);

  const error = !isAddress(recipient)
    ? "Enter a valid 0x recipient address."
    : tinybar === null
      ? "Amount must be a positive HBAR value with at most 8 decimals."
      : feeTinybar === null
        ? "Fee reserve must be a positive HBAR value with at most 8 decimals."
        : !Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS
          ? `Interval must be at least ${MIN_INTERVAL_SECONDS} seconds.`
          : !Number.isInteger(runCount) || runCount < 1 || runCount > MAX_RUNS
            ? `Runs must be between 1 and ${MAX_RUNS}.`
            : null;

  const total = tinybar !== null && feeTinybar !== null && !error ? (tinybar + feeTinybar) * BigInt(runCount) : null;

  const submit = async () => {
    if (error || tinybar === null || feeTinybar === null || total === null) return;
    // The contract takes tinybar; the wallet's `value` is weibar (18 decimals), which Hedera converts back.
    await writeContractAsync({
      functionName: "createPlan",
      args: [recipient as `0x${string}`, tinybar, feeTinybar, intervalSeconds, runCount],
      value: tinybarToWeibar(total),
      gas: BOOKING_GAS_LIMIT,
    });
    onCreated();
  };

  return (
    <div className="card bg-base-100 shadow-md">
      <div className="card-body gap-3">
        <h2 className="card-title">New recurring payment</h2>
        <label className="form-control">
          <span className="label-text">Recipient (0x address)</span>
          <input
            className="input input-bordered w-full"
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="form-control">
            <span className="label-text">HBAR per run</span>
            <input className="input input-bordered w-full" value={amount} onChange={e => setAmount(e.target.value)} />
          </label>
          <label className="form-control">
            <span className="label-text">Network fee reserve per run (HBAR)</span>
            <input
              className="input input-bordered w-full"
              value={feeReserve}
              onChange={e => setFeeReserve(e.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text">Interval (seconds)</span>
            <input
              className="input input-bordered w-full"
              value={interval}
              onChange={e => setInterval(e.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text">Runs</span>
            <input className="input input-bordered w-full" value={runs} onChange={e => setRuns(e.target.value)} />
          </label>
        </div>
        {total !== null ? (
          <p className="text-sm text-base-content/70 m-0">
            You escrow {tinybarToHbar(total)} HBAR now: the payments plus a per-run reserve that pays the network fee
            for each scheduled run. Runs that never fire are refunded on cancel; the reserve of runs that fired is spent
            on fees.
          </p>
        ) : (
          <p className="text-sm text-error m-0">{error}</p>
        )}
        <button className="btn btn-primary" disabled={!!error || isMining} onClick={submit}>
          {isMining ? "Creating…" : "Create plan"}
        </button>
      </div>
    </div>
  );
};
