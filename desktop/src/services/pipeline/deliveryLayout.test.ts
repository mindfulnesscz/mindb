/* The source→delivered path rules, at the edges the pipeline suites cannot reach cheaply.
 *
 * The behavioural guarantee — that `deliveredRelDir` agrees with what `runPublish` actually writes
 * — lives in services/pipelineExportLayout.test.ts, which runs both stages. These are the shapes
 * that reach the function when something upstream is unusual. */

import { describe, it, expect } from 'vitest';
import { deliveredRelDir, nestedPublishRel, sourceRelativeSegments } from './deliveryLayout';
import { makeSettings } from '../../test/pipelineHarness';

const S = makeSettings();          // outFolder '[03] OUT', packagePrefix '[00] 📦'
const SRC = '/src';

describe('deliveredRelDir', () => {
  it('drops the OUT segment and the identity suffix above it', () => {
    expect(deliveredRelDir(SRC, `${SRC}/01 Works/Batch I __a1111111/[03] OUT/x.png`, S))
      .toBe('01 Works/Batch I');
  });

  it('keeps a gallery folder below OUT verbatim — it is the client-visible name', () => {
    expect(deliveredRelDir(SRC, `${SRC}/Ascension __b2222222/[03] OUT/(Gll) Studio/01.jpg`, S))
      .toBe('Ascension/(Gll) Studio');
  });

  it('returns the root for a file directly inside a source-root OUT folder', () => {
    expect(deliveredRelDir(SRC, `${SRC}/[03] OUT/x.png`, S)).toBe('');
  });

  it('accepts the workflow-prefixed and bare spellings of the OUT folder', () => {
    // isOutFolder strips the `[03] ` prefix, so a library using plain `OUT` maps identically.
    expect(deliveredRelDir(SRC, `${SRC}/Set __c3333333/OUT/x.png`, S)).toBe('Set');
  });

  it('never invents a folder when the path has no OUT segment', () => {
    // Not reachable from the scan (it only collects inside OUT), so the answer just has to be
    // harmless: keep the folders, strip identity, add nothing.
    expect(deliveredRelDir(SRC, `${SRC}/Loose __d4444444/x.png`, S)).toBe('Loose');
  });

  it('is not confused by a source root with a trailing slash or backslashes', () => {
    expect(deliveredRelDir(`${SRC}/`, `${SRC}/A __a1111111/[03] OUT/x.png`, S)).toBe('A');
    expect(deliveredRelDir(SRC, `${SRC}\\A __a1111111\\[03] OUT\\x.png`, S)).toBe('A');
  });

  it('falls back to a case-insensitive prefix match when the root drifted', () => {
    // The publish and cloud stages both receive paths that have been through a folder picker and
    // a Rust canonicalisation; a case difference must not silently flatten the tree.
    expect(deliveredRelDir('/SRC', `${SRC}/A __a1111111/[03] OUT/x.png`, S)).toBe('A');
  });
});

describe('sourceRelativeSegments / nestedPublishRel', () => {
  it('returns nothing for the root itself', () => {
    expect(sourceRelativeSegments(SRC, SRC)).toEqual([]);
    expect(nestedPublishRel(SRC, SRC)).toBe('');
  });

  it('strips the identity suffix from every segment of a package path', () => {
    expect(nestedPublishRel(SRC, `${SRC}/01 Works/Batch I __a1111111/[00] 📦 Pickup`))
      .toBe('01 Works/Batch I/[00] 📦 Pickup');
  });

  it('drops empty segments from doubled slashes', () => {
    expect(sourceRelativeSegments(SRC, `${SRC}//A//B`)).toEqual(['A', 'B']);
  });
});
