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
import judgeRuns from "./judge-runs.json";
import "./app-shell.css";
import { initPwa, installSection, isStandalone, isMobileDevice, dragToDismiss } from "./pwa.js";

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
/** Haptics are punctuation: one short tick per outcome, on the same frame as the visual, never the only feedback (Android; iOS Safari has no web vibration). */
const haptic = (kind) => { if (!navigator.vibrate || reduceMotion() || window.innerWidth > 1024) return; try { navigator.vibrate(kind === "error" ? [12, 60, 12] : 10); } catch {} };
function toast(msg, kind = "info") {
  if (kind === "ok" || kind === "error") haptic(kind);
  let box = document.getElementById("toasts");
  if (!box) { box = h("div", { id: "toasts", "aria-live": "polite" }); document.body.append(box); }
  // Snackbar rules (Wise, Material, Geist via component.gallery): one short line, newest nearest the thumb, errors stay
  // until dismissed and carry a close button, exits are faster than entrances.
  const leave = () => { if (t.classList.contains("leaving")) return; t.classList.add("leaving"); setTimeout(() => t.remove(), reduceMotion() ? 0 : 150); };
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, h("span", { class: "toast-msg" }, msg),
    kind === "error" ? h("button", { type: "button", class: "toast-x", "aria-label": "Dismiss", onclick: leave }, ICON.close()) : null);
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  if (kind !== "error") { let timer = setTimeout(leave, 4500); t.onpointerenter = () => clearTimeout(timer); t.onpointerleave = () => (timer = setTimeout(leave, 2500)); }
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
// One outline icon family: Lucide (ISC), inlined, currentColor. Kindly's own marks (gate, token, Aevum) stay custom; the MetaMask fox is the official file. No emoji glyphs.
const ICON = {
  activity: () => svg('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'),
  lock: () => svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/> <path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  bell: () => svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/> <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  help: () => svg('<circle cx="12" cy="12" r="10"/> <path d="m4.93 4.93 4.24 4.24"/> <path d="m14.83 9.17 4.24-4.24"/> <path d="m14.83 14.83 4.24 4.24"/> <path d="m9.17 14.83-4.24 4.24"/> <circle cx="12" cy="12" r="4"/>'),
  logout: () => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/> <polyline points="16 17 21 12 16 7"/> <line x1="21" x2="9" y1="12" y2="12"/>'),
  chev: () => svg('<path d="m9 18 6-6-6-6"/>'),
  file: () => svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/> <path d="M14 2v4a2 2 0 0 0 2 2h4"/> <path d="M10 9H8"/> <path d="M16 13H8"/> <path d="M16 17H8"/>'),
  check: () => svg('<path d="M20 6 9 17l-5-5"/>'),
  pause: () => svg('<rect x="14" y="4" width="4" height="16" rx="1"/> <rect x="6" y="4" width="4" height="16" rx="1"/>'),
  cross: () => svg('<path d="M18 6 6 18"/> <path d="m6 6 12 12"/>'),
  shield: () => svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/> <path d="m9 12 2 2 4-4"/>'),
  // Kindly's Safety Gate glyph: a shield holding three connected nodes (agent, rules, merchant).
  gate: () => svg('<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><circle cx="12" cy="9.2" r="1.5"/><circle cx="8.9" cy="14.2" r="1.5"/><circle cx="15.1" cy="14.2" r="1.5"/><path d="M11.2 10.5l-1.5 2.4M12.8 10.5l1.5 2.4M10.4 14.2h3.2"/>'),
  wallet: () => svg('<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/> <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>'),
  copy: () => svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  ext: () => svg('<path d="M15 3h6v6"/> <path d="M10 14 21 3"/> <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  snow: () => svg('<line x1="2" x2="22" y1="12" y2="12"/> <line x1="12" x2="12" y1="2" y2="22"/> <path d="m20 16-4-4 4-4"/> <path d="m4 8 4 4-4 4"/> <path d="m16 4-4 4-4-4"/> <path d="m8 20 4-4 4 4"/>'),
  play: () => svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
  spark: () => svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/> <path d="M20 3v4"/> <path d="M22 5h-4"/> <path d="M4 17v2"/> <path d="M5 18H3"/>'),
  aevum: () => svg('<path d="M12 3.5l7.5 8.5-7.5 8.5L4.5 12z"/><path d="M12 8.5l3.2 3.5-3.2 3.5L8.8 12z"/>'),
  arrow: () => svg('<path d="M5 12h14"/> <path d="m12 5 7 7-7 7"/>'),
  home: () => svg('<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/> <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  receipt: () => svg('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/> <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/> <path d="M12 17.5v-11"/>'),
  gear: () => svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/> <circle cx="12" cy="12" r="3"/>'),
  phone: () => svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/> <path d="M12 18h.01"/>'),
  close: () => svg('<path d="M18 6 6 18"/> <path d="m6 6 12 12"/>'),
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
  if (!window.ethereum) return noWalletSheet();
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!addr) return;
  state.account = getAddress(addr);
  state.wallet = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum), account: state.account });
  // Graceful mismatch: a refused switch keeps the wallet connected; the banner and badge say so and nothing is sent.
  await ensureChain().catch(() => toast(`Connected, but your wallet is on another network. Switch to ${CHAIN.name} to send anything.`, "error"));
  window.ethereum.on?.("accountsChanged", (accs) => { if (accs && accs.length) return location.reload(); disconnectLocal(); });
  window.ethereum.on?.("chainChanged", () => location.reload());
  await refreshHeader();
  if (rerender) route();
}
/** Disconnected in the wallet: forget the account here too, keep the app usable read-only. */
function disconnectLocal() {
  state.account = null; state.wallet = null; state.wrongNet = false;
  document.getElementById("walletPop")?.remove();
  const c = document.getElementById("connect");
  c.className = "btn dark small"; c.removeAttribute("aria-haspopup"); c.removeAttribute("aria-expanded"); c.removeAttribute("aria-label");
  c.replaceChildren(ICON.wallet(), h("span", {}, "Connect"));
  document.getElementById("swName").textContent = "Not connected"; document.getElementById("swName").className = ""; document.getElementById("swNet").textContent = "Connect a wallet";
  toast("Wallet disconnected. You can still explore the demo.");
  paintMode(); route();
}
/** The official MetaMask fox (brand pack from metamask.io/assets), shown unmodified next to the MetaMask name. */
const fox = (size = 20) => h("img", { class: "fox", src: "./brand/metamask-fox.svg", alt: "", width: size, height: size });
/** Deep link that opens this exact page inside the MetaMask mobile browser. */
const metamaskLink = () => `https://link.metamask.io/dapp/${location.host}${location.pathname}${location.search}${location.hash}`;
/** No injected wallet: on phones, offer "Open in MetaMask"; on desktop, explain the extension. Either way the replay stays one tap away. */
function noWalletSheet() {
  const mobile = isMobileDevice();
  sheet("No wallet in this browser", [
    h("p", { class: "muted" }, mobile
      ? "Phone browsers can't talk to a wallet directly. Open Kindly inside the MetaMask app's browser and connect from there. Your keys never leave MetaMask."
      : "Kindly connects to a browser wallet such as the MetaMask extension. Install it, reload this page, then connect."),
    mobile ? h("a", { class: "btn mm big wide", href: metamaskLink(), rel: "noopener" }, fox(22), "Open in MetaMask") : h("a", { class: "btn mm big wide", href: "https://metamask.io/download/", target: "_blank", rel: "noopener" }, fox(22), "Get MetaMask"),
    mobile ? h("ol", { class: "plain small" }, h("li", {}, "MetaMask opens this page in its own browser."), h("li", {}, "Tap Connect and pick an account."), h("li", {}, "Switch to QDay Aevum Testnet when asked.")) : null,
    h("hr", { class: "sep" }),
    h("p", { class: "small muted" }, "Just looking? The guided demo replays real recorded testnet transactions and needs no wallet."),
    h("a", { class: "btn ghost wide", href: "#/judge", "data-close": "" }, ICON.play(), "Explore the guided demo"),
  ]);
}
/** Bottom sheet on phones, centred dialog on larger screens. Native <dialog>: focus trap, Escape and backdrop close. */
function sheet(title, body) {
  document.getElementById("sheet")?.remove();
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, ICON.close());
  const grab = h("div", {}, h("div", { class: "grabber", "aria-hidden": "true" }), h("div", { class: "row between" }, h("h2", { id: "sheet-title", class: "h3" }, title), close));
  const dlg = h("dialog", { id: "sheet", class: "modal sheet", "aria-labelledby": "sheet-title" }, grab, ...[body].flat().filter(Boolean));
  dragToDismiss(dlg, grab, () => dlg.close());
  close.onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest?.("[data-close]")) dlg.close(); });
  document.body.append(dlg); dlg.showModal();
  return dlg;
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
/** Persistent mode badge: says, on every screen, whether what you see is sample/recorded data or your live testnet wallet. */
function paintMode() {
  const el = document.getElementById("mode"); if (!el) return;
  const local = CHAIN.id !== 44005;
  const replay = document.body.dataset.replay === "1";
  let kind, key, rest;
  if (replay) [kind, key, rest] = ["demo", "DEMO MODE", "replay of recorded testnet transactions · no wallet involved"];
  else if (local) [kind, key, rest] = ["local", "LOCAL REHEARSAL", "private test chain · not real data"];
  else if (!state.account) [kind, key, rest] = ["demo", "DEMO MODE", "sample & recorded data · connect a wallet to go live"];
  else if (state.wrongNet) [kind, key, rest] = ["warn", "LIVE TESTNET", "wallet connected · wrong network, switch to Aevum"];
  else [kind, key, rest] = ["live", "LIVE TESTNET", "wallet connected · network verified"];
  el.className = `mode ${kind}`;
  el.replaceChildren(h("span", { class: "mode-dot", "aria-hidden": "true" }), h("b", {}, key), h("span", { class: "mode-rest" }, rest));
  el.setAttribute("aria-label", `${key}: ${rest}`);
}
let lastBlock = null;
/** Network pill → a sheet with the network's name, chain ID and what "testnet" means here. */
function networkSheet() {
  const local = CHAIN.id !== 44005;
  sheet(local ? "Local rehearsal chain" : "QDay Aevum Testnet", [
    h("dl", { class: "kv" },
      h("dt", {}, "Network"), h("dd", {}, local ? `${CHAIN.name} (on this computer)` : "QDay Aevum Testnet"),
      h("dt", {}, "Chain ID"), h("dd", {}, h("code", {}, String(CHAIN.id))),
      h("dt", {}, "Latest block"), h("dd", {}, lastBlock != null ? `#${lastBlock}` : "Unreachable right now"),
      h("dt", {}, "Your wallet"), h("dd", {}, !state.account ? "Not connected" : state.wrongNet ? "On another network" : "On this network")),
    h("p", { class: "small muted" }, local
      ? "A private chain that runs only on this computer, for rehearsing. Nothing here is real data or real money."
      : "A public test network. tQDAY and tUSD8 are free test tokens with no value; never send real funds to these contracts."),
    state.wrongNet ? h("button", { class: "btn dark wide", type: "button", "data-close": "", onclick: () => ensureChain().then(refreshHeader).catch((e) => toast(humanError(e), "error")) }, "Switch network") : null,
    local ? null : h("a", { class: "btn ghost wide", href: FAUCET_URL, target: "_blank", rel: "noopener" }, "Get test tokens", ICON.ext()),
  ]);
}
async function refreshHeader() {
  const net = document.getElementById("net");
  const label = CHAIN.id === 44005 ? "Aevum" : "Local";
  try {
    const bn = await pub.getBlockNumber(); lastBlock = bn;
    net.replaceChildren(ICON.aevum(), h("span", { class: "net-l" }, label), h("span", { class: "sr-only" }, ` testnet, chain ${CHAIN.id}. Network details`));
    net.title = `${CHAIN.name} · chain ${CHAIN.id} · block #${bn}`;
    net.className = "net ok";
  } catch {
    lastBlock = null;
    net.replaceChildren(ICON.aevum(), h("span", {}, `${label} unreachable`));
    net.className = "net bad";
  }
  net.onclick = networkSheet;
  if (state.account && window.ethereum) {
    const hex = await window.ethereum.request({ method: "eth_chainId" }).catch(() => null);
    state.wrongNet = hex != null && Number(hex) !== CHAIN.id;
    document.body.classList.toggle("wrong-net", state.wrongNet);
    const wn = document.getElementById("wrongNet");
    if (state.wrongNet && !wn) document.getElementById("banner").after(h("div", { id: "wrongNet", class: "netwarn", role: "alert" }, h("span", {}, `Your wallet is on another network. Kindly runs on ${CHAIN.name}. Nothing will be sent until you switch.`), h("button", { class: "btn dark small", type: "button", onclick: () => ensureChain().then(refreshHeader).catch((e) => toast(humanError(e), "error")) }, "Switch network")));
    else if (!state.wrongNet) wn?.remove();
  }
  if (state.account) {
    state.balance = D.token ? await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }).catch(() => state.balance ?? 0n) : 0n;
    const c = document.getElementById("connect");
    c.replaceChildren(h("span", { class: `cdot ${state.wrongNet ? "warn" : ""}`, "aria-hidden": "true" }), h("span", { class: "pill-txt" }, h("b", {}, state.wrongNet ? "Wrong network" : "Connected"), h("span", { class: "mono" }, short(state.account))));
    c.className = "addr-pill"; c.setAttribute("aria-haspopup", "dialog"); c.setAttribute("aria-expanded", String(!!document.getElementById("walletPop")));
    c.setAttribute("aria-label", `${state.wrongNet ? "Wrong network" : "Connected"}: wallet ${short(state.account)}. Show balance`);
    const pop = document.getElementById("walletPop"); if (pop) pop.querySelector(".wp-bal")?.replaceChildren(money(state.balance, "big"));
    const swn = document.getElementById("swName"); swn.textContent = short(state.account); swn.className = "mono";
    document.getElementById("swNet").textContent = state.wrongNet ? "Wrong network" : `${fmt(state.balance ?? 0n)} tUSD8 · ${CHAIN.id === 44005 ? "Aevum" : CHAIN.name}`;
    document.getElementById("sideWallet").setAttribute("aria-label", `Wallet ${short(state.account)}. Show balance`);
  }
  paintMode();
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
    h("a", { class: "btn dark small wide", href: "#/", onclick: () => close() }, "Open Home"));
  const gz = h("div", {}, h("div", { class: "grabber", "aria-hidden": "true" })); pop.prepend(gz); dragToDismiss(pop, gz, () => { close(); btn.focus(); });
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
  if (!signer && state.wrongNet) { await ensureChain().catch(() => {}); await refreshHeader(); if (state.wrongNet) { const e = new Error(`Switch your wallet to ${CHAIN.name} first. Nothing was sent.`); toast(e.message, "error"); throw e; } }
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
/** Kindly's event history. Aevum's public RPC answers eth_getLogs for at most 1,000 blocks, so the history is read
 *  once in 1,000-block slices (a few in parallel), cached, and topped up incrementally. Filtering happens in memory. */
