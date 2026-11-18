import "./style.css";
import { createPublicClient, createWalletClient, custom, http, erc20Abi, getAddress, isAddress, zeroAddress, parseEther, formatEther, parseEventLogs, keccak256, encodeAbiParameters } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import { aevumTestnet, localAnvil, explorerTx, explorerAddress, FAUCET_URL } from "../../shared/config.js";
import {
  STATUS, CONFIRMATION, DECISION, REASON, nameHash, refFromNumber, toUnits, fromUnits, paymentLink, parsePaymentHash,
  sanitizeText, humanError, explainDecision,
} from "../../shared/kindly.js";
import KindlyArt from "../../shared/abi/Kindly.json";
import RegistryArt from "../../shared/abi/PayeeRegistry.json";
import deployments from "./deployments.json";
import recordedRuns from "./recorded-runs.json";

const K = KindlyArt.abi;
const R = RegistryArt.abi;

// ------------------------------------------------------------------ config
const params = new URLSearchParams(location.search);
const CHAIN = params.get("chain") === "31337" ? localAnvil : aevumTestnet;
const D = deployments[CHAIN.id] || {};
const RPC = CHAIN.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const state = { account: null, wallet: null };
const SCALE = 1000; // "$24.99" in the story = 0.02499 tUSD8 on testnet
const usdToUnits = (usd) => toUnits((usd / SCALE).toFixed(6));
const unitsToUsd = (u) => `$${(Number(fromUnits(u)) * SCALE).toFixed(2)}`;

// ------------------------------------------------------------------ DOM helpers (textContent only → no HTML injection)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const $app = document.getElementById("app");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const txLink = (hash, label) => {
  const u = explorerTx(CHAIN.id, hash);
  return u ? h("a", { href: u, target: "_blank", rel: "noopener", class: "mono" }, label || short(hash)) : h("span", { class: "mono" }, label || short(hash));
};
const addrLink = (a) => {
  const u = explorerAddress(CHAIN.id, a);
  return u ? h("a", { href: u, target: "_blank", rel: "noopener", class: "mono" }, short(a)) : h("span", { class: "mono" }, short(a));
};
function toast(msg, kind = "info") {
  let box = document.getElementById("toasts");
  if (!box) { box = h("div", { id: "toasts", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, msg);
  box.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 9000 : 5000);
}
function banner(msg) {
  const b = document.getElementById("banner");
  b.textContent = msg || "";
  b.classList.toggle("hidden", !msg);
}
const riskView = (risk) => h("span", { class: "risk" }, `risk ${risk}`, h("span", { class: "meter" }, h("span", { style: `width:${Math.min(Number(risk), 100)}%` })));
function decisionCard(ex, extra) {
  return h("div", { class: `decision ${ex.decision}` },
    h("div", { class: "row between" }, h("span", { class: "verdict" }, { PAY: "✓ PAY", HOLD: "⏸ HOLD", REJECT: "✕ REJECT" }[ex.decision]), riskView(ex.risk)),
    h("p", {}, ex.text), h("div", { class: "row small muted" }, h("span", { class: "chip" }, ex.reason), extra));
}

// ------------------------------------------------------------------ wallet
async function connect({ rerender = true } = {}) {
  if (!window.ethereum) return toast("No browser wallet found. Install MetaMask, then reload.", "error");
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.account = getAddress(addr);
  state.wallet = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum), account: state.account });
  await ensureChain();
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
  await refreshHeader();
  if (rerender) route();
}
async function ensureChain() {
  const hex = await window.ethereum.request({ method: "eth_chainId" });
  if (Number(hex) === CHAIN.id) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CHAIN.id.toString(16)}` }] });
  } catch (e) {
    if (e.code !== 4902 || CHAIN.id !== aevumTestnet.id) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0xabe5", chainName: "QDay Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: ["https://rpc-test.qday.info"], blockExplorerUrls: ["https://explorer-test.qday.info"] }],
    });
  }
}
async function refreshHeader() {
  const net = document.getElementById("net");
  try {
    const bn = await pub.getBlockNumber();
    net.textContent = `${CHAIN.name} · #${bn}`;
    net.className = "pill ok";
  } catch {
    net.textContent = "RPC unreachable";
    net.className = "pill bad";
  }
  if (state.account) {
    const bal = D.token ? await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }).catch(() => 0n) : 0n;
    document.getElementById("connect").textContent = `${short(state.account)} · ${fromUnits(bal)} tUSD8`;
  }
}
function requireWallet() {
  if (!state.account) throw new Error("Connect your wallet first.");
  if (!D.kindly) throw new Error("Contracts are not deployed on this network yet.");
}

/** simulate → write → wait, with status + error feedback and double-click protection. `signer` defaults to the connected wallet. */
async function send(button, label, { address, abi, functionName, args, value }, signer) {
  const wallet = signer || state.wallet;
  const account = signer ? signer.account : state.account;
  if (!signer) requireWallet();
  const original = button?.textContent;
  try {
    if (button) { button.disabled = true; button.textContent = signer ? "Working…" : "Check wallet…"; }
    const { request, result } = await pub.simulateContract({ account, address, abi, functionName, args, value });
    const hash = await wallet.writeContract(request);
    if (button) button.textContent = "Confirming…";
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`Transaction reverted (${hash})`);
    if (!signer) toast(`${label}: confirmed ✓`, "ok");
    refreshHeader();
    return { hash, result, receipt: r };
  } catch (e) {
    toast(`${label} failed: ${humanError(e)}`, "error");
    throw e;
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}
async function ensureAllowance(button, amount) {
  const allowance = await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] });
  if (allowance >= amount) return null;
  // Least privilege: approve exactly what is needed, never unlimited.
  return send(button, `Approve ${fromUnits(amount)} tUSD8`, { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, amount] });
}
const fromBlock = () => BigInt(D.deployBlock || 0);
const mandateStatus = (m) => (m.revoked ? "Revoked" : m.frozen ? "Frozen" : Date.now() / 1000 > Number(m.validUntil) ? "Expired" : "Active");

