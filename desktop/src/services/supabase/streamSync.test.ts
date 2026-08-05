/* What syncStreamVideos decides to do, and — more importantly — what it decides to leave alone.
 *
 * The interesting cases are all "should this asset be touched at all". Getting that wrong is
 * expensive in both directions: a false positive re-encodes a video on every run forever, and a
 * false negative leaves the portal playing a superseded cut. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchAllForClient = vi.fn();
const requestStreamUpload = vi.fn();

vi.mock('./rest', () => ({
  fetchAllForClient: (...a: unknown[]) => fetchAllForClient(...a),
  makeHeaders: async () => ({}),
}));
vi.mock('./streamUpload', () => ({
  requestStreamUpload: (...a: unknown[]) => requestStreamUpload(...a),
}));

const { syncStreamVideos } = await import('./streamSync');

const cfg = { url: 'https://x.supabase.co', anonKey: 'anon' };
const log = () => {};
const row = (o: Partial<Record<string, unknown>>) => ({
  id: 'a1', name: 'Film', download_url: null, stream_uid: null,
  stream_status: null, stream_source_hash: null, ...o,
});

beforeEach(() => {
  fetchAllForClient.mockReset();
  requestStreamUpload.mockReset();
  requestStreamUpload.mockResolvedValue({ stream_uid: 'new-uid', stream_status: 'queued' });
});

describe('syncStreamVideos', () => {
  it('dry-runs an upload without starting a Stream mutation', async () => {
    fetchAllForClient.mockResolvedValue([row({ download_url: 'https://f.dc/client/c/originals/s/c.mp4?v=abc' })]);
    const r = await syncStreamVideos(cfg, 'c1', log, { dryRun: true });
    expect(requestStreamUpload).not.toHaveBeenCalled();
    expect(r.uploaded).toBe(1);
  });

  it('uploads a video that has no Stream copy', async () => {
    fetchAllForClient.mockResolvedValue([row({ download_url: 'https://f.dc/client/c/originals/s/c.mp4?v=abc' })]);
    const r = await syncStreamVideos(cfg, 'c1', log);
    expect(requestStreamUpload).toHaveBeenCalledWith(cfg, 'a1', { replace: false });
    expect(r.uploaded).toBe(1);
  });

  it('leaves a current video alone — the common case, and it must cost nothing', async () => {
    fetchAllForClient.mockResolvedValue([row({
      download_url: 'https://f.dc/client/c/originals/s/c.mp4?v=abc',
      stream_uid: 'uid1', stream_status: 'ready', stream_source_hash: 'abc',
    })]);
    const r = await syncStreamVideos(cfg, 'c1', log);
    expect(requestStreamUpload).not.toHaveBeenCalled();
    expect(r).toEqual({ uploaded: 0, replaced: 0, failed: 0 });
  });

  /* The bug this exists to prevent: v2 lands under the same version-stable key, so the row keeps
     v1's uid and the portal plays v1 while the download button hands over v2. Both halves work,
     which is why nobody would report it. */
  it('replaces a video whose master has changed under the same key', async () => {
    fetchAllForClient.mockResolvedValue([row({
      download_url: 'https://f.dc/client/c/originals/s/c.mp4?v=NEW',
      stream_uid: 'uid1', stream_status: 'ready', stream_source_hash: 'OLD',
    })]);
    const r = await syncStreamVideos(cfg, 'c1', log);
    expect(requestStreamUpload).toHaveBeenCalledWith(cfg, 'a1', { replace: true });
    expect(r.replaced).toBe(1);
  });

  it('ignores non-video assets entirely', async () => {
    fetchAllForClient.mockResolvedValue([
      row({ id: 'i1', download_url: 'https://f.dc/client/c/originals/s/c.png?v=1' }),
      row({ id: 'i2', download_url: 'https://f.dc/client/c/originals/s/c.pdf?v=1' }),
    ]);
    const r = await syncStreamVideos(cfg, 'c1', log);
    expect(requestStreamUpload).not.toHaveBeenCalled();
    expect(r.uploaded).toBe(0);
  });

  /* A display name is editable in the portal and often carries no extension, so the decision has
     to come off the object key. A name-based check would silently skip every renamed video. */
  it('detects video from the object key, not the display name', async () => {
    fetchAllForClient.mockResolvedValue([row({
      name: 'Brand Film — Director Cut',
      download_url: 'https://f.dc/client/c/originals/s/c.mov?v=abc',
    })]);
    await syncStreamVideos(cfg, 'c1', log);
    expect(requestStreamUpload).toHaveBeenCalledOnce();
  });

  it('survives one video failing, and keeps going', async () => {
    fetchAllForClient.mockResolvedValue([
      row({ id: 'v1', download_url: 'https://f.dc/client/c/originals/s/1.mp4?v=a' }),
      row({ id: 'v2', download_url: 'https://f.dc/client/c/originals/s/2.mp4?v=b' }),
    ]);
    requestStreamUpload.mockRejectedValueOnce(new Error('Stream refused the master'));
    const r = await syncStreamVideos(cfg, 'c1', log);
    expect(r).toEqual({ uploaded: 1, replaced: 0, failed: 1 });
  });

  /* The R2 master is already safe by the time this runs. Stream is a regenerable playback layer,
     so a query failure must not take the run down with it. */
  it('reports a query failure without throwing', async () => {
    fetchAllForClient.mockRejectedValue(new Error('network'));
    await expect(syncStreamVideos(cfg, 'c1', log)).resolves.toEqual({ uploaded: 0, replaced: 0, failed: 1 });
  });

  it('caps how many it starts in one run, leaving the rest for the next', async () => {
    fetchAllForClient.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) =>
        row({ id: `v${i}`, download_url: `https://f.dc/client/c/originals/s/${i}.mp4?v=a` })));
    const r = await syncStreamVideos(cfg, 'c1', log);
    expect(requestStreamUpload).toHaveBeenCalledTimes(20);
    expect(r.uploaded).toBe(20);
  });
});