const LOG_SPAN = CHAIN.id === 44005 ? 1000n : 1_000_000n;
const logCache = { to: null, logs: [], pending: null };
function kindlyLogs() {
  if (logCache.pending) return logCache.pending;
  logCache.pending = (async () => {
    const head = await pub.getBlockNumber();
    const start = logCache.to == null ? fromBlock() : logCache.to + 1n;
    const ranges = [];
    for (let a = start; a <= head; a += LOG_SPAN) ranges.push([a, a + LOG_SPAN - 1n > head ? head : a + LOG_SPAN - 1n]);
    const got = []; let i = 0;
    const worker = async () => {
      while (i < ranges.length) {
        const [a, b] = ranges[i++];
        let tries = 0;
        for (;;) { try { got.push(...(await pub.getLogs({ address: D.kindly, fromBlock: a, toBlock: b }))); break; } catch (e) { if (++tries > 2) throw e; await new Promise((r) => setTimeout(r, 400 * tries)); } }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, ranges.length) }, worker));
    got.sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex);
    logCache.logs.push(...parseEventLogs({ abi: K, logs: got, strict: false }).filter((l) => l.eventName));
    logCache.to = head;
  })().finally(() => { logCache.pending = null; });
  return logCache.pending;
}
const same = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
async function events(eventName, args = {}) {
  await kindlyLogs();
  return logCache.logs.filter((l) => l.eventName === eventName && Object.entries(args).every(([k, v]) => same(l.args[k], v)));
}
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
  const card = (n, t, body) => h("div", { class: "tcard" }, h("span", { class: "num" }, n), h("h2", { class: "h3" }, t), h("p", {}, body));
  const close = h("button", { class: "btn ghost small" }, "Close");
  const dlg = h("dialog", { id: "trust", class: "modal", "aria-labelledby": "trust-title" },
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Security and funds"), h("h2", { id: "trust-title" }, tab === "privacy" ? "What's visible on-chain" : "How your funds are protected")), close),
    tab === "privacy" ? privacyBody() : [
      h("p", { class: "muted" }, "Kindly doesn't give AI your wallet. It gives AI a permission to spend. Your tokens stay in your wallet until a payment settles, then move directly to the merchant."),
      h("div", { class: "tgrid" },
        card("01", "Spending limits", "Each mandate has a per-payment cap, a total budget, an expiry and an optional cooldown. The contract rejects anything over the cap or over the remaining budget."),
        card("02", "Merchant verification", "Payments only go to merchants on the mandate's allowlist. The payee's registered name is re-checked on-chain (Confirmation of Payee), so a swapped link or a look-alike name is held or reverted."),
        card("03", "Human approval", "Unusual amounts (3× your usual or more) and name mismatches are put on HOLD. Only you, the mandate owner, can approve or reject a hold. Duplicate invoice numbers are always rejected."),
        card("04", "Revoke & recover", "Freeze pauses the agent instantly. Revoke ends the mandate for good. Kindly never holds your funds, so there is nothing to withdraw: set your token allowance to 0 and no one can pull funds through Kindly.")),
      h("details", {}, h("summary", {}, "Implemented vs. roadmap"), h("div", { class: "body grid2" },
        h("div", { class: "stack" }, h("strong", {}, "Implemented (on testnet)"), h("ul", { class: "plain" }, ["Exact, bounded token approvals from the UI", "Per-payment cap, budget, allowlist, expiry, cooldown", "PAY / HOLD / REJECT decided by the contract, with a SafetyDecision event", "Owner-only approve, reject, freeze, revoke", "Duplicate-invoice and replay protection per payer, merchant and invoice number", "On-chain receipts anyone can verify"].map((x) => h("li", {}, x)))),
        h("div", { class: "stack" }, h("strong", {}, "Roadmap"), h("ul", { class: "plain" }, ["Two-person approval for large holds", "Independent KYB attesters instead of a single testnet operator", "Hashed memos with the text kept off-chain", "Session keys and a paymaster on Aevum", "External audit before any mainnet use"].map((x) => h("li", {}, x)))))),
      h("p", { class: "small muted" }, "Testnet software. It has automated tests but no external audit. Never use it with real funds."),
    ]);
  close.onclick = () => dlg.close();
  const gz = h("div", {}, h("div", { class: "grabber", "aria-hidden": "true" })); dlg.prepend(gz); dragToDismiss(dlg, gz, () => dlg.close());
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
const REPO = "https://github.com/yunnaysy/kindly";
const VIDEO_URL = "https://github.com/yunnaysy/kindly/blob/main/docs/video/kindly-demo.mp4";
/** Welcome: three honest ways in. No account, no email, no password: a wallet is the only identity. */
function entryPaths() {
  const path = (icon, title, sub, el) => h("li", { class: "path" }, h("span", { class: "path-ic", "aria-hidden": "true" }, icon), h("span", { class: "path-txt" }, h("b", {}, title), h("small", {}, sub)), el);
  const connectBtn = h("button", { class: "btn dark", type: "button", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, fox(18), "Connect");
  return h("ul", { class: "paths", "aria-label": "Ways to try Kindly" },
    path(ICON.wallet(), "Connect wallet · Try live", window.ethereum ? "MetaMask on QDay Aevum testnet. No sign-up, email or password." : isMobileDevice() ? "Open this page in the MetaMask app to connect." : "Needs a browser wallet such as MetaMask.", connectBtn),
    path(ICON.play(), "Explore demo without wallet", "A guided replay of real, recorded testnet transactions.", h("a", { class: "btn ghost", href: "#/judge" }, "Start", h("span", { class: "arrow" }, ICON.arrow()))),
    path(ICON.file(), "Watch the 2-minute walkthrough", "A narrated video of the guided demo, recorded on the live site.", h("a", { class: "btn ghost", href: VIDEO_URL, target: "_blank", rel: "noopener" }, "Watch", ICON.ext())));
}
function viewHome() {
  setTitle(null);
  const card = heroCard();
  return h("section", { class: "view" },
    h("div", { class: "hero" },
      h("div", {},
        h("span", { class: "netchip big" }, ICON.aevum(), "Runs on QDay Aevum testnet"),
        h("h1", { class: "display" }, "Payments, handled. ", h("em", {}, "Safely.")),
        h("p", { class: "lead" }, "AI should be able to pay for you, but it should never have unlimited permission to spend your money. Kindly gives your agent a bounded allowance and fixed rules, and asks you about anything unusual."),
        entryPaths(),
        h("ul", { class: "proof" }, h("li", {}, "Rules checked by the contract"), h("li", {}, "Bounded allowance, funds stay in your wallet"), h("li", {}, "Freeze or revoke in one tap"))),
      h("figure", { class: "hero-fig" }, card.el, h("figcaption", { class: "small muted" }, "Sample animation, not live data."))),
    h("div", { class: "steps3" },
      step3("01", "Verify", "Every payee is checked against an on-chain registry. A look-alike name or a swapped link is held for you or blocked."),
      step3("02", "Control", "You set the spending rules: max per payment, total budget, usual amount, allowed merchants and an end date."),
      step3("03", "Confirm", "Routine bills pay themselves. Anything unusual waits for one tap from you. Duplicates are blocked outright.")),
    h("div", { class: "story" },
      h("blockquote", {}, "Kindly doesn't give AI your wallet. ", h("span", {}, "It gives AI a permission to spend.")),
      h("p", { class: "muted", style: "max-width:640px" }, "Every invoice passes through an on-chain Safety Gate. Payments are bounded by spending limits, verified recipients, and your approval when something looks unusual."),
      h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => trustModal("funds") }, "How your funds are protected"), trustLink("What's visible on-chain", "privacy"), h("a", { class: "btn ghost", href: "#/demo" }, "3-invoice live demo")),
      D.kindly
        ? h("div", { class: "contracts" }, h("span", {}, "Kindly ", addrLink(D.kindly)), h("span", {}, "Payee registry ", addrLink(D.registry)), h("span", { class: "row", style: "gap:6px" }, tok(), addrLink(D.token)))
        : h("p", { class: "warn" }, `Contracts not deployed on ${CHAIN.name} yet.`)));
}
const step3 = (n, t, body) => h("div", {}, h("span", { class: "num" }, n), h("h2", { class: "h3" }, t), h("p", {}, body));

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
    h("div", { class: "stage" }, gate, grid, h("div", { class: "runbar" }, progress, h("div", { class: "row sticky-cta" }, replayBtn, runBtn)), summary, exec),
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
// ------------------------------------------------------------------ Judge mode: two scenarios, real transactions, a decision you make
const JUDGE_KEY = `kindly.judge.${CHAIN.id}`;
/** A tx proof link that works for recorded (Aevum) and live steps alike. */
function proofLink(st) {
  if (!st?.hash) return h("span", { class: "muted small" }, "—");
  const url = st.explorer || explorerTx(CHAIN.id, st.hash);
  return h("span", { class: "hash", translate: "no" }, h("code", { title: st.hash }, short(st.hash)),
    url ? h("a", { class: "hc-btn", href: url, target: "_blank", rel: "noopener", "aria-label": "View this transaction on the Aevum explorer (opens in a new tab)", title: "View on explorer" }, ICON.ext()) : null);
}
function viewJudge() {
  setTitle("Guided demo");
  const J = judgeRuns[aevumTestnet.id];
  const canLive = !!(state.account && D.kindly);
  let mode = canLive && !/replay=1/.test(location.hash) ? "live" : "replay";
  const root = h("section", { class: "view judge" });
  const setReplayBadge = () => { document.body.dataset.replay = mode === "replay" ? "1" : ""; paintMode(); };
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Demo mode" });
  const segBtn = (m, label, sub) => {
    const b = h("button", { type: "button", role: "radio", class: "seg-b", "aria-checked": String(mode === m), disabled: m === "live" && !canLive ? true : null }, h("b", {}, label), h("small", {}, sub));
    b.onclick = () => { if (busy) return; mode = m; [...seg.children].forEach((x) => x.setAttribute("aria-checked", String(x === b))); setReplayBadge(); reset(); };
    return b;
  };
  seg.append(
    segBtn("replay", "Recorded replay", J ? "Real Aevum transactions, no wallet" : "Not recorded yet"),
    segBtn("live", "Live on testnet", canLive ? "Your wallet, about 5 confirmations" : "Connect a wallet first"));
  const rules = h("div", { class: "card jrules" },
    h("div", { class: "row between" }, h("h2", { class: "h3" }, "The agent's spending rules"), term("Spending rules", "What is this?")),
    h("dl", { class: "facts" },
      h("div", {}, h("dt", {}, "Max per payment"), h("dd", {}, "$200")), h("div", {}, h("dt", {}, "Max budget"), h("dd", {}, "$500")),
      h("div", {}, h("dt", {}, "Usual payment"), h("dd", {}, "$25")), h("div", {}, h("dt", {}, "Allowed merchants"), h("dd", {}, "One café"))),
    h("p", { class: "small muted" }, "Testnet amounts are scaled 1:1000: $24.99 is 0.02499 tUSD8. Tokens are free test tokens."));
  const s1 = h("div", { class: "jbody" }); const s2 = h("div", { class: "jbody" });
  const scen = (n, title, sub, body) => h("section", { class: "card jscen", "aria-labelledby": `js${n}` }, h("div", { class: "js-head" }, h("span", { class: "js-n", "aria-hidden": "true" }, String(n)), h("div", {}, h("h2", { id: `js${n}`, class: "h3" }, title), h("p", { class: "small muted" }, sub))), body);
  const proof = h("tbody", {});
  const proofCard = h("div", { class: "card jproof hidden" }, h("h2", { class: "h3" }, "Proof"), h("p", { class: "small muted" }, "Every step of this run, in order, with its transaction."),
    h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", {}, "Step"), h("th", {}, "Result"), h("th", {}, "Transaction"))), proof), decidedBy());
  const status = h("p", { class: "progress-line", role: "status" });
  const start = h("button", { class: "btn big", type: "button" }, ICON.play(), "Start");
  const resetBtn = h("button", { class: "btn ghost big", type: "button" }, "Reset");
  let busy = false;
  const say = (t, spin = false) => status.replaceChildren(...[spin ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, h("span", {}, t)].filter(Boolean));
  const addProof = (step, result, st) => { proof.append(h("tr", {}, h("td", {}, step), h("td", {}, result), h("td", {}, proofLink(st)))); proofCard.classList.remove("hidden"); };
  const idle = (el, t) => el.replaceChildren(h("p", { class: "muted small" }, t));
  const outcome = (kind, title, lines, st) => h("div", { class: `jout ${kind}` }, h("div", { class: "row" }, kind === "PAY" ? stamp("PAY") : kind === "REJECT" ? stamp("REJECT") : stamp(kind === "APPROVED" ? "PAY" : "HOLD"), h("b", {}, title)),
    h("ul", { class: "plain small" }, lines.map((l) => h("li", {}, l))), st ? h("div", { class: "small" }, "Transaction ", proofLink(st)) : null);
  const allowLine = (v) => h("span", {}, "Allowance left: ", h("b", { class: "n" }, `${v} tUSD8`));
  function reset() {
    proof.replaceChildren(); proofCard.classList.add("hidden");
    idle(s1, "Your agent submits a $24.99 coffee-beans invoice to the Safety Gate.");
    idle(s2, "Then a $149 espresso-machine invoice, about 6× the usual payment.");
    say(mode === "replay" ? (J ? `Replays the recorded run of ${new Date(J.finishedAt).toLocaleString()}. Nothing is sent from your wallet.` : "No recorded run is available.") : "Runs live on testnet with your wallet and a throwaway test café and assistant kept in this browser.");
    start.disabled = mode === "replay" && !J;
  }
  /** Shared Scenario 2 UI: the hold card with the judge's two choices. Resolves to "approve" or "reject". */
  const choose = (args) => new Promise((resolve) => {
    const ok = h("button", { class: "btn ok", type: "button" }, ICON.check(), "Approve");
    const no = h("button", { class: "btn ghost", type: "button" }, ICON.cross(), "Reject");
    ok.onclick = () => { ok.disabled = no.disabled = true; resolve("approve"); };
    no.onclick = () => { ok.disabled = no.disabled = true; resolve("reject"); };
    s2.replaceChildren(holdCard({ ...args, action: h("div", { class: "row jchoice" }, ok, no) }));
    s2.querySelector("details.why").open = true;
    say("Your turn: approve or reject the held payment.");
    ok.focus({ preventScroll: true });
  });

  async function runReplay() {
    const P = J.scenarios.pay, H = J.scenarios.hold, RJ = H.reject;
    say("Scenario 1: the agent submits INV-J1 ($24.99).", true); await sleep(900);
    s1.replaceChildren(outcome("PAY", "Paid automatically", [`${P.amount} tUSD8 vs usual ${P.usual} tUSD8 (${(Number(P.amount) / Number(P.usual)).toFixed(1)}×)`, RULE.Ok, `Risk ${P.risk}/100 from the contract`], P));
    s1.querySelector("ul").append(h("li", {}, allowLine(J.allowance.afterPay)));
    addProof("Agent submits INV-J1 $24.99", "PAY", P);
    say("Scenario 2: the agent submits INV-J2 ($149).", true); await sleep(900);
    const pick = await choose({ amount: toUnits(H.amount), usual: toUnits(H.usual), reason: H.reason, merchantName: J.merchantName, merchant: J.merchant, tx: H });
    if (pick === "approve") {
      addProof("Agent submits INV-J2 $149", "HOLD · Unusual amount", H);
      say("Showing the recorded approval.", true); await sleep(700);
      s2.replaceChildren(outcome("APPROVED", "Approved by the owner, then paid", ["Only the owner's own approval transaction released it.", `Paid ${H.amount} tUSD8 to ${J.merchantName}`, allowLine(J.allowance.afterApprove), "Owner-approved payments don't count against the agent's budget."], H.approve));
      addProof("Owner approves INV-J2", "Paid", H.approve);
    } else {
      addProof("Agent submits INV-J3 $149", "HOLD · Unusual amount", RJ.gate);
      say("Showing the recorded rejection.", true); await sleep(700);
      s2.replaceChildren(outcome("REJECT", "Rejected by the owner", ["Nothing was paid.", allowLine(J.allowance.afterReject), "The café can only send a new invoice."], RJ.tx));
      addProof("Owner rejects INV-J3", "Rejected · nothing paid", RJ.tx);
    }
    say(`Replay complete. The recorded run did both branches (INV-J2 approved, INV-J3 rejected); you saw the one you picked. Clean-up refunds: ${J.cleanup.length} transactions.`);
  }

  async function runLive() {
    requireWallet();
    const need0 = usdToUnits(24.99) + usdToUnits(149);
    const bal0 = await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] });
    if (bal0 < need0) { s1.replaceChildren(h("div", { class: "jout FAILED", role: "alert" }, h("b", {}, "Not enough test tokens"), h("p", { class: "small" }, `The live run needs ${fromUnits(need0)} tUSD8 in your wallet (you have ${fromUnits(bal0)}). Nothing was sent.`), CHAIN.id === 44005 ? h("a", { class: "btn ghost small", href: FAUCET_URL, target: "_blank", rel: "noopener" }, "Get test tokens", ICON.ext()) : null)); throw new Error("Not enough tUSD8 for the live run"); }
    state.quiet = true;
    const { agent } = demoKeys();
    // A new throwaway café per run: the usual amount is your average with that café, so a fresh café makes the run repeatable.
    const k = generatePrivateKey(); const saved = JSON.parse(localStorage.getItem(JUDGE_KEY) || "[]"); saved.push(k); localStorage.setItem(JUDGE_KEY, JSON.stringify(saved.slice(-5)));
    const merchant = createWalletClient({ chain: CHAIN, transport: http(RPC), account: privateKeyToAccount(k) });
    const NAME = "Sunrise Coffee Co";
    const st = (r) => (r?.hash ? { hash: r.hash, explorer: explorerTx(CHAIN.id, r.hash) } : null);
    const gasTop = CHAIN.id === 31337 ? parseEther("0.05") : parseEther("0.003");
    for (const [who, w] of [["café", merchant], ["assistant", agent]]) {
      const bal = await pub.getBalance({ address: w.account.address });
      if (bal < gasTop / 2n) {
        say(`Topping up the test ${who} with ${formatEther(gasTop)} tQDAY for gas. Confirm in your wallet.`, true);
        const hash = await state.wallet.sendTransaction({ to: w.account.address, value: gasTop, account: state.account, chain: CHAIN });
        await pub.waitForTransactionReceipt({ hash }); addProof(`Gas for the test ${who}`, "Sent", st({ hash }));
      }
    }
    say("The test café registers its name.", true);
    addProof("Café registers its name", "Registered", st(await send(null, "Register", { address: D.registry, abi: R, functionName: "register", args: [NAME, ""] }, merchant)));
    const need = usdToUnits(24.99) + usdToUnits(149);
    say(`Allow exactly ${fromUnits(need)} tUSD8. Confirm in your wallet.`, true);
    const al = await ensureAllowance(null, need); addProof(`You allow ${fromUnits(need)} tUSD8 (bounded)`, al ? "Set" : "Already enough", st(al));
    say("Set the agent's spending rules. Confirm in your wallet.", true);
    const mr = await send(null, "Spending rules", { address: D.kindly, abi: K, functionName: "createMandate", args: [{ agent: agent.account.address, perPaymentCap: usdToUnits(200), totalBudget: usdToUnits(500), typicalAmount: usdToUnits(25), validUntil: BigInt(Math.floor(Date.now() / 1000) + 86400), cooldown: 0, anyMerchant: false, requireVerifiedPayee: false, merchants: [merchant.account.address] }] });
    const mandateId = mr.result; addProof("You set the spending rules", `Mandate #${mandateId}`, st(mr));
    const runId = Date.now().toString(36); const exp = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const issue = async (num, usdv, memo) => (await send(null, "Invoice", { address: D.kindly, abi: K, functionName: "createInvoice", args: [refFromNumber(`${num}-${runId}`), state.account, usdToUnits(usdv), exp, memo] }, merchant)).result;
    const gate = async (id) => { const r = await send(null, "Gate", { address: D.kindly, abi: K, functionName: "agentProcess", args: [mandateId, id, nameHash(NAME)] }, agent); return { r, ev: parseEventLogs({ abi: K, eventName: "SafetyDecision", logs: r.receipt.logs })[0].args }; };
    const allowNow = async () => fromUnits(await pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] }));
    say("Scenario 1: the agent submits a $24.99 invoice.", true);
    const a = await issue("INV-J1", 24.99, "Weekly coffee beans");
    const g1 = await gate(a); const d1 = DECISION[g1.ev.decision];
    s1.replaceChildren(outcome(d1, d1 === "PAY" ? "Paid automatically" : `Result: ${OUTCOME[d1]}`, [`${fromUnits(g1.ev.amount)} tUSD8 vs usual ${fromUnits(g1.ev.usualAmount)} tUSD8`, RULE[REASON[g1.ev.reason]], allowLine(await allowNow())], st(g1.r)));
    addProof("Agent submits INV-J1 $24.99", d1, st(g1.r));
    say("Scenario 2: the agent submits a $149 invoice.", true);
    const b = await issue("INV-J2", 149, "Espresso machine service");
    const g2 = await gate(b); const d2 = DECISION[g2.ev.decision];
    addProof("Agent submits INV-J2 $149", `${d2} · ${reasonLabel(REASON[g2.ev.reason])}`, st(g2.r));
    const paid = d1 === "PAY" ? [[a, usdToUnits(24.99)]] : [];
    if (d2 === "HOLD") {
      const pick = await choose({ amount: g2.ev.amount, usual: g2.ev.usualAmount, reason: g2.ev.reason, merchantName: NAME, merchant: merchant.account.address, tx: st(g2.r) });
      try {
        if (pick === "approve") {
          say("Approve in your wallet.", true);
          const r = await send(null, "Approve", { address: D.kindly, abi: K, functionName: "approveHold", args: [b, nameHash(NAME)] });
          s2.replaceChildren(outcome("APPROVED", "Approved by you, then paid", ["Your approval transaction released it.", allowLine(await allowNow()), "Owner-approved payments don't count against the agent's budget."], st(r)));
          addProof("You approve INV-J2", "Paid", st(r)); paid.push([b, usdToUnits(149)]);
        } else {
          say("Reject in your wallet.", true);
          const r = await send(null, "Reject", { address: D.kindly, abi: K, functionName: "rejectHold", args: [b] });
          s2.replaceChildren(outcome("REJECT", "Rejected by you", ["Nothing was paid.", allowLine(await allowNow())], st(r)));
          addProof("You reject INV-J2", "Rejected · nothing paid", st(r));
          await send(null, "Cancel", { address: D.kindly, abi: K, functionName: "cancelInvoice", args: [b] }, merchant).catch(() => {});
        }
      } catch (e) {
        s2.replaceChildren(h("div", { class: "jout FAILED", role: "alert" }, h("div", { class: "row" }, stamp("REJECT"), h("b", {}, "Your decision wasn't sent")), h("p", { class: "small" }, humanError(e)), h("p", { class: "small muted" }, "The payment is still held. Review it on Home, or press Reset to reject it.")));
        throw e;
      }
    } else s2.replaceChildren(outcome(d2, `Result: ${OUTCOME[d2]}`, [`${fromUnits(g2.ev.amount)} tUSD8 vs usual ${fromUnits(g2.ev.usualAmount)} tUSD8`, RULE[REASON[g2.ev.reason]]], st(g2.r)));
    // Give the test tokens back (signed by the throwaway café key, no wallet prompt).
    const total = paid.reduce((x, [, v]) => x + v, 0n);
    if (total > 0n) {
      say("The test café refunds your test tokens.", true);
      await send(null, "Approve refund", { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, total] }, merchant);
      for (const [id, v] of paid) addProof(`Café refunds ${fromUnits(v)} tUSD8`, "Refunded", st(await send(null, "Refund", { address: D.kindly, abi: K, functionName: "refund", args: [id, v] }, merchant)));
    }
    say("Done. Every step above is a real testnet transaction. Reset revokes the demo rules.");
  }

  /** Reset: clear the screen; in live mode also reject any held demo payment and revoke demo spending rules (your signature each). */
  resetBtn.onclick = async () => {
    if (busy) return;
    if (mode === "live" && state.account && D.kindly) {
      const { agent } = demoKeys();
      try {
        busy = true; resetBtn.disabled = start.disabled = true; say("Looking for leftover demo holds and rules…", true);
        const mine = (await events("MandateCreated", { owner: state.account })).map((l) => l.args.id);
        let n = 0;
        for (const id of mine) {
          const m = await pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] });
          if (!same(m.agent, agent.account.address) || m.revoked) continue;
          for (const ev of await events("SafetyDecision", { mandateId: id })) {
            if (DECISION[ev.args.decision] !== "HOLD") continue;
            const hd = await pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [ev.args.invoiceId] });
            if (hd.active) { await send(null, "Reject leftover hold", { address: D.kindly, abi: K, functionName: "rejectHold", args: [ev.args.invoiceId] }); n++; }
          }
          await send(null, "Revoke demo rules", { address: D.kindly, abi: K, functionName: "revokeMandate", args: [id] }); n++;
        }
        toast(n ? `Reset: ${n} demo item${n === 1 ? "" : "s"} cleared.` : "Nothing to clear.", "ok");
      } catch (e) { toast(`Reset stopped: ${humanError(e)}`, "error"); }
      finally { busy = false; resetBtn.disabled = false; state.quiet = false; }
    }
    reset();
  };
  start.onclick = async () => {
    if (busy) return; busy = true; start.disabled = resetBtn.disabled = true; reset(); start.disabled = true;
    try { await (mode === "replay" ? runReplay() : runLive()); }
    catch (e) { say(`Stopped: ${humanError(e)}. Nothing else was sent. Press Reset to clean up.`); }
    finally { busy = false; state.quiet = false; start.disabled = false; resetBtn.disabled = false; start.replaceChildren(ICON.play(), "Run again"); }
  };
  root.append(
    pageHead(null, "Guided demo", "Two scenarios, about a minute. A normal payment passes; an unusual one waits for your decision. Every step links to a real Aevum transaction."),
    seg, rules,
    scen(1, "A normal payment passes", "$24.99 · Weekly coffee beans", s1),
    scen(2, "An unusual payment waits for you", "$149 · Espresso machine service", s2),
    h("div", { class: "runbar" }, status, h("div", { class: "row sticky-cta" }, resetBtn, start)),
    proofCard,
    h("p", { class: "small muted" }, "Also available: the ", h("a", { href: "#/demo" }, "3-invoice demo"), ", which adds a duplicate invoice that is blocked outright."));
  setReplayBadge(); reset();
  if (/autostart=1/.test(location.hash)) setTimeout(() => start.click(), 300);
  return root;
}
function recordedRunCard() {
  const run = recordedRuns[CHAIN.id];
  if (!run?.decisions?.length) return h("div", {});
  return h("div", { class: "card" },
    h("div", { class: "row between" }, h("h2", { class: "h3" }, `Last recorded run on ${CHAIN.id === 44005 ? "Aevum" : CHAIN.name}`), h("span", { class: "mono muted" }, new Date(run.finishedAt).toLocaleString())),
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
  const logs = await events("MandateMerchantSet", { id }).catch(() => []);
  const m = new Map(); for (const l of logs) m.set(l.args.merchant, l.args.allowed);
  return [...m].filter(([, ok]) => ok).map(([a]) => a);
}
const connectCard = (what) => h("div", { class: "card panel empty-state" },
  h("span", { class: "es-icon" }, ICON.wallet()),
  h("h2", {}, "Connect your wallet"),
  h("p", { class: "muted" }, `Connect to ${what}. Kindly never asks for your seed phrase.`),
  h("div", { class: "row" }, h("button", { class: "btn dark", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, ICON.wallet(), "Connect wallet"), h("a", { class: "btn ghost", href: "#/demo?replay=1" }, "Watch the recorded demo")));

// ------------------------------------------------------------------ Dashboard ("Your AI agent")
/** Home (mode "home"): what needs you, your agent with Freeze, recent activity. Wallet (mode "wallet"): balance, allowance, every mandate and its settings. */
/** What actually fired, worded from the contract's own checks (Kindly.sol evaluate()). */
const RULE = {
  AmountAnomaly: "Amount is 3× the usual payment or more → hold for your decision",
  PayeeMismatch: "Registered name ≠ the name your agent submitted → hold for your decision",
  PayeeUnverified: "These rules pay verified merchants only, and this one isn't verified → hold",
  Duplicate: "Invoice was already paid → reject", NotOpen: "Invoice isn't payable → reject", Expired: "Invoice or rules expired → reject",
  MerchantNotAllowed: "Merchant isn't on the allowed list → reject", OverCap: "Above max per payment → reject", OverBudget: "Above the budget left → reject",
  PayerNotAllowed: "Invoice is addressed to another payer → reject", Ok: "Within every rule → paid automatically",
};
const ratioOf = (amount, usual) => (usual && BigInt(usual) > 0n ? Number(amount) / Number(usual) : null);
/** "Who decided": every verdict is a fixed contract rule. The agent only proposes; the wording is a template. */
const decidedBy = () => h("p", { class: "decided small" }, ICON.gate(), h("span", {}, h("b", {}, "Contract rule, deterministic. "), "Kindly's contract checks fixed rules; the same invoice always gets the same verdict. No AI model makes this decision. Your agent only proposes payments."));
/** "Why was this held?": computed from the SafetyDecision event's own amount and usual values. */
function whyHeld({ amount, usual, reason, tx, open = false }) {
  const r = typeof reason === "string" ? reason : REASON[Number(reason)];
  const x = ratioOf(amount, usual);
  return h("details", { class: "why", open: open || null },
    h("summary", {}, "Why was this held?"),
    h("div", { class: "body" },
      h("dl", { class: "kv" },
        h("dt", {}, "This payment"), h("dd", {}, money(BigInt(amount))),
        h("dt", {}, "Usual payment"), h("dd", {}, usual && BigInt(usual) > 0n ? money(BigInt(usual)) : "No usual amount yet"),
        r === "AmountAnomaly" && x ? [h("dt", {}, "Difference"), h("dd", {}, h("b", {}, `${x.toFixed(1)}× usual`), h("small", { class: "muted" }, " · holds start at 3×"))] : null,
        h("dt", {}, "Rule that fired"), h("dd", {}, RULE[r] || reasonLabel(r)),
        tx ? [h("dt", {}, "Decision tx"), h("dd", {}, typeof tx === "string" ? txLink(tx) : proofLink(tx))] : null),
      h("p", { class: "small muted" }, "Usual payment = your average with this merchant so far, or the usual amount in your spending rules before your first payment."),
      decidedBy()));
}
/** Held payment: calm amber card, thin border, white details. Red is reserved for rejected or failed. */
function holdCard({ amount, merchantName, merchant, reason, usual, tx, invoiceId, action }) {
  const r = typeof reason === "string" ? reason : REASON[Number(reason)];
  const x = ratioOf(amount, usual);
  const why = r === "AmountAnomaly" && x ? `Unusual amount, ${x.toFixed(1)}× your usual payment` : reasonLabel(r);
  return h("article", { class: "holdcard", "aria-label": `Payment held, review required: ${fromUnits(amount)} tUSD8` },
    h("div", { class: "hc-top" }, h("span", { class: "hold-badge" }, ICON.pause(), "Payment held"), h("span", { class: "hc-req" }, "Review required")),
    h("div", { class: "hc-body" },
      h("div", { class: "hc-line" }, h("div", { class: "hc-amt" }, money(BigInt(amount), "big")), h("div", { class: "hc-to" }, h("span", { class: "muted small" }, "to "), h("b", {}, sanitizeText(merchantName || "", 40) || short(merchant)))),
      h("p", { class: "hc-reason" }, h("span", { class: "muted" }, "Reason · "), why),
      h("p", { class: "hc-note small" }, "The payment is paused. Your agent cannot proceed without your decision."),
      whyHeld({ amount, usual, reason: r, tx }),
      action || (invoiceId ? h("a", { class: "btn dark wide", href: `#/review/${invoiceId}` }, "Review payment") : null)));
}
/** Plain-English helper for a term. A tap opens a short definition. */
const GLOSSARY = {
  "Spending rules": "What your agent may pay: a max per payment, a total budget, a usual amount, which merchants, and an end date. The contract stores them as a mandate and enforces them on every payment.",
  Mandate: "The on-chain record of your agent's spending rules. It has an ID, and only you can change, freeze or revoke it.",
  Allowance: "How many tUSD8 the Kindly contract may pull from your wallet, set by you with a standard token approval. Your tokens stay in your wallet; set it to 0 any time.",
  "Safety Gate": "The check every invoice goes through in the Kindly contract. It answers PAY, HOLD (waits for you) or REJECT using fixed rules.",
  Hold: "A payment the Safety Gate paused for you. Nothing moves until you approve or reject it.",
};

// ------------------------------------------------------------------ Payments history (Home + Activity): one row per invoice your agent tried
const payeeNames = new Map();
function payeeName(addr) {
  const k = String(addr).toLowerCase();
  if (!payeeNames.has(k)) payeeNames.set(k, pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [addr] }).then((p) => sanitizeText(p.name || "", 40)).catch(() => ""));
  return payeeNames.get(k);
}
/** Built only from on-chain events: SafetyDecision (latest per invoice), HoldApproved / HoldRejected, and your direct InvoicePaid. */
async function myPayments(limit = 40) {
  const ids = new Set((await events("MandateCreated", { owner: state.account })).map((l) => String(l.args.id)));
  const lc = (x) => String(x).toLowerCase();
  const created = new Map((await events("InvoiceCreated")).map((l) => [lc(l.args.id), l]));
  const appr = new Map((await events("HoldApproved", { owner: state.account })).map((l) => [lc(l.args.invoiceId), l]));
  const rej = new Map((await events("HoldRejected", { owner: state.account })).map((l) => [lc(l.args.invoiceId), l]));
  const last = new Map();
  for (const ev of await events("SafetyDecision")) if (ids.has(String(ev.args.mandateId))) last.set(lc(ev.args.invoiceId), ev);
  const rows = [];
  for (const [k, ev] of last) {
    const d = DECISION[ev.args.decision]; const ex = explainDecision({ ...ev.args, usual: ev.args.usualAmount });
    const a = appr.get(k), r = rej.get(k);
    const kind = d === "PAY" ? "paid" : d === "REJECT" ? "rejected" : a ? "paid" : r ? "rejected" : "held";
    const sub = d === "PAY" ? "Paid automatically, within your rules" : d === "REJECT" ? "Blocked by your rules. Nothing was paid." : a ? "Held, then approved by you" : r ? "Held, then rejected by you. Nothing was paid." : "Held. Waiting for your decision.";
    rows.push({ kind, sub, decision: d, reason: ex.reason, amount: ev.args.amount, usual: ev.args.usualAmount, risk: ev.args.risk, mandateId: ev.args.mandateId, invoiceId: ev.args.invoiceId, tx: ev.transactionHash, block: (a || r || ev).blockNumber, resolveTx: (a || r)?.transactionHash, merchant: created.get(k)?.args.merchant, memo: created.get(k)?.args.memo });
  }
  for (const lg of await events("InvoicePaid", { paidBy: state.account })) if (lg.args.mandateId === 0n) rows.push({ kind: "paid", sub: "Paid directly by you", decision: null, reason: "Ok", amount: lg.args.amount, mandateId: 0n, invoiceId: lg.args.id, tx: lg.transactionHash, block: lg.blockNumber, merchant: lg.args.merchant, direct: true });
  rows.sort((x, y) => Number(y.block - x.block));
  const top = rows.slice(0, limit);
  await Promise.all(top.map(async (r) => { r.name = r.merchant ? (await payeeName(r.merchant)) || short(r.merchant) : "Unknown merchant"; r.ts = await blockTime(r.block); }));
  return { rows: top, all: rows };
}
const KIND = { paid: ["Paid", "ok"], held: ["Held", "hold"], rejected: ["Rejected", "bad"] };
const CHECKS = [["MerchantNotAllowed", "Merchant is on your allowed list"], ["PayeeMismatch", "Merchant name matches the registry"], ["PayeeUnverified", "Merchant is verified"], ["OverCap", "Within max per payment"], ["OverBudget", "Within the budget left"], ["Duplicate", "Not a duplicate invoice"], ["AmountAnomaly", "Close to your usual amount"]];
function securityChecks(r) {
  if (r.direct) return h("p", { class: "small muted" }, "You paid this invoice yourself after checking the merchant's registered name. No agent rules were involved.");
  if (r.reason === "Ok") return h("ul", { class: "checks" }, ...CHECKS.map(([, t]) => h("li", { class: "pass" }, h("span", { class: "tick" }, svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')), h("span", {}, t))));
  const hit = CHECKS.find(([k]) => k === r.reason);
  return h("div", { class: "stack", style: "gap:8px" },
    h("ul", { class: "checks" }, h("li", { class: r.decision === "REJECT" ? "fail" : "flag" }, h("span", { class: "tick" }), h("span", {}, hit ? `${hit[1]}: no` : reasonLabel(r.reason)))),
    h("p", { class: "small muted" }, "The contract reports the first rule that fired. ", RULE[r.reason] || ""));
}
const when = (ts) => (ts ? h("time", { datetime: new Date(ts * 1000).toISOString(), title: new Date(ts * 1000).toLocaleString() }, ago(ts)) : "");
function payRow(r, { open = false, compact = false } = {}) {
  const [label, tone] = KIND[r.kind];
  const why = r.kind === "paid" ? (r.direct ? "Direct payment" : r.decision === "HOLD" ? "Approved by you" : "Within your rules") : r.kind === "rejected" && r.decision === "HOLD" ? "Rejected by you" : reasonLabel(r.reason);
  const head = [h("span", { class: `pr-ic ${tone}`, "aria-hidden": "true" }, r.kind === "paid" ? ICON.check() : r.kind === "held" ? ICON.pause() : ICON.cross()),
    h("span", { class: "pr-main" }, h("b", {}, r.name), h("small", {}, h("span", { class: `pr-st ${tone}` }, label), " · ", why)),
    h("span", { class: "pr-side" }, h("span", { class: "pr-amt" }, fmt(r.amount), h("small", {}, " tUSD8")), h("small", { class: "muted" }, when(r.ts)))];
  if (compact) return h("li", {}, h("a", { class: "prow", href: r.kind === "held" ? `#/review/${r.invoiceId}` : `#/activity?inv=${r.invoiceId}`, "aria-label": `${label}: ${fmt(r.amount)} tUSD8 to ${r.name}, ${why}` }, ...head));
  return h("li", {}, h("details", { class: "prow-d", open: open || null }, h("summary", { class: "prow" }, ...head),
    h("div", { class: "pr-body" },
      r.kind === "held" ? h("a", { class: "btn dark wide", href: `#/review/${r.invoiceId}` }, "Review payment") : null,
      h("dl", { class: "kv" },
        h("dt", {}, "What happened"), h("dd", {}, r.sub),
        r.usual && r.usual > 0n ? [h("dt", {}, "Usual payment"), h("dd", {}, money(r.usual))] : null,
        r.memo ? [h("dt", {}, "Invoice"), h("dd", {}, sanitizeText(r.memo, 80))] : null),
      h("div", { class: "pr-checks" }, h("h3", { class: "small-h" }, "Security checks"), securityChecks(r)),
      h("details", { class: "tech" }, h("summary", {}, "Technical details"), h("div", { class: "body" }, h("dl", { class: "kv" },
        r.mandateId > 0n ? [h("dt", {}, "Mandate"), h("dd", {}, `#${r.mandateId}`)] : null,
        r.risk != null ? [h("dt", {}, "Risk score"), h("dd", {}, riskView(r.risk))] : null,
        h("dt", {}, r.direct ? "Payment tx" : "Decision tx"), h("dd", {}, txLink(r.tx)),
        r.resolveTx ? [h("dt", {}, r.kind === "paid" ? "Approval tx" : "Rejection tx"), h("dd", {}, txLink(r.resolveTx))] : null,
        h("dt", {}, "Invoice ID"), h("dd", {}, hashChip(r.invoiceId, "invoice")),
        r.merchant ? [h("dt", {}, "Merchant address"), h("dd", {}, addrLink(r.merchant))] : null,
        h("dt", {}, "Kindly contract"), h("dd", {}, addrLink(D.kindly))))),
      r.kind === "paid" ? h("a", { class: "small", href: `#/activity?id=${r.invoiceId}` }, "Verify the receipt") : null)));
}
const emptyBox = (icon, title, body, action) => h("div", { class: "empty-box" }, h("span", { class: "es-icon" }, icon), h("b", {}, title), h("p", { class: "small muted" }, body), action || null);
const errorBox = (e, retry) => h("div", { class: "empty-box err", role: "alert" }, h("span", { class: "es-icon" }, ICON.cross()), h("b", {}, "Couldn't load your payments"), h("p", { class: "small muted" }, humanError(e)), h("button", { class: "btn ghost small", type: "button", onclick: retry }, "Try again"));

const term = (t, label = t) => h("button", { class: "term", type: "button", onclick: () => sheet(t, [h("p", {}, GLOSSARY[t])]), "aria-label": `${label}: what does this mean?` }, label, ICON.help());
async function viewControl(mode = "home") {
  const wallet = mode === "wallet";
  setTitle(wallet ? "Wallet" : "Home");
  const root = h("section", { class: "view" });
  if (!state.account) { root.append(pageHead(null, wallet ? "Wallet" : "Your AI agent", wallet ? "Your balance, the bounded allowance and every mandate." : "What your AI assistant may pay, how much, and to whom."), connectCard(wallet ? "see your balance and allowance" : "see and manage your assistant's permissions")); return root; }
  requireWallet();
  const head = h("div", {}, pageHead(null, wallet ? "Wallet" : "Home", wallet ? "Your funds stay in your wallet. Kindly may only move the bounded allowance below." : null));
  const top = h("div", { class: wallet ? "dash-top one" : "home-top" }, h("div", { class: "card panel" }, skeleton()));
  const holds = h("div", {});
  const metrics = h("div", { class: "metrics" }, ...[0, 1, 2].map(() => h("div", { class: "metric" }, skeleton())));
  const list = h("div", { class: "stack", style: "gap:16px" });
  const recent = h("ul", { class: "plist compact" }, h("li", {}, skeleton()));
  const funds = h("div", { class: "card panel funds" }, skeleton());
  const demoTile = h("a", { class: "card tile", href: "#/judge" }, h("span", { class: "tile-ic", "aria-hidden": "true" }, ICON.play()), h("span", { class: "tile-txt" }, h("b", {}, "Run guided demo"), h("small", {}, "A normal payment, then an unusual one you decide on")), h("span", { class: "tile-go", "aria-hidden": "true" }, ICON.chev()));
  const recentCard = h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { class: "h3" }, "Recent activity"), h("a", { class: "small", href: "#/activity" }, "See all")), recent);
  root.append(head, wallet
    ? h("div", { class: "dash-grid wallet-grid" },
        h("div", { class: "dash-main" }, h("h2", { class: "sec-h" }, "Connected wallet"), top, h("h2", { class: "sec-h" }, "Allowance"), funds, h("h2", { class: "sec-h" }, "Network & token"), networkCard()),
        h("div", { class: "dash-side" },
          h("div", { class: "row between" }, h("h2", { class: "sec-h" }, "Mandates · agent permissions"), h("a", { class: "btn ghost small", href: "#/start" }, "Add")),
          list))
    : h("div", { class: "dash-grid" },
        h("div", { class: "dash-main" }, holds, top, metrics),
        h("div", { class: "dash-side" }, recentCard, demoTile)));

  async function load() {
    const created = await events("MandateCreated", { owner: state.account });
    const ids = created.map((l) => l.args.id).reverse();
    const ms = [];
    const cards = [];
    for (const [i, id] of ids.slice(0, 12).entries()) {
      const [m, rem] = await Promise.all([pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] }), pub.readContract({ address: D.kindly, abi: K, functionName: "mandateRemaining", args: [id] })]);
      ms.push([id, m, rem]); if (wallet) cards.push(await mandateCard(id, load, i === 0));
    }
    const [bal, allowance] = await Promise.all([
      pub.readContract({ address: D.token, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }),
      pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] }),
    ]);
    const primary = ms.find(([, m]) => mandateStatus(m) === "Active") || ms.find(([, m]) => mandateStatus(m) === "Frozen") || ms[0];
    if (wallet) {
      top.replaceChildren(walletCard(bal, allowance, load));
      funds.replaceChildren(...fundsPanel(ms, allowance).childNodes);
      list.replaceChildren(...(cards.length ? cards : [h("div", { class: "card" }, emptyBox(ICON.gate(), "No mandates yet", "A mandate tells your agent what it may pay: limits, merchants and an end date.", h("a", { class: "btn dark small", href: "#/start" }, "Set up your agent")))]));
      return;
    }
    const { rows } = await myPayments(40);
    const pendingRows = rows.filter((r) => r.kind === "held");
    const pending = [];
    for (const r of pendingRows) {
      const hold = await pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [r.invoiceId] });
      if (!hold.active) continue;
      pending.push(holdCard({ amount: r.amount, usual: r.usual, reason: r.reason, merchantName: r.name, merchant: r.merchant, tx: r.tx, invoiceId: r.invoiceId }));
    }
    top.replaceChildren(await agentCard(primary, load, allowance));
    const pm = primary?.[1]; const pst = primary ? mandateStatus(pm) : null;
    const metric = (icon, label, value, sub, tone = "") => h("div", { class: `metric ${tone}` }, h("span", { class: "m-ic", "aria-hidden": "true" }, icon), h("small", {}, label), h("b", {}, value), sub ? h("span", { class: "m-sub" }, sub) : null);
    metrics.replaceChildren(
      metric(ICON.gate(), "Max per payment", pm ? `${fmt(pm.perPaymentCap)}` : "None", pm ? "tUSD8 · higher is rejected" : "No rules yet", "lav"),
      metric(ICON.receipt(), "Spent so far", pm ? `${fmt(pm.spent)}` : "0", pm ? `${pm.payments} payment${Number(pm.payments) === 1 ? "" : "s"} · tUSD8` : "tUSD8", "mint"),
      metric(ICON.pause(), "Needs you", String(pending.length), pending.length ? "Waiting for your decision" : pst === "Frozen" ? "Agent is frozen" : "Unusual payments wait here", pending.length ? "butter" : "peach"));
    recent.replaceChildren(...(rows.length ? rows.slice(0, 3).map((r) => payRow(r, { compact: true })) : [h("li", {}, emptyBox(ICON.activity(), "No payments yet", "When your agent submits an invoice, Kindly's decision shows up here."))]));
    head.replaceChildren(pageHead(null, pending.length ? `${pending.length} payment${pending.length > 1 ? "s need" : " needs"} you` : "All clear",
      pending.length ? "Nothing moves until you decide." : "Routine payments run within your rules. Anything unusual waits for you."));
    holds.replaceChildren(pending.length ? h("div", { class: "holds", role: "region", "aria-label": "Payments that need you" }, ...pending) : h("div", { class: "calm" }, ICON.check(), "Nothing is waiting for your approval."));
  }
  try { await load(); } catch (e) { top.replaceChildren(h("div", { class: "card" }, errorBox(e, () => route()))); }
  // Sidebar "Freeze agent" lands here: bring the real Freeze button into view and focus it. Freezing still takes a tap and a wallet confirmation.
  if (/[?&]freeze=1/.test(location.hash)) setTimeout(() => { const f = root.querySelector(".btn.freeze"); if (f) { f.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }); f.focus({ preventScroll: true }); } }, 50);
  const timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(timer); if (!document.querySelector("#app input:focus, #app details[open]")) load().catch(() => {}); }, 12000);
  return root;
}
/** Wallet → Network & token. Chain IDs and contract addresses stay behind "Details". */
function networkCard() {
  const live = CHAIN.id === 44005;
  return h("div", { class: "card panel" },
    h("ul", { class: "set-list flat" },
      h("li", { class: "set-row" }, h("span", { class: "set-ic", "aria-hidden": "true" }, ICON.aevum()), h("span", { class: "set-txt" }, h("b", {}, live ? "QDay Aevum Testnet" : CHAIN.name), h("small", {}, live ? "Test network · tokens have no real value" : "Local rehearsal chain, not real data")), h("span", { class: `spill ${state.wrongNet ? "warn" : "ok"}` }, state.wrongNet ? "Wrong network" : "Connected")),
      h("li", { class: "set-row" }, h("span", { class: "set-ic", "aria-hidden": "true" }, tok()), h("span", { class: "set-txt" }, h("b", {}, "tUSD8"), h("small", {}, "Test stablecoin used for every payment")), live ? h("a", { class: "small", href: FAUCET_URL, target: "_blank", rel: "noopener" }, "Get test tokens") : null)),
    h("details", { class: "tech" }, h("summary", {}, "Details"), h("div", { class: "body" }, h("dl", { class: "kv" },
      h("dt", {}, "Chain ID"), h("dd", { class: "mono" }, String(CHAIN.id)),
      h("dt", {}, "Token contract"), h("dd", {}, addrLink(D.token)),
      h("dt", {}, "Kindly contract"), h("dd", {}, addrLink(D.kindly)),
      h("dt", {}, "Payee registry"), h("dd", {}, addrLink(D.registry))))));
}

