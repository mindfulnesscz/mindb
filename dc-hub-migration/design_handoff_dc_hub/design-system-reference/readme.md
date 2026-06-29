# Disrupt Collective — Design System

A monochrome, high-contrast identity for **Disrupt Collective s.r.o.**, a creative communication & marketing studio in Brno, Czechia. Built on a single Clear-White ↔ Cosmos-Black axis, a serif/sans type pairing (Minion Pro + Commissioner), a strict 4-column grid, and the brand's open superellipse mark. This system follows the official **Design Manuál** (34 pp., by Studio SpoluDesign, ©2024).

---

## 1 · Company context

**Disrupt Collective s.r.o.** — Founded 3 July 2025 by MgA. Petr Mucha (Creative Director). Registered at Kmochova 135/40, 614 00 Brno; studio correspondence Špitálka 16, 602 00 Brno. A communication & marketing studio.

**What they do** — digital content creation (video, photo, copywriting); social campaigns & influencer partnerships; brand strategy & creative concept; performance marketing & analytics. The positioning underneath the work is *making unclear, chaotic processes legible* — "Chaos is information."

**How they work** — a flexible network of freelance creatives, producers and production partners; Adobe Suite, Meta Ads, Google Ads; distribution across Instagram, Facebook, YouTube and Google Ads.

**Who they serve** — startups, lifestyle brands, e-commerce, NGOs and cultural institutions.

### Sources provided (all read & applied)
- **`DisruptCollective_Design Manual COMP.pdf`** — the official 34-page brand manual (Czech). Authoritative for color, type, logo rules, grid and graphic elements; everything below is drawn from it.
- **Fonts** — `Commissioner` (9 weights) + `Minion Pro Medium`, the real licensed faces → `assets/fonts/`.
- **Logo package** (SVG) — wordmark + symbol, black/white on transparent/white/black → `assets/logos/`.
- **Symbol construction grid** → `assets/brand/`.

---

## 2 · Content fundamentals

**Voice.** English-language, confident and quietly provocative, built on a tension between order and chaos. Short declarative sentences. The brand writes *"Chaos is information."* and *"Solve your worries,"* and frames its value plainly: *"we make complicated workflows simple (and actually enjoyable)."*

- **Person.** "We" (the collective) to "you" (the client). Warm, direct, a little playful.
- **Casing.** Headlines in **sentence case**, set in serif. Labels, eyebrows, nav and metadata in **UPPERCASE Commissioner** with wide tracking (+0.12em). No Title Case.
- **Kickers.** Sections open with a short label or a number ("01 — Strategy"). Avoid code-style `//` prefixes.
- **Punctuation.** Periods for finality, even on fragments ("Chaos is information."). Em dashes for asides.
- **Numbers.** Lead with concrete outcomes, sparingly — never a wall of stats.
- **Emoji.** Not used. The mark, halftone texture and a `→` arrow provide accent instead.
- **Vibe.** Editorial, studio-grade, calm-under-pressure. Czech-rooted, internationally fluent. Signature lines: *Chaos is information · Solve your worries · How we works.*

---

## 3 · Visual foundations

**Color (manual §2/2).** Strictly monochrome. **Clear White `#FFFFFF`** + **Cosmos Black `#161616`** are the primaries — Cosmos Black is *deliberately not 100% black*, a softer shade that reads more naturally and lets pure black act as a subtle accent. A gray ramp steps the two in ~20%: `#323232 · #464646 · #999999 · #cecece · #f4f4f4`. The system runs **80% white-ground / black-elements, 20% inverse**. Color enters *only* through imagery, photography and video — never as decorative UI color.

**Type (manual §2/4).** Two faces:
- **Minion Pro Medium** (serif) — the *heading/display* face ("nadpisové písmo"). Set large with tight leading (Nadpis 200 / leading 193 ≈ 0.965; tracking ≈ −0.02em).
- **Commissioner** (humanist sans) — the *text* face ("textové písmo") for body, UI, labels and small captions. Medium (500) is the workhorse; full Thin→Black range available.
- **No monospace exists in the brand.** Labels are Commissioner, uppercase, tracked.
- Hierarchy is proportional: heading = unit X; sub-levels are eighths of X (≈ 200 / 125 / 75 / 25 pt). Headings keep at least one grid block of space from body.

