# Demo script (Demo Day, 3–5 minutes, live)

**Before the call**
- Open the web app on Aevum Testnet (chain 44005) with MetaMask connected as the payer. The payer needs ~0.2 tUSD8 and ~0.02 tQDAY. RUN DEMO refunds the tUSD8.
- In a second tab, open the merchant view (any merchant key, registered as "Sunrise Coffee Co" and verified).
- Open the explorer in a third tab.
- Do one RUN DEMO rehearsal earlier that day. It funds the throwaway café and assistant keys with gas, so the live run needs fewer prompts.

| Time | Screen | What to do and say |
|---|---|---|
| 0:00 | Welcome | "AI should be able to pay for you, but it should never have unlimited permission to spend your money. In Kindly, fixed contract rules decide, not a model." Point at the mode badge (`LIVE TESTNET`). Short version: the [60-second demo](../README.md#60-second-demo) in the README, or **Settings → Guided demo**. |
| 0:20 | Run demo | Press **RUN DEMO** (or use **Guided demo → Live on testnet** for the two-scenario version). Confirm the budget approval and the mandate (cap $200, budget $500, usual $25, café only). |
| 0:50 | Run demo | **$24.99 → PAY** (risk 19): "usual amount, confirmed payee, paid automatically." Click the decision tx and show the `SafetyDecision` event. |
| 1:15 | Run demo | **$149 → HOLD** (AmountAnomaly, 6.0× usual): "Under the cap, so a plain spending limit would have paid it. Kindly parks it and asks me." Click **Approve $149 payment** and sign it. |
| 1:45 | Run demo | **$24.99 again, same invoice number → REJECT** (Duplicate, risk 95): "No double payments. Not through the assistant, not by approval, not even paying directly." The refunds run and the tokens come back. |
| 2:15 | Control Center | Show the mandate card: remaining budget, editable limits, recent decisions feed. Lower the cap and **Save**, then press **Freeze**. "One tap and the assistant can't pay anything. The contract reverts with `MandateIsFrozen`." Unfreeze, then **Revoke forever**. |
| 3:00 | Merchant → Pay | Create a 0.0125 tUSD8 invoice. Show the link and QR. On the pay page, type "Sunrise Cofee Co" and the box turns red. "Confirmation of Payee: the contract re-checks the name hash." Restore the name and pay. |
| 3:40 | Receipts | Verify the receipt on-chain. Show the "Last recorded run on Aevum" card, which includes the $250 over-cap REJECT with a prompt injection in its memo. |
| 4:10 | Close | Roadmap: two-person holds, recurring invoices, a KYB attester network, session keys plus a paymaster on Aevum. "Kindly. Payments, taken care of." |

**Fallbacks**
- If the RPC is slow, use the "Last recorded run on Aevum" card on the demo page. Every decision links to a real tx. The full table is in the README and `deployments/e2e-44005.json`.
- If the wallet extension fails, run `npm run e2e` (or `CHAIN_ID=31337 REDEPLOY=1 npm run e2e` against a local anvil). It walks through the whole story and asserts every decision.
