# Sotto — Asset Management: Delegatable Agent Prompts (2026-08-05)

Six prompts derived from `SOTTO_ASSET_MGMT_TODO.md`. Each is self-contained and sized for one agent
to read the brief, explore, and implement. **Prepend the Shared Context block to every prompt.**

## Dependency & parallelization graph

```
        ┌── Prompt A (tagInference domain module) ──┐
        │                                           │
  start ┤                                           ├──► Prompt C (Convert UI + batch sheet)
        │                                           │            │
        └── Prompt B (convert primitive + routing) ─┘            ├──► Prompt E (OS right-click)
                                                                 │
                       Prompt A ──► Prompt D (wire into create screen)
```

- **Wave 1 (parallel):** A and B — no dependency on each other.
- **Wave 2 (parallel):** C (needs A + B), D (needs A).
- **Wave 3:** E (needs C).

Give A and B to two agents at once. Merge, then run C and D. E last.

---

## ▓▓ SHARED CONTEXT (prepend to every prompt) ▓▓

> You are working in **Sotto**, a monorepo at `/Users/petrmucha/Sites/localhost/dc-hub` (v3.2.0):
> a Tauri 2 + React desktop app (`desktop/`), a React/Vite Supabase portal (`web/`), shared TS
> packages (`packages/`: domain, asset-library, auth, database), Supabase (`supabase/`), and Cloudflare
> workers (`workers/`).
>
> **The one non-negotiable — asset identity.** An asset's identity is its package folder
> `Name __<8hex>/` plus a `.dchub.json` manifest mapping filenames → stable `child_id`s. The pair
> `(stable_id, child_id)` is the permanent key for every DB row, CDN object, rating and comment.
> Identity is minted in exactly ONE place: `desktop/src/features/vocabulary/createAssetFolder.ts`
> (read its header comment). **Never mint a `stable_id`/`child_id` anywhere else, never re-implement
> the minting, never key anything on a filename.** Reuse `@sotto/domain` (`stableId.ts`) and
> `desktop/src/services/supabase/manifest.ts`. Getting this wrong reintroduces the duplicate-identity
> bug that v3.0.0 removed.
>
> **Package contract for `@sotto/domain`:** platform-free by contract — no Tauri, no Supabase, no
> React, no filesystem, no network, no `window`. Pure functions over strings/plain objects. If you
> need fs/path work, do it in the caller and pass clean data in.
>
> **Update the docs before finishing.** `docs/pages/**` is maintained and authoritative
> (`pipeline.mdx`, `desktop/*.mdx` — esp. `identity.mdx`, `naming.mdx`, `scanning.mdx` —
> `data-model/*.mdx`, `getting-started/*.mdx`). If your change adds or alters user-facing behavior
> (a new convert flow, file routing, tag inference, a right-click entry) or touches the identity /
> package-folder model, update the relevant `.mdx` in the SAME change — and add a page under
> `docs/pages/desktop/` for the new conversion feature. A change that leaves the docs contradicting
> the code is not done.
>
> **Before you finish, the code must pass** (from repo root): `npm run lint` (eslint, max-warnings 0),
> `npm run typecheck`, and the relevant tests — `npm run test:packages` for `packages/*`,
> `npm run test:desktop` for `desktop/src`. Match existing file style (no new deps unless justified).
> Work on a feature branch. Do not run any `db:reset`/destructive DB command.

---

## ▶ PROMPT A — `@sotto/domain/tagInference.ts` (pure module + tests)

**Goal:** a platform-free module that suggests taxonomy tags from a folder path and from file
extensions, so tag entry becomes confirming instead of typing. Consumed later by both the convert
flow and the existing create-asset screen.

**Read first:** `packages/domain/src/vocabulary.ts` (the `VocabTag { shortcode, slot:'entity'|
'angle'|'format', parentGroup, label, key, icon }` type, `buildVocabMap`), `packages/domain/src/
filenameTranslator.ts` (reuse its version/`YYMM` regexes so those tokens are ignored),
`packages/domain/src/stableId.ts` (`stripStableId`), and `packages/domain/src/index.ts` (barrel).

