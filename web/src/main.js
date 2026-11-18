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
const state = { account: null, wallet: null, quiet: false };
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
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
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
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), kind === "error" ? 9000 : 4500);
}
function banner(msg) {
  const b = document.getElementById("banner");
  b.textContent = msg || "";
  b.classList.toggle("hidden", !msg);
}
const riskView = (risk) => h("span", { class: "risk", title: "Risk score from the contract (0–100)" }, `risk ${risk}`, h("span", { class: "meter" }, h("span", { style: `width:${Math.min(Number(risk), 100)}%` })));
const VERDICT = { PAY: "PAY", HOLD: "HOLD", REJECT: "REJECT" };
const ICON = {
  check: () => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  pause: () => svg('<path d="M9 6v12M15 6v12"/>'),
  cross: () => svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  shield: () => svg('<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
};
function svg(inner) { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.innerHTML = inner; return s; }
const stamp = (d) => h("span", { class: `stamp ${d}` }, (d === "PAY" ? ICON.check : d === "HOLD" ? ICON.pause : ICON.cross)(), VERDICT[d]);
function decisionCard(ex, extra) {
  return h("div", { class: `decision ${ex.decision}` },
    h("div", { class: "row between" }, h("span", { class: "verdict" }, ex.decision), riskView(ex.risk)),
    h("p", {}, ex.text), h("div", { class: "meta" }, h("span", { class: "chip" }, ex.reason), extra));
}
const skeleton = () => h("div", { class: "skeleton", "aria-label": "Loading" }, h("i"), h("i"), h("i"));

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
    net.textContent = `${CHAIN.id === 44005 ? "Aevum" : CHAIN.name} · #${bn}`;
    net.className = "net ok";
  } catch {
    net.textContent = "RPC unreachable";
    net.className = "net bad";
  }
  if (state.account) {
    const bal = D.token ? await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }).catch(() => 0n) : 0n;
    document.getElementById("connect").textContent = `${short(state.account)} · ${Number(fromUnits(bal)).toLocaleString(undefined, { maximumFractionDigits: 4 })} tUSD8`;
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
    if (!signer && !state.quiet) toast(`${label}: confirmed ✓`, "ok");
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
const fmt = (u) => Number(fromUnits(u)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion() ? 0 : ms));
const pageHead = (eyebrow, title, lead) => h("div", { class: "page-head" }, eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null, h("h2", {}, title), lead ? h("p", { class: "lead" }, lead) : null);
const checkItem = (label) => h("li", {}, h("span", { class: "tick" }, svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')), h("span", {}, label));

// ------------------------------------------------------------------ Trust: custody, protections, privacy (claims verified against contracts/src)
function trustModal(tab = "funds") {
  document.getElementById("trust")?.remove();
  const card = (n, t, body) => h("div", { class: "tcard" }, h("span", { class: "num" }, n), h("h3", {}, t), h("p", {}, body));
  const close = h("button", { class: "btn ghost small", "aria-label": "Close" }, "Close");
  const dlg = h("dialog", { id: "trust", class: "modal", "aria-labelledby": "trust-title" },
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Security & funds"), h("h2", { id: "trust-title" }, tab === "privacy" ? "What's visible on-chain" : "How your funds are protected")), close),
    tab === "privacy" ? privacyBody() : [
      h("p", { class: "muted" }, "Kindly doesn't give AI your wallet. It gives AI a permission to spend. Your tokens stay in your wallet until a payment settles, then move directly to the merchant."),
      h("div", { class: "tgrid" },
        card("01", "Spending limits", "Each mandate has a per-payment cap, a total budget, an expiry and an optional cooldown. The contract rejects anything over the cap or over the remaining budget."),
        card("02", "Merchant verification", "Payments only go to merchants on the mandate's allowlist. The payee's registered name is re-checked on-chain (Confirmation of Payee), so a swapped link or a look-alike name is held or reverted."),
        card("03", "Human approval", "Unusual amounts (3× your usual or more) and name mismatches are put on HOLD. Only you, the mandate owner, can approve or reject a hold. Duplicate invoice numbers are always rejected."),
        card("04", "Revoke & recover", "Freeze pauses the agent instantly. Revoke ends the mandate for good. Kindly never holds a deposit, so there is nothing to withdraw: set your token allowance to 0 and no one can pull funds through Kindly.")),
      h("details", {}, h("summary", {}, "Implemented vs. roadmap"), h("div", { class: "body grid2" },
        h("div", { class: "stack" }, h("strong", {}, "Implemented (on testnet)"), h("ul", { class: "plain" }, ["Exact, bounded token approvals from the UI", "Per-payment cap, budget, allowlist, expiry, cooldown", "PAY / HOLD / REJECT decided by the contract, with a SafetyDecision event", "Owner-only approve, reject, freeze, revoke", "Duplicate-invoice and replay protection per payer, merchant and invoice number", "On-chain receipts anyone can verify"].map((x) => h("li", {}, x)))),
        h("div", { class: "stack" }, h("strong", {}, "Roadmap"), h("ul", { class: "plain" }, ["Two-person approval for large holds", "Independent KYB attesters instead of a single testnet operator", "Hashed memos with the text kept off-chain", "Session keys and a paymaster on Aevum", "External audit before any mainnet use"].map((x) => h("li", {}, x)))))),
      h("p", { class: "small muted" }, "Testnet software. It has automated tests but no external audit. Never use it with real funds."),
    ]);
  close.onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}
function privacyBody() {
  return [
    h("p", { class: "muted" }, "Blockchains are public. Kindly does not make payments private or confidential."),
    h("div", { class: "grid2" },
      h("div", { class: "stack" }, h("strong", {}, "Public, forever"), h("ul", { class: "plain" }, ["Payer, merchant and agent addresses", "Amounts, timestamps and invoice IDs", "Invoice memos and merchant names", "Every Safety Gate decision and its reason"].map((x) => h("li", {}, x)))),
      h("div", { class: "stack" }, h("strong", {}, "Keep out of memos"), h("ul", { class: "plain" }, ["Names of people, emails, phone numbers", "Home or delivery addresses", "Health, legal or other sensitive details", "Anything you would not post publicly"].map((x) => h("li", {}, x))))),
    h("p", { class: "small muted" }, "Use a neutral memo such as “Order 1042” and keep details in your own records."),
  ];
}
const trustLink = (label, tab) => h("button", { class: "link small", type: "button", onclick: () => trustModal(tab) }, label);
const PII = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\+?\d[\s-]?){9,}|\b(street|st\.|jalan|jl\.|road|avenue|apt)\b/i;

// ------------------------------------------------------------------ Product (home)
function viewHome() {
  const card = heroCard();
  return h("section", { class: "view" },
    h("div", { class: "hero" },
      h("div", {},
        h("span", { class: "chip live ok" }, "Live on QDay Aevum Testnet"),
        h("h1", { style: "margin-top:18px" }, "Payments, handled. ", h("em", {}, "Safely.")),
        h("p", { class: "lead" }, "Your AI agent can pay invoices for you. Kindly makes sure every payment is verified, within your rules, and safe to approve."),
        h("div", { class: "cta" }, h("a", { class: "btn big", href: "#/demo" }, "Run the live demo ", h("span", { class: "arrow" }, "→")), h("a", { class: "btn ghost big", href: "#/demo?replay=1" }, "Explore the safety gate")),
        h("div", { class: "proof" }, h("span", {}, "Decided on-chain"), h("span", {}, "Exact allowances only"), h("span", {}, "Freeze or revoke in one tap"))),
      card.el),
    h("div", { class: "steps3" },
      step3("01", "Verify", "Every payee is checked against an on-chain registry. A look-alike name or a swapped link never gets paid."),
      step3("02", "Control", "You set the mandate: per-payment cap, total budget, usual amount and allowed merchants. Change it any time."),
      step3("03", "Confirm", "Routine bills pay themselves. Anything unusual waits for one tap from you. Duplicates are blocked outright.")),
    h("div", { class: "story" },
      h("span", { class: "eyebrow" }, "Why Kindly"),
      h("blockquote", {}, "Kindly doesn't give AI your wallet. ", h("span", {}, "It gives AI a permission to spend.")),
      h("p", { class: "muted", style: "max-width:640px" }, "Every invoice passes through an on-chain safety gate. Funds are governed by spending limits, verified recipients, and human approval when something looks unusual. We give AI agents financial autonomy without giving them unlimited authority."),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn ghost", onclick: () => trustModal("funds") }, "How your funds are protected ", h("span", { class: "arrow" }, "→")), trustLink("What's visible on-chain", "privacy")),
      h("p", { class: "eyebrow", style: "margin-top:18px" }, "Your money. Your rules. AI with limited authority."),
      D.kindly
        ? h("div", { class: "contracts" }, h("span", {}, "Kindly ", addrLink(D.kindly)), h("span", {}, "PayeeRegistry ", addrLink(D.registry)), h("span", {}, "tUSD8 ", addrLink(D.token)))
        : h("p", { class: "warn" }, `Contracts not deployed on ${CHAIN.name} yet.`)));
}
const step3 = (n, t, body) => h("div", {}, h("span", { class: "num" }, n), h("h3", {}, t), h("p", {}, body));

/** The floating payment card on the home page cycles PAY → HOLD → REJECT (static PAY with reduced motion). */
function heroCard() {
  const scenes = [
    { d: "PAY", amt: "24.99", num: "INV-1001", memo: "Weekly coffee beans", checks: ["pass", "pass", "pass"], text: "Paid automatically" },
    { d: "HOLD", amt: "149.00", num: "INV-1002", memo: "Espresso machine service", checks: ["pass", "pass", "flag"], text: "6× usual · waiting for you" },
    { d: "REJECT", amt: "24.99", num: "INV-1001", memo: "Sent again", checks: ["pass", "fail", "pass"], text: "Duplicate invoice · blocked" },
  ];
  const amt = h("div", { class: "amt" }, "", h("small", {}, "USD"));
  const num = h("span", { class: "mono muted" }); const memo = h("span", { class: "small muted" });
  const list = h("ul", { class: "checks" }, checkItem("Merchant verified"), checkItem("Not paid before"), checkItem("Amount matches usual spend"));
  const vtext = h("span", {}); const vstamp = h("span", {});
  const bar = h("div", { class: "verdict-bar" }, vtext, vstamp);
  const el = h("div", { class: "float-wrap", "aria-hidden": "true" }, h("div", { class: "paycard" },
    h("div", { class: "row between" }, h("div", { class: "who" }, h("span", { class: "avatar" }, "S"), h("div", { class: "stack", style: "gap:0" }, h("strong", {}, "Sunrise Coffee Co"), num)), h("span", { class: "chip ok" }, "✓ Verified")),
    h("div", { class: "stack", style: "gap:6px" }, amt, memo),
    h("div", { class: "agent-note" }, "✦ ", h("span", {}, h("b", {}, "Your agent"), " wants to pay this invoice")),
    list, bar,
    h("div", { class: "gate-tag" }, ICON.shield(), "Secured by Kindly Safety Gate")));
  let i = 0;
  async function show(s) {
    amt.firstChild.textContent = `$${s.amt}`; num.textContent = s.num; memo.textContent = s.memo;
    bar.className = "verdict-bar"; vtext.textContent = "Checking…"; vstamp.replaceChildren();
    const lis = [...list.children]; lis.forEach((li) => (li.className = ""));
    for (let k = 0; k < 3; k++) { await sleep(380); lis[k].className = s.checks[k]; }
    await sleep(320); bar.className = `verdict-bar ${s.d}`; vtext.textContent = s.text; vstamp.replaceChildren(stamp(s.d));
  }
  (async () => {
    if (reduceMotion()) return show(scenes[0]);
    while (document.body.contains(el) || i === 0) { await show(scenes[i % 3]); i++; await new Promise((r) => setTimeout(r, 2600)); if (!document.body.contains(el)) break; }
  })();
  return { el };
}

// ------------------------------------------------------------------ Demo: three invoices, three decisions
const DEMO_KEY = `kindly.demo.${CHAIN.id}`;
function demoKeys() {
  // Throwaway testnet keys for the demo café and assistant, kept only in this browser's localStorage.
  let k = JSON.parse(localStorage.getItem(DEMO_KEY) || "null");
  if (!k) { k = { merchant: generatePrivateKey(), agent: generatePrivateKey() }; localStorage.setItem(DEMO_KEY, JSON.stringify(k)); }
  const mk = (pk) => createWalletClient({ chain: CHAIN, transport: http(RPC), account: privateKeyToAccount(pk) });
  return { merchant: mk(k.merchant), agent: mk(k.agent) };
}
const DEMO_NAME = "Kindly Demo Café";
const DEMO_INVOICES = [
  { key: "a", num: "INV-1001", usd: 24.99, memo: "Weekly coffee beans", expect: "PAY", checks: ["Merchant verified", "Within spending mandate", "Amount matches usual spend"] },
  { key: "b", num: "INV-1002", usd: 149, memo: "Espresso machine service", expect: "HOLD", checks: ["Merchant verified", "Within spending mandate", "Amount matches usual spend"] },
  { key: "c", num: "INV-1001", usd: 24.99, memo: "Same invoice, sent again", expect: "REJECT", checks: ["Merchant verified", "Within spending mandate", "Not paid before"] },
];
const CHECK_RESULT = {
  PAY: ["pass", "pass", "pass"],
  AmountAnomaly: ["pass", "pass", "flag"], PayeeMismatch: ["flag", "pass", "pass"], PayeeUnverified: ["flag", "pass", "pass"],
  Duplicate: ["pass", "pass", "fail"], OverCap: ["pass", "fail", "pass"], OverBudget: ["pass", "fail", "pass"], MerchantNotAllowed: ["fail", "pass", "pass"],
  Expired: ["pass", "fail", "pass"], NotOpen: ["pass", "fail", "pass"], PayerNotAllowed: ["fail", "pass", "pass"],
};

function invoiceCard(inv) {
  const checks = h("ul", { class: "checks" }, inv.checks.map(checkItem));
  const verdict = h("span", { class: "stamp" }, "Queued");
  const why = h("p", { class: "why muted small" }, "");
  const extra = h("div", {});
  const el = h("article", { class: "inv", "aria-live": "polite" },
    h("div", { class: "head" }, h("span", { class: "num" }, inv.num), verdict),
    h("div", { class: "amt" }, `$${inv.usd.toFixed(2)}`), h("p", { class: "memo" }, inv.memo), checks, why, extra);
  return {
    el, extra,
    activate() { el.classList.add("active"); verdict.className = "stamp"; verdict.textContent = "At the gate…"; },
    async decide(ex, link) {
      const res = CHECK_RESULT[ex.decision === "PAY" ? "PAY" : ex.reason] || ["pass", "pass", "pass"];
      const lis = [...checks.children];
      for (let k = 0; k < 3; k++) { await sleep(260); lis[k].className = res[k]; }
      await sleep(200);
      el.classList.remove("active"); el.classList.add("decided", ex.decision);
      verdict.replaceWith(stamp(ex.decision));
      why.className = "why small"; why.replaceChildren(ex.text);
      if (link) extra.replaceChildren(h("div", { class: "row between small muted" }, riskView(ex.risk), link));
    },
  };
}

function viewDemo() {
  const replay = /replay=1/.test(location.hash);
  const root = h("section", { class: "view" });
  const gate = h("div", { class: "gate" }, h("span", { class: "shield" }, ICON.shield()), h("div", { class: "label" }, h("b", {}, "Kindly Safety Gate"), h("span", {}, "On-chain · decides PAY, HOLD or REJECT")), h("span", { class: "state" }, "idle"), h("span", { class: "scan" }));
  const grid = h("div", { class: "invoices" });
  let cards = [];
  const resetCards = () => { cards = DEMO_INVOICES.map(invoiceCard); grid.replaceChildren(...cards.map((c) => c.el)); grid.classList.remove("running"); };
  resetCards();
  const runBtn = h("button", { class: "btn big" }, "▶ Run 3 invoices");
  const replayBtn = h("button", { class: "btn ghost big" }, "Replay recorded run");
  const progress = h("div", { class: "progress-line" }, h("span", {}, "Uses your connected wallet on testnet. About 1 minute."));
  const summary = h("div", {});
  const steps = h("ol", { class: "timeline" });
  const exec = h("details", { class: "exec" }, h("summary", {}, "View execution details"), h("div", { class: "body" }, h("p", { class: "small muted" }, "Every real on-chain action of the run, in order. Amounts are scaled 1:1000 on testnet ($24.99 → 0.02499 tUSD8) and refunded at the end. The café and assistant use throwaway testnet keys kept in this browser."), steps));
  const setGate = (state, label) => { gate.className = `gate ${state}`; gate.querySelector(".state").textContent = label; };
  const setProgress = (busy, text) => progress.replaceChildren(...[busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, h("span", {}, text)].filter(Boolean));

  root.append(
    pageHead("Live demo", "Three invoices. Three decisions.", "Watch Kindly pay the routine invoice, pause an unusual amount for your approval, and block a duplicate, automatically."),
    h("div", { class: "stage" }, gate, grid, h("div", { class: "runbar" }, progress, h("div", { class: "row" }, replayBtn, runBtn)), summary, exec),
    recordedRunCard());

  const add = (label) => {
    const li = h("li", { class: "run" }, h("span", { class: "dot" }, ""), h("span", {}, label), h("span", { class: "small" }));
    steps.append(li);
    setProgress(true, label);
    return {
      ok: (hash, note) => { li.className = "done"; li.firstChild.textContent = "✓"; li.lastChild.replaceChildren(hash ? txLink(hash, "tx ↗") : note || ""); },
      fail: (msg) => { li.className = "err"; li.firstChild.textContent = "!"; li.lastChild.textContent = msg; },
    };
  };
  const step = async (label, fn) => {
    const s = add(label);
    try { const r = await fn(); s.ok(r?.hash, r?.note); return r; } catch (e) { s.fail(humanError(e)); throw e; }
  };
  const showSummary = (tally) => summary.replaceChildren(h("div", { class: "summary" },
    h("span", { class: "eyebrow" }, "Result"),
    h("div", { class: "tagline" }, "Autonomy, with boundaries."),
    h("div", { class: "tally" }, tally.map(([d, t]) => h("span", { class: `chip ${d}` }, t)))));

  replayBtn.onclick = async () => {
    const run = recordedRuns[aevumTestnet.id];
    if (!run?.decisions?.length) return toast("No recorded run available.", "error");
    runBtn.disabled = replayBtn.disabled = true; summary.replaceChildren(); resetCards(); grid.classList.add("running");
    try {
      for (let i = 0; i < 3; i++) {
        const d = run.decisions[i];
        cards[i].activate(); setGate("busy", `scanning ${DEMO_INVOICES[i].num}`); setProgress(true, `Replaying ${d.invoice} from the recorded Aevum run`);
        await sleep(1300);
        const link = d.explorer ? h("a", { href: d.explorer, target: "_blank", rel: "noopener", class: "mono" }, "Aevum tx ↗") : null;
        setGate(d.decision, d.decision);
        await cards[i].decide({ decision: d.decision, reason: d.reason, risk: d.risk, text: d.explanation }, link);
        if (d.decision === "HOLD") { cards[i].extra.append(h("div", { class: "approve", style: "margin-top:10px" }, h("strong", {}, "Approval required"), h("span", { class: "small" }, "In the recorded run, the owner approved this once."))); await sleep(1400); }
        await sleep(700);
      }
      setGate("", "done"); setProgress(false, `Replay of the recorded on-chain run (${new Date(run.finishedAt).toLocaleString()}). Every decision links to its Aevum transaction.`);
      showSummary([["PAY", "1 paid automatically"], ["HOLD", "1 approved by a human"], ["REJECT", "1 duplicate blocked"]]);
    } finally { runBtn.disabled = replayBtn.disabled = false; }
  };

  runBtn.onclick = async () => {
    try {
      if (!state.account) await connect({ rerender: false });
      requireWallet();
      runBtn.disabled = replayBtn.disabled = true; state.quiet = true;
      steps.replaceChildren(); summary.replaceChildren(); resetCards(); grid.classList.add("running"); setGate("busy", "preparing");
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
      const { result: mandateId } = await step("You give your assistant a mandate: cap $200, budget $500, usual $25, café only", () => send(null, "Create mandate", {
        address: D.kindly, abi: K, functionName: "createMandate",
        args: [{ agent: agent.account.address, perPaymentCap: usdToUnits(200), totalBudget: usdToUnits(500), typicalAmount: usdToUnits(25), validUntil, cooldown: 0, anyMerchant: false, requireVerifiedPayee: false, merchants: [merchant.account.address] }],
      }));
      const exp = BigInt(Math.floor(Date.now() / 1000) + 86400);
      const issue = (num, usd, memo) => step(`Café sends ${num} for $${usd}`, () => send(null, "Invoice", { address: D.kindly, abi: K, functionName: "createInvoice", args: [refFromNumber(`${num}-${run}`), state.account, usdToUnits(usd), exp, memo] }, merchant));
      const gate1 = async (i, invoiceId) => {
        const label = `${DEMO_INVOICES[i].num} ($${DEMO_INVOICES[i].usd})`;
        cards[i].activate(); setGate("busy", `scanning ${DEMO_INVOICES[i].num}`);
        const r = await step(`Assistant submits ${label} to the Safety Gate`, () => send(null, "Gate", { address: D.kindly, abi: K, functionName: "agentProcess", args: [mandateId, invoiceId, nameHash(DEMO_NAME)] }, agent));
        const ev = parseEventLogs({ abi: K, eventName: "SafetyDecision", logs: r.receipt.logs })[0].args;
        const ex = explainDecision({ decision: ev.decision, reason: ev.reason, risk: ev.risk, amount: ev.amount, usual: ev.usualAmount, merchantName: DEMO_NAME, cap: usdToUnits(200) });
        setGate(ex.decision, ex.decision);
        await cards[i].decide(ex, txLink(r.hash, "decision tx ↗"));
        return { ex, hash: r.hash };
      };
      const a = (await issue("INV-1001", 24.99, "Weekly coffee beans")).result;
      await gate1(0, a);
      const b = (await issue("INV-1002", 149, "Espresso machine service")).result;
      const gb = await gate1(1, b);
      let held = "1 rejected by you";
      if (gb.ex.decision === "HOLD") {
        setProgress(false, "Your assistant is waiting for you.");
        await new Promise((resolve, reject) => {
          const ok = h("button", { class: "btn ok small" }, "Approve once");
          const no = h("button", { class: "btn danger small" }, "Reject");
          const box = h("div", { class: "approve", style: "margin-top:10px" }, h("strong", {}, "Approval required"), h("span", { class: "small" }, "$149 is 6× your usual spend with this café."), h("div", { class: "row" }, ok, no));
          cards[1].extra.append(box);
          ok.onclick = async () => {
            try { await step("You approve the held $149 invoice (explicit approval tx)", () => send(ok, "Approve hold", { address: D.kindly, abi: K, functionName: "approveHold", args: [b, nameHash(DEMO_NAME)] })); box.remove(); held = "1 approved by you"; resolve(); } catch (e) { reject(e); }
          };
          no.onclick = async () => {
            try { await step("You reject the held invoice", () => send(no, "Reject hold", { address: D.kindly, abi: K, functionName: "rejectHold", args: [b] })); box.remove(); resolve(); } catch (e) { reject(e); }
          };
        });
      }
      const c = (await issue("INV-1001", 24.99, "Weekly coffee beans")).result;
      await gate1(2, c);
      // give the tokens back so the demo is repeatable on a one-time faucet claim
      const paid = [];
      for (const id of [a, b]) { const i = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] }); if (STATUS[i.status] === "Paid") paid.push([id, i.amount]); }
      const total = paid.reduce((s, [, amt]) => s + amt, 0n);
      if (total > 0n) {
        await step("Café approves the refund", () => send(null, "Approve", { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, total] }, merchant));
        for (const [id, amt] of paid) await step(`Café refunds ${fromUnits(amt)} tUSD8 to you`, () => send(null, "Refund", { address: D.kindly, abi: K, functionName: "refund", args: [id, amt] }, merchant));
      }
      await step("Café cancels the duplicate invoice", () => send(null, "Cancel", { address: D.kindly, abi: K, functionName: "cancelInvoice", args: [c] }, merchant));
      setGate("", "done"); setProgress(false, "Demo complete. Test tokens were refunded. Open Controls to see the mandate.");
      showSummary([["PAY", "1 paid automatically"], ["HOLD", held], ["REJECT", "1 duplicate blocked"]]);
    } catch (e) {
      setGate("REJECT", "stopped"); setProgress(false, `Demo stopped: ${humanError(e)}`);
      toast(`Demo stopped: ${humanError(e)}`, "error");
    } finally {
      runBtn.disabled = replayBtn.disabled = false; state.quiet = false;
    }
  };
  if (replay) setTimeout(() => replayBtn.click(), 400);
  return root;
}
function recordedRunCard() {
  const run = recordedRuns[CHAIN.id];
  if (!run?.decisions?.length) return h("div", {});
  return h("div", { class: "card" },
    h("div", { class: "row between" }, h("h3", {}, `Last recorded run on ${CHAIN.id === 44005 ? "Aevum" : CHAIN.name}`), h("span", { class: "mono muted" }, new Date(run.finishedAt).toLocaleString())),
    h("p", { class: "muted small" }, "Recorded by scripts/e2e.mjs. Every decision is a real SafetyDecision event. Click through to the explorer."),
    h("div", { class: "grid2" }, run.decisions.map((d) => decisionCard({ decision: d.decision, reason: d.reason, risk: d.risk, text: d.explanation }, [h("span", {}, d.invoice), txLink(d.hash, "tx ↗")]))));
}

