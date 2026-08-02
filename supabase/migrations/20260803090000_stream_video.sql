-- Video playback on Cloudflare Stream, keyed to folder identity.
--
-- R2 keeps the master file — Stream is added alongside it, never instead of it. The original is
-- what a client downloads and what the library is an archive of; Stream is a delivery format for
-- playing it in a browser, and a delivery format is regenerable. If Stream lost every video
-- tomorrow the library would be intact.
--
-- WHY TWO COLUMNS RATHER THAN ONE
--   `stream_uid` alone cannot answer "is this playable yet?". Encoding takes minutes for a large
--   file, and during that window the uid exists and every delivery URL built from it 404s. The
--   portal needs to tell "no video" from "video, not ready" — the first is a still thumbnail, the
--   second is the shimmer that is already in the codebase. Storing only the uid would make the
--   grid render broken images for the length of an encode.
--
-- WHY NOT A SEPARATE TABLE
--   A video is one-to-one with the asset row that owns it, and every query that wants the uid
--   already has the asset. A join table would buy nothing and cost a join on the hottest read in
--   the product.

alter table public.assets
  add column stream_uid    text,
  add column stream_status text;

comment on column public.assets.stream_uid is
  'Cloudflare Stream video id. Null for everything that is not a video, and for videos not yet '
  'uploaded. Delivery URLs are built from this — playback, stills and animated previews all live '
  'under customer-<code>.cloudflarestream.com/<uid|token>/.';

comment on column public.assets.stream_status is
  'Encoding state as Stream reports it, verbatim. Only `ready` means the delivery URLs resolve; '
  'anything else means the portal should hold its placeholder rather than render a broken image.';

/* Stream's own vocabulary, not a translation of it. A local synonym set would have to be kept in
   step with theirs forever, and the first time they add a state we would store something the
   portal has never heard of. The constraint exists to catch a typo in our code, not to model the
   lifecycle. */
alter table public.assets
  add constraint assets_stream_status_known check (
    stream_status is null or stream_status in
      ('pendingupload', 'downloading', 'queued', 'inprogress', 'ready', 'error')
  );

/* One video belongs to one asset. Postgres allows any number of NULLs under a unique constraint,
   which is exactly the wanted behaviour: the overwhelming majority of rows are not videos.

   This is a real guard, not tidiness. Re-running an upload for an asset that already has a uid
   would otherwise leave the old video orphaned in the account, still serving, still billed, and
   with no row pointing at it to say what it was or who may see it. */
create unique index assets_stream_uid_key on public.assets (stream_uid)
  where stream_uid is not null;

/* Finding videos whose encode has not landed. The portal polls this after an upload and the
   desktop reconciles it after a run; both ask the same question, and without an index it is a
   sequential scan of the whole library to find the handful that are mid-encode. */
create index assets_stream_pending_idx on public.assets (stream_status)
  where stream_uid is not null and stream_status is distinct from 'ready';

/* ── Access level and the signed-URL flag ─────────────────────────────────────
   A gated video is protected by Stream's `requireSignedURLs`, which is set per video through
   Cloudflare's API — so the access level is baked into the delivery object here exactly as it is
   baked into the R2 object key. The same consequence follows: a `public` -> `client` demotion has
   to propagate, or the video keeps serving to anyone holding the uid.

   Nothing new is needed to notice. `assets_queue_cdn_move` (20260802090000) already fires on any
   change to `perm` or `status` and queues the asset; cdn-reconcile flips the Stream flag in the
   same pass it moves the key. Cheaper than the R2 case, too — one API call, no bytes move.

   Existing rows with a stream_uid: none, this column is new. */
