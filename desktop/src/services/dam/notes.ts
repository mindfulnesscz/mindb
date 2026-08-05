/* Obsidian note construction and in-place patching.
 *
 * `patchMeta` edits a note the user may have written in, so two properties matter more than the
 * formatting:
 *   - it must PRESERVE anything it does not own (prose, extra sections, manual links);
 *   - it must report `changed: false` for a no-op, or every run rewrites every note and Obsidian
 *     and git see churn on files nobody touched.
 *
 * The `<!-- dam:key:"value" -->` comments are the ownership marker: those are ours to rewrite,
 * everything else is the user's.
 */

import type { ParsedFilename } from '@dc-hub/domain';
import type { CloudUrlEntry } from '../pipeline/types';
import { toFileUrl } from './paths';

export function makeNote(
  p: ParsedFilename,
  sourceFile: string,
  sourcePath: string,
  exportName: string | null,
  thumbName: string | null,
  outDirPath: string,
  cloudUrls?: CloudUrlEntry[],
): string {
  const today       = new Date().toISOString().split('T')[0];
  const thumbSection = thumbName ? `![[10 ATTACHMENTS/${thumbName}]]\n\n` : '';

  const obsTags: string[] = [];
  for (const t of p.tags) {
    const tag = t.key.trim();
    if (tag && !obsTags.includes(tag)) obsTags.push(tag);
  }
  obsTags.push('dam');
  if (p.error || p.unknownTags.length) obsTags.push('dam/incomplete');
  const inlineTags = obsTags.map(t => `#${t}`).join(' ');

  const rows: [string, string][] = [];
  rows.push(['Version', p.version || '---']);
  rows.push(['Created', today]);
  if (p.yymm) rows.push(['Year / Month', p.yymm]);
  rows.push(['Source', `\`${sourceFile}\``]);
  rows.push(['Location', `[Open in Finder ↗](${toFileUrl(outDirPath)})`]);
  if (exportName) rows.push(['Export name', `\`${exportName}\``]);
  for (const t of p.tags) {
    rows.push([t.slot.charAt(0).toUpperCase() + t.slot.slice(1),
               `${t.icon || ''} ${t.label}`.trim()]);
  }
  if (p.description) rows.push(['Description', p.description]);
  for (const entry of (cloudUrls ?? [])) {
    rows.push([entry.name, `[↗ open](${entry.url})`]);
  }

  const table = '| Field | Value |\n| --- | --- |\n' +
    rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');

  let meta = '';
  if (p.version) meta += `<!-- dam:version:"${p.version}" -->\n`;
  if (exportName) meta += `<!-- dam:export_name:"${exportName}" -->\n`;
  meta += `<!-- dam:source_path:"${sourcePath}" -->\n`;
  meta += `<!-- dam:file_path:"${outDirPath}" -->\n`;

  let warning = '';
  if (p.error) {
    warning = `\n> [!warning] Filename has no bracket tags\n` +
      `> **File:** \`${sourceFile}\`  \n` +
      `> Please rename using \`(Entity)(Angle)(Format)\` convention.\n`;
  } else if (p.unknownTags.length) {
    const ts = p.unknownTags.map(t => `[${t}]`).join(', ');
    warning = `\n> [!note] Unknown tags skipped: ${ts}\n` +
      `> These shortcodes are not in the vocabulary. Add them if needed.\n`;
  }

  return `---\n---\n\n${thumbSection}${inlineTags}\n\n${table}\n\n${meta}${warning}\n#### Notes\n\n`;
}

export function patchMeta(
  content: string,
  p: ParsedFilename,
  sourcePath: string,
  thumbName: string | null,
  outDirPath: string,
  cloudUrls?: CloudUrlEntry[],
): { content: string; changed: boolean } {
  let changed = false;

  function setComment(text: string, key: string, value: string): [string, boolean] {
    const re = new RegExp(`<!--\\s*dam:${key}:"([^"]*)"\\s*-->`);
    const m  = text.match(re);
    if (m) {
      if (m[1] === value) return [text, false];
      return [text.replace(re, `<!-- dam:${key}:"${value}" -->`), true];
    }
    return [text + `<!-- dam:${key}:"${value}" -->\n`, true];
  }

  let c: boolean;
  if (p.version) { [content, c] = setComment(content, 'version', p.version); changed = changed || c; }
  [content, c] = setComment(content, 'source_path', sourcePath); changed = changed || c;
  [content, c] = setComment(content, 'file_path', outDirPath);   changed = changed || c;

  if (thumbName) {
    const thumbLine = `![[10 ATTACHMENTS/${thumbName}]]`;
    if (content.includes('![[10 ATTACHMENTS/')) {
      const next = content.replace(/!\[\[10 ATTACHMENTS\/[^\]]+\]\]/, thumbLine);
      if (next !== content) { content = next; changed = true; }
    } else {
      const next = content.replace(/(---\n\n)(\s*#)/, `$1${thumbLine}\n\n$2`);
      if (next !== content) { content = next; changed = true; }
    }
  }

  // Patch cloud URL rows in the table
  if (cloudUrls?.length) {
    const tableStart = content.indexOf('| Field | Value |');
    if (tableStart !== -1) {
      let tableEnd = content.indexOf('\n\n', tableStart);
      if (tableEnd === -1) tableEnd = content.length;
      else tableEnd += 1; // include first \n of \n\n so slice boundary is clean

      let block = content.slice(tableStart, tableEnd);
      for (const entry of cloudUrls) {
        const newRow = `| ${entry.name} | [↗ open](${entry.url}) |`;
        const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rowRe   = new RegExp(`\\| ${escaped} \\| [^\\n]+ \\|`);
        if (rowRe.test(block)) {
          const updated = block.replace(rowRe, newRow);
          if (updated !== block) { block = updated; changed = true; }
        } else {
          const trimmed = block.trimEnd();
          block = trimmed + `\n${newRow}` + block.slice(trimmed.length);
          changed = true;
        }
      }
      if (changed) {
        content = content.slice(0, tableStart) + block + content.slice(tableEnd);
      }
    }
  }

  return { content, changed };
}

/* ── Gallery folder detection ───────────────────────────────────────────── */