// ------------------------------------------------------------------ Controls ("Agent permissions")
async function viewControl() {
  const root = h("section", { class: "view" });
  root.append(pageHead("Controls", "Agent permissions", "What your AI assistant may pay, how much, and to whom. Changes apply on-chain immediately."));
  if (!state.account) {
    root.append(h("div", { class: "card panel" }, h("p", { class: "muted" }, "Connect your wallet to see and manage your assistant's mandates."), h("button", { class: "btn dark", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, "Connect wallet")));
    return root;
  }
  requireWallet();
  const live = h("span", { class: "chip live ok" }, "Live");
  const holds = h("div", {}, skeleton());
  const list = h("div", { class: "stack", style: "gap:16px" }, skeleton());
  const recent = h("ul", { class: "activity" });
  const more = h("div", { class: "stack" });
  root.firstChild.prepend(h("div", { class: "row" }, live));
  const funds = h("div", { class: "card panel funds" }, skeleton());
  root.append(holds, funds, list,
    h("div", { class: "card" }, h("div", { class: "row between" }, h("h3", {}, "Recent activity"), h("span", { class: "muted small" }, "Safety Gate decisions")), recent,
      h("details", {}, h("summary", {}, "All activity →"), h("div", { class: "body" }, more))),
    h("details", { class: "card" }, h("summary", {}, "Create a new mandate"), h("div", { class: "body" }, newMandateCard())));

  async function load() {
    const created = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "MandateCreated", args: { owner: state.account }, fromBlock: fromBlock() });
    const ids = created.map((l) => l.args.id).reverse();
    const cards = [];
    const ms = [];
    for (const [i, id] of ids.slice(0, 12).entries()) { cards.push(await mandateCard(id, load, i === 0)); ms.push([id, await pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] }), await pub.readContract({ address: D.kindly, abi: K, functionName: "mandateRemaining", args: [id] })]); }
    funds.replaceChildren(...(await fundsPanel(ms, load)).childNodes);
    list.replaceChildren(...(cards.length ? cards : [h("div", { class: "card" }, h("p", { class: "muted" }, "No mandates yet. Create one below, or run the demo."))]));
    const decs = [];
    for (const id of ids.slice(0, 12)) decs.push(...(await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "SafetyDecision", args: { mandateId: id }, fromBlock: fromBlock() })));
    decs.sort((x, y) => Number(y.blockNumber - x.blockNumber));
    const item = (ev) => { const ex = explainDecision({ ...ev.args, usual: ev.args.usualAmount }); return h("li", {}, stamp(ex.decision), h("span", {}, `${fmt(ev.args.amount)} tUSD8 · mandate #${ev.args.mandateId} · `, h("span", { class: "muted" }, ex.reason)), txLink(ev.transactionHash, "tx ↗")); };
    recent.replaceChildren(...(decs.length ? decs.slice(0, 3).map(item) : [h("li", {}, h("span", { class: "muted" }, "No decisions yet."))]));
    more.replaceChildren(...decs.slice(3, 30).map((ev) => decisionCard(explainDecision({ ...ev.args, usual: ev.args.usualAmount }), [h("span", {}, `mandate #${ev.args.mandateId} · ${fmt(ev.args.amount)} tUSD8`), txLink(ev.transactionHash, "tx ↗")])));
    if (!more.children.length) more.append(h("p", { class: "muted small" }, "Nothing older."));
    const pending = [];
    for (const ev of decs.filter((x) => DECISION[x.args.decision] === "HOLD")) {
      const hold = await pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [ev.args.invoiceId] });
      if (!hold.active) continue;
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [ev.args.invoiceId] });
      const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] });
      const ex = explainDecision({ ...ev.args, usual: ev.args.usualAmount, merchantName: payee.name });
      const ok = h("button", { class: "btn ok" }, "Approve once");
      ok.onclick = async () => { await ensureAllowance(ok, inv.amount); await send(ok, "Approve hold", { address: D.kindly, abi: K, functionName: "approveHold", args: [ev.args.invoiceId, nameHash(payee.name)] }); load(); };
      const no = h("button", { class: "btn danger" }, "Reject");
      no.onclick = async () => { await send(no, "Reject hold", { address: D.kindly, abi: K, functionName: "rejectHold", args: [ev.args.invoiceId] }); load(); };
      pending.push(h("div", { class: "stack", style: "gap:10px" },
        h("div", { class: "row between" }, h("strong", {}, `${fmt(inv.amount)} tUSD8 to “${sanitizeText(payee.name, 40)}”`), riskView(ev.args.risk)),
        h("p", {}, ex.text),
        ex.reason === "PayeeMismatch" ? h("p", { class: "small" }, `Approving confirms the registered name “${sanitizeText(payee.name, 64)}”.`) : null,
        h("div", { class: "row" }, ok, no)));
    }
    holds.replaceChildren(pending.length
      ? h("div", { class: "attn" }, h("h3", {}, `Approval required${pending.length > 1 ? ` · ${pending.length}` : ""}`), ...pending.flatMap((p, i) => (i ? [h("hr", { class: "sep" }), p] : [p])))
      : h("div", { class: "calm" }, "✓ Nothing is waiting for your approval."));
  }
  await load();
  const timer = setInterval(() => { if (!document.body.contains(live)) return clearInterval(timer); if (!document.querySelector("#app input:focus, #app details.drawer[open]")) load().catch(() => {}); }, 12000);
  return root;
}

