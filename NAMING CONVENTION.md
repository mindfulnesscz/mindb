# ESS Marketing Materials — Naming Convention

This document is the canonical reference for naming folders and files in the ESS marketing asset library. It is written to be read by both humans and automated agents (e.g. the Obsidian deploy script).

---

## Filename pattern

```text
[Subject][Angle][Format][Description(optional)]vX-Y-Z
```

| Part            | Required     | Rule                                                                                                                |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `[NN]`          | Folders only | Two-digit sort priority prefix — `[01]`, `[02]`, … Strip this from filenames inside `[03] OUT`                      |
| `[Subject]`     | Yes          | What the piece is _about_ — product, customer, partner, event, or `[ESS]` for company-wide. See **Subject** section |
| `[Angle]`       | Yes          | The purpose or topic of the piece — see **Angle** table                                                             |
| `[Format]`      | Yes          | What the deliverable physically is — see **Format** table                                                           |
| `[Description]` | Optional     | Plain-language label in a fourth bracket. Keep it short but human-scannable                                         |
| `vX-Y-Z`        | Optional     | Semantic version number — e.g. `v3-0-5`. See **Versioning** section                                                 |

> **No dates in filenames.** The version number is the source of truth for file currency. YYMM date tokens are no longer used.

**Files inside `[03] OUT`** follow the pattern:

```text
[Subject][Angle][Format]vX-Y-Z.ext
[Subject][Angle][Format][Description]vX-Y-Z.ext
[Subject][Angle][Format]vX-Y-Z-thumb.webp
```

---

## Format tags

What the deliverable physically is.

| Tag     | Meaning       |
| ------- | ------------- |
| `[VID]` | Video         |
| `[DK]`  | Slide Deck    |
| `[PDF]` | PDF Document  |
| `[DOC]` | Word Document |
| `[1P]`  | One-Pager     |
| `[HN]`  | Handover      |
| `[MN]`  | User Manual   |
| `[SL]`  | Add-on Slide  |
| `[IMG]` | Static Image  |
| `[CRS]` | Carousel      |
| `[ART]` | Article       |
| `[PRT]` | Print File    |
| `[GDY]` | Goodie        |
| `[BNR]` | Banner        |
| `[WEB]` | Web Asset     |
| `[WB]`  | White Bkg     |
| `[GB]`  | Gray Bkg      |
| `[TB]`  | Transp Bkg    |

---

## Angle tags

The purpose or topic of the piece.

| Tag     | Meaning         |
| ------- | --------------- |
| `[SAL]` | Sales           |
| `[TEC]` | Technical       |
| `[OVR]` | Overview        |
| `[BCS]` | Business Case   |
| `[ABM]` | Account-Based   |
| `[ADD]` | Add-On          |
| `[BRD]` | Brand           |
| `[CRP]` | Corporate       |
| `[EVT]` | Event           |
| `[PTN]` | Partner         |
| `[TRN]` | Training        |
| `[SM]`  | Social Media    |
| `[TST]` | Testimonial     |
| `[CSS]` | Case Study      |
| `[SUC]` | Success Story   |
| `[UC]`  | Use Case        |
| `[REL]` | Product Release |
| `[HRE]` | Hiring          |
| `[SUS]` | Sustainability  |
| `[PPT]` | Pain Point      |
| `[CMP]` | Campaign        |
| `[ILL]` | Illust          |

---

## Subject — what the piece is about

The **first** bracket identifies the subject of the asset.

**Company-wide**
`[ESS]` — not product-specific; belongs to the ESS brand overall.

**ESS products** — use the full product name with a `_` prefix:
`[_Rinsing]`, `[_Dip Paint]`, `[_E-Coating]`, `[_Oven]`, `[_Sealing]`, `[_Waxing]`, `[_Top Coating]`, `[_Powder Coating]`, `[_Anodizing]`, `[_Cloud]`, `[_Anode Master]`, `[_Black Box]`, `[_Paint Analyzer]`, `[_Automate Reporting]`, `[_Merge]`, `[_Alsim]`

The `_` prefix signals an ESS-owned product. Use the full product name exactly — no abbreviations.

**Customers and partners:**
`[ABB]`, `[AUD]`, `[BMW]`, `[CEE]`, `[EBZ]`, `[GM]`, `[INE]`, `[JLR]`, `[MRC]`, `[MTS]`, `[SKD]`, `[SLT]`

**Events:**
`[P-EXP]`, `[PS30]`, `[ICS]`, `[SRC]`, `[SAE]`

---

## Versioning

Version numbers follow immediately after the last bracket group:

```text
[_Dip Paint][SAL][DK]v3-0-5.pptx
[ESS][SAL][DK][Main Company Introduction]v2-3-14.pptx
```

**Format:** `vMAJOR-MINOR-PATCH` using hyphens (not dots).

| Segment | Changes when…                               |
| ------- | ------------------------------------------- |
| MAJOR   | Complete redesign or structural overhaul    |
| MINOR   | New sections, significant content additions |
| PATCH   | Copy edits, tweaks, small visual fixes      |

The version is displayed on the cover slide. The matching `-thumb.webp` is a screenshot of the cover. Both the main file and its thumbnail always share the same version string and are renamed as a pair.

---

## Export filenames (SharePoint & OneDrive)

When files are exported, shortcodes are **automatically translated to full human-readable names**:

```text
[_Sealing][SAL][DK]v1-2-1.pptx               →  Sealing Sales Slide Deck v1-2-1.pptx
[ESS][SAL][DK][Main Company]v2-0-0.pptx       →  ESS Sales Slide Deck — Main Company v2-0-0.pptx
[BMW][ABM][DK]v3-1-0.pptx                     →  BMW Account-Based Slide Deck v3-1-0.pptx
```

---

## Workflow subfolders

| Folder     | Stage                       | Notes                                                             |
| ---------- | --------------------------- | ----------------------------------------------------------------- |
| `[01] IN`  | Source / input files        | Originals, client files, raw imports                              |
| `[02] WRK` | Work in progress            | Active edits, iterations                                          |
| `[03] OUT` | Published / deployed assets | **Only files here get deployed to Obsidian, Dropbox, SharePoint** |

---

## Examples

```text
[_Rinsing][SAL][DK]v2-0-1.pptx
[_Dip Paint][SAL][DK]v3-0-5.pptx
[_Waxing][SAL][DK][Flood Control]v3-1-13.pptx
[BMW][ABM][DK]v1-0-0.pptx
[_Top Coating][ABM][DK][China Bumpers]v1-0-0.pptx
[ESS][REL][DK][Highlights]v3-2-2.pptx
[P-EXP][EVT][PRT][Booth Design]v1-0-0.pdf
[ESS][SM][IMG][Happy Birthday]v1-0-0.jpg
[ESS][CRP][VID][Easy To Use]v1-0-0.mp4
```

---

## Notes for the deploy agent

- Parse filenames by extracting all leading `[…]` groups in order: Subject (tag 1), Angle (tag 2), Format (tag 3), optional Description (tag 4).
- A filename is valid if it starts with `[` and contains at least three bracket groups.
- Subject type: first character `_` = ESS product, `ESS` = company-wide, otherwise = customer/partner/event code.
- Version string: first token after all bracket groups matching `v\d+-\d+-\d+` (no space required before `v`).
- The canonical vocabulary is in `naming_convention.json`.
