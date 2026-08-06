# 00c — OUT folder hygiene: assets only in destinations, one `thumbnails/` folder, hidden manifests

Prepend the **SHARED CONTEXT block** from `DONE_01_security-hardening-S0-S7.md`.

**C1, C2 and C3 are LANDED** in 3.2.2 (commit `affecad`), in one change, with `lint`, `typecheck`,
`test:packages`, `test:desktop`, `test:rust`, `lint:rust`, `build:desktop` and `build:docs` green.

**The premise below was wrong on one point, and it is the interesting one.** This brief opens "nothing
here is a crash or a leak". C1's reproduce step found a leak: in the `folders` publish layout,
`publishDir` applied its artifact filter to files but recursed into **every** subdirectory
unconditionally, so a `<stem>-thumb/` previews folder was descended into and its `001.webp`,
`002.webp` … copied into the client's target as deliverables. The page files are the one artifact
with no marker in their names — which is why a filename filter never caught them and nothing
downstream did either. Fixed by applying the exclusion to the directory entry *before* the descent.
Targets published by an earlier build keep the stale folder until the next publish reconciles it.

**Known gap, accepted:** hiding a manifest means a leading dot, which Windows does not honour.
`FILE_ATTRIBUTE_HIDDEN` is not set — Sotto ships macOS only (`release-desktop.yml` builds one macOS
bundle) and has no Windows CI, so the call would be code no build here can compile or exercise. The
one place to add it is documented above `manifest_path` in `render.rs`.

_Filed and revised 2026-08-06; closed 2026-08-07. Target layout below is approved — earlier framings
in this file's history (hide the thumbnails; defer the shared folder) are superseded._

---

## The one rule

> A `thumbnails/` folder sits **beside the files it serves** — never nested per asset, never named
> per asset.

So it lands in `OUT/` for files directly under OUT, and inside the gallery folder for gallery
children. Thumbnails stay **visible** (they are useful in the source folder); only the `.json`
render caches hide. The folder is excluded from every export destination (C1).

Grouping vocabulary is `groupAssets` (`packages/domain/src/assetGrouping.ts:46`): a file directly
under OUT (`relative.length === 1`) is a **single**; a file in a subfolder is a **gallery** child,
named by the directory path.

### 1 · Single asset — one image in OUT

```
Chair __a1b2c3d4/                 Chair __a1b2c3d4/
└── OUT/                          └── OUT/
    ├── Chair-front-v1.jpg            ├── Chair-front-v1.jpg
    ├── Chair-front-v1-thumb.webp     └── thumbnails/
    └── …-thumb.webp.json                 ├── Chair-front-v1-thumb.webp
                                          └── .Chair-front-v1-thumb.webp.json
        3 visible  ->  2 visible
```

### 2 · Multi-asset — several files in OUT

Each file is its own child asset (`c1`, `c2`, `c3`); all are singles to `groupAssets`. This is where
loose thumbnails multiply fastest.

```
└── OUT/                          └── OUT/
    ├── Chair-front-v1.jpg            ├── Chair-front-v1.jpg
    ├── Chair-front-v1-thumb.webp     ├── Chair-side-v1.jpg
    ├── …-thumb.webp.json             ├── Chair-detail-v1.jpg
    ├── Chair-side-v1.jpg             └── thumbnails/
    ├── Chair-side-v1-thumb.webp          ├── Chair-front-v1-thumb.webp
    ├── …-thumb.webp.json                 ├── Chair-side-v1-thumb.webp
    ├── Chair-detail-v1.jpg               ├── Chair-detail-v1-thumb.webp
    ├── Chair-detail-v1-thumb.webp        └── .*-thumb.webp.json  x3
    └── …-thumb.webp.json
        9 visible  ->  4 visible
```

### 3 · Gallery — a subfolder under OUT, with a document

The document case is the worst today: a title thumbnail **and** a previews folder per deck.