async function fundsPanel(ms, reload) {
  const [bal, allowance] = await Promise.all([
    pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }),
    pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] }),
  ]);
  const live = ms.filter(([, m]) => mandateStatus(m) === "Active");
  const primary = live[0] || ms[0];
  const budget = live.reduce((s, [, , r]) => s + r, 0n);
  const zero = h("button", { class: "btn danger small" }, "Set allowance to 0");
  zero.onclick = async () => { if (!confirm("Set your tUSD8 allowance for Kindly to 0? No payment can be pulled through Kindly until you approve again.")) return; await send(zero, "Allowance to 0", { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, 0n] }); reload(); };
  const revokeLink = h("button", { class: "link" }, "Revoke access →");
  revokeLink.onclick = () => { const d = document.querySelector(".mandate:not(.revoked):not(.expired) details.drawer"); if (d) { d.open = true; d.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" }); } else toast("No live mandate to revoke.", "info"); };
  const perm = (ok, t) => h("li", { class: ok ? "yes" : "no" }, h("span", { class: "pm" }, ok ? "✓" : "✕"), t);
  const pm = primary?.[1];
  return h("div", {},
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("h3", {}, "Funds & permissions"), h("span", { class: "muted small" }, "Know exactly what your agent can access.")), trustLink("How your funds are protected →", "funds")),
    h("div", { class: "fund-grid" },
      h("div", {}, h("small", {}, "In your wallet"), h("b", {}, `${fmt(bal)} tUSD8`), h("span", { class: "small muted" }, "Kindly never holds a deposit")),
      h("div", {}, h("small", {}, "Agent spending budget"), h("b", {}, `${fmt(budget)} tUSD8`), h("span", { class: "small muted" }, `left across ${live.length} active mandate${live.length === 1 ? "" : "s"}`)),
      h("div", {}, h("small", {}, "Per-payment limit"), h("b", {}, pm ? `${fmt(pm.perPaymentCap)} tUSD8` : "—"), h("span", { class: "small muted" }, primary ? `mandate #${primary[0]}` : "no mandate yet")),
      h("div", {}, h("small", {}, "Kindly may pull at most"), h("b", {}, `${fmt(allowance)} tUSD8`), h("span", { class: "small muted" }, "your exact ERC-20 allowance"))),
    h("div", { class: "split" },
      h("ul", { class: "perms" },
        perm(true, "Can pay merchants on its allowlist"), perm(true, "Cannot exceed its per-payment cap or budget"), perm(true, "Duplicate invoices are blocked"), perm(true, "Unusual payments require your approval"),
        perm(false, "Cannot change its limits, approve holds or top up its budget"), perm(false, "Never gets a token allowance or your keys")),
      h("div", { class: "stack", style: "gap:10px" },
        h("div", { class: "row" }, h("small", { class: "muted" }, "Agent status"), pm ? h("span", { class: `chip ${mandateStatus(pm) === "Active" ? "ok live" : mandateStatus(pm) === "Frozen" ? "sky" : "bad"}` }, mandateStatus(pm)) : h("span", { class: "chip" }, "None"), pm ? h("span", { class: "small muted" }, `expires ${new Date(Number(pm.validUntil) * 1000).toLocaleString()}`) : null),
        h("div", { class: "recovery" }, h("strong", {}, "Recovery path"), h("ol", {}, h("li", {}, "Freeze the mandate: the agent stops at once."), h("li", {}, "Revoke it: permanent, can't be undone."), h("li", {}, "Set your allowance to 0: nothing can be pulled through Kindly. Your funds never left your wallet.")), h("div", { class: "row" }, revokeLink, zero)))));
}