// ------------------------------------------------------------------ Home
function viewHome() {
  return h("section", {},
    h("div", { class: "hero" },
      h("h1", {}, "Payments, ", h("em", {}, "taken care of.")),
      h("p", { class: "lead" }, "Kindly lets small businesses send stablecoin invoices as a link or QR code, and lets an AI assistant pay your bills — but only through an on-chain Invoice Safety Gate that decides PAY, HOLD or REJECT for every invoice, with a reason and a risk score you can verify."),
      h("div", { class: "row" }, h("a", { class: "btn big", href: "#/demo" }, "▶ Run the 3-invoice demo"), h("a", { class: "btn ghost", href: "#/control" }, "Open Control Center"))),
    h("div", { class: "grid3" },
      feature("🛡️", "var(--mint)", "Invoice Safety Gate", "Look-alike payee → HOLD. Unusual amount (≥3× usual) → HOLD. Duplicate, expired, over cap, not allowlisted → REJECT. Decided by the contract, emitted as events."),
      feature("🎛️", "var(--lav)", "Live Control Center", "Change limits, add merchants, freeze, unfreeze or revoke your agent in one tap. See the remaining budget update live."),
      feature("🔗", "var(--butter)", "Links, QR & Confirmation of Payee", "Merchants get verified names. Payers see a green ✓ only when the name matches, and the contract rejects swapped links.")),
    D.kindly
      ? h("p", { class: "muted small" }, "Live contracts: Kindly ", addrLink(D.kindly), " · PayeeRegistry ", addrLink(D.registry), " · tUSD8 ", addrLink(D.token))
      : h("p", { class: "warn" }, `Contracts not deployed on ${CHAIN.name} yet.`));
}
const feature = (icon, bg, title, body) => h("div", { class: "feature" }, h("div", { class: "icon", style: `background:${bg}` }, icon), h("h3", {}, title), h("p", { class: "muted" }, body));

// ------------------------------------------------------------------ RUN DEMO
const DEMO_KEY = `kindly.demo.${CHAIN.id}`;
function demoKeys() {
  let k = JSON.parse(localStorage.getItem(DEMO_KEY) || "null");
  if (!k) { k = { merchant: generatePrivateKey(), agent: generatePrivateKey() }; localStorage.setItem(DEMO_KEY, JSON.stringify(k)); }
  const mk = (pk) => createWalletClient({ chain: CHAIN, transport: http(RPC), account: privateKeyToAccount(pk) });
  return { merchant: mk(k.merchant), agent: mk(k.agent) };
}
const DEMO_NAME = "Kindly Demo Café";