**Layout (manual §2/5).** A **4-column grid**, expandable in fours (8/12/16/20…). Minimum margin = 1/39 of the shorter side; gutter = half the margin. **All text left-aligns** to a grid column. Generous vertical rhythm. Alternating Clear-White ↔ Cosmos-Black sections set the pace; a horizontal marquee is a recurring device.

**Shape & radius.** Sharp, flat, geometric — the identity "stands on firm, straight rules." Corners 0–2px. The **squircle/superellipse** (echoing the mark) is reserved for avatars/media. Pills used for filters/CTAs.

**Borders & elevation.** Structure is drawn with **hairlines** (`1px`) and `2px` ink rules, not soft shadows — surfaces stay flat. An optional **hard offset "stamp" shadow** (`5px 5px 0`) is available for emphasis (e.g. the contact card), but it is a UI device, not a core brand element.

**Graphic elements (manual §2/3) — the real signature.**
- **Offset halftone:** imagery converted to a fine color-halftone (max radius 4, all screen angles 36°), then duplicated — top layer set to **Overlay** and shifted **3px up & left** before flattening. This offset makes the halftone unmistakably Disrupt Collective.
- **Illustrations:** black & white, simple linear line — like a felt-tip pen or black crayon.
- **Photo direction:** order and chaos held in one moment — quiet, clean visuals with hidden tension; everyday life, nature and artistic abstraction.

**Motion.** Decisive and quick. `ease-out`, 120/220/420ms, opacity + transform only. The marquee scrolls linearly; the arrow nudges on hover. No bounce.

**Interaction states.** Hover = invert (secondary button fills ink) or lift; links underline with a 2px offset. Press = `translateY(1px) scale(.99)`. Focus = 3px soft ink ring.

---

## 4 · Logo & iconography

**Logo system (manual §1).** The logo is **a symbol and a logotype, used separately — never joined into a combined lockup.** Ideally one mark per output (symbol *or* logotype). The large symbol scales to 6/8 of the output width on image-only / pure-design pieces; the small symbol is used as a label (social intro slides, letterhead corners, headers). Clearspace is measured in *x* (symbol: height of its horizontal stroke; logotype: width of the left vertical of the "D") — **minimum 2x, recommended 4x**. **Forbidden:** rotating from horizontal, stretching/deforming, or placing on insufficient contrast.

**Iconography.** No UI icon set ships with the brand. Use instead:
- The **symbol** (`assets/logos/symbol.svg`) as hero glyph / watermark / favicon / avatar fallback.
- **Black & white linear illustrations** (felt-tip/crayon style) as the brand's preferred decorative imagery.
- A `→` arrow for directional UI affordance.
- Where a functional UI icon set is unavoidable, **Lucide** (CDN, 2px stroke) is the closest match — *flagged as a substitution*; confirm or replace with custom linear illustration. Emoji are not used; SVG over raster. All logo SVGs use `fill="currentColor"`.

---

## 5 · Index / manifest

**Root** — `styles.css` (global entry; import this), `readme.md`, `SKILL.md`

**Tokens** (`tokens/`) — `fonts.css` (real @font-face) · `colors.css` · `typography.css` · `spacing.css`

**Assets** (`assets/`) — `fonts/` (Commissioner ×9, Minion Pro Medium) · `logos/` (`logotype.svg`, `symbol.svg` currentColor masters + baked variants) · `brand/` (construction grid)

**Components** (`components/`) — `window.DisruptCollectiveDesignSystem_96f28c`
- `actions/` — `Button`, `IconButton`
- `feedback/` — `Tag`, `Badge`
- `forms/` — `Input`, `Checkbox`
- `surfaces/` — `Card`, `Divider`, `Avatar`

**UI kits** (`ui_kits/`) — `website/` — Disrupt Collective homepage (Nav, Hero, WorkGrid, Services, Contact, Footer)

**Foundation cards** (`guidelines/cards/`) — Type · Colors · Spacing · Brand specimen cards.

---

## Caveats / open questions
- **Stamp shadow & functional state colors** are my additions for UI completeness — not in the manual (which is purely flat + monochrome). Keep, tone down, or remove per preference.
- **Lucide** is suggested only as a stopgap UI icon set; the brand's documented approach is custom B&W linear illustration. Supply real illustrations to replace it.
- The **halftone** specimen card is a CSS approximation of the manual's Photoshop technique — use the real Overlay/offset process on actual imagery for production.
- Two addresses appear across sources (legal Kmochova 135/40 vs. studio Špitálka 16) — confirm which to surface publicly.
