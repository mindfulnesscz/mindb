/* Writing the Obsidian canvas for a note folder.
 *
 * Node ids come from `stableId(path)`, so an asset keeps its node across runs and the board does not
 * reshuffle. Nodes NOT under the current scope are preserved verbatim, so a user's own canvas additions
 * survive a rebuild.
 */

import {
  writeTextFile, readTextFile, mkdir,
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { LogType } from '../../store/pipelineStore';
import {
  relativeTo, pathParts, pathSortKey, compareSortKeys, stableId,
} from './paths';
import {
  CANVAS_W, CANVAS_H, CANVAS_GAP, CELL_W, CELL_H, BASE_H_GAP, DEFAULT_COLS, MAX_ROWS_PER_COL, LABEL_H, NOTE_Y_OFFSET,
} from './canvasLayout';
import {
  listDir, fileExists,
} from './fs';

export async function updateDamCanvas(
  noteFolder: string,
  canvasDir: string,
  vault: string,
  noteSourceMap: Map<string, [string[], string[]]>,
  appendLog: (t: LogType, m: string) => void,
): Promise<string | null> {
  // Recursively collect all .md notes under noteFolder (scope root)
  const allNotes: Array<{ absPath: string; name: string }> = [];
  async function collectNotes(dir: string) {
    const es = await listDir(dir);
    for (const e of es) {
      const childPath = await join(dir, e.name);
      if (e.isDirectory && !e.name.startsWith('.')) {
        await collectNotes(childPath);
      } else if (e.isFile && e.name.endsWith('.md') && !e.name.startsWith('🚫') && !e.name.startsWith('_X ')) {
        allNotes.push({ absPath: childPath, name: e.name });
      }
    }
  }
  await collectNotes(noteFolder);
  if (!allNotes.length) return null;

  // Canvas files live flat in canvasDir (DAM root), one per scope — not nested with notes.
  const fn = noteFolder.split('/').pop()!;
  const label = fn.replace(/^\[\d+\]\s*/, '') || fn;
  await mkdir(canvasDir, { recursive: true }).catch(() => {});
  const topEntries = await listDir(canvasDir);
  const existing = topEntries.find(
    e => e.isFile && e.name.endsWith('.canvas') && e.name.startsWith(`_X ${label}`),
  );
  let cols = DEFAULT_COLS;
  let canvasPath: string;
  if (existing) {
    const m = existing.name.match(/-c(\d+)/);
    if (m) cols = parseInt(m[1], 10);
    canvasPath = await join(canvasDir, existing.name);
  } else {
    canvasPath = await join(canvasDir, `_X ${label} -c3.canvas`);
  }

  const noteFolderRel = relativeTo(noteFolder, vault);

  // Resolve (clusterKey, sortKey) for each note using its absolute path
  async function getSrc(absPath: string): Promise<[string[], string[]]> {
    if (noteSourceMap.has(absPath)) return noteSourceMap.get(absPath)!;
    try {
      const text = await readTextFile(absPath);
      const m    = text.match(/<!--\s*dam:source_path:"([^"]*)"\s*-->/);
      if (m && m[1]) { const p = pathParts(m[1]); return [p, p]; }
    } catch { /* ignore */ }
    return [[], []];
  }

  const notesWithSrc: Array<{ absPath: string; name: string; ck: string[]; sk: string[] }> = [];
  for (const { absPath, name } of allNotes) {
    const [ck, sk] = await getSrc(absPath);
    notesWithSrc.push({ absPath, name, ck, sk });
  }

  notesWithSrc.sort((a, b) => {
    const r1 = compareSortKeys(pathSortKey(a.ck), pathSortKey(b.ck));
    if (r1 !== 0) return r1;
    const r2 = compareSortKeys(pathSortKey(a.sk), pathSortKey(b.sk));
    if (r2 !== 0) return r2;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  // Group into clusters
  const clusters: Array<{ key: string[]; notes: Array<{ absPath: string; name: string; sk: string[] }> }> = [];
  for (const n of notesWithSrc) {
    const last = clusters[clusters.length - 1];
    if (last && JSON.stringify(last.key) === JSON.stringify(n.ck)) {
      last.notes.push({ absPath: n.absPath, name: n.name, sk: n.sk });
    } else {
      clusters.push({ key: n.ck, notes: [{ absPath: n.absPath, name: n.name, sk: n.sk }] });
    }
  }

  clusters.sort((a, b) => {
    if (!a.key.length && b.key.length) return -1;
    if (a.key.length && !b.key.length) return 1;
    return compareSortKeys(pathSortKey(a.key), pathSortKey(b.key));
  });

  // Preserve non-note nodes from existing canvas (keep anything not under this scope)
  const preservedNodes: object[] = [];
  let edges: object[] = [];
  if (await fileExists(canvasPath)) {
    try {
      const data = JSON.parse(await readTextFile(canvasPath)) as {
        nodes?: Array<{ type: string; file?: string; [k: string]: unknown }>;
        edges?: object[];
      };
      edges = data.edges ?? [];
      for (const node of (data.nodes ?? [])) {
        if (node.type === 'file') {
          const f = node.file as string;
          if (!f.startsWith(noteFolderRel + '/') && f !== noteFolderRel) preservedNodes.push(node);
        } else if (node.type === 'text' && (node.color as string) === '#000000') {
          // auto-generated cluster labels — drop and regenerate
        } else {
          preservedNodes.push(node);
        }
      }
    } catch { /* start fresh */ }
  }

  // Layout — canvas file references are vault-relative paths of each note
  const noteNodes: object[] = [];
  let xCursor = 0;
  let prevKey: string[] | null = null;
  let prevClusterCols = cols;

  for (const cluster of clusters) {
    if (prevKey !== null) {
      let common = 0;
      const minLen = Math.min(prevKey.length, cluster.key.length);
      for (let i = 0; i < minLen; i++) { if (prevKey[i] === cluster.key[i]) common++; else break; }
      const maxDepth = Math.max(prevKey.length, cluster.key.length, 1);
      xCursor += prevClusterCols * CELL_W + BASE_H_GAP * (maxDepth - common);
    }

    // Group by sk within cluster
    const skMap = new Map<string, Array<{ absPath: string; name: string }>>();
    for (const { absPath, name, sk } of cluster.notes) {
      const k = JSON.stringify(sk);
      if (!skMap.has(k)) skMap.set(k, []);
      skMap.get(k)!.push({ absPath, name });
    }
    const sortedSks = [...skMap.keys()].sort((a, b) =>
      compareSortKeys(pathSortKey(JSON.parse(a)), pathSortKey(JSON.parse(b)))
    );
    const hasMulti = sortedSks.some(sk => skMap.get(sk)!.length >= 2);

    if (!hasMulti) {
      /* Simple cluster: fill top-down first, wrap to next column after MAX_ROWS_PER_COL rows */
      const cNotes = cluster.notes;
      const numCols = Math.max(1, Math.ceil(cNotes.length / MAX_ROWS_PER_COL));
      prevClusterCols = numCols;

      // Cluster label spanning all columns
      const labelText = '# ' + (cluster.key.length
        ? cluster.key[cluster.key.length - 1].replace(/^\[\d+\]\s*/, '')
        : '(root)');
      const labelId = stableId(`label:${JSON.stringify(cluster.key)}`);
      noteNodes.push({
        id: labelId, type: 'text', text: labelText,
        x: xCursor, y: 0,
        width: numCols * CELL_W - CANVAS_GAP, height: LABEL_H,
        color: '#000000',
      });

      cNotes.forEach(({ absPath }, i) => {
        const file = relativeTo(absPath, vault);
        noteNodes.push({
          id: stableId(file), type: 'file', file,
          x: xCursor + Math.floor(i / MAX_ROWS_PER_COL) * CELL_W,
          y: NOTE_Y_OFFSET + (i % MAX_ROWS_PER_COL) * CELL_H,
          width: CANVAS_W, height: CANVAS_H,
        });
      });
    } else {
      /* Mixed layout: each multi-asset sort_key group gets ceil(count/MAX_ROWS) dedicated
         columns so no column grows taller than MAX_ROWS_PER_COL notes. */
      const colAssign = new Map<string, number>(); // sk → base column index
      let colCounter = 0, singlesCol: number | null = null;
      for (const sk of sortedSks) {
        const count = skMap.get(sk)!.length;
        if (count >= 2) {
          colAssign.set(sk, colCounter);
          colCounter += Math.max(1, Math.ceil(count / MAX_ROWS_PER_COL));
        } else {
          if (singlesCol === null) singlesCol = colCounter++;
          colAssign.set(sk, singlesCol);
        }
      }
      prevClusterCols = colCounter;

      // Cluster label spanning all columns
      const labelText = '# ' + (cluster.key.length
        ? cluster.key[cluster.key.length - 1].replace(/^\[\d+\]\s*/, '')
        : '(root)');
      const labelId = stableId(`label:${JSON.stringify(cluster.key)}`);
      noteNodes.push({
        id: labelId, type: 'text', text: labelText,
        x: xCursor, y: 0,
        width: colCounter * CELL_W - CANVAS_GAP, height: LABEL_H,
        color: '#000000',
      });

      const skPos    = new Map<string, number>(); // position within each multi-item sk group
      let singlesPos = 0;                         // shared counter for all single-item sk groups
      for (const { absPath, sk } of cluster.notes) {
        const skKey   = JSON.stringify(sk);
        const baseCol = colAssign.get(skKey) ?? 0;
        const isMulti = (skMap.get(skKey)?.length ?? 0) >= 2;
        let inGroupIdx: number;
        if (isMulti) {
          inGroupIdx = skPos.get(skKey) ?? 0;
          skPos.set(skKey, inGroupIdx + 1);
        } else {
          inGroupIdx = singlesPos++;
        }
        const file = relativeTo(absPath, vault);
        noteNodes.push({
          id: stableId(file), type: 'file', file,
          x: xCursor + (baseCol + Math.floor(inGroupIdx / MAX_ROWS_PER_COL)) * CELL_W,
          y: NOTE_Y_OFFSET + (inGroupIdx % MAX_ROWS_PER_COL) * CELL_H,
          width: CANVAS_W, height: CANVAS_H,
        });
      }
    }

    prevKey = cluster.key;
  }

  try {
    await writeTextFile(canvasPath, JSON.stringify({ nodes: [...preservedNodes, ...noteNodes], edges }, null, 2));
    appendLog('success', `  🗺  canvas: ${relativeTo(canvasPath, vault)}`);
    return canvasPath;
  } catch (e) {
    appendLog('error', `  ✗  Canvas write failed: ${e}`);
    return null;
  }
}