async function mandateCard(id, reload, primary) {
  const m = await pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] });
  const remaining = await pub.readContract({ address: D.kindly, abi: K, functionName: "mandateRemaining", args: [id] });
  const st = mandateStatus(m);
  const pct = Number((m.spent * 100n) / (m.totalBudget || 1n));
  const live = st === "Active" || st === "Frozen";
  const cap = h("input", { type: "number", min: "0", step: "0.000001", value: fromUnits(m.perPaymentCap) });
  const budget = h("input", { type: "number", min: "0", step: "0.000001", value: fromUnits(m.totalBudget) });
  const usual = h("input", { type: "number", min: "0", step: "0.000001", value: fromUnits(m.typicalAmount) });
  const hours = h("input", { type: "number", min: "1", value: String(Math.max(1, Math.round((Number(m.validUntil) - Date.now() / 1000) / 3600))) });
  const cooldown = h("input", { type: "number", min: "0", value: String(m.cooldown / 60) });
  const anyM = h("input", { type: "checkbox", checked: m.anyMerchant });
  const verified = h("input", { type: "checkbox", checked: m.requireVerifiedPayee });
  const save = h("button", { class: "btn dark small" }, "Save limits");
  save.onclick = async () => {
    const vals = [cap, budget, usual, hours, cooldown].map((x) => Number(x.value));
    if (vals.some((v) => !Number.isFinite(v) || v < 0) || !(Number(cap.value) > 0) || !(Number(budget.value) > 0) || !(Number(hours.value) >= 1)) return toast("Limits must be positive numbers.", "error");
    await send(save, "Update limits", { address: D.kindly, abi: K, functionName: "updateMandate", args: [id, toUnits(cap.value), toUnits(budget.value), toUnits(usual.value || "0"), BigInt(Math.floor(Date.now() / 1000) + Math.floor(Number(hours.value)) * 3600), Math.floor(Number(cooldown.value)) * 60, anyM.checked, verified.checked] });
    reload();
  };
  const freeze = h("button", { class: "btn ghost small" }, m.frozen ? "▶ Unfreeze" : "❄ Freeze");
  freeze.onclick = async () => {
    if (!m.frozen && !confirm(`Freeze mandate #${id}? Your assistant can't pay anything until you unfreeze it.`)) return;
    await send(freeze, m.frozen ? "Unfreeze" : "Freeze", { address: D.kindly, abi: K, functionName: "setFrozen", args: [id, !m.frozen] }); reload();
  };
  const revoke = h("button", { class: "btn danger small" }, "Revoke forever");
  revoke.onclick = async () => { if (!confirm(`Revoke mandate #${id} permanently? This can't be undone.`)) return; await send(revoke, "Revoke", { address: D.kindly, abi: K, functionName: "revokeMandate", args: [id] }); reload(); };
  const merchantIn = h("input", { placeholder: "0x… merchant address", class: "mono", maxlength: 42 });
  const allow = h("button", { class: "btn ghost small" }, "Allow");
  const disallow = h("button", { class: "btn soft small" }, "Remove");
  const setM = (b, v) => async () => { if (!isAddress(merchantIn.value.trim())) return toast("Enter a valid merchant address", "error"); await send(b, v ? "Allow merchant" : "Remove merchant", { address: D.kindly, abi: K, functionName: "setMandateMerchant", args: [id, getAddress(merchantIn.value.trim()), v] }); toast(v ? "Merchant allowed" : "Merchant removed", "ok"); };
  allow.onclick = setM(allow, true); disallow.onclick = setM(disallow, false);
  const chipCls = st === "Active" ? "ok live" : st === "Frozen" ? "sky" : "bad";
  return h("div", { class: `card panel mandate ${st.toLowerCase()}` },
    h("div", { class: "row between" }, h("div", { class: "row" }, h("h3", {}, `Mandate #${id}`), h("span", { class: `chip ${chipCls}` }, st)), h("span", { class: "small muted" }, "assistant ", addrLink(m.agent))),
    h("div", { class: "mandate-hero" },
      h("div", { class: "stack" }, h("small", { class: "muted" }, st === "Frozen" ? "Remaining budget · paused" : "Remaining budget"), h("div", { class: "remaining" }, fmt(st === "Frozen" ? (m.totalBudget > m.spent ? m.totalBudget - m.spent : 0n) : remaining), h("small", {}, `of ${fmt(m.totalBudget)} tUSD8`)), h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(Math.min(pct, 100)), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Budget used" }, h("span", { style: `width:${Math.min(pct, 100)}%` }))),
      h("div", { class: "facts" },
        h("div", {}, h("small", {}, "Per payment"), h("b", {}, `${fmt(m.perPaymentCap)} tUSD8`)),
        h("div", {}, h("small", {}, "Usual amount"), h("b", {}, `${fmt(m.typicalAmount)} tUSD8`)),
        h("div", {}, h("small", {}, "Paid so far"), h("b", {}, `${m.payments} × · ${fmt(m.spent)}`)),
        h("div", {}, h("small", {}, "Valid until"), h("b", {}, new Date(Number(m.validUntil) * 1000).toLocaleDateString())))),
    live ? h("div", { class: "row" }, freeze) : h("p", { class: "small muted" }, "This mandate can no longer spend."),
    live ? h("details", { class: "drawer", open: primary && false },
      h("summary", {}, "Edit limits & merchants"),
      h("div", { class: "body stack", style: "gap:14px" },
        h("div", { class: "grid2" }, h("label", {}, "Per-payment cap (tUSD8)", cap), h("label", {}, "Total budget (tUSD8)", budget), h("label", {}, "Usual amount (baseline)", usual), h("label", {}, "Valid for (hours)", hours), h("label", {}, "Cooldown (minutes)", cooldown)),
        h("div", { class: "row" }, h("label", { class: "check" }, anyM, "Any merchant"), h("label", { class: "check" }, verified, "Verified payees only")),
        h("div", { class: "row" }, save),
        h("hr", { class: "sep" }),
        h("label", {}, "Allowed merchants", merchantIn), h("div", { class: "row" }, allow, disallow),
        h("div", { class: "danger-zone" }, h("div", {}, h("strong", {}, "Danger zone"), h("p", { class: "small muted" }, "Revoking ends this mandate permanently.")), revoke))) : null);
}

