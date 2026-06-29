# DC Hub — UX Redesign Brief for Claude Design

## 0. How to use this brief

This is a **redesign assignment** for an existing internal desktop tool. The current UI (shown in the connected Figma file via MCP, and described below) grew organically and is functional but inconsistent. **Do not preserve the current layout.** Use it only as a feature inventory and a record of known pain points. The goal is a coherent, branded, professional redesign.

Before wireframing, the Disrupt Collective design system will be built first (fonts, color tokens, components). This brief defines *what the product must do and the problems to solve* — not the visual styling, which comes from the DC design system.

When something is ambiguous, ask rather than assume.

---

## 1. Product overview

**Name:** DC Hub (currently titled "Package Collector" in the app header — rename to **DC Hub** in the redesign).

**Owner / users:** Internal team at Disrupt Collective (creative agency). Power users — designers, content producers, project managers. Comfortable with file systems and structured naming. This is a desktop operations tool, not a consumer product.

**Platform:** Desktop application (built in Python / customtkinter today). macOS primary; Windows and Linux secondary. The redesign should assume a resizable desktop window, roughly 1280×800 minimum, scaling up to large displays.

**Purpose:** DC Hub is a Digital Asset Management (DAM) pipeline tool. It takes a structured source folder of marketing assets and performs a sequence of operations: generating preview thumbnails, distributing files into package folders, publishing to cloud targets, and building an Obsidian-based DAM vault overlay. It also manages the controlled **vocabulary** that drives the project's file-naming convention, and generates filename shortcodes from that vocabulary.

**Two tools, to be unified:** Today there are two separate programs:
1. **The pipeline app** (`app.py`) — the main GUI with the four operations.
2. **The vocabulary manager** (`vocab-manager.py`) — a *separate* tool that opens in a web browser, used to edit the controlled vocabulary and generate shortcodes.

**A primary goal of this redesign is to merge both into a single application** with a unified navigation model, so the vocabulary manager and shortcode generator become first-class areas of DC Hub rather than a detached browser tool.

---

## 2. Core domain concepts (so the design reflects the real workflow)

**The naming convention.** Every asset filename follows this pattern:

```
(Tag)(Tag)...(Tag) Description vX-Y-Z.ext
```

A filename is one or more bracketed shortcode tags, then an optional plain-language description, then an optional semantic version. Round brackets `()` are canonical; square brackets `[]` are a legacy alias still parsed for old files.

**Three vocabulary dimensions.** Every shortcode belongs to one of three dimensions, each answering a different question:
- **Entity** — *who/what is this about?* (the company, products, customers, partners, events)
- **Angle** — *what is the purpose?* (sales, technical, overview, case study, testimonial, etc.)
- **Format** — *what kind of file is it?* (document, media, image variant)

**Subtypes within dimensions.** Each dimension is divided into subtypes that group its tags:
- Entity subtypes: `company`, `product`, `customer`, `partner`, `event`
- Angle subtypes: `sales-mktg`, `content`, `context`
- Format subtypes: `document`, `media`, `image-var`

**Entity prefix rules** (important for a feature request below): Entity shortcodes carry a prefix that encodes their subtype:
- `company` → no prefix (e.g. `ESS`)
- `product` → `p-` (e.g. `p-Sln`)
- `customer` → `c-` (e.g. `c-BMW`)
- `partner` → `x-` (e.g. `x-AuF`)
- `event` → `e-` (e.g. `e-PEX`)

**Folder structure markers.** The pipeline relies on folder-name conventions: package folders are prefixed `[00] 📦`, output folders are named `[03] OUT`, an exclude mark `⦰` blacklists items, an include mark `🏁` whitelists them, and `[99]` / `~$` items are always skipped.

**Versioning.** Semantic `vX-Y-Z`. The pipeline can filter to keep only the highest version of each file.

---

## 3. Full feature inventory

This is the complete set of features the current app has. The redesign must accommodate **all** of them. Features are grouped by the area they belong to.

### 3.1 Pipeline — path configuration

Four folder paths the user selects via a native folder picker ("Browse"). Each shows the currently selected path (truncated) or "not selected":
- **Source folder** — the structured asset library to scan.
- **Target folder** — destination for structured cloud publish.
- **OneDrive flat folder** — destination for the flat export.
- **Obsidian vault** — destination for the DAM note overlay.

### 3.2 Pipeline — cloud connections

Two OAuth-style cloud connections, each with a status indicator (connected / not connected, with auto-refresh state) and a "Connect" button:
- **Dropbox** — generates shareable links embedded in DAM notes.
- **OneDrive** — generates shareable links; also powers the "Update OneDrive Links" action.

> Note: actual credential entry / OAuth is handled by the system; the UI just shows status and triggers the connect flow.

### 3.3 Pipeline — tasks (the operations to run)

