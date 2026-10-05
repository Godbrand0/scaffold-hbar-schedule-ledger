// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { RecurringPayments } from "../contracts/RecurringPayments.sol";
import { MockHederaScheduleService } from "./mocks/MockHederaScheduleService.sol";
import { RejectingReceiver } from "./mocks/RejectingReceiver.sol";
import { MockSupraStorage } from "./mocks/MockSupraStorage.sol";
import { ISupraSValueFeed } from "../contracts/interfaces/ISupraSValueFeed.sol";

contract RecurringPaymentsTest is Test {
    address internal constant HSS = 0x000000000000000000000000000000000000016B;
    int64 internal constant SCHEDULE_EXPIRY_IS_BUSY = 359; // sample response-code ordinal returned by the mock

    uint256 internal constant AMOUNT = 1_000_000; // tinybar per run
    uint256 internal constant FEE = 500_000; // prepaid network-fee reserve per run
    uint32 internal constant INTERVAL = 3600;
    uint32 internal constant RUNS = 3;
    uint256 internal constant ESCROW = (AMOUNT + FEE) * RUNS;

    uint256 internal constant HBAR_USD_PAIR = 432;
    uint256 internal constant MAX_PRICE_AGE = 3600;
    uint256 internal constant PRICE = 0.1e18; // $0.10 per HBAR, 18 decimals like Supra
    uint256 internal constant USD_PER_RUN = 10e8; // $10 with 8 decimals
    uint256 internal constant USD_PAYOUT = 100e8; // $10 at $0.10 per HBAR is 100 HBAR, in tinybar
    uint256 internal constant CAP = 150e8; // escrowed per-run cap for USD plans, in tinybar

    RecurringPayments internal ledger;
    MockHederaScheduleService internal hss;
    MockSupraStorage internal oracle;

    address internal owner = makeAddr("owner");
    address payable internal recipient = payable(makeAddr("recipient"));
    address internal stranger = makeAddr("stranger");

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
    event PaymentExecuted(
        uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount, uint256 hbarUsdPrice
    );
    event PriceRejected(
        uint256 indexed planId,
        uint32 runIndex,
        RecurringPayments.PriceProblem problem,
        uint256 price,
        uint256 updatedAtMs
    );
    event SurplusClaimed(uint256 indexed planId, uint256 amount);
    event PaymentFailed(uint256 indexed planId, uint32 runIndex, address indexed recipient, uint256 amount);
    event PlanResumed(uint256 indexed planId);
    event PlanCompleted(uint256 indexed planId);
    event PlanCancelled(uint256 indexed planId, uint256 refunded);

    function setUp() public {
        // Foundry has no HSS, so etch a mock at the real system contract address.
        vm.etch(HSS, address(new MockHederaScheduleService()).code);
        hss = MockHederaScheduleService(HSS);
        oracle = new MockSupraStorage();
        oracle.set(PRICE, 18, block.timestamp * 1000);
        ledger = new RecurringPayments(ISupraSValueFeed(address(oracle)), HBAR_USD_PAIR, MAX_PRICE_AGE);
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

    // ---------------------------------------------------------------- USD plans (Supra oracle)

    function _createUsd(uint32 runs) internal returns (uint256) {
        vm.prank(owner);
        return ledger.createUsdPlan{ value: (CAP + FEE) * runs }(recipient, USD_PER_RUN, CAP, FEE, INTERVAL, runs);
    }

    function _due(uint256 id) internal {
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(oracle.feed_price(), 18, block.timestamp * 1000); // keep the price fresh for the run
    }

    function test_usdPlan_storesTerms_andEscrowsTheCap() public {
        vm.expectEmit(true, true, true, true);
        emit PlanCreated(1, owner, recipient, CAP, USD_PER_RUN, FEE, INTERVAL, 2);
        uint256 id = _createUsd(2);

        RecurringPayments.Plan memory plan = ledger.getPlan(id);
        assertEq(plan.usdPerRun, USD_PER_RUN);
        assertEq(plan.amountPerRun, CAP);
        assertEq(address(ledger).balance, (CAP + FEE) * 2);
    }

    function test_usdPlan_paysUsdValueAtTheOraclePrice() public {
        uint256 id = _createUsd(2);
        _due(id);
        vm.expectEmit(true, true, true, true);
        emit PaymentExecuted(id, 1, recipient, USD_PAYOUT, PRICE);

        hss.fire(0);

        assertEq(recipient.balance, USD_PAYOUT);
        assertEq(ledger.getPlan(id).completedRuns, 1);
        assertEq(ledger.getPlan(id).surplus, CAP - USD_PAYOUT);
    }

    function test_usdPlan_payoutFollowsThePrice() public {
        uint256 id = _createUsd(2);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(0.2e18, 18, block.timestamp * 1000); // HBAR doubles, so $10 is only 50 HBAR

        hss.fire(0);

        assertEq(recipient.balance, 50e8);
    }

    function test_usdPlan_secondRunUsesTheNewPrice() public {
        uint256 id = _createUsd(2);
        _due(id);
        hss.fire(0);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(0.25e18, 18, block.timestamp * 1000);

        hss.fire(1);

        assertEq(recipient.balance, USD_PAYOUT + 40e8);
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Completed));
    }

    function test_usdPlan_pausesOnAStalePrice() public {
        uint256 id = _createUsd(2);
        vm.warp(ledger.getPlan(id).nextRunAt);
        uint256 publishedMs = (block.timestamp - MAX_PRICE_AGE - 1) * 1000;
        oracle.set(PRICE, 18, publishedMs);
        vm.expectEmit(true, true, true, true);
        emit PriceRejected(id, 1, RecurringPayments.PriceProblem.Stale, PRICE, publishedMs);

        hss.fire(0);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Paused));
        assertEq(recipient.balance, 0);
        assertEq(ledger.getPlan(id).completedRuns, 0);
    }

    function test_usdPlan_acceptsAPriceExactlyAtTheAgeLimit() public {
        uint256 id = _createUsd(2);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(PRICE, 18, (block.timestamp - MAX_PRICE_AGE) * 1000);

        hss.fire(0);

        assertEq(recipient.balance, USD_PAYOUT);
    }

    function test_usdPlan_aFutureTimestampCountsAsFresh() public {
        uint256 id = _createUsd(2);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(PRICE, 18, (block.timestamp + 5) * 1000);

        hss.fire(0);

        assertEq(recipient.balance, USD_PAYOUT);
    }

    function test_usdPlan_pausesWhenTheOracleReverts() public {
        uint256 id = _createUsd(2);
        _due(id);
        oracle.setBroken(true);
        vm.expectEmit(true, true, true, false);
        emit PriceRejected(id, 1, RecurringPayments.PriceProblem.OracleReverted, 0, 0);

        hss.fire(0);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Paused));
        assertEq(recipient.balance, 0);
    }

    function test_usdPlan_pausesOnAZeroPrice() public {
        uint256 id = _createUsd(2);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(0, 18, block.timestamp * 1000);

        hss.fire(0);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Paused));
    }

    function test_usdPlan_pausesWhenThePayoutWouldExceedTheCap() public {
        uint256 id = _createUsd(2);
        vm.warp(ledger.getPlan(id).nextRunAt);
        uint256 low = 0.05e18; // $10 would need 200 HBAR, above the 150 HBAR cap
        oracle.set(low, 18, block.timestamp * 1000);
        vm.expectEmit(true, true, true, true);
        emit PriceRejected(id, 1, RecurringPayments.PriceProblem.AboveCap, low, block.timestamp * 1000);

        hss.fire(0);

        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Paused));
        assertEq(recipient.balance, 0);
    }

    function test_usdPlan_resumeRetriesWithAFreshPrice() public {
        uint256 id = _createUsd(1);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(PRICE, 18, 0); // published at the epoch, so far older than MAX_PRICE_AGE
        hss.fire(0);
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Paused));

        oracle.set(PRICE, 18, block.timestamp * 1000);
        vm.prank(owner);
        ledger.resume(id);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(PRICE, 18, block.timestamp * 1000);
        hss.fire(1);

        assertEq(recipient.balance, USD_PAYOUT);
        assertEq(uint8(_status(id)), uint8(RecurringPayments.Status.Completed));
    }

    function test_usdPlan_handlesOracleDecimalsOtherThan18() public {
        uint256 id = _createUsd(1);
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(10_000_000, 8, block.timestamp * 1000); // $0.10 with 8 decimals

        hss.fire(0);

        assertEq(recipient.balance, USD_PAYOUT);
    }

    function test_usdPlan_surplusCanBeClaimedByTheOwnerOnly() public {
        uint256 id = _createUsd(1);
        _due(id);
        hss.fire(0);
        uint256 surplus = CAP - USD_PAYOUT;

        vm.prank(stranger);
        vm.expectRevert(RecurringPayments.NotOwner.selector);
        ledger.claimSurplus(id);

        uint256 before = owner.balance;
        vm.expectEmit(true, false, false, true);
        emit SurplusClaimed(id, surplus);
        vm.prank(owner);
        ledger.claimSurplus(id);

        assertEq(owner.balance, before + surplus);
        vm.prank(owner);
        vm.expectRevert(RecurringPayments.NothingToClaim.selector);
        ledger.claimSurplus(id);
    }

    function test_usdPlan_cancelRefundsUnpaidRunsAndTheSurplus() public {
        uint256 id = _createUsd(3);
        _due(id);
        hss.fire(0);
        uint256 before = owner.balance;

        vm.prank(owner);
        ledger.cancel(id);

        assertEq(owner.balance, before + (CAP + FEE) * 2 + (CAP - USD_PAYOUT));
        assertEq(ledger.getPlan(id).surplus, 0);
        // What is left is exactly the fee reserve of the run that fired.
        assertEq(address(ledger).balance, FEE);
    }

    /// For any oracle price a USD run either pays a sane amount within the escrowed cap or pauses and pays nothing.
    function testFuzz_usdPlan_neverPaysAboveTheCapAndKeepsTheBooksBalanced(uint256 price, uint8 decimals) public {
        price = bound(price, 1, 1e30);
        decimals = uint8(bound(decimals, 0, 30));
        uint256 id = _createUsd(2);
        uint256 contractBefore = address(ledger).balance;
        vm.warp(ledger.getPlan(id).nextRunAt);
        oracle.set(price, decimals, block.timestamp * 1000);

        hss.fire(0);

        RecurringPayments.Plan memory plan = ledger.getPlan(id);
        assertLe(recipient.balance, CAP);
        assertEq(address(ledger).balance, contractBefore - recipient.balance);
        if (plan.status == RecurringPayments.Status.Paused) {
            assertEq(recipient.balance, 0);
            assertEq(plan.surplus, 0);
        } else {
            assertEq(plan.surplus, CAP - recipient.balance);
        }
    }

    function test_usdPlan_validatesInputs() public {
        vm.startPrank(owner);
        vm.expectRevert(RecurringPayments.InvalidAmount.selector);
        ledger.createUsdPlan{ value: 0 }(recipient, 0, CAP, FEE, INTERVAL, 1);
        vm.expectRevert(RecurringPayments.InvalidAmount.selector);
        ledger.createUsdPlan{ value: 0 }(recipient, USD_PER_RUN, 0, FEE, INTERVAL, 1);
        vm.expectRevert(abi.encodeWithSelector(RecurringPayments.WrongEscrow.selector, CAP + FEE, 1));
        ledger.createUsdPlan{ value: 1 }(recipient, USD_PER_RUN, CAP, FEE, INTERVAL, 1);
        vm.stopPrank();
    }

    function test_quoteUsd_isAViewAnyoneCanCall() public view {
        (uint256 tinybar, uint256 price, uint256 updatedAtMs, RecurringPayments.PriceProblem problem) =
            ledger.quoteUsd(USD_PER_RUN);
        assertEq(tinybar, USD_PAYOUT);
        assertEq(price, PRICE);
        assertEq(updatedAtMs, block.timestamp * 1000);
        assertEq(uint8(problem), uint8(RecurringPayments.PriceProblem.None));
    }

    function test_fixedPlans_ignoreTheOracleEntirely() public {
        uint256 id = _create();
        oracle.setBroken(true);
        vm.warp(ledger.getPlan(id).nextRunAt);

        hss.fire(0);

        assertEq(recipient.balance, AMOUNT);
        assertEq(ledger.getPlan(id).surplus, 0);
    }

    function test_constructor_rejectsABadOracleConfig() public {
        vm.expectRevert(RecurringPayments.InvalidOracle.selector);
        new RecurringPayments(ISupraSValueFeed(address(0)), HBAR_USD_PAIR, MAX_PRICE_AGE);
        vm.expectRevert(RecurringPayments.InvalidOracle.selector);
        new RecurringPayments(ISupraSValueFeed(address(oracle)), HBAR_USD_PAIR, 0);
    }

    // ---------------------------------------------------------------- createPlan

    function test_createPlan_escrowsFundsAndBooksFirstRun() public {
        vm.expectEmit(true, true, true, true);
        emit PlanCreated(1, owner, recipient, AMOUNT, 0, FEE, INTERVAL, RUNS);
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
        emit PaymentExecuted(id, 1, recipient, AMOUNT, 0);
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
        emit PaymentExecuted(id, 1, recipient, AMOUNT, 0);
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