function newMandateCard() {
  const agentIn = h("input", { placeholder: "0x… assistant address", class: "mono", maxlength: 42 });
  const merchants = h("input", { placeholder: "0x…, 0x… (comma separated)", class: "mono" });
  const cap = h("input", { type: "number", min: "0", step: "0.000001", value: "0.2" });
  const budget = h("input", { type: "number", min: "0", step: "0.000001", value: "0.5" });
  const usual = h("input", { type: "number", min: "0", step: "0.000001", value: "0.025" });
  const days = h("input", { type: "number", min: "1", value: "7" });
  const cooldown = h("input", { type: "number", min: "0", value: "0" });
  const anyM = h("input", { type: "checkbox" });
  const verified = h("input", { type: "checkbox", checked: true });
  const btn = h("button", { class: "btn dark" }, "Create mandate & approve budget");
  btn.onclick = async () => {
    if (!isAddress(agentIn.value.trim())) return toast("Assistant address is invalid", "error");
    const list = merchants.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.some((a) => !isAddress(a))) return toast("A merchant address is invalid", "error");
    if (!anyM.checked && !list.length) return toast("Add at least one merchant, or tick “Any merchant”", "error");
    if (!(Number(cap.value) > 0) || !(Number(budget.value) > 0) || !(Number(days.value) >= 1) || Number(usual.value) < 0 || Number(cooldown.value) < 0) return toast("Limits must be positive numbers.", "error");
    const b = toUnits(budget.value);
    await send(btn, "Create mandate", { address: D.kindly, abi: K, functionName: "createMandate", args: [{
      agent: getAddress(agentIn.value.trim()), perPaymentCap: toUnits(cap.value), totalBudget: b, typicalAmount: toUnits(usual.value || "0"),
      validUntil: BigInt(Math.floor(Date.now() / 1000) + Math.floor(Number(days.value)) * 86400), cooldown: Math.floor(Number(cooldown.value)) * 60,
      anyMerchant: anyM.checked, requireVerifiedPayee: verified.checked, merchants: list.map(getAddress),
    }] });
    await ensureAllowance(btn, b);
    route();
  };
  return h("div", { class: "stack", style: "gap:14px" },
    h("p", { class: "muted small" }, "Your assistant never holds your money. Kindly pulls exactly the invoice amount, only when the Safety Gate says PAY or you approve a HOLD."),
    h("div", { class: "grid2" }, h("label", {}, "Assistant address", agentIn), h("label", {}, "Allowed merchants", merchants), h("label", {}, "Per-payment cap (tUSD8)", cap), h("label", {}, "Total budget (tUSD8)", budget),
      h("label", {}, "Usual amount (tUSD8)", usual), h("label", {}, "Valid for (days)", days), h("label", {}, "Cooldown (minutes)", cooldown)),
    h("div", { class: "row" }, h("label", { class: "check" }, anyM, "Any merchant"), h("label", { class: "check" }, verified, "Verified payees only")), btn);
}

