/* The artifact layout contract: one `thumbnails/` folder beside the files it serves.

   Two things are pinned here. First, that `isPreviewArtifact` excludes the folder as a UNIT —
   every walker applies it before branching on file-vs-directory, and the page files inside carry
   no marker of their own, so a miss here publishes `001.webp` to a client as an asset. Second,
   that the target paths are composed in exactly one place: the pipeline, the CDN upload and the
   DAM each construct these paths, and a fourth copy of the rule is how they drift apart. */

import { describe, it, expect } from 'vitest';
import {
  THUMBNAILS_DIR, PAGES_MANIFEST, isPreviewArtifact, thumbName, artifactDir,
  thumbPathFor, pagesDirFor, pagesManifestPath, legacyArtifactMove,
} from './artifactLayout';

const OUT = '/src/Chair __a1b2c3d4/[03] OUT';

describe('isPreviewArtifact', () => {
  it('excludes the artifacts folder by name, so a walker never descends into it', () => {
    expect(isPreviewArtifact(THUMBNAILS_DIR)).toBe(true);
  });

  it('still excludes the pre-3.2.2 loose artifacts, as the migration safety net', () => {
    expect(isPreviewArtifact('Deck v2-thumb.webp')).toBe(true);
    expect(isPreviewArtifact('Deck v2-thumb.webp.json')).toBe(true);
    expect(isPreviewArtifact('Deck v2-thumb')).toBe(true);
  });

  it('lets real assets through, including a gallery folder', () => {
    expect(isPreviewArtifact('Chair-front-v1.jpg')).toBe(false);
    expect(isPreviewArtifact('Selected')).toBe(false);
    // The page files inside a previews folder are ordinary names — which is exactly why the
    // FOLDER has to be the thing that is excluded.
    expect(isPreviewArtifact('001.webp')).toBe(false);
    expect(isPreviewArtifact(PAGES_MANIFEST)).toBe(false);
  });
});

describe('artifact paths', () => {
  it('puts the thumbnail and the page previews in the same folder, beside the assets', () => {
    expect(artifactDir(OUT)).toBe(`${OUT}/thumbnails`);
    expect(thumbPathFor(OUT, 'Deck v2')).toBe(`${OUT}/thumbnails/Deck v2-thumb.webp`);
    expect(pagesDirFor(OUT, 'Deck v2')).toBe(`${OUT}/thumbnails/Deck v2`);
    expect(pagesManifestPath(pagesDirFor(OUT, 'Deck v2')))
      .toBe(`${OUT}/thumbnails/Deck v2/.pages.json`);
  });

  it('accepts a directory given with a trailing slash — callers slice paths both ways', () => {
    expect(thumbPathFor(`${OUT}/`, 'Hero v1')).toBe(`${OUT}/thumbnails/Hero v1-thumb.webp`);
    expect(pagesDirFor(`${OUT}/`, 'Hero v1')).toBe(`${OUT}/thumbnails/Hero v1`);
  });

  it('keeps `-thumb` in the thumbnail filename', () => {
    // Location is authoritative now, but the suffix is what keeps every legacy substring filter
    // working through the migration. Dropping it is a separate decision.
    expect(thumbName('Hero v1')).toBe('Hero v1-thumb.webp');
  });

  it('gives a gallery folder its own artifacts folder rather than sharing OUT\'s', () => {
    expect(thumbPathFor(`${OUT}/Selected`, 'Hero v1'))
      .toBe(`${OUT}/Selected/thumbnails/Hero v1-thumb.webp`);
  });
});

describe('legacyArtifactMove', () => {
  it('moves a loose thumbnail into thumbnails/, name unchanged', () => {
    expect(legacyArtifactMove('Deck v2-thumb.webp', false)).toEqual({
      from: 'Deck v2-thumb.webp',
      to: 'thumbnails/Deck v2-thumb.webp',
      kind: 'thumbnail',
    });
  });

  it('hides the render cache on the way in', () => {
    // The cache ends `-thumb.webp.json`, so it has to be classified before the thumbnail itself —
    // otherwise it matches as a thumbnail and lands visible under the wrong name.
    expect(legacyArtifactMove('Deck v2-thumb.webp.json', false)).toEqual({
      from: 'Deck v2-thumb.webp.json',
      to: 'thumbnails/.Deck v2-thumb.webp.json',
      kind: 'thumbnail-cache',
    });
  });

  it('does not double-dot a cache that is already hidden but still in the wrong place', () => {
    expect(legacyArtifactMove('.Deck v2-thumb.webp.json', false)?.to)
      .toBe('thumbnails/.Deck v2-thumb.webp.json');
  });

  it('drops the -thumb suffix from the previews folder, which no longer earns it', () => {
    expect(legacyArtifactMove('Deck v2-thumb', true)).toEqual({
      from: 'Deck v2-thumb',
      to: 'thumbnails/Deck v2',
      kind: 'pages',
    });
  });

  it('claims nothing else — a real asset must never be moved', () => {
    expect(legacyArtifactMove('Chair-front-v1.jpg', false)).toBeNull();
    expect(legacyArtifactMove('Deck v2.pptx', false)).toBeNull();
    expect(legacyArtifactMove('Selected', true)).toBeNull();
    // A file that merely mentions thumbnails is not one.
    expect(legacyArtifactMove('thumbnail-notes.md', false)).toBeNull();
  });

  it('leaves an already-migrated folder alone, so the migration is idempotent', () => {
    expect(legacyArtifactMove(THUMBNAILS_DIR, true)).toBeNull();
  });
});
