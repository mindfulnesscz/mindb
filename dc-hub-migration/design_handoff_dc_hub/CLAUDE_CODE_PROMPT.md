# Claude Code brief — Rebuild **DC Hub** as a cross-platform desktop app

Paste this whole file into Claude Code, run from the repository that contains the
existing Python proof-of-concept. Read `design-brief.md` and `README.md` (in this
handoff folder) before writing any code — they are the source of truth for behaviour
and visual design respectively.

---

## 1 · What you are building, and why

**DC Hub** is an internal desktop tool for **Disrupt Collective**, a creative studio.
It is a **Digital Asset Management (DAM) pipeline** plus the **controlled vocabulary**
and **shortcode generator** that drive the studio's file-naming convention.

### What the app does (functional purpose)

The studio keeps a structured source folder of marketing assets. Every filename
follows the convention:

```
(Tag)(Tag)... Description vX-Y-Z.ext      e.g.  (ESS)(p-Sln) Sealing overview v1-2-0.pdf
```

Tags are **shortcodes** drawn from a controlled vocabulary with three dimensions —
**Entity** (who/what), **Angle** (purpose), **Format** (file kind) — each split into
**subtypes**. Entity shortcodes carry a subtype-derived prefix
(`company`→none, `product`→`p-`, `customer`→`c-`, `partner`→`x-`, `event`→`e-`).

DC Hub runs a **pipeline** of operations, in fixed order, over that source folder:

1. **Generate thumbnails** — WebP previews from the first slide/page of
   PPTX/PPT/PPTM/PDF (needs LibreOffice headless + poppler + a webp encoder).
2. **Distribute packages** — find `[00] 📦` package folders, collect output files
   from sibling project folders, version-filter, copy them in.
3. **Publish on cloud** — mirror `[03] OUT` contents to a target path (rsync-like per
   folder). **Flat export to OneDrive** is a nested sub-option here.
4. **Publish to DAM** — build an Obsidian vault overlay: one note per asset, canvases
   per scope, with Dropbox/OneDrive share links embedded.

It also manages the **vocabulary** (CRUD on tags, grouped by subtype) and a
**shortcode generator** (pick tags across dimensions → live filename code + Obsidian
`#tags` preview).

Folder-name conventions matter: package folders `[00] 📦`, output `[03] OUT`, an
exclude mark `⦰` (blacklist), include mark `🏁` (whitelist), and `[99]` / `~$` items
are always skipped. Versions are semantic `vX-Y-Z`; the pipeline can keep only the
highest version of each file.

### The core principle

**Configure once, run repeatedly.** The Run action and run status/progress must always
be visible. A clean run should feel calm; a run *with issues* must make those issues
instantly findable (see the Issues panel in the design).

---

## 2 · There is already a POC in this repo — replace it

**This repository already contains a working proof-of-concept of this exact app,
written in Python.** It is two separate programs:

1. `app.py` — the pipeline GUI, built with **customtkinter** (the four operations,
   log, stats, a settings modal).
2. `vocab-manager.py` — a **separate** tool that opens in a web browser, used to edit
   the vocabulary and generate shortcodes.

The POC is **functionally complete and correct** — but the **design and UX are poor**,
it is **two disjointed apps**, the pipeline sidebar requires endless scrolling, and the
log dumps everything into one console. **We are getting rid of the Python version.**

**Your job:**
- Treat the Python POC as the **behavioural reference / ground truth for logic only** —
  read it to understand exactly how thumbnails are generated, how distribution &
  version-filtering work, how the DAM/Obsidian overlay is built, how cloud links are
  formed, and what every setting does. Mirror that behaviour faithfully.
- **Do not preserve any of its UI, layout, or structure.** The new UI is defined
  entirely by this handoff (`README.md` + the hi-fi prototype).
- **Unify the two programs into one application** with a single navigation model:
  Pipeline / Vocabulary / Generate / Settings as first-class areas.
- Once the new app reaches parity, the Python files are to be **removed** (confirm
  with the user before deleting; keep them until parity is verified).

Start by exploring the repo: locate `app.py`, `vocab-manager.py`, any settings/config
files (JSON/TOML/INI), the vocabulary data store, and the thumbnail/distribute/DAM
logic. Summarise what you find and the data shapes before porting.

---

## 3 · The stack to build

A clickable, installable, cross-platform desktop app (macOS / Windows / Linux) — app
icon, normal double-click launch, **no terminal/shell commands for the end user**.

