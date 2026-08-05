/* Stream sync — make sure every video asset has a current video on Cloudflare Stream.
 *
 * Runs after the Supabase export, and it has to: `stream-upload` takes an asset id and reads the
 * master's location off the row, so the row must exist and carry a download_url first. That is why
 * this is a post-run step rather than part of runOriginalUpload, where the brief first placed it —
 * at that point a brand-new asset has no row to attach a video to.
 *
 * IT ASKS THE DATABASE, NOT THE RUN. The question "which videos lack a current Stream copy" is
 * answered from rows, so a video missed by an earlier run — the pipeline crashed, the token was
 * not set yet, Stream was down — is picked up by the next one without anyone noticing it was
 * missed. Scoping it to files touched this run would make a miss permanent.
 */

import { isVideoFile, stripVersion } from '@dc-hub/domain';
import type { SupabaseConfig } from './rest';
import { makeHeaders, fetchAllForClient } from './rest';
import { requestStreamUpload } from './streamUpload';

type Log = (type: string, msg: string) => void;

interface VideoRow {
  id: string;
  name: string;
  download_url: string | null;
  stream_uid: string | null;
  stream_status: string | null;
  stream_source_hash: string | null;
}

/* One at a time. Each call makes Cloudflare pull a whole master, and the encode that follows is
   billed by the minute — firing eight at once buys nothing, because the pipeline does not wait for
   any of them to finish anyway. */
const MAX_PER_RUN = 20;

/** The master's content hash, as the pipeline wrote it into the URL. */
function sourceHashOf(url: string): string | null {
  try { return new URL(url).searchParams.get('v'); } catch { return null; }
}

/**
 * Upload any video that has no Stream copy, or whose copy was made from a superseded master.
 *
 * Returns quietly when there is nothing to do, which is the overwhelmingly common case — a library
 * of a thousand images with ten videos runs one query and stops.
 */
export async function syncStreamVideos(
  config: SupabaseConfig, clientId: string, log: Log,
): Promise<{ uploaded: number; replaced: number; failed: number }> {
  const result = { uploaded: 0, replaced: 0, failed: 0 };

  let rows: VideoRow[];
  try {
    rows = await fetchAllForClient<VideoRow>(
      `${config.url}/rest/v1`, 'assets', clientId,
      'id,name,download_url,stream_uid,stream_status,stream_source_hash',
      await makeHeaders(config.anonKey),
    );
  } catch (e) {
    log('error', `  ✕  Could not check video state: ${e}`);
    return { ...result, failed: 1 };
  }

  /* Extension is read from the object KEY, not from `name` — a display name is editable in the
     portal and routinely has no extension at all, so trusting it would silently skip videos. */
  const videos = rows.filter(r => r.download_url && isVideoFile(stripVersion(r.download_url)));
  if (!videos.length) return result;

  const needsUpload = videos.filter(v => !v.stream_uid);
  /* A master that changed content under a version-stable key. Without this check the portal keeps
     PLAYING the old cut while the download button hands over the new one — a disagreement nobody
     is likely to notice, because both halves work. */
  const stale = videos.filter(v =>
    v.stream_uid && v.stream_source_hash !== sourceHashOf(v.download_url!));

  const work = [...needsUpload, ...stale];
  if (!work.length) {
    log('dim', `  Stream: ${videos.length} video(s), all current`);
    return result;
  }

  log('section', '━━━ STREAM VIDEO ━━━');
  if (work.length > MAX_PER_RUN) {
    // Said out loud rather than silently truncated: a capped run that reports nothing reads as
    // "everything is uploaded". The rest are picked up next run, because the query is the source
    // of truth rather than this run's file list.
    log('warn', `  ⚠  ${work.length} videos need uploading — doing ${MAX_PER_RUN} this run, the rest next time`);
  }

  for (const v of work.slice(0, MAX_PER_RUN)) {
    const replacing = !!v.stream_uid;
    try {
      const res = await requestStreamUpload(config, v.id, { replace: replacing });
      if (res.reused) continue;
      if (replacing) {
        result.replaced += 1;
        log('success', `  ✓  ${v.name} — re-encoded from the new master (${res.stream_status})`);
      } else {
        result.uploaded += 1;
        log('success', `  ✓  ${v.name} → Stream (${res.stream_status})`);
      }
    } catch (e) {
      /* Never fatal to the run. The R2 master — the thing the library is an archive of — is already
         safely uploaded by this point; Stream is a playback convenience layered on top, and it is
         regenerable. A failure here costs a video that will not play until the next run retries it,
         which the query above guarantees it will. */
      result.failed += 1;
      log('error', `  ✕  ${v.name} — ${e}`);
    }
  }

  /* Encoding continues after this returns. Statuses land as `queued`/`inprogress` and are flipped
     to `ready` by the portal's own poll — nothing here blocks a run waiting for a transcode. */
  log('section',
    `━━━ STREAM DONE — ${result.uploaded} uploaded · ${result.replaced} replaced · ${result.failed} failed ━━━`);
  return result;
}
