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
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const unitsToUsd = (u) => usd.format(Number(fromUnits(u)) * SCALE);

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
/** Hash chip: monospace value, a copy button and (on Aevum) an explorer link. One component for tx hashes, addresses, receipts and invoice IDs. */
function hashChip(value, kind = "tx") {
  const v = String(value || "");
  const what = { tx: "transaction hash", address: "address", receipt: "receipt", invoice: "invoice ID" }[kind] || kind;
  const url = kind === "tx" ? explorerTx(CHAIN.id, v) : kind === "address" ? explorerAddress(CHAIN.id, v) : null;
  const copy = h("button", { type: "button", class: "hc-btn", "aria-label": `Copy ${what}`, title: `Copy ${what}` }, ICON.copy());
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(v); } catch { return toast("Copy failed. Select the value and copy it manually.", "error"); }
    copy.replaceChildren(ICON.check()); copy.classList.add("done"); announce(`Copied ${what}`);
    setTimeout(() => { copy.replaceChildren(ICON.copy()); copy.classList.remove("done"); }, 1400);
  };
  return h("span", { class: "hash", translate: "no" }, h("code", { title: v }, short(v)), copy,
    url ? h("a", { class: "hc-btn", href: url, target: "_blank", rel: "noopener", "aria-label": `View ${what} on the Aevum explorer (opens in a new tab)`, title: "View on explorer" }, ICON.ext()) : null);
}
const txLink = (hash) => hashChip(hash, "tx");
const addrLink = (a) => hashChip(a, "address");
/** Plain explorer link for a transaction, with an icon (used where a full chip is too heavy). */
const explorerLink = (hash, label = "View on explorer") => {
  const u = explorerTx(CHAIN.id, hash);
  return u ? h("a", { class: "ext", href: u, target: "_blank", rel: "noopener" }, label, ICON.ext()) : null;
};
function announce(msg) { const el = document.getElementById("sr-status"); if (el) { el.textContent = ""; setTimeout(() => (el.textContent = msg), 30); } }
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
const riskView = (risk) => h("span", { class: "risk", title: "Risk score from the contract (0–100)" }, `Risk ${risk}`, h("span", { class: "meter" }, h("span", { style: `width:${Math.min(Number(risk), 100)}%` })));
const VERDICT = { PAY: "PAY", HOLD: "HOLD", REJECT: "REJECT" };
/** One label per outcome, used everywhere: demo, dashboard, review screen and receipts. */
const OUTCOME = { PAY: "Automatic", HOLD: "Needs you", REJECT: "Blocked" };
// One outline icon set: 24px grid, 1.75 stroke, currentColor. No emoji glyphs.
const ICON = {
  check: () => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  pause: () => svg('<path d="M9 6v12M15 6v12"/>'),
  cross: () => svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  shield: () => svg('<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
  // Kindly's Safety Gate glyph: a shield holding three connected nodes (agent, rules, merchant).
  gate: () => svg('<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><circle cx="12" cy="9.2" r="1.5"/><circle cx="8.9" cy="14.2" r="1.5"/><circle cx="15.1" cy="14.2" r="1.5"/><path d="M11.2 10.5l-1.5 2.4M12.8 10.5l1.5 2.4M10.4 14.2h3.2"/>'),
  wallet: () => svg('<path d="M5 7.5V7a2 2 0 0 1 2-2h10"/><rect x="4" y="7.5" width="16" height="11.5" rx="2.5"/><path d="M15.5 13.25h1.5"/>'),
  copy: () => svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>'),
  ext: () => svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"/>'),
  snow: () => svg('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>'),
  play: () => svg('<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z"/>'),
  spark: () => svg('<path d="M12 4.5l1.6 4.4 4.4 1.6-4.4 1.6L12 16.5l-1.6-4.4L6 10.5l4.4-1.6z"/>'),
  aevum: () => svg('<path d="M12 3.5l7.5 8.5-7.5 8.5L4.5 12z"/><path d="M12 8.5l3.2 3.5-3.2 3.5L8.8 12z"/>'),
  arrow: () => svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
};
/** tUSD8 token badge: a custom mark (a coin with two level bars, "stable"), used on every balance and amount. */
const tok = () => h("span", { class: "tok", translate: "no" }, svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.6 10.3h6.8M8.6 13.7h6.8"/>'), "tUSD8");
/** An amount in tUSD8 with tabular numerals and the token badge. */
const money = (u, cls = "") => h("span", { class: `money ${cls}` }, h("span", { class: "n" }, fmt(u)), tok());
const aevumChip = (label = CHAIN.id === 44005 ? "Aevum" : CHAIN.name) => h("span", { class: "netchip", translate: "no" }, ICON.aevum(), label);
/** On-chain status chip: verified, confirmed or pending. Always text plus colour, never colour alone. */
const statusChip = (kind, label) => h("span", { class: `chip st-${kind}` }, kind === "pending" ? h("span", { class: "pdot", "aria-hidden": "true" }) : ICON.check(), label);
function svg(inner) { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.innerHTML = inner; return s; }
const stamp = (d, withLabel = false) => h("span", { class: `stamp ${d}` }, (d === "PAY" ? ICON.check : d === "HOLD" ? ICON.pause : ICON.cross)(), VERDICT[d], withLabel ? h("small", {}, OUTCOME[d]) : null);
function decisionCard(ex, extra) {
  return h("div", { class: `decision ${ex.decision}` },
    h("div", { class: "row between" }, stamp(ex.decision, true), riskView(ex.risk)),
    h("p", {}, ex.text), h("div", { class: "meta" }, h("span", { class: "chip" }, reasonLabel(ex.reason)), extra));
}
const skeleton = () => h("div", { class: "skeleton", role: "status", "aria-label": "Loading…" }, h("i"), h("i"), h("i"));

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
  const label = CHAIN.id === 44005 ? "Aevum" : CHAIN.name;
  try {
    const bn = await pub.getBlockNumber();
    net.replaceChildren(ICON.aevum(), h("span", {}, label), h("span", { class: "sr-only" }, `, testnet, latest block ${bn}`));
    net.title = `${CHAIN.name} · chain ${CHAIN.id} · block #${bn}`;
    net.className = "net ok";
  } catch {
    net.replaceChildren(ICON.aevum(), h("span", {}, `${label} unreachable`));
    net.className = "net bad";
  }
  if (state.account) {
    state.balance = D.token ? await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }).catch(() => state.balance ?? 0n) : 0n;
    const c = document.getElementById("connect");
    c.replaceChildren(ICON.wallet(), h("span", { class: "mono" }, short(state.account)));
    c.className = "btn ghost small addr-pill"; c.setAttribute("aria-haspopup", "dialog"); c.setAttribute("aria-expanded", String(!!document.getElementById("walletPop")));
    c.setAttribute("aria-label", `Wallet ${short(state.account)}. Show balance`);
    const pop = document.getElementById("walletPop"); if (pop) pop.querySelector(".wp-bal")?.replaceChildren(money(state.balance, "big"));
  }
}
/** Wallet panel: the balance lives here, not in the navbar. */
function toggleWalletPanel() {
  const btn = document.getElementById("connect");
  const old = document.getElementById("walletPop");
  if (old) { old.remove(); btn.setAttribute("aria-expanded", "false"); btn.focus(); return; }
  const close = () => { pop.remove(); btn.setAttribute("aria-expanded", "false"); document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onOut); };
  const onKey = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };
  const onOut = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) close(); };
  const pop = h("div", { id: "walletPop", class: "wallet-pop", role: "dialog", "aria-label": "Wallet" },
    h("div", { class: "row between" }, h("span", { class: "small muted" }, "Wallet balance"), statusChip("confirmed", "Connected")),
    h("div", { class: "wp-bal" }, money(state.balance ?? 0n, "big")),
    h("dl", { class: "kv" }, h("dt", {}, "Network"), h("dd", {}, aevumChip(CHAIN.id === 44005 ? "Aevum testnet" : CHAIN.name)), h("dt", {}, "Address"), h("dd", {}, addrLink(state.account))),
    h("p", { class: "small muted" }, "Kindly never holds your funds. Payments move straight from this wallet to the merchant."),
    h("a", { class: "btn dark small wide", href: "#/controls", onclick: () => close() }, "Open dashboard"));
  btn.after(pop); btn.setAttribute("aria-expanded", "true");
  setTimeout(() => { document.addEventListener("keydown", onKey); document.addEventListener("pointerdown", onOut); pop.querySelector("button, a")?.focus(); }, 0);
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
  const original = button ? [...button.childNodes] : null;
  try {
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.title = signer ? "Working…" : "Confirm in your wallet…"; button.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), ...original.map((n) => n.cloneNode(true))); }
    const { request, result } = await pub.simulateContract({ account, address, abi, functionName, args, value });
    const hash = await wallet.writeContract(request);
    if (button) button.title = "Confirming on-chain…";
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`Transaction reverted (${hash})`);
    if (!signer && !state.quiet) toast(`${label}: confirmed`, "ok");
    refreshHeader();
    return { hash, result, receipt: r };
  } catch (e) {
    toast(`${label} failed: ${humanError(e)}`, "error");
    throw e;
  } finally {
    if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.removeAttribute("title"); button.replaceChildren(...original); }
  }
}
async function ensureAllowance(button, amount) {
  const allowance = await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] });
  if (allowance >= amount) return null;
  // Least privilege: approve exactly what is needed, never unlimited.
  return send(button, `Allow ${fromUnits(amount)} tUSD8`, { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, amount] });
}

