# Kindly

**Payments, taken care of.**

Kindly lets small businesses send stablecoin invoices as a link or QR code, and lets an AI assistant pay your bills, but only through an **on-chain Invoice Safety Gate**. For every invoice, the gate decides **PAY**, **HOLD** or **REJECT** and records the reason and a risk score as an event anyone can verify. The AI never decides. It only *explains* the contract's decision in plain English.

Built for **Aevum Builder Challenge #1** on **QDay Aevum Testnet** (chain `44005`), using the official test stablecoin **tUSD8**.

**Live demo:** [https://kindly-lemon.vercel.app](https://kindly-lemon.vercel.app)

![Run demo: three invoices, three decisions](docs/screenshots/02-demo-complete.png)

Design system: [docs/DESIGN_NOTES.md](docs/DESIGN_NOTES.md) · Security, custody & privacy: [docs/SECURITY.md](docs/SECURITY.md)

## The problem

AI agents are starting to pay bills. The two most common ways small businesses lose money on invoices are exactly the ones an unsupervised agent would make worse:

- **Invoice fraud and payee swaps.** Someone sends a look-alike invoice ("Sunrise Cofee Co") or swaps the address in a payment link.
- **Duplicates and anomalies.** The same invoice gets paid twice, or a bill is suddenly 6× the usual.

Hard spending limits alone don't fix this. A $149 fake invoice sits well under a $200 cap. A useful agent wallet needs judgement that is **deterministic, auditable and enforced by the contract**, plus a human in the loop for anything odd.

## What Kindly does

| | |
|---|---|
| 🛡️ **Invoice Safety Gate** | `agentProcess()` evaluates each invoice on-chain and emits `SafetyDecision(decision, reason, risk, amount, usualAmount)`. PAY settles immediately. HOLD parks the invoice until **you** sign `approveHold`. REJECT moves nothing. |
| 🎛️ **Live Mandate Control Center** | Change the cap, budget, usual amount, expiry and cooldown, add or remove allowed merchants, **freeze/unfreeze** or **revoke** your assistant in one tap, and watch the remaining budget update live. Includes a queue of held invoices and a feed of recent gate decisions. |
| ▶️ **One-click RUN DEMO** | A demo café sends three invoices: **$24.99 → PAY**, **$149 → HOLD** (you approve it), **$24.99 with the same invoice number → REJECT**. Every step links to its transaction. Funds are refunded at the end, so the demo is repeatable. |
| 🔗 **Links, QR and Confirmation of Payee** | Merchants register a name, and an attester verifies it (on-chain *Confirmation of Payee*). Payers see a green ✓ only when the name they expect matches. The contract re-checks the name hash and the maximum amount, so a swapped link or a renamed merchant can't take the payment. |
| 🧾 **Verifiable receipts and refunds** | Every payment gets a receipt hash you can verify on the Receipts page. Merchants can refund fully or partially. |

### Safety Gate rules

The gate checks rules in this order and returns the first match. The thresholds are constants in `Kindly.sol`, so they are the same for everyone and easy to audit.

| Check | Decision | Reason code | Risk |
|---|---|---|---|
| Invoice number already paid to this merchant | REJECT | `Duplicate` | 95 |
| Invoice is not open (cancelled, refunded) | REJECT | `NotOpen` | 100 |
| Invoice expired | REJECT | `Expired` | 90 |
| Merchant not on the mandate's allowlist | REJECT | `MerchantNotAllowed` | 90 |
| Invoice addressed to a different payer | REJECT | `PayerNotAllowed` | 90 |
| Amount above the per-payment cap | REJECT | `OverCap` | 90 |
| Amount above the remaining budget | REJECT | `OverBudget` | 80 |
| Payee name doesn't match what the assistant expects (Confirmation of Payee) | HOLD | `PayeeMismatch` | 85 |
| Payee not verified, and the mandate requires verified payees | HOLD | `PayeeUnverified` | 60 |
| Amount ≥ **3×** the usual amount for this merchant | HOLD | `AmountAnomaly` | 50 + 5×ratio (max 95) |
| None of the above | PAY | `Ok` | ≤ 45, scaled by amount ÷ usual |

The **usual amount** is the average this payer has paid this merchant. Before there is any history, it falls back to the `typicalAmount` baseline you set on the mandate.

Duplicates are tracked per *(payer, merchant, invoice number)*. A merchant can re-issue the same invoice number, which is how the duplicate demo works, but nobody can pay it twice. That holds through the assistant, through a held-then-approved payment, and through a direct payment.

**Kindly also rejects transactions, with no state change, when:**
- the caller isn't the mandate's assistant,
- the mandate is frozen, revoked or expired,
- the mandate is in cooldown,
- the invoice is already on hold, or
- the contract is paused.

### Who decides what

- **The contract decides.** `evaluate()` is a free `view` call, so the UI and the agent can preview a decision. `agentProcess()` makes the binding decision and emits it.
- **A human approves holds.** Only the mandate owner can call `approveHold` or `rejectHold`. Approval re-checks duplicates and the payee name. A held payment that the owner approves is the owner's own payment, so it doesn't use up the assistant's budget.
- **The AI only explains.** `explainDecision()` in `shared/kindly.js` turns `(decision, reason, risk, amount, usual)` into one friendly sentence. It has no keys and no say. Invoice memos are treated as untrusted text: they're sanitized, shown, and never interpreted. In the e2e run, INV-1003 carries an injection attempt in its memo and is still rejected as `OverCap`.

## Deployed on Aevum Testnet

| Contract | Address | Deploy tx |
|---|---|---|
| **Kindly** | [`0x944e66ba2642a2e83453e62bb48906f22eecb1b3`](https://explorer-test.qday.info/address/0x944e66ba2642a2e83453e62bb48906f22eecb1b3) | [`0x760d8c89…`](https://explorer-test.qday.info/tx/0x760d8c89a19afa97b4062a23bc928a02d087f1e29154ba0db6749c2d8ba5efb6) |
| **PayeeRegistry** | [`0xff6ce066fa19b68bd3150b8a2f0eff477fad2679`](https://explorer-test.qday.info/address/0xff6ce066fa19b68bd3150b8a2f0eff477fad2679) | [`0x0c88ed18…`](https://explorer-test.qday.info/tx/0x0c88ed18075ae3c194d94a4dcd40291d49be77f5933211e6dea38abb9c7a2107) |
| tUSD8 (official test stablecoin, 6 decimals) | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) | n/a |

Deployer/operator `0xD7d365901a2267B860e54E1DfBD3deAd39D39858`, deploy block 3499952. Earlier deployments under previous working names are listed, marked superseded, in [deployments/HISTORY.md](deployments/HISTORY.md).

### Scale note

The deployer had a one-time faucet claim (1 tQDAY, 5 tUSD8), so on-chain amounts are scaled **1:1000**: "$24.99" is `0.02499 tUSD8`. The e2e run and RUN DEMO refund every payment at the end, so token balances go back to their starting values. After this run, the payer, merchant and agent hold exactly what they held before (2, 3 and 0 tUSD8). Only gas was spent.

### Safety Gate decisions (real `SafetyDecision` events, 2026-11-18 14:57 UTC)

| Invoice | Decision | Reason | Risk | Decision tx |
|---|---|---|---|---|
| INV-1001 · $24.99 · usual amount | **PAY** | `Ok` | 19 | [`0x98784b2c…`](https://explorer-test.qday.info/tx/0x98784b2c6080f9aa7fbaa74c845c5baef6a8ff75997484fea355afb8ce824253) |
| INV-1002 · $149 · 6× usual | **HOLD** | `AmountAnomaly` | 75 | [`0xd37ef58d…`](https://explorer-test.qday.info/tx/0xd37ef58d52344b5d63b750f9197ae6095b28862f52581dbb8ac209a2d9495e6d) |
| INV-1001 re-sent · $24.99 | **REJECT** | `Duplicate` | 95 | [`0x94fad52a…`](https://explorer-test.qday.info/tx/0x94fad52aba092367e889dd6218a8ba81339db262a07a1e6f792c45d369c98f20) |
| INV-1003 · $250 · memo contains a prompt-injection attempt | **REJECT** | `OverCap` | 90 | [`0x1fd9c849…`](https://explorer-test.qday.info/tx/0x1fd9c849a8ffada28afe16a5e47e61520e477700fac0f52e0363d778950985b1) |

### Full end-to-end run (`npm run e2e`)

25 transactions, all with status `success`. Each was checked with `cast receipt <hash> status`. The 5 "blocked" rows are attacks the contract refused: the call was simulated, it reverted with the named error, and no transaction was sent. The full machine-readable log is in [deployments/e2e-44005.json](deployments/e2e-44005.json).

| # | Step | Result |
|---|---|---|
| 1 | merchant registers payee name | [`0x7ea48dea…`](https://explorer-test.qday.info/tx/0x7ea48deaf1b9c1e3d65e7e7ff84a3e6f20fa8b8d4e7599ed78a59901705ddef4) ✅ |
| 2 | attester verifies merchant name hash | [`0x8de4f14b…`](https://explorer-test.qday.info/tx/0x8de4f14be0fb1de39ed7a95b49996867e0183a345d5ce892730e2143fa6f8df2) ✅ |
| 3 | payer approves 0.3 tUSD8 to Kindly (exact, not unlimited) | [`0xe45217ec…`](https://explorer-test.qday.info/tx/0xe45217ecab5291252c72137056108e3828dc579167a2d1af586617d141098ede) ✅ |
| 4 | payer creates mandate: cap $200, budget $500, usual $25, allowlist [Sunrise], verified-only | [`0x1fdd12fa…`](https://explorer-test.qday.info/tx/0x1fdd12fa4052dfc3fb7dc9dd868a1668c665966917ea5803c7eca1133f3ec2db) ✅ |
| 5 | merchant issues INV-1001 ($24.99 → 0.02499 tUSD8) | [`0xc544bc34…`](https://explorer-test.qday.info/tx/0xc544bc348b318c676c57fd7093c7b376840f01262d8e1803ada0167e1f1219b6) ✅ |
| 6 | agent → Safety Gate: INV-1001 $24.99 ⇒ PAY (Ok, risk 19) | [`0x98784b2c…`](https://explorer-test.qday.info/tx/0x98784b2c6080f9aa7fbaa74c845c5baef6a8ff75997484fea355afb8ce824253) ✅ |
| 7 | merchant issues INV-1002 ($149 → 0.149 tUSD8) | [`0x1d53e69b…`](https://explorer-test.qday.info/tx/0x1d53e69ba7444066330d57bacee12551d5e03725b81d64a0f343945152c2084a) ✅ |
| 8 | agent → Safety Gate: INV-1002 $149 ⇒ HOLD (AmountAnomaly, risk 75) | [`0xd37ef58d…`](https://explorer-test.qday.info/tx/0xd37ef58d52344b5d63b750f9197ae6095b28862f52581dbb8ac209a2d9495e6d) ✅ |
| 9 | payer approves held INV-1002 (explicit approval tx) | [`0x911fe816…`](https://explorer-test.qday.info/tx/0x911fe816965c879ebc94f279e6be8c647dfd32a89243d2e0ad0aaaa0600e5f2f) ✅ |
| 10 | merchant issues INV-1001 (re-sent) ($24.99 → 0.02499 tUSD8) | [`0x077a7d09…`](https://explorer-test.qday.info/tx/0x077a7d09105af1b68b61773201f3b5cc8d4d89a3257a33a361c670bfd8d8267a) ✅ |
| 11 | agent → Safety Gate: INV-1001 re-sent $24.99 ⇒ REJECT (Duplicate, risk 95) | [`0x94fad52a…`](https://explorer-test.qday.info/tx/0x94fad52aba092367e889dd6218a8ba81339db262a07a1e6f792c45d369c98f20) ✅ |
| 12 | merchant issues INV-1003 ($250 → 0.25 tUSD8) | [`0x10e641e2…`](https://explorer-test.qday.info/tx/0x10e641e2cf831d2c62a5f624656807095237ec9e8c3157f09e9748d850e68374) ✅ |
| 13 | agent → Safety Gate: INV-1003 $250 ⇒ REJECT (OverCap, risk 90) | [`0x1fd9c849…`](https://explorer-test.qday.info/tx/0x1fd9c849a8ffada28afe16a5e47e61520e477700fac0f52e0363d778950985b1) ✅ |
| 14 | control center: lower per-payment cap to $100 | [`0xf5aa3f56…`](https://explorer-test.qday.info/tx/0xf5aa3f567c8159f2f0eeace5e8bf422d9d2b42f3701b41c21500218612b201a6) ✅ |
| 15 | control center: freeze mandate | [`0xf57a18c5…`](https://explorer-test.qday.info/tx/0xf57a18c5e3b95c22b0e32573d6bf3d96716a77a9be843817c8e02174eb218200) ✅ |
| 16 | agent while frozen | blocked: `MandateIsFrozen` ✅ (expected, no tx sent) |
| 17 | control center: unfreeze mandate | [`0x3798eb0c…`](https://explorer-test.qday.info/tx/0x3798eb0c5aa37a57d77392030e6f0650b4a8880001e616fb691ac99640570fbb) ✅ |
| 18 | control center: revoke mandate | [`0x7e415c40…`](https://explorer-test.qday.info/tx/0x7e415c40a993f71413ff56ea3b4eeb05d19cc538ebcc0ef5f48ef2ee58aa68d0) ✅ |
| 19 | agent after revoke | blocked: `MandateInactive` ✅ (expected, no tx sent) |
| 20 | merchant issues INV-2001 ($50 → 0.05 tUSD8) | [`0xd8493e9a…`](https://explorer-test.qday.info/tx/0xd8493e9a402975c465f794f067353a31f42c8dd77f3bf3992d0cfb27ba8c3d79) ✅ |
| 21 | payer pays look-alike name 'Sunrise Cofee Co' | blocked: `PayeeMismatch` ✅ (expected, no tx sent) |
| 22 | payer pays with tampered max amount | blocked: `AmountAboveMax` ✅ (expected, no tx sent) |
| 23 | payer pays INV-2001 directly with CoP name pin | [`0x59e8da67…`](https://explorer-test.qday.info/tx/0x59e8da67b67f98ca25fb88ca0b8d1a8940a04c745f2047321e3648305ec86250) ✅ |
| 24 | double payment of INV-2001 | blocked: `InvoiceNotOpen` ✅ (expected, no tx sent) |
| 25 | merchant approves 0.22399 tUSD8 for refunds | [`0x0eab60b5…`](https://explorer-test.qday.info/tx/0x0eab60b5bfdaf409234564ae86e10ac2470fcb0cebebc231a13d634e0c3b0aeb) ✅ |
| 26 | merchant refunds INV-1001 in full | [`0x07b1466f…`](https://explorer-test.qday.info/tx/0x07b1466f0e3b686980b2357f68f2722ff5e5c0413e6938bbb8260816c43bd7de) ✅ |
| 27 | merchant refunds INV-1002 in full | [`0x538e436a…`](https://explorer-test.qday.info/tx/0x538e436a00813b1bbc9a0ef7a1010db9af9961d0389657164cd845a1f9c9e212) ✅ |
| 28 | merchant refunds INV-2001 in full | [`0xedfa4a4e…`](https://explorer-test.qday.info/tx/0xedfa4a4e67cb9c42b96064d225a1eb7d8bd64da5538891ee24544a3136f47a15) ✅ |
| 29 | merchant cancels re-sent INV-1001 | [`0x5fa4dc3c…`](https://explorer-test.qday.info/tx/0x5fa4dc3c9f6a55e30dd60b45f91d3425e9f84dad3def7a04471a8593318b47e5) ✅ |
| 30 | merchant cancels INV-1003 | [`0x2067a3dc…`](https://explorer-test.qday.info/tx/0x2067a3dc2ffbf0190875fc729a4cf6ad5958f4b22ad4dceae44ebab5548bd18c) ✅ |

Final mandate state: spent 0.02499 of 0.5 tUSD8, cap lowered to 0.1, revoked. Receipt for INV-1002 verified on-chain: `true`.

## Screenshots

| | |
|---|---|
| ![Home](docs/screenshots/01-home.png) Home | ![Hold waiting](docs/screenshots/03-demo-hold-waiting.png) RUN DEMO: the $149 invoice waits for you |
| ![Control Center](docs/screenshots/04-control-center.png) Dashboard: agent status, wallet balance, funds & recovery path | ![Frozen](docs/screenshots/05-control-frozen.png) One tap to freeze |
| ![Merchant](docs/screenshots/06-merchant-invoice-qr.png) Merchant: invoice link + QR | ![Pay](docs/screenshots/07-pay-cop-verified.png) Pay page: Confirmation of Payee |
| ![Paid](docs/screenshots/08-paid-receipt.png) Paid, with receipt | ![Receipts](docs/screenshots/09-receipts.png) Receipts and settlements |
| ![Funds](docs/screenshots/12-funds-modal.png) How your funds are protected | ![Mobile](docs/screenshots/10-mobile-home.png) Mobile |
| ![Setup: allowance](docs/screenshots/16-start-allowance.png) Get started, step 1: a bounded spending allowance, never a deposit | ![Setup: activated](docs/screenshots/18-start-activated.png) Step 3: the mandate is active |
| ![Needs you](docs/screenshots/13-dashboard-needs-you.png) Dashboard: one payment needs you | ![HOLD review](docs/screenshots/14-hold-review.png) HOLD review: the reason comes first |

(Screenshots come from a local Anvil run of the same build.)

## Architecture

```
 Merchant (browser)            Payer (browser)                 AI assistant (agent.mjs or RUN DEMO)
   │ register name               │ pay link / QR                   │ evaluate() preview → explainDecision()
   │ createInvoice / refund      │ CoP check → payInvoice()        │ agentProcess(mandate, invoice, expectedName)
   ▼                             ▼                                 ▼
 ┌───────────────┐  confirm()  ┌──────────────────────────────────────────────────────────┐
 │ PayeeRegistry │◄────────────│ Kindly                                                   │
 │ name + attester│            │  invoices · receipts · refunds · settledRef (duplicates)  │
 └───────────────┘             │  mandates: cap, budget, usual, allowlist, expiry, cooldown│
                               │  Safety Gate → SafetyDecision event → PAY / HOLD / REJECT │
                               │  holds → approveHold / rejectHold (owner only)            │
                               └───────────────────────────┬──────────────────────────────┘
                                                           │ transferFrom (exact amount only)
                                                           ▼
                                                    tUSD8 (ERC-20, 6 dp)
```

- **No custody.** Funds stay in the payer's wallet. Kindly pulls the exact invoice amount, and only on PAY or on your approval. Payers approve an exact allowance, never an unlimited one.
- **No backend, no API keys.** The web app is static. Everything is read from and written to the chain.
- **Live UI.** The Control Center re-reads mandates, holds and decision events every 12 s.

## Repository layout

```
contracts/   Foundry: Kindly.sol (invoices, Safety Gate, mandates, holds, receipts), PayeeRegistry.sol, MockUSD8.sol (local only), 28 tests incl. 2 fuzz
shared/      chain config (Aevum 44005, tUSD8), ABIs, helpers: decision/reason codes, explainDecision, sanitizer, error messages
agent/       AI assistant runner (agent.mjs): preview → explain → agentProcess, idempotent, retries, + 15 unit tests
scripts/     deploy.mjs, e2e.mjs (full on-chain flow, records every tx hash), export-abi.mjs
web/         static dApp (Vite, vanilla JS + viem + qrcode): Run demo, Control Center, Merchant, Pay, Receipts
deployments/ deployed addresses, e2e reports per chain, deployment history
docs/        pitch, demo script, screenshots
Dockerfile   packaged demo (nginx serving the built web app)
```

## Quick start

Requirements: Node ≥ 18, [Foundry](https://getfoundry.sh).

```bash
npm install
npm run deps:contracts      # forge-std + OpenZeppelin v5.1.0 into contracts/lib
npm run build:contracts     # forge build + export ABIs to shared/abi
npm test                    # 28 Solidity tests (incl. fuzz) + 15 agent/helper tests
```

### Run everything locally (no faucet needed)

```bash
anvil &                                     # local chain 31337
CHAIN_ID=31337 REDEPLOY=1 npm run e2e       # deploys MockUSD8 + contracts, runs the full flow
npm run dev                                 # open http://localhost:5173/?chain=31337#/demo and press RUN DEMO
```

### Use it on Aevum Testnet

1. Add the network: RPC `https://rpc-test.qday.info`, chain id `44005`, symbol `tQDAY`, explorer `https://explorer-test.qday.info`.
2. Get tQDAY (gas) and tUSD8 at <https://faucet.qday.info/en>. RUN DEMO needs about 0.01 tQDAY and 0.174 tUSD8, and returns the tUSD8 at the end.
3. Open the web app, connect your wallet and press **RUN DEMO**. You'll confirm the budget approval, the mandate, the HOLD approval and two tiny gas top-ups for the throwaway café and assistant keys, which are kept in your browser.

To deploy your own copy, put a funded key in `DEPLOYER_SECRET.txt` (`PRIVATE_KEY=0x…`, git-ignored) and run:

```bash
npm run deploy      # PayeeRegistry + Kindly bound to the official tUSD8 → deployments/deployments.json
npm run e2e         # the full flow above; refunds everything at the end
npm run build:web   # static site in web/dist (Vercel/Netlify/IPFS), or: docker build -t kindly . && docker run -p 8080:80 kindly
```

### Run the assistant continuously

```bash
cp agent/agent.config.example.json agent/agent.config.json   # fill kindly, registry, mandateId, vendorBook
AGENT_KEY=0x… npm run agent
```

The assistant only knows the payee names in its `vendorBook`. If an invoice comes from an unknown vendor, it sends an empty expected name. That yields HOLD (`PayeeMismatch`), so a person has to look.

## Contract API

### `Kindly`

| Function | Who | What |
|---|---|---|
| `createInvoice(ref, payer, amount, expiresAt, memo) → id` | merchant | Open an invoice. `payer = 0x0` means anyone can pay. |
| `cancelInvoice(id)` | merchant | Cancel an open invoice. |
| `payInvoice(id, expectedNameHash, maxAmount) → receipt` | payer | Direct payment with a CoP name pin and a maximum amount. Duplicates are blocked. |
| `refund(id, amount)` | merchant | Full or partial refund. |
| `evaluate(mandateId, id, nameHash) → (decision, reason, risk, usual)` | anyone (view) | Preview the Safety Gate. |
| `agentProcess(mandateId, id, nameHash)` | assistant | Binding gate decision. PAY settles, HOLD parks, REJECT does nothing. Always emits `SafetyDecision`. |
| `approveHold(id, confirmedNameHash)` / `rejectHold(id)` | mandate owner | Human decision on a held invoice. |
| `createMandate(params)` | payer | Set up the assistant, cap, budget, usual amount, expiry, cooldown and allowlist. |
| `updateMandate(…)`, `setMandateMerchant`, `setFrozen`, `revokeMandate` | mandate owner | Live controls. |
| `mandateRemaining(id)`, `usualAmount(payer, merchant, typical)`, `getHold`, `verifyReceipt`, `settledRef` | view | Data for the Control Center and the Receipts page. |

Events: `InvoiceCreated`, `InvoicePaid`, `InvoiceRefunded`, `InvoiceCancelled`, `SafetyDecision`, `HoldApproved`, `HoldRejected`, `MandateCreated`, `MandateUpdated`, `MandateMerchantSet`, `MandateFrozen`, `MandateRevoked`.

### `PayeeRegistry`

`register(name, url)`, `deactivate()`, `verify(payee, expectedNameHash)` (attester only, requires an exact name-hash match), `revokeVerification`, `setAttester`, and `confirm(payee, nameHash) → Unregistered | NoMatch | MatchUnverified | MatchVerified`. Renaming a payee voids its verification.

## QDay / Aevum integration

- Uses Aevum Testnet (chain 44005, RPC `rpc-test.qday.info`) and the official tUSD8 test stablecoin (`0x4565…3483`, 6 decimals).
- Transactions are plain EVM, and every decision is a public event, so the explorer shows exactly what the assistant was and wasn't allowed to do.
- The web app adds and switches to the Aevum network for you (`wallet_addEthereumChain`) and links every tx to `explorer-test.qday.info`.

## Testing

- `forge test`: 28 tests. They cover the demo trio, each gate rule, the decision event, hold approve/reject, no double holds, duplicate blocking on every path, the Control Center (update, allowlist, freeze, revoke, owner-only), assistant-only processing, expiry, cooldown, pause, Confirmation of Payee and renames. Two fuzz tests check that *the assistant can never exceed the budget* and that *a HOLD never moves funds*.
- `node --test agent/agent.test.mjs`: 15 tests for the assistant runner, explanations, sanitizer, retries and payment links.
- `scripts/e2e.mjs` asserts every gate decision against the expected value and fails loudly on any mismatch.

## Assumptions and limitations

- Testnet only. The contracts are not audited.
- The attester is a single address, the deployer. In production this would be a KYB provider or a multisig.
- The thresholds are fixed constants: anomaly at 3× the usual amount, and an average for the usual amount. They're simple on purpose, so anyone can predict a decision.
- The "AI" layer is a deterministic explanation template. An LLM could replace it without changing the security model, because it has no authority.
- Amounts are scaled 1:1000 on-chain because of the one-time faucet claim.

## Roadmap

- Per-merchant usual-amount windows (median of the last N payments) and per-category caps.
- Multi-approver holds (two-person rule) and notifications for new holds.
- Recurring invoices and subscriptions with the same gate.
- A KYB attester network for payee verification.
- An LLM explanation layer and an email/PDF invoice importer feeding `agentProcess`.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
