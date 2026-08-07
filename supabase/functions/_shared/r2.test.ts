import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyObject, listObjects, type TempCreds } from './r2.ts';

const CREDS: TempCreds = {
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
  sessionToken: 'test-session',
};

afterEach(() => vi.unstubAllGlobals());

describe('R2 ListObjectsV2 inventory', () => {
  it('paginates, validates KeyCount, and decodes XML entities exactly once', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes('continuation-token=')) {
        return new Response(`<?xml version="1.0"?>
          <ListBucketResult>
            <KeyCount>2</KeyCount>
            <Contents><Key>client/a&amp;b.webp</Key><LastModified>2026-08-06T10:00:00.000Z</LastModified><Size>42</Size></Contents>
            <Contents><Key>literal&amp;lt;name.webp</Key><LastModified>2026-08-06T10:01:00.000Z</LastModified><Size>7</Size></Contents>
            <IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>
          </ListBucketResult>`);
      }
      expect(url).toContain('continuation-token=tok%261');
      return new Response(`<?xml version="1.0"?>
        <ListBucketResult>
          <KeyCount>1</KeyCount>
          <Contents><Key>client/final.webp</Key><LastModified>2026-08-06T10:02:00.000Z</LastModified><Size>9</Size></Contents>
          <IsTruncated>false</IsTruncated>
        </ListBucketResult>`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listObjects('account', CREDS, 'bucket')).resolves.toEqual([
      { key: 'client/a&b.webp', size: 42, lastModified: '2026-08-06T10:00:00.000Z' },
      { key: 'literal&lt;name.webp', size: 7, lastModified: '2026-08-06T10:01:00.000Z' },
      { key: 'client/final.webp', size: 9, lastModified: '2026-08-06T10:02:00.000Z' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a page whose declared count does not match parsed objects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <ListBucketResult><KeyCount>2</KeyCount>
        <Contents><Key>one</Key><Size>1</Size></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`)));

    await expect(listObjects('account', CREDS, 'bucket')).rejects.toThrow(/KeyCount=2 but parsed 1/);
  });
});

/* Moving an object used to mean GET the whole thing into the edge runtime, hash it, PUT it back —
 * two transfers of every byte, and for a page probe, bytes read only to be discarded. Within one
 * bucket R2 can do it server-side. What these pin is that the shortcut keeps the properties the
 * streaming path had: the `x-amz-meta-sha256` the desktop recognises an already-published object
 * by, the `?v=` hash the caller stamps onto a URL, and `source missing` still meaning 404.
 */
const COPIED = '<?xml version="1.0"?><CopyObjectResult><ETag>"abc"</ETag></CopyObjectResult>';

/** Record every request the signer issues, so the assertions are on what reached R2. */
function recorder(handler: (method: string, url: string, init: RequestInit) => Response) {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>)
        .map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    calls.push({ method, url: String(input), headers });
    return handler(method, String(input), init);
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

describe('copyObject within one bucket', () => {
  it('copies server-side without ever reading the bytes when no hash is wanted', async () => {
    const calls = recorder((method) => method === 'PUT'
      ? new Response(COPIED)
      : new Response('should not be read', { status: 500 }));

    await expect(copyObject(
      'account',
      { creds: CREDS, bucket: 'gated', key: 'client/tenant/pages/a/c1/001.webp' },
      { creds: CREDS, bucket: 'gated', key: 'internal/tenant/pages/a/c1/001.webp' },
    )).resolves.toEqual({ ok: true, sha256: null });

    // One request. Not a GET of the object followed by a PUT of the same bytes.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers['x-amz-copy-source'])
      .toBe('/gated/client/tenant/pages/a/c1/001.webp');
    // COPY, not REPLACE: identical bytes, so the source's own recorded hash stays correct.
    expect(calls[0].headers['x-amz-metadata-directive']).toBe('COPY');
  });

  it('encodes a copy source the RFC 3986 way, so parenthesised legacy keys do not 403', async () => {
    const calls = recorder(() => new Response(COPIED));

    await copyObject(
      'account',
      { creds: CREDS, bucket: 'gated', key: 'client/t/(PRD)(SlD) Deck.pdf' },
      { creds: CREDS, bucket: 'gated', key: 'internal/t/(PRD)(SlD) Deck.pdf' },
    );

    expect(calls[0].headers['x-amz-copy-source'])
      .toBe('/gated/client/t/%28PRD%29%28SlD%29%20Deck.pdf');
  });

  it('reads the recorded hash with a HEAD and restates the metadata when the caller needs a stamp', async () => {
    const calls = recorder((method) => method === 'HEAD'
      ? new Response(null, { headers: { 'x-amz-meta-sha256': 'deadbeef', 'content-type': 'image/webp' } })
      : new Response(COPIED));

    await expect(copyObject(
      'account',
      { creds: CREDS, bucket: 'gated', key: 'client/t/thumbnails/a/c1.webp' },
      { creds: CREDS, bucket: 'gated', key: 'internal/t/thumbnails/a/c1.webp' },
      { wantHash: true },
    )).resolves.toEqual({ ok: true, sha256: 'deadbeef' });

    expect(calls.map(c => c.method)).toEqual(['HEAD', 'PUT']);
    expect(calls[1].headers['x-amz-metadata-directive']).toBe('REPLACE');
    expect(calls[1].headers['x-amz-meta-sha256']).toBe('deadbeef');
    expect(calls[1].headers['content-type']).toBe('image/webp');
    expect(calls[1].headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('falls back to streaming for a legacy object with no recorded hash, healing it', async () => {
    const calls = recorder((method) => {
      if (method === 'HEAD') return new Response(null, { headers: { 'content-type': 'image/webp' } });
      if (method === 'GET') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } });
      return new Response(null, { status: 200 });
    });

    const result = await copyObject(
      'account',
      { creds: CREDS, bucket: 'gated', key: 'client/t/thumbnails/a/c1.webp' },
      { creds: CREDS, bucket: 'gated', key: 'internal/t/thumbnails/a/c1.webp' },
      { wantHash: true },
    );

    expect(result.ok).toBe(true);
    // The hash is computed from the bytes and written, so the object stops being legacy.
    expect(calls.map(c => c.method)).toEqual(['HEAD', 'GET', 'PUT']);
    expect(calls[2].headers['x-amz-meta-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a 404 source as missing rather than as a failure', async () => {
    // Three of four level probes miss by design. Counting those as failures is what jammed the queue.
    recorder(() => new Response(null, { status: 404 }));

    await expect(copyObject(
      'account',
      { creds: CREDS, bucket: 'gated', key: 'guest/t/pages/a/c1/001.webp' },
      { creds: CREDS, bucket: 'gated', key: 'internal/t/pages/a/c1/001.webp' },
    )).resolves.toEqual({ ok: false, reason: 'source missing' });
  });

  it('refuses a 200 that did not actually copy', async () => {
    recorder(() => new Response('<Error><Code>InternalError</Code></Error>'));

    await expect(copyObject(
      'account',
      { creds: CREDS, bucket: 'gated', key: 'client/t/pages/a/c1/001.webp' },
      { creds: CREDS, bucket: 'gated', key: 'internal/t/pages/a/c1/001.webp' },
    )).resolves.toEqual({ ok: false, reason: 'COPY reported no result' });
  });

  it('still streams across the public/gated boundary, where one signature cannot reach both', async () => {
    const calls = recorder((method) => method === 'GET'
      ? new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/webp' } })
      : new Response(null, { status: 200 }));

    const result = await copyObject(
      'account',
      { creds: CREDS, bucket: 'public-bucket', key: 't/thumbnails/a/c1.webp' },
      { creds: CREDS, bucket: 'gated-bucket', key: 'client/t/thumbnails/a/c1.webp' },
      { wantHash: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(calls.map(c => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].headers['x-amz-copy-source']).toBeUndefined();
  });
});
