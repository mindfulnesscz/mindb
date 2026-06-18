# Package Maker

Scans a source folder, collects output files into package folders, mirrors them to a target, generates thumbnails, and builds an Obsidian DAM (Digital Asset Manager) — with version filtering, exclusion marks, and configurable folder patterns.

---

## Table of Contents

- [Folder Structure](#folder-structure)
- [File Naming](#file-naming)
  - [Tags](#tags)
  - [Description](#description)
  - [Version](#version)
- [Tag Vocabulary](#tag-vocabulary)
- [Tasks](#tasks)
  - [Distribute](#distribute)
  - [Publish](#publish)
  - [Generate Thumbnails](#generate-thumbnails)
  - [Obsidian DAM](#obsidian-dam)
- [Excluding Files and Folders](#excluding-files-and-folders)
- [Version Filtering](#version-filtering)
- [Settings](#settings)

---

## Folder Structure

Each project folder follows a fixed four-folder layout:

```text
My Project/
├── [00] 📦 My Project/   ← package (auto-populated, do not edit manually)
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

- Only files inside `[03] OUT` are ever copied, published, or indexed in Obsidian.
- The `[00] 📦` folder is managed by the tool — don't store anything there manually.
- Subfolders inside `[03] OUT` are supported — see below.

### Multiple files in [03] OUT

Every file in `[03] OUT` is handled independently:

- Each file gets its own Obsidian note.
- Each `.pptx`, `.ppt`, `.pptm`, or `.pdf` file gets its own thumbnail.
- Each file is individually distributed to the package and published to the target.

### Subfolders in [03] OUT

Subfolders in `[03] OUT` behave differently depending on what they contain.

**Gallery folder** — a subfolder that:

- has a name matching the `[TAG]…` naming convention, and
- contains at least one image file (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.tif`, `.bmp`)

A gallery folder is treated as a **single asset**. It gets one Obsidian note, the first image alphabetically is used as its thumbnail, and the entire folder is copied as a unit to the target. Use this for image sets, carousel assets, or any collection of images belonging to one deliverable.

```text
[03] OUT/
├── [ESS][SAL][DK]v2-0-0.pptx          ← regular file → one note, one thumbnail
└── [ESS][SM][CRS] Social Pack v1-0/    ← gallery folder → one note, folder copied whole
    ├── slide-01.jpg
    ├── slide-02.jpg
    └── slide-03.jpg
```

**Regular subfolder** — any subfolder that does not qualify as a gallery. Files inside are traversed recursively and each file is handled individually, the same as files directly in `[03] OUT`. The subfolder path is mirrored in the DAM vault so notes stay organised.

---

## File Naming

Files inside `[03] OUT` must follow this pattern:

```text
[TAG1][TAG2][TAG3] Description v1-2-3.ext
```

```text
[ESS][SAL][DK]v2-0-0.pptx
[ESS][SAL][DK] Main Company Introduction v2-3-14.pptx
[BMW][ABM][DK]v1-0-0.pptx
[_Sea][SAL][DK] Flood Control v3-1-13.pptx
[P-EXP][EVT][PRI] Booth Design v1-0-0.pdf
[ESS][SM][IMG] Happy Birthday v1-0-0.jpg
```

### Tags

- Any number of `[TAG]` brackets, in any order.
- Tags must appear **at the very start** of the filename.
- Each tag is a shortcode from the vocabulary (see [Tag Vocabulary](#tag-vocabulary)).
- Unknown tags are silently skipped — no error, but a note is added to the Obsidian card.
- A file with no bracket tags at all gets flagged as incomplete.

### Description

- Optional plain-language label placed **after** all bracket tags.
- Can be preceded by a space or underscore — both are stripped.
- Keep it short and human-scannable.

### Version

- Optional. Place it after the description (or after the tags if no description).
- Accepted formats: `v1`, `v1-2`, `v1-2-3`, `v1.2`, `v1.2.3`, `V1`, `V2-1` (case-insensitive, any separator).
- Dots are normalised to hyphens on export: `v1.2.3` → `v1-2-3`.
- No version? The Obsidian card shows `---` in the Version field and won't be re-updated on subsequent runs.

> No dates in filenames. Version is the source of truth for file currency.

---

## Tag Vocabulary

All recognised shortcodes. Tags are grouped by type but can appear in any order in the filename.

### Topic — what the piece is about

| Tag | Label |
| --- | --- |
| `[ESS]` | ESS |
| `[_Rin]` | Rinsing |
| `[_Dip]` | Dip Paint |
| `[_E-C]` | E-Coating |
| `[_Ovn]` | Oven |
| `[_Sea]` | Sealing |
| `[_Wax]` | Waxing |
| `[_Tpc]` | Top Coating |
| `[_Pwd]` | Powder Coating |
| `[_Ano]` | Anodizing |
| `[_Cld]` | Cloud |
| `[_A-M]` | Anode Master |
| `[_BB]` | Black Box |
| `[_PIQ]` | Paint Analyzer |
| `[_A-R]` | Automate Reporting |
| `[_Mrg]` | Merge |
| `[_Als]` | Alsim |
| `[ABB]` | ABB |
| `[AUD]` | Audi |
| `[BMW]` | BMW |
| `[CEE]` | CEE |
| `[EBZ]` | EBZ |
| `[GM]` | GM |
| `[INE]` | INE |
| `[JLR]` | JLR |
| `[MRC]` | MRC |
| `[MTS]` | MTS |
| `[SKD]` | SKD |
| `[STE]` | Stellantis |
| `[P-EXP]` | Paint Expo |
| `[PS30]` | PS30 |
| `[ICS]` | ICS |
| `[SRC]` | SRC |
| `[SAE]` | SAE |

### Type — the purpose of the piece

| Tag | Label |
| --- | --- |
| `[SAL]` | Sales Pitch |
| `[TEC]` | Technical |
| `[OVR]` | Overview |
| `[BCS]` | Business Case |
| `[ABM]` | Account-Based |
| `[ADD]` | Add-On |
| `[BRD]` | Brand |
| `[CRP]` | Corporate |
| `[EVT]` | Event |
| `[PTN]` | Partner |
| `[TRA]` | Training |
| `[SM]` | Social Media |
| `[TST]` | Testimonial |
| `[CSS]` | Case Study |
| `[SUC]` | Success Story |
| `[UC]` | Use Case |
| `[REL]` | Product Release |
| `[HIR]` | Hiring |
| `[SUS]` | Sustainability |
| `[PPT]` | Pain Point |
| `[CMP]` | Campaign |
| `[ENO]` | Encapsulated Oven |
| `[ILL]` | Illust |

### Format — what the deliverable physically is

| Tag | Label |
| --- | --- |
| `[VID]` | 🎬 Video |
| `[DK]` | 🗂️ Slide Deck |
| `[PDF]` | 📄 PDF Document |
| `[DOC]` | 📝 Word Document |
| `[1P]` | 📋 One-Pager |
| `[HAN]` | 🤝 Handover |
| `[MN]` | 📖 User Manual |
| `[SL]` | 🧩 Add-on Slide |
| `[IMG]` | 🖼️ Static Image |
| `[CRS]` | 🎠 Carousel |
| `[ART]` | ✍️ Article |
| `[PRI]` | 🖨️ Print File |
| `[GDY]` | 🎁 Goodie |
| `[BNR]` | 🏳️ Banner |
| `[WEB]` | 🌐 Web Asset |
| `[WB]` | White Bkg |
| `[GB]` | Gray Bkg |
| `[TB]` | Transp Bkg |

To add new tags, edit `vocabulary.json` — one entry per line, `type` must be `topic`, `type`, or `format`.

---

## Tasks

### Distribute

Finds every `[00] 📦` folder, clears it, then fills it from sibling `[03] OUT` folders.

```text
My Project/
├── [00] 📦 My Project/     ← cleared then populated
├── [02] WRK/
│   └── [03] OUT/
│       └── [ESS][SAL][DK]v1-2-0.pptx   ← collected ✓
└── [03] OUT/
    └── [BMW][ABM][DK]v1-0-0.pptx        ← collected ✓
```

- Copies files **flat** into the package by default (subfolder structure not preserved unless Pack subfolders is on).
- Filenames are **translated to full human-readable names** on copy: `[ESS][SAL][DK]v2-0-0.pptx` → `ESS Sales Pitch Slide Deck v2-0-0.pptx`.
- Orphaned files (no longer in any `[03] OUT`) are removed from the package automatically.

### Publish

Mirrors `[03] OUT` contents from source into an equivalent path inside the target folder. Everything else (`[01] IN`, `[02] WRK`, etc.) is ignored.

- Filenames are translated to human-readable names on copy.
- A file is only overwritten if the source is newer or a different size — unchanged files are skipped.
- **Target folders and files are never deleted.** SharePoint and Dropbox links stay intact.
- Files and folders no longer represented in `[03] OUT` are renamed with a `🚫` prefix instead of being removed. This flags them as disconnected without breaking their share links.

### Generate Thumbnails

Generates a WebP thumbnail from the first slide or page of every `.pptx`, `.ppt`, `.pptm`, and `.pdf` file. Saved next to the source file as `{filename}-thumb.webp`.

Requires three CLI tools:

| Tool | Purpose | Install (macOS) |
| --- | --- | --- |
| `soffice` | PPTX → PDF | [LibreOffice](https://www.libreoffice.org) |
| `pdftoppm` | PDF page → PNG | `brew install poppler` |
| `cwebp` | PNG → WebP | `brew install webp` |

Thumbnails are never generated inside `[00] 📦` folders.

### Obsidian DAM

Builds an Obsidian vault overlay — one markdown note per asset, grouped into canvas files for visual navigation.

**Notes** are created in the DAM root (configured in Settings). Each note contains:

- Thumbnail embed
- Inline tags from all matched vocabulary entries
- Metadata table: Version, Created, Dropbox/OneDrive links, Source, tags
- A note at the bottom if any tags were unrecognised

**Canvases** are auto-generated per scope. A folder containing a `[📦]` package becomes its own canvas scope — assets inside are grouped on a canvas named `_X FOLDER NAME -c3.canvas`. All assets outside any package scope appear on `_X ROOT -c3.canvas`.

Canvas layout rules:

- Assets are arranged in clusters by their position in the folder hierarchy.
- Direct children of the scope root share one cluster.
- Siblings one level deeper form sub-clusters, positioned with smaller gaps.
- Clusters are sorted: direct children first, then by `[n]` folder number.

---

## Excluding Files and Folders

**Automatically skipped — no action needed:**

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

## Version Filtering

When **Keep highest version only** is enabled, only the file with the highest version number among files sharing the same base name is kept. Older versions are skipped.

| File | Result |
| --- | --- |
| `[ESS][SAL][DK]v1-0-0.pptx` | ✗ skipped |
| `[ESS][SAL][DK]v1-2-0.pptx` | ✓ kept |
| `[BMW][ABM][DK].pptx` | ✓ always kept (no version) |

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| **Package folder prefix** | `[00] 📦` | Prefix that identifies a package folder |
| **Output folder name** | `[03] OUT` | Name of the folder holding deployed files |
| **Exclude mark** | `⦰` | Prefix that marks a file or folder as excluded |
| **Thumbnail width (px)** | `320` | Thumbnail output width (height scales proportionally) |
| **Thumbnail quality** | `70` | WebP quality 0–100 |

Saved to `settings.json` next to `app.py`. Delete the file to reset to defaults.