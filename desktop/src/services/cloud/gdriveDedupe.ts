/* Google Drive duplicate-folder cleanup — the Drive analogue of the CDN garbage collector.
 *
 * Drive addresses folders by id, not by path, and it accepts any number of folders with the same
 * name in the same parent. An export that uploaded 8-wide into a tree that did not exist yet
 * therefore created up to eight copies of every folder level, with the files scattered between them;
 * Google Drive for Desktop mirrors that to the client's laptop as "Deliverables", "Deliverables (1)",
 * "Deliverables (2)"… The uploader no longer creates them (see `gdrive.ts`), and this merges the ones
 * already out there.
 *
 * The shape is deliberately the same as the CDN GC, because the failure mode is the same — an
 * automated sweep over a client's files:
 *
 *   scan     read-only walk → a PLAN of every move and trash, with a `planId` over its contents
 *   execute  re-walks, re-plans, and refuses unless the fresh plan is byte-identical to the one the
 *            operator confirmed
 *
 * Safety rails, each of which exists because its absence loses a client's file:
 *   · never `files.delete` — everything is TRASHED, so a wrong merge is recoverable for 30 days;
 *   · a duplicate folder is trashed only after a FRESH listing shows it empty, at execute time;
 *   · a listing that fails throws: a partial view of a folder reads as "empty enough to delete";
 *   · a name collision between two DIFFERENT files keeps both and reports it — only a byte-identical
 *     copy is dropped;
 *   · the walk stays inside the destination's `remotePath` (plus its same-named duplicates), and
 *     refuses to run at the root of someone's My Drive.
 */

import {
  listGDriveChildren, moveGDriveChild, trashGDriveNode, resolveGDriveFolderPathStrict,
  pickCanonicalGDriveFolder,
  type GDriveChild, type GDriveDuplicateFolderNotice,
} from './gdrive';

/** A folder as walked: its own metadata, its child folders, and its files. */
export interface GDriveTreeNode {
  id:           string;
  name:         string;
  createdTime?: string;
  folders:      GDriveTreeNode[];
  files:        GDriveChild[];
}

export type GDriveDedupeAction =
  | {
      kind: 'move';
      /** The node being re-parented, and both ends of the move — Drive's move is a parent swap. */
      childId: string; childName: string; isFolder: boolean;
      fromId: string; toId: string; path: string;
    }
  | { kind: 'trash-file';   fileId: string;   name: string; path: string; keptId: string }
  | { kind: 'trash-folder'; folderId: string; name: string; path: string };

export interface GDriveDedupeCollision {
  path:       string;
  name:       string;
  keptId:     string;
  otherId:    string;
  /** `kept-both` means the two files differ — nothing is dropped, and the operator is told. */
  resolution: 'trashed-identical-copy' | 'kept-both';
}

export interface GDriveDedupeSet {
  path:                 string;
  name:                 string;
  canonicalId:          string;
  canonicalCreatedTime?: string;
  duplicates:           Array<{ id: string; createdTime?: string }>;
  filesMoved:           number;
  foldersMoved:         number;
  filesTrashed:         number;
  foldersTrashed:       number;
  collisions:           number;
}

export interface GDriveDedupeTotals {
  duplicateSets:    number;
  duplicateFolders: number;
  filesMoved:       number;
  foldersMoved:     number;
  filesTrashed:     number;
  foldersTrashed:   number;
  collisions:       number;
}

export interface GDriveDedupePlan {
  rootPath:       string;
  rootId:         string;
  scannedFolders: number;
  sets:           GDriveDedupeSet[];
  collisions:     GDriveDedupeCollision[];
  actions:        GDriveDedupeAction[];
  warnings:       string[];
  totals:         GDriveDedupeTotals;
  /** Fingerprint of the actions. Execution refuses a plan the operator did not see. */
  planId:         string;
}

export interface GDriveDedupeTarget {
  accessToken:   string;
  remotePath:    string;
  sharedDriveId: string;
}

export interface GDriveDedupeAuditEntry {
  action:  GDriveDedupeAction;
  outcome: 'applied' | 'skipped' | 'failed';
  reason?: string;
  at:      string;
}

export interface GDriveDedupeExecution {
  planId:      string;
  applied:     number;
  skipped:     number;
  failed:      number;
  audit:       GDriveDedupeAuditEntry[];
  completedAt: string;
}