**Build** `packages/domain/src/tagInference.ts` exporting:
```ts
export interface TagSuggestion { tag: VocabTag; score: number;
  reason: 'label'|'key'|'shortcode'|'phrase'|'fuzzy'|'group'|'filetype'; sourceToken: string; }
export interface InferenceIndex { /* opaque precomputed lookup */ }
export function buildInferenceIndex(vocab: VocabTag[]): InferenceIndex;
export function inferTagsFromPath(segments: string[], index: InferenceIndex,
  opts?: { minScore?: number; maxPerSlot?: number }): TagSuggestion[];
export function inferFormatFromExtensions(exts: string[], index: InferenceIndex): TagSuggestion[];
```

**Algorithm (path → tags):** caller passes path segments already cleaned of the ` __<hash>` suffix,
the reserved folder names (`IN`,`WRK`,`OUT`,`versions`), and the client root. Tokenize each segment
(lowercase; split on space `-` `_` `.` `/` and camelCase; capture bracket groups; drop pure numbers,
version strings, `YYMM`). `buildInferenceIndex` maps normalized forms → `VocabTag[]` over: exact
shortcode (weight 1.0), exact key (1.0), exact label (0.95), parentGroup (0.4); normalize =
lowercase + strip punctuation + collapse whitespace + naive plural fold (`s$`/`es$`). Score each
token/whole-segment: exact index hit → its weight; multi-word label contained in a segment →
`phrase` 0.9; substring either direction, len ≥ 4 → `fuzzy` 0.6; Levenshtein ≤ 1 for len ≥ 5 →
`fuzzy` 0.55 (only compare against labels sharing a first letter, to keep it cheap); parentGroup hit
→ `group` 0.4. Dedupe by `tag.key` keeping the max; +0.05 when hit by more than one segment. Filter
`score ≥ minScore` (default 0.5), cap `maxPerSlot` (default 3) per slot.

**Algorithm (ext → format):** built-in ext→concept map (`.pdf/.doc*`→document, `.ppt*`→presentation,
`.xls*`→spreadsheet, rasters→image, `.mp4/.mov/.webm`→video, `.ai/.eps`→vector, `.psd`→raster-source,
`.indd`→layout), each concept with a few aliases; resolve concept+aliases against format-slot
labels/keys via the index; alias hit → 0.8, exact label → 0.9, `reason:'filetype'`. If the client has
no matching format tag, return nothing — **never invent a tag not in the vocabulary.**

**Constraints:** pure module (no fs/network/React). Never auto-commit anything (this only *suggests*).
Never match on the hash suffix or reserved folders. Export from the barrel (`index.ts`).

**Definition of done:** `packages/domain/src/tagInference.test.ts` covering: exact label/key/shortcode
per slot; case + plural folding; multi-word phrase; camelCase split; ambiguous token in two slots
(returned in both); same label under two parent groups (both, disambiguated); version/date/number/hash
/reserved-folder tokens ignored; ext→format exact + alias; client-missing-format-tag → empty; fuzzy
within threshold matches and below doesn't. `npm run test:packages`, `npm run typecheck`, `npm run
lint` green.

---

## ▶ PROMPT B — `convertSelectionToAsset` primitive + smart file routing (desktop service)

**Goal:** the reusable engine that turns a selected folder (or an empty selection = blank asset) into
a Sotto asset package, routing displayable files to `OUT` and the rest to `WRK`, minting identity via
the existing sanctioned path. Batch-capable with per-item partial-failure reporting. No UI.

**Read first:** `desktop/src/features/vocabulary/createAssetFolder.ts` (the ONLY sanctioned mint — you
wrap it, you do not replace it), `desktop/src/services/pipeline/naming.ts` (reuse the exported
`THUMB_EXTS` set — that *is* the "displayable" set; do not define a new list), `desktop/src/services/
supabase/manifest.ts` (`versionLineageChildId` and how the extensionless placeholder reserves `c1`),
and how `useAssetGenerator.ts` currently calls `createAssetFolder`.

**Build** a new service (suggested `desktop/src/services/convert/convertSelectionToAsset.ts`):
```ts
interface ConvertOptions {
  originalOutNames?: string[];   // e.g. ['OUT','Final','Deliverables','Export','Hi-Res']
  move?: boolean;                // default false = copy (operator works on a clone)
}
interface ConvertInput { sourcePaths: string[]; folderName: string; targetFolder: string;
  selectedTags: VocabTag[]; description: string; version: VersionState;
  clientId: string; config: { url:string; anonKey:string }; opts?: ConvertOptions; }
