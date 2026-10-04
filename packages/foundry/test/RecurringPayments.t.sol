// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { RecurringPayments } from "../contracts/RecurringPayments.sol";
import { MockHederaScheduleService } from "./mocks/MockHederaScheduleService.sol";
import { RejectingReceiver } from "./mocks/RejectingReceiver.sol";

contract RecurringPaymentsTest is Test {
    address internal constant HSS = 0x000000000000000000000000000000000000016B;
    int64 internal constant SCHEDULE_EXPIRY_IS_BUSY = 359; // sample response-code ordinal returned by the mock

    uint256 internal constant AMOUNT = 1_000_000; // tinybar per run
    uint256 internal constant FEE = 500_000; // prepaid network-fee reserve per run
    uint32 internal constant INTERVAL = 3600;
    uint32 internal constant RUNS = 3;
    uint256 internal constant ESCROW = (AMOUNT + FEE) * RUNS;

    RecurringPayments internal ledger;
    MockHederaScheduleService internal hss;

    address internal owner = makeAddr("owner");
    address payable internal recipient = payable(makeAddr("recipient"));
    address internal stranger = makeAddr("stranger");

    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        address indexed recipient,
        uint256 amountPerRun,
        uint256 feeReservePerRun,
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

    function setUp() public {
        // Foundry has no HSS, so etch a mock at the real system contract address.
        vm.etch(HSS, address(new MockHederaScheduleService()).code);
        hss = MockHederaScheduleService(HSS);
        ledger = new RecurringPayments();
        vm.deal(owner, 100 ether);
    }

    function _create() internal returns (uint256) {
        vm.prank(owner);
        return ledger.createPlan{ value: ESCROW }(recipient, AMOUNT, FEE, INTERVAL, RUNS);
    }

    function _createFor(address payable to) internal returns (uint256) {
        vm.prank(owner);
        return ledger.createPlan{ value: ESCROW }(to, AMOUNT, FEE, INTERVAL, RUNS);
    }

    function _status(uint256 id) internal view returns (RecurringPayments.Status) {
        return ledger.getPlan(id).status;
    }

    // ---------------------------------------------------------------- createPlan

    function test_createPlan_escrowsFundsAndBooksFirstRun() public {
        vm.expectEmit(true, true, true, true);
        emit PlanCreated(1, owner, recipient, AMOUNT, FEE, INTERVAL, RUNS);
        uint256 id = _create();

        RecurringPayments.Plan memory plan = ledger.getPlan(id);
        assertEq(uint8(plan.status), uint8(RecurringPayments.Status.Active));
        assertEq(plan.completedRuns, 0);
        assertTrue(plan.scheduleAddress != address(0));
        assertEq(address(ledger).balance, ESCROW);
        assertEq(hss.callCount(), 1);
    }

    function test_createPlan_booksExecuteRunCallAimedAtItself() public {
        uint256 id = _create();
        (address to,, bytes memory data,) = hss.calls(0);
        assertEq(to, address(ledger));
        assertEq(data, abi.encodeCall(RecurringPayments.executeRun, (id)));
    }

    function test_createPlan_emitsScheduleBooked() public {
        vm.expectEmit(true, false, false, false);
        emit ScheduleBooked(1, 1, address(0), 0);
        _create();
    }

    function test_createPlan_revertsOnWrongEscrow() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RecurringPayments.WrongEscrow.selector, ESCROW, ESCROW - 1));
        ledger.createPlan{ value: ESCROW - 1 }(recipient, AMOUNT, FEE, INTERVAL, RUNS);
    }

    function test_createPlan_validatesInputs() public {
        vm.startPrank(owner);
        vm.expectRevert(RecurringPayments.InvalidRecipient.selector);
        ledger.createPlan{ value: ESCROW }(payable(address(0)), AMOUNT, FEE, INTERVAL, RUNS);
        vm.expectRevert(RecurringPayments.InvalidRecipient.selector);
        ledger.createPlan{ value: ESCROW }(payable(address(ledger)), AMOUNT, FEE, INTERVAL, RUNS);
        vm.expectRevert(RecurringPayments.InvalidAmount.selector);
        ledger.createPlan(recipient, 0, FEE, INTERVAL, RUNS);
        vm.expectRevert(RecurringPayments.InvalidInterval.selector);
        ledger.createPlan{ value: ESCROW }(recipient, AMOUNT, FEE, 59, RUNS);
        vm.expectRevert(RecurringPayments.InvalidRuns.selector);
        ledger.createPlan(recipient, AMOUNT, FEE, INTERVAL, 0);
        vm.stopPrank();
    }

    function test_createPlan_needsRescheduleWhenHssRefusesAndKeepsFunds() public {
        hss.setNextFailureCode(SCHEDULE_EXPIRY_IS_BUSY);
        vm.expectEmit(true, false, false, false);
        emit ScheduleFailed(1, 1, SCHEDULE_EXPIRY_IS_BUSY, 0);
        uint256 id = _create();

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.NeedsReschedule));
        assertEq(address(ledger).balance, ESCROW);
    }

    function test_createPlan_reportsCapacityUnavailable() public {
        hss.setCapacityAvailable(false);
        vm.expectEmit(true, false, false, false);
        emit ScheduleFailed(1, 1, ledger.CAPACITY_UNAVAILABLE(), 0);
        uint256 id = _create();

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.NeedsReschedule));
        assertEq(hss.callCount(), 0);
    }

    // ---------------------------------------------------------------- executeRun

    function test_executeRun_revertsWhenNotDue() public {
        uint256 id = _create();
        vm.expectRevert(abi.encodeWithSelector(RecurringPayments.NotDue.selector, ledger.getPlan(id).nextRunAt));
        ledger.executeRun(id);
    }

    /// Regression for a failure seen on testnet: HSS fired the run at the target consensus second, but the EVM
    /// `block.timestamp` was slightly earlier, so a strict due check reverted the schedule's own call.
    function test_executeRun_acceptsAScheduleFiringJustBeforeTheTargetSecond() public {
        uint256 id = _create();
        uint64 target = ledger.getPlan(id).nextRunAt;
        vm.warp(target - 2);

        (bool ok,) = hss.fire(0);

        assertTrue(ok);
        assertEq(ledger.getPlan(id).completedRuns, 1);
    }

    function test_executeRun_stillRejectsRunsMoreThanTheToleranceEarly() public {
        uint256 id = _create();
        uint64 target = ledger.getPlan(id).nextRunAt;
        vm.warp(target - ledger.DUE_TOLERANCE_SECONDS() - 1);
        vm.expectRevert(abi.encodeWithSelector(RecurringPayments.NotDue.selector, target));
        ledger.executeRun(id);
    }

    function test_executeRun_revertsOnUnknownPlan() public {
        vm.expectRevert(RecurringPayments.UnknownPlan.selector);
        ledger.executeRun(42);
    }

    function test_executeRun_paysRecipientAndBooksNextRunWhenHssFires() public {
        uint256 id = _create();
        skip(INTERVAL + 10);

        (bool ok,) = hss.fire(0);

        assertTrue(ok);
        assertEq(recipient.balance, AMOUNT);
        assertEq(ledger.getPlan(id).completedRuns, 1);
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Active));
        assertEq(hss.callCount(), 2);
    }

    function test_executeRun_anyoneCanTriggerADueRun() public {
        uint256 id = _create();
        skip(INTERVAL + 10);
        vm.expectEmit(true, true, false, true);
        emit PaymentExecuted(id, 1, recipient, AMOUNT);
        vm.prank(stranger);
        ledger.executeRun(id);
    }

    function test_executeRun_completesAfterLastRunWithNoEscrowLeft() public {
        uint256 id = _create();
        for (uint256 i; i < RUNS; ++i) {
            skip(INTERVAL + 10);
            if (i == RUNS - 1) {
                vm.expectEmit(true, false, false, false);
                emit PlanCompleted(id);
            }
            (bool ok,) = hss.fire(i);
            assertTrue(ok);
        }
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Completed));
        assertEq(ledger.getPlan(id).completedRuns, RUNS);
        // Payouts left the contract; the fee reserve stays behind to cover network fees.
        assertEq(address(ledger).balance, FEE * RUNS);
        assertEq(recipient.balance, AMOUNT * RUNS);
        assertEq(hss.callCount(), RUNS); // nothing booked after the final run
    }

    function test_executeRun_cannotPaySameRunTwice() public {
        uint256 id = _create();
        skip(INTERVAL + 10);
        ledger.executeRun(id);
        vm.expectRevert();
        ledger.executeRun(id);
        assertEq(recipient.balance, AMOUNT);
    }

    function test_executeRun_keepsPaymentButNeedsRescheduleWhenNextBookingFails() public {
        uint256 id = _create();
        hss.setNextFailureCode(SCHEDULE_EXPIRY_IS_BUSY);
        skip(INTERVAL + 10);

        vm.expectEmit(true, true, false, true);
        emit PaymentExecuted(id, 1, recipient, AMOUNT);
        ledger.executeRun(id);

        assertEq(recipient.balance, AMOUNT);
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.NeedsReschedule));
    }

    function test_executeRun_pausesAndEmitsPaymentFailedWhenRecipientRejects() public {
        RejectingReceiver receiver = new RejectingReceiver();
        uint256 id = _createFor(payable(address(receiver)));
        skip(INTERVAL + 10);

        vm.expectEmit(true, true, false, true);
        emit PaymentFailed(id, 1, address(receiver), AMOUNT);
        ledger.executeRun(id);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Paused));
        assertEq(ledger.getPlan(id).completedRuns, 0);
        assertEq(address(ledger).balance, ESCROW);
    }

    function test_executeRun_rejectsCancelledPlan() public {
        uint256 id = _create();
        vm.prank(owner);
        ledger.cancel(id);
        skip(INTERVAL + 10);
        vm.expectRevert(
            abi.encodeWithSelector(RecurringPayments.WrongStatus.selector, RecurringPayments.Status.Cancelled)
        );
        ledger.executeRun(id);
    }

    // ---------------------------------------------------------------- rebook

    function test_rebook_letsAnyoneBookAgain() public {
        hss.setNextFailureCode(SCHEDULE_EXPIRY_IS_BUSY);
        uint256 id = _create();

        vm.expectEmit(true, false, false, false);
        emit ScheduleBooked(id, 1, address(0), 0);
        vm.prank(stranger);
        ledger.rebook(id);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Active));
        assertEq(hss.callCount(), 1);
    }

    function test_rebook_revertsWhenNotWaitingForReschedule() public {
        uint256 id = _create();
        vm.expectRevert(abi.encodeWithSelector(RecurringPayments.WrongStatus.selector, RecurringPayments.Status.Active));
        ledger.rebook(id);
    }

    function test_rebook_movesStaleTargetIntoTheFuture() public {
        hss.setCapacityAvailable(false);
        uint256 id = _create();
        skip(INTERVAL * 2);
        hss.setCapacityAvailable(true);

        ledger.rebook(id);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Active));
        assertGt(ledger.getPlan(id).nextRunAt, block.timestamp);
    }

    // ---------------------------------------------------------------- resume

    function _paused() internal returns (uint256 id, RejectingReceiver receiver) {
        receiver = new RejectingReceiver();
        id = _createFor(payable(address(receiver)));
        skip(INTERVAL + 10);
        ledger.executeRun(id);
    }

    function test_resume_ownerCanRetryOnceRecipientAcceptsAgain() public {
        (uint256 id, RejectingReceiver receiver) = _paused();
        receiver.setAccepting(true);

        vm.expectEmit(true, false, false, false);
        emit PlanResumed(id);
        vm.prank(owner);
        ledger.resume(id);

        skip(60);
        ledger.executeRun(id);
        assertEq(address(receiver).balance, AMOUNT);
    }

    function test_resume_isOwnerOnly() public {
        (uint256 id,) = _paused();
        vm.prank(stranger);
        vm.expectRevert(RecurringPayments.NotOwner.selector);
        ledger.resume(id);
    }

    function test_resume_onlyWorksOnPausedPlans() public {
        uint256 id = _create();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RecurringPayments.WrongStatus.selector, RecurringPayments.Status.Active));
        ledger.resume(id);
    }

    // ---------------------------------------------------------------- cancel

    function test_cancel_refundsUnpaidEscrowAndDeletesPendingSchedule() public {
        uint256 id = _create();
        skip(INTERVAL + 10);
        hss.fire(0); // run 1 paid, run 2 booked

        uint256 before = owner.balance;
        vm.expectEmit(true, false, false, true);
        emit PlanCancelled(id, (AMOUNT + FEE) * 2);
        vm.prank(owner);
        ledger.cancel(id);

        assertEq(owner.balance, before + (AMOUNT + FEE) * 2);
        (,,, bool deleted) = hss.calls(1);
        assertTrue(deleted);
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Cancelled));
        // Only the run that already fired keeps its fee reserve in the contract.
        assertEq(address(ledger).balance, FEE);
    }

    function test_cancel_isOwnerOnlyAndNotRepeatable() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(RecurringPayments.NotOwner.selector);
        ledger.cancel(id);

        vm.startPrank(owner);
        ledger.cancel(id);
        vm.expectRevert(
            abi.encodeWithSelector(RecurringPayments.WrongStatus.selector, RecurringPayments.Status.Cancelled)
        );
        ledger.cancel(id);
        vm.stopPrank();
    }

    function test_cancel_revertsWhenOwnerCannotReceiveRefund() public {
        RefundRejector rejector = new RefundRejector(ledger);
        vm.deal(address(rejector), ESCROW);
        uint256 id = rejector.create{ value: 0 }(recipient, AMOUNT, FEE, INTERVAL, RUNS);
        vm.expectRevert(RecurringPayments.RefundFailed.selector);
        rejector.cancel(id);
    }

    // ---------------------------------------------------------------- invariants

    function testFuzz_escrowAlwaysCoversRemainingRunsAndReserve(uint8 runsSeed, uint8 stepsSeed) public {
        uint32 runs = uint32(bound(runsSeed, 1, 10));
        uint256 steps = bound(stepsSeed, 0, runs);
        vm.prank(owner);
        uint256 id = ledger.createPlan{ value: (AMOUNT + FEE) * runs }(recipient, AMOUNT, FEE, INTERVAL, runs);

        for (uint256 i; i < steps; ++i) {
            skip(INTERVAL + 10);
            ledger.executeRun(id);
        }

        RecurringPayments.Plan memory plan = ledger.getPlan(id);
        assertEq(
            address(ledger).balance, (AMOUNT + FEE) * (plan.totalRuns - plan.completedRuns) + FEE * plan.completedRuns
        );
        assertEq(recipient.balance, AMOUNT * plan.completedRuns);
    }
}

/// @dev Owner that refuses refunds, to prove `cancel` reverts instead of silently losing funds.
contract RefundRejector {
    RecurringPayments internal immutable ledger;

    constructor(RecurringPayments ledger_) {
        ledger = ledger_;
    }

    function create(address payable to, uint256 amount, uint256 fee, uint32 interval, uint32 runs)
        external
        payable
        returns (uint256)
    {
        return ledger.createPlan{ value: (amount + fee) * runs }(to, amount, fee, interval, runs);
    }

    function cancel(uint256 id) external {
        ledger.cancel(id);
    }
}
