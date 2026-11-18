# Kindly design notes

**Direction: "Quiet trust."** Kindly should feel like a calm fintech app, not a developer demo. The product is the permission layer between an AI agent and your money, so the UI leads with the decision (PAY, HOLD or REJECT) and with what the agent can and can't do.

The primary spec came from a ChatGPT critique of the old UI (summarized below). It was blended with patterns from eight X posts the user shared.


## Redesign v2: white-first (Nov 2026) — current

This section supersedes the palette and layout above where they conflict. Source: a second ChatGPT critique ("simple but useful").

- **Look:** white-first. Canvas `#FAFAFC`, cards `#FFFFFF`, ink `#1F1E24`, muted `#62616E`, border `#ECECF1`. Pastels are used sparingly for tints only: pink, lavender (`--lav-soft`), peach, mint, butter. Primary accent coral `#E26D8F` with `#B13D62` for text and buttons (AA). The AI/agent colour is `#5A51B0` on `#EEEBFD`.
- **Brand mark:** a minimal cat face shaped like a shield (dark `#2B2A33`, white eyes, pink nose) on a lavender tile. It reads at 32px. Masters are in `docs/brand/`; the favicon, PWA icons (192/512/maskable), apple-touch icon and OG image are generated from them.
- **Navigation:** Home · Activity · Wallet · Settings.
- **Home** answers "am I OK?" in about 5 seconds: a held payment first (if any), then **Allowance left** (a big number plus a progress bar) with **Freeze**, three small metric cards (max per payment, spent so far, needs you) and the 3 most recent items. Spending rules sit behind "Spending rules & details".
- **Activity:** segmented filters All / Paid / Held / Rejected, with counts. Tap a row to see the security checks plus technical details (tx hash, contract, block). Invoices, pay-a-link and receipt verification sit below.
- **Wallet:** Connected wallet (official MetaMask fox only), Allowance / Funds protection, Network & token (chain ID and addresses behind "Details"), Mandates. On desktop it is one readable column (max 900px).
- **Settings:** Wallet / Safety (Allowance & mandates, Freeze, Funds protection) / Preferences (Notifications — push is *coming soon*, Privacy & security) / About (About Kindly, Testnet information).
- **Payment review:** merchant, amount, why it was held, how it compares with the usual amount, the mandate used and the safety rule. **Approve** opens a confirmation box: a summary, a required checkbox ("I checked the merchant and the amount"), then **Confirm and sign**. Approval is never a single casual tap.
- Every page has empty, loading and error states. The testnet badge is always visible, and nothing hides behind the bottom nav.

## Palette

| Token | Hex | Use |
|---|---|---|
| canvas | `#F7F6F3` | page background, warm off-white (was `#F8F6F1`) |
| surface | `#FFFFFF` | cards, panels |
| ink | `#1D1C1A` | near-black text, dark buttons, the Safety Gate bar (was `#302E2B`) |
| muted | `#6F6860` | secondary text. The critique suggested `#827B73`; it was darkened to pass WCAG AA (axe-core) |
| border | `#ECEAE5` / strong `#DDD9D1` | hairlines (cards now rely on shadow, not borders) |
| coral | `#E8755A` | accents only (about 2% of the screen) |
| coral-ink | `#B9503A` | primary buttons. White on `#E8755A` is only 2.95:1, so buttons use the deeper coral (4.9:1) |
| coral-soft | `#FBEAE5` | avatars, soft accents |
| success | `#266D50` on `#E6F2EA` | PAY, verified |
| hold | `#8A6415` on `#F9ECCD` | HOLD, approval required |
| reject | `#A83D35` on `#F8E5E2` | REJECT, danger zone |
| violet (AI) | `#59558D` on `#E9E8F6` | anything the agent says or does, focus rings |
| frost | `#3F6A8A` on `#E5EEF4` | frozen mandates |

