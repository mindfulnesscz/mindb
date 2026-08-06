# Sotto — Asset Management & Conversion TODO (2026-08-05)

Prioritized by **value ÷ effort**, structured like `SOTTO_AUDIT_TODO.md`. This is the "updated
asset management" track — start it *after* the P0/P1 security items in the audit TODO.

Decisions baked in (from David, 2026-08-05):
- **No auto-detecting wizard.** Telling galleries vs sub-assets vs assets apart from a raw tree is
  unreliable. The flow is human-in-the-loop, folder-by-folder batch, and doubles as a tidy-up pass.
- **No reversion/undo.** The operator works on a *clone* of the archive. Convert can be
  non-destructive by preference, but we don't build undo.
- **Displayable files auto-route to `OUT`; non-displayable stay out of it.** Reuse the existing
  `THUMB_EXTS` set. Ability to name an "original OUT" folder to make routing automatic.
- **Tag inference from path + file type** is the marquee feature (detailed plan in Part B).

---

## Correction to the earlier plan (you were right)

My claim "*nothing outside the app can hand it a folder*" was **wrong as worded.** Verified in
`desktop/src/components/FolderTargetPicker.tsx:21`: the app already receives OS drag-drop via
`getCurrentWebview().onDragDropEvent`, so a folder path *does* cross the Finder→app boundary today.
What it currently does with that path is narrow — it only **sets the Target Parent Folder**
(`onChange(path)` at line 40), i.e. picks *where* a new asset will be created, not *what to convert*.

The genuinely-absent piece (verified: no `deep-link` / `single-instance` / CLI plugin in
`src-tauri`) matters **only for a true Finder/Explorer right-click while the app isn't the drop
target.** For an in-app drag-to-convert, the plumbing is already here — extending the existing drop
handler from "set target" to "convert dropped folder(s)" is a small change, which makes Tier 1 below
cheaper than I first estimated.

---

# Part A — Prioritized TODO

## 🟢 Tier 1 — High value / Low effort (quick wins, do first)

- [ ] **Convert-on-drop: extend the existing drop handler to convert dropped folders.**
  Value: high · Effort: low. The drop event and folder validation already exist
  (`FolderTargetPicker.tsx:21-45`). Add a second mode: when the operator is in a "Convert" context,
  a dropped folder (or multiple) becomes the *input* to `convertSelectionToAsset` rather than the
  target. Reuses `createAssetFolder` for the actual mint. Accepts multi-select (Tauri gives
  `event.payload.paths[]`).

- [ ] **`convertSelectionToAsset(paths[], tags[], opts)` primitive.**
  Value: high · Effort: low-med. One function that wraps `createAssetFolder.ts` and: (1) derives the
  folder name from the dropped folder, (2) routes files (Tier 2 below), (3) mints identity via the
  existing single-path logic. Mode 2 (blank asset) is `paths=[]`. Keep the same partial-failure
  reporting the single-create path has (folder-made-but-draft-row-failed).