const fromBlock = () => BigInt(D.deployBlock || 0);
const mandateStatus = (m) => (m.revoked ? "Revoked" : m.frozen ? "Frozen" : Date.now() / 1000 > Number(m.validUntil) ? "Expired" : "Active");
const fmt = (u) => Number(fromUnits(u)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion() ? 0 : ms));
const pageHead = (eyebrow, title, lead) => h("div", { class: "page-head" }, eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null, h("h1", { class: "title" }, title), lead ? h("p", { class: "lead" }, lead) : null);
const setTitle = (t) => { document.title = t ? `${t} · Kindly` : "Kindly · Payments, handled. Safely."; };
/** Relative time for activity lists ("2 min ago"), locale-aware. */
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(sec) {
  const d = Math.round(Number(sec) - Date.now() / 1000);
  const a = Math.abs(d);
  return a < 60 ? rtf.format(Math.round(d), "second") : a < 3600 ? rtf.format(Math.round(d / 60), "minute") : a < 86400 ? rtf.format(Math.round(d / 3600), "hour") : rtf.format(Math.round(d / 86400), "day");
}
const checkItem = (label) => h("li", {}, h("span", { class: "tick" }, svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')), h("span", {}, label));

// ------------------------------------------------------------------ Trust: custody, protections, privacy (claims verified against contracts/src)
function trustModal(tab = "funds") {
  document.getElementById("trust")?.remove();
  const card = (n, t, body) => h("div", { class: "tcard" }, h("span", { class: "num" }, n), h("h3", {}, t), h("p", {}, body));
  const close = h("button", { class: "btn ghost small" }, "Close");
  const dlg = h("dialog", { id: "trust", class: "modal", "aria-labelledby": "trust-title" },
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Security and funds"), h("h2", { id: "trust-title" }, tab === "privacy" ? "What's visible on-chain" : "How your funds are protected")), close),
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
  setTitle(null);
  const card = heroCard();
  return h("section", { class: "view" },
    h("div", { class: "hero" },
      h("div", {},
        h("span", { class: "netchip big" }, ICON.aevum(), "Live on QDay Aevum testnet"),
        h("h1", { class: "display" }, "Payments, handled. ", h("em", {}, "Safely.")),
        h("p", { class: "lead" }, "Your AI agent can pay invoices for you. Kindly makes sure every payment is verified, within your rules, and safe to approve."),
        h("div", { class: "cta" }, h("a", { class: "btn big", href: "#/demo" }, "Run the live demo", h("span", { class: "arrow" }, ICON.arrow())), h("a", { class: "btn ghost big", href: "#/start" }, "Set up your agent")),
        h("ul", { class: "proof" }, h("li", {}, "Decided on-chain"), h("li", {}, "Exact allowances, never a deposit"), h("li", {}, "Freeze or revoke in one tap"))),
      card.el),
    h("div", { class: "steps3" },
      step3("01", "Verify", "Every payee is checked against an on-chain registry. A look-alike name or a swapped link never gets paid."),
      step3("02", "Control", "You set the mandate: per-payment cap, total budget, usual amount and allowed merchants. Change it any time."),
      step3("03", "Confirm", "Routine bills pay themselves. Anything unusual waits for one tap from you. Duplicates are blocked outright.")),
    h("div", { class: "story" },
      h("blockquote", {}, "Kindly doesn't give AI your wallet. ", h("span", {}, "It gives AI a permission to spend.")),
      h("p", { class: "muted", style: "max-width:640px" }, "Every invoice passes through an on-chain safety gate. Funds are governed by spending limits, verified recipients, and human approval when something looks unusual. We give AI agents financial autonomy without giving them unlimited authority."),
      h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => trustModal("funds") }, "How your funds are protected"), trustLink("What's visible on-chain", "privacy")),
      D.kindly
        ? h("div", { class: "contracts" }, h("span", {}, "Kindly ", addrLink(D.kindly)), h("span", {}, "Payee registry ", addrLink(D.registry)), h("span", { class: "row", style: "gap:6px" }, tok(), addrLink(D.token)))
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
    h("div", { class: "row between" }, h("div", { class: "who" }, h("span", { class: "avatar" }, "S"), h("div", { class: "stack", style: "gap:0" }, h("strong", {}, "Sunrise Coffee Co"), num)), statusChip("verified", "Verified")),
    h("div", { class: "stack", style: "gap:6px" }, amt, memo),
    h("div", { class: "agent-note" }, ICON.spark(), h("span", {}, h("b", {}, "Your agent"), " wants to pay this invoice")),
    list, bar,
    h("div", { class: "gate-tag" }, ICON.gate(), "Secured by Kindly Safety Gate")));
  // Autoplay longer than 5s needs a pause control (WCAG 2.2.2, Vercel guidelines).
  let paused = false;
  const pauseBtn = h("button", { type: "button", class: "motion-toggle", "aria-pressed": "false" }, ICON.pause(), h("span", {}, "Pause animation"));
  pauseBtn.onclick = () => { paused = !paused; pauseBtn.setAttribute("aria-pressed", String(paused)); pauseBtn.replaceChildren(paused ? ICON.play() : ICON.pause(), h("span", {}, paused ? "Play animation" : "Pause animation")); };
  const wrap = h("div", { class: "hero-art" }, el, reduceMotion() ? null : pauseBtn);
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
    while (document.body.contains(el) || i === 0) {
      while (paused || document.hidden) { await new Promise((r) => setTimeout(r, 400)); if (!document.body.contains(el)) return; }
      await show(scenes[i % 3]); i++; await new Promise((r) => setTimeout(r, 2600)); if (!document.body.contains(el)) break;
    }
  })();
  return { el: wrap };
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
    h("div", { class: "amt" }, usd.format(inv.usd)), h("p", { class: "memo" }, inv.memo), checks, why, extra);
  return {
    el, extra,
    activate() { el.classList.add("active"); verdict.className = "stamp"; verdict.textContent = "At the gate…"; },
    async decide(ex, link) {
      const res = CHECK_RESULT[ex.decision === "PAY" ? "PAY" : ex.reason] || ["pass", "pass", "pass"];
      const lis = [...checks.children];
      for (let k = 0; k < 3; k++) { await sleep(260); lis[k].className = res[k]; }
      await sleep(200);
      el.classList.remove("active"); el.classList.add("decided", ex.decision);
      verdict.replaceWith(stamp(ex.decision, true));
      why.className = "why small"; why.replaceChildren(ex.text);
      if (link) extra.replaceChildren(h("div", { class: "row between small muted" }, riskView(ex.risk), link));
    },
  };
}

function viewDemo() {
  setTitle("Live demo");
  const replay = /replay=1/.test(location.hash);
  const root = h("section", { class: "view" });
  const gate = h("div", { class: "gate" }, h("span", { class: "shield" }, ICON.gate()), h("div", { class: "label" }, h("b", {}, "Kindly Safety Gate"), h("span", {}, "Runs on-chain and decides PAY, HOLD or REJECT")), h("span", { class: "state" }, "idle"), h("span", { class: "scan" }));
  const grid = h("div", { class: "invoices" });
  let cards = [];
  const resetCards = () => { cards = DEMO_INVOICES.map(invoiceCard); grid.replaceChildren(...cards.map((c) => c.el)); grid.classList.remove("running"); };
  resetCards();
  const runBtn = h("button", { class: "btn big" }, ICON.play(), "Run 3 invoices");
  const replayBtn = h("button", { class: "btn ghost big" }, "Replay recorded run");
  const progress = h("div", { class: "progress-line" }, h("span", {}, "Uses your connected wallet on testnet and takes about a minute. No setup needed: the demo brings its own throwaway assistant."));
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
      ok: (hash, note) => { li.className = "done"; li.firstChild.replaceChildren(ICON.check()); li.lastChild.replaceChildren(hash ? txLink(hash) : note || ""); },
      fail: (msg) => { li.className = "err"; li.firstChild.textContent = "!"; li.lastChild.textContent = msg; },
    };
  };
  const step = async (label, fn) => {
    const s = add(label);
    try { const r = await fn(); s.ok(r?.hash, r?.note); return r; } catch (e) { s.fail(humanError(e)); throw e; }
  };
  const showSummary = (tally) => summary.replaceChildren(h("div", { class: "summary" },
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
        const link = d.explorer ? h("a", { href: d.explorer, target: "_blank", rel: "noopener", class: "ext" }, "Aevum transaction", ICON.ext()) : null;
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
        await cards[i].decide(ex, txLink(r.hash));
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
      setGate("", "done"); setProgress(false, "Demo complete. Test tokens were refunded. Open the dashboard to see the mandate.");
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
    h("div", { class: "grid2" }, run.decisions.map((d) => decisionCard({ decision: d.decision, reason: d.reason, risk: d.risk, text: d.explanation }, [h("span", {}, d.invoice), txLink(d.hash)]))));
}

