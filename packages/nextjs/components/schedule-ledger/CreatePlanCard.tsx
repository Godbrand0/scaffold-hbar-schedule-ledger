"use client";

import { useState } from "react";
import { isAddress } from "viem";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";
import { BOOKING_GAS_LIMIT, SUGGESTED_FEE_RESERVE_HBAR } from "~~/utils/schedule-ledger/gas";
import {
  formatOraclePrice,
  hbarToTinybar,
  suggestedCapTinybar,
  tinybarToHbar,
  tinybarToWeibar,
  usdToUnits,
} from "~~/utils/schedule-ledger/units";

const MIN_INTERVAL_SECONDS = 60;
const MAX_RUNS = 1000;
const PROBLEMS = ["", "the oracle call failed", "no usable price", "the price is stale", "above the cap"];

type Mode = "hbar" | "usd";

export const CreatePlanCard = ({ onCreated }: { onCreated: () => void }) => {
  const [mode, setMode] = useState<Mode>("hbar");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [usd, setUsd] = useState("10");
  const [capInput, setCapInput] = useState<string | null>(null); // null = use the suggested cap
  const [feeReserve, setFeeReserve] = useState(SUGGESTED_FEE_RESERVE_HBAR);
  const [interval, setInterval] = useState("3600");
  const [runs, setRuns] = useState("3");
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "RecurringPayments" });

  const usdUnits = usdToUnits(usd);
  // The contract does the conversion, so the preview always matches what a run would pay right now.
  const { data: quote } = useScaffoldReadContract({
    contractName: "RecurringPayments",
    functionName: "quoteUsd",
    args: [usdUnits ?? 1n],
  });
  const [quoteTinybar, quotePrice, , quoteProblem] = quote ?? [0n, 0n, 0n, 0];
  const quoteOk = !!quote && quoteProblem === 0;
  const suggestedCap = quoteOk ? suggestedCapTinybar(quoteTinybar) : null;
  const capTinybar = capInput === null ? suggestedCap : hbarToTinybar(capInput);

  // In USD mode the escrowed per-run amount is the cap; in HBAR mode it is the payment itself.
  const tinybar = mode === "usd" ? capTinybar : hbarToTinybar(amount);
  const feeTinybar = hbarToTinybar(feeReserve);
  const intervalSeconds = Number(interval);
  const runCount = Number(runs);

  const error = !isAddress(recipient)
    ? "Enter a valid 0x recipient address."
    : mode === "usd" && usdUnits === null
      ? "Dollar amount must be positive with at most 8 decimals."
      : mode === "usd" && capTinybar === null
        ? quoteOk || capInput !== null
          ? "Cap must be a positive HBAR value with at most 8 decimals."
          : "Waiting for Supra's price. Enter a cap manually to continue."
        : mode === "hbar" && tinybar === null
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
    const to = recipient as `0x${string}`;
    // The contract takes tinybar; the wallet's `value` is weibar (18 decimals), which Hedera converts back.
    if (mode === "usd" && usdUnits !== null) {
      await writeContractAsync({
        functionName: "createUsdPlan",
        args: [to, usdUnits, tinybar, feeTinybar, intervalSeconds, runCount],
        value: tinybarToWeibar(total),
        gas: BOOKING_GAS_LIMIT,
      });
    } else {
      await writeContractAsync({
        functionName: "createPlan",
        args: [to, tinybar, feeTinybar, intervalSeconds, runCount],
        value: tinybarToWeibar(total),
        gas: BOOKING_GAS_LIMIT,
      });
    }
    onCreated();
  };

  return (
    <div className="card bg-base-100 shadow-md">
      <div className="card-body gap-3">
        <h2 className="card-title">New recurring payment</h2>
        <div role="tablist" className="tabs tabs-boxed w-fit">
          <button role="tab" className={`tab ${mode === "hbar" ? "tab-active" : ""}`} onClick={() => setMode("hbar")}>
            Fixed HBAR
          </button>
          <button role="tab" className={`tab ${mode === "usd" ? "tab-active" : ""}`} onClick={() => setMode("usd")}>
            USD (Supra price)
          </button>
        </div>
        <label className="form-control">
          <span className="label-text">Recipient (0x address)</span>
          <input
            className="input input-bordered w-full"
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {mode === "hbar" ? (
            <label className="form-control">
              <span className="label-text">HBAR per run</span>
              <input className="input input-bordered w-full" value={amount} onChange={e => setAmount(e.target.value)} />
            </label>
          ) : (
            <>
              <label className="form-control">
                <span className="label-text">USD per run</span>
                <input className="input input-bordered w-full" value={usd} onChange={e => setUsd(e.target.value)} />
              </label>
              <label className="form-control">
                <span className="label-text">Max HBAR per run (escrowed cap)</span>
                <input
                  className="input input-bordered w-full"
                  value={capInput ?? (suggestedCap !== null ? tinybarToHbar(suggestedCap) : "")}
                  onChange={e => setCapInput(e.target.value)}
                />
              </label>
            </>
          )}
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
        {mode === "usd" && (
          <p className="text-sm text-base-content/70 m-0">
            {quoteOk
              ? `Supra reports ${formatOraclePrice(quotePrice)} per HBAR, so a run would pay about ${tinybarToHbar(quoteTinybar)} HBAR now. `
              : `Supra's price is not usable right now (${PROBLEMS[quoteProblem] ?? "unknown"}), so runs would pause. `}
            Each run re-reads the price. The cap is escrowed; whatever a run does not need is yours to claim back.
          </p>
        )}
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
