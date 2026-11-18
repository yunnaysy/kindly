#!/usr/bin/env node
// Kindly AP agent: submits the owner's incoming invoices to the on-chain Invoice Safety Gate.
//
// Who decides what:
//   * The CONTRACT decides (Kindly.agentProcess -> PAY / HOLD / REJECT + reason + risk), deterministically,
//     and emits a SafetyDecision event for every attempt. HOLD needs an explicit approval tx by the owner.
//   * The AGENT only (1) pins the payee name from its own vendor book (Confirmation of Payee), (2) previews the
//     decision with the same view function, (3) explains it in plain language, (4) handles retries.
//   * Free text written by merchants (memo, name) is untrusted data and is never interpreted as instructions.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, getAddress, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById, explorerTx } from "../shared/config.js";
import { STATUS, DECISION, nameHash, fromUnits, sanitizeText, errorReason, explainDecision } from "../shared/kindly.js";

const root = new URL("..", import.meta.url).pathname;
const KindlyAbi = JSON.parse(readFileSync(`${root}shared/abi/Kindly.json`, "utf8")).abi;
const RegistryAbi = JSON.parse(readFileSync(`${root}shared/abi/PayeeRegistry.json`, "utf8")).abi;

const RETRYABLE = /timeout|timed out|ECONNRESET|fetch failed|rate limit|429|502|503|nonce too low|replacement/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, { attempts = 4, baseMs = 500, log = () => {} } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      const msg = e?.shortMessage || e?.message || "";
      if (!RETRYABLE.test(msg) || i === attempts - 1) throw e;
      log(`retry ${i + 1}/${attempts - 1} after: ${msg.slice(0, 80)}`);
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

/** Name the agent expects for a merchant: from its own vendor book only, never from the invoice. */
export function expectedNameFor(vendorBook, merchant) {
  return vendorBook[getAddress(merchant)] ?? "";
}

/** Pure pre-check (unit-tested): skip invoices that are not worth a transaction. */
export function shouldSubmit({ invoice, journal, invoiceId }) {
  if (journal?.[invoiceId]?.final) return { submit: false, reason: "already decided (journal)" };
  if (STATUS[invoice.status] !== "Open") return { submit: false, reason: `status ${STATUS[invoice.status]}` };
  return { submit: true };
}