// ------------------------------------------------------------------ Invoices: Send · Pay · Receipts
const invoiceTabs = (active) => h("nav", { class: "tabs", "aria-label": "Invoices" },
  [["send", "#/merchant", "Send"], ["pay", "#/pay", "Pay"], ["receipts", "#/activity", "Receipts"]].map(([k, href, t]) => h("a", { href, class: k === active ? "active" : "", "aria-current": k === active ? "page" : null }, t)));
function invoicesShell(active, title, lead) {
  return h("section", { class: "view" }, pageHead("Invoices", title, lead), invoiceTabs(active));
}

async function viewMerchant() {
  const root = invoicesShell("send", "Get paid by link or QR", "Create a stablecoin invoice. Payers see your verified name before they pay.");
  if (!state.account) { root.append(h("div", { class: "card panel" }, h("p", { class: "muted" }, "Connect your wallet to send invoices."), h("button", { class: "btn dark", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, "Connect wallet"))); return root; }
  requireWallet();
  const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [state.account] });
  const verified = await pub.readContract({ address: D.registry, abi: R, functionName: "isVerified", args: [state.account] });
  const nameIn = h("input", { value: payee.name || "", maxlength: 64, placeholder: "Your business name" });
  const uriIn = h("input", { value: payee.metadataURI || "", maxlength: 256, placeholder: "https://… (optional)" });
  const regBtn = h("button", { class: "btn dark" }, payee.active ? "Update profile" : "Register as merchant");
  regBtn.onclick = async () => {
    const name = nameIn.value.trim();
    if (!name) return toast("Enter your business name", "error");
    if (uriIn.value.trim() && !/^https:\/\//i.test(uriIn.value.trim())) return toast("Profile URL must start with https://", "error");
    if (payee.active && name !== payee.name && !confirm("Changing your name removes your verified badge until it is re-verified. Continue?")) return;
    await send(regBtn, "Register", { address: D.registry, abi: R, functionName: "register", args: [name, uriIn.value.trim()] });
    route();
  };
  const profileForm = h("div", { class: "stack", style: "gap:12px" }, h("label", {}, "Business name", nameIn), h("label", {}, "Profile URL", uriIn), regBtn,
    h("p", { class: "muted small" }, "On testnet, the Kindly operator verifies names. In production this would be a KYB partner or marketplace."));
  const name = sanitizeText(payee.name || "", 64);
  root.append(h("div", { class: "card panel" },
    payee.active
      ? h("div", { class: "row between" }, h("div", { class: "merchant-head" }, h("span", { class: "avatar" }, (name[0] || "?").toUpperCase()), h("div", { class: "stack", style: "gap:2px" }, h("h3", {}, name), h("span", { class: "small muted" }, addrLink(state.account)))),
          h("span", { class: `chip ${verified ? "ok" : "amber"}` }, verified ? "✓ Verified merchant" : "Awaiting verification"))
      : h("h3", {}, "Register your business"),
    payee.active ? h("details", {}, h("summary", {}, "Edit profile"), h("div", { class: "body" }, profileForm)) : profileForm));
  if (!payee.active) return root;

  const num = h("input", { class: "mono", maxlength: 31, value: `INV-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 900 + 100)}` });
  const amt = h("input", { type: "number", min: "0.000001", step: "0.000001", placeholder: "0.00", inputmode: "decimal", "aria-label": "Amount in tUSD8" });
  const payer = h("input", { placeholder: "0x… (optional, empty means anyone)", class: "mono", maxlength: 42 });
  const hours = h("input", { type: "number", min: "1", max: "8760", value: "24" });
  const memo = h("input", { maxlength: 280, placeholder: "e.g. Order 1042" });
  const out = h("div", { class: "share" }, h("p", { class: "muted small" }, "Your payment link and QR code will appear here."));
  const createBtn = h("button", { class: "btn big wide" }, "Create invoice");
  createBtn.onclick = async () => {
    if (!(Number(amt.value) > 0) || !/^\d+(\.\d{1,6})?$/.test(amt.value.trim())) return toast("Enter an amount with at most 6 decimals", "error");
    if (payer.value.trim() && !isAddress(payer.value.trim())) return toast("Payer must be a valid address", "error");
    if (!num.value.trim()) return toast("Enter an invoice number", "error");
    if (PII.test(memo.value) && !confirm("The memo looks like it contains personal data (an email, phone number or address). Memos are public on-chain forever. Create the invoice anyway?")) return;
    const exp = BigInt(Math.floor(Date.now() / 1000) + Math.min(8760, Math.max(1, Math.floor(Number(hours.value) || 24))) * 3600);
    const { result: id } = await send(createBtn, "Create invoice", { address: D.kindly, abi: K, functionName: "createInvoice", args: [refFromNumber(num.value.trim()), payer.value.trim() ? getAddress(payer.value.trim()) : zeroAddress, toUnits(amt.value.trim()), exp, sanitizeText(memo.value, 280)] });
    const link = paymentLink(location.href.split("#")[0], id, payee.name);
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: "#302E2B", light: "#ffffff" } });
    out.replaceChildren(
      h("span", { class: "chip ok" }, "✓ Invoice created"),
      h("img", { src: qr, alt: "Payment QR code", width: 220, height: 220 }),
      h("div", { class: "amt" }, `${fmt(toUnits(amt.value.trim()))} tUSD8`), h("span", { class: "mono muted" }, num.value.trim()),
      h("input", { value: link, readonly: true, class: "mono", "aria-label": "Payment link", onclick: (e) => e.target.select() }),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn dark", onclick: () => navigator.clipboard.writeText(link).then(() => toast("Link copied", "ok")) }, "Copy payment link ", h("span", { class: "arrow" }, "→")),
        h("a", { class: "btn ghost", href: `#/pay/${id}?n=${encodeURIComponent(payee.name)}` }, "Open payer view")));
    loadList();
  };
  root.append(h("div", { class: "split" },
    h("div", { class: "card panel" }, h("h3", {}, "Create invoice"),
      h("div", { class: "amount-field" }, amt, h("span", {}, "tUSD8")),
      h("label", {}, "What is this for?", memo, h("span", { class: "hint" }, "Public on-chain. Keep names, emails, phones and addresses out. ", trustLink("What's visible?", "privacy"))), h("label", {}, "Invoice number", num),
      h("details", {}, h("summary", {}, "More options"), h("div", { class: "body grid2" }, h("label", {}, "Bill to (optional)", payer), h("label", {}, "Expires in (hours)", hours))),
      createBtn),
    out));
  const list = h("div", { class: "card" }, h("h3", {}, "My invoices"), skeleton());
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
        b.onclick = async () => { if (!confirm("Cancel this invoice?")) return; await send(b, "Cancel", { address: D.kindly, abi: K, functionName: "cancelInvoice", args: [lg.args.id] }); loadList(); };
        actions.append(h("a", { class: "btn small ghost", href: `#/pay/${lg.args.id}?n=${encodeURIComponent(payee.name)}` }, "Link"), b);
      }
      if (st === "Paid") {
        const b = h("button", { class: "btn small soft" }, "Refund");
        b.onclick = async () => {
          const max = fromUnits(inv.amount - inv.refunded);
          const v = prompt(`Refund how much tUSD8? (max ${max})`, max);
          if (!v) return;
          if (!/^\d+(\.\d{1,6})?$/.test(v.trim()) || !(Number(v) > 0) || toUnits(v.trim()) > inv.amount - inv.refunded) return toast(`Enter an amount between 0 and ${max}`, "error");
          await ensureAllowance(b, toUnits(v.trim()));
          await send(b, "Refund", { address: D.kindly, abi: K, functionName: "refund", args: [lg.args.id, toUnits(v.trim())] });
          loadList();
        };
        actions.append(b);
      }
      rows.push(h("tr", {}, h("td", { class: "mono" }, short(lg.args.id)), h("td", {}, sanitizeText(lg.args.memo, 60)), h("td", {}, fmt(inv.amount)),
        h("td", {}, h("span", { class: `chip s-${st}` }, st), " ", inv.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${inv.mandateId}`) : ""), h("td", {}, actions)));
    }
    list.replaceChildren(h("h3", {}, "My invoices"), rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["ID", "Memo", "tUSD8", "Status", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rows))) : h("p", { class: "muted" }, "No invoices yet."));
  }
  loadList().catch((e) => list.replaceChildren(h("p", { class: "warn" }, humanError(e))));
  return root;
}

async function viewPay() {
  const parsed = parsePaymentHash(location.hash);
  if (!parsed) {
    const root = invoicesShell("pay", "Pay an invoice", "Open a payment link, or paste an invoice ID and the merchant name you were given.");
    const idIn = h("input", { placeholder: "0x… invoice id", class: "mono", maxlength: 66 });
    const nIn = h("input", { placeholder: "Merchant name you were told", maxlength: 64 });
    root.append(h("div", { class: "card panel request" }, h("label", {}, "Invoice ID", idIn), h("label", {}, "Expected merchant name", nIn),
      h("button", { class: "btn big wide", onclick: () => { const id = idIn.value.trim(); if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return toast("Invoice ID must be 0x followed by 64 hex characters", "error"); location.hash = `/pay/${id}?n=${encodeURIComponent(nIn.value.trim())}`; } }, "Open invoice")));
    return root;
  }
  const root = invoicesShell("pay", "Payment request", null);
  const { invoiceId } = parsed;
  const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [invoiceId] });
  if (STATUS[inv.status] === "None") { root.append(h("div", { class: "card" }, h("p", { class: "warn" }, "Invoice not found on this network."))); return root; }
  const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] });
  const created = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoiceCreated", args: { id: invoiceId }, fromBlock: fromBlock() }).catch(() => []);
  const memo = created[0]?.args?.memo ?? "";
  const expectedIn = h("input", { value: parsed.expectedName ?? "", placeholder: "Name the merchant gave you", maxlength: 64 });
  const payto = h("div", { class: "payto" });
  const payBtn = h("button", { class: "btn big wide" }, `Pay ${fmt(inv.amount)} tUSD8`);
  const card = h("div", { class: "card request" });
  let confirmation = 0;
  async function runCoP() {
    const exp = expectedIn.value;
    confirmation = Number(await pub.readContract({ address: D.registry, abi: R, functionName: "confirm", args: [inv.merchant, nameHash(exp)] }));
    const view = {
      MatchVerified: ["ok", "✓ Verified merchant", "The wallet name matches this merchant."],
      MatchUnverified: ["amber", "Name matches, not verified yet", "No one has verified this business. Pay only if you trust it."],
      NoMatch: ["bad", "✕ Name does not match", `This address is registered as “${sanitizeText(payee.name, 64)}”, not “${sanitizeText(exp, 64)}”. It could be a scam. Don't pay.`],
      Unregistered: ["bad", "✕ Unknown payee", "This address is not a registered merchant."],
    }[CONFIRMATION[confirmation]];
    payto.className = `payto ${view[0]}`;
    payto.replaceChildren(h("span", { class: "eyebrow" }, "Paying to"), h("div", { class: "name" }, sanitizeText(payee.name, 64) || "Unregistered address"), h("span", { class: "status" }, view[1]), h("span", { class: "small" }, view[2]), h("span", { class: "small muted" }, addrLink(inv.merchant)));
    payBtn.disabled = !(confirmation >= 2) || STATUS[inv.status] !== "Open";
  }
  const paidView = (hash, receipt, paidBy) => card.replaceChildren(h("div", { class: "success" },
    h("span", { class: "ring" }, svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')),
    h("h2", {}, "Payment sent"),
    h("p", { class: "muted" }, `${fmt(inv.amount)} tUSD8 to ${sanitizeText(payee.name, 64)}`),
    h("dl", {}, hash ? [h("dt", {}, "Transaction"), h("dd", {}, txLink(hash))] : null, h("dt", {}, "Receipt"), h("dd", { class: "mono" }, short(receipt)), paidBy ? [h("dt", {}, "Paid by"), h("dd", {}, addrLink(paidBy))] : null, h("dt", {}, "For"), h("dd", {}, sanitizeText(memo) || "—")),
    h("div", { class: "row", style: "justify-content:center" }, h("a", { class: "btn ghost", href: `#/activity?id=${invoiceId}` }, "Verify receipt"), h("a", { class: "btn dark", href: "#/" }, "Done"))));
  expectedIn.addEventListener("input", () => runCoP().catch(() => {}));
  payBtn.onclick = async () => {
    if (!state.account) await connect({ rerender: false });
    const dup = await pub.readContract({ address: D.kindly, abi: K, functionName: "settledRef", args: [keccakRefKey(state.account, inv.merchant, inv.ref)] });
    if (dup) return toast("You already paid this invoice number to this merchant. Kindly blocks duplicates.", "error");
    if (CONFIRMATION[confirmation] === "MatchUnverified" && !confirm("This merchant is not verified. Pay anyway?")) return;
    if (!confirm(`Pay ${fmt(inv.amount)} tUSD8 to “${sanitizeText(payee.name, 64)}” (${inv.merchant})? Payments on-chain can't be reversed except by a merchant refund.`)) return;
    await ensureAllowance(payBtn, inv.amount);
    const { hash, result: receipt } = await send(payBtn, "Pay invoice", { address: D.kindly, abi: K, functionName: "payInvoice", args: [invoiceId, nameHash(expectedIn.value), inv.amount] });
    paidView(hash, receipt, state.account);
  };
  const st = STATUS[inv.status];
  const expired = Date.now() / 1000 > Number(inv.expiresAt);
  if (st === "Paid" || st === "Refunded") { paidView(null, inv.receipt, inv.paidBy); root.append(card); return root; }
  await runCoP();
  card.append(...[
    h("div", { class: "row between" }, h("span", { class: "eyebrow" }, "Payment request"), h("span", { class: `chip s-${st}` }, expired && st === "Open" ? "Expired" : st)),
    h("div", { class: "amount" }, fmt(inv.amount), h("small", {}, "tUSD8")),
    h("p", { class: "for" }, sanitizeText(memo) || "No memo"),
    payto,
    h("label", {}, "Name you were told (Confirmation of Payee)", expectedIn),
    st === "Open" && !expired ? payBtn : null,
    h("div", { class: "secured" }, ICON.shield(), "Secured by Kindly Safety Gate · expires ", new Date(Number(inv.expiresAt) * 1000).toLocaleString()),
    h("div", { class: "secured" }, "Your tokens stay in your wallet until this payment. ", trustLink("What's visible on-chain", "privacy")),
    inv.payer !== zeroAddress ? h("p", { class: "small muted", style: "text-align:center" }, "Billed to ", addrLink(inv.payer)) : null].filter(Boolean));
  root.append(card);
  return root;
}
const keccakRefKey = (payer, merchant, ref) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [payer, merchant, ref]));