```
└── OUT/                          └── OUT/
    └── Selected/                     └── Selected/
        ├── Deck-v2.pptx                  ├── Deck-v2.pptx
        ├── Deck-v2-thumb.webp            ├── Hero-v1.jpg
        ├── …-thumb.webp.json             └── thumbnails/
        ├── Deck-v2-thumb/                    ├── Deck-v2-thumb.webp   <- title slide
        │   ├── 001.webp                      ├── Hero-v1-thumb.webp
        │   ├── 002.webp                      ├── .Deck-v2-thumb.webp.json
        │   └── pages.json                    ├── .Hero-v1-thumb.webp.json
        ├── Hero-v1.jpg                       └── Deck-v2/            <- page previews
        ├── Hero-v1-thumb.webp                    ├── 001.webp
        └── …-thumb.webp.json                     ├── 002.webp
                                                  └── .pages.json
        7 visible  ->  3 visible
```

### Three things this layout asserts

- **The title slide joins the other thumbnails**, rather than living in its own per-document folder.
  Page previews keep a subfolder because they are a set — but it sits inside `thumbnails/`.
- **No special case for the single-asset package.** One image still gets a `thumbnails/` folder. It
  saves only one visible entry there, but a rule with exceptions is exactly what makes the ~8
  artifact-detection call sites hard to change safely.
- **`-thumb` stays in the filenames** even though location becomes authoritative. It keeps every
  legacy substring filter working as a safety net through the migration. Dropping it is a separate,
  later decision — do not bundle it in.

---

## Correction: the CDN does not care where these files live locally

An earlier draft flagged the CDN prune as a blocker on moving artifacts, assuming object keys derive
from local paths. **They do not.** `cdnUpload.ts:4`, verbatim:

> Keys are built from folder identity (stable_id/child_id), never from the filename, so renaming a
> [file does not change the key].

Confirmed at `cdnUpload.ts:245-246,279-282` — `storageTarget(level, clientId, 'thumbnails',
stableId, childId, '.webp')`. Moving a local artifact changes **no** object key, orphans **nothing**,
and does not interact with the prune guard. This is what makes C3 affordable.

The only local-path dependencies are two *constructed* read paths — `cdnUpload.ts:213` and `:418`
build `${dir}${stem}-thumb.webp` and `${dir}${stem}-thumb`. Construction, not discovery, so they
follow the layout in a two-line change.

---

## C1. Destinations receive assets only — DO THIS FIRST

**Intent:** render artifacts belong beside the source (as the cache) and on the CDN (as what the
portal serves). A client destination gets assets. Never a thumbnail, a previews folder, or a manifest.

**State of the code — read before assuming it's broken.** The exclusion already exists in every path
traced, as an ad-hoc `name.includes('-thumb')` test: `scan.ts:50,104,152`; `publishLocal.ts:309,323`;
`packages.ts:119,127,183,189,207`; `fs.ts:52` via `isPreviewArtifact`. `cloudExport.ts` has **no test
of its own** — it is clean only because `collectedAssets` is already scan-filtered.

**Do:**

1. **Reproduce first.** Export to a cloud destination and a local destination; record exactly which
   artifacts arrive. Do not change filters before knowing which path leaks.
2. **One predicate at the export boundary.** The rule is duplicated in ~8 places, which is how a path
   ends up missing it. Make `isPreviewArtifact` (`packages/domain/src/naming.ts:76`) the single gate
   every destination writer passes through, and have `cloudExport` apply it explicitly rather than
   trusting its caller.
3. **Test at the boundary**, not per-call-site: a writer handed a directory containing every artifact
   type emits assets only. Written this way the test survives C3; a `-thumb` assertion would not.

**Decide:** whether `.dchub.json` travels with a delivered asset. It probably should not.

C1's boundary test is the safety net for C3's predicate change. Land it first.

## C2. Hide the manifests — and only the manifests

