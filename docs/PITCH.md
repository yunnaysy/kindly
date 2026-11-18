# Kindly: pitch (60–90 seconds)

> **AI should be able to pay for you — but it should never have unlimited permission to spend your money.**

**Problem.** Payment agents are arriving, and today's options are bad: hand the agent a hot wallet, or give it a hard spending cap that a $149 fake invoice slips straight under. Stablecoin payments are instant and final, so one bad payment is gone.

**Solution.** Kindly gives the agent a **bounded allowance** and **your spending rules**, and puts a **Safety Gate** in the contract. The agent can't pay anyone directly. Every attempt goes through the gate, which returns **PAY**, **HOLD** or **REJECT** with a reason code. A HOLD waits for your signature. Funds stay in your wallet outside the allowance.

## Five things that stand out

1. **The contract decides, not a model.** The gate is a fixed set of deterministic rules in `Kindly.sol` (duplicate, not open, expired, merchant not allowed, over cap, over budget, payee mismatch, payee unverified, 3× the usual amount). The same invoice always gets the same verdict, and anyone can re-check it from the `SafetyDecision` event.
2. **Calm human-in-the-loop.** Unusual payments are held, not failed. The amber card says what was held, why, and that the agent can't proceed without you. "Why was this held?" shows the real values the rule used (this payment, usual payment, the ratio, the rule, the decision transaction).
3. **Bounded by construction.** The agent only ever pulls the exact invoice amount from an exact allowance you set. Max per payment, total budget, allowed merchants and expiry are enforced on-chain, and one tap freezes or revokes the agent.
4. **Confirmation of Payee.** Merchants register a name and an attester verifies it. A look-alike name or a swapped payment link is held or rejected by the contract.
5. **Proof you can click.** The guided demo replays a recorded Aevum run (PAY, HOLD → reject, HOLD → approve, cleanup), and with a wallet it runs the same two scenarios live with a fresh throwaway café. Every step links to the explorer.

## Proof

Live on QDay Aevum Testnet with tUSD8 (scaled 1:1000). The recorded guided-demo run and the earlier 25-transaction e2e run are listed in the [README](../README.md#proof-the-recorded-guided-demo-run-on-aevum), and every token was refunded at the end.

## Honest scope

- No AI model ships in this repo. The included agent is a script; a real AI agent would plug in at the same point, with the same limited authority. Explanations are templates.
- Testnet only, unaudited contracts.
- No video walkthrough yet; the [60-second demo](../README.md#60-second-demo) is written.

**Ask.** Open the app, choose **Explore demo without wallet**, and watch one payment pass and one wait for you. About a minute.
