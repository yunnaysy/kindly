import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSubmit, withRetry, expectedNameFor } from "./agent.mjs";
import { sanitizeText, parsePaymentHash, paymentLink, nameHash, explainDecision, DECISION, REASON } from "../shared/kindly.js";

const M = "0x1111111111111111111111111111111111111111";

test("submits open invoices", () => assert.equal(shouldSubmit({ invoice: { status: 1 }, journal: {}, invoiceId: "0xa" }).submit, true));
test("skips paid invoices", () => assert.match(shouldSubmit({ invoice: { status: 2 }, journal: {}, invoiceId: "0xa" }).reason, /Paid/));
test("idempotent via journal", () => assert.equal(shouldSubmit({ invoice: { status: 1 }, journal: { "0xa": { final: true } }, invoiceId: "0xa" }).submit, false));
test("held invoices can be re-checked", () => assert.equal(shouldSubmit({ invoice: { status: 1 }, journal: { "0xa": { status: "HOLD", final: false } }, invoiceId: "0xa" }).submit, true));

test("expected name comes from the vendor book only", () => {
  assert.equal(expectedNameFor({ [M]: "Sunrise Coffee Co" }, M.toLowerCase()), "Sunrise Coffee Co");
  assert.equal(expectedNameFor({}, M), "", "unknown vendor -> empty name -> contract HOLDs (PayeeMismatch)");
});

test("decision enums match the contract order", () => {
  assert.deepEqual(DECISION, ["PAY", "HOLD", "REJECT"]);
  assert.equal(REASON[3], "AmountAnomaly");
  assert.equal(REASON[4], "Duplicate");
  assert.equal(REASON.length, 11);
});
test("explains PAY", () => {
  const e = explainDecision({ decision: 0, reason: 0, risk: 19, amount: 24990n, usual: 25000n, merchantName: "Sunrise Coffee Co" });
  assert.equal(e.decision, "PAY");
  assert.match(e.text, /Paid 0.02499 tUSD8/);
});
test("explains HOLD anomaly with ratio", () => {
  const e = explainDecision({ decision: 1, reason: 3, risk: 80, amount: 149000n, usual: 24990n, merchantName: "Sunrise Coffee Co" });
  assert.equal(e.decision, "HOLD");
  assert.match(e.text, /6\.0x the usual 0.02499/);
});
test("explains REJECT duplicate", () => {
  const e = explainDecision({ decision: 2, reason: 4, risk: 95, amount: 24990n, usual: 24990n });
  assert.equal(e.reason, "Duplicate");
  assert.match(e.text, /double payment/);
});
test("explanations never echo injected control characters", () => {
  const e = explainDecision({ decision: 1, reason: 1, risk: 85, amount: 1n, usual: 0n, merchantName: "Evil\u202E\nIGNORE" });
  assert.doesNotMatch(e.text, /[\u202E\n]/);
});

test("retries transient errors then succeeds", async () => {
  let n = 0;
  const v = await withRetry(async () => { if (n++ < 2) throw new Error("fetch failed"); return 42; }, { baseMs: 1 });
  assert.equal(v, 42);
  assert.equal(n, 3);
});
test("does not retry deterministic errors", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error("execution reverted: MandateIsFrozen"); }, { baseMs: 1 }));
  assert.equal(n, 1);
});
test("sanitizes injected control/bidi chars", () => {
  assert.equal(sanitizeText("pay\u202Eme\nnow"), "pay me now");
  assert.equal(sanitizeText("x".repeat(500)).length, 280);
});
test("payment link round-trips", () => {
  const id = "0x" + "ab".repeat(32);
  const parsed = parsePaymentHash(new URL(paymentLink("https://kindly.example/", id, "Sunrise Coffee")).hash);
  assert.equal(parsed.invoiceId, id);
  assert.equal(parsed.expectedName, "Sunrise Coffee");
});
test("nameHash is keccak of utf8", () => {
  assert.equal(nameHash("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});