The `.json` sidecars are render caches, not metadata. `render.rs:681` writes one per thumbnail
holding the source's size+mtime and the width/quality it was rendered at; `pages.json` does the same
for document previews plus page count and limit. They are the only way to know a render is stale — a
directory listing cannot see that the source changed or that the page limit changed. **Delete them
and every run re-renders the library** (~6.4s per Office document). They stay; they stop being visible.

**Do:**

- Dot-prefix the manifests only: `<name>.webp.json` -> `.<name>.webp.json` (`render.rs:681`), and
  `pages.json` -> `.pages.json` (`render.rs:647`). **Thumbnails and previews keep visible names.**
- **Windows does not hide dot-prefixed files** — it uses `FILE_ATTRIBUTE_HIDDEN`. Set it via
  `SetFileAttributesW` when writing on Windows, or the change is macOS/Linux only. Decide explicitly.
- Migration is an in-place rename; the manifest travels with the artifact, so nothing re-renders.
- The scan already skips dotfiles (`scan.ts:50,152`) and `requireLiteralLeadingDot: false` is already
  set in `tauri.conf.json` -> `plugins.fs` for `.dchub.json`, so globs already match dotfiles.

**Explicitly NOT consolidating the manifests.** The pipeline renders 8-at-a-time; eight workers
writing one shared manifest is last-writer-wins, and a corrupt write would invalidate a whole
gallery's cache instead of one thumbnail. Once hidden, the file count costs nothing.

## C3. Move every render artifact into `thumbnails/`

**Do:**

- Write thumbnails to `<dir>/thumbnails/<stem>-thumb.webp` and page previews to
  `<dir>/thumbnails/<stem>/`, where `<dir>` is the folder holding the assets — `OUT/` for singles,
  the gallery folder for gallery children.
- **Convert `isPreviewArtifact` from a name test to a location test**, and change all call sites in
  one commit with C1's boundary test already green. Miss one and either junk ships to a client or a
  real asset is skipped as an artifact. The sites are enumerated in C1.
- **Rewrite `validate_preview_area` (`render.rs:204-226`).** Highest-risk edit in the file. It is not
  a naming convention — it is the guard in front of `remove_dir_all`, and CLAUDE.md requires it in
  both the Tauri command and the one-shot PDFium worker. The previews root is no longer a computed
  sibling of the source, so the check becomes: canonicalise, assert the target is inside that
  folder's own `thumbnails/`, refuse everything else. **Keep it computed and strict — never
  caller-supplied, never relaxed.**
- Update the two constructed read paths at `cdnUpload.ts:213,418`.
- **Migration:** on encountering the old layout, move the artifacts into `thumbnails/`. No re-render
  (manifests travel), no CDN traffic (keys are identity-derived). Route the move through the existing
  guardrail rather than a bare rename loop.
- `thumbnails/` is visible, so C1's exclusion must cover it **by location** — re-verify a destination
  export after the move, not just before.

---

## Definition of done

- A cloud destination and a local destination each receive **assets only** — no thumbnail, no
  previews folder, no manifest — proven by one boundary test that does not assert on `-thumb` naming,
  and re-run after C3 lands.
- `cloudExport` filters explicitly rather than inheriting a filtered list.
- Each of the three shapes above matches its target tree: single, multi-asset, gallery.
- The document title thumbnail sits in `thumbnails/` alongside every other thumbnail.
- Manifests are hidden on macOS/Linux; the Windows hidden attribute is set or the gap is documented.
- `validate_preview_area` refuses any path outside that folder's own `thumbnails/`, still runs in
  both the command and the worker, with a test proving it against the new layout.
- An existing library migrates with **no** re-render and no CDN traffic.
- Docs updated: `docs/pages/desktop/thumbnails.mdx` (the `-thumb` sidecar contract changes here),
  `docs/pages/desktop/naming.mdx`, CLAUDE.md.
- `npm run check` green.
