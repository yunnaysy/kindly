// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PayeeRegistry — on-chain Confirmation of Payee (CoP) for Aevum
/// @notice Merchants self-register a display name. An attester (KYB partner, marketplace,
///         or the ClearBill operator during the testnet) can verify the *exact* name hash.
///         If a merchant changes its name, verification lapses automatically, so a payer
///         can never be shown a verified badge for a name that was not checked.
contract PayeeRegistry is Ownable {
    enum Confirmation {
        Unregistered, // address has never registered or deactivated itself
        NoMatch, // name the payer expects does not match the registered name
        MatchUnverified, // name matches, but no attester has verified it
        MatchVerified // name matches and is attested
    }

    struct Payee {
        string name;
        string metadataURI;
        bytes32 verifiedNameHash; // hash that the attester verified (0 = never)
        address verifiedBy;
        uint64 registeredAt;
        uint64 verifiedAt;
        bool active;
    }

    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_URI_LENGTH = 256;

    mapping(address => Payee) private _payees;
    mapping(address => bool) public isAttester;

    event PayeeRegistered(address indexed payee, string name, bytes32 indexed nameHash, string metadataURI);
    event PayeeDeactivated(address indexed payee);
    event PayeeVerified(address indexed payee, bytes32 indexed nameHash, address indexed attester);
    event PayeeVerificationRevoked(address indexed payee, address indexed attester);
    event AttesterSet(address indexed attester, bool allowed);

    error InvalidName();
    error InvalidURI();
    error NotAttester();
    error NotRegistered();
    error NameHashMismatch();

    constructor(address initialOwner) Ownable(initialOwner) {
        isAttester[initialOwner] = true;
        emit AttesterSet(initialOwner, true);
    }

    modifier onlyAttester() {
        if (!isAttester[msg.sender]) revert NotAttester();
        _;
    }

    // ------------------------------------------------------------------ admin

    function setAttester(address attester, bool allowed) external onlyOwner {
        isAttester[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    // ------------------------------------------------------------------ payee

    /// @notice Register or update your payee profile. Updating the name voids verification.
    function register(string calldata name, string calldata metadataURI) external {
        uint256 len = bytes(name).length;
        if (len == 0 || len > MAX_NAME_LENGTH) revert InvalidName();
        if (bytes(metadataURI).length > MAX_URI_LENGTH) revert InvalidURI();
        Payee storage p = _payees[msg.sender];
        if (p.registeredAt == 0) p.registeredAt = uint64(block.timestamp);
        p.name = name;
        p.metadataURI = metadataURI;
        p.active = true;
        emit PayeeRegistered(msg.sender, name, keccak256(bytes(name)), metadataURI);
    }

    function deactivate() external {
        Payee storage p = _payees[msg.sender];
        if (!p.active) revert NotRegistered();
        p.active = false;
        emit PayeeDeactivated(msg.sender);
    }

    // --------------------------------------------------------------- attester

    /// @notice Verify a payee. The attester must pass the name hash it checked off-chain,
    ///         which protects against a merchant front-running a rename before verification.
    function verify(address payee, bytes32 expectedNameHash) external onlyAttester {
        Payee storage p = _payees[payee];
        if (!p.active) revert NotRegistered();
        if (keccak256(bytes(p.name)) != expectedNameHash) revert NameHashMismatch();
        p.verifiedNameHash = expectedNameHash;
        p.verifiedBy = msg.sender;
        p.verifiedAt = uint64(block.timestamp);
        emit PayeeVerified(payee, expectedNameHash, msg.sender);
    }

    function revokeVerification(address payee) external onlyAttester {
        Payee storage p = _payees[payee];
        p.verifiedNameHash = bytes32(0);
        p.verifiedBy = address(0);
        p.verifiedAt = 0;
        emit PayeeVerificationRevoked(payee, msg.sender);
    }

    // ------------------------------------------------------------------ views

    function getPayee(address payee) external view returns (Payee memory) {
        return _payees[payee];
    }

    function nameHashOf(address payee) public view returns (bytes32) {
        return keccak256(bytes(_payees[payee].name));
    }

    function isActive(address payee) public view returns (bool) {
        return _payees[payee].active;
    }

    function isVerified(address payee) public view returns (bool) {
        Payee storage p = _payees[payee];
        return p.active && p.verifiedNameHash != bytes32(0) && p.verifiedNameHash == keccak256(bytes(p.name));
    }

    /// @notice Confirmation of Payee: "is `payee` really called `expectedNameHash`?"
    function confirm(address payee, bytes32 expectedNameHash) public view returns (Confirmation) {
        Payee storage p = _payees[payee];
        if (!p.active) return Confirmation.Unregistered;
        if (keccak256(bytes(p.name)) != expectedNameHash) return Confirmation.NoMatch;
        return isVerified(payee) ? Confirmation.MatchVerified : Confirmation.MatchUnverified;
    }
}