/** "Your agent's spending rules": budget left above the fold, the limits in plain words, Freeze never buried. */
async function agentCard(entry, reload, allowance) {
  if (!entry) return h("div", { class: "card panel agent empty-state" },
    h("span", { class: "es-icon" }, ICON.gate()), h("h2", { class: "h3" }, "Your agent has no spending rules yet"),
    h("p", { class: "muted" }, "Set a bounded allowance and spending rules in three short steps. Or run the guided demo, which brings its own test assistant."),
    h("div", { class: "row" }, h("a", { class: "btn", href: "#/start" }, "Set up your agent"), h("a", { class: "btn ghost", href: "#/judge" }, "Run guided demo")));
  const [id, m, remaining] = entry;
  const st = mandateStatus(m);
  const shown = st === "Frozen" ? (m.totalBudget > m.spent ? m.totalBudget - m.spent : 0n) : st === "Active" ? remaining : 0n;
  const pctLeft = m.totalBudget ? Number((shown * 100n) / m.totalBudget) : 0;
  const merchants = m.anyMerchant ? null : await mandateMerchants(id);
  const live = st === "Active" || st === "Frozen";
  const freeze = h("button", { class: `btn freeze ${m.frozen ? "on" : ""}` }, m.frozen ? ICON.play() : ICON.snow(), m.frozen ? "Unfreeze agent" : "Freeze agent");
  freeze.onclick = async () => {
    if (!m.frozen && !confirm("Freeze your agent? It can't pay anything until you unfreeze it.")) return;
    await send(freeze, m.frozen ? "Unfreeze" : "Freeze", { address: D.kindly, abi: K, functionName: "setFrozen", args: [id, !m.frozen] }); reload();
  };
  const chip = st === "Active" ? h("span", { class: "chip ok live" }, "Agent active") : st === "Frozen" ? h("span", { class: "chip sky" }, ICON.snow(), "Frozen") : h("span", { class: "chip bad" }, st);
  const date = (t) => h("time", { datetime: new Date(Number(t) * 1000).toISOString() }, new Date(Number(t) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
  return h("div", { class: `card panel agent ${st.toLowerCase()}` },
    h("div", { class: "row between" }, h("div", { class: "row" }, h("span", { class: "gate-mark" }, ICON.gate()), h("h2", { class: "h3 agent-t" }, "Allowance left")), chip),
    h("div", { class: "stack", style: "gap:6px" },
      h("span", { class: "small muted" }, st === "Frozen" ? "Your agent can spend, paused" : "Your agent can still spend"),
      h("div", { class: "remaining" }, h("span", { class: "n" }, fmt(shown)), h("small", {}, "of ", fmt(m.totalBudget), " "), tok(), h("span", { class: "pct" }, `${pctLeft}% left`)),
      h("div", { class: "bar", role: "progressbar", "aria-valuenow": String(pctLeft), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Budget left" }, h("span", { style: `--w:${Math.min(pctLeft, 100) / 100}` }))),
    live ? h("div", { class: "freeze-row" }, freeze, h("span", { class: "small muted" }, m.frozen ? "Your agent can't pay anything while frozen." : "Stops every payment at once.")) : h("p", { class: "small muted" }, "These rules can no longer spend."),
    h("details", { class: "tech rules-d" }, h("summary", {}, "Spending rules & details"), h("div", { class: "body stack", style: "gap:14px" },
    h("dl", { class: "facts" },
      h("div", {}, h("dt", {}, "Max budget"), h("dd", {}, money(m.totalBudget))),
      h("div", {}, h("dt", {}, "Max per payment"), h("dd", {}, money(m.perPaymentCap))),
      h("div", {}, h("dt", {}, "Usual payment"), h("dd", {}, money(m.typicalAmount))),
      h("div", {}, h("dt", {}, "Allowed merchants"), h("dd", {}, m.anyMerchant ? "Any merchant" : `${merchants.length} merchant${merchants.length === 1 ? "" : "s"}`, m.requireVerifiedPayee ? h("small", { class: "muted" }, " · verified only") : null)),
      h("div", {}, h("dt", {}, "Expires"), h("dd", {}, date(m.validUntil))),
      allowance != null ? h("div", {}, h("dt", {}, term("Allowance", "Allowance")), h("dd", {}, money(allowance))) : null),
    h("p", { class: "funds-note small" }, ICON.lock(), "Funds stay in your wallet outside the allowance."),
    h("p", { class: "small muted id-line" }, term("Mandate", `Mandate #${id}`), " · assistant ", addrLink(m.agent)),
    h("a", { class: "small", href: "#/wallet" }, "Edit limits in Wallet"))));
}

/** The one charcoal contrast moment: real wallet balance, read from the token contract. */
function walletCard(bal, allowance, reload) {
  const zero = h("button", { class: "btn on-dark small" }, "Reduce allowance to 0");
  zero.onclick = async () => { if (!confirm("Set your tUSD8 allowance for Kindly to 0? No payment can be pulled through Kindly until you allow spending again.")) return; await send(zero, "Allowance to 0", { address: D.token, abi: erc20Abi, functionName: "approve", args: [D.kindly, 0n] }); reload(); };
  return h("div", { class: "walletcard" },
    h("div", { class: "row between" }, h("span", { class: "wc-label" }, h("span", { class: "fox-av" }, fox(18)), h("code", {}, short(state.account))), h("span", { class: "wc-chip" }, h("span", { class: "dot", "aria-hidden": "true" }), "Connected")),
    h("span", { class: "wc-small" }, "Wallet balance"),
    h("div", { class: "wc-amt" }, h("span", { class: "n" }, fmt(bal)), tok()),
    h("div", { class: "row wc-meta" }, aevumChip(CHAIN.id === 44005 ? "Aevum testnet" : CHAIN.name), h("span", {}, "Available in wallet")),
    h("hr", {}),
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:2px" }, h("span", { class: "wc-small" }, "Kindly may move at most"), h("b", { class: "n" }, fmt(allowance), " tUSD8")), allowance > 0n ? zero : h("span", { class: "wc-small" }, "Nothing can be pulled")),
    h("p", { class: "wc-small" }, "Your funds stay here. Kindly only holds a bounded allowance, never your funds."));
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
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("h3", { class: "h3" }, "Funds protection"), h("span", { class: "muted small" }, "Kindly may pull only your exact allowance. Everything else stays put.")), trustLink("How it works", "funds")),
    h("div", { class: "fund-grid three" },
      h("div", {}, h("small", {}, "Agent spending budget"), h("b", {}, money(budget)), h("span", { class: "small muted" }, `left across ${live.length} active mandate${live.length === 1 ? "" : "s"}`)),
      h("div", {}, h("small", {}, "Per-payment limit"), h("b", {}, pm ? money(pm.perPaymentCap) : "None"), h("span", { class: "small muted" }, primary ? `mandate #${primary[0]}` : "no mandate yet")),
      h("div", {}, h("small", {}, "Kindly may pull at most"), h("b", {}, money(allowance)), h("span", { class: "small muted" }, "your exact ERC-20 allowance"))),
    h("details", { class: "tech" }, h("summary", {}, "What your agent can and can't do"), h("div", { class: "split body" },
      h("ul", { class: "perms" },
        perm(true, "Can pay merchants on its allowlist"), perm(true, "Cannot exceed its per-payment limit or budget"), perm(true, "Duplicate invoices are blocked"), perm(true, "Unusual payments wait for your approval"),
        perm(false, "Cannot change its limits, approve holds or raise its budget"), perm(false, "Never gets a token allowance or your keys")),
      h("div", { class: "recovery" }, h("strong", {}, "Recovery path"), h("ol", {}, h("li", {}, "Freeze the agent: it stops at once."), h("li", {}, "Revoke the mandate: permanent, can't be undone."), h("li", {}, "Reduce your allowance to 0: nothing can be pulled through Kindly. Your funds never left your wallet.")), h("div", { class: "row" }, revokeLink)))));
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
    if (!m.frozen && !confirm(`Freeze these spending rules (mandate #${id})? Your assistant can't pay anything until you unfreeze it.`)) return;
    await send(freeze, m.frozen ? "Unfreeze" : "Freeze", { address: D.kindly, abi: K, functionName: "setFrozen", args: [id, !m.frozen] }); reload();
  };
  const revoke = h("button", { class: "btn danger small" }, "Revoke forever");
  revoke.onclick = async () => { if (!confirm(`Revoke these spending rules (mandate #${id}) permanently? This can't be undone.`)) return; await send(revoke, "Revoke", { address: D.kindly, abi: K, functionName: "revokeMandate", args: [id] }); reload(); };
  const merchantIn = h("input", { placeholder: "0x… merchant address", class: "mono", maxlength: 42, autocomplete: "off", spellcheck: "false", name: "merchant" });
  const allow = h("button", { class: "btn ghost small" }, "Allow");
  const disallow = h("button", { class: "btn soft small" }, "Remove");
  const setM = (b, v) => async () => { if (!isAddress(merchantIn.value.trim())) return toast("Enter a valid merchant address", "error"); await send(b, v ? "Allow merchant" : "Remove merchant", { address: D.kindly, abi: K, functionName: "setMandateMerchant", args: [id, getAddress(merchantIn.value.trim()), v] }); toast(v ? "Merchant allowed" : "Merchant removed", "ok"); };
  allow.onclick = setM(allow, true); disallow.onclick = setM(disallow, false);
  const chipCls = st === "Active" ? "ok live" : st === "Frozen" ? "sky" : "bad";
  return h("div", { class: `card panel mandate ${st.toLowerCase()}` },
    h("div", { class: "row between" }, h("div", { class: "row" }, h("h3", {}, primary ? "Spending rules (current)" : "Spending rules"), h("span", { class: `chip ${chipCls}` }, st)), h("span", { class: "small muted" }, `Mandate #${id}`)),
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
        h("p", { class: "small muted" }, "Assistant address ", addrLink(m.agent)),
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
          h("ul", { class: "plain" }, h("li", {}, "Your tUSD8 stays in your wallet. Kindly never holds it."), h("li", {}, "Kindly can move at most this amount, only to merchants your mandate allows."), h("li", {}, "You can reduce it to 0 or revoke it from the dashboard at any time."))),
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
      h("div", { class: "row between sticky-cta" }, h("a", { class: "btn ghost", href: "#/start?step=1" }, "Back"), next)));
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
    const after = h("div", { class: "row hidden" }, h("a", { class: "btn dark", href: "#/" }, "Go to Home"));
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(id || "")) { root.append(h("div", { class: "card" }, h("p", { class: "warn" }, "This review link is incomplete."), h("a", { class: "btn ghost small", href: "#/" }, "Back to dashboard"))); return root; }
  if (!state.account) { root.append(connectCard("review this payment")); return root; }
  const [hold, inv] = await Promise.all([pub.readContract({ address: D.kindly, abi: K, functionName: "getHold", args: [id] }), pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] })]);
  const [payee, verified, decs, created] = await Promise.all([
    pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] }),
    pub.readContract({ address: D.registry, abi: R, functionName: "isVerified", args: [inv.merchant] }),
    events("SafetyDecision", { invoiceId: id }),
    events("InvoiceCreated", { id }).catch(() => []),
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
  const reject = h("button", { class: "btn ghost big" }, ICON.cross(), "Reject");
  const failNote = h("div", { "aria-live": "polite" });
  const allowNow = () => pub.readContract({ address: D.token, abi: erc20Abi, functionName: "allowance", args: [state.account, D.kindly] }).catch(() => null);
  const failed = (what, e) => failNote.replaceChildren(h("div", { class: "jout FAILED", role: "alert" }, h("div", { class: "row" }, stamp("REJECT"), h("b", {}, `${what} failed`)), h("p", { class: "small" }, humanError(e)), h("p", { class: "small muted" }, "Nothing changed: the payment is still held. You can try again.")));
  // Approving moves money, so it never happens on one casual tap: a confirmation step with a tick-box comes first.
  const ack = h("input", { type: "checkbox", name: "ack" });
  const confirmBtn = h("button", { class: "btn ok big", disabled: true }, ICON.check(), "Confirm and sign");
  const backBtn = h("button", { class: "btn ghost big", type: "button" }, "Go back");
  ack.onchange = () => { confirmBtn.disabled = !ack.checked; };
  const ctaRow = h("div", { class: "row sticky-cta" }, approve, reject);
  const confirmBox = h("div", { class: "confirm-box", role: "region", "aria-label": "Confirm approval", hidden: true },
    h("div", { class: "row" }, h("span", { class: "cb-ic", "aria-hidden": "true" }, ICON.shield()), h("h2", { class: "h3" }, "Confirm this payment")),
    h("ul", { class: "cb-list" },
      h("li", {}, "Pay ", h("b", {}, `${fmt(inv.amount)} tUSD8`), " to ", h("b", {}, name), verified ? " (verified merchant)" : " (not verified)"),
      ratio ? h("li", {}, "That's ", h("b", {}, `${ratio.toLocaleString(undefined, { maximumFractionDigits: 1 })}×`), " your usual payment with this merchant") : null,
      h("li", {}, "Paid once from your wallet. Your spending rules don't change."),
      h("li", {}, "Your wallet asks you to sign. It can't be undone once confirmed on-chain.")),
    h("label", { class: "check ack" }, ack, "I checked the merchant and the amount"),
    h("div", { class: "row" }, confirmBtn, backBtn));
  approve.onclick = () => { failNote.replaceChildren(); ctaRow.hidden = true; confirmBox.hidden = false; ack.checked = false; confirmBtn.disabled = true; ack.focus(); };
  backBtn.onclick = () => { confirmBox.hidden = true; ctaRow.hidden = false; approve.focus(); };
  confirmBtn.onclick = async () => {
    state.quiet = true; failNote.replaceChildren(); backBtn.disabled = true;
    try {
      await ensureAllowance(confirmBtn, inv.amount);
      const { hash, result } = await send(confirmBtn, "Approve payment", { address: D.kindly, abi: K, functionName: "approveHold", args: [id, nameHash(payee.name)] });
      const left = await allowNow();
      announce(`Payment approved. ${fmt(inv.amount)} tUSD8 paid to ${name}.`); card.replaceChildren(receiptCard({ amount: inv.amount, merchantName: payee.name, merchant: inv.merchant, memo, invoiceId: id, hash, receipt: result, mandateId: hold.mandateId, decision: "HOLD", approved: true, risk: hold.risk }),
        h("div", { class: "after" }, h("dl", { class: "kv" }, h("dt", {}, "Approval tx"), h("dd", {}, txLink(hash)), left != null ? [h("dt", {}, "Allowance now"), h("dd", {}, money(left))] : null),
          h("a", { class: "btn ghost wide", href: "#/" }, "Back to Home")));
    } catch (e) { failed("Approval", e); } finally { state.quiet = false; backBtn.disabled = false; }
  };
  reject.onclick = async () => {
    if (!confirm(`Reject this ${fromUnits(inv.amount)} tUSD8 payment to “${name}”? Nothing will be paid.`)) return;
    failNote.replaceChildren();
    try {
      const { hash } = await send(reject, "Reject payment", { address: D.kindly, abi: K, functionName: "rejectHold", args: [id] });
      const left = await allowNow();
      card.replaceChildren(h("div", { class: "jout REJECT big" }, h("div", { class: "row" }, stamp("REJECT", true), h("h2", { class: "h3" }, "Payment rejected")),
        h("p", {}, `Nothing was paid to ${name}. The invoice stays unpaid; the merchant can send a corrected one.`),
        h("dl", { class: "kv" }, h("dt", {}, "Rejection tx"), h("dd", {}, txLink(hash)), left != null ? [h("dt", {}, "Allowance (unchanged)"), h("dd", {}, money(left))] : null),
        h("a", { class: "btn ghost wide", href: "#/" }, "Back to Home")));
    } catch (e) { failed("Rejection", e); }
  };
  card.append(
    h("div", { class: "row between" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "New payment request"), h("h1", { class: "title" }, "Invoice received")),
      resolved ? statusChip("confirmed", "Resolved") : statusChip("pending", "Under review")),
    h("div", { class: "review-amt" }, h("span", { class: "n" }, fmt(inv.amount)), tok()),
    h("dl", { class: "summary-kv" },
      h("div", {}, h("dt", {}, "Merchant"), h("dd", {}, name, " ", verified ? statusChip("verified", "Verified") : h("span", { class: "chip amber" }, "Not verified"))),
      h("div", {}, h("dt", {}, "Invoice"), h("dd", {}, memo || "No memo")),
      h("div", {}, h("dt", {}, "Usual amount"), h("dd", {}, usualAmt > 0n ? money(usualAmt) : "No history yet")),
      h("div", {}, h("dt", {}, "Difference"), h("dd", { class: ratio ? "hold-ink" : "" }, ratio ? `${ratio.toLocaleString(undefined, { maximumFractionDigits: 2 })}× usual` : "Not applicable")),
      h("div", {}, h("dt", {}, "Mandate used"), h("dd", {}, `Spending rules #${hold.mandateId}`)),
      h("div", {}, h("dt", {}, "Safety rule"), h("dd", {}, reasonLabel(reason)))),
    h("div", { class: "why-box" }, h("div", { class: "row between" }, h("h2", { class: "h3" }, "Why it's on hold"), stamp("HOLD", true)), h("p", {}, why), h("p", { class: "small" }, h("b", {}, "Rule that fired: "), RULE[reason] || reason), decidedBy()),
    h("div", { class: "grid2 outcomes" },
      h("div", {}, h("strong", {}, "If you approve"), h("p", { class: "small muted" }, `Kindly pays ${fromUnits(inv.amount)} tUSD8 from your wallet to ${name}, once. Your spending rules don't change.`)),
      h("div", {}, h("strong", {}, "If you reject"), h("p", { class: "small muted" }, "Nothing is paid. The invoice stays unpaid and the merchant can send a corrected one."))),
    ...(resolved ? [h("p", { class: "calm" }, ICON.check(), `This hold was already resolved. Invoice status: ${STATUS[inv.status]}.`)] : [ctaRow, confirmBox]),
    failNote,
    h("details", {}, h("summary", {}, "Technical details"), h("div", { class: "body" }, h("dl", { class: "kv" },
      h("dt", {}, "Safety Gate"), h("dd", {}, `HOLD · ${reason}`),
      h("dt", {}, "Risk score"), h("dd", {}, riskView(hold.risk)),
      h("dt", {}, "Mandate"), h("dd", {}, `#${hold.mandateId}`),
      h("dt", {}, "Invoice ID"), h("dd", {}, hashChip(id, "invoice")),
      ev ? [h("dt", {}, "Decision tx"), h("dd", {}, txLink(ev.transactionHash))] : null,
      h("dt", {}, "Merchant address"), h("dd", {}, addrLink(inv.merchant)),
      h("dt", {}, "Held at"), h("dd", {}, new Date(Number(hold.heldAt) * 1000).toLocaleString())))));
  root.append(h("a", { class: "back", href: "#/" }, "Back to Home"), card);
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
      h("a", { class: "btn dark", href: "#/" }, "Done")));
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
      ? h("div", { class: "row between" }, h("div", { class: "merchant-head" }, h("span", { class: "avatar" }, (name[0] || "?").toUpperCase()), h("div", { class: "stack", style: "gap:2px" }, h("h2", { class: "h3" }, name), h("span", { class: "small muted" }, addrLink(state.account)))),
          verified ? statusChip("verified", "Verified merchant") : statusChip("pending", "Awaiting verification"))
      : h("h2", { class: "h3" }, "Register your business"),
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
    h("div", { class: "card panel" }, h("h2", { class: "h3" }, "Create invoice"),
      h("label", { class: "amount-label" }, "Amount", h("div", { class: "amount-field" }, amt, tok())),
      h("label", {}, "What is this for?", memo, h("span", { class: "hint" }, "Public on-chain. Keep names, emails, phones and addresses out. ", trustLink("What's visible?", "privacy"))), h("label", {}, "Invoice number", num),
      h("details", {}, h("summary", {}, "More options"), h("div", { class: "body grid2" }, h("label", {}, "Bill to (optional)", payer), h("label", {}, "Expires in (hours)", hours))),
      createBtn),
    out));
  const list = h("div", { class: "card" }, h("h2", { class: "h3" }, "My invoices"), skeleton());
  root.append(list);
  async function loadList() {
    const logs = await events("InvoiceCreated", { merchant: state.account });
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
    list.replaceChildren(h("h2", { class: "h3" }, "My invoices"), rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["ID", "Memo", "tUSD8", "Status", ""].map((t, i) => h("th", { class: i === 2 ? "num" : "" }, t)))), h("tbody", {}, rows))) : h("p", { class: "muted" }, "No invoices yet. Create one above and share the link or QR code."));
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
  const created = await events("InvoiceCreated", { id: invoiceId }).catch(() => []);
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
    st === "Open" && !expired ? h("div", { class: "sticky-cta solo" }, payBtn) : null,
    h("div", { class: "secured" }, ICON.gate(), "Secured by Kindly Safety Gate · expires ", new Date(Number(inv.expiresAt) * 1000).toLocaleString()),
    h("div", { class: "secured" }, "Your tokens stay in your wallet until this payment. ", trustLink("What's visible on-chain", "privacy")),
    inv.payer !== zeroAddress ? h("p", { class: "small muted", style: "text-align:center" }, "Billed to ", addrLink(inv.payer)) : null].filter(Boolean));
  root.append(card);
  return root;
}
const keccakRefKey = (payer, merchant, ref) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [payer, merchant, ref]));

