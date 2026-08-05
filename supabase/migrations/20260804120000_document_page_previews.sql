-- Per-page document previews: how many to render, and how many exist.
--
-- A document asset (PDF, PowerPoint, Word, Excel) gets a title thumbnail as before, plus a folder of
-- per-page WebP previews published under the `pages/` R2 namespace for the portal's page viewer.
-- Two numbers have to reach the portal, and they are NOT the same number:
--
--   preview_page_count  how many pages were rendered and uploaded — what the viewer can show
--   preview_page_total  how many pages the document actually has
--
-- When total exceeds count the viewer shows what it has and then tells the reader to download the
-- asset for the rest. Collapsing these into one column would lose exactly that: the portal could
-- render the pages it has but could not tell the difference between "that is the whole document" and
-- "there is more, behind the cap".
--
-- No URL column. There is one object per page, so storing 50 URLs per asset would be absurd; the
-- portal derives each page's address from the asset's identity and level the same way the pipeline
-- does. See `pageTarget` in @dc-hub/domain.

alter table public.clients
  add column preview_page_limit integer not null default 50
    constraint clients_preview_page_limit_range check (preview_page_limit between 0 and 500);

comment on column public.clients.preview_page_limit is
  'Maximum document pages the desktop pipeline renders previews for, per asset. Portal-owned: an '
  'admin sets it in the client admin. 0 disables page previews for the client. The upper bound is a '
  'guard rather than a policy — a 500-page render is minutes of work and 500 objects per asset. '
  'Spreadsheets ignore this and always render one page (see render::page_budget): a wide sheet '
  'paginates into dozens of near-empty slices, so the full allowance would produce useless images.';

alter table public.assets
  add column preview_page_count integer,
  add column preview_page_total integer;

comment on column public.assets.preview_page_count is
  'Pages rendered and published to the pages/ namespace. Null for assets with no page previews — '
  'every raster, every video, and any document processed before this feature. The portal reads N '
  'pages at pageTarget(level, client, stable, child, 1..N).';

comment on column public.assets.preview_page_total is
  'Pages the source document actually has. Greater than preview_page_count when the client''s '
  'preview_page_limit capped rendering; the difference is what the portal turns into "download the '
  'asset to see the rest".';

-- The portal filters galleries and detail views by whether previews exist. A partial index keeps
-- that cheap without carrying a row for every raster and video, which is most of the table.
create index assets_with_page_previews_idx
  on public.assets (client_id, stable_id, child_id)
  where preview_page_count is not null and preview_page_count > 0;
