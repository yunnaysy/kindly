// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {Kindly} from "../src/Kindly.sol";
import {MockUSD8} from "../src/MockUSD8.sol";

contract KindlyTest is Test {
    MockUSD8 usd;
    PayeeRegistry reg;
    Kindly k;

    address operator = makeAddr("operator");
    address merchant = makeAddr("merchant");
    address other = makeAddr("other");
    address payer = makeAddr("payer");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    string constant NAME = "Sunrise Coffee Co";
    bytes32 NH = keccak256(bytes(NAME));
    uint128 constant USUAL = 24_990; // 0.02499 tUSD8 ("$24.99" scaled 1:1000)

    function setUp() public {
        usd = new MockUSD8();
        reg = new PayeeRegistry(operator);
        k = new Kindly(IERC20(address(usd)), reg, operator);
        vm.prank(merchant);
        reg.register(NAME, "");
        vm.prank(operator);
        reg.verify(merchant, NH);
        vm.prank(other);
        reg.register("Other Shop", "");
        vm.prank(operator);
        reg.verify(other, keccak256("Other Shop"));
        usd.mint(payer, 1_000e6);
        usd.mint(merchant, 10e6);
        vm.prank(payer);
        usd.approve(address(k), type(uint256).max);
        vm.prank(merchant);
        usd.approve(address(k), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers
    function _inv(address m, bytes32 ref, uint128 amount) internal returns (bytes32 id) {
        vm.prank(m);
        id = k.createInvoice(ref, address(0), amount, uint64(block.timestamp + 1 days), "memo");
    }

    function _mandate(uint128 cap, uint128 budget, uint128 typical, bool any) internal returns (uint256 id) {
        address[] memory ms = new address[](1);
        ms[0] = merchant;
        vm.prank(payer);
        id = k.createMandate(
            Kindly.MandateParams({
                agent: agent,
                perPaymentCap: cap,
                totalBudget: budget,
                typicalAmount: typical,
                validUntil: uint64(block.timestamp + 7 days),
                cooldown: 0,
                anyMerchant: any,
                requireVerifiedPayee: true,
                merchants: ms
            })
        );
    }

    function _process(uint256 m, bytes32 id, bytes32 nh) internal returns (Kindly.Decision d, Kindly.Reason r, uint8 risk) {
        vm.prank(agent);
        return k.agentProcess(m, id, nh);
    }

    // ------------------------------------------------------------ the demo trio
    function test_DemoTrio_PayHoldReject() public {
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        bytes32 a = _inv(merchant, "INV-1001", USUAL);
        (Kindly.Decision d, Kindly.Reason r, uint8 risk) = _process(m, a, NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Pay));
        assertEq(uint8(r), uint8(Kindly.Reason.Ok));
        assertLe(risk, 45);
        assertEq(uint8(k.getInvoice(a).status), uint8(Kindly.Status.Paid));

        bytes32 b = _inv(merchant, "INV-1002", 149_000);
        uint256 before = usd.balanceOf(payer);
        (d, r, risk) = _process(m, b, NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Hold));
        assertEq(uint8(r), uint8(Kindly.Reason.AmountAnomaly));
        assertGe(risk, 50);
        assertEq(usd.balanceOf(payer), before);
        assertTrue(k.getHold(b).active);
        vm.prank(payer);
        k.approveHold(b, NH);
        assertEq(uint8(k.getInvoice(b).status), uint8(Kindly.Status.Paid));
        assertEq(before - usd.balanceOf(payer), 149_000);

        bytes32 c = _inv(merchant, "INV-1001", USUAL);
        (d, r,) = _process(m, c, NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.Duplicate));
        assertEq(uint8(k.getInvoice(c).status), uint8(Kindly.Status.Open));
    }

    function test_DecisionEventEmitted() public {
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.expectEmit(true, true, false, true);
        emit Kindly.SafetyDecision(a, m, Kindly.Decision.Pay, Kindly.Reason.Ok, 19, USUAL, 25_000);
        _process(m, a, NH);
    }

    // ------------------------------------------------------------- gate rules
    function test_PayeeMismatchHolds() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, a, keccak256("Sunrise Cofee Co"));
        assertEq(uint8(d), uint8(Kindly.Decision.Hold));
        assertEq(uint8(r), uint8(Kindly.Reason.PayeeMismatch));
        vm.prank(payer);
        vm.expectRevert(Kindly.PayeeMismatch.selector);
        k.approveHold(a, keccak256("Sunrise Cofee Co"));
        vm.prank(payer);
        k.approveHold(a, NH);
    }

    function test_UnverifiedPayeeHolds() public {
        uint256 m = _mandate(200_000, 500_000, 0, true);
        vm.prank(stranger);
        reg.register("New Vendor", "");
        bytes32 a = _inv(stranger, "A", USUAL);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, a, keccak256("New Vendor"));
        assertEq(uint8(d), uint8(Kindly.Decision.Hold));
        assertEq(uint8(r), uint8(Kindly.Reason.PayeeUnverified));
    }

    function test_OverCapRejects() public {
        uint256 m = _mandate(100_000, 500_000, 0, false);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, _inv(merchant, "A", 100_001), NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.OverCap));
    }

    function test_OverBudgetRejects() public {
        uint256 m = _mandate(100_000, 150_000, 0, false);
        _process(m, _inv(merchant, "A", 100_000), NH);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, _inv(merchant, "B", 100_000), NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.OverBudget));
    }

    function test_MerchantNotAllowlistedRejects() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, _inv(other, "A", USUAL), keccak256("Other Shop"));
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.MerchantNotAllowed));
        vm.prank(payer);
        k.setMandateMerchant(m, other, true);
        (d,,) = _process(m, _inv(other, "B", USUAL), keccak256("Other Shop"));
        assertEq(uint8(d), uint8(Kindly.Decision.Pay));
    }

    function test_ExpiredRejects() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.warp(block.timestamp + 1 days + 1);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, a, NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.Expired));
    }

    function test_CancelledRejects() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.prank(merchant);
        k.cancelInvoice(a);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, a, NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.NotOpen));
    }

    function test_PayerRestrictionRejects() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        vm.prank(merchant);
        bytes32 a = k.createInvoice("A", stranger, USUAL, uint64(block.timestamp + 1 days), "");
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, a, NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.PayerNotAllowed));
    }

    function test_UsualAmountLearnsFromHistory() public {
        uint256 m = _mandate(1e6, 5e6, 0, false);
        (Kindly.Decision d,,) = _process(m, _inv(merchant, "A", 100_000), NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Pay));
        (d,,) = _process(m, _inv(merchant, "B", 299_999), NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Pay));
        (Kindly.Decision d2, Kindly.Reason r2,) = _process(m, _inv(merchant, "C", 600_000), NH);
        assertEq(uint8(d2), uint8(Kindly.Decision.Hold));
        assertEq(uint8(r2), uint8(Kindly.Reason.AmountAnomaly));
    }

    function test_RejectHoldAndNoDoubleHold() public {
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        bytes32 b = _inv(merchant, "B", 149_000);
        _process(m, b, NH);
        vm.prank(agent);
        vm.expectRevert(Kindly.AlreadyHeld.selector);
        k.agentProcess(m, b, NH);
        vm.prank(stranger);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.rejectHold(b);
        vm.prank(payer);
        k.rejectHold(b);
        vm.prank(payer);
        vm.expectRevert(Kindly.NoActiveHold.selector);
        k.approveHold(b, NH);
    }

    function test_DirectPayRejectsDuplicateNumber() public {
        bytes32 a = _inv(merchant, "INV-7", USUAL);
        vm.prank(payer);
        k.payInvoice(a, NH, USUAL);
        bytes32 b = _inv(merchant, "INV-7", USUAL);
        vm.prank(payer);
        vm.expectRevert(Kindly.DuplicateInvoice.selector);
        k.payInvoice(b, NH, USUAL);
    }

    function test_DirectPayGuards() public {
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.startPrank(payer);
        vm.expectRevert(Kindly.PayeeMismatch.selector);
        k.payInvoice(a, keccak256("Sunrise Cofee Co"), USUAL);
        vm.expectRevert(Kindly.AmountAboveMax.selector);
        k.payInvoice(a, NH, USUAL - 1);
        bytes32 receipt = k.payInvoice(a, NH, USUAL);
        assertTrue(k.verifyReceipt(a, receipt));
        vm.expectRevert(Kindly.InvoiceNotOpen.selector);
        k.payInvoice(a, NH, USUAL);
        vm.stopPrank();
    }

    function test_RefundReturnsTokens() public {
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.prank(payer);
        k.payInvoice(a, NH, USUAL);
        uint256 before = usd.balanceOf(payer);
        vm.prank(merchant);
        k.refund(a, USUAL);
        assertEq(usd.balanceOf(payer) - before, USUAL);
        assertEq(uint8(k.getInvoice(a).status), uint8(Kindly.Status.Refunded));
    }

    // ---------------------------------------------------------- control center
    function test_FreezeUnfreezeRevoke() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.prank(payer);
        k.setFrozen(m, true);
        assertEq(k.mandateRemaining(m), 0);
        vm.prank(agent);
        vm.expectRevert(Kindly.MandateIsFrozen.selector);
        k.agentProcess(m, a, NH);
        vm.prank(payer);
        k.setFrozen(m, false);
        _process(m, a, NH);
        vm.prank(payer);
        k.revokeMandate(m);
        bytes32 b = _inv(merchant, "B", USUAL);
        vm.prank(agent);
        vm.expectRevert(Kindly.MandateInactive.selector);
        k.agentProcess(m, b, NH);
        vm.prank(payer);
        vm.expectRevert(Kindly.MandateInactive.selector);
        k.setFrozen(m, false);
    }

    function test_UpdateLimits() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        _process(m, _inv(merchant, "A", 100_000), NH);
        vm.startPrank(payer);
        vm.expectRevert(Kindly.InvalidAmount.selector);
        k.updateMandate(m, 50_000, 90_000, 0, uint64(block.timestamp + 1 days), 0, false, true);
        k.updateMandate(m, 50_000, 300_000, 0, uint64(block.timestamp + 1 days), 0, false, true);
        vm.stopPrank();
        assertEq(k.mandateRemaining(m), 200_000);
        (Kindly.Decision d, Kindly.Reason r,) = _process(m, _inv(merchant, "B", 60_000), NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Reject));
        assertEq(uint8(r), uint8(Kindly.Reason.OverCap));
    }

    function test_OnlyOwnerControls() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        vm.startPrank(agent);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.setFrozen(m, true);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.revokeMandate(m);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.setMandateMerchant(m, other, true);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.updateMandate(m, 1, 1, 0, uint64(block.timestamp + 1), 0, true, false);
        vm.stopPrank();
    }

    function test_OnlyAgentProcesses() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.prank(stranger);
        vm.expectRevert(Kindly.NotMandateAgent.selector);
        k.agentProcess(m, a, NH);
    }

    function test_MandateExpiryAndCooldown() public {
        address[] memory ms = new address[](0);
        vm.prank(payer);
        uint256 m = k.createMandate(
            Kindly.MandateParams(agent, 200_000, 500_000, 0, uint64(block.timestamp + 2 hours), 1 hours, true, true, ms)
        );
        _process(m, _inv(merchant, "A", USUAL), NH);
        bytes32 b = _inv(merchant, "B", USUAL);
        vm.prank(agent);
        vm.expectRevert(Kindly.MandateCooldown.selector);
        k.agentProcess(m, b, NH);
        vm.warp(block.timestamp + 1 hours);
        _process(m, b, NH);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(merchant);
        bytes32 c = k.createInvoice("C", address(0), USUAL, uint64(block.timestamp + 1 days), "");
        vm.prank(agent);
        vm.expectRevert(Kindly.MandateExpired.selector);
        k.agentProcess(m, c, NH);
    }

    function test_PauseStopsAgentButNotControls() public {
        uint256 m = _mandate(200_000, 500_000, 0, false);
        bytes32 a = _inv(merchant, "A", USUAL);
        vm.prank(operator);
        k.pause();
        vm.prank(agent);
        vm.expectRevert();
        k.agentProcess(m, a, NH);
        vm.prank(payer);
        k.revokeMandate(m);
    }

    function test_InvalidMandateParams() public {
        address[] memory ms = new address[](0);
        vm.startPrank(payer);
        vm.expectRevert(Kindly.InvalidMandate.selector);
        k.createMandate(Kindly.MandateParams(payer, 1, 1, 0, uint64(block.timestamp + 1), 0, true, true, ms));
        vm.expectRevert(Kindly.InvalidAmount.selector);
        k.createMandate(Kindly.MandateParams(agent, 2, 1, 0, uint64(block.timestamp + 1), 0, true, true, ms));
        vm.expectRevert(Kindly.InvalidExpiry.selector);
        k.createMandate(Kindly.MandateParams(agent, 1, 1, 0, uint64(block.timestamp), 0, true, true, ms));
        vm.stopPrank();
    }

    // ---------------------------------------------------------- registry (CoP)
    function test_ConfirmationOfPayee() public view {
        assertEq(uint8(reg.confirm(merchant, NH)), uint8(PayeeRegistry.Confirmation.MatchVerified));
        assertEq(uint8(reg.confirm(merchant, keccak256("Sunrise Cofee Co"))), uint8(PayeeRegistry.Confirmation.NoMatch));
        assertEq(uint8(reg.confirm(stranger, NH)), uint8(PayeeRegistry.Confirmation.Unregistered));
    }

    function test_RenameVoidsVerification() public {
        vm.prank(merchant);
        reg.register("Totally Legit Bank", "");
        assertFalse(reg.isVerified(merchant));
    }

    function test_VerifyRequiresExactNameHash() public {
        vm.prank(operator);
        vm.expectRevert(PayeeRegistry.NameHashMismatch.selector);
        reg.verify(other, NH);
    }

    function test_OnlyAttesterVerifies() public {
        vm.prank(stranger);
        vm.expectRevert(PayeeRegistry.NotAttester.selector);
        reg.verify(merchant, NH);
    }

    // -------------------------------------------------------------------- fuzz
    function testFuzz_AgentNeverExceedsBudget(uint128 cap, uint128 budget, uint8 n, uint128 seed) public {
        budget = uint128(bound(budget, 1, 50e6));
        cap = uint128(bound(cap, 1, budget));
        n = uint8(bound(n, 1, 15));
        address[] memory ms = new address[](0);
        vm.prank(payer);
        uint256 m = k.createMandate(Kindly.MandateParams(agent, cap, budget, 0, uint64(block.timestamp + 1 days), 0, true, true, ms));
        uint256 start = usd.balanceOf(payer);
        for (uint256 i; i < n; i++) {
            uint128 amt = uint128(bound(uint256(keccak256(abi.encode(seed, i))), 1, uint256(cap) * 2));
            bytes32 id = _inv(merchant, bytes32(i + 1), amt);
            vm.prank(agent);
            try k.agentProcess(m, id, NH) {} catch {}
        }
        assertLe(start - usd.balanceOf(payer), budget);
        assertEq(start - usd.balanceOf(payer), k.getMandate(m).spent);
    }

    function testFuzz_HoldNeverMovesFunds(uint128 amount) public {
        amount = uint128(bound(amount, 75_000, 200_000));
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        uint256 start = usd.balanceOf(payer);
        (Kindly.Decision d,,) = _process(m, _inv(merchant, "X", amount), NH);
        assertEq(uint8(d), uint8(Kindly.Decision.Hold));
        assertEq(usd.balanceOf(payer), start);
    }

    /// Replay / duplicate protection: an invoice number paid once can never be paid again by the same payer,
    /// whether the agent, a hold approval or the payer submits it.
    function testFuzz_InvoiceNumberNeverPaidTwice(bytes32 ref, uint128 amount, uint8 path) public {
        amount = uint128(bound(amount, 1, 70_000));
        uint256 m = _mandate(200_000, 5_000_000, 25_000, false);
        bytes32 a = _inv(merchant, ref, amount);
        vm.prank(payer);
        k.payInvoice(a, NH, amount);
        uint256 after1 = usd.balanceOf(payer);
        bytes32 b = _inv(merchant, ref, amount); // merchant re-sends the same number
        path = uint8(bound(path, 0, 1));
        if (path == 0) {
            (Kindly.Decision d, Kindly.Reason r,) = _process(m, b, NH);
            assertEq(uint8(d), uint8(Kindly.Decision.Reject));
            assertEq(uint8(r), uint8(Kindly.Reason.Duplicate));
        } else {
            vm.prank(payer);
            vm.expectRevert(Kindly.DuplicateInvoice.selector);
            k.payInvoice(b, NH, amount);
        }
        assertEq(usd.balanceOf(payer), after1);
    }

    /// Access control: nobody but the mandate owner can change limits, freeze, revoke, approve or reject holds.
    function testFuzz_OnlyOwnerControlsMandate(address caller) public {
        vm.assume(caller != payer);
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        bytes32 h = _inv(merchant, "HOLD-ME", 150_000);
        _process(m, h, NH); // 6x usual -> HOLD
        vm.startPrank(caller);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.updateMandate(m, 1e12, 1e12, 0, uint64(block.timestamp + 1 days), 0, true, false);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.setFrozen(m, true);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.revokeMandate(m);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.setMandateMerchant(m, caller, true);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.approveHold(h, NH);
        vm.expectRevert(Kindly.NotMandateOwner.selector);
        k.rejectHold(h);
        vm.stopPrank();
    }

    /// Frozen or revoked mandates can't spend, for any invoice.
    function testFuzz_FrozenOrRevokedNeverPays(uint128 amount, bool revoke) public {
        amount = uint128(bound(amount, 1, 70_000));
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        vm.prank(payer);
        if (revoke) k.revokeMandate(m);
        else k.setFrozen(m, true);
        bytes32 id = _inv(merchant, "F", amount);
        vm.prank(agent);
        vm.expectRevert(revoke ? Kindly.MandateInactive.selector : Kindly.MandateIsFrozen.selector);
        k.agentProcess(m, id, NH);
        assertEq(k.mandateRemaining(m), 0);
    }

    /// Documents a known accounting limitation: a hold the owner approves is paid from the owner's wallet
    /// but is not added to the mandate's `spent` counter (the agent's automatic budget is unchanged).
    function test_KnownLimitation_ApprovedHoldNotCountedInSpent() public {
        uint256 m = _mandate(200_000, 500_000, 25_000, false);
        bytes32 h = _inv(merchant, "BIG", 150_000);
        _process(m, h, NH);
        vm.prank(payer);
        k.approveHold(h, NH);
        assertEq(uint8(k.getInvoice(h).status), uint8(Kindly.Status.Paid));
        assertEq(k.getMandate(m).spent, 0);
    }
}