function viewDemo() {
  const root = h("section", {});
  const steps = h("ol", { class: "timeline" });
  const cards = h("div", { class: "grid3" });
  const runBtn = h("button", { class: "btn big" }, "▶ RUN DEMO");
  const approveBox = h("div", {});
  root.append(h("div", { class: "card" },
    h("h2", {}, "One-click demo: three invoices, three decisions"),
    h("p", { class: "muted" }, "A demo café sends three invoices to you. Your AI assistant submits each one to the on-chain Invoice Safety Gate. Amounts are scaled 1:1000 on testnet ($24.99 → 0.02499 tUSD8) and refunded at the end, so the demo costs you almost nothing."),
    h("div", { class: "grid3" },
      h("div", { class: "decision PAY" }, h("strong", {}, "$24.99 · INV-1001"), h("span", { class: "small" }, "usual amount → auto-paid")),
      h("div", { class: "decision HOLD" }, h("strong", {}, "$149 · INV-1002"), h("span", { class: "small" }, "6× usual → held for your approval")),
      h("div", { class: "decision REJECT" }, h("strong", {}, "$24.99 · INV-1001 again"), h("span", { class: "small" }, "duplicate invoice number → blocked"))),
    h("p", { class: "small muted" }, "You'll confirm 3 wallet prompts (budget approval, mandate, and the HOLD approval) plus 2 tiny gas top-ups on the first run. The café and assistant use throwaway testnet keys kept in this browser."),
    runBtn, approveBox, steps));
  root.append(h("div", { class: "card" }, h("h2", {}, "Gate decisions"), cards));
  root.append(recordedRunCard());

  const add = (label) => {
    const li = h("li", { class: "run" }, h("span", { class: "dot" }, "•"), h("span", {}, label), h("span", { class: "small" }));
    steps.append(li);
    return {
      ok: (hash, note) => { li.className = "done"; li.firstChild.textContent = "✓"; li.lastChild.replaceChildren(hash ? txLink(hash, "view tx ↗") : note || ""); },
      fail: (msg) => { li.className = "err"; li.firstChild.textContent = "!"; li.lastChild.textContent = msg; },
    };
  };
  const step = async (label, fn) => {
    const s = add(label);
    try { const r = await fn(); s.ok(r?.hash, r?.note); return r; } catch (e) { s.fail(humanError(e)); throw e; }
  };

  runBtn.onclick = async () => {
    try {
      if (!state.account) await connect({ rerender: false });
      requireWallet();
      runBtn.disabled = true;
      steps.replaceChildren(); cards.replaceChildren(); approveBox.replaceChildren();
      const { merchant, agent } = demoKeys();
      const run = Date.now().toString(36);
      const gasTop = CHAIN.id === 31337 ? parseEther("0.05") : parseEther("0.003");
      for (const [who, w] of [["café", merchant], ["assistant", agent]]) {
        const bal = await pub.getBalance({ address: w.account.address });
        if (bal < gasTop / 2n) {
          await step(`Top up the demo ${who} with ${formatEther(gasTop)} tQDAY for gas`, async () => {
            const hash = await state.wallet.sendTransaction({ to: w.account.address, value: gasTop, account: state.account, chain: CHAIN });
            await pub.waitForTransactionReceipt({ hash });
            return { hash };
          });
        }
      }
      const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [merchant.account.address] });
      if (!payee.active || payee.name !== DEMO_NAME) await step(`Café registers its name "${DEMO_NAME}"`, () => send(null, "Register", { address: D.registry, abi: R, functionName: "register", args: [DEMO_NAME, ""] }, merchant));
      const need = usdToUnits(24.99) + usdToUnits(149);
      await step(`You approve exactly ${fromUnits(need)} tUSD8 for Kindly`, async () => (await ensureAllowance(null, need)) || { note: "allowance already set" });
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400);
      const { result: mandateId, hash: mh } = await step("You give your assistant a mandate: cap $200, budget $500, usual $25, café only", () => send(null, "Create mandate", {
        address: D.kindly, abi: K, functionName: "createMandate",
        args: [{ agent: agent.account.address, perPaymentCap: usdToUnits(200), totalBudget: usdToUnits(500), typicalAmount: usdToUnits(25), validUntil, cooldown: 0, anyMerchant: false, requireVerifiedPayee: false, merchants: [merchant.account.address] }],
      }));
      void mh;
      const exp = BigInt(Math.floor(Date.now() / 1000) + 86400);
      const issue = (num, usd, memo) => step(`Café sends ${num} for $${usd}`, () => send(null, "Invoice", { address: D.kindly, abi: K, functionName: "createInvoice", args: [refFromNumber(`${num}-${run}`), state.account, usdToUnits(usd), exp, memo] }, merchant));
      const gate = async (label, invoiceId) => {
        const r = await step(`Assistant submits ${label} to the Safety Gate`, () => send(null, "Gate", { address: D.kindly, abi: K, functionName: "agentProcess", args: [mandateId, invoiceId, nameHash(DEMO_NAME)] }, agent));
        const ev = parseEventLogs({ abi: K, eventName: "SafetyDecision", logs: r.receipt.logs })[0].args;
        const ex = explainDecision({ decision: ev.decision, reason: ev.reason, risk: ev.risk, amount: ev.amount, usual: ev.usualAmount, merchantName: DEMO_NAME, cap: usdToUnits(200) });
        cards.append(decisionCard(ex, [h("span", {}, label), txLink(r.hash, "decision tx ↗")]));
        return { ex, hash: r.hash };
      };
      const a = (await issue("INV-1001", 24.99, "Weekly coffee beans")).result;
      await gate("INV-1001 ($24.99)", a);
      const b = (await issue("INV-1002", 149, "Espresso machine service")).result;
      const gb = await gate("INV-1002 ($149)", b);
      if (gb.ex.decision === "HOLD") {
        await new Promise((resolve, reject) => {
          const ok = h("button", { class: "btn mint big" }, "Approve $149 payment");
          const no = h("button", { class: "btn danger" }, "Reject");
          approveBox.replaceChildren(h("div", { class: "decision HOLD" }, h("strong", {}, "Your assistant is waiting for you"), h("p", {}, gb.ex.text), h("div", { class: "row" }, ok, no)));
          ok.onclick = async () => {
            try { await step("You approve the held $149 invoice (explicit approval tx)", () => send(ok, "Approve hold", { address: D.kindly, abi: K, functionName: "approveHold", args: [b, nameHash(DEMO_NAME)] })); approveBox.replaceChildren(); resolve(); } catch (e) { reject(e); }
          };
          no.onclick = async () => {
            try { await step("You reject the held invoice", () => send(no, "Reject hold", { address: D.kindly, abi: K, functionName: "rejectHold", args: [b] })); approveBox.replaceChildren(); resolve(); } catch (e) { reject(e); }
          };
        });
      }
      const c = (await issue("INV-1001", 24.99, "Weekly coffee beans")).result;
      await gate("INV-1001 again ($24.99)", c);
      // give the tokens back so the demo is repeatable on a one-time faucet claim
      const paid = [];
      for (const id of [a, b]) { const i = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] }); if (STATUS[i.status] === "Paid") paid.push([id, i.amount]); }
      const total = paid.reduce((s, [, amt]) => s + amt, 0n);
      if (total > 0n) {
        await step("Café approves the refund", () => send(null, "Approve", { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, total] }, merchant));
        for (const [id, amt] of paid) await step(`Café refunds ${fromUnits(amt)} tUSD8 to you`, () => send(null, "Refund", { address: D.kindly, abi: K, functionName: "refund", args: [id, amt] }, merchant));
      }
      await step("Café cancels the duplicate invoice", () => send(null, "Cancel", { address: D.kindly, abi: K, functionName: "cancelInvoice", args: [c] }, merchant));
      toast("Demo complete ✓ Open the Control Center to see the mandate.", "ok");
    } catch (e) {
      toast(`Demo stopped: ${humanError(e)}`, "error");
    } finally {
      runBtn.disabled = false;
    }
  };
  return root;
}
function recordedRunCard() {
  const run = recordedRuns[CHAIN.id];
  if (!run?.decisions?.length) return h("div", {});
  return h("div", { class: "card" },
    h("h2", {}, "Last recorded run on Aevum"),
    h("p", { class: "muted small" }, `Recorded by scripts/e2e.mjs at ${run.finishedAt}. Every decision below is a real SafetyDecision event — click through to the explorer.`),
    h("div", { class: "grid3" }, run.decisions.map((d) => decisionCard({ decision: d.decision, reason: d.reason, risk: d.risk, text: d.explanation }, [h("span", {}, d.invoice), txLink(d.hash, "tx ↗")]))));
}

