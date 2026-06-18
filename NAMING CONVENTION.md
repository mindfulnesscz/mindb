# ESS Marketing Materials — Naming Convention v2.0

This document is the canonical reference for naming folders and files in the ESS marketing asset library. It is written to be read by both humans and automated agents (e.g. the dc-hub deploy script).

---

## Filename pattern

```
(Entity)(Angle)(Format)Description vX-Y-Z.ext
(Entity)(Angle)(Format)(Description)vX-Y-Z.ext
```

| Part            | Required     | Rule                                                                                   |
| --------------- | ------------ | -------------------------------------------------------------------------------------- |
| `(Entity)`      | Yes          | Slot 1 — what the asset is about. See **Entity** section below.                        |
| `(Angle)`       | Yes          | Slot 2 — purpose or content type. See **Angle** table.                                 |
| `(Format)`      | Yes          | Slot 3 — what the deliverable physically is. See **Format** table.                     |
| `(Description)` | Optional     | Plain-language label — either in brackets or as a space-separated suffix before `v`.   |
| `vX-Y-Z`        | Optional     | Semantic version — e.g. `v3-0-5`. See **Versioning** section.                          |

> **Round brackets `()` only.** Square brackets `[]` are no longer used in asset filenames. They caused issues with SharePoint, OneDrive URL encoding, and shell globbing. Folder infrastructure names (`[01] IN`, `[03] OUT`, etc.) are unchanged — they are managed by the tool, not by users.

> **No dates in filenames.** The version number is the source of truth for file currency.

---

## Slot 1 — Entity

The first bracket identifies *what* or *who* the asset is about. Five subtypes, each with a clear prefix.

### Company-wide

| Shortcode | Label        | When to use                                     |
| --------- | ------------ | ----------------------------------------------- |
| `ESS`     | ESS          | Not product-specific; belongs to the ESS brand. |

### ESS products — prefix `p-`

The `p-` prefix signals an ESS-owned product or solution.

| Shortcode  | Label                   |
| ---------- | ----------------------- |
| `p-Rns`    | Rinsing                 |
| `p-DpP`    | Dip Paint               |
| `p-EtC`    | E-Coating               |
| `p-Ovn`    | Oven                    |
| `p-Sln`    | Sealing                 |
| `p-SIQ`    | SealingIQ               |
| `p-Wax`    | Waxing                  |
| `p-SpW`    | Spray Waxing            |
| `p-TpC`    | Top Coating             |
| `p-PwC`    | Powder Coating          |
| `p-And`    | Anodizing               |
| `p-Cld`    | Cloud                   |
| `p-AIQ`    | AnodeIQ                 |
| `p-BlB`    | Black Box               |
| `p-PIQ`    | PaintIQ                 |
| `p-AtR`    | Automate Reporting      |
| `p-Mrg`    | Merge                   |
| `p-Als`    | Alsim                   |
| `p-EnO`    | Encapsulated Oven       |
| `p-EnP`    | Encapsulated Paint Shop |

### Customers — prefix `c-`

| Shortcode | Label      | Shortcode | Label      |
| --------- | ---------- | --------- | ---------- |
| `c-ABB`   | ABB        | `c-JLR`   | JLR        |
| `c-AUD`   | Audi       | `c-MRC`   | MRC        |
| `c-BMW`   | BMW        | `c-MTS`   | MTS        |
| `c-CEE`   | CEE        | `c-SKD`   | Skoda      |
| `c-EBZ`   | EBZ        | `c-STE`   | Stellantis |
| `c-GM`    | GM         | `c-COA`   | COA-CFD    |
| `c-INE`   | INEOS      | `c-GUI`   | GUI        |

### External partners — prefix `x-`

The `x-` prefix signals an external partner, integrator, or collaborator that is not an ESS product and not a direct customer.

| Shortcode | Label    |
| --------- | -------- |
| `x-AuF`   | Autoform |
| `x-JJ`    | JJ       |

### Events & conferences — prefix `e-`

| Shortcode  | Label      |
| ---------- | ---------- |
| `e-PEX`    | Paint Expo |
| `e-PS30`   | PS-2030    |
| `e-PSD`    | PS-D       |
| `e-ICS`    | ICS        |
| `e-SRC`    | SRC        |
| `e-SAE`    | SAE        |
| `e-Wbn`    | Webinar    |

---

## Slot 2 — Angle

The second bracket identifies the *purpose* or *content type* of the asset.

### Sales & marketing

| Shortcode | Label          | Shortcode | Label          |
| --------- | -------------- | --------- | -------------- |
| `SAL`     | Sales          | `TST`     | Testimonial    |
| `TEC`     | Technical      | `CSS`     | Case Study     |
| `OVR`     | Overview       | `SUC`     | Success Story  |
| `BCS`     | Business Case  | `UC`      | Use Case       |
| `ABM`     | Account-Based  | `PPT`     | Pain Point     |
| `SML`     | Simulation     |           |                |

### Content type

| Shortcode | Label           | Shortcode | Label          |
| --------- | --------------- | --------- | -------------- |
| `CMP`     | Campaign        | `SUS`     | Sustainability |
| `REL`     | Product Release | `HRE`     | Hiring         |
| `SM`      | Social Media    | `ILL`     | Illustration   |
| `TRN`     | Training        | `3D`      | 3D             |

### Context

