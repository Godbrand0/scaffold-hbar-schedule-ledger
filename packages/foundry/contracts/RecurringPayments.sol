// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";

/// @title RecurringPayments
/// @notice Escrowed HBAR payments that pay themselves out on a schedule, using the Hedera Schedule Service.
/// @dev Each plan escrows `amountPerRun * totalRuns` up front. After every successful run the contract books
///      the next run through HSS (HIP-1215), so no off-chain keeper is needed.
///
///      HSS never reverts: a booking can fail and a scheduled execution can fail later. This contract turns
///      both cases into events (`ScheduleFailed`, `PaymentFailed`) and into recoverable plan states, so an
///      indexer can show users what happened. HIP-1215 itself defines no events; everything an indexer needs
///      from the contract side is emitted here.
///
///      All amounts are in tinybar, which is the unit the EVM sees in `msg.value` on Hedera (1 HBAR = 1e8).
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
        uint256 amountPerRun;
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
    uint256 public constant RUN_GAS_LIMIT = 2_000_000;
    uint256 public constant PAYMENT_GAS_LIMIT = 100_000;
    /// @dev A schedule must expire strictly after the current consensus second.
    uint256 public constant MIN_LEAD_SECONDS = 5;
    uint256 public constant CAPACITY_PROBES = 4;
    uint32 public constant MIN_INTERVAL_SECONDS = 60;

    uint256 public planCount;
    mapping(uint256 planId => Plan) internal plans;

    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        address indexed recipient,
        uint256 amountPerRun,
        uint32 intervalSeconds,
        uint32 totalRuns
    );
    event ScheduleBooked(uint256 indexed planId, uint32 runIndex, address scheduleAddress, uint256 expirySecond);
    event ScheduleFailed(uint256 indexed planId, uint32 runIndex, int64 responseCode, uint256 expirySecond);
    event PaymentExecuted(uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount);
    event PaymentFailed(uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount);
    event PlanResumed(uint256 indexed planId);
    event PlanCompleted(uint256 indexed planId);
    event PlanCancelled(uint256 indexed planId, uint256 refunded);

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

    /// @notice Escrow `amountPerRun * runs` tinybar and start paying `recipient` every `intervalSeconds`.
    /// @dev `msg.value` must equal the full escrow. The first run is booked immediately. If HSS cannot book it,
    ///      the plan is still created in `NeedsReschedule` so the owner's funds are never stuck mid-creation.
    function createPlan(address payable recipient, uint256 amountPerRun, uint32 intervalSeconds, uint32 runs)
        external
        payable
        returns (uint256 planId)
    {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountPerRun == 0) revert InvalidAmount();
        if (intervalSeconds < MIN_INTERVAL_SECONDS) revert InvalidInterval();
        if (runs == 0) revert InvalidRuns();

        uint256 escrow = amountPerRun * runs;
        if (msg.value != escrow) revert WrongEscrow(escrow, msg.value);

        planId = ++planCount;
        plans[planId] = Plan({
            owner: msg.sender,
            recipient: recipient,
            amountPerRun: amountPerRun,
            intervalSeconds: intervalSeconds,
            totalRuns: runs,
            completedRuns: 0,
            nextRunAt: uint64(block.timestamp) + intervalSeconds,
            scheduleAddress: address(0),
            status: Status.Active
        });

        emit PlanCreated(planId, msg.sender, recipient, amountPerRun, intervalSeconds, runs);
        _book(planId);
    }

    /// @notice Pay out the next run. HSS calls this at the booked time; anyone may call it once the run is due.
    /// @dev Open on purpose: the transfer is fixed by the plan, so a manual call after a missed schedule is
    ///      harmless and acts as a fallback keeper. A failed transfer does not revert. It pauses the plan and
    ///      emits `PaymentFailed`, which keeps the failure visible and the funds safe.
    function executeRun(uint256 planId) external nonReentrant {
        Plan storage plan = _plan(planId);
        if (plan.status != Status.Active) revert WrongStatus(plan.status);
        if (block.timestamp < plan.nextRunAt) revert NotDue(plan.nextRunAt);

        uint32 runIndex = plan.completedRuns + 1;
        plan.scheduleAddress = address(0);

        (bool ok,) = plan.recipient.call{ value: plan.amountPerRun, gas: PAYMENT_GAS_LIMIT }("");
        if (!ok) {
            plan.status = Status.Paused;
            emit PaymentFailed(planId, runIndex, plan.recipient, plan.amountPerRun);
            return;
        }

        plan.completedRuns = runIndex;
        emit PaymentExecuted(planId, runIndex, plan.recipient, plan.amountPerRun);

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

        uint256 refund = plan.amountPerRun * (plan.totalRuns - plan.completedRuns);
        emit PlanCancelled(planId, refund);

        (bool ok,) = payable(plan.owner).call{ value: refund }("");
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
