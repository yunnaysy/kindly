// Records the two Judge-mode scenarios on Aevum Testnet (or anvil) with real transactions, so the guided
// replay in the web app can link every step to the explorer:
//   1. a routine $24.99 invoice → PAY (automatic)
//   2. an unusual $149 invoice → HOLD → the owner APPROVES (receipt) — and a second $149 → HOLD → REJECT
// Amounts are scaled 1:1000 like e2e.mjs, payments are refunded and the mandate is revoked at the end.
// Output: deployments/judge-<chain>.json and web/src/judge-runs.json. Keys are never printed.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { erc20Abi, getAddress, parseEther, formatEther, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chmodSync } from "node:fs";
import { setup, artifact, readDeployments, root } from "./common.mjs";
import { explorerTx } from "../shared/config.js";
import { nameHash, refFromNumber, toUnits, fromUnits, DECISION, REASON } from "../shared/kindly.js";

const NAME = process.env.MERCHANT_NAME || "Sunrise Coffee Co";
const K = artifact("Kindly").abi;
const R = artifact("PayeeRegistry").abi;
const M = artifact("MockUSD8").abi;
const { chainId, pub, accounts, wallet } = await setup();
const { operator, agent } = accounts;
// A fresh café key per recorded run: the "usual amount" is the payer's average with that café, so an old café's
// history would make $149 look normal. Kept in a gitignored *SECRET* file (never printed, never deployed).
const KEYFILE = `${root}JUDGE_KEYS_SECRET.json`;
const keys = existsSync(KEYFILE) ? JSON.parse(readFileSync(KEYFILE, "utf8")) : [];
const pk = generatePrivateKey(); keys.push({ chainId: Number(process.env.CHAIN_ID || 44005), role: "judge café", key: pk, createdAt: new Date().toISOString() });
writeFileSync(KEYFILE, JSON.stringify(keys, null, 2) + "\n"); chmodSync(KEYFILE, 0o600);
const merchant = privateKeyToAccount(pk);
const d = readDeployments()[chainId];
if (!d?.kindly) throw new Error(`No Kindly deployment for chain ${chainId}`);
const $ = (usd) => toUnits((usd / 1000).toFixed(6));
const run = Date.now().toString(36);
const steps = [];
const allowance = () => pub.readContract({ address: d.token, abi: erc20Abi, functionName: "allowance", args: [operator.address, d.kindly] });

async function tx(key, label, account, address, abi, functionName, args) {
  const { request, result } = await pub.simulateContract({ account, address, abi, functionName, args });
  const hash = await wallet(account).writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  const s = { key, step: label, from: account.address, hash, block: Number(r.blockNumber), explorer: explorerTx(chainId, hash) };
  steps.push(s);
  console.log(`✔ ${label}\n   ${hash}`);
  return { result, receipt: r, step: s };
}
async function gas(to, amount) {
  const bal = await pub.getBalance({ address: to });
  if (bal >= amount / 2n) return;
  const hash = await wallet(operator).sendTransaction({ to, value: amount - bal });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`✔ gas ${formatEther(amount - bal)} → ${to}`);
}
async function gate(key, label, mandateId, invoiceId) {
  const { receipt, step } = await tx(key, `agent → Safety Gate: ${label}`, agent, d.kindly, K, "agentProcess", [mandateId, invoiceId, nameHash(NAME)]);
  const ev = parseEventLogs({ abi: K, eventName: "SafetyDecision", logs: receipt.logs })[0].args;
  return { ...step, decision: DECISION[ev.decision], reason: REASON[ev.reason], risk: Number(ev.risk), amount: fromUnits(ev.amount), usual: fromUnits(ev.usualAmount), invoiceId };
}
const invoice = (key, num, usd, memo) =>
  tx(key, `café issues ${num} ($${usd} → ${fromUnits($(usd))} tUSD8)`, merchant, d.kindly, K, "createInvoice", [refFromNumber(`${num}-${run}`), operator.address, $(usd), BigInt(Math.floor(Date.now() / 1000) + 86400), memo]).then((x) => x.result);

if (chainId === 31337) await tx("mint", "mint mock tUSD8 to the payer", operator, d.token, M, "mint", [operator.address, toUnits(10)]);
await gas(merchant.address, chainId === 31337 ? parseEther("1") : parseEther("0.006"));
await gas(agent.address, chainId === 31337 ? parseEther("1") : parseEther("0.006"));
await tx("register", "café registers its name", merchant, d.registry, R, "register", [NAME, ""]);
await tx("verify", "attester verifies the café's name", operator, d.registry, R, "verify", [merchant.address, nameHash(NAME)]);