// ------------------------------------------------------------------ Control Center
async function viewControl() {
  const root = h("section", {});
  if (!state.account) {
    root.append(h("div", { class: "card" }, h("h2", {}, "Live Mandate Control Center"), h("p", { class: "muted" }, "Connect your wallet to manage what your AI assistant may pay."), h("button", { class: "btn", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, "Connect wallet")));
    return root;
  }
  requireWallet();
  const live = h("span", { class: "chip ok" }, "● live");
  const list = h("div", { class: "grid2" }, h("p", { class: "muted" }, "Loading…"));
  const holds = h("div", { class: "grid2" });
  const feed = h("div", { class: "grid3" });
  root.append(h("div", { class: "row between" }, h("h2", { style: "margin:0" }, "Live Mandate Control Center"), live));
  root.append(h("div", { class: "card" }, h("h3", {}, "Waiting for your approval"), holds));
  root.append(h("div", { class: "card" }, h("h3", {}, "Your mandates"), list));
  root.append(h("div", { class: "card" }, h("h3", {}, "Recent gate decisions"), feed));
  root.append(newMandateCard());

  async function load() {
    const created = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "MandateCreated", args: { owner: state.account }, fromBlock: fromBlock() });
    const ids = created.map((l) => l.args.id).reverse();
    const cards = [];
    for (const id of ids.slice(0, 12)) cards.push(await mandateCard(id, load));
    list.replaceChildren(...(cards.length ? cards : [h("p", { class: "muted" }, "No mandates yet. Create one below, or run the demo.")]));
    // decisions + holds for my mandates
    const decs = [];
    for (const id of ids.slice(0, 12)) decs.push(...(await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "SafetyDecision", args: { mandateId: id }, fromBlock: fromBlock() })));
    decs.sort((x, y) => Number(y.blockNumber - x.blockNumber));
    feed.replaceChildren(...(decs.length ? decs.slice(0, 9).map((ev) => decisionCard(explainDecision({ ...ev.args, usual: ev.args.usualAmount }), [h("span", {}, `mandate #${ev.args.mandateId} · ${unitsToUsd(ev.args.amount)}`), txLink(ev.transactionHash, "tx ↗")])) : [h("p", { class: "muted" }, "No decisions yet.")]));
    const pending = [];
    for (const ev of decs.filter((x) => DECISION[x.args.decision] === "HOLD")) {
      const hold = await pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [ev.args.invoiceId] });
      if (!hold.active) continue;
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [ev.args.invoiceId] });
      const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] });
      const ex = explainDecision({ ...ev.args, usual: ev.args.usualAmount, merchantName: payee.name });
      const ok = h("button", { class: "btn mint small" }, `Approve ${fromUnits(inv.amount)} tUSD8 to “${sanitizeText(payee.name, 40)}”`);
      ok.onclick = async () => { await ensureAllowance(ok, inv.amount); await send(ok, "Approve hold", { address: D.kindly, abi: K, functionName: "approveHold", args: [ev.args.invoiceId, nameHash(payee.name)] }); load(); };
      const no = h("button", { class: "btn danger small" }, "Reject");
      no.onclick = async () => { await send(no, "Reject hold", { address: D.kindly, abi: K, functionName: "rejectHold", args: [ev.args.invoiceId] }); load(); };
      pending.push(h("div", { class: "decision HOLD" }, h("div", { class: "row between" }, h("strong", {}, `${fromUnits(inv.amount)} tUSD8 · mandate #${ev.args.mandateId}`), riskView(ev.args.risk)), h("p", {}, ex.text),
        ex.reason === "PayeeMismatch" ? h("p", { class: "small" }, `Approving confirms the registered name “${sanitizeText(payee.name, 64)}”.`) : null, h("div", { class: "row" }, ok, no)));
    }
    holds.replaceChildren(...(pending.length ? pending : [h("p", { class: "muted" }, "Nothing on hold. 🎉")]));
  }
  await load();
  const timer = setInterval(() => { if (!document.body.contains(live)) return clearInterval(timer); if (!document.querySelector("#app input:focus")) load().catch(() => {}); }, 12000);
  return root;
}