export type GDriveDedupeExecuteResult =
  | { executed: GDriveDedupeExecution; plan: GDriveDedupePlan; refused?: undefined }
  | { refused: string; plan: GDriveDedupePlan; executed?: undefined };

/* A tree this large is not a delivery folder — it is a wrong `remotePath`, and walking it would take
   tens of thousands of requests before doing anything. */
const MAX_SCANNED_FOLDERS = 20_000;

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

/** Two files count as the same bytes only on real evidence. Google-native docs (no md5, no size)
 *  never match, so a Doc collision is always resolved by keeping both. */
function sameContent(a: GDriveChild, b: GDriveChild): boolean {
  if (a.md5Checksum && b.md5Checksum) {
    return a.md5Checksum.toLowerCase() === b.md5Checksum.toLowerCase();
  }
  return Boolean(a.size) && a.size === b.size;
}

/* ── The walk ─────────────────────────────────────────────────────────────── */

export interface GDriveWalkResult {
  node:     GDriveTreeNode;
  scanned:  number;
  warnings: string[];
}

async function walkFolder(
  target:   GDriveDedupeTarget,
  folder:   { id: string; name: string; createdTime?: string },
  path:     string,
  state:    { scanned: number; warnings: string[]; seen: Set<string> },
  onProgress?: (message: string) => void,
): Promise<GDriveTreeNode> {
  // A Drive node can be reachable through more than one parent; a repeat visit would plan the same
  // move twice and count its files twice.
  if (state.seen.has(folder.id)) {
    state.warnings.push(`Folder "${path}" was reached twice (${folder.id}) — visited once.`);
    return { id: folder.id, name: folder.name, createdTime: folder.createdTime, folders: [], files: [] };
  }
  state.seen.add(folder.id);
  state.scanned += 1;
  if (state.scanned > MAX_SCANNED_FOLDERS) {
    throw new Error(`Refusing to scan more than ${MAX_SCANNED_FOLDERS} folders — check the destination's remote path.`);
  }
  onProgress?.(`Reading ${path || folder.name}…`);

  const { folders, files } = await listGDriveChildren(target.accessToken, folder.id, target.sharedDriveId);
  const children: GDriveTreeNode[] = [];
  for (const child of folders) {
    children.push(await walkFolder(target, child, joinPath(path, child.name), state, onProgress));
  }
  return { id: folder.id, name: folder.name, createdTime: folder.createdTime, folders: children, files };
}

/* ── The plan (pure) ──────────────────────────────────────────────────────── */

/**
 * Decide every move and trash needed to leave one folder per name, from a walked tree.
 *
 * Pure and synchronous: given the same tree it produces the same actions in the same order, which is
 * what makes the `planId` check at execute time meaningful. It works on a copy of the tree and
 * simulates each move, so a merge that creates a new same-name situation deeper down is planned in
 * the same pass.
 *
 * `startPath` is the path of `root` itself, so reported paths read the way the operator's remote
 * path does.
 */
