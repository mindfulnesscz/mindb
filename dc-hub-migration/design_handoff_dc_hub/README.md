# Handoff: DC Hub — desktop app redesign

## Overview

**DC Hub** is an internal desktop tool for **Disrupt Collective** (a Brno creative
studio). It's a **Digital Asset Management (DAM) pipeline**: it scans a structured
source folder of marketing assets, generates preview thumbnails, distributes files
into package folders, publishes to cloud targets (Dropbox / OneDrive), and builds an
Obsidian-based DAM vault overlay. It also owns the **controlled vocabulary** behind
the studio's file-naming convention and a **shortcode generator** built from that
vocabulary.

This bundle is the **design + UX handoff** for rebuilding DC Hub as a polished,
cross-platform desktop app. There is already a **working proof-of-concept in Python**
in the target repository (a `customtkinter` pipeline app + a separate browser-based
vocab manager). It is functional but the design and UX are poor and it is two
disjointed programs. **The goal is to replace that POC with one coherent app** that
keeps every behaviour but adopts the design and information architecture defined here.

> The detailed product/behaviour spec lives in **`design-brief.md`** (read it — it is
> the source of truth for *what the app does*). This README covers *what it should
> look like and how the screens are structured*. **`CLAUDE_CODE_PROMPT.md`** is the
> ready-to-paste brief for the implementing agent.

## About the design files

The files in `standalone-previews/` and the `*.dc.html` files are **design
references created in HTML** — interactive prototypes showing intended look,
structure and behaviour. **They are not production code to copy.** The task is to
**recreate these designs in the real app** (stack below) using its own components and
patterns — specifically by composing the **Disrupt Collective design-system React
components**, not by porting this prototype markup.

- `standalone-previews/DC Client Hub (hi-fi).html` — **the target.** Open in any
  browser. Branded, final type/spacing, navigable (click the left rail; expand
  config groups; switch vocabulary dimensions; open the Add-tag modal).
- `standalone-previews/DC Hub Wireframes (lo-fi).html` — the approved low-fi
  wireframe with annotations tying each layout decision to the five problems.
- `design-system-reference/` — the DC design tokens (colors, type, spacing, fonts)
  and the design-system guide. The real component library is published separately
  (see the prompt).

## Fidelity

**High-fidelity.** Colors, typography, spacing and interactions are final and reflect
the Disrupt Collective design system. Recreate the UI faithfully using the DC
component library + tokens. The lo-fi file is included only to show the reasoning.

---

## Navigation model (resolved)

A **persistent left icon+label rail** (84px, Cosmos-Black `#161616`) is the single
global nav, with four destinations: **Pipeline · Vocabulary · Generate · Settings**.
The active item is a white rounded square; inactive items are `#969696`. A brand mark
sits at the top of the rail, a user avatar (squircle) at the bottom.

This was chosen over top-tabs and a wide rail because **Pipeline needs its own
secondary configuration sidebar** beside the global nav — two rails coexist cleanly,
and the model scales if a fifth area is added. (See the lo-fi file for the three
options weighed.)

The whole app sits inside a **resizable desktop window**, min ~1280×800. The
prototype shows it inside macOS window chrome for context; in the real app this is
the OS window.

---

## Screens / views

### 1 · Pipeline workspace (the core)

Three-zone layout inside the screen area:

**A. Configuration sidebar** (left, 316px, surface `#FAFAF9`, hairline right border)
- Header: "Pipeline" (Minion Pro serif) + one-line caption.
- **Collapsible accordion groups** (this solves *Problem 1 — no more one long scroll*):
  - **Paths** (open by default) — 4 folder pickers: Source, Target, OneDrive flat,
    Obsidian vault. Each = a truncated monospace path field + "Browse" button.
  - **Connections** (collapsed) — Dropbox + OneDrive rows, each with a status dot,
    label, state text, "Reconnect" button.
  - **Tasks** (open) — the 5 operations as checkboxes in fixed run order:
    1 Generate thumbnails · 2 Distribute packages · 3 Publish on cloud
    (with **Flat export to OneDrive** as a nested sub-option) · 4 Publish to DAM.
  - **Run options** (collapsed) — Dry run · Keep highest version only · Preserve
    folder structure.
  - Each group header shows a caret + uppercase label + a small count/summary on the
    right ("4 set", "2 connected", "2 on").