export async function convertSelectionToAsset(input: ConvertInput): Promise<{ packageDir:string;
  stableId:string; routed:{ out:string[]; wrk:string[] } }>;
export async function convertBatch(inputs: ConvertInput[]): Promise<Array<{ ok:boolean;
  input: ConvertInput; result?: ...; error?: string }>>;   // never throws; per-item results
```

**Behaviour:**
- **File routing.** For a source folder: if it contains a subfolder whose name matches
  `opts.originalOutNames` (case-insensitive), route *that* subfolder's displayable files → `OUT` and
  everything else → `WRK`. Otherwise route by extension: `ext ∈ THUMB_EXTS` → `OUT`, else → `WRK`.
  Copy by default (`move:false`). Preserve subfolder structure under `WRK`; flatten deliverables into
  `OUT` (matches the pipeline's OUT model).
- **Placeholder rule.** Seed the reserved-`c1` extensionless placeholder **only if `OUT` ends up
  empty** (blank asset / no displayable files). If a real displayable file lands in `OUT`, it becomes
  the primary and claims `c1` through the existing placeholder-claim path — do NOT also write a
  competing placeholder.
- **Identity + draft row** come from `createAssetFolder`'s logic. Reuse it; if the current signature
  doesn't fit routing, refactor its body into a shared helper both call (keep ONE implementation).
- **Partial failure.** Mirror `createAssetFolder`'s existing contract: folder-created-but-Supabase-
  draft-failed must be reported per item so a retry doesn't create a second folder for one asset.
  `convertBatch` collects per-item results and never throws.

**Constraints:** must require an active signed-in client (Supabase url+anonKey+clientId) — the
collision check (`fetchExistingStableIds`) and draft row need it; surface a clear error if absent.
Sanitize folder names (no parentheses — see `appendStableId`) and never let a tag label with `/`,
`\`, `..` become a path segment.

**Definition of done:** unit tests for routing (original-OUT match; ext-based fallback; empty→
placeholder; non-empty→no placeholder; `.ai`/`.psd`→WRK) and for batch partial-failure aggregation,
using mocked fs + a stubbed mint. `npm run test:desktop`, `npm run typecheck`, `npm run lint` green.

---

## ▶ PROMPT C — Convert UI: drop-to-convert + batch review sheet + tag quick-add (desktop)

**Depends on:** Prompt A (`inferTagsFromPath`/`inferFormatFromExtensions`) and Prompt B
(`convertSelectionToAsset`/`convertBatch`). Assume both exist and are exported.

**Goal:** the operator drops one or more folders onto the app and gets a review sheet with proposed
asset name, routed file counts, and pre-checked inferred tags per folder; one action converts all.

**Read first:** `desktop/src/components/FolderTargetPicker.tsx` (the existing
`getCurrentWebview().onDragDropEvent` handler — currently sets the target folder; you add a convert
mode that accepts `event.payload.paths[]`), `desktop/src/features/vocabulary/VocabularyView.tsx` +
`panels/DimColumn.tsx` (existing tag-picker UI to reuse/mirror), and the vocab cache store
(`desktop/src/store/vocabularyStore.ts` / `useVocabSync.ts`).

**Build:**
- A **convert entry** (button + a drop mode) that captures dropped folder paths. Multi-folder drop
  supported.
- A **batch review sheet**: one row per folder → editable asset name (default = folder name), routed
  OUT/WRK file counts (call B's routing preview, or a dry classify helper), and a compact tag picker
  per row grouped entity/angle/format. Build the `InferenceIndex` once from the client's cached
  vocabulary; pre-check suggestions with `score ≥ 0.85`, show the rest dimmed/toggleable. Per-row
  "skip".
- **"Convert all"** calls `convertBatch`, shows a result summary (created / draft-row-failed /
  skipped) with the same clarity the single-create flow has.
- An **"Original OUT folder" input** (comma-separated names) feeding `ConvertOptions.originalOutNames`,
  with a sensible default, persisted per client if trivial.

**Constraints:** the global window-scoped drop means only one active drop target on screen — guard so
convert-mode and target-picker-mode don't both fire (see the comment in `FolderTargetPicker`). Require
an active signed-in client before allowing convert; message clearly if not.

**Definition of done:** component/interaction tests where practical (mock B + A); manual smoke steps
documented in the PR (drop 2 folders, confirm routing counts + inferred tags, convert, verify one
package folder each with correct OUT/WRK contents and a `.dchub.json`). Lint/typecheck/test green.

---

## ▶ PROMPT D — Wire tag inference into the create-new-asset screen (desktop)

**Depends on:** Prompt A. Small task.

**Goal:** on the existing "create new asset" flow, suggest tags from the chosen path + intended file
type as the operator fills the form — your point about making creation, not just conversion, smarter.

**Read first:** `desktop/src/features/vocabulary/useAssetGenerator.ts` (holds `selected` tag Map keyed
by shortcode, `targetFolder`, `folderName`, calls `createAssetFolder`), `VocabularyView.tsx` +
`panels/DimColumn.tsx` (where tags are shown/selected), the vocab store.

**Build:** when `targetFolder`/`folderName` change, run `inferTagsFromPath(cleanSegments, index)` over
the path (clean the segments as A expects) and surface the results as *suggested* chips the operator
can accept into `selected` with one click (don't auto-add silently). If a format is implied by the
name/intended file, also surface `inferFormatFromExtensions`. Build the `InferenceIndex` once per
vocabulary (memoize).

**Constraints:** suggestions only — never mutate `selected` without an explicit click. Reuse the
existing selection Map + `toggleTag`; don't fork tag state.

**Definition of done:** a test that given a target path + vocab, the hook exposes the expected
suggestion set and accepting one adds it to `selected`. Lint/typecheck/`npm run test:desktop` green.

---

## ▶ PROMPT E — OS right-click "Convert to Sotto asset" (Tier 3, do last)

**Depends on:** Prompt C (the in-app batch review sheet is the landing surface).

**Goal:** a Finder/Explorer/Linux right-click that hands selected folder paths to the running,
signed-in app and opens the convert review sheet — without the app window being the drop target.

**Read first:** `desktop/src-tauri/` (`lib.rs`, `tauri.conf.json`, `capabilities/`, `Cargo.toml`) —
confirm there is currently no `deep-link`/`single-instance`/CLI plugin; `desktop/src-tauri/src/
reveal.rs` (existing localhost bridge pattern, for reference — but prefer a proper deep-link over a
new HTTP endpoint).

**Build:**
1. Add Tauri `deep-link` + `single-instance` plugins; register a `sotto://convert?paths=<url-encoded
   list>` scheme. Single-instance so a second invocation focuses the existing window and forwards the
   paths rather than launching a duplicate.
2. Frontend: on a `sotto://convert` event, open Prompt C's batch review sheet pre-filled with the
   paths. If not signed in / no active client, show a clear "open Sotto and pick a client to finish
   converting N folders" state — queue, don't drop.
3. Thin per-OS context-menu registration, all routed through the one `sotto://convert` entry:
   **macOS** a Finder Quick Action (cheapest; no separate signed extension), **Windows** a shell
   context-menu entry, **Linux** Nautilus/Dolphin/Thunar service scripts. Ship the registration for
   the platforms you build for; document how each is installed.

**Constraints:** do NOT introduce a new unauthenticated localhost endpoint (the existing reveal bridge
on `127.0.0.1:7624` is already flagged as an origin-oracle risk — don't add to that surface). Keep the
scheme handler minimal; all real work stays in the JS convert flow. Requires app running + signed in.

**Definition of done:** deep-link cold-start and warm (single-instance) both open the sheet with the
right paths on your dev platform; `npm run check:rust`/`lint:rust` and the JS checks green; per-OS
install steps documented in the PR.

---

### Note
This splits the **asset-management** track only. The **security audit** (`SOTTO_AUDIT_TODO.md`) you're
doing first is a different shape — mostly small, surgical, independently-verifiable fixes — and splits
cleanly by severity (one P0 migration + test; the P1 items each a self-contained fix). Say the word
and I'll produce the same prompt-per-task breakdown for it.
