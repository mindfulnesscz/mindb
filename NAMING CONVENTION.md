# ESS Marketing Materials -- Naming Convention v2.1

This document is the canonical reference for naming folders and files in the ESS
marketing asset library. It is written to be read by both humans and automated
agents (e.g. the dc-hub deploy script).

---

## Filename pattern

```
(Tag)(Tag)...(Tag) Description vX-Y-Z.ext
```

A filename is a sequence of one or more bracket tags followed by an optional
plain-language description and an optional version number.

| Part | Required | Rule |
| --- | --- | --- |
| `(Tag)` | At least one | Any shortcode from the vocabulary. Repeat as needed. |
| `Description` | Optional | Plain-language label after the last bracket. Written without brackets. Keep it short and human-scannable. |
| `vX-Y-Z` | Optional | Semantic version -- see **Versioning** section. |

> **Description brackets are optional legacy.** Both `(ESS)(SAL)(SlD) Main Introduction v2-0-0.pptx` and `(ESS)(SAL)(SlD)(Main Introduction)v2-0-0.pptx` parse identically. New files should use the space-separated form without brackets.

> **Round brackets `()` only.** Square brackets `[]` are parsed as a legacy alias
> for files not yet renamed, but all new files must use `()`.

> **No dates in filenames.** Version number is the source of truth for file currency.

---

## Tag dimensions

Every shortcode belongs to one of three dimensions. Each dimension answers a
different question about the asset. You can use **any number of tags from any
dimension** -- there is no enforced limit of one per dimension.

### Dimension 1 -- Entity: *who or what is this about?*

Identifies the subject(s) of the asset: products, customers, partners, events,
or the company as a whole. Use multiple entity tags whenever an asset covers
more than one subject.

```
(p-Sln)(p-EtC)(SAL)(SlD)v1-0-0.pptx    -- covers both Sealing and E-Coating
(c-BMW)(c-AUD)(ABM)(SlD)v1-0-0.pptx    -- account deck for BMW and Audi
(e-PEX)(p-Sln)(EVT)(Bnn)v1-0-0.pdf     -- Paint Expo banner, Sealing topic
```

**Shortcode prefix rules for Entity tags:**

| Prefix | Subtype | Example |
| --- | --- | --- |
| `ESS` | Company-wide (no prefix) | `ESS` |
| `p-` | ESS product | `p-Sln`, `p-EtC` |
| `c-` | Customer | `c-BMW`, `c-AUD` |
| `x-` | External partner | `x-AuF`, `x-JJ` |
| `e-` | Event / conference | `e-PEX`, `e-Wbn` |

**ESS products**

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

**Customers**

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

**External partners**

| Shortcode | Label |
| --- | --- |
| `x-AuF` | Autoform |
| `x-JJ` | JJ |

**Events & conferences**

| Shortcode | Label | Shortcode | Label |
| --- | --- | --- | --- |
| `e-PEX` | Paint Expo | `e-SRC` | SRC |
| `e-PS30` | PS-2030 | `e-SAE` | SAE |
| `e-PSD` | PS-D | `e-Wbn` | Webinar |
| `e-ICS` | ICS | | |

---

### Dimension 2 -- Angle: *what is the purpose?*

Identifies the content type or intent of the asset.

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

### Dimension 3 -- Format: *what does the asset physically look like?*

Identifies the deliverable type. Format tags carry **inherited Obsidian tags** --
a more specific format automatically implies its broader category in the DAM,
so you never need to add a redundant tag.

**Documents & presentations**

| Shortcode | Label | Obsidian tags |
| --- | --- | --- |
| `SlD` | Slide Deck | `#deck` `#document` |
| `PDF` | PDF | `#pdf` `#document` |
| `Dcm` | Word Document | `#doc` `#document` |
| `1Pg` | One-Pager | `#onepager` `#document` |
| `Hnd` | Handover | `#handover` `#document` |
| `Mnl` | Manual | `#manual` `#document` |
| `Art` | Article | `#article` `#document` |

**Print & physical**

| Shortcode | Label | Obsidian tags |
| --- | --- | --- |
| `Prn` | Print | `#print` |
| `Bnn` | Banner | `#banner` `#print` |
| `Gdy` | Goodie | `#goodie` `#print` |

**Video & motion**

| Shortcode | Label | Obsidian tags |
| --- | --- | --- |
| `Vid` | Video | `#video` |

**Digital & social**

| Shortcode | Label | Obsidian tags |
| --- | --- | --- |
| `Crs` | Carousel | `#carousel` `#social-media` |
| `Web` | Web Asset | `#web` |
| `PrP` | Profile Picture | `#profile-picture` `#social-media` |

**Images**

| Shortcode | Label | Obsidian tags |
| --- | --- | --- |
| `Img` | Static Image | `#image` |
| `Gll` | Gallery | `#gallery` `#image` |
| `WhtB` | White Background | `#white-bkg` `#image` |
| `GryB` | Gray Background | `#gray-bkg` `#image` |
| `TrpB` | Transparent Bkg | `#transp-bkg` `#image` |

