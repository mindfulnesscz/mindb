# dc-hub

Digital asset pipeline for ESS Marketing. Distributes, publishes, thumbnails, and indexes marketing materials into Obsidian — with version filtering, Dropbox/OneDrive integration, and automatic naming translation.

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Running the app](#running-the-app)
- [Folder structure](#folder-structure)
- [File naming](#file-naming)
  - [Filename pattern](#filename-pattern)
  - [Slot 1 — Entity](#slot-1--entity)
  - [Slot 2 — Angle](#slot-2--angle)
  - [Slot 3 — Format](#slot-3--format)
  - [Versioning](#versioning)
- [Tasks](#tasks)
  - [Generate thumbnails](#generate-thumbnails)
  - [Distribute](#distribute)
  - [Publish on cloud](#publish-on-cloud)
  - [Publish to DAM](#publish-to-dam)
- [Excluding files and folders](#excluding-files-and-folders)
- [Version filtering](#version-filtering)
- [Dropbox integration](#dropbox-integration)
- [OneDrive integration](#onedrive-integration)
- [Settings reference](#settings-reference)
- [Adding new tags](#adding-new-tags)

---

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| **Python** | 3.10 or later | [python.org/downloads](https://python.org/downloads) |
| **LibreOffice** | any recent | PPTX → thumbnail conversion. [libreoffice.org](https://libreoffice.org) |
| **poppler** | any | PDF → thumbnail. `brew install poppler` |
| **webp** | any | WebP encoding. `brew install webp` |

Python and Homebrew are the only hard dependencies to install manually. LibreOffice, poppler, and webp are only needed if you use **Generate thumbnails** — the rest of the app works without them.

Install Homebrew (macOS) if you don't have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install the CLI tools:

```bash
brew install poppler webp
```

---

## Installation

Clone or download the repository, then let the launcher handle the rest on first run. No manual `pip install` needed.

```bash
git clone <repo-url> dc-hub
cd dc-hub
```

The `.venv` virtual environment and Python dependencies (`customtkinter`, `darkdetect`) are created automatically the first time you launch the app.

---

## Running the app

### macOS — double-click launcher

Double-click `run.command` in Finder.

> First run only: macOS may show a security warning. Go to **System Settings → Privacy & Security** and click "Open Anyway".

The launcher:
1. Creates `.venv` if it doesn't exist yet.
2. Installs/updates `requirements.txt` (once per day).
3. Starts the app.

### macOS — Terminal

```bash
cd /path/to/dc-hub
python3 -m venv .venv          # only needed once
source .venv/bin/activate
pip install -r requirements.txt # only needed once
python app.py
```

### Windows — double-click launcher

Double-click `run.bat`. Same auto-setup logic as the macOS launcher.

### Windows — Command Prompt

```bat
cd \path\to\dc-hub
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

---

## Folder structure

Each project folder follows this layout:

```
My Project/
├── [00] 📦 My Project/   ← package (auto-populated — do not edit manually)
├── [01] IN/              ← source inputs, originals, raw imports
├── [02] WRK/             ← work in progress, iterations
└── [03] OUT/             ← finished files — only these are deployed
```

| Folder | Role |
| --- | --- |
| `[00] 📦 …` | Collected package — cleared and repopulated on every Distribute run |
| `[01] IN` | Inputs only — never deployed |
| `[02] WRK` | Working files — never deployed |
| `[03] OUT` | The only folder that matters for deployment |

**Rules:**
- Only files inside `[03] OUT` are ever copied, published, or indexed.
- The `[00] 📦` folder is managed by the tool — don't store anything there manually.
- Subfolders inside `[03] OUT` are supported (gallery folders and regular subfolders).

### Gallery folders

A gallery folder is a direct subfolder of `[03] OUT` that:
- has a name matching the `(Tag)…` naming convention, and
- contains at least one image file (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.tif`, `.bmp`).

Gallery folders are treated as a **single asset**: one Obsidian note, one thumbnail (from the first image alphabetically), and the entire folder is copied as a unit to the target.

```
[03] OUT/
├── (ESS)(SAL)(SlD)v2-0-0.pptx           ← regular file → one note, one thumbnail
└── (ESS)(SM)(Crs) Social Pack v1-0/     ← gallery folder → one note, folder copied whole
    ├── slide-01.jpg
    ├── slide-02.jpg
    └── slide-03.jpg
```

---

## File naming

### Filename pattern

```
(Entity)(Angle)(Format)vX-Y-Z.ext
(Entity)(Angle)(Format)(Description)vX-Y-Z.ext
```

| Part | Required | Rule |
| --- | --- | --- |
| `(Entity)` | Yes | Slot 1 — what the asset is about. See [Slot 1](#slot-1--entity). |
| `(Angle)` | Yes | Slot 2 — purpose or content type. See [Slot 2](#slot-2--angle). |
| `(Format)` | Yes | Slot 3 — physical deliverable. See [Slot 3](#slot-3--format). |
| `(Description)` | Optional | Plain-language label — short, human-scannable. |
| `vX-Y-Z` | Optional | Semantic version. See [Versioning](#versioning). |

> **Round brackets `()` are the standard from v1.0.** Square brackets `[]` are still parsed as a legacy alias — existing files do not need to be renamed immediately, but new files should use `()`.

> **No dates in filenames.** The version number is the source of truth for file currency.

**Examples:**

```
(p-Rns)(SAL)(SlD)v2-0-1.pptx
(p-DpP)(SAL)(SlD)v3-0-5.pptx
(p-Wax)(SAL)(SlD)(Flood Control)v3-1-13.pptx
(c-BMW)(ABM)(SlD)v1-0-0.pptx
(p-TpC)(ABM)(SlD)(China Bumpers)v1-0-0.pptx
(ESS)(REL)(SlD)(Highlights)v3-2-2.pptx
(e-PEX)(EVT)(Prn)(Booth Design)v1-0-0.pdf
(ESS)(SM)(Img)(Happy Birthday)v1-0-0.jpg
(ESS)(CRP)(Vid)(Easy To Use)v1-0-0.mp4
(ESS)(CMP)(Crs)(DIP Campaign)v1-0-0.jpg
(x-AuF)(PTN)(SlD)v2-1-0.pptx
```

**Translated export names** (what SharePoint / OneDrive sees):

```
(p-Sln)(SAL)(SlD)v1-2-1.pptx             →  Sealing Sales Slide Deck v1-2-1.pptx
(ESS)(SAL)(SlD)(Main Company)v2-0-0.pptx →  ESS Sales Slide Deck — Main Company v2-0-0.pptx
(c-BMW)(ABM)(SlD)v3-1-0.pptx             →  BMW Account-Based Slide Deck v3-1-0.pptx
```

---

### Slot 1 — Entity

What or who the asset is about. Five subtypes, each with a clear shortcode prefix.

**Company-wide**

| Shortcode | Label | When to use |
| --- | --- | --- |
| `ESS` | ESS | Not product-specific; belongs to the ESS brand overall. |

**ESS products — prefix `p-`**

| Shortcode | Label | Shortcode | Label |
| --- | --- | --- | --- |
| `p-Rns` | Rinsing | `p-Cld` | Cloud |
| `p-DpP` | Dip Paint | `p-AIQ` | AnodeIQ |
| `p-EtC` | E-Coating | `p-BlB` | Black Box |
| `p-Ovn` | Oven | `p-PIQ` | PaintIQ |
| `p-Sln` | Sealing | `p-AtR` | Automate Reporting |
| `p-SIQ` | SealingIQ | `p-Mrg` | Merge |
| `p-Wax` | Waxing | `p-Als` | Alsim |
| `p-SpW` | Spray Waxing | `p-EnO` | Encapsulated Oven |
| `p-TpC` | Top Coating | `p-EnP` | Encapsulated Paint Shop |
| `p-PwC` | Powder Coating | | |
| `p-And` | Anodizing | | |

**Customers — prefix `c-`**

| Shortcode | Label | Shortcode | Label |
| --- | --- | --- | --- |
| `c-ABB` | ABB | `c-MRC` | MRC |
| `c-AUD` | Audi | `c-MTS` | MTS |
| `c-BMW` | BMW | `c-SKD` | Skoda |
| `c-CEE` | CEE | `c-STE` | Stellantis |
| `c-EBZ` | EBZ | `c-COA` | COA-CFD |
| `c-GM` | GM | `c-GUI` | GUI |
| `c-INE` | INEOS | | |
| `c-JLR` | JLR | | |

**External partners — prefix `x-`**

| Shortcode | Label |
| --- | --- |
| `x-AuF` | Autoform |
| `x-JJ` | JJ |

**Events & conferences — prefix `e-`**

| Shortcode | Label | Shortcode | Label |
| --- | --- | --- | --- |
| `e-PEX` | Paint Expo | `e-SRC` | SRC |
| `e-PS30` | PS-2030 | `e-SAE` | SAE |
| `e-PSD` | PS-D | `e-Wbn` | Webinar |
| `e-ICS` | ICS | | |

---

### Slot 2 — Angle

The purpose or content type of the asset.

**Sales & marketing**

| Shortcode | Label | Shortcode | Label |
| --- | --- | --- | --- |
| `SAL` | Sales | `TST` | Testimonial |
| `TEC` | Technical | `CSS` | Case Study |
| `OVR` | Overview | `SUC` | Success Story |
| `BCS` | Business Case | `UC` | Use Case |
| `ABM` | Account-Based | `PPT` | Pain Point |
| `SML` | Simulation | | |

**Content type**

| Shortcode | Label | Shortcode | Label |
| --- | --- | --- | --- |
| `CMP` | Campaign | `SUS` | Sustainability |
| `REL` | Product Release | `HRE` | Hiring |
| `SM` | Social Media | `ILL` | Illustration |
| `TRN` | Training | `3D` | 3D |

**Context**

| Shortcode | Label |
| --- | --- |
| `BRD` | Brand |
| `CRP` | Corporate |
| `EVT` | Event |
| `PTN` | Partner |
| `ADD` | Add-On |

---

### Slot 3 — Format

What the deliverable physically is.

**Documents & presentations**

| Shortcode | Label | Icon |
| --- | --- | --- |
| `SlD` | Slide Deck | 🗂️ |
| `PDF` | PDF | 📄 |
| `Dcm` | Word Document | 📝 |
| `1Pg` | One-Pager | 📋 |
| `Hnd` | Handover | 🤝 |
| `Mnl` | Manual | 📖 |
| `Art` | Article | ✍️ |

**Media & visual**

| Shortcode | Label | Icon |
| --- | --- | --- |
| `Vid` | Video | 🎬 |
| `Img` | Static Image | 🖼️ |
| `Crs` | Carousel | 🎠 |
| `Bnn` | Banner | |
| `Prn` | Print | 🖨️ |
| `Web` | Web Asset | 🌐 |
| `Gdy` | Goodie | 🎁 |
| `PrP` | Profile Picture | |
| `Gll` | Gallery | 🖼️ |

**Image background variants**

| Shortcode | Label |
| --- | --- |
| `WhtB` | White Background |
| `GryB` | Gray Background |
| `TrpB` | Transparent Background |

---

### Versioning

```
(p-Sln)(SAL)(SlD)v3-0-5.pptx
(ESS)(SAL)(SlD)(Main Company Introduction)v2-3-14.pptx
```

Format: `vMAJOR-MINOR-PATCH` using hyphens (not dots).

| Segment | Changes when… |
| --- | --- |
| MAJOR | Complete redesign or structural overhaul |
| MINOR | New sections, significant content additions |
| PATCH | Copy edits, tweaks, small visual fixes |

The version is displayed on the cover slide. The matching `-thumb.webp` thumbnail always shares the same version string and is renamed as a pair.

---

## Tasks

### Generate thumbnails

Generates a WebP thumbnail from the first slide or page of every `.pptx`, `.ppt`, `.pptm`, and `.pdf` file inside `[03] OUT`. Saved next to the source file as `{filename}-thumb.webp`.

Requires: LibreOffice, poppler (`pdftoppm`), webp (`cwebp`).

Thumbnails are never generated inside `[00] 📦` folders and never overwrite an existing thumbnail. Delete the `.webp` file manually to force regeneration.

---

### Distribute

Finds every `[00] 📦` folder, clears it, then fills it from sibling `[03] OUT` folders.

- Collects files **flat** into the package by default (subfolder structure is preserved if **Preserve folder structure in packages** is on).
- Filenames are **translated to full human-readable names** on copy: `(ESS)(SAL)(SlD)v2-0-0.pptx` → `ESS Sales Slide Deck v2-0-0.pptx`.
- Orphaned files (no longer in any `[03] OUT`) are removed from the package automatically.
- When **Keep highest version only** is on, only the file with the highest version number among files sharing the same base name is kept.

---

### Publish on cloud

Mirrors `[03] OUT` contents from source into an equivalent path inside the SharePoint / OneDrive target folder.

- Filenames are translated to human-readable names on copy.
- Unchanged files (same size as destination) are skipped.
- Files no longer present in `[03] OUT` are renamed with a `🚫` prefix in the target instead of being deleted — this flags them as disconnected without breaking their existing share links.
- **Flat export to OneDrive** (sub-option): additionally copies all assets into a single flat folder for the OneDrive marketing kit, deduplicating by version.

---

### Publish to DAM

Builds an Obsidian vault overlay — one markdown note per asset, with auto-generated canvas files for visual navigation.

Each note contains:
- Thumbnail embed (from the matching `-thumb.webp` file)
- Inline `#tags` from all matched vocabulary entries
- Metadata table: Version, Created, Dropbox link, OneDrive link, Source, tag labels
- A warning callout at the bottom if any tags were unrecognised

Canvases are auto-generated per scope. A folder containing a `[00] 📦` package becomes its own canvas scope. Notes are grouped into clusters by their position in the folder hierarchy, sorted by `[n]` folder number.

After running Publish to DAM, use the **Update OneDrive Links** button (once files have synced to OneDrive) to inject OneDrive sharing links into the relevant notes.

---

## Excluding files and folders

**Automatically skipped:**

| Pattern | Reason |
| --- | --- |
| `[99]` anywhere in the name | Archive / backup folders |
| `~$` prefix | Office temporary lock files |

**Manual exclusion:** prefix any file or folder name with `⦰` to exclude it from all operations.

Copy the character: **`⦰`**
macOS shortcut: `Control + Command + Space` → search "circled division slash"

| Where applied | Effect |
| --- | --- |
| Any folder | Not traversed during any operation |
| A sibling folder (Distribute) | Not searched for `[03] OUT` |
| A file inside `[03] OUT` | Not copied, published, or indexed |
| A `[00] 📦` folder | Not recognised as a package |

---

## Version filtering

When **Keep highest version only** is enabled, only the file with the highest `vX-Y-Z` number among files sharing the same base name is collected. Older versions are skipped (not deleted).

| File | Result |
| --- | --- |
| `(ESS)(SAL)(SlD)v1-0-0.pptx` | ✗ skipped |
| `(ESS)(SAL)(SlD)v1-2-0.pptx` | ✓ kept |
| `(c-BMW)(ABM)(SlD).pptx` | ✓ always kept (no version) |

---

## Dropbox integration

Dropbox sharing links are automatically embedded into Obsidian notes when the source folder lives inside a Dropbox-synced directory.

**Setup:**
1. Go to [dropbox.com/developers/apps](https://dropbox.com/developers/apps) and create an app (Scoped access, Full Dropbox).
2. Copy the **App key**.
3. In dc-hub: open **Settings**, paste the App key into **Dropbox app key**, save.
4. Click **Connect** next to Dropbox. Your browser opens the Dropbox authorisation page.
5. Approve. The app receives and stores tokens automatically (with silent refresh).

Links are cached per version — if the file version hasn't changed, the existing link is reused without an API call.

---

## OneDrive integration

OneDrive sharing links are injected into notes as a separate step after files have synced.

**Setup:**
1. Register a free app at [portal.azure.com](https://portal.azure.com) → App registrations → New registration.
   - Platform: Mobile and desktop application
   - Enable: Allow public client flows (Device code flow)
   - Permissions: `Files.ReadWrite`, `offline_access`
2. Copy the **Application (client) ID**.
3. In dc-hub: open **Settings**, paste it into **OneDrive app client ID**. Set **OneDrive tenant ID** to your organisation's Directory ID (or leave as `common` for personal accounts).
4. Click **Connect** next to OneDrive. Follow the device code instructions shown in the log.

After running **Publish on cloud → Flat export to OneDrive** and waiting for files to sync, click **Update OneDrive Links** to inject the links into notes.

---

## Settings reference

Open with the **⚙ Settings** button in the top-right corner of the app.

| Setting | Default | Description |
| --- | --- | --- |
| Filter mode | `blacklist` | `blacklist` skips items with the exclude mark; `whitelist` keeps only items with the include mark |
| Package folder prefix | `[00] 📦` | Prefix that identifies a package folder |
| Output folder name | `[03] OUT` | Name of the folder holding deployed files |
| Exclude mark | `⦰` | Prefix that marks a file or folder as excluded (blacklist mode) |
| Include mark | `🏁` | Prefix that marks a file or folder as included (whitelist mode) |
| Thumbnail width (px) | `640` | Thumbnail output width; height scales proportionally |
| Thumbnail quality | `70` | WebP quality 0–100 |
| DAM folder depth | `0` | How many levels of source folder hierarchy to mirror in the DAM (0 = flat) |
| Dropbox app key | — | Your Dropbox app's App key (from the Dropbox developer console) |
| OneDrive app client ID | — | Azure app registration Client ID |
| OneDrive tenant ID | `common` | Azure Directory (tenant) ID, or `common` for personal accounts |

Settings are saved to `settings.json` next to `app.py`. Delete `settings.json` to reset to defaults (folder paths are preserved in the UI after reset).

---

## Adding new tags

1. Open `vocabulary.json`.
2. Add a new entry to the `"tags"` array.
3. Choose the correct `"slot"`: `entity`, `angle`, or `format`.
4. Choose the correct `"subtype"`:
   - Entity: `company`, `product`, `customer`, `partner`, or `event`
   - Angle: `sales-mktg`, `content`, or `context`
   - Format: `document`, `media`, or `image-var`
5. Apply the correct **shortcode prefix**:

   | What you're adding | Prefix | Example |
   | --- | --- | --- |
   | New ESS product | `p-` | `p-New` |
   | New customer | `c-` | `c-VWG` |
   | New partner | `x-` | `x-Xyz` |
   | New event | `e-` | `e-ABC` |
   | Angle or Format | none | `SAL`, `SlD` |

6. Use `CamelCase` for the shortcode body (3–5 characters is ideal).
7. Add the matching row to the relevant table in `NAMING CONVENTION.md`.

**Never use** `_`, `±`, `~`, `=` prefixes — those are legacy and are silently remapped via `legacy_aliases` in `vocabulary.json`.