export function planGDriveDedupe(
  root:      GDriveTreeNode,
  startPath: string,
  seed: { rootPath?: string; rootId?: string; scannedFolders?: number; warnings?: string[] } = {},
): Omit<GDriveDedupePlan, 'planId'> {
  const tree       = structuredClone(root);
  const actions:    GDriveDedupeAction[] = [];
  const collisions: GDriveDedupeCollision[] = [];
  const sets:       GDriveDedupeSet[] = [];

  function mergeFolder(src: GDriveTreeNode, dst: GDriveTreeNode, path: string, set: GDriveDedupeSet): void {
    for (const file of src.files) {
      const clash = dst.files.find(existing => existing.name === file.name);
      if (clash) {
        set.collisions += 1;
        if (sameContent(clash, file)) {
          collisions.push({ path, name: file.name, keptId: clash.id, otherId: file.id, resolution: 'trashed-identical-copy' });
          actions.push({ kind: 'trash-file', fileId: file.id, name: file.name, path, keptId: clash.id });
          set.filesTrashed += 1;
          continue;
        }
        // Different bytes under one name. Drive allows both, so both stay and the operator decides.
        collisions.push({ path, name: file.name, keptId: clash.id, otherId: file.id, resolution: 'kept-both' });
      }
      actions.push({
        kind: 'move', childId: file.id, childName: file.name, isFolder: false,
        fromId: src.id, toId: dst.id, path,
      });
      dst.files.push(file);
      set.filesMoved += 1;
    }
    src.files = [];

    for (const sub of src.folders) {
      const clash = dst.folders.find(existing => existing.name === sub.name);
      if (clash) {
        // Merge into the copy already inside the canonical folder rather than moving this one next
        // to it — a move would only create the duplicate set one level down. Depth first, so the
        // subfolder is empty (and trashed) before its parent is considered for trashing.
        mergeFolder(sub, clash, joinPath(path, sub.name), set);
        continue;
      }
      actions.push({
        kind: 'move', childId: sub.id, childName: sub.name, isFolder: true,
        fromId: src.id, toId: dst.id, path,
      });
      dst.folders.push(sub);
      set.foldersMoved += 1;
    }
    src.folders = [];

    actions.push({ kind: 'trash-folder', folderId: src.id, name: src.name, path });
    set.foldersTrashed += 1;
  }

  function mergeLevel(node: GDriveTreeNode, path: string): void {
    const byName = new Map<string, GDriveTreeNode[]>();
    for (const child of node.folders) {
      const group = byName.get(child.name);
      if (group) group.push(child);
      else byName.set(child.name, [child]);
    }

    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      const canonical = pickCanonicalGDriveFolder(group)!;
      const dups      = group.filter(folder => folder !== canonical);
      const setPath   = joinPath(path, name);
      const set: GDriveDedupeSet = {
        path: setPath, name,
        canonicalId: canonical.id, canonicalCreatedTime: canonical.createdTime,
        duplicates: dups.map(folder => ({ id: folder.id, createdTime: folder.createdTime })),
        filesMoved: 0, foldersMoved: 0, filesTrashed: 0, foldersTrashed: 0, collisions: 0,
      };
      for (const dup of dups) mergeFolder(dup, canonical, setPath, set);
      node.folders = node.folders.filter(folder => !dups.includes(folder));
      sets.push(set);
    }

    // Only the survivors: a merged duplicate has already been emptied and trashed.
    for (const child of node.folders) mergeLevel(child, joinPath(path, child.name));
  }

  mergeLevel(tree, startPath);

  return {
    rootPath:       seed.rootPath ?? startPath,
    rootId:         seed.rootId ?? root.id,
    scannedFolders: seed.scannedFolders ?? 0,
    sets,
    collisions,
    actions,
    warnings:       seed.warnings ?? [],
    totals: {
      duplicateSets:    sets.length,
      duplicateFolders: sets.reduce((n, set) => n + set.duplicates.length, 0),
      filesMoved:       sets.reduce((n, set) => n + set.filesMoved, 0),
      foldersMoved:     sets.reduce((n, set) => n + set.foldersMoved, 0),
      filesTrashed:     sets.reduce((n, set) => n + set.filesTrashed, 0),
      foldersTrashed:   sets.reduce((n, set) => n + set.foldersTrashed, 0),
      collisions:       collisions.length,
    },
  };
}