/** One pass over invoice ids. Returns a report with the on-chain decision for each. */
export async function runOnce({ publicClient, walletClient, kindly, registry, mandateId, vendorBook, invoiceIds, journal = {}, log = console.log }) {
  const report = [];
  const chainId = await publicClient.getChainId();
  for (const invoiceId of invoiceIds) {
    const invoice = await withRetry(() => publicClient.readContract({ address: kindly, abi: KindlyAbi, functionName: "getInvoice", args: [invoiceId] }));
    const pre = shouldSubmit({ invoice, journal, invoiceId });
    if (!pre.submit) {
      log(`skip ${invoiceId.slice(0, 10)}…: ${pre.reason}`);
      report.push({ invoiceId, action: "skip", reason: pre.reason });
      continue;
    }
    const expected = nameHash(expectedNameFor(vendorBook, invoice.merchant));
    const payee = await publicClient.readContract({ address: registry, abi: RegistryAbi, functionName: "getPayee", args: [invoice.merchant] });
    const mandate = await publicClient.readContract({ address: kindly, abi: KindlyAbi, functionName: "getMandate", args: [mandateId] });
    const [decision, reason, risk, usual] = await publicClient.readContract({ address: kindly, abi: KindlyAbi, functionName: "evaluate", args: [mandateId, invoiceId, expected] });
    const preview = explainDecision({ decision, reason, risk, amount: invoice.amount, usual, merchantName: payee.name, cap: mandate.perPaymentCap, remaining: mandate.totalBudget - mandate.spent });
    log(`gate preview ${invoiceId.slice(0, 10)}… ${preview.decision} (${preview.reason}, risk ${preview.risk}): ${preview.text}`);

    let hash;
    try {
      const { request } = await publicClient.simulateContract({ account: walletClient.account, address: kindly, abi: KindlyAbi, functionName: "agentProcess", args: [mandateId, invoiceId, expected] });
      hash = await withRetry(() => walletClient.writeContract(request), { log });
    } catch (e) {
      const why = errorReason(e); // mandate frozen / revoked / expired / cooldown / already held
      log(`not submitted ${invoiceId.slice(0, 10)}…: ${why}`);
      report.push({ invoiceId, action: "blocked", reason: why });
      continue;
    }
    journal[invoiceId] = { status: "sent", hash };
    let receipt;
    try {
      receipt = await withRetry(() => publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 }), { log });
    } catch (e) {
      // Reconcile from chain state instead of re-sending (idempotency).
      const hold = await publicClient.readContract({ address: kindly, abi: KindlyAbi, functionName: "getHold", args: [invoiceId] });
      const after = await publicClient.readContract({ address: kindly, abi: KindlyAbi, functionName: "getInvoice", args: [invoiceId] });
      if (!(hold.active || STATUS[after.status] === "Paid")) throw e;
      receipt = { status: "success", logs: [] };
    }
    const ev = parseEventLogs({ abi: KindlyAbi, eventName: "SafetyDecision", logs: receipt.logs })[0]?.args;
    const final = ev ? explainDecision({ decision: ev.decision, reason: ev.reason, risk: ev.risk, amount: ev.amount, usual: ev.usualAmount, merchantName: payee.name, cap: mandate.perPaymentCap, remaining: mandate.totalBudget - mandate.spent }) : preview;
    journal[invoiceId] = { status: final.decision, hash, final: final.decision !== "HOLD" };
    const link = explorerTx(chainId, hash);
    log(`on-chain ${final.decision} ${invoiceId.slice(0, 10)}… tx ${hash}${link ? " " + link : ""}`);
    report.push({ invoiceId, action: final.decision, reason: final.reason, risk: final.risk, explanation: final.text, hash });
  }
  return report;
}

// ------------------------------------------------------------------------------------ CLI
async function main() {
  const cfgPath = process.argv[2] || `${root}agent/agent.config.json`;
  if (!existsSync(cfgPath)) {
    console.error(`Missing ${cfgPath}. Copy agent/agent.config.example.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const key = process.env.AGENT_KEY;
  if (!key) throw new Error("Set AGENT_KEY (the agent's hot key; it needs only a little tQDAY for gas, never stablecoins).");
  const chain = chainById(cfg.chainId);
  const transport = http(cfg.rpcUrl || chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account: privateKeyToAccount(key) });
  const statePath = `${root}agent/state.json`;
  const journal = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const vendorBook = Object.fromEntries(Object.entries(cfg.vendorBook).map(([a, n]) => [getAddress(a), n]));

  const loop = async () => {
    const mandate = await publicClient.readContract({ address: cfg.kindly, abi: KindlyAbi, functionName: "getMandate", args: [BigInt(cfg.mandateId)] });
    const logs = await publicClient.getContractEvents({ address: cfg.kindly, abi: KindlyAbi, eventName: "InvoiceCreated", args: { payer: mandate.owner }, fromBlock: BigInt(cfg.fromBlock || 0) });
    const ids = [...new Set(logs.map((l) => l.args.id))].filter((id) => !journal[id]?.final);
    await runOnce({ publicClient, walletClient, kindly: cfg.kindly, registry: cfg.registry, mandateId: BigInt(cfg.mandateId), vendorBook, invoiceIds: ids, journal });
    writeFileSync(statePath, JSON.stringify(journal, null, 2));
  };
  await loop();
  if (cfg.pollSeconds) setInterval(() => loop().catch((e) => console.error(errorReason(e))), cfg.pollSeconds * 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(errorReason(e)); process.exit(1); });
