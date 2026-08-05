# Sotto — Onboarding & Folder-to-Asset Conversion Plan (2026-08-05)

**Goal (David's framing):** make Sotto acquirable by other agencies. The stated bottleneck is that
moving an *existing* folder structure into the app's logic — the `Name __<hash>/` package, `IN/WRK/
OUT`, `.dchub.json`, reserved child IDs — is tedious, and today it can only be done inside the app
(open app → create folder → navigate → move content). You want a cross-platform right-click
"convert folder → asset" flow.

This plan is grounded in how identity actually works in the code, then lays out the options, a
recommended phased path, correctness traps to avoid, and extra automation ideas.

---

## 1. What the code says about feasibility (the constraint that shapes everything)

Creating an asset is not "make a folder." It **mints permanent identity**, and there is exactly one
sanctioned place that does it: `desktop/src/features/vocabulary/createAssetFolder.ts`. Its own
header says it is "the ONLY sanctioned way to create an asset folder." That single function does
five things that any conversion tool must also do, in order:

1. **Fetch every `stable_id` the client already holds** (`fetchExistingStableIds` → Supabase) and
   generate an 8-hex id that can't collide (`generateStableId`, `@sotto/domain/stableId`).
2. Create `Name __<hash>/` with `IN/ WRK/ OUT/`.
3. Write an **extensionless placeholder** into `OUT` (so the scanner ignores it) reserving `child_id
   c1` in `.dchub.json`.
4. Write `readme.md`.
5. Create a **Supabase draft row** so the first real sync *updates* this asset instead of creating a
   second row beside it.

Two facts fall out of this that decide the architecture:

- **The pure, reusable half already exists and is platform-free.** `@sotto/domain` (stableId,
  naming, version, vocabulary, filenameTranslator, assetGrouping) is by contract "no Tauri, no
  Supabase, no filesystem, no network" and is designed to run "in a Node script or an edge function
  without a shim." Identity *generation* is portable.
- **The stateful half is not.** Steps 1 and 5 need a live, signed-in client context: the client's
  Supabase URL/anon key, the user's JWT (RLS requires editor/admin), and `client_id`. A pure offline
  shell extension **cannot** safely mint a per-client-unique id (no collision check) and **cannot**
  create the draft row. Skipping either produces the exact "folder exists on disk, no DB row"
  partial state the code already warns about — and duplicate-identity, the failure v3.0.0 was built
  to remove.

**Conclusion:** the conversion tool should generate identity through the *existing* code path, not a
reimplementation. The interesting design question is purely **how a right-click hands the selected
paths to that code path** — not how to rebuild the minting logic.

There is also a relevant gap: the Tauri app currently has **no deep-link, single-instance, or CLI
plugin** (verified in `src-tauri`). So today nothing outside the app can hand it a folder. Adding
that hook is the enabling piece.

---

## 2. Your two modes are one operation

- **Mode 1** (wrap existing folders, content → WRK, placeholder+tags → OUT) and
- **Mode 2** (register a blank asset from a folder / blank space, quick tags)

are the same action with different inputs: *"create a package around a selection, where the
selection may be empty."* Build one primitive — `convertSelectionToAsset(paths[], tags[], opts)` —
and Mode 2 is just `paths=[]`. This keeps one code path and one set of tests.

> ⚠️ **One correctness note on Mode 1.** The pipeline **only scans `OUT`** (`docs/desktop/scanning`).
> Moving a folder's content into `WRK` is correct for working files, but that asset's *deliverable*
> stays the empty placeholder until a real file lands in `OUT`. Decide per-conversion whether the
> selected files are working material (→ WRK) or the deliverable (→ OUT). A good default: images/PDFs/
> decks that look like finished deliverables land in OUT; everything else in WRK; always overridable.

---

## 3. Architecture options

### Option A — Thin OS shim → deep-link into the running app *(recommended)*
Right-click entry hands the selected paths to the already-running, already-signed-in Sotto app via a
custom URL scheme (`sotto://convert?paths=…`) or a CLI arg, using Tauri's `deep-link` +
`single-instance` plugins. The app opens a small "Convert to asset" panel pre-filled with the paths,
offers tag quick-add from the client's vocabulary, and runs the **existing** `createAssetFolder`
logic (batched).

- ✅ Reuses all tested identity + draft-row logic → zero duplication, zero drift risk.
- ✅ Has the client's Supabase session and vocabulary already → collision check and tag autocomplete
  "just work."
- ✅ The per-OS part is thin glue that only needs to launch a URL/binary with file paths.
- ⚠️ Requires the app to be running and signed in (acceptable — it's a staff tool). Queue gracefully
  if not: "Sotto isn't open — open it to finish converting 4 folders."
- ⚠️ Adds two Tauri plugins + a single-instance handler.

### Option B — Standalone cross-platform CLI (`sotto convert ./folder --tags …`)
A small Node or Rust binary bundling `@sotto/domain`, talking to Supabase directly with a stored
session. Context-menu entries call it.

- ✅ Works without the GUI open; scriptable; good for bulk/headless migration.
- ❌ Re-implements steps 1 and 5 outside the app → **the drift risk the whole identity design fears.**
  Only acceptable if you first **extract the orchestration** (the createAssetFolder body) into a
  shared package both the app and CLI import, so there is still one implementation.
- ❌ Needs its own auth/session storage and its own partial-failure reconciliation.

### Option C — In-app batch import / drag-and-drop *(cheapest, ship first)*
No OS integration at all: an "Import existing folder(s)" button and a drop-zone in the desktop app
that runs `createAssetFolder` in batch with tag quick-add.

- ✅ Kills ~80% of the pain you described (the navigate→create→navigate→move tedium) with the least
  work and no cross-OS shell-extension cost.
- ✅ Reuses everything; nothing new to sign or maintain per platform.
- ⚠️ Not a right-click — the operator drags folders onto the app instead of acting in Finder.

---

## 4. Recommended path (phased)

**Phase 1 — In-app batch import + drag-drop (Option C).** Fastest credible relief. One
`convertSelectionToAsset` primitive + a drop-zone + a tag quick-add row. Batched
`createAssetFolder`, with a summary and the same partial-failure reporting the single-create path
has. Ship this first; it's the thing you can demo to a prospect next week.

**Phase 2 — OS right-click via deep-link (Option A).** Add `deep-link` + `single-instance` to Tauri;
register the `sotto://` scheme. Then the per-OS context-menu registration, which is the real
cross-platform cost and should be scoped honestly — each platform is a different mechanism:
- **macOS:** a Finder *Quick Action* (Automator/Shortcuts) or a Finder Sync extension that opens
  `sotto://convert?…`. Quick Action is far cheaper and needs no separate signed extension.
- **Windows:** a shell context-menu entry (registry / packaged `MSIX` `desktopN` extension) invoking
  the app or a launcher with the selected paths.
- **Linux:** per-file-manager scripts — Nautilus (`~/.local/share/nautilus/scripts` or an extension),
  Dolphin `.desktop` ServiceMenus, Thunar custom actions. Ship the common two or three.

Route all three through the *same* `sotto://convert` entry point so the app-side logic is written
once.

**Phase 3 — Bulk migration wizard (the actual acquisition unlock — see §6).**

**Avoid Option B** as a first move. Only build a standalone CLI *after* the orchestration is
extracted into shared code, and even then treat it as a power-user/headless add-on, not the primary
onboarding path.

---

## 5. Correctness traps to design against (all drawn from the current code)

1. **Never mint identity in two places.** If anything other than `createAssetFolder`/`@sotto/domain`
   generates a `stable_id` or `child_id`, you reopen the v3.0.0 wound. Extract-and-share, don't copy.
2. **Require a live signed-in client, or queue.** Offline conversion can't do the collision check or
   the draft row → guaranteed partial state. Make "app open + signed in as editor/admin" a
   precondition, surfaced clearly.
3. **Content in WRK is invisible to publish.** Give the operator the WRK-vs-OUT choice (see §2).
4. **Batch = many draft inserts.** Reuse the single-path partial-failure handling: report exactly
   which folders got a DB row and which didn't, so a retry doesn't create a second folder for one asset.
5. **Make bulk conversion reversible.** This codebase has a scar history of destructive moves
   (`REFACTOR_PLAN.md`, the P1 publish/tag-delete findings). Any batch/bulk convert must be
   dry-run-first + undoable (record what moved where; offer "undo this conversion").
6. **`stableId` uses `Math.random()` guarded by the collision check** — fine *because* of the check.
   A tool that mints without the check would eventually collide. Another reason to keep minting
   centralized.
7. **Folder names can't contain parentheses** (the id uses the typed name, not the bracket-stem) —
   your tag-derived names must be sanitized before becoming folder names, and taxonomy labels must
   be stripped of path separators before they become filename/path segments (P2 finding).

---

## 6. Automation ideas you may be missing

- **Bulk migration wizard — this is the real "acquire other agencies" feature, bigger than
  right-click.** A new agency's whole pain isn't converting *one* folder; it's converting *their
  entire back catalogue*. A wizard that points at an existing archive, detects leaf "project"
  folders (heuristics: folders with deliverable-type files, or an existing OUT-like convention),
  previews the proposed packages, lets them bulk-assign/auto-infer tags, and ingests everything in
  one reversible pass is what turns "evaluate over a weekend" into "migrated on day one." Right-click
  is the *ongoing* ergonomic; the wizard is the *adoption* ergonomic.
- **Watch-folder / auto-adopt.** A designated drop folder the app watches; drop a folder in and it
  auto-converts on a debounce. Zero clicks, and it fits agencies who already dump work into a shared
  drive.
- **Convention presets per client.** If an incoming agency already uses e.g. `01 IN / 02 WRK / 03
  OUT` or `_deliverables/`, let them map their convention once; conversion then respects it instead
  of forcing a re-layout.
- **Tag inference from folder path.** The filename↔taxonomy coupling already exists
  (`filenameTranslator`). Extend it to *suggest* tags from folder/file names during conversion, so
  "quick-add tags" is mostly confirming rather than typing.
- **Templates for blank assets.** Mode 2 with a one-click "new asset from this client's default
  template" (pre-seeded tags/structure) removes the last bit of friction.

---

## 7. Honest framing on "acquirable by other agencies"

Onboarding friction is a real adoption tax and this plan removes most of it. But two things matter
more than right-click for selling to a *second tenant*, and they're worth saying plainly:

1. **The P0 security bug is the actual blocker.** A multi-agency product where any signed-in user can
   self-elevate to `super_admin` and read another agency's assets (see the audit TODO, P0 + the
   two P1 cross-tenant items) is not yet safe to put a second paying agency on. Fix that *before* you
   pitch multi-tenant. It's a small SQL change; it's also table stakes.
2. **Reversibility and trust.** Agencies are handing you their creative archive. The destructive-path
   findings (dry-run that isn't dry, transient-error deletes, tag deletion) undermine the "safe to
   trust with our library" story that the conversion tool is meant to sell. Land the P1 fixes
   alongside the conversion feature.

Do those, ship Phase 1, and the onboarding story becomes: "point Sotto at your existing folders, it
wraps them as assets in one reversible pass, and your library is safely isolated from every other
agency on the platform." That's a sellable sentence.
