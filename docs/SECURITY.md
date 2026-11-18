# Kindly: security, custody & privacy

> **Testnet software.** Kindly runs on QDay Aevum Testnet with a test token (tUSD8). It has automated, fuzz and static-analysis checks but **no external audit**. Never use it with real funds.

**Kindly doesn't give AI your wallet. It gives AI a permission to spend.** Every agent payment passes an on-chain Invoice Safety Gate: the contract, not the agent, decides PAY, HOLD or REJECT.

## 1. Custody: exactly what the contracts do

Everything below is checked against `contracts/src/Kindly.sol` and `PayeeRegistry.sol`.

| Claim (UI and pitch) | Why it is true in the code |
|---|---|
| **Kindly never holds your funds.** | No function receives and keeps tokens. Every payment is one `token.safeTransferFrom(payer → merchant)` inside `_settle`. Refunds are `safeTransferFrom(merchant → original payer)` in `refund`. The contract's own token balance is always 0. |
| **Your tokens stay in your wallet until a payment settles.** | Payment needs an ERC-20 allowance from you to the Kindly contract. The UI's `ensureAllowance` approves **exactly** the amount needed and never an unlimited approval. "Set allowance to 0" in Controls revokes it. |
| **Nobody else can spend your allowance.** | `_settle` is reached in only three ways. `payInvoice` takes `from = msg.sender`, so you pay for yourself. `agentProcess` is restricted to the mandate's agent (`msg.sender == m.agent`) and pays from `m.owner`. `approveHold` is restricted to the mandate owner (`msg.sender == m.owner`). |
| **The agent has no wallet access.** | The agent holds no allowance and no keys of yours. It can only call `agentProcess` for a mandate that names it. That reverts if the mandate is missing, revoked, frozen, expired or in cooldown, or if the invoice is already held. |
| **The agent can't exceed its per-payment cap or budget.** | In `evaluate`, `amount > perPaymentCap` → REJECT OverCap and `spent + amount > totalBudget` → REJECT OverBudget. Only PAY settles automatically and adds to `m.spent`. Fuzzed in `testFuzz_AgentNeverExceedsBudget`. |
| **Only allowlisted merchants** (unless the mandate says any merchant). | `!m.anyMerchant && !mandateAllows[id][merchant]` → REJECT MerchantNotAllowed. |
| **Merchant verification (Confirmation of Payee).** | `PayeeRegistry.confirm(merchant, expectedNameHash)`. A name mismatch → HOLD PayeeMismatch for agents and a revert for direct payments. If the mandate requires verified payees, unverified → HOLD PayeeUnverified. Only registry-approved attesters can verify, and only by passing the exact name hash. Renaming voids verification. |
| **Unusual amounts wait for you.** | `amount ≥ 3 × usual spend` → HOLD AmountAnomaly. A HOLD moves no funds (`testFuzz_HoldNeverMovesFunds`). Only the owner can `approveHold` (re-confirming the merchant's name) or `rejectHold`. |
| **The same invoice is never paid twice.** | Invoice status must be Open. `settledRef[keccak(payer, merchant, ref)]` blocks re-issuing the same invoice number. Fuzzed in `testFuzz_InvoiceNumberNeverPaidTwice`. |
| **Freeze and revoke at any time, even when the contract is paused.** | `setFrozen` and `revokeMandate` are owner-only (`_onlyLiveOwner`) and have no `whenNotPaused`. Revoke is permanent. Fuzzed in `testFuzz_FrozenOrRevokedNeverPays` and `testFuzz_OnlyOwnerControlsMandate`. |
| **Every decision is on-chain.** | `SafetyDecision(invoiceId, mandateId, decision, reason, risk, amount, usual)` is emitted for every `agentProcess` call. Also `HoldApproved`, `HoldRejected`, `InvoicePaid` (with a receipt hash anyone can check via `verifyReceipt`), `InvoiceRefunded`, `MandateCreated/Updated/Frozen/Revoked` and `MandateMerchantSet`. |

**Admin powers.** The contract owner (the deployer) can `pause`/`unpause` new payments, invoices, mandates and agent actions. The owner **cannot** move anyone's tokens, change a mandate or approve a hold. Refunds, cancels, rejects, freeze and revoke still work while paused. The registry owner chooses attesters, and on testnet that is a single operator.

### Recovery path (shown in Controls)

1. **Freeze** the mandate. This is instant and reversible, and the agent can't pay.
2. **Revoke** the mandate. This is permanent.
3. **Set your Kindly allowance to 0.** Nothing can be pulled through Kindly at all.
4. Your tokens never left your wallet, so there is nothing to withdraw. If a merchant was paid by mistake, they can `refund` it to your address.

## 2. Contract checklist

| Area | Status |
|---|---|
| Access control | Owner/agent checks on every state change (`_onlyLiveOwner`, `msg.sender == m.agent`, `onlyOwner` for pause, `onlyAttester` in the registry). Tests: `test_OnlyOwnerControls`, `test_OnlyAgentProcesses`, `test_OnlyAttesterVerifies` and the owner-control fuzz test. |
| Reentrancy | OpenZeppelin `ReentrancyGuard` on `payInvoice`, `refund`, `agentProcess` and `approveHold`. State (status, `settledRef`, `spent`) is written before the token transfer (checks-effects-interactions). SafeERC20 is used throughout. |
| Integers and limits | Solidity 0.8 checked math. `uint128` amounts. Cap ≤ budget, budget ≥ spent, memo ≤ 280 bytes, invoice lifetime ≤ 365 days, refunds ≤ amount paid. |
| Replay / duplicates | Status machine (Open → Paid/Cancelled/Refunded). `settledRef` per payer + merchant + invoice number. One active hold per invoice. |
| Pause / revoke | Global pause (admin), per-mandate freeze and revoke (owner), allowance-to-0 (wallet). |
| Events | See the custody table. Each decision includes its reason and risk score. |

## 3. Tooling results (2026-11-18)

- **Foundry:** `forge test` gives 32 passed, 0 failed, including 5 fuzz tests at 256 runs each. New in this pass: `testFuzz_InvoiceNumberNeverPaidTwice`, `testFuzz_OnlyOwnerControlsMandate`, `testFuzz_FrozenOrRevokedNeverPays` and `test_KnownLimitation_ApprovedHoldNotCountedInSpent`.
- **JS:** `node --test agent/*.test.mjs` gives 15 passed.
- **Slither 0.11** (`slither . --filter-paths "lib|test" --exclude-informational`) reports 8 results and no high or medium issues:
  - 2 × `divide-before-multiply` in `evaluate`. The risk score uses `ratio = amount / usual` and then `ratio * 5 + 50`. This is deliberate integer bucketing for a 0 to 95 display score and never affects which decision is made. Accepted.
  - 6 × `timestamp`, for invoice expiry, mandate expiry and cooldown. These are day-scale windows, and a few seconds of validator drift is irrelevant. Accepted.
- **gitleaks 8.21** over the full git history reports 8 "generic-api-key" hits. All of them are **public contract addresses and tx hashes** in `deployments/*.json` and `web/src/deployments.json`. They are false positives. No private key or token appears in history.
- **Key check:** the deployer key (`DEPLOYER_SECRET.txt`) and demo keys (`DEMO_KEYS_SECRET.json`) are gitignored (`*SECRET*`, `.env`, `.env.*`, `agent/agent.config.json`). A scripted comparison shows none of their keys appear in tracked files, the git history, the diff or the built `web/dist` bundle. `scripts/keys.mjs` contains only the **public Anvil development keys** used for local runs.
- **npm audit:** `npm audit --omit=dev` reports **0 vulnerabilities** (runtime deps: viem, qrcode). Vite was bumped from 6.2.7 to 6.4.6 to fix its advisories. The remaining reports are 4 "high" entries, all from one ReDoS advisory in `picomatch`, which ships with the dev-only Vite toolchain. It is not part of the shipped bundle and needs a breaking Vite major upgrade, so it is deferred.

## 4. Frontend hardening

- **Strict CSP** meta in `web/index.html`: `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and `connect-src` limited to the Aevum RPC and localhost. Fonts come only from Google Fonts. `referrer` is `strict-origin-when-cross-origin`.
- **No HTML injection:** the UI is built with a DOM helper (`h()`, `textContent`). The only `innerHTML` use writes static, hard-coded SVG icon paths. Invoice memos and merchant names are rendered as text and passed through `sanitizeText` (control characters and length).
- **Validation:** addresses (`isAddress`), amounts (positive, ≤ 6 decimals), invoice IDs (`0x` + 64 hex), https-only profile URLs, refunds ≤ remaining and mandate limits (cap ≤ budget, future expiry) are checked before any wallet prompt.
- **Confirm dialogs:** freezing, revoking, setting the allowance to 0, cancelling an invoice, paying (showing the amount, name and full address), paying an unverified merchant, renaming (which drops verification) and saving a memo that looks like personal data.
- **Testnet labels:** a network pill in the header, a banner on any other chain, "tUSD8" everywhere and the audit disclaimer in the trust modal.
- **Demo keys:** RUN DEMO generates throwaway testnet keys for the demo café and assistant in the browser (`localStorage`). They hold only test tokens. They are never sent anywhere and never shipped in the bundle.

## 5. Privacy: what's public on-chain

On-chain data is public forever, and Kindly does not make payments private. Public data: wallet addresses, amounts, invoice numbers, **memos (up to 280 characters)**, registered merchant names and profile URLs, mandate limits and every decision.

What the UI does about it:
- The memo field says it is public and suggests a neutral placeholder ("e.g. Order 1042").
- Creating an invoice asks for confirmation if the memo looks like an email, a phone number or a street address.
- Demo data is neutral ("Weekly coffee beans", "Kindly Demo Café").
- "What's visible on-chain" is linked from Pay, Send and Controls.

## 6. Known limitations

1. **Approved holds don't count toward `m.spent`.** `approveHold` settles without adding to the mandate's spent total. A hold only arises after the cap and budget checks have passed, and the owner approves it personally, so this is not an agent bypass. It does mean the budget measures *automatic* spending only. This is documented and pinned by `test_KnownLimitation_ApprovedHoldNotCountedInSpent`. The fix (counting approved holds) would need a redeploy, so it is deferred.
2. **`approveHold` doesn't re-check the mandate's freeze, revoke or expiry state.** Only the owner can call it, and it pays from the owner's own wallet, so this is a human decision rather than an agent permission.
3. **Single testnet attester.** Merchant verification trusts the registry's attester set, which on testnet is one operator. Independent KYB attesters are on the roadmap.
4. **Memos and names are plaintext on-chain.** Hashed memos with the text kept off-chain are on the roadmap.
5. **No external audit.** The same applies to the off-chain agent: it is a demo process that keeps its key in a gitignored local config.

**Redeploy decision:** no vulnerability that lets anyone move funds they shouldn't was found, so the contracts were **not redeployed**.

## 7. Implemented vs. roadmap

| Implemented (testnet) | Roadmap |
|---|---|
| Exact, bounded approvals. Cap, budget, allowlist, expiry and cooldown. Contract-decided PAY/HOLD/REJECT with events. Owner-only approve, reject, freeze and revoke. Duplicate and replay protection. Verifiable receipts. CSP and input validation. | Two-person approval for large holds. Independent attesters. Hashed memos. Session keys and a paymaster. Counting approved holds in the budget. External audit before any mainnet use. |