Radius: cards 22px, panels and settings groups 26px, controls 14px, the demo stage 28px. Shadows are two soft layers: card `0 1px 2px` + `0 8px 28px` at 4 to 5% ink, floating `0 2px 6px` + `0 16px 40px`, lifted `0 18px 48px rgba(29,28,26,.12)`.

## Type (Fontshare, self-hosted)

- **Satoshi** (Fontshare) for headlines and UI: hero 56px/700, page titles 30 to 36px, body 15.5px/400, buttons 14.5px/700. Satoshi has true tabular figures, so every amount keeps `font-variant-numeric: tabular-nums`.
- **Sentient** italic 400 (Fontshare) for one word only: "*Safely.*" in the hero. This is the single documented brand override of the "emphasis stays in the family" rule.
- **JetBrains Mono** (variable 400 to 500, OFL) 12 to 13px for addresses, hashes, invoice IDs and risk scores.
- Self-hosted woff2 in `web/public/fonts/`, `font-display: swap`, Satoshi 400 and 700 preloaded. No font CDN; the CSP is `font-src 'self'`.
- **License.** Fontshare fonts use the ITF Free Font License (FFL): free for personal and commercial use, including self-hosting on our own site. It forbids redistributing the files from a repository or public file server, and forbids modifying or converting them. So we ship the official woff2 files unchanged, the Fontshare files are **gitignored**, and `npm run fonts` (`scripts/fetch-fonts.sh`) downloads them before every build. JetBrains Mono is OFL and is committed with `OFL-NOTICE.md`.

## Layout