async function planFingerprint(value: unknown): Promise<string> {
  const bytes  = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/* ── Scan ─────────────────────────────────────────────────────────────────── */

/**
 * Read-only. Resolves the destination path, walks its subtree, and returns the plan.
 *
 * The scan root is the destination folder *and its own same-named copies* — the top segment of a
 * remote path is created by the same racing walk as every other segment, so "Deliverables" itself is
 * often one of the duplicated levels. Nothing outside that name in that parent is read or touched.
 */
export async function scanGDriveDuplicates(
  target: GDriveDedupeTarget,
  onProgress?: (message: string) => void,
): Promise<GDriveDedupePlan> {
  // Trimmed: a remote path of "  " is an unset field, not a folder named with two spaces.
  const parts = target.remotePath.split('/').map(part => part.trim()).filter(Boolean);
  const sharedDrive = target.sharedDriveId.trim();
  if (!parts.length && !sharedDrive) {
    throw new Error('This destination has no remote path. Refusing to sweep the whole of My Drive — set a remote path first.');
  }

  const state = { scanned: 0, warnings: [] as string[], seen: new Set<string>() };
  const noteDuplicateAncestors = (notices: GDriveDuplicateFolderNotice[]): void => {
    for (const notice of notices) {
      state.warnings.push(
        `"${notice.path}" is itself duplicated (${notice.count} folders). It is above this ` +
        `destination's folder, so it is left alone — this run works inside ${notice.chosenId}.`);
    }
  };

  let root: GDriveTreeNode;
  let startPath: string;
  let rootPath: string;
  let rootId: string;

  if (!parts.length) {
    // Shared Drive root: the drive IS the destination subtree.
    root = await walkFolder(target, { id: sharedDrive, name: '' }, '', state, onProgress);
    startPath = '';
    rootPath  = '(shared drive root)';
    rootId    = sharedDrive;
  } else {
    const leaf       = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent     = await resolveGDriveFolderPathStrict(target.accessToken, parentPath, target.sharedDriveId);
    noteDuplicateAncestors(parent.duplicatePathSegments);

    const children = await listGDriveChildren(target.accessToken, parent.id, target.sharedDriveId);
    const copies   = children.folders.filter(folder => folder.name === leaf);
    if (!copies.length) {
      throw new Error(`Drive folder "${target.remotePath}" does not exist — nothing to clean up under it.`);
    }

    const walked: GDriveTreeNode[] = [];
    for (const copy of copies) {
      walked.push(await walkFolder(target, copy, joinPath(parentPath, leaf), state, onProgress));
    }
    // Synthetic parent holding ONLY the copies of the destination folder: its files and its other
    // children are outside the destination and must stay invisible to the planner.
    root = { id: parent.id, name: parentPath, folders: walked, files: [] };
    startPath = parentPath;
    rootPath  = parts.join('/');
    rootId    = pickCanonicalGDriveFolder(walked)!.id;
  }

  const plan = planGDriveDedupe(root, startPath, {
    rootPath, rootId,
    scannedFolders: state.scanned,
    warnings:       state.warnings,
  });
  return { ...plan, planId: await planFingerprint({ rootId: plan.rootId, actions: plan.actions }) };
}

/* ── Execute ──────────────────────────────────────────────────────────────── */

/**
 * Re-scan, then apply — but only if the fresh plan matches the one the operator confirmed.
 *
 * The re-scan is not a formality: between the preview and the click, another machine's export may
 * have written into a folder this plan wants to trash. Mismatched plan → nothing is touched and the
 * fresh plan comes back for review, exactly as the CDN GC does.
 */
export async function executeGDriveDedupe(
  target:         GDriveDedupeTarget,
  expectedPlanId: string,
  onProgress?:    (message: string) => void,
): Promise<GDriveDedupeExecuteResult> {
  const plan = await scanGDriveDuplicates(target, onProgress);
  if (plan.planId !== expectedPlanId) {
    return {
      refused: 'The Drive folders changed since the preview was generated. Review the fresh preview and confirm again.',
      plan,
    };
  }
  if (!plan.actions.length) {
    return {
      refused: 'Nothing to merge — no duplicate folders remain.',
      plan,
    };
  }

  const audit: GDriveDedupeAuditEntry[] = [];
  const record = (action: GDriveDedupeAction, outcome: GDriveDedupeAuditEntry['outcome'], reason?: string): void => {
    audit.push({ action, outcome, reason, at: new Date().toISOString() });
  };

  let done = 0;
  for (const action of plan.actions) {
    done += 1;
    onProgress?.(`${done}/${plan.actions.length} · ${action.kind} · ${action.path}`);
    try {
      if (action.kind === 'move') {
        await moveGDriveChild(target.accessToken, action.childId, action.fromId, action.toId);
        record(action, 'applied');
      } else if (action.kind === 'trash-file') {
        await trashGDriveNode(target.accessToken, action.fileId);
        record(action, 'applied');
      } else {
        // The last check before anything disappears, against Drive itself rather than the plan: a
        // move that failed above leaves its file here, and this is what notices.
        const remaining = await listGDriveChildren(target.accessToken, action.folderId, target.sharedDriveId);
        const left = remaining.folders.length + remaining.files.length;
        if (left > 0) {
          record(action, 'skipped', `still holds ${left} item(s) — left in place`);
          continue;
        }
        await trashGDriveNode(target.accessToken, action.folderId);
        record(action, 'applied');
      }
    } catch (error) {
      // Keep going: the remaining moves are independent, and a folder whose moves failed simply
      // fails its emptiness check and is left alone.
      record(action, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  return {
    plan,
    executed: {
      planId:      plan.planId,
      applied:     audit.filter(entry => entry.outcome === 'applied').length,
      skipped:     audit.filter(entry => entry.outcome === 'skipped').length,
      failed:      audit.filter(entry => entry.outcome === 'failed').length,
      audit,
      completedAt: new Date().toISOString(),
    },
  };
}
