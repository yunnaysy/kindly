// PWA helpers shared by the app shell: service worker, offline screen, install hint.
// No chain state is ever cached here; the service worker only stores the app shell and static assets.
export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isMobileDevice = () => /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) || (window.matchMedia?.("(pointer: coarse)").matches && window.innerWidth <= 1024);

let deferred = null; // Android/Chrome beforeinstallprompt event
const KEY = "kindly.installHint.dismissed";
let H, ICON;

/** Settings → App: how to install, with the real install button when the browser offers one. */
export function installSection(h, icon) {
  const box = h("div", { class: "install-box" });
  const render = () => {
    if (isStandalone()) return box.replaceChildren(h("p", { class: "small" }, "Installed. Kindly is running as an app on this device."));
    if (deferred) {
      const b = h("button", { class: "btn dark", type: "button" }, icon.phone(), "Install Kindly");
      b.onclick = async () => { deferred.prompt(); await deferred.userChoice.catch(() => null); deferred = null; render(); };
      return box.replaceChildren(h("p", { class: "small muted" }, "Add Kindly to your home screen. It opens full screen, like an app."), b);
    }
    if (isIOS()) return box.replaceChildren(h("p", { class: "small" }, "On iPhone or iPad: tap ", h("b", {}, "Share"), ", then ", h("b", {}, "Add to Home Screen"), "."), h("p", { class: "small muted" }, "Kindly then opens full screen, with its own icon."));
    box.replaceChildren(h("p", { class: "small muted" }, "On a phone, open this page in Chrome or Safari and use “Add to Home Screen” (or “Install app”). Kindly then opens full screen, with its own icon."));
  };
  render(); window.addEventListener("kindly:installable", render);
  return box;
}

function installHint() {
  if (isStandalone() || localStorage.getItem(KEY) || document.getElementById("installHint")) return;
  if (!(deferred || isIOS()) || window.innerWidth > 640) return;
  const h = H;
  const dismiss = h("button", { class: "icon-btn", type: "button", "aria-label": "Dismiss install hint" }, ICON.close());
  const body = deferred
    ? [h("span", {}, h("b", {}, "Install Kindly"), h("small", {}, "Full screen, one tap from your home screen.")), h("button", { class: "btn dark small", type: "button", onclick: async () => { deferred.prompt(); await deferred.userChoice.catch(() => null); deferred = null; hint.remove(); } }, "Install")]
    : [h("span", {}, h("b", {}, "Add Kindly to your Home Screen"), h("small", {}, "Tap Share, then “Add to Home Screen”."))];
  const hint = h("div", { id: "installHint", class: "install-hint", role: "region", "aria-label": "Install Kindly" }, h("span", { class: "ih-ic", "aria-hidden": "true" }, ICON.phone()), ...body, dismiss);
  dismiss.onclick = () => { localStorage.setItem(KEY, "1"); hint.remove(); };
  document.body.append(hint);
}

function offlineScreen(appName, text) {
  const h = H;
  const set = () => {
    const off = !navigator.onLine;
    document.body.classList.toggle("is-offline", off);
    let el = document.getElementById("offline");
    if (off && !el) {
      const retry = h("button", { class: "btn dark", type: "button", onclick: () => location.reload() }, "Try again");
      el = h("div", { id: "offline", class: "offline", role: "alert", "aria-labelledby": "off-t", "aria-describedby": "off-d" },
        h("div", { class: "offline-card" }, h("span", { class: "es-icon", "aria-hidden": "true" }, ICON.wallet()),
          h("h2", { id: "off-t" }, "You're offline."), h("p", { id: "off-d", class: "muted" }, text),
          h("p", { class: "small muted" }, `${appName} never shows a cached balance as live. Nothing is sent while you're offline.`),
          h("div", { class: "row" }, retry, h("button", { class: "btn ghost", type: "button", onclick: () => el.remove() }, "Keep browsing"))));
      document.body.append(el);
    } else if (!off && el) el.remove();
  };
  window.addEventListener("online", set); window.addEventListener("offline", set); set();
}

export function initPwa({ h, icon, appName, offlineText }) {
  H = h; ICON = icon;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; window.dispatchEvent(new Event("kindly:installable")); installHint(); });
  window.addEventListener("appinstalled", () => { deferred = null; document.getElementById("installHint")?.remove(); });
  setTimeout(installHint, 2500);
  offlineScreen(appName, offlineText);
  document.documentElement.classList.toggle("standalone", isStandalone());
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}

/**
 * Drag-to-dismiss for bottom sheets (phones only). The finger owns the sheet: it follows 1:1 from the grab point,
 * rubber-bands upward, and on release a flick (velocity) or a drag past a quarter of its height commits.
 * Exit is faster than the entrance (200ms vs 250ms) and leaves the way it came in.
 */
export function dragToDismiss(panel, handle, close) {
  const phone = () => window.matchMedia("(max-width: 640px)").matches;
  let y0 = 0, t0 = 0, last = 0, lastT = 0, dy = 0, active = false;
  handle.classList.add("grabber-zone");
  handle.addEventListener("pointerdown", (e) => {
    if (!phone()) return;
    active = true; y0 = last = e.clientY; t0 = lastT = performance.now(); dy = 0;
    panel.classList.remove("settling", "leaving"); panel.classList.add("dragging");
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!active) return;
    const raw = e.clientY - y0; dy = raw > 0 ? raw : raw / 4; // resist upward drags
    panel.style.transform = `translateY(${dy}px)`; lastT = performance.now(); last = e.clientY;
  });
  const end = (e) => {
    if (!active) return; active = false;
    const v = (e.clientY - last) / Math.max(1, performance.now() - lastT) || (dy / Math.max(1, performance.now() - t0));
    panel.classList.remove("dragging");
    if (dy > panel.offsetHeight / 4 || (v > 0.5 && dy > 10)) {
      panel.classList.add("leaving"); panel.style.transform = "translateY(100%)"; panel.style.opacity = "0";
      setTimeout(close, 200);
    } else { panel.classList.add("settling"); panel.style.transform = ""; setTimeout(() => panel.classList.remove("settling"), 260); }
  };
  handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
}