- **Pinned run controls** (always visible, fixed at sidebar bottom, top border `2px`
  ink): a status line ("Idle · ready"), a thin progress bar, a full-width **Run**
  button (`#161616` solid, the single most important CTA), and a row with **Stop**
  (disabled when idle) + **Update OneDrive links** (secondary). *This solves the
  "Run must always be visible" principle.*

**B. Activity area** (center, fills remaining width)
- **Last-run stats strip** (top, hairline bottom): a label ("Last run · completed
  with issues · 2m 14s ago") above an 8-cell grid of counters — Packages, Copied,
  Skipped, Errors, Pub. folders, Published, Thumbnails, Notes. Numbers in Minion Pro
  serif `24px`; labels uppercase `10px` `#969696`. (Resolved the open question:
  stats live as a **header strip above the log**, not in the sidebar.)
- **Activity log** (fills height, scrolls): a label row with a "Clear" button, then a
  monospace console. Each line = timestamp (`#C4C4C4`) · a typed marker glyph ·
  message. Line types: section/phase headers (bold ink), info (`#6B6B6B`), success,
  skip/warning, error, disconnected. Full chronological — nothing removed.

**C. Issues panel** (right, 362px, surface `#FAFAF9`)
- This solves *Problem 2 — surface problems without scrolling the log*. The full log
  stays in B; this panel groups **only the problems** into collapsible categories,
  each with a **count badge**:
  - **Skipped** (badge 12) — file + reason rows, hairline left rule.
  - **Disconnected / broken links** (badge 3) — file + reason + a "Relink" action.
  - **Version conflicts** (badge 5) — file + reason.
  - **Errors** (badge 1, inverted black badge) — file + reason.
- Header: "Issues · 21 to review".

### 2 · Vocabulary

- Header: dimension name (Minion Pro `34px`) + a live tag-count pill + a sub-line
  ("Tags that answer 'Who or what is this about?'") + a top-right **+ Add tag**
  button (solid ink).
- **Dimension tabs** under the header: Entity · Angle · Format (underline-on-active).
- **Tag table** with a sticky column header: Shortcode · Label · Subtype · Obsidian
  tags · actions.
- Rows are grouped by **subtype**, and each group header is **collapsible** (*solves
  Problem 4*): caret + uppercase subtype label + a **count badge** + (for Entity) the
  derived **prefix** shown in mono (e.g. "prefix p-").
- Row cells: shortcode in a bordered mono chip, label, subtype pill (outline),
  `#hashtag` obsidian tags in mono, Edit / Delete buttons.

### 3 · Add / Edit tag modal

Solves *Problem 5 — auto-prefix by subtype*. Centered modal, `2px` ink border, hard
`6px 6px 0` stamp shadow.
- **Subtype is chosen first** (pill row) because it drives the prefix. Each pill shows
  the label + the prefix it implies ("p-", "c-", "x-", "e-", or "no prefix").
- **Shortcode field**: when the dimension is Entity and the subtype has a prefix, a
  **locked ink prefix segment** (e.g. `p-`) is fused to the left of the input; the
  user types only the distinctive part (e.g. `Sln`). A hint explains the prefix is
  derived and locked. A live "Result · p-Sln" line confirms the full code. Company
  (no prefix) and non-Entity dimensions show no locked segment.
- Plus: Label, optional Icon, Obsidian tags (space-separated; hint: first = most
  specific). Cancel / Save.

### 4 · Shortcode generator

- Header: "Shortcode generator" + sub-line.
- **Three dimension panels** side by side (Entity / Angle / Format), each listing
  selectable tags grouped by subtype. Tags are toggle buttons (multi-select; selected
  = solid ink).
- **Result rail** (right, 380px): Description field · Version as three numeric fields
  `v [maj]-[min]-[pat]` · the live **generated shortcode** in a bordered mono block
  with stamp shadow + **Copy** · a live **Obsidian tags preview** (mono chips) ·
  **Clear all**.

### 5 · Settings (in-app, not a modal)

Solves *Problem 6 — promote the old settings modal to a real screen*. Header with
Cancel / Save. Two-column card layout:
- **Folder patterns** card — Filter mode (blacklist/whitelist segmented control),
  Package folder prefix, Output folder name, Exclude mark, Include mark.
- **Thumbnails & DAM** card — Thumbnail width (px), Thumbnail quality (0–100), DAM
  folder depth.
- **Cloud credentials** card (optional) — Dropbox app key, Dropbox access token,
  OneDrive client ID, OneDrive tenant ID.

---

## Design tokens

From `design-system-reference/` (use these vars, do not hard-code new values):

**Color — strictly monochrome.** Color enters only through asset imagery, never as
decorative UI color.
- Clear White `#FFFFFF` · Cosmos Black `#161616` (primary ink — deliberately not pure
  black) · pure `#000` only as a rare accent.
- Gray ramp: `#323232 · #464646 · #969999 · #C4C4C4 · #ECECEC · #F4F4F4`.
- App canvas in the prototype: `#E4E3DF` (warm paper). Surfaces: `#FFFFFF` /
  `#FAFAF9`. Hairlines: `#E2E2E2`; strong rules `#161616`.
- Run ~80% white-ground / black-elements, 20% inverse.

**Type.** Two faces only:
- **Minion Pro Medium** (serif) — headings/display. Large, tight leading (~0.97),
  tracking ~-0.02em.
- **Commissioner** (humanist sans) — body, UI, labels. Medium (500) is the workhorse;
  labels are UPPERCASE, tracked +0.08–0.12em.
- **Brand note + the one deliberate departure:** the manual has *no monospace*. This
  design uses a **monospace face only for shortcodes, filenames and log lines**
  (code legibility), and Commissioner for all UI chrome. Confirm this is acceptable;
  if not, set those in Commissioner.

**Shape & elevation.** Sharp, flat, geometric. Corners 0–2px. Squircle/superellipse
reserved for avatars/media. Structure drawn with **1px hairlines** and **2px ink
rules** — not soft shadows. Optional hard **`5px 5px 0` stamp shadow** for emphasis
(used on modal + generated-code block). Pills for filters/CTAs.

**Motion.** Decisive, quick. `ease-out`, 120/220/420ms, opacity + transform only.
Caret rotation on accordion toggle. No bounce.

**Spacing.** See `spacing.css`. 4-column grid, expandable in fours. All text
left-aligns to a column.

## Assets

- **Fonts**: Commissioner (9 weights) + Minion Pro Medium — in the DC design system
  package (`assets/fonts/`).
- **Brand mark**: the open-superellipse symbol (`assets/logos/symbol.svg`,
  `currentColor`). Used in the nav rail and as the app icon basis.
- **Icons**: no brand icon set ships. The prototype uses simple 2px-stroke linear
  glyphs for nav; Lucide (2px stroke) is an acceptable stopgap, ideally replaced with
  custom B&W linear illustration. No emoji in chrome (the domain markers like
  `[00] 📦` are *data*, not UI decoration — keep those).

## Files in this bundle

- `design-brief.md` — full product/behaviour spec (source of truth for *what it does*).
- `CLAUDE_CODE_PROMPT.md` — paste-ready brief for the implementing agent.
- `standalone-previews/DC Client Hub (hi-fi).html` — hi-fi target, opens in a browser.
- `standalone-previews/DC Hub Wireframes (lo-fi).html` — annotated wireframe.
- `DC Client Hub.dc.html` / `DC Hub Wireframes.dc.html` — the design-tool source.
- `design-system-reference/` — DC tokens (colors/typography/spacing/fonts) + guide.