**Tag inheritance example:** `(e-PEX)(p-Sln)(EVT)(Bnn)v1-0-0.pdf`
generates: `#paint-expo #sealing #event #banner #print #dam`
You can now filter `#print` to find ALL print materials, or `#banner` for
just banners, without ever writing `(Prn)(Bnn)` in the filename.

---

## Versioning

```
(p-Sln)(SAL)(SlD)v3-0-5.pptx
(ESS)(SAL)(SlD)(Main Company Introduction)v2-3-14.pptx
```

Format: `vMAJOR-MINOR-PATCH` using hyphens (not dots).

| Segment | Changes when... |
| --- | --- |
| MAJOR | Complete redesign or structural overhaul |
| MINOR | New sections, significant content additions |
| PATCH | Copy edits, tweaks, small visual fixes |

The version is displayed on the cover slide. The matching `-thumb.webp` thumbnail
always shares the same version string and is renamed as a pair.

---

## Export filenames (SharePoint & OneDrive)

Shortcodes are automatically translated to human-readable names on deploy:

```
(p-Sln)(SAL)(SlD)v1-2-1.pptx                    ->  Sealing Sales Slide Deck v1-2-1.pptx
(ESS)(SAL)(SlD)(Main Company)v2-0-0.pptx         ->  ESS Sales Slide Deck -- Main Company v2-0-0.pptx
(c-BMW)(ABM)(SlD)v3-1-0.pptx                     ->  BMW Account-Based Slide Deck v3-1-0.pptx
(e-PEX)(p-Sln)(EVT)(Bnn)(Booth)v1-0-0.pdf        ->  Paint Expo Sealing Event Banner -- Booth v1-0-0.pdf
(p-Sln)(p-EtC)(OVR)(SlD)v2-0-0.pptx             ->  Sealing E-Coating Overview Slide Deck v2-0-0.pptx
```

---

## How to add a new tag

1. Open `vocabulary.json`.
2. Add a new entry to the `"tags"` array.
3. Set `"slot"` to `entity`, `angle`, or `format`.
4. Set `"subtype"` to the appropriate sub-group (see existing entries).
5. Apply the correct shortcode prefix for Entity tags (see table above).
   Angle and Format tags use plain CamelCase with no prefix.
6. Set `"obsidian_tag"` to one or more space-separated Obsidian tag names.
   The first should be the most specific; any that follow are inherited
   broader categories. Example: `"brochure print"` generates both `#brochure`
   and `#print` on every note that uses this tag.
7. Add the matching row to this document.

**Never use** `_`, `+-`, `~`, `=` prefixes -- those are legacy and are silently
remapped via `legacy_aliases` in `vocabulary.json`.

---

## Workflow subfolders

| Folder | Stage | Notes |
| --- | --- | --- |
| `[01] IN` | Source / input files | Originals, client files, raw imports |
| `[02] WRK` | Work in progress | Active edits, iterations |
| `[03] OUT` | Published / deployed assets | **Only files here get deployed** |

---

## Examples

```
(p-Rns)(SAL)(SlD)v2-0-1.pptx
(p-DpP)(SAL)(SlD)v3-0-5.pptx
(p-Wax)(SAL)(SlD)(Flood Control)v3-1-13.pptx
(c-BMW)(ABM)(SlD)v1-0-0.pptx
(p-TpC)(ABM)(SlD)(China Bumpers)v1-0-0.pptx
(ESS)(REL)(SlD)(Highlights)v3-2-2.pptx
(e-PEX)(EVT)(Bnn)(Booth Design)v1-0-0.pdf
(ESS)(SM)(Img)(Happy Birthday)v1-0-0.jpg
(ESS)(CRP)(Vid)(Easy To Use)v1-0-0.mp4
(ESS)(CMP)(Crs)(DIP Campaign)v1-0-0.jpg
(x-AuF)(PTN)(SlD)v2-1-0.pptx
(e-PEX)(p-Sln)(p-EtC)(EVT)(Bnn)v1-0-0.pdf
(p-Sln)(p-Wax)(p-DpP)(OVR)(SlD)(Three Products)v1-0-0.pptx
```

---

## Notes for the deploy agent

- Parse filenames by extracting all leading `(...)` or `[...]` groups.
- A filename is valid if it starts with a bracket group and contains at least one tag.
- There is no enforced minimum or maximum number of tags per dimension.
- Resolve unknown shortcodes against `legacy_aliases` before flagging as unknown.
- Entity subtype: prefix `p-` = product, `c-` = customer, `x-` = partner,
  `e-` = event, `ESS` = company-wide.
- `obsidian_tag` may contain space-separated values -- split on whitespace to
  get all Obsidian tags for a given shortcode.
- Version string: first token after all bracket groups matching `v\d+(-\d+)*`.
- Canonical vocabulary: `vocabulary.json` next to `app.py`.
