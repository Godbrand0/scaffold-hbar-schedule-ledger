// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { ISupraSValueFeed } from "./interfaces/ISupraSValueFeed.sol";

/// @title RecurringPayments
/// @notice Escrowed HBAR payments that pay themselves out on a schedule, using the Hedera Schedule Service.
/// @dev Each plan escrows `(amountPerRun + feeReservePerRun) * totalRuns` up front. After every successful run the
///      contract books the next run through HSS (HIP-1215), so no off-chain keeper is needed.
///
///      **Network fees.** The payer of a contract-scheduled call is the contract itself. The network requires the
///      payer to hold at least `gasLimit * gasPrice` when the call fires (about 2.2 HBAR for `RUN_GAS_LIMIT` at
///      testnet prices) and then charges the gas actually used, mostly for booking the *next* run. Observed on
///      testnet: a run with too little balance fails with `INSUFFICIENT_PAYER_BALANCE` and still burns fees.
///      The per-run `feeReservePerRun` is therefore prepaid into the contract and is never paid to the recipient.
///      It is refunded only for runs that never fire (on `cancel`).
///
///      HSS never reverts: a booking can fail and a scheduled execution can fail later. This contract turns
///      both cases into events (`ScheduleFailed`, `PaymentFailed`) and into recoverable plan states, so an
///      indexer can show users what happened. HIP-1215 itself defines no events; everything an indexer needs
///      from the contract side is emitted here.
///
///      **USD-denominated plans** (`createUsdPlan`) pay a fixed dollar amount per run. At each run the contract reads
///      the HBAR/USD price from Supra's oracle and pays `usdPerRun / price`. The owner escrows a per-run HBAR cap
///      (`amountPerRun`), so the contract always holds enough. A run never pays a wrong amount: if the price is
///      stale, missing, or would require more than the cap, the plan pauses with `PaymentFailed` and
///      `PriceRejected` instead. The unused part of the cap accrues as a surplus the owner can claim.
///
///      All HBAR amounts are in tinybar, which is the unit the EVM sees in `msg.value` on Hedera (1 HBAR = 1e8).
///      USD amounts use the same 8 decimals (1e8 = $1).
contract RecurringPayments is ReentrancyGuard {
    enum Status {
        None,
        Active, // a run is booked (or about to be) and funds are escrowed
        NeedsReschedule, // HSS refused to book the next run; anyone can call `rebook`
        Paused, // the last payment could not be delivered; the owner can `resume`
        Completed,
        Cancelled
    }

    struct Plan {
        address owner;
        address payable recipient;
        /// @dev Tinybar paid per run. For USD plans this is the per-run cap and the escrowed amount.
        uint256 amountPerRun;
        /// @dev USD per run with 8 decimals; 0 means a fixed-HBAR plan.
        uint256 usdPerRun;
        uint256 feeReservePerRun;
        /// @dev Escrowed HBAR from USD plans that was not needed because the price was favourable.
        uint256 surplus;
        uint32 intervalSeconds;
        uint32 totalRuns;
        uint32 completedRuns;
        uint64 nextRunAt;
        address scheduleAddress;
        Status status;
    }

    IHederaScheduleService internal constant HSS = IHederaScheduleService(0x000000000000000000000000000000000000016B);
    int64 internal constant HSS_SUCCESS = 22;
    /// @dev Reported in `ScheduleFailed` when no capacity probe succeeded (HSS was never asked to book).
    int64 public constant CAPACITY_UNAVAILABLE = -1;
    /// @dev Gas for one scheduled `executeRun`: the payout plus booking the next run. Booking costs about 1.45M gas
    ///      and a payout to an *existing* account about 0.05M. Paying an address that has no account yet makes Hedera
    ///      create one, which costs about 0.65M more (measured on testnet: 643,594 gas for one such transfer), so the
    ///      first payment to a new address needs about 2.1M in total. 2.6M leaves headroom.
    uint256 public constant RUN_GAS_LIMIT = 2_600_000;
    /// @dev Gas forwarded to the recipient. 100k was too little: a transfer to a brand-new address reverted at
    ///      100k, 200k, 400k and 600k gas and succeeded at 700k and above, because Hedera creates the account inside
    ///      the call. A recipient contract can burn all of this, but the cost is bounded by this limit and is paid
    ///      from the plan's fee reserve.
    uint256 public constant PAYMENT_GAS_LIMIT = 800_000;
    /// @dev A schedule must expire strictly after the current consensus second.
    uint256 public constant MIN_LEAD_SECONDS = 5;
    uint256 public constant CAPACITY_PROBES = 4;
    /// @dev HSS fires a schedule at a consensus second, but `block.timestamp` inside that execution can still be a
    ///      second or two earlier. Observed on testnet: a strict `block.timestamp >= nextRunAt` check made the
    ///      schedule's own call revert with `NotDue`. Runs may therefore start this many seconds early.
    uint256 public constant DUE_TOLERANCE_SECONDS = 10;
    uint32 public constant MIN_INTERVAL_SECONDS = 60;
    uint256 public constant USD_DECIMALS = 8;
    uint256 public constant MAX_ORACLE_DECIMALS = 30;

    /// @notice Supra price storage contract and the pair index of HBAR/USD within it.
    ISupraSValueFeed public immutable PRICE_FEED;
    uint256 public immutable HBAR_USD_PAIR;
    /// @notice A price older than this many seconds is rejected.
    uint256 public immutable MAX_PRICE_AGE;

    uint256 public planCount;
    mapping(uint256 planId => Plan) internal plans;

    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        address indexed recipient,
        uint256 amountPerRun,
        uint256 usdPerRun,
        uint256 feeReservePerRun,
        uint32 intervalSeconds,
        uint32 totalRuns
    );
    event ScheduleBooked(uint256 indexed planId, uint32 runIndex, address scheduleAddress, uint256 expirySecond);
    event ScheduleFailed(uint256 indexed planId, uint32 runIndex, int64 responseCode, uint256 expirySecond);
    /// @param hbarUsdPrice The oracle price used, in the oracle's decimals (18 for Supra). 0 for fixed-HBAR plans.
    event PaymentExecuted(
        uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount, uint256 hbarUsdPrice
    );
    event PaymentFailed(uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount);
    event PriceRejected(
        uint256 indexed planId, uint32 runIndex, PriceProblem problem, uint256 price, uint256 updatedAtMs
    );
    event SurplusClaimed(uint256 indexed planId, uint256 amount);
    event PlanResumed(uint256 indexed planId);
    event PlanCompleted(uint256 indexed planId);
    event PlanCancelled(uint256 indexed planId, uint256 refunded);

    /// @dev Why a USD plan could not price a run. Emitted in `PriceRejected`.
    enum PriceProblem {
        None,
        OracleReverted,
        ZeroPrice,
        Stale,
        AboveCap
    }

    error InvalidOracle();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidInterval();
    error InvalidRuns();
    error WrongEscrow(uint256 expected, uint256 provided);
    error UnknownPlan();
    error NotOwner();
    error NotDue(uint64 nextRunAt);
    error WrongStatus(Status current);
    error RefundFailed();
    error NothingToClaim();

    /// @param priceFeed Supra price storage contract (see `ISupraSValueFeed`).
    /// @param hbarUsdPair The HBAR/USD pair index in that contract (432 on Supra).
    /// @param maxPriceAge Seconds after which a published price counts as stale.
    constructor(ISupraSValueFeed priceFeed, uint256 hbarUsdPair, uint256 maxPriceAge) {
        if (address(priceFeed) == address(0) || maxPriceAge == 0) revert InvalidOracle();
        PRICE_FEED = priceFeed;
        HBAR_USD_PAIR = hbarUsdPair;
        MAX_PRICE_AGE = maxPriceAge;
    }

    /// @notice Escrow `(amountPerRun + feeReservePerRun) * runs` tinybar and start paying `recipient` a fixed
    ///         `amountPerRun` every `intervalSeconds`.
    /// @dev `msg.value` must equal the full escrow. The first run is booked immediately. If HSS cannot book it,
    ///      the plan is still created in `NeedsReschedule` so the owner's funds are never stuck mid-creation.
    ///      Booking costs roughly 1.6M gas, so send `createPlan` with an explicit gas limit of at least 2M.
    function createPlan(
        address payable recipient,
        uint256 amountPerRun,
        uint256 feeReservePerRun,
        uint32 intervalSeconds,
        uint32 runs
    ) external payable returns (uint256 planId) {
        if (amountPerRun == 0) revert InvalidAmount();
        planId = _create(recipient, amountPerRun, 0, feeReservePerRun, intervalSeconds, runs);
    }

    /// @notice Like `createPlan`, but each run pays `usdPerRun` dollars of HBAR at the price Supra reports when the
    ///         run executes. `maxHbarPerRun` is the cap that is escrowed per run.
    /// @dev `usdPerRun` has 8 decimals (1e8 = $1). A run whose price is stale or unavailable, or whose payout would
    ///      exceed `maxHbarPerRun`, pauses the plan rather than paying a wrong amount. Choose a cap with headroom
    ///      (for example 2x the current conversion) so a price drop does not pause the plan. Escrow is
    ///      `(maxHbarPerRun + feeReservePerRun) * runs`, same as `createPlan`.
    function createUsdPlan(
        address payable recipient,
        uint256 usdPerRun,
        uint256 maxHbarPerRun,
        uint256 feeReservePerRun,
        uint32 intervalSeconds,
        uint32 runs
    ) external payable returns (uint256 planId) {
        if (usdPerRun == 0 || maxHbarPerRun == 0) revert InvalidAmount();
        planId = _create(recipient, maxHbarPerRun, usdPerRun, feeReservePerRun, intervalSeconds, runs);
    }

    /// @notice The HBAR a USD plan would pay for one run right now, and the price it is based on.
    /// @return tinybar The payout, or 0 when the price cannot be used.
    /// @return price The oracle price (oracle decimals), 0 if unavailable.
    /// @return updatedAtMs When the oracle published that price, in unix milliseconds.
    /// @return problem `None` when `tinybar` is usable, otherwise why the price was rejected.
    function quoteUsd(uint256 usdPerRun)
        public
        view
        returns (uint256 tinybar, uint256 price, uint256 updatedAtMs, PriceProblem problem)
    {
        ISupraSValueFeed.PriceFeed memory feed;
        try PRICE_FEED.getSvalue(HBAR_USD_PAIR) returns (ISupraSValueFeed.PriceFeed memory f) {
            feed = f;
        } catch {
            return (0, 0, 0, PriceProblem.OracleReverted);
        }
        if (feed.price == 0 || feed.decimals > MAX_ORACLE_DECIMALS) {
            return (0, 0, feed.time, PriceProblem.ZeroPrice);
        }
        // `feed.time` is in milliseconds. A timestamp slightly in the future (clock skew) counts as fresh.
        uint256 nowMs = block.timestamp * 1000;
        if (nowMs > feed.time && (nowMs - feed.time) / 1000 > MAX_PRICE_AGE) {
            return (0, feed.price, feed.time, PriceProblem.Stale);
        }
        // usd (1e8 = $1) and tinybar (1e8 = 1 HBAR) share a scale, so tinybar = usd / (usd per HBAR).
        return (usdPerRun * 10 ** feed.decimals / feed.price, feed.price, feed.time, PriceProblem.None);
    }

    function _create(
        address payable recipient,
        uint256 amountPerRun,
        uint256 usdPerRun,
        uint256 feeReservePerRun,
        uint32 intervalSeconds,
        uint32 runs
    ) internal returns (uint256 planId) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (intervalSeconds < MIN_INTERVAL_SECONDS) revert InvalidInterval();
        if (runs == 0) revert InvalidRuns();

        uint256 escrow = (amountPerRun + feeReservePerRun) * runs;
        if (msg.value != escrow) revert WrongEscrow(escrow, msg.value);

        planId = ++planCount;
        plans[planId] = Plan({
            owner: msg.sender,
            recipient: recipient,
            amountPerRun: amountPerRun,
            usdPerRun: usdPerRun,
            feeReservePerRun: feeReservePerRun,
            surplus: 0,
            intervalSeconds: intervalSeconds,
            totalRuns: runs,
            completedRuns: 0,
            nextRunAt: uint64(block.timestamp) + intervalSeconds,
            scheduleAddress: address(0),
            status: Status.Active
        });

        emit PlanCreated(
            planId, msg.sender, recipient, amountPerRun, usdPerRun, feeReservePerRun, intervalSeconds, runs
        );
        _book(planId);
    }

    /// @notice Pay out the next run. HSS calls this at the booked time; anyone may call it once the run is due
    ///         (within `DUE_TOLERANCE_SECONDS` of the target second).
    /// @dev Open on purpose: the transfer is fixed by the plan, so a manual call after a missed schedule is
    ///      harmless and acts as a fallback keeper. A failed transfer does not revert. It pauses the plan and
    ///      emits `PaymentFailed`, which keeps the failure visible and the funds safe.
    function executeRun(uint256 planId) external nonReentrant {
        Plan storage plan = _plan(planId);
        if (plan.status != Status.Active) revert WrongStatus(plan.status);
        if (block.timestamp + DUE_TOLERANCE_SECONDS < plan.nextRunAt) revert NotDue(plan.nextRunAt);

        uint32 runIndex = plan.completedRuns + 1;
        plan.scheduleAddress = address(0);

        uint256 amount = plan.amountPerRun;
        uint256 price;
        if (plan.usdPerRun != 0) {
            PriceProblem problem;
            uint256 updatedAtMs;
            (amount, price, updatedAtMs, problem) = quoteUsd(plan.usdPerRun);
            if (problem == PriceProblem.None && amount > plan.amountPerRun) {
                problem = PriceProblem.AboveCap;
                amount = 0;
            }
            if (problem != PriceProblem.None || amount == 0) {
                if (problem == PriceProblem.None) problem = PriceProblem.ZeroPrice; // payout rounded down to nothing
                plan.status = Status.Paused;
                emit PriceRejected(planId, runIndex, problem, price, updatedAtMs);
                emit PaymentFailed(planId, runIndex, plan.recipient, 0);
                return;
            }
        }

        (bool ok,) = plan.recipient.call{ value: amount, gas: PAYMENT_GAS_LIMIT }("");
        if (!ok) {
            plan.status = Status.Paused;
            emit PaymentFailed(planId, runIndex, plan.recipient, amount);
            return;
        }

        plan.completedRuns = runIndex;
        plan.surplus += plan.amountPerRun - amount;
        emit PaymentExecuted(planId, runIndex, plan.recipient, amount, price);

        if (runIndex == plan.totalRuns) {
            plan.status = Status.Completed;
            emit PlanCompleted(planId);
            return;
        }

        plan.nextRunAt = uint64(block.timestamp) + plan.intervalSeconds;
        _book(planId);
    }

    /// @notice Book the next run again after HSS refused it. Anyone may call; no funds move.
    function rebook(uint256 planId) external {
        Plan storage plan = _plan(planId);
        if (plan.status != Status.NeedsReschedule) revert WrongStatus(plan.status);
        if (plan.nextRunAt < block.timestamp + MIN_LEAD_SECONDS) {
            plan.nextRunAt = uint64(block.timestamp + MIN_LEAD_SECONDS);
        }
        plan.status = Status.Active;
        _book(planId);
    }

    /// @notice Retry a paused plan after fixing the recipient problem (the recipient is immutable, so this is
    ///         for recipients that can accept funds again, such as a contract that was temporarily rejecting).
    function resume(uint256 planId) external {
        Plan storage plan = _plan(planId);
        if (msg.sender != plan.owner) revert NotOwner();
        if (plan.status != Status.Paused) revert WrongStatus(plan.status);

        plan.nextRunAt = uint64(block.timestamp + MIN_LEAD_SECONDS);
        plan.status = Status.Active;
        emit PlanResumed(planId);
        _book(planId);
    }

    /// @notice Stop the plan, delete the pending schedule if there is one, and refund the unpaid escrow.
    function cancel(uint256 planId) external nonReentrant {
        Plan storage plan = _plan(planId);
        if (msg.sender != plan.owner) revert NotOwner();
        if (plan.status == Status.Completed || plan.status == Status.Cancelled) revert WrongStatus(plan.status);

        address scheduleAddress = plan.scheduleAddress;
        plan.scheduleAddress = address(0);
        plan.status = Status.Cancelled;

        // Best effort: the schedule may already have fired. A leftover schedule is harmless because
        // `executeRun` rejects cancelled plans.
        if (scheduleAddress != address(0)) {
            HSS.deleteSchedule(scheduleAddress);
        }

        uint256 refund =
            (plan.amountPerRun + plan.feeReservePerRun) * (plan.totalRuns - plan.completedRuns) + plan.surplus;
        plan.surplus = 0;
        emit PlanCancelled(planId, refund);

        (bool ok,) = payable(plan.owner).call{ value: refund }("");
        if (!ok) revert RefundFailed();
    }

    /// @notice Send the owner the escrow that USD runs did not need (the cap minus what each run actually paid).
    /// @dev Works at any time, including after the plan completed. `cancel` pays out any remaining surplus too.
    function claimSurplus(uint256 planId) external nonReentrant {
        Plan storage plan = _plan(planId);
        if (msg.sender != plan.owner) revert NotOwner();
        uint256 amount = plan.surplus;
        if (amount == 0) revert NothingToClaim();

        plan.surplus = 0;
        emit SurplusClaimed(planId, amount);
        (bool ok,) = payable(plan.owner).call{ value: amount }("");
        if (!ok) revert RefundFailed();
    }

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return _plan(planId);
    }

    function _plan(uint256 planId) internal view returns (Plan storage plan) {
        plan = plans[planId];
        if (plan.status == Status.None) revert UnknownPlan();
    }

    /// @dev Books the run due at `nextRunAt`. Probes a few seconds past the target because HSS throttles
    ///      each expiry second (HIP-1215). On failure the plan moves to `NeedsReschedule` instead of reverting,
    ///      so a payment that already went out in `executeRun` is never rolled back by a scheduling problem.
    function _book(uint256 planId) internal {
        Plan storage plan = plans[planId];
        uint32 runIndex = plan.completedRuns + 1;

        uint256 expiry = plan.nextRunAt;
        if (expiry < block.timestamp + MIN_LEAD_SECONDS) expiry = block.timestamp + MIN_LEAD_SECONDS;

        bool found;
        for (uint256 i; i < CAPACITY_PROBES; ++i) {
            if (HSS.hasScheduleCapacity(expiry + i, RUN_GAS_LIMIT)) {
                expiry += i;
                found = true;
                break;
            }
        }
        if (!found) {
            plan.status = Status.NeedsReschedule;
            emit ScheduleFailed(planId, runIndex, CAPACITY_UNAVAILABLE, expiry);
            return;
        }

        (int64 code, address scheduleAddress) =
            HSS.scheduleCall(address(this), expiry, RUN_GAS_LIMIT, 0, abi.encodeCall(this.executeRun, (planId)));
        if (code != HSS_SUCCESS || scheduleAddress == address(0)) {
            plan.status = Status.NeedsReschedule;
            emit ScheduleFailed(planId, runIndex, code, expiry);
            return;
        }

        plan.scheduleAddress = scheduleAddress;
        plan.nextRunAt = uint64(expiry);
        emit ScheduleBooked(planId, runIndex, scheduleAddress, expiry);
    }
}