const REASON_LABEL = {
  Ok: "Matches usual spend", PayeeMismatch: "Name mismatch", PayeeUnverified: "Unverified merchant", AmountAnomaly: "Unusual amount",
  Duplicate: "Duplicate invoice", NotOpen: "Not payable", Expired: "Invoice expired", MerchantNotAllowed: "Merchant not allowed",
  OverCap: "Over per-payment limit", OverBudget: "Over budget", PayerNotAllowed: "Different payer",
};
const reasonLabel = (r) => REASON_LABEL[r] || r;
const blockTimes = new Map();
async function blockTime(bn) {
  const k = String(bn);
  if (!blockTimes.has(k)) blockTimes.set(k, pub.getBlock({ blockNumber: BigInt(bn) }).then((b) => Number(b.timestamp)).catch(() => null));
  return blockTimes.get(k);
}
/** Latest allowlist of a mandate, rebuilt from MandateMerchantSet events (the contract has no list getter). */
async function mandateMerchants(id) {
  const logs = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "MandateMerchantSet", args: { id }, fromBlock: fromBlock() }).catch(() => []);
  const m = new Map(); for (const l of logs) m.set(l.args.merchant, l.args.allowed);
  return [...m].filter(([, ok]) => ok).map(([a]) => a);
}
const connectCard = (what) => h("div", { class: "card panel empty-state" },
  h("span", { class: "es-icon" }, ICON.wallet()),
  h("h2", {}, "Connect your wallet"),
  h("p", { class: "muted" }, `Connect to ${what}. Kindly never asks for your seed phrase.`),
  h("div", { class: "row" }, h("button", { class: "btn dark", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, ICON.wallet(), "Connect wallet"), h("a", { class: "btn ghost", href: "#/demo?replay=1" }, "Watch the recorded demo")));

// ------------------------------------------------------------------ Dashboard ("Your AI agent")
async function viewControl() {
  setTitle("Dashboard");
  const root = h("section", { class: "view" });
  if (!state.account) { root.append(pageHead("Your AI agent", "Agent dashboard", "What your AI assistant may pay, how much, and to whom."), connectCard("see and manage your assistant's permissions")); return root; }
  requireWallet();
  const head = h("div", {}, pageHead("Your AI agent", "Everything under control.", null));
  const top = h("div", { class: "dash-top" }, h("div", { class: "card panel" }, skeleton()), h("div", { class: "walletcard" }, skeleton()));
  const holds = h("div", {});
  const list = h("div", { class: "stack", style: "gap:16px" });
  const recent = h("ul", { class: "activity" }, h("li", {}, skeleton()));
  const more = h("div", { class: "stack" });
  const funds = h("div", { class: "card panel funds" }, skeleton());
  root.append(head, holds, top,
    h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { class: "h3" }, "Recent activity"), h("span", { class: "muted small" }, "Safety Gate decisions")), recent,
      h("details", {}, h("summary", {}, "All activity"), h("div", { class: "body" }, more))),
    funds,
    h("div", { class: "row between" }, h("h2", { class: "h3" }, "Mandates"), h("a", { class: "btn ghost small", href: "#/start" }, "Add a mandate")),
    list);

  async function load() {
    const created = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "MandateCreated", args: { owner: state.account }, fromBlock: fromBlock() });
    const ids = created.map((l) => l.args.id).reverse();
    const ms = [];
    const cards = [];
    for (const [i, id] of ids.slice(0, 12).entries()) {
      const [m, rem] = await Promise.all([pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] }), pub.readContract({ address: D.kindly, abi: K, functionName: "mandateRemaining", args: [id] })]);
      ms.push([id, m, rem]); cards.push(await mandateCard(id, load, i === 0));
    }
    const [bal, allowance] = await Promise.all([
      pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }),
      pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] }),
    ]);
    const primary = ms.find(([, m]) => mandateStatus(m) === "Active") || ms.find(([, m]) => mandateStatus(m) === "Frozen") || ms[0];
    top.replaceChildren(await agentCard(primary, load), walletCard(bal, allowance, load));
    funds.replaceChildren(...fundsPanel(ms, allowance).childNodes);
    list.replaceChildren(...(cards.length ? cards : [h("div", { class: "card empty-state" }, h("p", { class: "muted" }, "No mandates yet. A mandate tells your agent what it may pay."), h("a", { class: "btn dark small", href: "#/start" }, "Set up your agent"))]));

    const decs = [];
    for (const id of ids.slice(0, 12)) decs.push(...(await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "SafetyDecision", args: { mandateId: id }, fromBlock: fromBlock() })));
    decs.sort((x, y) => Number(y.blockNumber - x.blockNumber));
    const item = async (ev) => {
      const ex = explainDecision({ ...ev.args, usual: ev.args.usualAmount });
      const ts = await blockTime(ev.blockNumber);
      return h("li", {}, stamp(ex.decision), h("div", { class: "a-main" }, money(ev.args.amount), h("span", { class: "small muted" }, `${OUTCOME[ex.decision]} · ${reasonLabel(ex.reason)} · mandate #${ev.args.mandateId}`)),
        h("span", { class: "small muted a-time" }, ts ? h("time", { datetime: new Date(ts * 1000).toISOString(), title: new Date(ts * 1000).toLocaleString() }, ago(ts)) : ""), txLink(ev.transactionHash));
    };
    recent.replaceChildren(...(decs.length ? await Promise.all(decs.slice(0, 3).map(item)) : [h("li", { class: "empty" }, h("span", { class: "muted" }, "No decisions yet. When your agent submits an invoice, the Safety Gate's verdict shows up here."))]));
    more.replaceChildren(...(await Promise.all(decs.slice(3, 30).map(item))).map((li) => h("ul", { class: "activity" }, li)));
    if (!more.children.length) more.append(h("p", { class: "muted small" }, "Nothing older."));

    const pending = [];
    for (const ev of decs.filter((x) => DECISION[x.args.decision] === "HOLD")) {
      const hold = await pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [ev.args.invoiceId] });
      if (!hold.active) continue;
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [ev.args.invoiceId] });
      const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] });
      const ex = explainDecision({ ...ev.args, usual: ev.args.usualAmount, merchantName: payee.name });
      pending.push(h("div", { class: "needs-row" },
        h("div", { class: "stack", style: "gap:2px" }, h("strong", {}, money(inv.amount), " to ", sanitizeText(payee.name, 40) || short(inv.merchant)),
          h("span", { class: "small" }, `${reasonLabel(ex.reason)} · Awaiting your approval`)),
        h("a", { class: "btn dark", href: `#/review/${ev.args.invoiceId}` }, "Review payment")));
    }
    head.replaceChildren(pageHead("Your AI agent", pending.length ? `${pending.length} payment${pending.length > 1 ? "s need" : " needs"} you.` : "Everything under control.",
      pending.length ? "Your agent paused these because something looked unusual. Nothing moves until you decide." : "Your agent pays routine invoices within the limits below. Anything unusual waits for you."));
    holds.replaceChildren(pending.length
      ? h("div", { class: "attn", role: "region", "aria-label": "Payments that need you" }, h("div", { class: "row between" }, h("h2", { class: "h3" }, pending.length > 1 ? `${pending.length} payments need you` : "1 payment needs you"), stamp("HOLD", true)), ...pending)
      : h("div", { class: "calm" }, ICON.check(), "Nothing is waiting for your approval."));
  }
  await load();
  const timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(timer); if (!document.querySelector("#app input:focus, #app details.drawer[open]")) load().catch(() => {}); }, 12000);
  return root;
}

/** The hero card of the dashboard: status, remaining budget, limits, and a Freeze that is never buried. */
async function agentCard(entry, reload) {
  if (!entry) return h("div", { class: "card panel agent empty-state" },
    h("span", { class: "es-icon" }, ICON.gate()), h("h2", { class: "h3" }, "Your agent has no permissions yet"),
    h("p", { class: "muted" }, "Set a spending allowance and a mandate in three short steps. Or run the demo, which brings its own assistant."),
    h("div", { class: "row" }, h("a", { class: "btn", href: "#/start" }, "Set up your agent"), h("a", { class: "btn ghost", href: "#/demo" }, "Run the demo")));
  const [id, m, remaining] = entry;
  const st = mandateStatus(m);
  const shown = st === "Frozen" ? (m.totalBudget > m.spent ? m.totalBudget - m.spent : 0n) : st === "Active" ? remaining : 0n;
  const pctLeft = m.totalBudget ? Number((shown * 100n) / m.totalBudget) : 0;
  const merchants = m.anyMerchant ? null : await mandateMerchants(id);
  const live = st === "Active" || st === "Frozen";
  const freeze = h("button", { class: `btn freeze ${m.frozen ? "on" : ""}` }, m.frozen ? ICON.play() : ICON.snow(), m.frozen ? "Unfreeze agent" : "Freeze agent");
  freeze.onclick = async () => {
    if (!m.frozen && !confirm(`Freeze mandate #${id}? Your assistant can't pay anything until you unfreeze it.`)) return;
    await send(freeze, m.frozen ? "Unfreeze" : "Freeze", { address: D.kindly, abi: K, functionName: "setFrozen", args: [id, !m.frozen] }); reload();
  };
  const chip = st === "Active" ? h("span", { class: "chip ok live" }, "Active · Limited permissions") : st === "Frozen" ? h("span", { class: "chip sky" }, ICON.snow(), "Frozen") : h("span", { class: "chip bad" }, st);
  return h("div", { class: `card panel agent ${st.toLowerCase()}` },
    h("div", { class: "row between" }, h("div", { class: "row" }, h("span", { class: "gate-mark" }, ICON.gate()), h("div", { class: "stack", style: "gap:0" }, h("strong", {}, `Mandate #${id}`), h("span", { class: "small muted" }, "Assistant ", addrLink(m.agent)))), chip),
    h("div", { class: "stack", style: "gap:8px" },
      h("span", { class: "small muted" }, st === "Frozen" ? "Remaining budget, paused" : "Remaining budget"),
      h("div", { class: "remaining" }, h("span", { class: "n" }, fmt(shown)), h("small", {}, "of ", fmt(m.totalBudget), " "), tok(), h("span", { class: "pct" }, `${pctLeft}% available`)),
      h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(pctLeft), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Budget available" }, h("span", { style: `--w:${Math.min(pctLeft, 100) / 100}` }))),
    h("dl", { class: "facts" },
      h("div", {}, h("dt", {}, "Payment limit"), h("dd", {}, money(m.perPaymentCap))),
      h("div", {}, h("dt", {}, "Usual amount"), h("dd", {}, money(m.typicalAmount))),
      h("div", {}, h("dt", {}, "Allowed merchants"), h("dd", {}, m.anyMerchant ? "Any merchant" : `${merchants.length} merchant${merchants.length === 1 ? "" : "s"}`, m.requireVerifiedPayee ? h("small", { class: "muted" }, " · verified only") : null)),
      h("div", {}, h("dt", {}, "Valid until"), h("dd", {}, h("time", { datetime: new Date(Number(m.validUntil) * 1000).toISOString() }, new Date(Number(m.validUntil) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))))),
    live ? h("div", { class: "freeze-row" }, freeze, h("span", { class: "small muted" }, m.frozen ? "Your agent can't pay anything while frozen." : "Stops every payment at once. You can unfreeze any time.")) : h("p", { class: "small muted" }, "This mandate can no longer spend."));
}

/** The one charcoal contrast moment: real wallet balance, read from the token contract. */
function walletCard(bal, allowance, reload) {
  const zero = h("button", { class: "btn on-dark small" }, "Reduce allowance to 0");
  zero.onclick = async () => { if (!confirm("Set your tUSD8 allowance for Kindly to 0? No payment can be pulled through Kindly until you allow spending again.")) return; await send(zero, "Allowance to 0", { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, 0n] }); reload(); };
  return h("div", { class: "walletcard" },
    h("div", { class: "row between" }, h("span", { class: "wc-label" }, ICON.wallet(), "Wallet balance"), h("span", { class: "wc-chip" }, h("span", { class: "dot", "aria-hidden": "true" }), "Connected")),
    h("div", { class: "wc-amt" }, h("span", { class: "n" }, fmt(bal)), tok()),
    h("div", { class: "row wc-meta" }, aevumChip(CHAIN.id === 44005 ? "Aevum testnet" : CHAIN.name), h("span", {}, "Available in wallet")),
    h("hr", {}),
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:2px" }, h("span", { class: "wc-small" }, "Kindly may move at most"), h("b", { class: "n" }, fmt(allowance), " tUSD8")), allowance > 0n ? zero : h("span", { class: "wc-small" }, "Nothing can be pulled")),
    h("p", { class: "wc-small" }, "Your funds stay here. Kindly only holds a permission, never a deposit."));
}