Five toggleable operations. The user selects which to run, then hits Run. They execute in a fixed order (thumbnails → distribute → cloud publish → flat export → DAM):
1. **Generate thumbnails** — creates WebP previews from the first slide/page of PPTX/PPT/PPTM/PDF files.
2. **Distribute packages** — scans for `[00] 📦` package folders, collects output files from sibling project folders, version-filters, and copies them in.
3. **Publish on cloud** — mirrors `[03] OUT` contents to the target path (structured, rsync-like per folder).
4. **Publish to DAM** — builds the Obsidian vault overlay: one note per asset, canvases per scope.
   - **Flat export to OneDrive** — a *sub-option* of cloud publish (nested/indented under it), exporting a flat copy to the OneDrive flat folder.

### 3.4 Pipeline — run options

Three independent toggles that modify how a run behaves:
- **Dry run** (preview, makes no changes)
- **Keep highest version only** (vX-Y-Z version filtering)
- **Preserve folder structure in packages**

### 3.5 Pipeline — run controls

- **Run** — primary action; enabled only when prerequisites are met (at least one task + required paths). This is the single most important CTA in the pipeline area.
- **Stop** — cancels an in-progress run; shows a "Stopping…" state.
- **Update OneDrive Links** — a separate, secondary action that refreshes OneDrive share links in existing DAM notes without a full run.
- A **progress bar** tracks overall run progress across the active phases.

### 3.6 Pipeline — activity log

A large scrolling console showing real-time run output. Log lines are typed and currently colour-coded:
- `info` (normal), `success`, `skip`/`warning`, `error`, `dim` (secondary), `section` (phase headers), `disconnected` (orphaned/broken-link assets, shown in orange).
- A **Clear** button empties the log.

### 3.7 Pipeline — last-run stats

A set of result counters updated after each run, shown as small cards:
`Packages`, `Copied`, `Skipped`, `Errors`, `Pub. Folders`, `Published`, `Thumbnails`, `Notes`.

### 3.8 Pipeline — settings (currently a modal)

A settings dialog ("Folder Patterns") with these editable fields:
- Filter mode — segmented toggle: `blacklist` / `whitelist`
- Package folder prefix (e.g. `[00] 📦`)
- Output folder name (e.g. `[03] OUT`)
- Exclude mark (blacklist) — e.g. `⦰`
- Include mark (whitelist) — e.g. `🏁`
- Thumbnail width (px)
- Thumbnail quality (0–100)
- DAM folder depth (0 = flat, 1 = one level, …)
- Dropbox app key (optional)
- Dropbox access token (optional)
- OneDrive app client ID (optional)
- OneDrive tenant ID (or "common")
- Save / Cancel actions

### 3.9 Vocabulary manager (currently the separate browser tool)

A controlled-vocabulary editor. Today it has a left sidebar with:
- **Dimensions:** Entity, Angle, Format (one page each)
- **Tools:** Shortcode generator

**Per-dimension tag table.** Shows all tags for the selected dimension, grouped by subtype (group headers like `COMPANY`, `PRODUCT`). Each row shows: Icon, Shortcode, Label, Subtype (as a coloured pill), Obsidian Tags (as `#hashtag` chips), and Edit / Delete actions. A header shows the dimension name and a live tag count (e.g. "47 tags"). An **+ Add tag** button is top-right.

