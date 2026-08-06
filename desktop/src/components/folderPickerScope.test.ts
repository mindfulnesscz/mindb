/* Every folder picker must ask Tauri for a RECURSIVE scope grant.
 *
 * `open({ directory: true })` without `recursive` makes Tauri call
 * `fs_scope().allow_directory(path, false)`, which grants only `<dir>` and `<dir>/*`. Everything
 * deeper is then refused by `path_policy` — and a source folder is always deeper than one level
 * (project / shoot / OUT / asset). That shipped in 3.2.1 as "Refusing checksum source outside
 * Sotto's approved working directories" on a fresh install, with the whole pipeline erroring out.
 *
 * This is a source-level test rather than a component test on purpose: the bug was one call site
 * out of three forgetting the flag, so the thing worth guarding is that NO call site can forget it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** The `open({...})` argument object containing a given `directory: true`. */
function enclosingCall(source: string, index: number): string {
  const start = source.lastIndexOf('{', index);
  const end = source.indexOf('}', index);
  return source.slice(start === -1 ? index : start, end === -1 ? index : end + 1);
}

describe('folder picker scope grants', () => {
  const callSites = sourceFiles(SRC).flatMap(file => {
    const source = readFileSync(file, 'utf8');
    const sites: { file: string; call: string }[] = [];
    for (let i = source.indexOf('directory: true'); i !== -1; i = source.indexOf('directory: true', i + 1)) {
      sites.push({ file: file.slice(SRC.length), call: enclosingCall(source, i) });
    }
    return sites;
  });

  it('finds the folder pickers, so the scan itself cannot silently pass', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(3);
  });

  it.each(callSites.map(s => [s.file, s.call] as const))(
    'grants the whole subtree in %s',
    (_file, call) => {
      expect(call).toContain('recursive: true');
    },
  );
});