- [ ] **File-type format tag, automatic.**
  Value: high · Effort: low. From the files being converted, infer the **format**-slot tag from
  extension (e.g. `.pptx`→ the client's "Deck/Presentation" format tag). Pure function in
  `@sotto/domain` (Part B §3). Only suggests tags that exist in the client vocabulary — never invents
  one (vocabulary is portal SoT).

- [ ] **Reuse `THUMB_EXTS` as the "displayable" set — no new list.**
  Value: med · Effort: trivial. `desktop/src/services/pipeline/naming.ts:49` already defines exactly
  the displayable set you described (pptx/ppt, docx/doc, xlsx/xls, pdf, png/jpg/jpeg/webp/gif/tif/
  tiff). Import it for OUT-routing so there's one source of truth. `.ai/.psd/.indd/.sketch/.fig/.eps`
  fall outside it → they go to WRK, exactly as you want.

## 🔵 Tier 2 — High value / Medium effort

- [ ] **Smart file routing on convert (displayable → OUT, rest → WRK).**
  Value: high · Effort: med. When converting a folder: files whose ext ∈ `THUMB_EXTS` copy into
  `OUT`; everything else into `WRK`. The reserved `c1` placeholder is created **only if OUT ends up
  empty** (otherwise the first displayable file becomes the real primary and claims c1 via the
  existing `versionLineageChildId` placeholder-claim path — `manifest.ts:64-80`). Copy, don't move,
  by default (operator is on a clone anyway).

- [ ] **"Original OUT" folder mapping.**
  Value: high · Effort: med. Per-conversion (with a per-client default) setting: if the source folder
  contains a subfolder matching a configured name list (`OUT`, `Final`, `Deliverables`, `Export`,
  `Hi-Res`…), treat *its* displayable contents as the deliverables → `OUT`, and everything else →
  `WRK`. This is what makes routing automatic for agencies that already have a deliverables
  convention. Falls back to the ext filter when no such folder exists.

- [ ] **Tag inference from folder path → pre-filled suggestions.**
  Value: very high · Effort: med. The marquee feature. Full design in **Part B**. Pure `@sotto/domain`
  module, so it's shared by the convert flow *and* the existing Vocabulary "create new asset" screen.

- [ ] **Tag quick-add UI with inferred suggestions pre-selected.**
  Value: high · Effort: med. A compact tag picker (grouped by entity/angle/format) that opens on
  convert, pre-checks high-confidence inferred tags, and shows "maybe" ones dimmed. Operator confirms
  in one glance instead of typing. Reuses the vocabulary the client already has cached.

- [ ] **Batch convert with a review sheet.**
  Value: high · Effort: med. Drop N folders → a table: folder name → proposed asset name, routed
  file counts (OUT/WRK), inferred tags per slot, editable inline, with a per-row "skip." One
  "Convert all" runs them through `convertSelectionToAsset` and reports which got DB rows. This is
  the folder-by-folder-batch loop you described, made into one screen.

## 🟣 Tier 3 — High value / Higher effort

- [ ] **Finder/Explorer right-click "Convert to Sotto asset" (true OS context menu).**
  Value: high · Effort: high (per-OS). Needs the enabling hook first: add Tauri `deep-link` +
  `single-instance`, register a `sotto://convert?paths=…` scheme, and open the batch review sheet
  pre-filled. Then thin per-OS registration — macOS Quick Action (cheapest), Windows shell entry,
  Linux file-manager scripts — all routed through the one `sotto://` entry point. Requires the app
  running + signed in; queue a message if not. Do this *after* Tiers 1-2 prove the flow in-app.

- [ ] **Path-based tag suggestions on the *existing* "create new asset" screen.**
  Value: high · Effort: low *once Part B exists*. Your point about new-asset creation: as the
  operator picks the target/types a name, run the same `inferTagsFromPath` over the chosen path and
  pre-suggest tags from the pool. Free feature once the domain module is built — just wire it into
  `GeneratorView`/vocabulary create.

## ⚪ Tier 4 — Defer / nice-to-have

- [ ] Watch-folder auto-adopt (a drop folder the app converts on a debounce). Nice, but the batch
  review sheet covers the same need with more control. Revisit if a client asks.
- [ ] "Create missing format/entity tag" inline during convert — skip for now: vocabulary is
  portal-managed SoT, so minting tags from the desktop reopens a sync question. Keep tag creation on
  the portal.
- [ ] Convention presets per client (map an incoming agency's own `01 IN / 02 WRK / 03 OUT`). Fold
  into the "Original OUT" mapping once that ships; generalize only if needed.

---

# Part B — Tag Inference: Implementation Plan

The whole feature is one **platform-free** module in `@sotto/domain` (no fs, no network, no React —
matches the package contract), consumed by both the convert flow and the create-new-asset screen.
That keeps one implementation, unit-tested, with zero drift between the two call sites.

## B.1 New module: `packages/domain/src/tagInference.ts`

**Public surface:**

```ts
export interface TagSuggestion {
  tag: VocabTag;
  score: number;                    // 0..1
  reason: 'label' | 'key' | 'shortcode' | 'phrase' | 'fuzzy' | 'group' | 'filetype';
  sourceToken: string;              // the path token / extension that matched
}

export interface InferenceIndex { /* precomputed lookup, built once per vocabulary */ }

export function buildInferenceIndex(vocab: VocabTag[]): InferenceIndex;

export function inferTagsFromPath(
  segments: string[],               // path segments BELOW the client source root
  index: InferenceIndex,
  opts?: { minScore?: number; maxPerSlot?: number },
): TagSuggestion[];

export function inferFormatFromExtensions(
  exts: string[],                   // e.g. ['.pptx', '.png']
  index: InferenceIndex,
): TagSuggestion[];
```

Grouping the result by `tag.slot` (entity/angle/format) for the UI is a one-liner the caller does.

## B.2 Path → tag algorithm

1. **Get the segments.** Caller passes path segments *below the client source root*, having already
   stripped: the ` __<hash>` suffix (`stableId.stripStableId`), the reserved folder names (`IN`,
   `WRK`, `OUT`, `versions`), and the file's own name for the folder case. Domain fn stays pure —
   the desktop does the fs/path work and hands in a clean `string[]`.

2. **Tokenize each segment.** Lowercase; split on ` `, `-`, `_`, `.`, `/`, and camelCase boundaries;
   also strip and separately capture bracket groups `(...)`/`[...]` (these may already be shortcodes).
   Keep both the individual tokens *and* the whole normalized segment (for multi-word phrase matches).
   Drop pure numbers, version strings (`v1-0-0`), and `YYMM` codes (reuse `parseFilename`'s regexes).

3. **Build the index once** (`buildInferenceIndex`): maps from normalized form → `VocabTag[]`, over
   four key spaces, each tagged with a base weight:
   - exact `shortcode` (already have `buildVocabMap`) → weight 1.0
   - exact `key` → 1.0
   - exact `label` (normalized) → 0.95
   - `parentGroup` (normalized) → 0.4 (suggests the group's leaves, weakly)
   Normalize = lowercase, strip punctuation, collapse whitespace, naive singular/plural fold
   (`s$`, `es$`). Precomputing this avoids re-scanning the vocab per segment.

4. **Match + score.** For each token and each whole-segment phrase:
   - exact hit in shortcode/key/label index → that weight, `reason` accordingly.
   - multi-word label fully contained in a segment → `phrase`, 0.9.
   - token is a substring of a label (or vice-versa), length ≥ 4 → `fuzzy`, 0.6.
   - Levenshtein ≤ 1 for tokens length ≥ 5 → `fuzzy`, 0.55 (guard against typos; cap cost — only
     compare against labels sharing a first letter to keep it cheap).
   - parentGroup hit → `group`, 0.4 (only surfaced if nothing stronger in that slot).
   Dedupe by `tag.key`, keeping the highest score; accumulate a small bonus (+0.05) when the same tag
   is hit by more than one segment (repetition across the path = signal).

5. **Rank & cap.** Sort by score desc; keep `score ≥ minScore` (default 0.5); cap `maxPerSlot`
   (default 3) per slot. Return flat `TagSuggestion[]`; UI groups by slot and pre-checks
   `score ≥ 0.85`, dims the rest.

**Deliberately NOT done:** never auto-commit a tag the operator can't see; never invent a tag not in
the vocabulary; never match on the hash suffix or reserved folders.

## B.3 File-type → format tag

Format tags are per-client and free-form, so do it in two layers:

1. **Built-in ext → format *concept* map** (in the module, stable):
   `.pdf`→`document`; `.doc/.docx/.docm`→`document`; `.ppt/.pptx/.pptm`→`presentation`;
   `.xls/.xlsx/.xlsm`→`spreadsheet`; `.png/.jpg/.jpeg/.webp/.gif/.tif/.tiff`→`image`;
   `.mp4/.mov/.webm`→`video`; `.ai/.eps`→`vector`; `.psd`→`raster-source`; `.indd`→`layout`.
   Each concept carries a few **aliases** (`presentation` → `["deck","slides","presentation","keynote"]`).
2. **Resolve concept → the client's actual format `VocabTag`** by matching the concept + its aliases
   against format-slot labels/keys via the same index. If the client has no matching format tag,
   return nothing for that file (don't invent). `reason:'filetype'`, score 0.8 on an alias hit, 0.9
   on an exact label hit.

This gives you "PPTX in the folder → suggest the Deck format tag" with zero per-client config, and
degrades gracefully when a client's vocabulary doesn't have a matching tag.

## B.4 Wiring (desktop side, thin)

- **Convert flow:** before opening the review sheet, for each folder call
  `inferTagsFromPath(cleanSegments, index)` + `inferFormatFromExtensions(extsInFolder, index)`, merge,
  pre-fill the tag picker. `index` built once per run from the client's cached `VocabularyData.tags`.
- **Create-new-asset screen (`GeneratorView`/vocabulary create):** on target/name change, run the
  same two calls over the chosen path and surface suggestions. This is your point 5, and it's nearly
  free once the module exists.

## B.5 Tests (pure module → easy, high-confidence)

`packages/domain/src/tagInference.test.ts`:
- exact label / key / shortcode hits per slot; case/plural folding.
- multi-word phrase inside a segment; camelCase split.
- ambiguous token appearing in two slots → suggested in both.
- same label under two parent groups → both returned, disambiguated.
- version/date/number tokens ignored; hash suffix + IN/WRK/OUT ignored.
- ext→format: exact and alias resolution; client-missing-tag → empty (no invention).
- fuzzy/typo within threshold matches; below threshold doesn't.

## B.6 Estimated size

The domain module + tests is the bulk and is self-contained (~a day). Wiring each call site is small
(reuses the existing vocabulary cache and tag picker). It's genuinely high-value because it turns tag
entry from typing into confirming, and it's the same code path for convert *and* create — so it pays
off twice.
