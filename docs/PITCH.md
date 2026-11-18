# Kindly: pitch (60–90 seconds)

**Kindly — Payments, taken care of.**

**Hook.** We're about to let AI assistants pay our bills. The scary part isn't the AI. It's the invoices. A look-alike supplier, an invoice paid twice, a bill that's suddenly six times bigger: humans catch these by instinct. Agents don't.

**Problem.** Small businesses get invoices through chat, PDFs and QR codes. Stablecoin payments are instant and irreversible, so one bad invoice means the money is gone. Today's agent wallets offer two bad options: a hot wallet with no judgement, or a hard spending limit that a $149 fake invoice slips straight under.

**Solution.** Kindly puts an **Invoice Safety Gate** on-chain. The assistant can't pay anything directly. It submits each invoice to the gate, and the *contract* decides:
- **PAY** when the amount is usual, the payee is confirmed, and it fits the mandate.
- **HOLD** when the payee name doesn't match, the payee isn't verified, or the amount is 3× the usual or more. Nothing moves until *you* sign an approval.
- **REJECT** for a duplicate invoice number, an expired invoice, a merchant that isn't allowed, or anything over the cap or the budget.

Every decision is an on-chain event with a reason code and a risk score. The AI only explains the decision in plain English. It has no authority, so a prompt injection in an invoice memo changes nothing. The **Live Control Center** lets you change limits, freeze or revoke your assistant in one tap, and see the remaining budget live. Merchants get links and QR codes with on-chain **Confirmation of Payee**, verifiable receipts and refunds.

**Proof.** Live on QDay Aevum Testnet with tUSD8. Our recorded run shows $24.99 **paid**, $149 **held** then approved by the owner, the same invoice number **rejected** as a duplicate, $250 **rejected** over the cap, and the assistant blocked while frozen and after revoke. That's 25 transactions, all on the explorer, and every token was refunded at the end.

**Why Aevum.** Aevum is built for agentic payments, with a native stablecoin. Kindly's mandates map directly to session-key policies, and the gate can sit behind a stablecoin paymaster so small businesses never touch gas.

**Market.** SMEs, freelancers and B2B suppliers in markets like Indonesia, where chat commerce and QR payments are already normal. Revenue: a small fee per settled invoice, plus a paid tier for assistant automation and accounting exports.

**Ask.** Press **RUN DEMO**: three invoices, three decisions, about a minute.
