import { afterEach, describe, expect, it, vi } from 'vitest';
import { listObjects, type TempCreds } from './r2.ts';

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
