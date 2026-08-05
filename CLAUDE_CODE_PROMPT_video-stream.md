# Claude Code handoff — video on Cloudflare Stream

Pick this up **after the auth + refactor work is done**. Goal: videos in a client
library get uploaded to Cloudflare Stream for playback, get automatic thumbnails,
and show a short frame preview on hover in the portal gallery. Delete or archive
this file once all three are live.

Written 2026-07-29 against v3.0.0. **Everything in "Starting facts" was verified
then — re-verify before relying on it,** especially the line numbers.

---

## Scope, in one paragraph

Videos already upload to R2 as originals and stay there for **download**. Stream is
added alongside for **playback** — not instead of R2. Stream also gives stills and
animated previews from a URL, which is what makes the thumbnail and hover work
almost free. The expensive alternative (decoding video locally) is explicitly out of
scope: see "Do not do this".

## Starting facts (verified 2026-07-29)

| Fact | Where | Why it matters |
|---|---|---|
| Videos already reach R2 | `runOriginalUpload`, [pipelineService.ts:1238](desktop/src/services/pipelineService.ts#L1238) — no extension filter | Stream can copy from the R2 URL; no upload plumbing needed in the desktop |
| Video thumbnails don't exist | `generate_thumbnail` errors on unknown extensions, [lib.rs:86-101](desktop/src-tauri/src/lib.rs#L86-L101) | Nothing to migrate; any video thumb today was made by hand |
| Thumbnail step skips them silently | `runCdnUpload` [pipelineService.ts:1111](desktop/src/services/pipelineService.ts#L1111) requires a `-thumb.webp` sidecar | Videos are counted as `skipped`, not errors |
| Portal has no video support at all | no `<video>`, no HLS anywhere in `web/apps/client-hub/src` | Player is greenfield — no legacy playback to reconcile |
| Obsidian thumb extension sets exclude video | `GALLERY_THUMB_EXTS` [damService.ts:34](desktop/src/services/damService.ts#L34), `IMAGE_EXTS` [damService.ts:354](desktop/src/services/damService.ts#L354) | Two-line change so notes pick up a video thumb |
| Hover machinery already exists | [MultiAssetHover.tsx](web/apps/client-hub/src/features/gallery/MultiAssetHover.tsx) — `MAX_HOVER_TILES`, `AnimatePresence`, shimmer, `useReducedMotion` | The flipbook is new presentation on existing plumbing |
| Edge-function auth pattern to copy | [r2-grant](supabase/functions/r2-grant/index.ts): session → role → `client_members` → 503 when secrets missing | Reuse this shape exactly; also see `r2-branding-upload` |
| Desktop grant client to copy | `requestR2Grant` [r2Grant.ts:15](desktop/src/services/supabase/r2Grant.ts#L15), called from [PipelineView.tsx:368](desktop/src/features/pipeline/PipelineView.tsx#L368) | Same call shape for a `stream-upload` function |

Library size at the time of writing: **13 videos, ~1 GB total, largest 380 MB**
(12 in ESS, 1 in DC). Small enough that cost and batch concerns are negligible;
large enough that the 380 MB file rules out naive single-POST uploads.

## Decisions already made — don't re-litigate

1. **R2 keeps the original; Stream is for playback.** Both, not either.
2. **Stream pulls from the R2 public URL** ("copy from URL"), so the desktop never
   streams bytes to Stream and you never implement tus/resumable upload.
3. **Key Stream state to folder identity**, not filenames. `stable_id` + `child_id`
   is the identity everywhere in v3.0.0 (see `CHANGELOG.md` 3.0.0). A `stream_uid`
   hangs off the asset row, so renames and version bumps behave automatically.
4. **Thumbnails come from Stream**, built from `stream_uid` — not stored, not
   generated locally, not uploaded to R2.

## Verify these before writing code (~1 hour of docs)

My knowledge of Stream's specifics may be stale, and these change the estimates:

- The **copy-from-URL** endpoint and whether it accepts an R2 public URL directly
  (and what it does about private buckets — see the signed-playback question).
- **Animated thumbnail** parameters: format options (GIF only, or WebP/MP4 too),
  and the `fps`/`duration` limits. `fps=2` is one frame per 0.5s, which is the
  effect requested.
- **Still thumbnail** parameters (`time`, `height`/`width`) and whether a
  percentage offset is supported, for computing N evenly spaced frames.
- **Signed URLs**: whether `requireSignedURLs` also covers the thumbnail and
  animated-thumbnail endpoints. If it doesn't, "private" videos leak preview
  frames, which is a design problem, not a detail.
- Current **pricing** per minute stored / delivered.

If any answer contradicts this document, the docs win — update this file.

## Open design question to settle with Petr first

**Do internal videos need private playback?** Assets carry `perm`
(`public`/`client`/`internal`) and the portal is role-gated, but a plain Stream
playback URL works for anyone holding it. Signed URLs mean minting tokens in an
edge function and signing thumbnail URLs too — **budget about a day extra** and it
touches every URL the portal builds. Settle it before Phase 2, because retrofitting
means revisiting the player, the grid, and the hover preview.

## Implementation

### Phase 1 — plumbing (~1 day)

1. Migration: add `stream_uid text` and `stream_status text` to `public.assets`
   (nullable — only videos have them). Follow the v3.0.0 precedent: no backfill
   shim, no dual path. Then `npm run db:types` (needs Docker) and commit the
   regenerated `packages/database/src/database.types.ts`.
2. Edge function `supabase/functions/stream-upload/`, modelled on `r2-grant`:
   same auth chain, same 503-when-unprovisioned behaviour. Input: `client_id`,
   the R2 object URL, and the asset's identity. Output: `stream_uid` + status.
   Add its secrets to `supabase/functions/.env` and `.env.example`.
3. `requestStreamUpload` in `desktop/src/services/supabase/`, mirroring
   `requestR2Grant` — including its gateway-vs-refusal error split, so a dead edge
   runtime reads as unreachable rather than misconfigured.

### Phase 2 — pipeline (~1 day)

4. In `runOriginalUpload` (or a step right after it), detect video extensions and
   call the function once the R2 upload for that file has succeeded. Skip when
   `stream_uid` is already set and the content hash hasn't changed — reuse the
   existing `r2-upload-cache.json` idea rather than inventing a second cache.
5. Transcoding is async: store `processing`, and have a later run (or a small poll)
   flip it to `ready`. Never block a pipeline run waiting on it.
6. Write `stream_uid`/`stream_status` through `exportAssetsToSupabase` alongside the
   other asset fields. **Do not** add a second write path for them.
7. Add video extensions to `GALLERY_THUMB_EXTS` and `IMAGE_EXTS` in `damService.ts`
   so Obsidian notes show a frame.

### Phase 3 — portal playback (~1 day)

8. Player in `AssetDetail`. Stream's iframe embed is the zero-effort option; hls.js
   only if you want custom controls. Respect `perm` per the signed-URL decision.
9. Thumbnails: build the still URL from `stream_uid` wherever `thumbnailUrl` is used
   today, so video cards stop being blank. Keep the fallback for `stream_status !==
   'ready'` (show the shimmer that already exists).

### Phase 4 — hover preview (~half a day)

10. Start with **Stream's animated thumbnail**: one `<img>` swapped in on hover,
    `fps=2` for the half-second-per-frame feel, wired into the hover state already
    in `MultiAssetHover`/`GalleryView`. Lazy-load on first hover — never eagerly
    for a whole grid.
11. **Hold a static frame when `useReducedMotion()` is true.** The codebase is
    consistent about this and an auto-playing preview is exactly what that rule is
    for.
12. Only if GIF quality disappoints: switch to N stills at computed timestamps and
    step them with an interval. Same hover plumbing, ~1 day. A sprite sheet would
    be better still but needs local ffmpeg — see below.

## Do not do this

**Don't add local video decoding.** It means bundling ffmpeg as a Tauri sidecar:
binary size, per-platform packaging, and a licensing review. It is the most
expensive item on the whole list and Stream removes the need. If you ever truly
need offline thumbnails, raise it as its own piece of work with Petr first.

**Don't reintroduce filename-keyed lookups.** v3.0.0 deleted the shortcode identity
path and the stem-keyed maps that silently dropped assets when two packages held the
same filename. Anything new keys on `stable_id` + `child_id`. See `CHANGELOG.md`
3.0.0 and `desktop/src/domain/assetGrouping.test.ts` for the regressions that guard
this.

## Definition of done

- A video in a client's `OUT` folder ends up: in R2 originals (download), on Stream
  (playback), with a working thumbnail in the portal grid and in its Obsidian note.
- Hovering a video card plays a short frame preview; reduced-motion holds a still.
- Re-running the pipeline changes nothing (no re-upload, no new `stream_uid`),
  and renaming the file keeps the same Stream asset and DB row.
- A video whose folder lacks a ` __<hash>` suffix is reported and skipped, matching
  how R2 uploads already behave ([pipelineService.ts:1276](desktop/src/services/pipelineService.ts#L1276)).
- `npm run check` + `npm test` clean; migration replays from zero via
  `supabase db reset`; `supabase db lint --level warning` clean.

## Testing notes

There's a working pattern for integration tests against the local stack in
`desktop/src/services/supabaseSync.integration.test.ts`: mock `@tauri-apps/api/core`
to delegate `invoke` to real `fetch`, mock `authService`'s token with the seeded
local admin (`admin@acme.test` / `dchub-local`), and let the test hit
`127.0.0.1:54321`. It self-skips when the stack is down so CI stays green. Reuse
that for `requestStreamUpload`.

If CDN steps fail locally with a gateway error, check the edge runtime container is
running — it has no restart policy and has died silently before:
`docker start supabase_edge_runtime_dc-hub`.
