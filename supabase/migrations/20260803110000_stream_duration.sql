-- How long a video is, so a hover preview can span all of it.
--
-- The first hover preview used Cloudflare's animated thumbnail, which turned out to be capped at
-- FIFTEEN SECONDS: `duration: attribute 20s must be between 100ms and 15s`. On a 62-second film that
-- shows the opening and nothing else, which reads as a broken preview rather than a short one.
--
-- The replacement samples stills across the whole timeline, and to place them it has to know where
-- the end is. Measured on a real 61.9s video: ten stills spanning the full length total 121 KB,
-- against 763 KB for a five-second GIF at the same height — so the approach that covers everything
-- is also six times cheaper.
--
-- Recorded rather than fetched per view: it is a fixed property of an encoded video, and asking
-- Cloudflare for it on every gallery render would be one API call per card for a number that
-- never changes.

alter table public.assets add column stream_duration real;

comment on column public.assets.stream_duration is
  'Video length in seconds, as Cloudflare Stream reports it once encoding finishes. Null until then, '
  'and for everything that is not a video. Used to place hover-preview frames across the timeline.';