- **Nav:** `kindly | Product · Demo · Controls · Invoices`. Merchant, Pay and Receipts are merged into **Invoices** as a segmented control (Send · Pay · Receipts). The chain pill is subdued and the wallet is a compact dark pill.
- **Product:** a two-column hero with a floating payment card on a dotted field. The card cycles PAY → HOLD → REJECT, and each check ticks in turn. Below it, a horizontal 3-step explainer (01 Verify · 02 Control · 03 Confirm) and a centered pitch line.
- **Demo:** a single stage. The dark **Safety Gate** bar sits above three invoice cards. The active card lifts into the gate while a scan sweeps across it. Then its checks resolve and the verdict stamps in. The HOLD card grows an inline "Approval required" panel. The run ends on "**Autonomy, with boundaries.**" with a tally. Execution logs collapse under "View execution details". "Replay recorded run" animates the real Aevum run, with explorer links, without a wallet. `#/demo?replay=1` autoplays it.
- **Controls ("Agent permissions"):** an amber "Approval required" panel, or a calm green "Nothing is waiting". Next comes **Funds & permissions** (wallet balance, agent budget, per-payment limit, exact allowance, a can/can't list and the recovery path). Then one hero card per mandate, with the remaining budget as the largest number. Settings live in an "Edit limits & merchants" drawer, and Revoke sits in a danger zone. Freeze is a secondary button. Recent activity shows 3 items, with "All activity →" to expand.
- **Invoices · Send:** a verified merchant header, a big amount field, a memo with a privacy hint, and options folded away. The created state is a QR on white with "Copy payment link →".
- **Invoices · Pay:** state A is a calm request card in the style of Apple Pay ("PAYING TO … ✓ Verified merchant · The wallet name matches this merchant", "Secured by Kindly Safety Gate"). State B is "Payment sent", with an animated check, a receipt and Done.
- **Trust modal:** "How your funds are protected" (4 cards plus Implemented vs. roadmap) and "What's visible on-chain".

## Motion (150 to 250ms, ease-out quint, no bounce)

- Buttons rise 1px and gain a shadow on hover, and press down to `scale(.97)`. Arrows nudge 3px. Cards get a darker border and rise 2px.
- Views fade in with a 4px slide. The QR scales from 0.98 to 1. The modal rises 8px.
- PAY draws its check stroke (`stroke-dashoffset`). HOLD pulses once in amber. REJECT's cross pops in.
- The budget bar and risk meters grow from 0. Skeleton shimmer replaces spinners for page loads.
- During the demo, wallet-confirmation toasts are muted in favor of persistent states. Toasts stack (max 3) instead of overlapping.
- `prefers-reduced-motion: reduce` collapses every animation to 1ms. The hero card shows a static PAY, and the replay completes instantly.

## Which source inspired what

| Source | What we took |
|---|---|
| ChatGPT critique (via the user) | Primary spec: "Quiet trust" palette, the fonts, nav and Invoices merge, the three-act demo, Controls as Agent permissions, the Pay states, motion timings, the 12-second wow sequence, the "Autonomy, with boundaries." end frame |
| ChatGPT security & privacy guidance | Funds & permissions panel, "How your funds are protected" modal, "What's visible on-chain", recovery path, the pitch lines ("Kindly doesn't give AI your wallet. It gives AI a permission to spend."), neutral memo defaults with a PII warning |
| @iamtanzil_ 2117951858404913336 (jiro.build, land-book, godly, minimal.gallery, fontinlogo, 60fps.design, 3dicons) | Gallery-grade hero composition: big headline left, one floating product object right (as in the reel's landing pages). "Clean beats clever" (minimal.gallery) for the restraint. 60fps.design for small, purposeful UI motion |
| @Skirook 2116857233887907988 (devault ASCII, quickpick, modulify, dotmatrix, motionin) | The dotted-matrix field behind the hero card and the demo stage. The tidy app-launcher card grid from quickpick for the 3-step explainer |
| @amananimates 2113599514103906657 (scrolltide, shaders, free type, easing curves) | Easing discipline: one ease-out-quint curve everywhere, and why linear or bouncy motion feels cheap. The soft gradient halo behind the header is a still, cheap stand-in for a shader background |
| @Skirook 2119305314759749692 (DESIGN.md resources: devault, refero styles, neuform, typeui, aura) | Writing this DESIGN_NOTES.md as a design-system file (tokens, type, motion) that an AI coding agent can follow |
| @creativedash 2118192577849741393 (iconmcp) | One consistent stroke icon style (inline SVG, 2px strokes, round caps) |
| @e1genqq 2122435244028542995 ("UI/UX studio in 11 free repos": UI UX Pro Max, Penpot, shadcn/ui, Radix, Tailwind, Lucide, Motion, Magic UI, Storybook, axe-core, Playwright) | Lucide-style stroke icons, Radix-style accessible patterns (native `<dialog>`, `aria-current`, focus rings, progressbar roles), the serif-italic accent from the reel, and the pipeline "brief → design system → components → motion → test → ship". We test with **axe-core** (WCAG 2 A/AA, 0 violations on every route) and a headless browser flow test |
| @BNBCHAIN 2123020505083199585, @Zorvh87 2123041742371140030 | Not design inspiration (a hackathon and a bug-bounty list). Not applied |

All fonts are free (Fontshare FFL + OFL) and every icon is inline SVG. No paid assets.

## Guided journey and Web3 identity (ChatGPT flow spec, Nov 2026)

- **Connect → 3-step setup (`#/start`).** (1) *Set a spending allowance*: an exact ERC-20 approval, never unlimited. It shows the token, spender and network as hash chips, estimated gas, and "What this approval means". (2) *How much freedom should your agent have?*: Everyday or Strict presets over the real `MandateParams` fields only (agent, payment limit, total budget, usual amount, valid days, cooldown, any merchant, verified payees only, merchant list). Validation errors appear next to each field. (3) *Review & activate*: a summary and the line "Your AI can request payments but cannot bypass these contract-enforced limits." Activation runs approve (only if the amount changed) and then `createMandate`. The shield draws and the status turns "Active · Limited permissions".
- **Dashboard home (`#/controls`).** The title is "Everything under control." or "N payments need you." The agent card shows the remaining budget, payment limit, usual amount, allowed merchants (counted from `MandateMerchantSet` events), the expiry date and a prominent **Freeze agent** button. A charcoal wallet card shows the real balance, plus "Kindly may move at most" (the live allowance) and a link to reduce it to 0.
- **Reason-first HOLD review (`#/review/<invoiceId>`).** It shows the amount, the merchant and whether it is verified, the usual amount, "Difference: N× usual", and "Why it's on hold" (from `getHold().reason`), then what approving or rejecting does. Approving settles once and does not change any limits, which matches `approveHold`. Technical details are folded away.
- **Receipts.** One receipt card with hash chips for the tx and the receipt, a Verify action and the explorer link.
- **Identity.** An Aevum chain chip with the live block number. The address pill opens a wallet panel (balance, network, "Kindly never holds your funds"), so the balance is no longer in the navbar. The tUSD8 token badge, the Safety Gate glyph (brand mark, favicon, demo) and hash chips with copy.
- **Truthful copy.** It says *allowance* and never *deposit*: funds stay in the user's wallet. Run the live demo and the recorded replay stay one click from Home and from the setup screen, so judges can skip onboarding.

## Anti-slop audit (Nov 2026)

Source: @achxvi's post "10 skills that kill AI slop" (x.com/achxvi/status/2123016367125540918). We read all 10 as reference text only. Nothing was installed and none of their scripts were run: uizze.com, pbakaus/impeccable, Leonxlnx/taste-skill, emilkowalski/skills, vercel-labs/web-interface-guidelines, anthropics/skills (frontend-design), Nutlope/hallmark, jakubkrehel/make-interfaces-feel-better, nextlevelbuilder/ui-ux-pro-max-skill and benjitaylor/skills.

**The 3 we used as the checklist:**
1. **Vercel Web Interface Guidelines.** Testable accessibility and interaction MUSTs: focus-visible, 44px targets, `aria-live`, field-level errors with `aria-invalid`, autocomplete/name attributes, tabular numbers, `Intl` formatting, a page title per route and scroll margins.
2. **Emil Kowalski's design-eng skill.** Motion craft: one strong ease-out `cubic-bezier(.23,1,.32,1)`, 150–250ms, `scale(.97)` on press, never `ease-in`, and no looping animation on screens people look at all day.
3. **Anthropic frontend-design.** Slop tells: ALL-CAPS tracked eyebrows, emoji icons, endless float and breathe loops, an arrow appended to every button and the generic card kit.

Jakub Krehel's make-interfaces-feel-better was a secondary reference for `text-wrap: balance/pretty`, tabular nums and hit areas.

| Before | After |
|---|---|
| ALL-CAPS tracked eyebrows and table heads; "Why Kindly" style section labels | Sentence case; decorative eyebrows removed |
| Hero card floating forever; live chips breathing; attention pulse looping | Still by default. The hero card has a Pause/Play control and stops when the tab is hidden |
| Gradient wash behind the whole page | Removed (flat paper background) |
| Emoji and ✓/✕ glyphs as icons | One inline SVG stroke set (gate, wallet, copy, external, snowflake, play) |
| Balance in the navbar; raw addresses and hashes | Address pill and wallet panel; hash chips with copy (announced to screen readers) and an explorer link |
| Amounts as plain text in proportional figures | tUSD8 badge with `tabular-nums`; `Intl` currency and relative time ("in 21 seconds") |
| Button text replaced by "Waiting…" while a tx runs | The label stays, with a spinner and `aria-busy` |
| Form errors only as a toast | Inline `.ferr` (`role=alert`) under the field, `aria-invalid`, focus on the first error, cleared as you type |
| Mixed control heights; 14px inputs zoomed on iOS | 44px controls (38px small, 44px on coarse pointers); 16px inputs on mobile |
| Stamp labels at 85% opacity (axe contrast 3.5:1) | Full opacity, so they pass AA |
| Error view with no way out | "Try again" and "Go home"; `document.title` per route; a `#sr-status` live region |

**Considered and kept:** Anthropic lists cream + terracotta as an AI default, but this palette is the brief's pinned "Quiet trust" spec, and the brief wins. The italic "Safely." accent is also from the spec. The 01/02/03 numbering stays because the steps are a real sequence.

Verified with axe-core (WCAG 2 A/AA, 0 violations on every route, including setup, review and pay), the headless flow (demo, replay, wizard, inline errors, HOLD review, reduced motion), `npm run test:js` (15/15) and the unchanged contract suite (`forge test`, 32/32).

## Native app shell (Nov 2026)

Kindly is a PWA, not an APK: it installs to the home screen and opens full screen, but it is still the same web app.

- **Phone (≤640px and installed):** a compact app bar (logo, the page title that appears once the large title scrolls away, an icon-only chain chip, the wallet pill) and a bottom tab bar: Home · Activity · Wallet · Settings (it was Home · Demo · Payments · Invoices · Settings; see the light direction below). Freeze is one tap from Home, from Settings → Security & Permissions, and from the sidebar on larger screens. Safe areas (`viewport-fit=cover`, `env(safe-area-inset-*)`), `interactive-widget=resizes-content`, tap highlight off, `overscroll-behavior` contain (none when installed), 16px inputs so iOS never zooms.
- **Sheets:** on phones every dialog (wallet, trust, privacy, funds) is a bottom sheet with a grabber, drag-to-dismiss (a quarter of its height, or a flick), and a close button. Exit 200ms, faster than the 250ms entrance.
- **Sticky primary CTAs** above the tab bar: Set up the agent, Run the demo, Approve / Reject, Pay.
- **Lists:** tables stack into labelled rows; Settings is a grouped iPhone-style list (Wallet, Security & Permissions, Notifications, App, Help & Support, Disconnect wallet).
- **Wallet on phones:** with no injected provider, Connect opens a sheet with **Open in MetaMask** (`https://link.metamask.io/dapp/<host>/…`), so the page reopens in MetaMask's browser, plus "Watch the recorded demo". Inside MetaMask the injected provider is used. Wrong network shows a banner with Switch network and a dot on the pill; disconnecting in the wallet returns the app to Connect.
- **PWA:** `manifest.webmanifest` (standalone, portrait, cream theme), icons 192/512/maskable/apple-touch, Apple meta tags. `sw.js` precaches the shell, icons and fonts and serves hashed assets cache-first; navigation is network-first. It never caches RPC, explorer or wallet traffic (other origins are not intercepted), so chain state is always live. Offline shows "You're offline. Wallet and payment state may be outdated…". A dismissible install hint uses `beforeinstallprompt` on Android and Share → Add to Home Screen on iOS.
- **Tablet (641 to 1023px):** an icon rail with labels under the icons. The rail toggle opens a full drawer with groups (Escape, a pick or a tap outside closes it).
- **Desktop (≥1024px):** a 248px sidebar, a top bar with chain chip and wallet, and multi-column dashboards. Home is holds + your agent on the left (Wallet is balance, allowance and mandates), recent activity and your receipts in a sticky 380px column at ≥1280px.

### Sidebar patterns from navbar.gallery (side-bar type)

We looked at the side-bar examples (Aveon, Bud, Ayush Wanjari, Significa, Three Circles, Big Dirty Agency) for patterns only, no code or assets:

- **Grouping with quiet labels** (Bud, Significa): Money (Home, Activity, Wallet) · Account (Settings); it was Overview · Money · Account before the four-tab change. Labels are sentence case, 12.5px muted, never ALL CAPS.
- **Active state** (Ayush Wanjari): a filled white pill with a hairline border and the icon in coral, plus `aria-current="page"`.
- **Account block pinned at the bottom** (Aveon, Bud): the wallet as a card (address in mono, balance and network), which opens the wallet panel.
- **One prominent action** (Three Circles' colour block, Bud's primary button): **Freeze agent** in frost blue above the wallet block. It goes to Payments and focuses the real Freeze button; freezing still takes a tap and a wallet confirmation.
- **Collapsible rail:** on desktop the toggle collapses the sidebar into a 92px icon rail (remembered in `localStorage`); on tablet the rail is the default and the toggle expands a drawer. `aria-expanded` / `aria-controls` on the toggle; labels stay in the accessibility tree and show as `title` tooltips.
- **Keyboard:** skip link, visible focus rings, Up/Down/Home/End move between destinations, Escape closes the drawer.

### What we took from the three skill repos (@jaimintf post), read as text only

- **Appllama (main source):** the shell itself: tab bar of peers (switching tabs never slides; a push into a deeper page in the same tab does a 220ms slide), re-tapping the active tab scrolls to top, the large title that collapses into the app bar, grouped settings lists, sheets with grabbers, and press feedback by role (tab items dim to 55%, rows highlight, buttons scale to 0.97).
- **Expo skills (transferable rules only):** 44px targets, 16px inputs, safe areas, keyboard-aware layout, disable the long-press callout on chrome, haptics as punctuation (`navigator.vibrate` on success and error, Android only, never the only feedback), and the "native slop" list we avoided: floating pill tab bar, everything in a card, X-only sheets, a grand entrance animation.
- **Emil Kowalski's skills:** re-checked every animation: ease-out 150 to 250ms, exits faster than entrances, transform and opacity only, no animation on frequent actions (tab switches), a reduced-motion path for each.
- **Honest gap:** no dark mode. Kindly is a single-theme brand ("Quiet trust").

### Design resources from @iamtanzil_ (2108066324907962575), guidance only

| Resource | What we took |
|---|---|
| AppShot Gallery | Finance app screenshots (Robinhood and other wallet apps): one hero number per screen, the balance first, plain rows under it, the primary action at the thumb |
| Component Gallery | How mature systems build the pieces: toasts / snackbars (Wise, Material, Geist): one line, newest nearest the thumb, errors stay until dismissed and get a close button, success auto-dismisses after 4.5s and pauses on hover. Tabs, sidebars, steppers and empty states (one line of why + one action) checked against it |
| Refero Styles | Typography and spacing check for the Satoshi + Sentient pairing: one family for UI and headings, a tight −0.02em on display sizes, 4/8px spacing rhythm |
| MicroKit, Motion Primitives | Micro-interaction ideas rebuilt in plain CSS/JS, no dependencies: copy-hash confirmation (the copy icon swaps to a check that pops from 0.6 to 1 in 160ms, plus a screen-reader "Copied"), press feedback, toast exit 150ms |
| Minimal Gallery | Restraint check: one accent, no decoration that doesn't carry state |

Deliberately skipped: gradient buttons, liquid glass, CSS text effects, 3D icons, and flashy Aceternity / Magic UI effects (spotlights, beams, count-up numbers on money). They break the anti-slop rules and would make a payments app feel less trustworthy.

## Light iOS fintech direction (ChatGPT, Nov 2026)

The brief: look like a modern iOS fintech app, not a Web3 dashboard. Kindly was already light, so this is a re-tune, not a new theme:

- **Tokens.** Canvas `#F7F6F3`, pure white cards that float on shadow instead of borders, near-black ink `#1D1C1A`, radius 22 to 26px, round icons and avatars (settings icons, receipt icons, the gate mark, empty states). Coral stays the single accent. The charcoal wallet-balance card is kept on purpose as the one high-contrast "card" object, like a bank card in a wallet app.
- **Four tabs.** Home · Activity · Wallet · Settings.
  - **Home:** connected, it is your dashboard: payments that need you (holds), your agent with Freeze and the remaining budget, a "See the Safety Gate in action" tile (live demo and the recorded replay), and recent Safety Gate decisions. Not connected, it is the landing page. The demo, Set up and Review screens live under Home.
  - **Activity:** receipts and verification, plus the merchant Send and Pay screens.
  - **Wallet:** balance, the bounded allowance and funds panel, every mandate (edit, freeze, revoke) and your receipts.
  - **Settings:** below.
  - `#/controls` still works and opens Home.
- **Freeze is always one tap away:** the Freeze button on the Home agent card, the first row of Settings → Security & Permissions, and the sidebar footer on desktop (`#/?freeze=1` scrolls to and focuses the real button; freezing still takes a tap and a signature).
- **iPhone-style Settings.** Grouped rounded lists:
  - **Wallet:** the MetaMask fox, the short address and a Connected pill (or Wrong network), plus the network row with the faucet.
  - **Security & Permissions:** Freeze your agent, Allowance and mandates, how your funds are protected, what's visible on-chain.
  - **Notifications:** in-app only. The row says holds show up on Home within seconds and that push isn't available yet.
  - **App:** install.
  - **Help & Support:** the recorded demo and the source code.
  - **Disconnect wallet:** calls `wallet_revokePermissions` and forgets the account locally. It doesn't claim to log the wallet out.
- **Crypto details moved to detail screens.** Home and Settings use words and small status pills (Active, Connected, Waiting, In-app). Hashes and contract addresses stay on receipts, review and the sheets.
- **Icons are Lucide** (ISC license, v0.460.0), inline SVG, including the iOS-style gear for Settings. The Safety Gate mark, the Aevum glyph and the token mark stay custom. No emoji icons.
- **MetaMask fox.**
  - `web/public/brand/metamask-fox.svg` is the official fox from the logo pack on metamask.io/assets, unmodified (not redrawn, recoloured or stretched).
  - It appears only next to the word MetaMask: Open in MetaMask, Get MetaMask, the sidebar wallet and the connected-wallet row.
  - It is always shown on white or a neutral background, and nothing implies MetaMask endorses Kindly.
  - The assets page gives the colours but no written rules, so we followed standard brand-pack practice.
- **No WalletConnect logo**, because Kindly only supports injected wallets.
- **The tab bar stays docked.** The cards float, but the bar doesn't become a floating pill: Expo's native-feel guidance calls that a web-app tell, and a docked bar keeps 44px targets clear of the home indicator.
- **Copy unchanged in substance.** It still says "bounded allowance" (Kindly never holds funds), and it doesn't overclaim security: the testnet and no-audit note stays in Settings.
- **Verification.** axe-core reports 0 violations on phone, tablet and desktop for Home (landing and connected), Wallet, Activity, Settings, the demo replay, Review and the sheets. `npm test` passes: forge 32/32 and JS 15/15.

## Phase 3: honest modes, calm holds, guided demo (ChatGPT critique, Nov 2026)

- **Entry screen with three paths.** Connect wallet · Try live; Explore demo without wallet (a replay of a recorded Aevum run); Watch the 60-second walkthrough, which says plainly that there is no video yet and opens the README script. The animation on the welcome screen is captioned "Sample animation, not live data."
- **Mode badge on every screen.** `DEMO MODE`, `LIVE TESTNET` (amber when the wallet is on the wrong network) or `LOCAL REHEARSAL · private test chain · not real data`. The keyword is the one deliberate ALL-CAPS exception to the anti-slop rules: it is a status label, like a broadcast "LIVE" sign, not an eyebrow. The rest of the line is sentence case.
- **Hold colours.** A held payment is a calm amber card ("Payment held · Review required"), because nothing is wrong yet: it is waiting for you. Red is reserved for rejected or failed payments. The card's copy is fixed: amount, merchant, reason, and "The payment is paused. Your agent cannot proceed without your decision."
- **Why was this held?** A disclosure that lists the real values the rule used (this payment, usual payment, the ratio, the rule that fired, the decision transaction). Nothing in it is estimated.
- **Honest labels.** Decisions say "Contract rule, deterministic" and never "AI". The glossary (Settings → Learn) defines Spending rules, Mandate, Allowance, Safety Gate and Hold in plain English, and the same terms are dotted-underlined buttons where they appear.
- **Wallet and network pills.** The wallet pill reads "● Connected" with the short address and shows a focus ring only on `:focus-visible`. The network pill is a separate button; its sheet shows the network name, chain ID and a testnet note.
- **Home order on phones.** What needs you first (hold cards), then "Your agent's spending rules" with the budget bar above the fold, then "Security status" (4 checks). Desktop puts the rules and security status side by side.
- **Bottom nav.** Solid background (no translucency over content) and extra bottom padding with the safe area, so nothing hides behind it.

## v3: the user's reference style (Nov 2026)

The user rejected the "restrained premium" pass and sent three reference images. v3 follows them closely, and it supersedes the earlier "docked tab bar" note.

- **Canvas and greeting:**
  - near-white canvas (#FAFAFC)
  - a big two-line greeting: "Morning" in bold, then the short wallet address in a light weight
  - one helper line underneath, which says how many payments need you, or "All clear"
- **Colour cards:**
  - Bold, flat cards (radius 28) in violet #6050EE, orange #CF4A0E, butter #FFC94D, sky #A8D4FF and pink #FFB8D9, each with a big number and a glossy 3D object that partly overflows the card.
  - On phones they sit in a horizontal snap carousel. From 1024 px they become a grid, with the allowance card spanning the full row.
  - Contrast:
    - White text only on violet (5.4:1) and orange (4.5:1).
    - Dark ink #17161C on butter (11.7:1), sky (11.6:1) and pink (11.2:1).
- **3D objects:**
  - shield, coin stack, cat, wallet and lock
  - generated for this project (see `docs/brand/3d/README.md`), with the background removed, as 512 px WebP files of 14 to 23 KB each
  - always `alt=""` with `aria-hidden`, because they are decoration
- **Lists and pills:**
  - Section titles are semibold with a grey "View all".
  - Lists sit on white cards with soft shadows and pastel pill tags.
  - Filter chips are pills, with the active one filled.
- **Bottom nav:**
  - a floating dark pill (#17161C), with the active tab in a white circle
  - labels visually hidden but still the accessible name
  - 56 px targets
  - The desktop sidebar stays white, with a violet pill on the active item.
- **Onboarding and empty states:**
  - a centred floating composition of 3D objects
  - a heavy title with a light second word
  - a grey subtitle
  - a black pill primary action, plus a white pill or a "Not now" text link
- **Unchanged:**
  - the four tabs and the information architecture
  - progressive disclosure, honesty labels, the mode badge and the testnet labels
  - all flows, including connect, review, approve, freeze and revoke

### What we took from each source (Meng To's design-skills list)

Nothing below is vendored into the app. We read the skills, applied the ideas by hand, and ran one tool locally.

- **Impeccable** (pbakaus/impeccable, Apache-2.0):
  - We ran its browser anti-pattern detector (`detect-antipatterns-browser.js`, `impeccableDetectAsync()`) locally against Welcome, Home and the demo at 390 and 1440 px. It is a test-time tool only and is not shipped.
  - It found two things, both fixed:
    - the 10.4 px "tUSD8" token label, now at least 11 px
    - the tiny "01 / 02 / 03" numbered section labels, now colour tiles with a 3D object
  - From its checklist we also avoided: purple gradients (cards use flat fills), zero-offset glow halos (we use colour shadows offset downward), uppercase kicker labels above headings, grey text on coloured fills, bounce easing, and thin borders paired with wide shadows.
- **Emil Kowalski's skills** (MIT), for motion:
  - ease-out curves, 150 to 250 ms for UI and up to 600 ms only for the one-time entrance of the 3D composition
  - press feedback with `scale(.98)`
  - no animation from `scale(0)`
  - everything gated behind `prefers-reduced-motion: no-preference`
- **MengTo/skills** (MIT):
  - the "reference first" workflow: match the user's three reference images closely, with type scale, card radius, colour blocking and object placement taken from the references rather than invented
- **Stageshow** (benjitaylor/skills, no licence file in the repo, so ideas only and nothing copied):
  - bento grids of mixed tile sizes (the Shortcuts block)
  - composing README, OG and video stills around the hero cards
- **open-design** (nexu-io/open-design, Apache-2.0, ideas only):
  - pairing one heavy display weight with a light secondary line
- **solid-glass** (deeplethe/solid-glass, MIT, nothing vendored):
  - the bottom bar and sheets stay solid and opaque instead of translucent glass, so the text on them keeps AA contrast