**Add/Edit tag modal.** Fields:
- Shortcode (with a hint about CamelCase / prefix rules)
- Icon (optional emoji)
- Label (human-readable name)
- Subtype (dropdown, scoped to the current dimension's subtypes)
- Obsidian tags (space-separated; first = most specific; converts to `#tags`)
- Save / Cancel

### 3.10 Shortcode generator (currently inside the browser tool)

A builder for constructing a filename shortcode string:
- Three columns/panels, one per dimension (Entity / Angle / Format), each listing selectable tags grouped by subtype. Tags are toggleable (multi-select; the convention allows any number of tags from any dimension).
- A **description** text input (optional).
- A **version** input as three numeric fields: `v [major] - [minor] - [patch]`.
- A live **generated shortcode** result string.
- A live **Obsidian tags preview** showing which `#tags` the selection will produce.
- **Copy** (copies the generated string) and **Clear all** actions.

---

## 4. Known problems with the current UI (and required solutions)

These are the specific pain points driving the redesign. Each needs an explicit solution in the new design.

### Problem 1 — The pipeline sidebar requires scrolling
The left configuration sidebar packs paths, cloud connections, tasks, options, and stats into one long scrolling column. Users must scroll to reach Run options or stats, and lose sight of context.

**Required solution:** Replace the single scroll column with **collapsible sections** (accordion-style groups), so each logical group — Paths, Connections, Tasks, Options, Last Run — can be expanded or collapsed independently. The aim is for the whole configuration to be navigable without continuous scrolling, with the primary Run/Stop controls always visible. Consider which sections should be open by default (likely Paths + Tasks) and whether stats belong in the sidebar at all versus the main area.

### Problem 2 — The activity log mixes everything together
All output — successes, skips, broken connections, version mismatches, errors — streams into one console. Finding the *problems* means scrolling through the entire log.

**Required solution:** Separate the output by concern so problems surface without scrolling. Design a structure where the full chronological log still exists, but **skipped items, broken/disconnected links, and version mismatches each have their own filtered view or panel**. Options to explore (pick and justify the best): tabbed sub-views (All / Skipped / Disconnected / Version conflicts / Errors), or a persistent full log with a separate "Issues" panel that groups problems by category with counts. The categories that matter most are: **skipped**, **disconnected / broken links**, and **version mismatches/conflicts** — these should be glanceable and individually addressable. Tie these to the existing log line types (`skip`, `disconnected`, `error`, and a version-conflict category).

### Problem 3 — The vocabulary manager is not part of the GUI
It runs as a separate browser-based tool, which is a disjointed experience.

**Required solution:** Bring the vocabulary manager and shortcode generator **into the main application** as first-class navigation destinations alongside the pipeline. Design the top-level navigation for DC Hub so it cleanly accommodates: the **Pipeline** (the run/log workspace), the **Vocabulary** (dimension tag tables), the **Shortcode generator**, and **Settings**. Propose the navigation pattern (e.g. left rail with primary sections, or top tabs) and show how the user moves between the pipeline workspace and the vocabulary workspace.

### Problem 4 — Vocabulary subtypes should be collapsible
The per-dimension tag tables group rows by subtype, but the groups are always fully expanded, making long lists (e.g. 47 product tags) hard to scan.

**Required solution:** Make each **subtype group collapsible** within the dimension table (e.g. collapse `PRODUCT` to focus on `CUSTOMER`). Show the tag count per subtype group on its header. Consider a sensible default (e.g. all expanded, or remember last state).

### Problem 5 — New shortcodes should auto-prefix by subtype
When adding a new Entity tag, the user must manually type the prefix (`p-`, `c-`, `x-`, `e-`). This is error-prone.

**Required solution:** In the Add/Edit tag flow, when the dimension is **Entity**, selecting a **subtype** should **automatically prefix the shortcode** according to the prefix rules (`product` → `p-`, `customer` → `c-`, `partner` → `x-`, `event` → `e-`, `company` → no prefix). Design the interaction so the prefix appears automatically and the user types only the distinctive part (e.g. selecting "product" pre-fills/locks a `p-` prefix and the user types `Sln`). Make it clear in the UI that the prefix is derived from the subtype, and handle the company case (no prefix) gracefully.

---

## 5. Brand & design system

Apply the **Disrupt Collective design system** (being built separately, ahead of this work). The current app already hints at a direction the redesign can refine or replace:
- **Dark-mode-first**, near-black layered surfaces (background → surface → raised card), structural borders.
- A **monospace** feel is used heavily today for labels and codes (fitting for a developer-ish tool and for displaying shortcodes/filenames) — decide deliberately whether to keep monospace for code/shortcode display while using the brand typeface for UI chrome.
- Status colour system already in use: green = success/accent, blue = secondary accent, amber = warning/skip, red = error, orange = disconnected. Map these onto DC's palette.
- Accent colour should be **purposeful, not decorative** — reserve it for the primary Run action and key states.

Treat the existing colours and fonts as placeholders to be replaced by the DC design tokens, not as constraints.

---

## 6. Design priorities & principles

- **Configure once, run repeatedly.** The pipeline's core loop is: set it up, then run it many times. The **Run** action and **run status/progress** must always be visible and unmistakable.
- **Surface problems, hide noise.** A successful run should be calm; a run with issues should make those issues immediately findable (see Problem 2).
- **Dense but breathable.** This is a professional tool — information density matters, but it must never feel cramped. Use the collapsible patterns to manage density.
- **One coherent app.** Pipeline, Vocabulary, Generator, and Settings should feel like one product with one navigation model (see Problem 3).
- **Respect the domain.** Shortcodes, filenames, and tags are the heart of the workflow — display them precisely and make them easy to read, build, and copy.

---

## 7. Deliverables requested from Claude Design

1. A proposed **top-level navigation model** for the unified DC Hub (Pipeline / Vocabulary / Generator / Settings).
2. **Pipeline workspace** redesign: collapsible configuration sidebar, always-visible Run/Stop/progress, and the restructured activity log with separated issue views (Problems 1 & 2).
3. **Vocabulary** redesign: dimension tag tables with collapsible subtype groups and per-group counts (Problem 4).
4. **Add/Edit tag** flow with subtype-driven auto-prefixing for Entity (Problem 5).
5. **Shortcode generator** redesign: dimension panels, description + version inputs, live result + Obsidian-tag preview, copy.
6. **Settings** redesign (in-app, ideally not a detached modal): all fields from §3.8 organised sensibly.
7. Application of the **DC design system** throughout (once tokens are available).

Wireframe / low-fidelity structure first; high-fidelity once the navigation and the five problem-solutions are agreed.

---

## 8. Open questions to resolve (ask the requester)

- Should **Last Run stats** stay in the sidebar, move into the activity area, or become a header strip above the log?
- For the separated log (Problem 2): preference for **tabs** vs a **persistent log + grouped Issues panel**?
- Top-level nav: **left rail** vs **top tabs**? (Affects how Pipeline's own sidebar coexists with global nav.)
- Should the **Generate thumbnails** prerequisites (LibreOffice / poppler / webp) be surfaced as a status/health check in the UI?
- Any assets/screens not covered above that should be in scope?