| Layer | Choice | Notes |
|---|---|---|
| **Desktop shell** | **Tauri 2** | Tiny native bundle, OS webview, signed installers + auto-update built in. Keep nearly all logic in TypeScript via Tauri's JS plugins; touch Rust only for bundler config + any sidecar wiring. |
| **Frontend** | **Vite + React + TypeScript** | The DC design components are React; this is the natural fit. |
| **Styling** | **Plain CSS / CSS Modules + DC tokens** | No Tailwind. Import the DC token CSS (`colors/typography/spacing/fonts`) and use the `var(--*)` tokens + DC component library. |
| **Design system** | **Disrupt Collective component library** | Compose its React components (`Button`, `IconButton`, `Tag`, `Badge`, `Input`, `Checkbox`, `Card`, `Divider`, `Avatar`). Do **not** re-create them or restyle raw HTML to imitate them. Tokens + guide are in `design-system-reference/`. Ask the user for the published package/path if not already in the repo. |
| **State** | **Zustand** (or plain React state) | App is moderate size; keep it simple. |
| **Filesystem & process** | Tauri `fs`, `path`, `dialog`, `shell` plugins | Folder pickers → `dialog`. Scanning/copying → `fs`. Spawning LibreOffice/poppler/webp → `shell` with **bundled sidecar binaries** (declare them in `tauri.conf.json > bundle.externalBin`). |
| **Cloud** | Dropbox JS SDK + Microsoft Graph SDK | OAuth via `tauri-plugin-oauth` / deep-link redirect. UI only shows connection status + triggers connect, per the brief. |
| **Vocabulary store** | Local JSON (or SQLite via `tauri-plugin-sql`) | Match the POC's data model; migrate its existing vocabulary data on first run. |
| **Packaging** | Tauri bundler | `.dmg` (signed + notarized) · `.msi`/NSIS · `.AppImage` + `.deb`. App icon from the DC superellipse symbol. Auto-update via `tauri-plugin-updater`. |

If sidecar binary wiring or desktop OAuth proves painful, **Electron + electron-builder
is the acceptable fallback** — it keeps all file/process/cloud logic in pure Node/TS.
Default to Tauri; only switch if you hit a real wall, and tell the user why.

### Suggested structure

```
src/
  app/            # window shell, left nav rail, routing between the 4 areas
  features/
    pipeline/     # config sidebar (accordion + pinned Run), stats strip, log, issues panel
    vocabulary/   # dimension tabs, collapsible subtype tables, Add/Edit tag modal
    generator/    # 3 dimension panels + result rail
    settings/     # in-app settings screen
  domain/         # naming convention, prefix rules, version parsing, vocabulary model
  services/       # fs scan, thumbnails (sidecar), distribute, cloud publish, DAM/Obsidian builder
  store/          # zustand stores
  ui/             # thin wrappers over DC components if needed
src-tauri/        # Rust shell, tauri.conf.json, sidecar binaries, updater, icons
```

---

## 4 · What to implement (screens)

Build all six per `README.md` (which has exact layout, sizes, colors, type, and the
problem each solves). In short:

1. **Left nav rail** — global, 4 destinations, brand mark + avatar. One nav model for
   the whole app.
2. **Pipeline workspace** — collapsible config accordion (Paths / Connections / Tasks
   / Run options) with an **always-visible pinned Run/Stop/progress**; a **last-run
   stats strip**; a **full chronological activity log**; and a separate **Issues
   panel** that groups Skipped / Disconnected / Version conflicts / Errors with live
   counts.
3. **Vocabulary** — dimension tabs; tag table with **collapsible subtype groups** that
   show per-group counts (and the derived prefix for Entity).
4. **Add/Edit tag modal** — choose subtype first; **auto-prefix** the shortcode for
   Entity (locked `p-`/`c-`/`x-`/`e-` segment, user types only the distinctive part;
   company = no prefix).
5. **Shortcode generator** — three dimension panels (multi-select) + result rail with
   description, `v X-Y-Z` fields, live generated code (Copy), and live Obsidian-tag
   preview.
6. **Settings** — in-app screen (not a modal): Folder patterns, Thumbnails & DAM,
   Cloud credentials.

Match the **hi-fi prototype** for look; match the **Python POC** for behaviour.

---

## 5 · Definition of done

- One unified app; the two Python programs are superseded (and removed after the user
  confirms parity).
- All features in `design-brief.md §3` work end-to-end, behaviour-identical to the POC.
- All five problems in `§4` are solved as designed (no-scroll config + pinned Run;
  log vs. grouped Issues; unified nav; collapsible subtypes; auto-prefix).
- DC design system applied throughout via its component library + tokens — monochrome,
  hairline structure, Minion Pro + Commissioner. (Confirm the monospace-for-code
  exception with the user.)
- Builds to signed, installable packages for macOS, Windows and Linux with an app
  icon and normal launch — no terminal needed by the end user.
- Thumbnail prerequisites (LibreOffice/poppler/webp) ship as bundled sidecars (the
  user opted **not** to surface a health-check in the UI — fail gracefully in the log
  instead).

Work in vertical slices: stand up the Tauri shell + nav + DC tokens first, then
Pipeline (the heart), then Vocabulary + modal, then Generator, then Settings, then
packaging. Ask the user whenever the POC's behaviour is ambiguous rather than guessing.