function fundsPanel(ms, allowance) {
  const live = ms.filter(([, m]) => mandateStatus(m) === "Active");
  const primary = live[0] || ms[0];
  const budget = live.reduce((s, [, , r]) => s + r, 0n);
  const revokeLink = h("button", { class: "link" }, "Revoke access");
  revokeLink.onclick = () => { const d = document.querySelector(".mandate:not(.revoked):not(.expired) details.drawer"); if (d) { d.open = true; d.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" }); } else toast("No live mandate to revoke.", "info"); };
  const perm = (ok, t) => h("li", { class: ok ? "yes" : "no" }, h("span", { class: "pm" }, ok ? ICON.check() : ICON.cross()), t);
  const pm = primary?.[1];
  return h("div", {},
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("h2", { class: "h3" }, "Funds and permissions"), h("span", { class: "muted small" }, "Exactly what your agent can and can't touch.")), trustLink("How your funds are protected", "funds")),
    h("div", { class: "fund-grid three" },
      h("div", {}, h("small", {}, "Agent spending budget"), h("b", {}, money(budget)), h("span", { class: "small muted" }, `left across ${live.length} active mandate${live.length === 1 ? "" : "s"}`)),
      h("div", {}, h("small", {}, "Per-payment limit"), h("b", {}, pm ? money(pm.perPaymentCap) : "None"), h("span", { class: "small muted" }, primary ? `mandate #${primary[0]}` : "no mandate yet")),
      h("div", {}, h("small", {}, "Kindly may pull at most"), h("b", {}, money(allowance)), h("span", { class: "small muted" }, "your exact ERC-20 allowance"))),
    h("div", { class: "split" },
      h("ul", { class: "perms" },
        perm(true, "Can pay merchants on its allowlist"), perm(true, "Cannot exceed its per-payment limit or budget"), perm(true, "Duplicate invoices are blocked"), perm(true, "Unusual payments wait for your approval"),
        perm(false, "Cannot change its limits, approve holds or raise its budget"), perm(false, "Never gets a token allowance or your keys")),
      h("div", { class: "recovery" }, h("strong", {}, "Recovery path"), h("ol", {}, h("li", {}, "Freeze the agent: it stops at once."), h("li", {}, "Revoke the mandate: permanent, can't be undone."), h("li", {}, "Reduce your allowance to 0: nothing can be pulled through Kindly. Your funds never left your wallet.")), h("div", { class: "row" }, revokeLink))));
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
  const freeze = h("button", { class: "btn ghost small" }, m.frozen ? ICON.play() : ICON.snow(), m.frozen ? "Unfreeze" : "Freeze");
  freeze.onclick = async () => {
    if (!m.frozen && !confirm(`Freeze mandate #${id}? Your assistant can't pay anything until you unfreeze it.`)) return;
    await send(freeze, m.frozen ? "Unfreeze" : "Freeze", { address: D.kindly, abi: K, functionName: "setFrozen", args: [id, !m.frozen] }); reload();
  };
  const revoke = h("button", { class: "btn danger small" }, "Revoke forever");
  revoke.onclick = async () => { if (!confirm(`Revoke mandate #${id} permanently? This can't be undone.`)) return; await send(revoke, "Revoke", { address: D.kindly, abi: K, functionName: "revokeMandate", args: [id] }); reload(); };
  const merchantIn = h("input", { placeholder: "0x… merchant address", class: "mono", maxlength: 42, autocomplete: "off", spellcheck: "false", name: "merchant" });
  const allow = h("button", { class: "btn ghost small" }, "Allow");
  const disallow = h("button", { class: "btn soft small" }, "Remove");
  const setM = (b, v) => async () => { if (!isAddress(merchantIn.value.trim())) return toast("Enter a valid merchant address", "error"); await send(b, v ? "Allow merchant" : "Remove merchant", { address: D.kindly, abi: K, functionName: "setMandateMerchant", args: [id, getAddress(merchantIn.value.trim()), v] }); toast(v ? "Merchant allowed" : "Merchant removed", "ok"); };
  allow.onclick = setM(allow, true); disallow.onclick = setM(disallow, false);
  const chipCls = st === "Active" ? "ok live" : st === "Frozen" ? "sky" : "bad";
  return h("div", { class: `card panel mandate ${st.toLowerCase()}` },
    h("div", { class: "row between" }, h("div", { class: "row" }, h("h3", {}, `Mandate #${id}`), h("span", { class: `chip ${chipCls}` }, st)), h("span", { class: "small muted" }, "assistant ", addrLink(m.agent))),
    h("div", { class: "mandate-hero" },
      h("div", { class: "stack" }, h("small", { class: "muted" }, st === "Frozen" ? "Remaining budget · paused" : "Remaining budget"), h("div", { class: "remaining sm" }, h("span", { class: "n" }, fmt(st === "Frozen" ? (m.totalBudget > m.spent ? m.totalBudget - m.spent : 0n) : remaining)), h("small", {}, `of ${fmt(m.totalBudget)} `), tok()), h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(Math.min(pct, 100)), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Budget used" }, h("span", { style: `--w:${Math.min(pct, 100) / 100}` }))),
      h("div", { class: "facts" },
        h("div", {}, h("small", {}, "Per payment"), h("b", {}, `${fmt(m.perPaymentCap)} tUSD8`)),
        h("div", {}, h("small", {}, "Usual amount"), h("b", {}, `${fmt(m.typicalAmount)} tUSD8`)),
        h("div", {}, h("small", {}, "Paid so far"), h("b", {}, `${m.payments} payment${Number(m.payments) === 1 ? "" : "s"}, ${fmt(m.spent)}`)),
        h("div", {}, h("small", {}, "Valid until"), h("b", {}, new Date(Number(m.validUntil) * 1000).toLocaleDateString())))),
    live ? h("div", { class: "row" }, freeze) : h("p", { class: "small muted" }, "This mandate can no longer spend."),
    live ? h("details", { class: "drawer", open: primary && false },
      h("summary", {}, "Edit limits & merchants"),
      h("div", { class: "body stack", style: "gap:14px" },
        h("div", { class: "grid2" }, h("label", {}, "Payment limit (tUSD8)", cap), h("label", {}, "Total budget (tUSD8)", budget), h("label", {}, "Usual amount (baseline)", usual), h("label", {}, "Valid for (hours)", hours), h("label", {}, "Cooldown (minutes)", cooldown)),
        h("div", { class: "row" }, h("label", { class: "check" }, anyM, "Any merchant"), h("label", { class: "check" }, verified, "Verified payees only")),
        h("div", { class: "row" }, save),
        h("hr", { class: "sep" }),
        h("label", {}, "Allowed merchants", merchantIn), h("div", { class: "row" }, allow, disallow),
        h("div", { class: "danger-zone" }, h("div", {}, h("strong", {}, "Danger zone"), h("p", { class: "small muted" }, "Revoking ends this mandate permanently.")), revoke))) : null);
}

// ------------------------------------------------------------------ Get started: connect → 1 Allow spending → 2 Permissions → 3 Activate
// Only fields the contract really has (MandateParams): agent, perPaymentCap, totalBudget, typicalAmount, validUntil, cooldown, anyMerchant, requireVerifiedPayee, merchants.
const PRESETS = {
  everyday: { title: "Everyday spending", body: "Small, routine payments. Approval required for unusual amounts.", cap: "0.2", usual: "0.025", days: "30", cooldown: "0", verified: false },
  strict: { title: "Strict mode", body: "Only verified merchants and very low payment limits.", cap: "0.05", usual: "0.01", days: "7", cooldown: "10", verified: true },
};
const WZ_KEY = `kindly.setup.${CHAIN.id}`;
const wzLoad = () => ({ allowance: "0.5", preset: "everyday", agent: "", merchants: "", anyMerchant: false, budget: "0.5", ...PRESETS.everyday, ...JSON.parse(sessionStorage.getItem(WZ_KEY) || "{}") });
const wzSave = (w) => sessionStorage.setItem(WZ_KEY, JSON.stringify(w));
const DEC6 = /^\d+(\.\d{1,6})?$/;
/** Inline field error next to the field (not a toast), and focus the first one. */
function fieldCheck(rules) {
  let first = null;
  for (const [input, msg] of rules) {
    const lab = input.closest("label"); const old = lab?.querySelector(".ferr"); old?.remove();
    input.removeAttribute("aria-invalid");
    if (msg) {
      input.setAttribute("aria-invalid", "true"); lab?.append(h("span", { class: "ferr", role: "alert" }, msg)); first ||= input;
      input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); lab?.querySelector(".ferr")?.remove(); }, { once: true });
    }
  }
  first?.focus();
  return !first;
}
const field = (label, input, hint) => h("label", {}, label, input, hint ? h("span", { class: "hint" }, hint) : null);
const num = (value, attrs = {}) => h("input", { type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", value, ...attrs });

async function viewStart() {
  setTitle("Get started");
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  let step = Math.min(3, Math.max(1, Number(q.get("step")) || 1));
  const w = wzLoad();
  const root = h("section", { class: "view wizard" });
  const go = (n) => { location.hash = `/start?step=${n}`; };
  if (!state.account) {
    const warn = h("p", { class: "netwarn hidden", role: "status" });
    window.ethereum?.request({ method: "eth_chainId" }).then((hex) => { if (Number(hex) !== CHAIN.id) { warn.textContent = `Your wallet is on another network (chain ${Number(hex)}). Kindly will ask it to switch to ${CHAIN.id === 44005 ? "Aevum testnet" : CHAIN.name}.`; warn.classList.remove("hidden"); } }).catch(() => {});
    root.append(h("div", { class: "card panel welcome" },
      h("span", { class: "es-icon" }, ICON.wallet()),
      h("span", { class: "netchip" }, ICON.aevum(), "Testnet · Aevum"),
      h("h1", { class: "title" }, "Welcome to Kindly"),
      h("p", { class: "lead" }, "Let your AI handle payments. You stay in control."),
      h("div", { class: "stack", style: "gap:4px" }, h("h2", { class: "h3" }, "Connect your wallet"), h("p", { class: "muted" }, "Connect securely to get started. Kindly never asks for your seed phrase.")),
      warn,
      h("button", { class: "btn big", onclick: (e) => connect().catch((err) => toast(humanError(err), "error")) }, "Connect wallet", h("span", { class: "arrow" }, ICON.arrow())),
      window.ethereum ? null : h("p", { class: "small warn" }, "No browser wallet found. Install MetaMask, then reload."),
      h("p", { class: "small muted" }, "Just looking? ", h("a", { href: "#/demo?replay=1" }, "Watch the recorded demo"), " or ", h("a", { href: "#/demo" }, "run it live"), ". Both skip setup.")));
    return root;
  }
  requireWallet();
  const [bal, curAllow] = await Promise.all([
    pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }),
    pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] }),
  ]);
  const stepper = h("ol", { class: "stepper", "aria-label": "Setup progress" },
    ["Allow spending", "Permissions", "Activate"].map((t, i) => h("li", { class: i + 1 < step ? "done" : i + 1 === step ? "now" : "", "aria-current": i + 1 === step ? "step" : null },
      h("span", { class: "sn" }, i + 1 < step ? ICON.check() : String(i + 1)), h("span", {}, t))));
  root.append(h("div", { class: "row between" }, h("span", { class: "small muted" }, `Step ${step} of 3`), h("a", { class: "small", href: "#/demo?replay=1" }, "Skip setup and watch the demo")), stepper);

  if (step === 1) {
    const amount = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: w.allowance, "aria-label": "Allowance in tUSD8", name: "allowance" });
    const gas = h("span", { class: "muted" }, "Estimating…");
    const estimate = async () => {
      try {
        const v = DEC6.test(amount.value.trim()) ? toUnits(amount.value.trim()) : 0n;
        const [g, price] = await Promise.all([pub.estimateContractGas({ account: state.account, address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, v] }), pub.getGasPrice()]);
        gas.textContent = `≈ ${Number(formatEther(g * price)).toLocaleString(undefined, { maximumSignificantDigits: 2 })} ${CHAIN.nativeCurrency.symbol}`;
      } catch { gas.textContent = "Shown in your wallet before you confirm"; }
    };
    estimate();
    const next = h("button", { class: "btn big" }, "Continue to permissions", h("span", { class: "arrow" }, ICON.arrow()));
    next.onclick = () => {
      const v = amount.value.trim();
      if (!fieldCheck([[amount, !DEC6.test(v) || !(Number(v) > 0) ? "Enter an amount above 0 with at most 6 decimals." : null]])) return;
      w.allowance = v; if (!(Number(w.budget) > 0) || Number(w.budget) > Number(v)) w.budget = v; wzSave(w); go(2);
    };
    root.append(h("div", { class: "split wz" },
      h("div", { class: "card panel stack", style: "gap:18px" },
        h("div", { class: "stack", style: "gap:6px" }, h("h1", { class: "title" }, "Set a spending allowance"), h("p", { class: "lead" }, "Kindly never holds your funds. You allow it to move up to an exact amount, and only when an invoice passes the Safety Gate or you approve it.")),
        h("label", { class: "amount-label" }, "Allowance", h("div", { class: "amount-field" }, amount, tok())),
        h("p", { class: "small muted" }, "In your wallet: ", money(bal), curAllow > 0n ? h("span", {}, " · currently allowed: ", money(curAllow)) : null),
        next),
      h("div", { class: "card stack approval-facts", style: "gap:14px" },
        h("h2", { class: "h3" }, "Before your wallet asks you to confirm"),
        h("dl", { class: "kv" },
          h("dt", {}, "Token"), h("dd", {}, tok(), " ", addrLink(D.token)),
          h("dt", {}, "Spender"), h("dd", {}, "Kindly contract ", addrLink(D.kindly)),
          h("dt", {}, "Network"), h("dd", {}, aevumChip(CHAIN.id === 44005 ? "Aevum testnet" : CHAIN.name), h("span", { class: "small muted" }, ` chain ${CHAIN.id}`)),
          h("dt", {}, "Estimated gas"), h("dd", {}, gas)),
        h("div", { class: "means" }, h("strong", {}, "What this approval means"),
          h("ul", { class: "plain" }, h("li", {}, "Your tUSD8 stays in your wallet. Nothing is deposited."), h("li", {}, "Kindly can move at most this amount, only to merchants your mandate allows."), h("li", {}, "You can reduce it to 0 or revoke it from the dashboard at any time."))),
        h("p", { class: "small muted" }, "Your wallet will show the same spender address. If it doesn't match, reject the request."))));
  }

  if (step === 2) {
    const agent = h("input", { class: "mono", maxlength: 42, autocomplete: "off", spellcheck: "false", name: "agent", value: w.agent, placeholder: "0x… assistant address" });
    const useDemo = h("button", { type: "button", class: "link small" }, "Use a demo assistant from this browser");
    useDemo.onclick = () => { agent.value = demoKeys().agent.account.address; agent.dispatchEvent(new Event("input")); };
    const merchants = h("input", { class: "mono", autocomplete: "off", spellcheck: "false", name: "merchants", value: w.merchants, placeholder: "0x…, 0x… (comma separated)" });
    const anyM = h("input", { type: "checkbox", checked: w.anyMerchant, name: "anyMerchant" });
    const cap = num(w.cap, { name: "cap" }), budget = num(w.budget, { name: "budget" }), usual = num(w.usual, { name: "usual" });
    const days = h("input", { type: "text", inputmode: "numeric", autocomplete: "off", value: w.days, name: "days" });
    const cooldown = h("input", { type: "text", inputmode: "numeric", autocomplete: "off", value: w.cooldown, name: "cooldown" });
    const verified = h("input", { type: "checkbox", checked: w.verified, name: "verified" });
    const fill = (p) => { const x = PRESETS[p]; cap.value = x.cap; usual.value = x.usual; days.value = x.days; cooldown.value = x.cooldown; verified.checked = x.verified; };
    const preset = (key, rec) => {
      const r = h("input", { type: "radio", name: "preset", value: key, checked: w.preset === key });
      r.onchange = () => { w.preset = key; fill(key); };
      return h("label", { class: "preset" }, r, h("span", { class: "stack", style: "gap:4px" }, h("span", { class: "row", style: "gap:8px" }, h("strong", {}, PRESETS[key].title), rec ? h("span", { class: "chip ok" }, "Recommended") : null), h("span", { class: "small muted" }, PRESETS[key].body)));
    };
    const next = h("button", { class: "btn big" }, "Review permissions", h("span", { class: "arrow" }, ICON.arrow()));
    next.onclick = () => {
      const list = merchants.value.split(",").map((x) => x.trim()).filter(Boolean);
      const ok = fieldCheck([
        [agent, isAddress(agent.value.trim()) ? (agent.value.trim().toLowerCase() === state.account.toLowerCase() ? "Use a separate assistant address, not your own wallet." : null) : "Enter the assistant's 0x address (42 characters)."],
        [merchants, list.some((a) => !isAddress(a)) ? "One of these isn't a valid 0x address." : !anyM.checked && !list.length ? "Add at least one merchant, or tick Any merchant." : null],
        [cap, DEC6.test(cap.value.trim()) && Number(cap.value) > 0 ? null : "Enter an amount above 0."],
        [budget, !(DEC6.test(budget.value.trim()) && Number(budget.value) > 0) ? "Enter an amount above 0." : Number(budget.value) > Number(w.allowance) ? `Keep the budget within your ${w.allowance} tUSD8 allowance, or raise the allowance in step 1.` : null],
        [usual, DEC6.test(usual.value.trim()) ? null : "Enter an amount (0 means no baseline)."],
        [days, /^\d+$/.test(days.value.trim()) && Number(days.value) >= 1 && Number(days.value) <= 365 ? null : "Enter 1 to 365 days."],
        [cooldown, /^\d+$/.test(cooldown.value.trim()) ? null : "Enter whole minutes (0 for none)."],
      ]);
      if (!ok) return;
      Object.assign(w, { agent: getAddress(agent.value.trim()), merchants: list.join(", "), anyMerchant: anyM.checked, cap: cap.value.trim(), budget: budget.value.trim(), usual: usual.value.trim(), days: days.value.trim(), cooldown: cooldown.value.trim(), verified: verified.checked });
      wzSave(w); go(3);
    };
    root.append(h("div", { class: "card panel stack", style: "gap:22px" },
      h("div", { class: "stack", style: "gap:6px" }, h("h1", { class: "title" }, "How much freedom should your agent have?"), h("p", { class: "lead" }, "Pick a starting point, then adjust. Every limit is enforced by the contract, not by the agent.")),
      h("div", { class: "presets", role: "radiogroup", "aria-label": "Preset" }, preset("everyday", true), preset("strict", false)),
      h("div", { class: "grid2" },
        field("Assistant address", agent, useDemo), field("Allowed merchants", merchants, h("label", { class: "check" }, anyM, "Any merchant")),
        field("Payment limit (per payment, tUSD8)", cap), field("Total budget (tUSD8)", budget, `Up to your ${w.allowance} tUSD8 allowance`),
        field("Usual amount (tUSD8)", usual, "Invoices at 3× this or more wait for your approval"), field("Valid for (days)", days),
        field("Cooldown between payments (minutes)", cooldown)),
      h("label", { class: "check" }, verified, "Verified merchants only (others wait for your approval)"),
      h("div", { class: "row between" }, h("a", { class: "btn ghost", href: "#/start?step=1" }, "Back"), next)));
  }

  if (step === 3) {
    if (!isAddress(w.agent || "")) { go(2); return root; }
    const list = w.merchants.split(",").map((x) => x.trim()).filter(Boolean);
    const shield = h("div", { class: "shield-moment", "aria-hidden": "true" }, svg('<path class="sh" d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path class="ck" d="M9 12l2 2 4-4"/>'));
    const status = h("span", { class: "chip" }, "Not authorized");
    const bar = h("div", { class: "bar act" }, h("span", { style: "--w:0" }));
    const activate = h("button", { class: "btn big" }, "Activate mandate", h("span", { class: "arrow" }, ICON.arrow()));
    const backBtn = h("a", { class: "btn ghost", href: "#/start?step=2" }, "Back");
    const hint = h("p", { class: "small muted" }, "Your wallet asks you to confirm up to two transactions: the allowance (if it changed) and the mandate.");
    const after = h("div", { class: "row hidden" }, h("a", { class: "btn dark", href: "#/controls" }, "Go to your dashboard"));
    activate.onclick = async () => {
      state.quiet = true; // the screen itself shows the result; no toasts on top of it
      try {
        const allowance = toUnits(w.allowance);
        const current = await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] });
        // Least privilege: set exactly the chosen allowance, never unlimited.
        if (current !== allowance) await send(activate, `Allow ${w.allowance} tUSD8`, { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, allowance] });
        await send(activate, "Activate mandate", { address: D.kindly, abi: K, functionName: "createMandate", args: [{
          agent: getAddress(w.agent), perPaymentCap: toUnits(w.cap), totalBudget: toUnits(w.budget), typicalAmount: toUnits(w.usual || "0"),
          validUntil: BigInt(Math.floor(Date.now() / 1000) + Number(w.days) * 86400), cooldown: Number(w.cooldown) * 60,
          anyMerchant: w.anyMerchant, requireVerifiedPayee: w.verified, merchants: list.map(getAddress),
        }] });
        sessionStorage.removeItem(WZ_KEY);
        root.classList.add("activated"); activate.classList.add("hidden"); backBtn.classList.add("hidden"); hint.classList.add("hidden"); after.classList.remove("hidden");
        status.className = "chip ok live"; status.textContent = "Active · Limited permissions";
        requestAnimationFrame(() => bar.firstChild.style.setProperty("--w", "1"));
        announce("Mandate active. Your agent now has limited permissions.");
        after.querySelector("a").focus();
      } catch { /* send() already explained the error */ } finally { state.quiet = false; }
    };
    root.append(h("div", { class: "card panel review-card stack", style: "gap:20px" },
      h("div", { class: "row between" }, h("div", { class: "row" }, shield, h("div", { class: "stack", style: "gap:4px" }, h("h1", { class: "title" }, "Your agent is ready"), h("div", { class: "row", style: "gap:14px" }, h("span", { class: "tickline" }, ICON.check(), "Limited authority"), h("span", { class: "tickline" }, ICON.check(), w.verified ? "Verified merchants" : w.anyMerchant ? "Any merchant, held if unusual" : "Your merchants only")))), status),
      bar,
      h("dl", { class: "summary-kv" },
        h("div", {}, h("dt", {}, "Spending allowance"), h("dd", {}, h("span", { class: "n" }, w.allowance), " ", tok())),
        h("div", {}, h("dt", {}, "Total budget"), h("dd", {}, h("span", { class: "n" }, w.budget), " ", tok())),
        h("div", {}, h("dt", {}, "Payment limit"), h("dd", {}, h("span", { class: "n" }, w.cap), " ", tok())),
        h("div", {}, h("dt", {}, "Usual amount"), h("dd", {}, h("span", { class: "n" }, w.usual), " ", tok())),
        h("div", {}, h("dt", {}, "Merchants"), h("dd", {}, w.anyMerchant ? "Any merchant" : `${list.length} allowed`, w.verified ? ", verified only" : "")),
        h("div", {}, h("dt", {}, "Expires"), h("dd", {}, `in ${w.days} day${w.days === "1" ? "" : "s"}`)),
        h("div", {}, h("dt", {}, "Cooldown"), h("dd", {}, Number(w.cooldown) ? `${w.cooldown} min` : "None")),
        h("div", {}, h("dt", {}, "Assistant"), h("dd", {}, addrLink(w.agent)))),
      h("p", { class: "important" }, h("strong", {}, "Important: "), "Your AI can request payments but cannot bypass these contract-enforced limits."),
      h("div", { class: "row between" }, backBtn, h("div", { class: "row" }, activate, after)),
      hint));
  }
  return root;
}