async function mandateCard(id, reload) {
  const m = await pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] });
  const remaining = await pub.readContract({ address: D.kindly, abi: K, functionName: "mandateRemaining", args: [id] });
  const st = mandateStatus(m);
  const pct = Number((m.spent * 100n) / (m.totalBudget || 1n));
  const live = st === "Active" || st === "Frozen";
  const cap = h("input", { type: "number", step: "0.001", value: fromUnits(m.perPaymentCap) });
  const budget = h("input", { type: "number", step: "0.001", value: fromUnits(m.totalBudget) });
  const usual = h("input", { type: "number", step: "0.001", value: fromUnits(m.typicalAmount) });
  const hours = h("input", { type: "number", min: "1", value: String(Math.max(1, Math.round((Number(m.validUntil) - Date.now() / 1000) / 3600))) });
  const cooldown = h("input", { type: "number", min: "0", value: String(m.cooldown / 60) });
  const anyM = h("input", { type: "checkbox", checked: m.anyMerchant });
  const verified = h("input", { type: "checkbox", checked: m.requireVerifiedPayee });
  const save = h("button", { class: "btn small" }, "Save limits");
  save.onclick = async () => {
    await send(save, "Update limits", { address: D.kindly, abi: K, functionName: "updateMandate", args: [id, toUnits(cap.value), toUnits(budget.value), toUnits(usual.value || "0"), BigInt(Math.floor(Date.now() / 1000) + Number(hours.value) * 3600), Number(cooldown.value) * 60, anyM.checked, verified.checked] });
    reload();
  };
  const freeze = h("button", { class: "btn soft small" }, m.frozen ? "▶ Unfreeze" : "❄ Freeze");
  freeze.onclick = async () => { await send(freeze, m.frozen ? "Unfreeze" : "Freeze", { address: D.kindly, abi: K, functionName: "setFrozen", args: [id, !m.frozen] }); reload(); };
  const revoke = h("button", { class: "btn danger small" }, "Revoke forever");
  revoke.onclick = async () => { if (!confirm("Revoke this mandate permanently?")) return; await send(revoke, "Revoke", { address: D.kindly, abi: K, functionName: "revokeMandate", args: [id] }); reload(); };
  const merchantIn = h("input", { placeholder: "0x… merchant to allow / remove" });
  const allow = h("button", { class: "btn ghost small" }, "Allow");
  const disallow = h("button", { class: "btn soft small" }, "Remove");
  const setM = (b, v) => async () => { if (!isAddress(merchantIn.value)) return toast("Enter a valid merchant address", "error"); await send(b, v ? "Allow merchant" : "Remove merchant", { address: D.kindly, abi: K, functionName: "setMandateMerchant", args: [id, getAddress(merchantIn.value), v] }); toast(v ? "Merchant allowed" : "Merchant removed", "ok"); };
  allow.onclick = setM(allow, true); disallow.onclick = setM(disallow, false);
  return h("div", { class: `mandate ${st.toLowerCase()}` },
    h("div", { class: "row between" }, h("strong", {}, `Mandate #${id}`), h("span", { class: `chip ${st === "Active" ? "ok" : st === "Frozen" ? "sky" : "bad"}` }, st)),
    h("div", { class: "row small muted" }, "assistant ", addrLink(m.agent)),
    h("div", { class: "row between" }, h("div", { class: "stat" }, h("small", {}, "Remaining budget"), h("span", { class: "big-num" }, `${fromUnits(remaining)}`), h("small", {}, `of ${fromUnits(m.totalBudget)} tUSD8`)),
      h("div", { class: "stat" }, h("small", {}, "Paid by assistant"), h("strong", {}, `${m.payments} × · ${fromUnits(m.spent)} tUSD8`))),
    h("div", { class: "bar" }, h("span", { style: `width:${Math.min(pct, 100)}%` })),
    live ? [
      h("div", { class: "grid2" }, h("label", {}, "Per-payment cap", cap), h("label", {}, "Total budget", budget), h("label", {}, "Usual amount (baseline)", usual), h("label", {}, "Valid for (hours)", hours), h("label", {}, "Cooldown (min)", cooldown)),
      h("div", { class: "row" }, h("label", { class: "check" }, anyM, "Any merchant"), h("label", { class: "check" }, verified, "Verified payees only")),
      h("div", { class: "row" }, save, freeze, revoke),
      h("div", { class: "row" }, merchantIn, allow, disallow),
    ] : h("p", { class: "small muted" }, "This mandate can no longer spend."));
}