| Shortcode | Label     |
| --------- | --------- |
| `BRD`     | Brand     |
| `CRP`     | Corporate |
| `EVT`     | Event     |
| `PTN`     | Partner   |
| `ADD`     | Add-On    |

---

## Slot 3 — Format

The third bracket identifies *what the deliverable physically is*.

### Documents & presentations

| Shortcode | Label         | Icon |
| --------- | ------------- | ---- |
| `SlD`     | Slide Deck    | 🗂️  |
| `PDF`     | PDF           | 📄   |
| `Dcm`     | Word Document | 📝   |
| `1Pg`     | One-Pager     | 📋   |
| `Hnd`     | Handover      | 🤝   |
| `Mnl`     | Manual        | 📖   |
| `Art`     | Article       | ✍️   |

### Media & visual

| Shortcode | Label           | Icon |
| --------- | --------------- | ---- |
| `Vid`     | Video           | 🎬   |
| `Img`     | Static Image    | 🖼️  |
| `Crs`     | Carousel        | 🎠   |
| `Bnn`     | Banner          |      |
| `Prn`     | Print           | 🖨️  |
| `Web`     | Web Asset       | 🌐   |
| `Gdy`     | Goodie          | 🎁   |
| `PrP`     | Profile Picture |      |
| `Gll`     | Gallery         | 🖼️  |

### Image background variants

Used as the format tag when the asset is an image delivered in multiple background variants.

| Shortcode | Label              |
| --------- | ------------------ |
| `WhtB`    | White Background   |
| `GryB`    | Gray Background    |
| `TrpB`    | Transparent Background |

---

## Versioning

Version numbers follow immediately after the last bracket group (or description):

```
(p-Sln)(SAL)(SlD)v3-0-5.pptx
(ESS)(SAL)(SlD)(Main Company Introduction)v2-3-14.pptx
```

**Format:** `vMAJOR-MINOR-PATCH` using hyphens (not dots).

| Segment | Changes when…                               |
| ------- | ------------------------------------------- |
| MAJOR   | Complete redesign or structural overhaul    |
| MINOR   | New sections, significant content additions |
| PATCH   | Copy edits, tweaks, small visual fixes      |

The version is displayed on the cover slide. The matching `-thumb.webp` thumbnail always shares the same version string and is renamed as a pair.

---

## Export filenames (SharePoint & OneDrive)

When files are deployed, shortcodes are automatically translated to full human-readable names:

```
(p-Sln)(SAL)(SlD)v1-2-1.pptx                      →  Sealing Sales Slide Deck v1-2-1.pptx
(ESS)(SAL)(SlD)(Main Company)v2-0-0.pptx           →  ESS Sales Slide Deck — Main Company v2-0-0.pptx
(c-BMW)(ABM)(SlD)v3-1-0.pptx                       →  BMW Account-Based Slide Deck v3-1-0.pptx
(e-PEX)(EVT)(Prn)(Booth Design)v1-0-0.pdf          →  Paint Expo Event Print — Booth Design v1-0-0.pdf
(ESS)(SM)(Img)(Happy Birthday)v1-0-0.jpg           →  ESS Social Media Static Image — Happy Birthday v1-0-0.jpg
```

---

## How to add a new tag

1. Open `vocabulary.json`.
2. Add a new entry under `"tags"`.
3. Choose the correct `"slot"` (`entity`, `angle`, or `format`).
4. Choose the correct `"subtype"`:
   - Entity: `company`, `product`, `customer`, `partner`, or `event`
   - Angle: `sales-mktg`, `content`, or `context`
   - Format: `document`, `media`, or `image-var`
5. Apply the correct **shortcode prefix**:

   | What you're adding | Prefix | Example |
   | ------------------ | ------ | ------- |
   | New ESS product    | `p-`   | `p-New` |
   | New customer       | `c-`   | `c-VWG` |
   | New partner        | `x-`   | `x-Xyz` |
   | New event          | `e-`   | `e-ABC` |
   | Angle or Format    | none   | `SAL`, `SlD` |

6. Use `CamelCase` for the shortcode body (3–5 characters is ideal).
7. Update this document's tables to match.

**Never use** `_`, `±`, `~`, `=` prefixes — those were legacy and are now mapped via `legacy_aliases` in `vocabulary.json`.

---

## Workflow subfolders

| Folder     | Stage                       | Notes                                                             |
| ---------- | --------------------------- | ----------------------------------------------------------------- |
| `[01] IN`  | Source / input files        | Originals, client files, raw imports                              |
| `[02] WRK` | Work in progress            | Active edits, iterations                                          |
| `[03] OUT` | Published / deployed assets | **Only files here get deployed to Obsidian, Dropbox, SharePoint** |

---

## Examples

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

---

## Notes for the deploy agent

- Parse filenames by extracting all leading `(…)` groups in order: Entity (tag 1), Angle (tag 2), Format (tag 3), optional Description (tag 4).
- Also accept `[…]` groups for backward compatibility with files not yet renamed.
- A filename is valid if it starts with `(` or `[` and contains at least three tag groups.
- Resolve unknown shortcodes against `legacy_aliases` in `vocabulary.json` before flagging as unknown.
- Entity subtype: first character `p` + `-` = ESS product, `c` + `-` = customer, `x` + `-` = partner, `e` + `-` = event, `ESS` = company-wide.
- Version string: first token after all bracket groups matching `v\d+(-\d+)*` (no space required before `v`).
- The canonical vocabulary is `vocabulary.json` next to `app.py`.