async function viewActivity() {
  setTitle("Activity");
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const root = h("section", { class: "view" }, pageHead(null, "Activity", "Every payment your agent tried, and what Kindly decided."));
  let filter = ["all", "paid", "held", "rejected"].includes(q.get("f")) ? q.get("f") : "all";
  const list = h("ul", { class: "plist" }, ...[0, 1, 2].map(() => h("li", { class: "prow-skel" }, skeleton())));
  const seg = h("div", { class: "segf", role: "group", "aria-label": "Show payments" });
  let rows = null;
  const EMPTY = {
    all: ["No payments yet", "When your agent submits an invoice, Kindly's decision shows up here."],
    paid: ["Nothing paid yet", "Payments within your rules, and holds you approve, show up here."],
    held: ["Nothing is waiting for you", "Unusual payments pause here until you approve or reject them."],
    rejected: ["Nothing rejected", "Payments blocked by your rules, or holds you reject, show up here."],
  };
  const paint = () => {
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === filter)));
    if (!rows) return;
    for (const b of seg.querySelectorAll("button")) b.querySelector(".seg-n").textContent = String(b.dataset.f === "all" ? rows.length : rows.filter((r) => r.kind === b.dataset.f).length);
    const shown = rows.filter((r) => filter === "all" || r.kind === filter);
    list.replaceChildren(...(shown.length ? shown.map((r) => payRow(r, { open: !!q.get("inv") && same(q.get("inv"), r.invoiceId) })) : [h("li", {}, emptyBox(filter === "held" ? ICON.check() : ICON.activity(), ...EMPTY[filter], filter === "all" ? h("a", { class: "btn ghost small", href: "#/judge" }, "Run guided demo") : null))]));
  };
  for (const [f, t] of [["all", "All"], ["paid", "Paid"], ["held", "Held"], ["rejected", "Rejected"]]) seg.append(h("button", { type: "button", "data-f": f, "aria-pressed": "false", onclick: () => { filter = f; paint(); } }, t, h("span", { class: "seg-n", "aria-hidden": "true" })));
  const load = async () => {
    try { rows = (await myPayments(60)).rows; paint(); }
    catch (e) { list.replaceChildren(h("li", {}, errorBox(e, load))); }
  };
  if (!state.account) root.append(connectCard("see what your agent paid"));
  else if (D.kindly) { root.append(seg, h("div", { class: "card plist-card" }, list)); paint(); load(); }
  root.append(h("h2", { class: "sec-h" }, "Invoices & receipts"), h("ul", { class: "set-list" },
    h("li", { class: "set-row" }, h("span", { class: "set-ic", "aria-hidden": "true" }, ICON.file()), h("span", { class: "set-txt" }, h("b", {}, "Send an invoice"), h("small", {}, "Get paid by link or QR")), h("a", { class: "set-go", href: "#/merchant", "aria-label": "Send an invoice" }, ICON.chev())),
    h("li", { class: "set-row" }, h("span", { class: "set-ic", "aria-hidden": "true" }, ICON.wallet()), h("span", { class: "set-txt" }, h("b", {}, "Pay a payment link"), h("small", {}, "Check the merchant's name, then pay")), h("a", { class: "set-go", href: "#/pay", "aria-label": "Pay a payment link" }, ICON.chev()))),
    verifyBox(q), settlementsBox());
  return root;
}
/** Verify any receipt by invoice ID: readContract verifyReceipt. */
function verifyBox(q) {
  const idIn = h("input", { value: q.get("id") || "", placeholder: "0x… invoice ID", class: "mono", maxlength: 66, name: "invoiceId", autocomplete: "off", spellcheck: "false" });
  const out = h("div", { "aria-live": "polite" });
  const vbtn = h("button", { class: "btn dark" }, "Verify receipt");
  vbtn.onclick = async () => {
    out.replaceChildren(skeleton());
    try {
      const id = idIn.value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("Invoice ID must be 0x followed by 64 hex characters.");
      const inv = await pub.readContract({ address: D.kindly, abi: K, functionName: "getInvoice", args: [id] });
      const ok = await pub.readContract({ address: D.kindly, abi: K, functionName: "verifyReceipt", args: [id, inv.receipt] });
      if (!ok) return out.replaceChildren(h("div", { class: "cop bad" }, h("strong", {}, "No valid receipt for this invoice"), h("p", {}, `Status: ${STATUS[inv.status]}. A receipt exists only after the invoice is paid.`)));
      const [payee, paid, created] = await Promise.all([
        pub.readContract({ address: D.registry, abi: R, functionName: "getPayee", args: [inv.merchant] }),
        events("InvoicePaid", { id }).catch(() => []),
        events("InvoiceCreated", { id }).catch(() => []),
      ]);
      const decs = inv.mandateId > 0n ? await events("SafetyDecision", { invoiceId: id }).catch(() => []) : [];
      const last = decs[decs.length - 1]?.args;
      out.replaceChildren(h("div", { class: "receipt-wrap" }, receiptCard({ amount: inv.amount, merchantName: payee.name, merchant: inv.merchant, memo: created[0]?.args?.memo, invoiceId: null, hash: paid[0]?.transactionHash, receipt: inv.receipt, mandateId: inv.mandateId, decision: last ? DECISION[last.decision] : null, approved: last && DECISION[last.decision] === "HOLD", risk: last?.risk, paidBy: inv.paidBy })));
    } catch (e) { out.replaceChildren(h("p", { class: "warn", role: "alert" }, e.message?.startsWith("Invoice ID") ? e.message : humanError(e))); }
  };
  const d = h("details", { class: "card tech-card", open: q.get("id") ? true : null }, h("summary", {}, ICON.receipt(), "Verify a receipt"),
    h("div", { class: "body stack" }, h("p", { class: "small muted" }, "Every paid invoice has an on-chain receipt anyone can check."), h("div", { class: "row", style: "align-items:end" }, h("label", { style: "flex:1;min-width:220px" }, "Invoice ID", idIn), vbtn), out));
  if (q.get("id")) setTimeout(() => vbtn.click(), 0);
  return d;
}
/** Latest settlements on the network: loaded only when opened. */
function settlementsBox() {
  const body = h("div", { class: "body" }, skeleton());
  const d = h("details", { class: "card tech-card" }, h("summary", {}, ICON.activity(), "Latest settlements on the network"), body);
  let done = false;
  d.addEventListener("toggle", async () => {
    if (!d.open || done || !D.kindly) return; done = true;
    try {
      const logs = await events("InvoicePaid");
      const rows = logs.slice().reverse().slice(0, 30).map((lg) => h("tr", {}, h("td", {}, txLink(lg.transactionHash)), h("td", { class: "num" }, fmt(lg.args.amount)), h("td", {}, addrLink(lg.args.merchant)),
        h("td", {}, lg.args.mandateId > 0n ? h("span", { class: "chip lav" }, `assistant #${lg.args.mandateId}`) : h("span", { class: "chip" }, "direct")), h("td", {}, hashChip(lg.args.receipt, "receipt"))));
      body.replaceChildren(rows.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Transaction", "tUSD8", "Merchant", "Path", "Receipt"].map((t, i) => h("th", { class: i === 1 ? "num" : "" }, t)))), h("tbody", {}, rows))) : h("p", { class: "muted" }, "No payments yet."));
    } catch (e) { done = false; body.replaceChildren(errorBox(e, () => { d.open = false; d.open = true; })); }
  });
  return d;
}

// ------------------------------------------------------------------ Settings (app tab): wallet, network, safety, install, privacy
/** Settings, iPhone style: grouped rounded lists. Every row opens something real. */
function viewSettings() {
  setTitle("Settings");
  const root = h("section", { class: "view" }, pageHead(null, "Settings", null));
  const row = (icon, title, sub, action, cls = "") => h("li", { class: `set-row ${cls}` }, h("span", { class: "set-ic", "aria-hidden": "true" }, icon), h("span", { class: "set-txt" }, h("b", {}, title), sub ? h("small", {}, sub) : null), action || null);
  const go = (href, label) => h("a", { class: "set-go", href, "aria-label": label }, ICON.chev());
  const pill = (txt, kind = "") => h("span", { class: `spill ${kind}` }, txt);
  const read = (kind) => h("button", { class: "btn ghost small", type: "button", onclick: () => trustModal(kind) }, "Read");
  const group = (title, ...rows) => h("div", { class: "set-group" }, title ? h("h2", { class: "set-h" }, title) : null, h("ul", { class: "set-list" }, ...rows));
  // Freeze row shows the real state of your current spending rules, read from the contract.
  const freezeRow = row(ICON.snow(), "Freeze your agent", "Stops every payment at once", go("#/?freeze=1", "Go to Home to freeze your agent"), "freeze-row-s");
  if (state.account && D.kindly) (async () => {
    const ids = (await events("MandateCreated", { owner: state.account })).map((l) => l.args.id).reverse();
    let st = null;
    for (const id of ids.slice(0, 12)) { const m = await pub.readContract({ address: D.kindly, abi: K, functionName: "getMandate", args: [id] }); const x = mandateStatus(m); if (x === "Active" || x === "Frozen") { st = x; if (x === "Active") break; } }
    freezeRow.classList.add(st === "Frozen" ? "is-frozen" : st === "Active" ? "is-active" : "is-none");
    freezeRow.querySelector(".set-txt small").textContent = st === "Frozen" ? "Nothing can be paid until you unfreeze" : st === "Active" ? "Stops every payment at once" : "No live spending rules yet";
    freezeRow.querySelector(".set-txt b").after(h("span", { class: `spill ${st === "Frozen" ? "sky" : st === "Active" ? "ok" : ""}` }, st === "Frozen" ? "Frozen" : st === "Active" ? "Agent active" : "No agent"));
  })().catch(() => {});
  const disconnect = async () => {
    // A web page can't log a wallet out. MetaMask supports revoking this site's account permission; Kindly forgets the account either way.
    await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
    disconnectLocal();
  };
  const live = CHAIN.id === 44005;
  const aboutSheet = () => sheet("About Kindly", [
    h("p", {}, "Kindly lets an AI agent pay invoices for you inside a bounded allowance. A smart contract checks fixed rules on every payment; anything unusual waits for you. No AI model makes the decision."),
    h("ul", { class: "set-list flat" },
      row(ICON.play(), "Guided demo", "Two scenarios with real testnet transactions", go("#/judge", "Open the guided demo")),
      row(ICON.file(), "2-minute walkthrough video", "Narrated, recorded on the live site", h("a", { class: "set-go", href: VIDEO_URL, target: "_blank", rel: "noopener", "aria-label": "Watch the walkthrough video (new tab)" }, ICON.ext())),
      row(ICON.help(), "Glossary", "Spending rules, allowance, Safety Gate, hold", h("button", { class: "btn ghost small", type: "button", onclick: () => sheet("Glossary", h("dl", { class: "kv gloss" }, Object.entries(GLOSSARY).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))) }, "Open"), "info"),
      row(ICON.file(), "Source code and docs", "MIT licensed, on GitHub", h("a", { class: "set-go", href: REPO, target: "_blank", rel: "noopener", "aria-label": "Open the source code on GitHub (new tab)" }, ICON.ext()))),
    h("p", { class: "small muted" }, "Testnet software with automated tests and no external audit. Never use it with real funds.")]);
  const testnetSheet = () => sheet("Testnet information", [
    h("p", {}, live ? "Kindly runs on QDay Aevum Testnet. tUSD8 is a test stablecoin with no real value." : `This is a local rehearsal chain (${CHAIN.name}). Nothing here is real or public.`),
    h("dl", { class: "kv" },
      h("dt", {}, "Network"), h("dd", {}, CHAIN.name),
      h("dt", {}, "Chain ID"), h("dd", { class: "mono" }, String(CHAIN.id)),
      h("dt", {}, "Token"), h("dd", {}, "tUSD8 ", addrLink(D.token)),
      h("dt", {}, "Kindly contract"), h("dd", {}, addrLink(D.kindly)),
      h("dt", {}, "Payee registry"), h("dd", {}, addrLink(D.registry)),
      live ? [h("dt", {}, "Explorer"), h("dd", {}, h("a", { href: "https://explorer-test.qday.info", target: "_blank", rel: "noopener" }, "explorer-test.qday.info"))] : null,
      live ? [h("dt", {}, "Test tokens"), h("dd", {}, h("a", { href: FAUCET_URL, target: "_blank", rel: "noopener" }, "QDay faucet"))] : null)]);
  root.append(h("div", { class: "settings-grid" },
    h("div", { class: "stack", style: "gap:22px" },
      group("Wallet",
        state.account
          ? row(h("span", { class: "fox-av" }, fox(20)), h("code", {}, short(state.account)), state.wrongNet ? "MetaMask · wrong network" : "MetaMask · connected wallet", state.wrongNet ? pill("Wrong network", "warn") : pill("Connected", "ok"), "tap-row")
          : row(h("span", { class: "fox-av" }, fox(20)), "Connected wallet", window.ethereum ? "Not connected" : isMobileDevice() ? "Open Kindly in the MetaMask app to connect" : "Needs a browser wallet such as MetaMask", h("button", { class: "btn dark small", type: "button", onclick: () => connect().catch((e) => toast(humanError(e), "error")) }, "Connect")),
        row(ICON.aevum(), "Network", live ? "QDay Aevum Testnet · test tokens only" : `${CHAIN.name} · local rehearsal, not real data`, h("button", { class: "btn ghost small", type: "button", onclick: networkSheet }, "View")),
        state.account ? h("li", { class: "set-row danger" }, h("button", { class: "set-btn", type: "button", onclick: disconnect }, ICON.logout(), "Disconnect wallet")) : null),
      group("Safety",
        row(ICON.gate(), "Allowance & mandates", "A bounded allowance. Set it to 0 any time.", go("#/wallet", "Open Wallet")),
        freezeRow,
        row(ICON.shield(), "Funds protection", "What Kindly can and can't touch", read("funds")))),
    h("div", { class: "stack", style: "gap:22px" },
      group("Preferences",
        row(ICON.bell(), "Notifications", "Holds show up on Home within seconds. Push notifications are coming soon.", pill("In-app")),
        row(ICON.lock(), "Privacy & security", "What's visible on-chain, and what Kindly never stores", read("privacy"))),
      h("div", { class: "set-group" }, h("h2", { class: "set-h" }, "App"), installSection(h, ICON)),
      group("About",
        row(h("span", { class: "mark mini", "aria-hidden": "true" }, document.querySelector(".brand .mark svg")?.cloneNode(true) || ""), "About Kindly", "What it is, guided demo, video, source", h("button", { class: "btn ghost small", type: "button", onclick: aboutSheet }, "Open")),
        row(ICON.aevum(), "Testnet information", live ? "Chain 44005 · contracts · faucet" : "Local rehearsal chain", h("button", { class: "btn ghost small", type: "button", onclick: testnetSheet }, "Open"))))));
  return root;
}