function newMandateCard() {
  const agentIn = h("input", { placeholder: "0x… assistant address" });
  const merchants = h("input", { placeholder: "0x…, 0x… allowed merchants (comma separated)" });
  const cap = h("input", { type: "number", step: "0.001", value: "0.2" });
  const budget = h("input", { type: "number", step: "0.001", value: "0.5" });
  const usual = h("input", { type: "number", step: "0.001", value: "0.025" });
  const days = h("input", { type: "number", min: "1", value: "7" });
  const cooldown = h("input", { type: "number", min: "0", value: "0" });
  const anyM = h("input", { type: "checkbox" });
  const verified = h("input", { type: "checkbox", checked: true });
  const btn = h("button", { class: "btn" }, "Create mandate & approve budget");
  btn.onclick = async () => {
    if (!isAddress(agentIn.value)) return toast("Assistant address is invalid", "error");
    const list = merchants.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.some((a) => !isAddress(a))) return toast("A merchant address is invalid", "error");
    if (!anyM.checked && !list.length) return toast("Add at least one merchant, or tick “Any merchant”", "error");
    const b = toUnits(budget.value);
    await send(btn, "Create mandate", { address: D.kindly, abi: K, functionName: "createMandate", args: [{
      agent: getAddress(agentIn.value), perPaymentCap: toUnits(cap.value), totalBudget: b, typicalAmount: toUnits(usual.value || "0"),
      validUntil: BigInt(Math.floor(Date.now() / 1000) + Number(days.value) * 86400), cooldown: Number(cooldown.value) * 60,
      anyMerchant: anyM.checked, requireVerifiedPayee: verified.checked, merchants: list.map(getAddress),
    }] });
    await ensureAllowance(btn, b);
    route();
  };
  return h("div", { class: "card" }, h("h3", {}, "New mandate"),
    h("p", { class: "muted small" }, "Your assistant never holds your money. Kindly pulls exactly the invoice amount, only when the Safety Gate says PAY or you approve a HOLD."),
    h("div", { class: "grid2" }, h("label", {}, "Assistant address", agentIn), h("label", {}, "Allowed merchants", merchants), h("label", {}, "Per-payment cap (tUSD8)", cap), h("label", {}, "Total budget (tUSD8)", budget),
      h("label", {}, "Usual amount (tUSD8)", usual), h("label", {}, "Valid for (days)", days), h("label", {}, "Cooldown (minutes)", cooldown)),
    h("div", { class: "row" }, h("label", { class: "check" }, anyM, "Any merchant"), h("label", { class: "check" }, verified, "Verified payees only")), btn);
}