async function viewActivity() {
  const root = invoicesShell("receipts", "Receipts", "Every payment produces an on-chain receipt anyone can verify.");
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const idIn = h("input", { value: q.get("id") || "", placeholder: "0x… invoice ID", class: "mono", maxlength: 66 });
  const out = h("div", {});
  const vbtn = h("button", { class: "btn dark" }, "Verify receipt");
  vbtn.onclick = async () => {
    try {
      const id = idIn.value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("Invoice ID must be 0x followed by 64 hex characters.");
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] });
      const ok = await pub.readContract({ address: D.kindly, abi: K, functionName: "verifyReceipt", args: [id, inv.receipt] });
      out.replaceChildren(h("div", { class: `cop ${ok ? "ok" : "bad"}` }, h("strong", {}, ok ? "✓ Receipt is valid on-chain" : "✕ No valid receipt"), h("p", { class: "mono" }, inv.receipt),
        h("p", {}, `${fmt(inv.amount)} tUSD8 · ${STATUS[inv.status]} · paid by ${short(inv.paidBy)}${inv.mandateId > 0n ? ` (assistant mandate #${inv.mandateId})` : ""}`)));
    } catch (e) { out.replaceChildren(h("p", { class: "warn" }, e.message?.startsWith("Invoice ID") ? e.message : humanError(e))); }
  };
  root.append(h("div", { class: "card panel" }, h("h3", {}, "Verify a receipt"), h("div", { class: "row", style: "align-items:end" }, h("label", { style: "flex:1;min-width:240px" }, "Invoice ID", idIn), vbtn), out));
  const feed = h("div", { class: "card" }, h("h3", {}, "Latest settlements"), skeleton());
  root.append(feed);
  if (D.kindly) {
    const logs = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoicePaid", fromBlock: fromBlock() }).catch(() => []);
    const rows = logs.reverse().slice(0, 30).map((lg) => h("tr", {}, h("td", {}, txLink(lg.transactionHash)), h("td", {}, `${fmt(lg.args.amount)} tUSD8`), h("td", {}, addrLink(lg.args.merchant)),
      h("td", {}, lg.args.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${lg.args.mandateId}`) : h("span", { class: "chip" }, "direct")), h("td", { class: "mono" }, short(lg.args.receipt))));
    feed.replaceChildren(h("h3", {}, "Latest settlements"), rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Tx", "Amount", "Merchant", "Path", "Receipt"].map((t) => h("th", {}, t)))), h("tbody", {}, rows))) : h("p", { class: "muted" }, "No payments yet."));
  }
  return root;
}

// ------------------------------------------------------------------ router
async function route() {
  const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
  document.querySelectorAll("#nav a").forEach((a) => {
    const on = a.dataset.match.split(" ").some((m) => (m === "/" ? path === "/" : path.startsWith(m)));
    a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $app.replaceChildren(h("section", { class: "view" }, skeleton()));
  try {
    let v;
    if (path.startsWith("/demo")) v = viewDemo();
    else if (path.startsWith("/control")) v = await viewControl();
    else if (path.startsWith("/invoices") || path.startsWith("/merchant")) v = await viewMerchant();
    else if (path.startsWith("/pay")) v = await viewPay();
    else if (path.startsWith("/activity")) v = await viewActivity();
    else v = viewHome();
    $app.replaceChildren(v);
  } catch (e) {
    $app.replaceChildren(h("div", { class: "card" }, h("p", { class: "warn" }, humanError(e))));
  }
}
document.getElementById("connect").onclick = () => connect().catch((e) => toast(humanError(e), "error"));
window.addEventListener("hashchange", () => { route(); window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" }); });
window.addEventListener("scroll", () => document.querySelector(".top")?.classList.toggle("scrolled", window.scrollY > 4), { passive: true });
if (!D.kindly) banner(`Kindly is not deployed on ${CHAIN.name} yet. Read-only mode. Test tokens: ${FAUCET_URL}`);
else if (CHAIN.id !== 44005) banner(`Local development chain (${CHAIN.name}). Testnet tokens only.`);
void REASON;
refreshHeader();
setInterval(refreshHeader, 15000);
route();