// ------------------------------------------------------------------ router
const TAB_TITLE = (p) => p.startsWith("/judge") ? "Guided demo" : p.startsWith("/demo") ? "Live demo" : /^\/(control|start|review)/.test(p) ? "Home" : /^\/(invoices|merchant|pay|activity)/.test(p) ? "Activity" : p.startsWith("/wallet") ? "Wallet" : p.startsWith("/settings") ? "Settings" : "Home";
/** Phones: tables become stacked cards; each cell gets its column name as a label. */
new MutationObserver(() => { for (const t of $app.querySelectorAll("table:not([data-labelled])")) { const hs = [...t.querySelectorAll("thead th")].map((x) => x.textContent); t.querySelectorAll("tbody tr").forEach((tr) => [...tr.children].forEach((td, i) => hs[i] && td.setAttribute("data-label", hs[i]))); if (t.tBodies[0]?.rows.length) t.dataset.labelled = "1"; } }).observe($app, { childList: true, subtree: true });
let lastTab = -1, lastPath = "";
// Re-tapping the active tab returns to the top of that tab (native tab-bar convention).
document.getElementById("nav").addEventListener("click", (e) => {
  const a = e.target.closest("a"); if (!a) return;
  if (a.getAttribute("href") === location.hash || (a.getAttribute("href") === "#/" && !location.hash)) { e.preventDefault(); window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" }); }
});
/** iOS-style large title: the compact title in the app bar appears only once the page's large title has scrolled away. */
let titleIO = null;
function watchLargeTitle() {
  titleIO?.disconnect();
  const big = $app.querySelector("h1"); const bar = document.querySelector(".appbar-title");
  if (!big || !("IntersectionObserver" in window)) { bar.classList.add("shown"); return; }
  bar.classList.remove("shown");
  titleIO = new IntersectionObserver(([en]) => bar.classList.toggle("shown", !en.isIntersecting), { rootMargin: "-56px 0px 0px 0px" });
  titleIO.observe(big);
}
async function route() {
  const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
  document.querySelectorAll("#nav a").forEach((a) => {
    const on = a.dataset.match.split(" ").some((m) => (m === "/" ? path === "/" : path.startsWith(m)));
    a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const tabs = [...document.querySelectorAll("#nav a")]; const ti = Math.max(0, tabs.findIndex((a) => a.classList.contains("active")));
  // Tabs are peers: switching tabs never slides. Going deeper inside a tab (e.g. Payments → Review) is a push.
  const deeper = ti === lastTab && path !== lastPath && path.split("/").length > (lastPath.split("/").length || 0);
  document.documentElement.dataset.dir = deeper ? "push" : ti === lastTab ? "same" : "tab"; lastTab = ti; lastPath = path;
  $app.replaceChildren(h("section", { class: "view" }, skeleton()));
  if (!path.startsWith("/judge") && document.body.dataset.replay) { document.body.dataset.replay = ""; paintMode(); }
  try {
    let v;
    if (path.startsWith("/judge")) v = viewJudge();
    else if (path.startsWith("/demo")) v = viewDemo();
    else if (path.startsWith("/control")) v = await viewControl("home");
    else if (path.startsWith("/wallet")) v = await viewControl("wallet");
    else if (path.startsWith("/start")) v = await viewStart();
    else if (path.startsWith("/review/")) v = await viewReview();
    else if (path.startsWith("/invoices") || path.startsWith("/merchant")) v = await viewMerchant();
    else if (path.startsWith("/pay")) v = await viewPay();
    else if (path.startsWith("/activity")) v = await viewActivity();
    else if (path.startsWith("/settings")) v = viewSettings();
    else v = state.account ? await viewControl("home") : viewHome();
    $app.replaceChildren(v);
    document.querySelector(".appbar-title").textContent = TAB_TITLE(path);
    watchLargeTitle();
  } catch (e) {
    $app.replaceChildren(h("section", { class: "view" }, h("div", { class: "card" }, h("p", { class: "warn" }, humanError(e)), h("div", { class: "row" }, h("button", { class: "btn ghost small", onclick: () => route() }, "Try again"), h("a", { class: "btn ghost small", href: "#/" }, "Go home")))));
  }
}
// ------------------------------------------------------------------ sidebar: collapse to an icon rail, arrow-key navigation, wallet block
{
  const root = document.documentElement, tog = document.getElementById("sideToggle");
  const desk = window.matchMedia("(min-width: 1024px)");
  const sync = () => {
    const expanded = desk.matches ? !root.classList.contains("side-collapsed") : root.classList.contains("side-open");
    tog.setAttribute("aria-expanded", String(expanded)); tog.setAttribute("aria-label", expanded ? "Collapse sidebar" : "Expand sidebar");
  };
  if (localStorage.getItem("kindly.side") === "rail") root.classList.add("side-collapsed");
  tog.onclick = () => {
    if (desk.matches) { root.classList.toggle("side-collapsed"); localStorage.setItem("kindly.side", root.classList.contains("side-collapsed") ? "rail" : "full"); }
    else { root.classList.toggle("side-open"); if (root.classList.contains("side-open")) document.querySelector("#nav a.active, #nav a")?.focus(); }
    sync();
  };
  document.querySelector(".main-col").addEventListener("click", (e) => { if (root.classList.contains("side-open") && !e.target.closest("button, a")) { root.classList.remove("side-open"); sync(); } });
  // Rail tooltips: the label stays in the accessibility tree, title shows it on hover.
  document.querySelectorAll("#nav a, .side-freeze").forEach((a) => a.title = a.textContent.trim());
  desk.addEventListener?.("change", () => { root.classList.remove("side-open"); sync(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("side-open")) { root.classList.remove("side-open"); sync(); tog.focus(); } });
  document.getElementById("nav").addEventListener("click", () => { if (root.classList.contains("side-open")) { root.classList.remove("side-open"); sync(); } });
  // Up/Down/Home/End move between sidebar destinations (Tab still walks the page normally).
  document.getElementById("nav").addEventListener("keydown", (e) => {
    const links = [...document.querySelectorAll("#nav a")]; const i = links.indexOf(document.activeElement); if (i < 0) return;
    const j = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: links.length - 1 }[e.key];
    if (j == null) return; e.preventDefault(); links[(j + links.length) % links.length].focus();
  });
  sync();
  document.getElementById("sideWallet").onclick = () => document.getElementById("connect").click();
}
document.getElementById("connect").onclick = () => (state.account ? toggleWalletPanel() : connect().catch((e) => toast(humanError(e), "error")));
window.addEventListener("hashchange", () => { document.getElementById("walletPop")?.remove(); route(); window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" }); });
window.addEventListener("scroll", () => document.querySelector(".top")?.classList.toggle("scrolled", window.scrollY > 4), { passive: true });
if (!D.kindly) banner(`Kindly is not deployed on ${CHAIN.name} yet. Read-only mode. Test tokens: ${FAUCET_URL}`);
void REASON;
paintMode();
refreshHeader();
setInterval(refreshHeader, 15000);
initPwa({ h, icon: ICON, appName: "Kindly", offlineText: "Wallet and payment state may be outdated. Balances, holds and receipts refresh when you reconnect." });
route();
