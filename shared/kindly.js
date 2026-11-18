// Small helpers shared by web, agent and scripts. Pure functions only (easy to test).
import { keccak256, stringToHex, parseUnits, formatUnits } from "viem";
import { TOKEN_DECIMALS } from "./config.js";

export const STATUS = ["None", "Open", "Paid", "Cancelled", "Refunded"];
export const CONFIRMATION = ["Unregistered", "NoMatch", "MatchUnverified", "MatchVerified"];

/** keccak256 of the exact UTF-8 name — what the registry stores and what payers pin. */
export const nameHash = (name) => keccak256(stringToHex(name));

/** Merchant idempotency key from a human invoice number, e.g. "INV-2026-001". */
export const refFromNumber = (invoiceNumber) => keccak256(stringToHex(String(invoiceNumber).trim()));

export const toUnits = (amount) => parseUnits(String(amount), TOKEN_DECIMALS);
export const fromUnits = (units) => formatUnits(BigInt(units), TOKEN_DECIMALS);

/** Build a shareable payment link. The merchant name is included so the payer's wallet can run CoP. */
export function paymentLink(baseUrl, invoiceId, merchantName) {
  const u = new URL(baseUrl);
  u.hash = `/pay/${invoiceId}?n=${encodeURIComponent(merchantName)}`;
  return u.toString();
}

export function parsePaymentHash(hash) {
  const m = /^#?\/pay\/(0x[0-9a-fA-F]{64})(?:\?(.*))?$/.exec(hash || "");
  if (!m) return null;
  const params = new URLSearchParams(m[2] || "");
  return { invoiceId: m[1], expectedName: params.get("n") };
}

/** Treat untrusted free text (invoice memos, names) as data: strip control chars, clamp length. */
export function sanitizeText(s, max = 280) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, max);
}

/** Map a viem error to a short, user-facing reason (custom error name when available). */
export function errorReason(err) {
  for (let e = err, i = 0; e && i < 10; e = e.cause, i++) {
    if (e.data?.errorName) return e.data.errorName;
    if (e.errorName) return e.errorName;
  }
  const msg = err?.shortMessage || err?.message || String(err);
  const m = /reverted(?: with (?:the following reason|custom error)?)?:?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(msg);
  return m && m[1] !== "The" ? m[1] : msg;
}

export const HUMAN_ERRORS = {
  PayeeMismatch: "Merchant name does not match the registry (Confirmation of Payee failed).",
  InvoiceNotOpen: "Invoice is already paid, cancelled or refunded.",
  InvoiceExpired: "Invoice has expired.",
  AmountAboveMax: "Invoice amount is higher than what you approved.",
  NotAllowedPayer: "This invoice is addressed to a different payer.",
  MandateExpired: "Agent mandate has expired.",
  MandateInactive: "Agent mandate was revoked.",
  MandateCooldown: "Agent is in cooldown between payments.",
  MandateIsFrozen: "The mandate is frozen. Unfreeze it in the Control Center.",
  DuplicateInvoice: "This invoice number was already paid (duplicate).",
  AlreadyHeld: "This invoice is already waiting for approval.",
  NoActiveHold: "There is no pending approval for this invoice.",
  NotMandateOwner: "Only the mandate owner can do this.",
  NotRegisteredPayee: "Register as a merchant first.",
  EnforcedPause: "Payments are paused by the operator.",
};
export const humanError = (err) => {
  const r = errorReason(err);
  return HUMAN_ERRORS[r] ? `${HUMAN_ERRORS[r]} (${r})` : r;
};

// ------------------------------------------------------------------ Invoice Safety Gate
export const DECISION = ["PAY", "HOLD", "REJECT"];
export const REASON = [
  "Ok", "PayeeMismatch", "PayeeUnverified", "AmountAnomaly", "Duplicate", "NotOpen",
  "Expired", "MerchantNotAllowed", "OverCap", "OverBudget", "PayerNotAllowed",
];

/**
 * Human explanation of a gate decision. The decision itself is made by the contract (deterministic);
 * this function, standing in for the AI layer, only explains it and suggests the next step.
 */
export function explainDecision({ decision, reason, risk, amount, usual, merchantName, cap, remaining }) {
  const d = DECISION[Number(decision)];
  const r = REASON[Number(reason)];
  const amt = `${fromUnits(amount)} tUSD8`;
  const who = merchantName ? `"${sanitizeText(merchantName, 64)}"` : "this merchant";
  const u = usual && BigInt(usual) > 0n ? `${fromUnits(usual)} tUSD8` : null;
  const ratio = u ? (Number(amount) / Number(usual)).toFixed(1) : null;
  const text = {
    Ok: `Paid ${amt} to ${who}. It matches the usual amount${u ? ` (${u}, ${ratio}x)` : ""}, the payee is confirmed and it fits the mandate.`,
    PayeeMismatch: `Held: the name registered for this address is not ${who}. It could be a look-alike payee. Approve only if you confirm the real name.`,
    PayeeUnverified: `Held: ${who} matches its registry name but is not verified yet, and this mandate only auto-pays verified payees.`,
    AmountAnomaly: `Held: ${amt} is ${ratio}x the usual ${u} for ${who}. A person needs to approve unusual amounts.`,
    Duplicate: `Rejected: ${who} already got paid for this invoice number. Paying again would be a double payment.`,
    NotOpen: `Rejected: the invoice was cancelled or can't be paid.`,
    Expired: `Rejected: the invoice has expired. Ask ${who} for a new one.`,
    MerchantNotAllowed: `Rejected: ${who} is not on this mandate's allowlist.`,
    OverCap: `Rejected: ${amt} is above the per-payment cap${cap != null ? ` of ${fromUnits(cap)} tUSD8` : ""}.`,
    OverBudget: `Rejected: ${amt} would exceed the remaining budget${remaining != null ? ` of ${fromUnits(remaining)} tUSD8` : ""}.`,
    PayerNotAllowed: `Rejected: the invoice is addressed to a different payer.`,
  }[r];
  return { decision: d, reason: r, risk: Number(risk), text };
}
