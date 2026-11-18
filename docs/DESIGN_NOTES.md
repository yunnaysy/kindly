# Kindly design notes

**Direction: "Quiet trust."** Kindly should feel like a calm fintech app, not a developer demo. The product is the permission layer between an AI agent and your money, so the UI leads with the decision (PAY, HOLD or REJECT) and with what the agent can and can't do.

The primary spec came from a ChatGPT critique of the old UI (summarized below). It was blended with patterns from eight X posts the user shared.

## Palette

| Token | Hex | Use |
|---|---|---|
| canvas | `#F8F6F1` | page background, warm paper |
| surface | `#FFFFFF` | cards, panels |
| ink | `#302E2B` | text, dark buttons, the Safety Gate bar |
| muted | `#6F6860` | secondary text. The critique suggested `#827B73`; it was darkened to pass WCAG AA (axe-core) |
| border | `#EAE6DE` / strong `#DCD6CB` | hairlines |
| coral | `#E8755A` | accents only (about 2% of the screen) |
| coral-ink | `#B9503A` | primary buttons. White on `#E8755A` is only 2.95:1, so buttons use the deeper coral (4.9:1) |
| coral-soft | `#FBEAE5` | avatars, soft accents |
| success | `#266D50` on `#E6F2EA` | PAY, verified |
| hold | `#8A6415` on `#F9ECCD` | HOLD, approval required |
| reject | `#A83D35` on `#F8E5E2` | REJECT, danger zone |
| violet (AI) | `#59558D` on `#E9E8F6` | anything the agent says or does, focus rings |
| frost | `#3F6A8A` on `#E5EEF4` | frozen mandates |

Radius: cards 20px, panels 24px, the demo stage 28px. Shadows: card `0 4px 24px rgba(48,46,43,.045)`, floating `0 12px 32px rgba(48,46,43,.08)`, lifted `0 18px 48px rgba(48,46,43,.12)`.

## Type (Google Fonts)

- **DM Sans** 600 for headlines: hero 56px, page titles 30 to 36px, letter-spacing −0.02em.
- **Inter** for the UI: body 15.5px, secondary 13 to 14px, buttons 14.5px/600.
- **JetBrains Mono** 12 to 13px for addresses, hashes, invoice IDs and risk scores.
- **Instrument Serif** italic for one word only: "*Safely.*" in the hero. It is the editorial serif accent seen in the @e1genqq studio reel and in the land-book and godly galleries.

## Layout

- **Nav:** `kindly | Product · Demo · Controls · Invoices`. Merchant, Pay and Receipts are merged into **Invoices** as a segmented control (Send · Pay · Receipts). The chain pill is subdued and the wallet is a compact dark pill.
- **Product:** a two-column hero with a floating payment card on a dotted field. The card cycles PAY → HOLD → REJECT, and each check ticks in turn. Below it, a horizontal 3-step explainer (01 Verify · 02 Control · 03 Confirm) and a centered pitch line.
- **Demo:** a single stage. The dark **Safety Gate** bar sits above three invoice cards. The active card lifts into the gate while a scan sweeps across it. Then its checks resolve and the verdict stamps in. The HOLD card grows an inline "Approval required" panel. The run ends on "**Autonomy, with boundaries.**" with a tally. Execution logs collapse under "View execution details". "Replay recorded run" animates the real Aevum run, with explorer links, without a wallet. `#/demo?replay=1` autoplays it.
- **Controls ("Agent permissions"):** an amber "Approval required" panel, or a calm green "Nothing is waiting". Next comes **Funds & permissions** (wallet balance, agent budget, per-payment limit, exact allowance, a can/can't list and the recovery path). Then one hero card per mandate, with the remaining budget as the largest number. Settings live in an "Edit limits & merchants" drawer, and Revoke sits in a danger zone. Freeze is a secondary button. Recent activity shows 3 items, with "All activity →" to expand.
- **Invoices · Send:** a verified merchant header, a big amount field, a memo with a privacy hint, and options folded away. The created state is a QR on white with "Copy payment link →".
- **Invoices · Pay:** state A is a calm request card in the style of Apple Pay ("PAYING TO … ✓ Verified merchant · The wallet name matches this merchant", "Secured by Kindly Safety Gate"). State B is "Payment sent", with an animated check, a receipt and Done.
- **Trust modal:** "How your funds are protected" (4 cards plus Implemented vs. roadmap) and "What's visible on-chain".

## Motion (150 to 250ms, ease-out quint, no bounce)

- Buttons rise 1px and gain a shadow on hover. Arrows nudge 3px. Cards get a darker border and rise 2px.
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

All fonts are free Google Fonts and every icon is inline SVG or a Unicode glyph. No paid assets.
