import { describe, expect, it } from 'vitest';
import {
  indexCdnKeyReferences, inspectCdnKeyReferences, objectKeyFromReference,
} from './cdnReferences';

describe('CDN live-row references', () => {
  it('indexes shared URL and raw-key references by their owning stable identities', () => {
    const key = 'client/client-1/originals/stable/c1.pdf';
    const references = indexCdnKeyReferences([
      {
        stable_id: 'stable', child_id: 'c1',
        download_url: `https://files.example.com/${key}?v=abc`,
      },
      {
        stable_id: 'stable', child_id: 'gallery-parent',
        download_key: key,
      },
    ]);

    expect(references.get(key)).toEqual(new Set(['stable:c1', 'stable:gallery-parent']));
  });

  it('decodes URL paths and rejects malformed URL references', () => {
    expect(objectKeyFromReference('https://cdn.example.com/client%20one/thumb.webp?v=1'))
      .toBe('client one/thumb.webp');
    expect(objectKeyFromReference('https://%')).toBeNull();
  });

  it('marks the index incomplete when a stored non-empty reference cannot be parsed', () => {
    const result = inspectCdnKeyReferences([{
      stable_id: 'stable', child_id: 'c1', thumbnail_url: 'https://%',
    }]);

    expect(result.complete).toBe(false);
    expect(result.references.size).toBe(0);
  });
});