// ------------------------------------------------------------------ HOLD review: reasons first, risk score under technical details
async function viewReview() {
  setTitle("Review payment");
  const id = location.hash.split("?")[0].split("/")[2];
  const root = h("section", { class: "view" });
  if (!/^0x[0-9a-fA-F]{64}$/.test(id || "")) { root.append(h("div", { class: "card" }, h("p", { class: "warn" }, "This review link is incomplete."), h("a", { class: "btn ghost small", href: "#/controls" }, "Back to dashboard"))); return root; }
  if (!state.account) { root.append(connectCard("review this payment")); return root; }
  const [hold, inv] = await Promise.all([pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [id] }), pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] })]);
  const [payee, verified, decs, created] = await Promise.all([
    pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] }),
    pub.readContract({ address: D.registry, abi: R, functionName: "isVerified", args: [inv.merchant] }),
    pub.getContractEvents({ address: D.kindly, abi: K, eventName: "SafetyDecision", args: { invoiceId: id }, fromBlock: fromBlock() }),
    pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoiceCreated", args: { id }, fromBlock: fromBlock() }).catch(() => []),
  ]);
  const ev = decs.filter((x) => DECISION[x.args.decision] === "HOLD").pop();
  const reason = REASON[hold.reason] || (ev ? REASON[ev.args.reason] : "AmountAnomaly");
  const usualAmt = ev?.args.usualAmount ?? 0n;
  const ratio = usualAmt > 0n ? (Number(inv.amount) / Number(usualAmt)) : null;
  const name = sanitizeText(payee.name, 64) || short(inv.merchant);
  const memo = sanitizeText(created[0]?.args?.memo ?? "", 120);
  const why = {
    AmountAnomaly: "This invoice is significantly higher than the usual payment. Kindly paused the transaction until you approve it.",
    PayeeMismatch: "The name registered for this wallet doesn't match the merchant name your agent submitted. Kindly paused it so a look-alike payee can't get paid.",
    PayeeUnverified: "No one has verified this merchant yet, and your mandate only pays verified merchants automatically.",
  }[reason] || "Kindly paused this payment until you decide.";
  const card = h("div", { class: "card panel review stack", style: "gap:22px" });
  const resolved = !hold.active;
  const approve = h("button", { class: "btn ok big" }, ICON.check(), "Approve payment");
  const reject = h("button", { class: "btn danger big" }, ICON.cross(), "Reject");
  approve.onclick = async () => {
    state.quiet = true;
    try {
      await ensureAllowance(approve, inv.amount);
      const { hash, result } = await send(approve, "Approve payment", { address: D.kindly, abi: K, functionName: "approveHold", args: [id, nameHash(payee.name)] });
      card.replaceChildren(receiptCard({ amount: inv.amount, merchantName: payee.name, merchant: inv.merchant, memo, invoiceId: id, hash, receipt: result, mandateId: hold.mandateId, decision: "HOLD", approved: true, risk: hold.risk }));
    } catch { /* explained by send() */ } finally { state.quiet = false; }
  };
  reject.onclick = async () => {
    if (!confirm(`Reject this ${fromUnits(inv.amount)} tUSD8 payment to “${name}”? Nothing will be paid.`)) return;
    try { await send(reject, "Reject payment", { address: D.kindly, abi: K, functionName: "rejectHold", args: [id] }); location.hash = "/controls"; } catch { /* explained */ }
  };
  card.append(
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "New payment request"), h("h1", { class: "title" }, "Invoice received")),
      resolved ? statusChip("confirmed", "Resolved") : statusChip("pending", "Under review")),
    h("div", { class: "review-amt" }, h("span", { class: "n" }, fmt(inv.amount)), tok()),
    h("dl", { class: "summary-kv" },
      h("div", {}, h("dt", {}, "Merchant"), h("dd", {}, name, " ", verified ? statusChip("verified", "Verified") : h("span", { class: "chip amber" }, "Not verified"))),
      h("div", {}, h("dt", {}, "Invoice"), h("dd", {}, memo || "No memo")),
      h("div", {}, h("dt", {}, "Usual amount"), h("dd", {}, usualAmt > 0n ? money(usualAmt) : "No history yet")),
      h("div", {}, h("dt", {}, "Difference"), h("dd", { class: ratio ? "hold-ink" : "" }, ratio ? `${ratio.toLocaleString(undefined, { maximumFractionDigits: 2 })}× usual` : "Not applicable"))),
    h("div", { class: "why-box" }, h("div", { class: "row between" }, h("h2", { class: "h3" }, "Why it's on hold"), stamp("HOLD", true)), h("p", {}, why)),
    h("div", { class: "grid2 outcomes" },
      h("div", {}, h("strong", {}, "If you approve"), h("p", { class: "small muted" }, `Kindly pays ${fromUnits(inv.amount)} tUSD8 from your wallet to ${name}, once. Your mandate's limits don't change.`)),
      h("div", {}, h("strong", {}, "If you reject"), h("p", { class: "small muted" }, "Nothing is paid. The invoice stays unpaid and the merchant can send a corrected one."))),
    resolved ? h("p", { class: "calm" }, ICON.check(), `This hold was already resolved. Invoice status: ${STATUS[inv.status]}.`) : h("div", { class: "row" }, approve, reject),
    h("details", {}, h("summary", {}, "Technical details"), h("div", { class: "body" }, h("dl", { class: "kv" },
      h("dt", {}, "Safety Gate"), h("dd", {}, `HOLD · ${reason}`),
      h("dt", {}, "Risk score"), h("dd", {}, riskView(hold.risk)),
      h("dt", {}, "Mandate"), h("dd", {}, `#${hold.mandateId}`),
      h("dt", {}, "Invoice ID"), h("dd", {}, hashChip(id, "invoice")),
      ev ? [h("dt", {}, "Decision tx"), h("dd", {}, txLink(ev.transactionHash))] : null,
      h("dt", {}, "Merchant address"), h("dd", {}, addrLink(inv.merchant)),
      h("dt", {}, "Held at"), h("dd", {}, new Date(Number(hold.heldAt) * 1000).toLocaleString())))));
  root.append(h("a", { class: "back", href: "#/controls" }, "Back to dashboard"), card);
  return root;
}

