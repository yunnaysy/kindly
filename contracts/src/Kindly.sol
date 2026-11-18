// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PayeeRegistry} from "./PayeeRegistry.sol";

/// @title Kindly: payments, taken care of.
/// @notice tUSD8 invoices (shared as payment links / QR codes) with on-chain Confirmation of Payee, plus
///         AI-agent mandates guarded by a deterministic, on-chain **Invoice Safety Gate**.
///         Every agent payment attempt is evaluated by the contract and produces a verifiable
///         `SafetyDecision` event: PAY (settled immediately), HOLD (needs an explicit payer approval tx)
///         or REJECT (nothing moves). The AI agent only explains decisions; it never makes them.
contract Kindly is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Open,
        Paid,
        Cancelled,
        Refunded
    }

    enum Decision {
        Pay,
        Hold,
        Reject
    }

    enum Reason {
        Ok,
        PayeeMismatch, // HOLD: registry name differs from the name the agent expects
        PayeeUnverified, // HOLD: mandate requires a verified payee
        AmountAnomaly, // HOLD: amount >= ANOMALY_MULTIPLIER x the merchant's usual amount
        Duplicate, // REJECT: this invoice number from this merchant was already paid
        NotOpen, // REJECT: cancelled / not payable
        Expired, // REJECT: invoice past its expiry
        MerchantNotAllowed, // REJECT: merchant not on the mandate allowlist
        OverCap, // REJECT: above the per-payment cap
        OverBudget, // REJECT: would exceed the remaining budget
        PayerNotAllowed // REJECT: invoice is addressed to someone else
    }

    struct Invoice {
        address merchant;
        address payer; // optional restriction; 0 = anyone
        address paidBy;
        uint128 amount;
        uint128 refunded;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 paidAt;
        Status status;
        uint256 mandateId; // 0 = paid directly
        bytes32 ref; // merchant's invoice number (hash). Duplicates are detected on this.
        bytes32 memoHash;
        bytes32 receipt;
    }

    struct Mandate {
        address owner; // whose tUSD8 is spent (approves this contract)
        address agent; // hot key that may submit invoices to the gate
        uint128 perPaymentCap;
        uint128 totalBudget;
        uint128 spent;
        uint128 typicalAmount; // baseline "usual amount" before any payment history exists (0 = none)
        uint64 validUntil;
        uint64 lastPaidAt;
        uint32 cooldown;
        uint32 payments;
        bool anyMerchant; // false = only allowlisted merchants
        bool requireVerifiedPayee;
        bool frozen; // temporary stop, reversible
        bool revoked; // permanent stop
    }

    struct MandateParams {
        address agent;
        uint128 perPaymentCap;
        uint128 totalBudget;
        uint128 typicalAmount;
        uint64 validUntil;
        uint32 cooldown;
        bool anyMerchant;
        bool requireVerifiedPayee;
        address[] merchants;
    }

    struct Hold {
        uint256 mandateId;
        Reason reason;
        uint8 risk;
        uint64 heldAt;
        bool active;
    }

    struct Stats {
        uint64 count;
        uint128 total;
    }

    // ---------------------------------------------------------------- storage

    uint256 public constant MAX_MEMO_LENGTH = 280;
    uint256 public constant MAX_INVOICE_LIFETIME = 365 days;
    uint256 public constant ANOMALY_MULTIPLIER = 3;

    IERC20 public immutable token;
    PayeeRegistry public immutable registry;

    mapping(bytes32 => Invoice) private _invoices;
    mapping(address => uint256) public invoiceNonce;
    mapping(uint256 => Mandate) private _mandates;
    mapping(uint256 => mapping(address => bool)) public mandateAllows;
    mapping(bytes32 => Hold) private _holds;
    mapping(bytes32 => bool) public settledRef; // keccak(payer, merchant, ref)
    mapping(bytes32 => Stats) private _stats; // keccak(payer, merchant)
    uint256 public mandateCount;

    // ----------------------------------------------------------------- events

    event InvoiceCreated(
        bytes32 indexed id,
        address indexed merchant,
        address indexed payer,
        bytes32 ref,
        uint128 amount,
        uint64 expiresAt,
        string memo
    );
    event InvoiceCancelled(bytes32 indexed id);
    event InvoicePaid(
        bytes32 indexed id,
        address indexed paidBy,
        address indexed merchant,
        uint128 amount,
        uint256 mandateId,
        address executor,
        bytes32 receipt
    );
    event InvoiceRefunded(bytes32 indexed id, address indexed to, uint128 amount, uint128 totalRefunded);
    event SafetyDecision(
        bytes32 indexed invoiceId,
        uint256 indexed mandateId,
        Decision decision,
        Reason reason,
        uint8 risk,
        uint128 amount,
        uint128 usualAmount
    );
    event HoldApproved(bytes32 indexed invoiceId, uint256 indexed mandateId, address indexed owner);
    event HoldRejected(bytes32 indexed invoiceId, uint256 indexed mandateId, address indexed owner);
    event MandateCreated(uint256 indexed id, address indexed owner, address indexed agent);
    event MandateUpdated(
        uint256 indexed id,
        uint128 perPaymentCap,
        uint128 totalBudget,
        uint128 typicalAmount,
        uint64 validUntil,
        uint32 cooldown,
        bool anyMerchant,
        bool requireVerifiedPayee
    );
    event MandateMerchantSet(uint256 indexed id, address indexed merchant, bool allowed);
    event MandateFrozen(uint256 indexed id, bool frozen);
    event MandateRevoked(uint256 indexed id, address indexed owner);

    // ----------------------------------------------------------------- errors

    error NotRegisteredPayee();
    error InvalidAmount();
    error InvalidExpiry();
    error MemoTooLong();
    error InvoiceNotOpen();
    error InvoiceExpired();
    error DuplicateInvoice();
    error NotMerchant();
    error NotAllowedPayer();
    error PayeeMismatch();
    error AmountAboveMax();
    error RefundTooLarge();
    error NotMandateOwner();
    error NotMandateAgent();
    error MandateInactive();
    error MandateExpired();
    error MandateIsFrozen();
    error MandateCooldown();
    error InvalidMandate();
    error AlreadyHeld();
    error NoActiveHold();

    constructor(IERC20 token_, PayeeRegistry registry_, address initialOwner) Ownable(initialOwner) {
        token = token_;
        registry = registry_;
    }

    // ------------------------------------------------------------------ admin

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --------------------------------------------------------------- invoices

    /// @notice Issue an invoice. `ref` is the merchant's invoice number (hashed). Re-issuing the same
    ///         number is possible (vendors do resend bills), but a number that was already paid can never be
    ///         paid again by the same payer: the agent gate REJECTs it and `payInvoice` reverts.
    function createInvoice(bytes32 ref, address payer, uint128 amount, uint64 expiresAt, string calldata memo)
        external
        whenNotPaused
        returns (bytes32 id)
    {
        if (!registry.isActive(msg.sender)) revert NotRegisteredPayee();
        if (amount == 0) revert InvalidAmount();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_INVOICE_LIFETIME) revert InvalidExpiry();
        if (bytes(memo).length > MAX_MEMO_LENGTH) revert MemoTooLong();

        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, ref, invoiceNonce[msg.sender]++));
        Invoice storage inv = _invoices[id];
        inv.merchant = msg.sender;
        inv.payer = payer;
        inv.amount = amount;
        inv.createdAt = uint64(block.timestamp);
        inv.expiresAt = expiresAt;
        inv.status = Status.Open;
        inv.ref = ref;
        inv.memoHash = keccak256(bytes(memo));
        emit InvoiceCreated(id, msg.sender, payer, ref, amount, expiresAt, memo);
    }

    function cancelInvoice(bytes32 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.merchant != msg.sender) revert NotMerchant();
        if (inv.status != Status.Open) revert InvoiceNotOpen();
        inv.status = Status.Cancelled;
        _holds[id].active = false;
        emit InvoiceCancelled(id);
    }

    /// @notice A person pays an invoice directly, pinning the merchant name (CoP) and a max amount.
    function payInvoice(bytes32 id, bytes32 expectedNameHash, uint128 maxAmount)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32)
    {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Open) revert InvoiceNotOpen();
        if (inv.amount > maxAmount) revert AmountAboveMax();
        if (settledRef[_refKey(msg.sender, inv.merchant, inv.ref)]) revert DuplicateInvoice();
        return _settle(id, msg.sender, expectedNameHash, 0);
    }

    function refund(bytes32 id, uint128 amount) external nonReentrant {
        Invoice storage inv = _invoices[id];
        if (inv.merchant != msg.sender) revert NotMerchant();
        if (inv.status != Status.Paid) revert InvoiceNotOpen();
        if (amount == 0 || uint256(inv.refunded) + amount > inv.amount) revert RefundTooLarge();
        inv.refunded += amount;
        if (inv.refunded == inv.amount) inv.status = Status.Refunded;
        token.safeTransferFrom(msg.sender, inv.paidBy, amount);
        emit InvoiceRefunded(id, inv.paidBy, amount, inv.refunded);
    }

    // ------------------------------------------------------------ safety gate

    /// @notice Pure, deterministic evaluation of an invoice against a mandate. Same logic the agent path enforces.
    function evaluate(uint256 mandateId, bytes32 invoiceId, bytes32 expectedNameHash)
        public
        view
        returns (Decision decision, Reason reason, uint8 risk, uint128 usual)
    {
        Mandate storage m = _mandates[mandateId];
        Invoice storage inv = _invoices[invoiceId];
        usual = usualAmount(m.owner, inv.merchant, m.typicalAmount);

        if (inv.status == Status.Paid || inv.status == Status.Refunded) return (Decision.Reject, Reason.Duplicate, 95, usual);
        if (inv.status != Status.Open) return (Decision.Reject, Reason.NotOpen, 100, usual);
        if (settledRef[_refKey(m.owner, inv.merchant, inv.ref)]) return (Decision.Reject, Reason.Duplicate, 95, usual);
        if (block.timestamp > inv.expiresAt) return (Decision.Reject, Reason.Expired, 90, usual);
        if (!m.anyMerchant && !mandateAllows[mandateId][inv.merchant]) {
            return (Decision.Reject, Reason.MerchantNotAllowed, 90, usual);
        }
        if (inv.payer != address(0) && inv.payer != m.owner) return (Decision.Reject, Reason.PayerNotAllowed, 90, usual);
        if (inv.amount > m.perPaymentCap) return (Decision.Reject, Reason.OverCap, 90, usual);
        if (m.spent + inv.amount > m.totalBudget) return (Decision.Reject, Reason.OverBudget, 80, usual);

        PayeeRegistry.Confirmation c = registry.confirm(inv.merchant, expectedNameHash);
        if (c != PayeeRegistry.Confirmation.MatchVerified && c != PayeeRegistry.Confirmation.MatchUnverified) {
            return (Decision.Hold, Reason.PayeeMismatch, 85, usual);
        }
        if (m.requireVerifiedPayee && c != PayeeRegistry.Confirmation.MatchVerified) {
            return (Decision.Hold, Reason.PayeeUnverified, 60, usual);
        }
        if (usual > 0 && uint256(inv.amount) >= uint256(usual) * ANOMALY_MULTIPLIER) {
            uint256 ratio = uint256(inv.amount) / usual;
            return (Decision.Hold, Reason.AmountAnomaly, uint8(ratio * 5 + 50 > 95 ? 95 : ratio * 5 + 50), usual);
        }
        // PAY: low risk, scaled by how far the amount is from the usual amount (max 45).
        uint256 r = usual == 0 ? 30 : (uint256(inv.amount) * 20) / usual;
        return (Decision.Pay, Reason.Ok, uint8(r > 45 ? 45 : r), usual);
    }

    /// @notice The agent submits an invoice to the gate. The contract decides; the decision is emitted on-chain.
    function agentProcess(uint256 mandateId, bytes32 invoiceId, bytes32 expectedNameHash)
        external
        nonReentrant
        whenNotPaused
        returns (Decision decision, Reason reason, uint8 risk)
    {
        Mandate storage m = _mandates[mandateId];
        if (m.owner == address(0)) revert InvalidMandate();
        if (msg.sender != m.agent) revert NotMandateAgent();
        if (m.revoked) revert MandateInactive();
        if (m.frozen) revert MandateIsFrozen();
        if (block.timestamp > m.validUntil) revert MandateExpired();
        if (m.payments > 0 && block.timestamp < uint256(m.lastPaidAt) + m.cooldown) revert MandateCooldown();
        if (_holds[invoiceId].active) revert AlreadyHeld();

        uint128 usual;
        (decision, reason, risk, usual) = evaluate(mandateId, invoiceId, expectedNameHash);
        Invoice storage inv = _invoices[invoiceId];
        emit SafetyDecision(invoiceId, mandateId, decision, reason, risk, inv.amount, usual);

        if (decision == Decision.Pay) {
            m.spent += inv.amount;
            m.lastPaidAt = uint64(block.timestamp);
            m.payments += 1;
            _settle(invoiceId, m.owner, expectedNameHash, mandateId);
        } else if (decision == Decision.Hold) {
            _holds[invoiceId] =
                Hold({mandateId: mandateId, reason: reason, risk: risk, heldAt: uint64(block.timestamp), active: true});
        }
    }

    /// @notice The mandate owner explicitly approves a held invoice. They must confirm the merchant's real
    ///         registered name (CoP), so approving a payee-mismatch hold is a conscious decision.
    function approveHold(bytes32 invoiceId, bytes32 confirmedNameHash) external nonReentrant whenNotPaused returns (bytes32) {
        Hold storage h = _holds[invoiceId];
        if (!h.active) revert NoActiveHold();
        Mandate storage m = _mandates[h.mandateId];
        if (msg.sender != m.owner) revert NotMandateOwner();
        Invoice storage inv = _invoices[invoiceId];
        if (settledRef[_refKey(m.owner, inv.merchant, inv.ref)]) revert DuplicateInvoice();
        h.active = false;
        emit HoldApproved(invoiceId, h.mandateId, msg.sender);
        return _settle(invoiceId, m.owner, confirmedNameHash, h.mandateId);
    }

    function rejectHold(bytes32 invoiceId) external {
        Hold storage h = _holds[invoiceId];
        if (!h.active) revert NoActiveHold();
        if (msg.sender != _mandates[h.mandateId].owner) revert NotMandateOwner();
        h.active = false;
        emit HoldRejected(invoiceId, h.mandateId, msg.sender);
    }

    function _settle(bytes32 id, address from, bytes32 expectedNameHash, uint256 mandateId) internal returns (bytes32 receipt) {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Open) revert InvoiceNotOpen();
        if (block.timestamp > inv.expiresAt) revert InvoiceExpired();
        if (inv.payer != address(0) && inv.payer != from) revert NotAllowedPayer();
        PayeeRegistry.Confirmation c = registry.confirm(inv.merchant, expectedNameHash);
        if (c != PayeeRegistry.Confirmation.MatchVerified && c != PayeeRegistry.Confirmation.MatchUnverified) {
            revert PayeeMismatch();
        }
        receipt = keccak256(
            abi.encode(block.chainid, address(this), id, from, inv.merchant, inv.amount, block.timestamp, mandateId)
        );
        inv.status = Status.Paid;
        inv.paidBy = from;
        inv.paidAt = uint64(block.timestamp);
        inv.mandateId = mandateId;
        inv.receipt = receipt;
        settledRef[_refKey(from, inv.merchant, inv.ref)] = true;
        Stats storage s = _stats[keccak256(abi.encode(from, inv.merchant))];
        s.count += 1;
        s.total += inv.amount;

        token.safeTransferFrom(from, inv.merchant, inv.amount);
        emit InvoicePaid(id, from, inv.merchant, inv.amount, mandateId, msg.sender, receipt);
    }

    function _refKey(address payer, address merchant, bytes32 ref) internal pure returns (bytes32) {
        return keccak256(abi.encode(payer, merchant, ref));
    }

    // --------------------------------------------------- mandate control center

    function createMandate(MandateParams calldata p) external whenNotPaused returns (uint256 id) {
        if (p.agent == address(0) || p.agent == msg.sender) revert InvalidMandate();
        id = ++mandateCount;
        Mandate storage m = _mandates[id];
        m.owner = msg.sender;
        m.agent = p.agent;
        emit MandateCreated(id, msg.sender, p.agent);
        _setLimits(id, p.perPaymentCap, p.totalBudget, p.typicalAmount, p.validUntil, p.cooldown, p.anyMerchant, p.requireVerifiedPayee);
        for (uint256 i; i < p.merchants.length; i++) {
            mandateAllows[id][p.merchants[i]] = true;
            emit MandateMerchantSet(id, p.merchants[i], true);
        }
    }

    function updateMandate(
        uint256 id,
        uint128 perPaymentCap,
        uint128 totalBudget,
        uint128 typicalAmount,
        uint64 validUntil,
        uint32 cooldown,
        bool anyMerchant,
        bool requireVerifiedPayee
    ) external {
        _onlyLiveOwner(id);
        _setLimits(id, perPaymentCap, totalBudget, typicalAmount, validUntil, cooldown, anyMerchant, requireVerifiedPayee);
    }

    function setMandateMerchant(uint256 id, address merchant, bool allowed) external {
        _onlyLiveOwner(id);
        mandateAllows[id][merchant] = allowed;
        emit MandateMerchantSet(id, merchant, allowed);
    }

    /// @notice Temporary, reversible stop. Works while paused.
    function setFrozen(uint256 id, bool frozen) external {
        _onlyLiveOwner(id);
        _mandates[id].frozen = frozen;
        emit MandateFrozen(id, frozen);
    }

    /// @notice Permanent kill switch. Works while paused.
    function revokeMandate(uint256 id) external {
        _onlyLiveOwner(id);
        _mandates[id].revoked = true;
        emit MandateRevoked(id, msg.sender);
    }

    function _onlyLiveOwner(uint256 id) internal view {
        Mandate storage m = _mandates[id];
        if (m.owner != msg.sender) revert NotMandateOwner();
        if (m.revoked) revert MandateInactive();
    }

    function _setLimits(
        uint256 id,
        uint128 cap,
        uint128 budget,
        uint128 typical,
        uint64 validUntil,
        uint32 cooldown,
        bool anyMerchant,
        bool requireVerified
    ) internal {
        Mandate storage m = _mandates[id];
        if (cap == 0 || budget == 0 || cap > budget || budget < m.spent) revert InvalidAmount();
        if (validUntil <= block.timestamp) revert InvalidExpiry();
        m.perPaymentCap = cap;
        m.totalBudget = budget;
        m.typicalAmount = typical;
        m.validUntil = validUntil;
        m.cooldown = cooldown;
        m.anyMerchant = anyMerchant;
        m.requireVerifiedPayee = requireVerified;
        emit MandateUpdated(id, cap, budget, typical, validUntil, cooldown, anyMerchant, requireVerified);
    }

    // ------------------------------------------------------------------ views

    function getInvoice(bytes32 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    function getMandate(uint256 id) external view returns (Mandate memory) {
        return _mandates[id];
    }

    function getHold(bytes32 invoiceId) external view returns (Hold memory) {
        return _holds[invoiceId];
    }

    /// @notice Average amount `payer` has paid `merchant`, or the mandate's baseline if there is no history.
    function usualAmount(address payer, address merchant, uint128 baseline) public view returns (uint128) {
        Stats storage s = _stats[keccak256(abi.encode(payer, merchant))];
        return s.count == 0 ? baseline : uint128(s.total / s.count);
    }

    function mandateRemaining(uint256 id) external view returns (uint128) {
        Mandate storage m = _mandates[id];
        if (m.owner == address(0) || m.revoked || m.frozen || block.timestamp > m.validUntil) return 0;
        return m.totalBudget - m.spent;
    }

    function verifyReceipt(bytes32 id, bytes32 receipt) external view returns (bool) {
        Invoice storage inv = _invoices[id];
        if (inv.receipt == bytes32(0)) return false;
        bytes32 expected = keccak256(
            abi.encode(block.chainid, address(this), id, inv.paidBy, inv.merchant, inv.amount, uint256(inv.paidAt), inv.mandateId)
        );
        return expected == receipt && inv.receipt == receipt;
    }
}
