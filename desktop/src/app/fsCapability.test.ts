/* The filesystem capability is a security decision, so it gets a test rather than a code review.
 *
 * Its history is the argument for one: S5 replaced a static scope with runtime-only grants and broke
 * every out-of-appdata write; the stopgap put a machine-wide `**` back; 3.2.2 settled on $HOME plus
 * /Volumes. Each of those was a one-line edit to a JSON file nobody diffs carefully.
 *
 * Two ways this regresses, and both are caught here: widening back to `**`, and dropping
 * `requireLiteralLeadingDot: false` — which lives in the PLUGIN config, not the capability, and
 * whose absence silently stops the globs matching `.dchub.json` (the asset identity manifest) on
 * unix, where the plugin default is true.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));

const capability = read('../../src-tauri/capabilities/default.json');
const tauriConf = read('../../src-tauri/tauri.conf.json');

interface ScopeEntry { path: string }
interface PermissionEntry { identifier: string; allow?: ScopeEntry[] }

const permissions: (string | PermissionEntry)[] = capability.permissions;
const scoped = permissions.filter((p): p is PermissionEntry => typeof p === 'object');

describe('filesystem capability', () => {
  it('scopes the fs commands through a single global fs:scope entry', () => {
    const fsScopes = scoped.filter(p => p.identifier === 'fs:scope');
    expect(fsScopes).toHaveLength(1);
    expect(fsScopes[0].allow?.map(a => a.path).sort()).toEqual(
      ['$APPDATA/**', '$HOME/**', '/Volumes/**'],
    );
  });

  it('grants no machine-wide path', () => {
    const paths = scoped.flatMap(p => p.allow?.map(a => a.path) ?? []);
    expect(paths).not.toContain('**');
    for (const path of paths) {
      // Every root must be anchored — a bare glob or a `/**` would put / back in scope.
      expect(path === '/**' || !path.startsWith('**')).toBe(true);
    }
  });

  it('keeps requireLiteralLeadingDot false, or the globs miss .dchub.json', () => {
    expect(tauriConf.plugins?.fs?.requireLiteralLeadingDot).toBe(false);
  });

  it('still declares every fs command the desktop imports', () => {
    // Kept in step with the `@tauri-apps/plugin-fs` imports under desktop/src.
    const required = [
      'fs:allow-copy-file', 'fs:allow-exists', 'fs:allow-mkdir', 'fs:allow-read-dir',
      'fs:allow-read-file', 'fs:allow-read-text-file', 'fs:allow-remove', 'fs:allow-rename',
      'fs:allow-stat', 'fs:allow-write-text-file',
    ];
    const declared = new Set(permissions.map(p => (typeof p === 'string' ? p : p.identifier)));
    for (const permission of required) expect(declared).toContain(permission);
  });
});