/** Kindly receipt: easy to save, share and verify. Only public on-chain facts, no personal metadata. */
function receiptCard({ amount, merchantName, merchant, memo, invoiceId, hash, receipt, mandateId, decision, approved, risk, paidBy }) {
  const viaAgent = mandateId && BigInt(mandateId) > 0n;
  return h("div", { class: "success receipt" },
    h("span", { class: "ring" }, svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')),
    h("div", { class: "stack", style: "gap:4px; justify-items:center" }, h("span", { class: "small muted" }, "Kindly receipt"), statusChip("confirmed", "Confirmed")),
    h("h2", {}, "Payment complete"),
    h("p", { class: "muted" }, "Verified and executed on-chain."),
    h("div", { class: "review-amt" }, h("span", { class: "n" }, fmt(amount)), tok()),
    h("dl", {},
      h("dt", {}, "Paid to"), h("dd", {}, sanitizeText(merchantName, 64) || "Merchant", merchant ? [" ", addrLink(merchant)] : null),
      h("dt", {}, "Invoice"), h("dd", {}, sanitizeText(memo) || "No memo"),
      h("dt", {}, "Safety decision"), h("dd", {}, viaAgent ? (approved ? `HOLD, approved by you${risk != null ? ` · Risk ${risk}` : ""}` : `${decision || "PAY"}${risk != null ? ` · Risk ${risk}` : ""}`) : "Direct payment · payee name confirmed"),
      paidBy ? [h("dt", {}, "Paid by"), h("dd", {}, addrLink(paidBy))] : null,
      h("dt", {}, "Network"), h("dd", {}, aevumChip(CHAIN.id === 44005 ? "Aevum testnet" : CHAIN.name)),
      hash ? [h("dt", {}, "Transaction"), h("dd", {}, txLink(hash))] : null,
      h("dt", {}, "Receipt"), h("dd", {}, hashChip(receipt, "receipt"))),
    h("div", { class: "row", style: "justify-content:center" },
      hash && explorerLink(hash) ? h("a", { class: "btn ghost", href: explorerTx(CHAIN.id, hash), target: "_blank", rel: "noopener" }, "View on explorer", ICON.ext()) : null,
      invoiceId ? h("a", { class: "btn ghost", href: `#/activity?id=${invoiceId}` }, "Verify receipt") : null,
      h("a", { class: "btn dark", href: "#/controls" }, "Done")));
}

// ------------------------------------------------------------------ Invoices: Send · Pay · Receipts
const invoiceTabs = (active) => h("nav", { class: "tabs", "aria-label": "Invoices" },
  [["send", "#/merchant", "Send"], ["pay", "#/pay", "Pay"], ["receipts", "#/activity", "Receipts"]].map(([k, href, t]) => h("a", { href, class: k === active ? "active" : "", "aria-current": k === active ? "page" : null }, t)));
function invoicesShell(active, title, lead) {
  setTitle(title);
  return h("section", { class: "view" }, pageHead("Invoices", title, lead), invoiceTabs(active));
}

async function viewMerchant() {
  const root = invoicesShell("send", "Get paid by link or QR", "Create a stablecoin invoice. Payers see your verified name before they pay.");
  if (!state.account) { root.append(connectCard("send invoices")); return root; }
  requireWallet();
  const payee = await pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [state.account] });
  const verified = await pub.readContract({ address: D.registry, abi: R, functionName: "isVerified", args: [state.account] });
  const nameIn = h("input", { value: payee.name || "", maxlength: 64, placeholder: "e.g. Sunrise Coffee Co…", name: "organization", autocomplete: "organization" });
  const uriIn = h("input", { type: "url", value: payee.metadataURI || "", maxlength: 256, placeholder: "https://… (optional)", name: "url", autocomplete: "url", spellcheck: "false" });
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
          verified ? statusChip("verified", "Verified merchant") : statusChip("pending", "Awaiting verification"))
      : h("h3", {}, "Register your business"),
    payee.active ? h("details", {}, h("summary", {}, "Edit profile"), h("div", { class: "body" }, profileForm)) : profileForm));
  if (!payee.active) return root;

  const num = h("input", { class: "mono", maxlength: 31, name: "invoiceNumber", autocomplete: "off", spellcheck: "false", value: `INV-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 900 + 100)}` });
  const amt = h("input", { type: "text", placeholder: "0.00", inputmode: "decimal", autocomplete: "off", name: "amount", "aria-label": "Amount in tUSD8" });
  const payer = h("input", { placeholder: "0x… (optional, empty means anyone)", class: "mono", maxlength: 42, name: "payer", autocomplete: "off", spellcheck: "false" });
  const hours = h("input", { type: "text", inputmode: "numeric", value: "24", name: "hours", autocomplete: "off" });
  const memo = h("input", { maxlength: 280, placeholder: "e.g. Order 1042", name: "memo", autocomplete: "off" });
  const out = h("div", { class: "share" }, h("p", { class: "muted small" }, "Your payment link and QR code will appear here."));
  const createBtn = h("button", { class: "btn big wide" }, "Create invoice");
  createBtn.onclick = async () => {
    if (!fieldCheck([
      [amt, !(Number(amt.value) > 0) || !DEC6.test(amt.value.trim()) ? "Enter an amount above 0 with at most 6 decimals." : null],
      [num, num.value.trim() ? null : "Enter an invoice number."],
      [payer, payer.value.trim() && !isAddress(payer.value.trim()) ? "Enter a valid 0x address, or leave it empty." : null],
      [hours, /^\d+$/.test(hours.value.trim()) && Number(hours.value) >= 1 && Number(hours.value) <= 8760 ? null : "Enter 1 to 8760 hours."],
    ])) { if (amt.getAttribute("aria-invalid") !== "true" && (payer.getAttribute("aria-invalid") || hours.getAttribute("aria-invalid"))) amt.closest(".card").querySelector("details").open = true; return; }
    if (PII.test(memo.value) && !confirm("The memo looks like it contains personal data (an email, phone number or address). Memos are public on-chain forever. Create the invoice anyway?")) return;
    const exp = BigInt(Math.floor(Date.now() / 1000) + Math.min(8760, Math.max(1, Math.floor(Number(hours.value) || 24))) * 3600);
    const { result: id } = await send(createBtn, "Create invoice", { address: D.kindly, abi: K, functionName: "createInvoice", args: [refFromNumber(num.value.trim()), payer.value.trim() ? getAddress(payer.value.trim()) : zeroAddress, toUnits(amt.value.trim()), exp, sanitizeText(memo.value, 280)] });
    const link = paymentLink(location.href.split("#")[0], id, payee.name);
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: "#302E2B", light: "#ffffff" } });
    out.replaceChildren(
      statusChip("confirmed", "Invoice created"),
      h("img", { src: qr, alt: "Payment QR code", width: 220, height: 220 }),
      h("div", { class: "amt" }, money(toUnits(amt.value.trim()))), h("span", { class: "mono muted" }, num.value.trim()),
      h("input", { value: link, readonly: true, class: "mono", "aria-label": "Payment link", onclick: (e) => e.target.select() }),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn dark", onclick: () => navigator.clipboard.writeText(link).then(() => toast("Link copied", "ok")) }, ICON.copy(), "Copy payment link"),
        h("a", { class: "btn ghost", href: `#/pay/${id}?n=${encodeURIComponent(payee.name)}` }, "Open payer view")));
    loadList();
  };
  root.append(h("div", { class: "split" },
    h("div", { class: "card panel" }, h("h3", {}, "Create invoice"),
      h("label", { class: "amount-label" }, "Amount", h("div", { class: "amount-field" }, amt, tok())),
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
      rows.push(h("tr", {}, h("td", {}, hashChip(lg.args.id, "invoice")), h("td", { class: "memo-cell" }, sanitizeText(lg.args.memo, 60) || h("span", { class: "muted" }, "No memo")), h("td", { class: "num" }, fmt(inv.amount)),
        h("td", {}, h("span", { class: `chip s-${st}` }, st), " ", inv.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${inv.mandateId}`) : ""), h("td", {}, actions)));
    }
    list.replaceChildren(h("h3", {}, "My invoices"), rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["ID", "Memo", "tUSD8", "Status", ""].map((t, i) => h("th", { class: i === 2 ? "num" : "" }, t)))), h("tbody", {}, rows))) : h("p", { class: "muted" }, "No invoices yet. Create one above and share the link or QR code."));
  }
  loadList().catch((e) => list.replaceChildren(h("p", { class: "warn" }, humanError(e))));
  return root;
}

async function viewPay() {
  const parsed = parsePaymentHash(location.hash);
  if (!parsed) {
    const root = invoicesShell("pay", "Pay an invoice", "Open a payment link, or paste an invoice ID and the merchant name you were given.");
    const idIn = h("input", { placeholder: "0x… invoice ID", class: "mono", maxlength: 66, name: "invoiceId", autocomplete: "off", spellcheck: "false" });
    const nIn = h("input", { placeholder: "e.g. Sunrise Coffee Co…", maxlength: 64, name: "merchantName", autocomplete: "off" });
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
  const expectedIn = h("input", { value: parsed.expectedName ?? "", placeholder: "e.g. Sunrise Coffee Co…", maxlength: 64, name: "merchantName", autocomplete: "off" });
  const payto = h("div", { class: "payto" });
  const payBtn = h("button", { class: "btn big wide" }, `Pay ${fmt(inv.amount)} tUSD8`);
  const card = h("div", { class: "card request" });
  let confirmation = 0;
  async function runCoP() {
    const exp = expectedIn.value;
    confirmation = Number(await pub.readContract({ address: D.registry, abi: R, functionName: "confirm", args: [inv.merchant, nameHash(exp)] }));
    const view = {
      MatchVerified: ["ok", "Verified merchant", "The wallet name matches this merchant."],
      MatchUnverified: ["amber", "Name matches, not verified yet", "No one has verified this business. Pay only if you trust it."],
      NoMatch: ["bad", "Name does not match", `This address is registered as “${sanitizeText(payee.name, 64)}”, not “${sanitizeText(exp, 64)}”. It could be a scam. Don't pay.`],
      Unregistered: ["bad", "Unknown payee", "This address is not a registered merchant."],
    }[CONFIRMATION[confirmation]];
    payto.className = `payto ${view[0]}`;
    payto.replaceChildren(h("span", { class: "eyebrow" }, "Paying to"), h("div", { class: "name" }, sanitizeText(payee.name, 64) || "Unregistered address"), h("span", { class: "status" }, view[0] === "ok" ? ICON.check() : view[0] === "bad" ? ICON.cross() : ICON.pause(), view[1]), h("span", { class: "small" }, view[2]), h("span", { class: "small muted" }, addrLink(inv.merchant)));
    payBtn.disabled = !(confirmation >= 2) || STATUS[inv.status] !== "Open";
  }
  const paidView = (hash, receipt, paidBy, mandateId) => card.replaceChildren(receiptCard({ amount: inv.amount, merchantName: payee.name, merchant: inv.merchant, memo, invoiceId, hash, receipt, mandateId: mandateId ?? inv.mandateId, paidBy }));
  expectedIn.addEventListener("input", () => runCoP().catch(() => {}));
  payBtn.onclick = async () => {
    if (!state.account) await connect({ rerender: false });
    const dup = await pub.readContract({ address: D.kindly, abi: K, functionName: "settledRef", args: [keccakRefKey(state.account, inv.merchant, inv.ref)] });
    if (dup) return toast("You already paid this invoice number to this merchant. Kindly blocks duplicates.", "error");
    if (CONFIRMATION[confirmation] === "MatchUnverified" && !confirm("This merchant is not verified. Pay anyway?")) return;
    if (!confirm(`Pay ${fmt(inv.amount)} tUSD8 to “${sanitizeText(payee.name, 64)}” (${inv.merchant})? Payments on-chain can't be reversed except by a merchant refund.`)) return;
    await ensureAllowance(payBtn, inv.amount);
    const { hash, result: receipt } = await send(payBtn, "Pay invoice", { address: D.kindly, abi: K, functionName: "payInvoice", args: [invoiceId, nameHash(expectedIn.value), inv.amount] });
    paidView(hash, receipt, state.account, 0n);
  };
  const st = STATUS[inv.status];
  const expired = Date.now() / 1000 > Number(inv.expiresAt);
  if (st === "Paid" || st === "Refunded") { paidView(null, inv.receipt, inv.paidBy); root.append(card); return root; }
  await runCoP();
  card.append(...[
    h("div", { class: "row between" }, h("span", { class: "eyebrow" }, "Payment request"), h("div", { class: "row", style: "gap:6px" }, aevumChip(), h("span", { class: `chip s-${st}` }, expired && st === "Open" ? "Expired" : st))),
    h("div", { class: "amount" }, h("span", { class: "n" }, fmt(inv.amount)), tok()),
    h("p", { class: "for" }, sanitizeText(memo) || "No memo"),
    payto,
    h("label", {}, "Name you were told (Confirmation of Payee)", expectedIn),
    st === "Open" && !expired ? payBtn : null,
    h("div", { class: "secured" }, ICON.gate(), "Secured by Kindly Safety Gate · expires ", new Date(Number(inv.expiresAt) * 1000).toLocaleString()),
    h("div", { class: "secured" }, "Your tokens stay in your wallet until this payment. ", trustLink("What's visible on-chain", "privacy")),
    inv.payer !== zeroAddress ? h("p", { class: "small muted", style: "text-align:center" }, "Billed to ", addrLink(inv.payer)) : null].filter(Boolean));
  root.append(card);
  return root;
}
const keccakRefKey = (payer, merchant, ref) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [payer, merchant, ref]));

async function viewActivity() {
  const root = invoicesShell("receipts", "Receipts", "Every payment produces an on-chain receipt anyone can verify.");
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const idIn = h("input", { value: q.get("id") || "", placeholder: "0x… invoice ID", class: "mono", maxlength: 66, name: "invoiceId", autocomplete: "off", spellcheck: "false" });
  const out = h("div", {});
  const vbtn = h("button", { class: "btn dark" }, "Verify receipt");
  vbtn.onclick = async () => {
    try {
      const id = idIn.value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("Invoice ID must be 0x followed by 64 hex characters.");
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] });
      const ok = await pub.readContract({ address: D.kindly, abi: K, functionName: "verifyReceipt", args: [id, inv.receipt] });
      if (!ok) return out.replaceChildren(h("div", { class: "cop bad" }, h("strong", {}, "No valid receipt for this invoice"), h("p", {}, `Status: ${STATUS[inv.status]}. A receipt exists only after the invoice is paid.`)));
      const [payee, paid, created] = await Promise.all([
        pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] }),
        pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoicePaid", args: { id }, fromBlock: fromBlock() }).catch(() => []),
        pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoiceCreated", args: { id }, fromBlock: fromBlock() }).catch(() => []),
      ]);
      const decs = inv.mandateId > 0n ? await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "SafetyDecision", args: { invoiceId: id }, fromBlock: fromBlock() }).catch(() => []) : [];
      const last = decs[decs.length - 1]?.args;
      out.replaceChildren(h("div", { class: "card receipt-wrap" }, receiptCard({ amount: inv.amount, merchantName: payee.name, merchant: inv.merchant, memo: created[0]?.args?.memo, invoiceId: null, hash: paid[0]?.transactionHash, receipt: inv.receipt, mandateId: inv.mandateId, decision: last ? DECISION[last.decision] : null, approved: last && DECISION[last.decision] === "HOLD", risk: last?.risk, paidBy: inv.paidBy })));
    } catch (e) { out.replaceChildren(h("p", { class: "warn" }, e.message?.startsWith("Invoice ID") ? e.message : humanError(e))); }
  };
  root.append(h("div", { class: "card panel" }, h("h3", {}, "Verify a receipt"), h("div", { class: "row", style: "align-items:end" }, h("label", { style: "flex:1;min-width:240px" }, "Invoice ID", idIn), vbtn), out));
  const feed = h("div", { class: "card" }, h("h3", {}, "Latest settlements"), skeleton());
  root.append(feed);
  if (D.kindly) {
    const logs = await pub.getContractEvents({ address: D.kindly, abi: K, eventName: "InvoicePaid", fromBlock: fromBlock() }).catch(() => []);
    const rows = logs.reverse().slice(0, 30).map((lg) => h("tr", {}, h("td", {}, txLink(lg.transactionHash)), h("td", { class: "num" }, fmt(lg.args.amount)), h("td", {}, addrLink(lg.args.merchant)),
      h("td", {}, lg.args.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${lg.args.mandateId}`) : h("span", { class: "chip" }, "direct")), h("td", {}, hashChip(lg.args.receipt, "receipt"))));
    feed.replaceChildren(h("h3", {}, "Latest settlements"), rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Transaction", "tUSD8", "Merchant", "Path", "Receipt"].map((t, i) => h("th", { class: i === 1 ? "num" : "" }, t)))), h("tbody", {}, rows))) : h("p", { class: "muted" }, "No payments yet. Receipts appear here as soon as an invoice is paid."));
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
    else if (path.startsWith("/start")) v = await viewStart();
    else if (path.startsWith("/review/")) v = await viewReview();
    else if (path.startsWith("/invoices") || path.startsWith("/merchant")) v = await viewMerchant();
    else if (path.startsWith("/pay")) v = await viewPay();
    else if (path.startsWith("/activity")) v = await viewActivity();
    else v = viewHome();
    $app.replaceChildren(v);
  } catch (e) {
    $app.replaceChildren(h("section", { class: "view" }, h("div", { class: "card" }, h("p", { class: "warn" }, humanError(e)), h("div", { class: "row" }, h("button", { class: "btn ghost small", onclick: () => route() }, "Try again"), h("a", { class: "btn ghost small", href: "#/" }, "Go home")))));
  }
}
document.getElementById("connect").onclick = () => (state.account ? toggleWalletPanel() : connect().catch((e) => toast(humanError(e), "error")));
window.addEventListener("hashchange", () => { document.getElementById("walletPop")?.remove(); route(); window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" }); });
window.addEventListener("scroll", () => document.querySelector(".top")?.classList.toggle("scrolled", window.scrollY > 4), { passive: true });
if (!D.kindly) banner(`Kindly is not deployed on ${CHAIN.name} yet. Read-only mode. Test tokens: ${FAUCET_URL}`);
else if (CHAIN.id !== 44005) banner(`Local development chain (${CHAIN.name}). Testnet tokens only.`);
void REASON;
refreshHeader();
setInterval(refreshHeader, 15000);
route();