const need = $(24.99) + $(149) + $(149);
const before = await allowance();
await tx("allow", `payer allows exactly ${fromUnits(need)} tUSD8 (bounded allowance)`, operator, d.token, erc20Abi, "approve", [d.kindly, need]);
const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400);
const { result: mandateId } = await tx("mandate", "payer sets the agent's spending rules: max $200 per payment, $500 budget, usual $25, Sunrise only, verified only", operator, d.kindly, K, "createMandate", [{
  agent: agent.address, perPaymentCap: $(200), totalBudget: $(500), typicalAmount: $(25), validUntil, cooldown: 0, anyMerchant: false, requireVerifiedPayee: true, merchants: [merchant.address],
}]);

// Scenario 1: routine payment
const a = await invoice("inv1", "INV-J1", 24.99, "Weekly coffee beans");
const s1 = await gate("pay", "INV-J1 $24.99", mandateId, a);
const allowAfterPay = await allowance();
if (s1.decision !== "PAY") throw new Error(`expected PAY, got ${s1.decision}`);
// Scenario 2, reject branch first (a rejection doesn't change the payment history, so the next $149 is still unusual)
const c = await invoice("inv3", "INV-J3", 149, "Espresso machine service");
const s3 = await gate("hold2", "INV-J3 $149", mandateId, c);
if (s3.decision !== "HOLD") throw new Error(`expected HOLD, got ${s3.decision}`);
const rj = await tx("reject", "owner rejects the held INV-J3 (nothing is paid)", operator, d.kindly, K, "rejectHold", [c]);
const allowAfterReject = await allowance();
// Scenario 2, approve branch
const b = await invoice("inv2", "INV-J2", 149, "Espresso machine service");
const s2 = await gate("hold", "INV-J2 $149", mandateId, b);
if (s2.decision !== "HOLD") throw new Error(`expected HOLD, got ${s2.decision}`);
const ap = await tx("approve", "owner approves the held INV-J2 (explicit approval tx)", operator, d.kindly, K, "approveHold", [b, nameHash(NAME)]);
const allowAfterApprove = await allowance();
const invB = await pub.readContract({ address: d.kindly, abi: K, functionName: "getInvoice", args: [b] });
const m = await pub.readContract({ address: d.kindly, abi: K, functionName: "getMandate", args: [mandateId] });

// Clean-up: refund the two payments, cancel the rejected invoice, revoke the mandate, allowance back to 0.
const paid = $(24.99) + $(149);
await tx("refundApprove", `café approves ${fromUnits(paid)} tUSD8 for refunds`, merchant, d.token, erc20Abi, "approve", [d.kindly, paid]);
await tx("refund1", "café refunds INV-J1", merchant, d.kindly, K, "refund", [a, $(24.99)]);
await tx("refund2", "café refunds INV-J2", merchant, d.kindly, K, "refund", [b, $(149)]);
await tx("cancel3", "café cancels the rejected INV-J3", merchant, d.kindly, K, "cancelInvoice", [c]);
await tx("revoke", "payer revokes the judge mandate", operator, d.kindly, K, "revokeMandate", [mandateId]);
await tx("allow0", "payer sets the allowance back to 0", operator, d.token, erc20Abi, "approve", [d.kindly, 0n]);

const out = {
  chainId, kindly: d.kindly, registry: d.registry, token: d.token, merchantName: NAME, merchant: getAddress(merchant.address), payer: operator.address, agent: agent.address,
  scale: "1 USD in the story = 0.001 tUSD8 on testnet",
  mandate: { id: String(mandateId), perPaymentCap: fromUnits($(200)), totalBudget: fromUnits($(500)), usual: fromUnits($(25)), spentAfterApprove: fromUnits(m.spent) },
  allowance: { before: fromUnits(before), set: fromUnits(need), afterPay: fromUnits(allowAfterPay), afterApprove: fromUnits(allowAfterApprove), afterReject: fromUnits(allowAfterReject) },
  scenarios: {
    pay: s1,
    hold: { ...s2, approve: ap.step, receipt: invB.receipt, reject: { gate: s3, tx: rj.step } },
  },
  setup: steps.filter((s) => ["register", "verify", "allow", "mandate", "inv1", "inv2", "inv3"].includes(s.key)),
  cleanup: steps.filter((s) => ["refundApprove", "refund1", "refund2", "cancel3", "revoke", "allow0"].includes(s.key)),
  finishedAt: new Date().toISOString(),
};
writeFileSync(`${root}deployments/judge-${chainId}.json`, JSON.stringify(out, null, 2) + "\n");
const p = `${root}web/src/judge-runs.json`;
const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
all[chainId] = out;
writeFileSync(p, JSON.stringify(all, null, 2) + "\n");
console.log(`\nJudge run recorded: ${steps.length} transactions → deployments/judge-${chainId}.json`);