// ------------------------------------------------------------------ Merchant
async function viewMerchant() {
  const root = h("section", {});
  if (!state.account) { root.append(h("div", { class: "card" }, h("p", {}, "Connect your wallet to send invoices."))); return root; }
  requireWallet();
  const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [state.account] });
  const verified = await pub.readContract({ address: D.registry, abi: R, functionName: "isVerified", args: [state.account] });
  const nameIn = h("input", { value: payee.name || "", maxlength: 64, placeholder: "Your business name" });
  const uriIn = h("input", { value: payee.metadataURI || "", maxlength: 256, placeholder: "https://… (optional)" });
  const regBtn = h("button", { class: "btn" }, payee.active ? "Update profile" : "Register as merchant");
  regBtn.onclick = async () => {
    if (payee.active && nameIn.value !== payee.name && !confirm("Changing your name removes your verified badge until it is re-verified. Continue?")) return;
    await send(regBtn, "Register", { address: D.registry, abi: R, functionName: "register", args: [nameIn.value.trim(), uriIn.value.trim()] });
    route();
  };
  root.append(h("div", { class: "card" }, h("h2", {}, "Merchant profile"),
    h("div", { class: "row" }, payee.active ? h("span", { class: `chip ${verified ? "ok" : "amber"}` }, verified ? "✓ Verified payee" : "Registered · awaiting verification") : h("span", { class: "chip" }, "Not registered")),
    h("label", {}, "Name", nameIn), h("label", {}, "Profile URL", uriIn), regBtn,
    h("p", { class: "muted small" }, "On testnet, the Kindly operator verifies names. In production this would be a KYB partner or marketplace.")));
  if (!payee.active) return root;

  const num = h("input", { value: `INV-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 900 + 100)}` });
  const amt = h("input", { type: "number", min: "0.000001", step: "0.000001", placeholder: "0.025" });
  const payer = h("input", { placeholder: "0x… (optional — empty means anyone)" });
  const hours = h("input", { type: "number", min: "1", value: "24" });
  const memo = h("input", { maxlength: 280, placeholder: "What is this for?" });
  const out = h("div", {});
  const createBtn = h("button", { class: "btn" }, "Create invoice");
  createBtn.onclick = async () => {
    if (!(Number(amt.value) > 0)) return toast("Enter an amount", "error");
    if (payer.value && !isAddress(payer.value)) return toast("Payer must be a valid address", "error");
    const exp = BigInt(Math.floor(Date.now() / 1000) + Number(hours.value || 24) * 3600);
    const { result: id } = await send(createBtn, "Create invoice", { address: D.kindly, abi: K, functionName: "createInvoice", args: [refFromNumber(num.value), payer.value ? getAddress(payer.value) : zeroAddress, toUnits(amt.value), exp, memo.value] });
    const link = paymentLink(location.href.split("#")[0], id, payee.name);
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: "#3a2f2a", light: "#ffffff" } });
    out.replaceChildren(h("div", { class: "share" }, h("img", { src: qr, alt: "Payment QR code", width: 220, height: 220 }),
      h("div", {}, h("h3", {}, `${fromUnits(toUnits(amt.value))} tUSD8 · ${num.value}`),
        h("input", { value: link, readonly: true, class: "mono", onclick: (e) => e.target.select() }),
        h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => navigator.clipboard.writeText(link).then(() => toast("Link copied", "ok")) }, "Copy link"),
          h("a", { class: "btn soft", href: `#/pay/${id}?n=${encodeURIComponent(payee.name)}` }, "Open payer view")))));
    loadList();
  };
  root.append(h("div", { class: "card" }, h("h2", {}, "New invoice"),
    h("div", { class: "grid2" }, h("label", {}, "Invoice number", num), h("label", {}, "Amount (tUSD8)", amt), h("label", {}, "Bill to (optional)", payer), h("label", {}, "Expires in (hours)", hours)),
    h("label", {}, "Memo", memo), createBtn, out));
  const list = h("div", { class: "card" }, h("h2", {}, "My invoices"), h("p", { class: "muted" }, "Loading…"));
  root.append(list);
  async function loadList() {
    const logs = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoiceCreated", args: { merchant: state.account }, fromBlock: fromBlock() });
    const rows = [];
    for (const lg of logs.reverse().slice(0, 25)) {
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [lg.args.id] });
      const st = STATUS[inv.status];
      const actions = h("div", { class: "row" });
      if (st === "Open") {
        const b = h("button", { class: "btn small soft" }, "Cancel");
        b.onclick = async () => { await send(b, "Cancel", { address: D.kindly, abi: K, functionName: "cancelInvoice", args: [lg.args.id] }); loadList(); };
        actions.append(h("a", { class: "btn small ghost", href: `#/pay/${lg.args.id}?n=${encodeURIComponent(payee.name)}` }, "Link"), b);
      }
      if (st === "Paid") {
        const b = h("button", { class: "btn small soft" }, "Refund");
        b.onclick = async () => {
          const max = fromUnits(inv.amount - inv.refunded);
          const v = prompt(`Refund how much tUSD8? (max ${max})`, max);
          if (!v) return;
          await ensureAllowance(b, toUnits(v));
          await send(b, "Refund", { address: D.kindly, abi: K, functionName: "refund", args: [lg.args.id, toUnits(v)] });
          loadList();
        };
        actions.append(b);
      }
      rows.push(h("tr", {}, h("td", { class: "mono" }, short(lg.args.id)), h("td", {}, sanitizeText(lg.args.memo, 60)), h("td", {}, fromUnits(inv.amount)),
        h("td", {}, h("span", { class: `chip s-${st}` }, st), inv.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${inv.mandateId}`) : ""), h("td", {}, actions)));
    }
    list.replaceChildren(h("h2", {}, "My invoices"), rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["ID", "Memo", "tUSD8", "Status", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rows)) : h("p", { class: "muted" }, "No invoices yet."));
  }
  loadList().catch((e) => list.replaceChildren(h("p", { class: "warn" }, humanError(e))));
  return root;
}

// ------------------------------------------------------------------ Pay
async function viewPay() {
  const parsed = parsePaymentHash(location.hash);
  const root = h("section", {});
  if (!parsed) {
    const idIn = h("input", { placeholder: "0x… invoice id (or open a payment link)" });
    const nIn = h("input", { placeholder: "Merchant name you were told" });
    root.append(h("div", { class: "card" }, h("h2", {}, "Pay an invoice"), h("label", {}, "Invoice ID", idIn), h("label", {}, "Expected merchant name", nIn),
      h("button", { class: "btn", onclick: () => (location.hash = `/pay/${idIn.value.trim()}?n=${encodeURIComponent(nIn.value)}`) }, "Open invoice")));
    return root;
  }
  const { invoiceId } = parsed;
  const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [invoiceId] });
  if (STATUS[inv.status] === "None") { root.append(h("div", { class: "card" }, h("p", { class: "warn" }, "Invoice not found on this network."))); return root; }
  const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] });
  const created = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoiceCreated", args: { id: invoiceId }, fromBlock: fromBlock() }).catch(() => []);
  const memo = created[0]?.args?.memo ?? "";
  const expectedIn = h("input", { value: parsed.expectedName ?? "", placeholder: "Name the merchant gave you", maxlength: 64 });
  const copBox = h("div", {});
  const payBtn = h("button", { class: "btn big wide" }, `Pay ${fromUnits(inv.amount)} tUSD8`);
  const result = h("div", {});
  let confirmation = 0;
  async function runCoP() {
    const exp = expectedIn.value;
    confirmation = Number(await pub.readContract({ address: D.registry, abi: R, functionName: "confirm", args: [inv.merchant, nameHash(exp)] }));
    const view = {
      MatchVerified: ["ok", "✓ Name matches and is verified", `This address belongs to “${sanitizeText(payee.name, 64)}”, verified by ${short(payee.verifiedBy)}.`],
      MatchUnverified: ["amber", "Name matches, not verified yet", "The name matches the registry, but no one has verified this business. Pay only if you trust it."],
      NoMatch: ["bad", "✕ Name does NOT match", `This address is registered as “${sanitizeText(payee.name, 64)}”, not “${sanitizeText(exp, 64)}”. It could be a scam — don't pay.`],
      Unregistered: ["bad", "✕ Unknown payee", "This address is not a registered merchant."],
    }[CONFIRMATION[confirmation]];
    copBox.replaceChildren(h("div", { class: `cop ${view[0]}` }, h("strong", {}, view[1]), h("p", {}, view[2])));
    payBtn.disabled = !(confirmation >= 2) || STATUS[inv.status] !== "Open";
  }
  expectedIn.addEventListener("input", () => runCoP().catch(() => {}));
  await runCoP();
  payBtn.onclick = async () => {
    if (!state.account) await connect({ rerender: false });
    const dup = await pub.readContract({ address: D.kindly, abi: K, functionName: "settledRef", args: [keccakRefKey(state.account, inv.merchant, inv.ref)] });
    if (dup) return toast("You already paid this invoice number to this merchant. Kindly blocks duplicates.", "error");
    if (CONFIRMATION[confirmation] === "MatchUnverified" && !confirm("This merchant is not verified. Pay anyway?")) return;
    await ensureAllowance(payBtn, inv.amount);
    const { hash, result: receipt } = await send(payBtn, "Pay invoice", { address: D.kindly, abi: K, functionName: "payInvoice", args: [invoiceId, nameHash(expectedIn.value), inv.amount] });
    result.replaceChildren(h("div", { class: "cop ok" }, h("strong", {}, "Paid ✓ Thank you!"), h("p", {}, "Transaction ", txLink(hash)), h("p", { class: "mono small" }, `Receipt ${receipt}`), h("a", { class: "btn ghost", href: `#/activity?id=${invoiceId}` }, "Verify receipt")));
    payBtn.disabled = true;
  };
  const st = STATUS[inv.status];
  const expired = Date.now() / 1000 > Number(inv.expiresAt);
  root.append(h("div", { class: "card" },
    h("div", { class: "row between" }, h("h2", {}, "Invoice"), h("span", { class: `chip s-${st}` }, expired && st === "Open" ? "Expired" : st)),
    h("div", { class: "amount" }, fromUnits(inv.amount), h("small", {}, " tUSD8")),
    h("dl", {}, h("dt", {}, "To"), h("dd", {}, sanitizeText(payee.name, 64), " ", addrLink(inv.merchant)), h("dt", {}, "For"), h("dd", {}, sanitizeText(memo) || "—"),
      h("dt", {}, "Expires"), h("dd", {}, new Date(Number(inv.expiresAt) * 1000).toLocaleString()),
      inv.payer !== zeroAddress ? [h("dt", {}, "Bill to"), h("dd", {}, addrLink(inv.payer))] : null,
      st === "Paid" || st === "Refunded" ? [h("dt", {}, "Paid by"), h("dd", {}, addrLink(inv.paidBy), inv.mandateId > 0n ? ` via assistant mandate #${inv.mandateId}` : "")] : null),
    h("label", {}, "Confirmation of Payee: the name you expect", expectedIn), copBox, st === "Open" && !expired ? payBtn : null, result,
    h("p", { class: "muted small" }, "The contract re-checks the name and the amount on-chain, so a swapped link or a renamed merchant can't take your payment.")));
  return root;
}
const keccakRefKey = (payer, merchant, ref) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [payer, merchant, ref]));

// ------------------------------------------------------------------ Receipts
async function viewActivity() {
  const root = h("section", {});
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const idIn = h("input", { value: q.get("id") || "", placeholder: "Invoice ID" });
  const out = h("div", {});
  const vbtn = h("button", { class: "btn" }, "Verify receipt");
  vbtn.onclick = async () => {
    try {
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [idIn.value.trim()] });
      const ok = await pub.readContract({ address: D.kindly, abi: K, functionName: "verifyReceipt", args: [idIn.value.trim(), inv.receipt] });
      out.replaceChildren(h("div", { class: `cop ${ok ? "ok" : "bad"}` }, h("strong", {}, ok ? "✓ Receipt is valid on-chain" : "✕ No valid receipt"), h("p", { class: "mono small" }, inv.receipt),
        h("p", {}, `${fromUnits(inv.amount)} tUSD8 · ${STATUS[inv.status]} · paid by ${short(inv.paidBy)}${inv.mandateId > 0n ? ` (assistant mandate #${inv.mandateId})` : ""}`)));
    } catch (e) { out.replaceChildren(h("p", { class: "warn" }, humanError(e))); }
  };
  root.append(h("div", { class: "card" }, h("h2", {}, "Verify a receipt"), h("label", {}, "Invoice ID", idIn), vbtn, out));
  const feed = h("div", { class: "card" }, h("h2", {}, "Latest settlements"), h("p", { class: "muted" }, "Loading…"));
  root.append(feed);
  if (D.kindly) {
    const logs = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoicePaid", fromBlock: fromBlock() }).catch(() => []);
    const rows = logs.reverse().slice(0, 30).map((lg) => h("tr", {}, h("td", {}, txLink(lg.transactionHash)), h("td", {}, `${fromUnits(lg.args.amount)} tUSD8`), h("td", {}, addrLink(lg.args.merchant)),
      h("td", {}, lg.args.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${lg.args.mandateId}`) : h("span", { class: "chip" }, "direct")), h("td", { class: "mono small" }, short(lg.args.receipt))));
    feed.replaceChildren(h("h2", {}, "Latest settlements"), rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Tx", "Amount", "Merchant", "Path", "Receipt"].map((t) => h("th", {}, t)))), h("tbody", {}, rows)) : h("p", { class: "muted" }, "No payments yet."));
  }
  return root;
}

// ------------------------------------------------------------------ router
async function route() {
  const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", path.startsWith(a.getAttribute("href").slice(1))));
  $app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    let v;
    if (path.startsWith("/demo")) v = viewDemo();
    else if (path.startsWith("/control")) v = await viewControl();
    else if (path.startsWith("/merchant")) v = await viewMerchant();
    else if (path.startsWith("/pay")) v = await viewPay();
    else if (path.startsWith("/activity")) v = await viewActivity();
    else v = viewHome();
    $app.replaceChildren(v);
  } catch (e) {
    $app.replaceChildren(h("div", { class: "card" }, h("p", { class: "warn" }, humanError(e))));
  }
}
document.getElementById("connect").onclick = () => connect().catch((e) => toast(humanError(e), "error"));
window.addEventListener("hashchange", route);
if (!D.kindly) banner(`Kindly is not deployed on ${CHAIN.name} yet — read-only mode. Test tokens: ${FAUCET_URL}`);
void REASON;
refreshHeader();
setInterval(refreshHeader, 15000);
route();
