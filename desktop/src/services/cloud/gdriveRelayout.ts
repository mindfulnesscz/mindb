/* Google Drive re-layout — move a delivered library into its new folder shape, without re-uploading.
 *
 * Changing a destination's `exportLayout` changes where every file belongs. The export alone would
 * handle that the expensive way: upload each file again under its new path and leave the old copy
 * where it is, because the cloud export never deletes. On a real library that is minutes of bytes
 * and a client folder holding two of everything.
 *
 * Drive's move is a PARENT SWAP — one metadata request, no bytes, and the file keeps its id, so
 * every share link, comment and rating pointing at it survives untouched. That is what makes a
 * re-layout affordable: the same 58-file library that costs minutes to re-upload costs a few
 * seconds to re-parent, and nothing is orphaned.
 *
 * The shape is the duplicate-folder cleanup's, deliberately (see ./gdriveDedupe.ts), because the
 * failure mode is the same — an automated sweep over a client's files:
 *
 *   scan     read-only walk → a PLAN of every move, with a `planId` over its contents
 *   execute  re-walks, re-plans, and refuses unless the fresh plan is byte-identical to the
 *            confirmed one
 *
 * Safety rails, each of which exists because its absence loses or misplaces a client's file:
 *   · a file is moved ONLY from a path this machine's upload cache says it delivered. A file the
 *     client put there themselves is reported and left alone, however well its name matches;
 *   · an occupied destination path is never overwritten — the move is skipped and reported;
 *   · nothing is deleted: emptied source folders are TRASHED, and only after a FRESH listing at
 *     execute time shows them empty;
 *   · the destination's own root folder is never trashed, however empty it ends up;
 *   · a listing that fails throws, because a partial view of a folder reads as "already empty".
 */

import {
  listGDriveChildren, moveGDriveChild, trashGDriveNode, resolveGDriveFolderPathStrict,
  ensureGDriveFolderPaths,
  type GDriveChild, type GDriveDuplicateFolderNotice,
} from './gdrive';
import type { CloudFileJob } from '../pipeline/exportNames';
import { remoteNamesFor } from '../pipeline/exportNames';
import type { DestExportLayout } from '../../domain/client';
import type { buildVocabMap } from '@sotto/domain';

/* Same ceiling as the dedupe walk: a tree this large is a wrong `remotePath`, not a delivery
   folder, and walking it would cost tens of thousands of requests before doing anything. */
const MAX_SCANNED_FOLDERS = 20_000;

export interface GDriveRelayoutTarget {
  accessToken:   string;
  remotePath:    string;
  sharedDriveId: string;
  /** Scopes the folder-resolution memo per destination — two destinations may share a path name. */
  destId:        string;
}

/** One file that is delivered somewhere other than where the current layout puts it. */
export interface RelayoutMapping {
  /** Remote path, relative to the destination root, where the last export put it. */
  from: string;
  /** Remote path, relative to the destination root, where the current layout puts it. */
  to:   string;
}

export interface RelayoutMappingResult {
  mappings: RelayoutMapping[];
  /** Already where the current layout wants it. */
  inPlace:  number;
  /** Never delivered to this destination (or delivered by another machine) — the export will
   *  upload these normally; the mover has no record entitling it to touch anything for them. */
  unknown:  string[];
}

export interface RelayoutAction {
  kind:         'move';
  fileId:       string;
  name:         string;
  from:         string;
  to:           string;
  fromFolderId: string;
  /** Destination directory relative to the root; `''` is the root itself. Resolved (and created)
   *  at execute time — a plan cannot carry the id of a folder that does not exist yet. */
  toDir:        string;
}

export interface RelayoutSkip {
  path:   string;
  reason: string;
}

export interface GDriveRelayoutPlan {
  rootPath:       string;
  rootId:         string;
  scannedFolders: number;
  actions:        RelayoutAction[];
  /** Folders left empty by the moves, deepest first. Re-checked against Drive before trashing. */
  prune:          Array<{ folderId: string; path: string }>;
  inPlace:        number;
  skipped:        RelayoutSkip[];
  warnings:       string[];
  totals: {
    moves:   number;
    prune:   number;
    inPlace: number;
    skipped: number;
  };
  planId: string;
}

export interface GDriveRelayoutAuditEntry {
  action:  RelayoutAction | { kind: 'trash-folder'; folderId: string; path: string };
  outcome: 'applied' | 'skipped' | 'failed';
  reason?: string;
  at:      string;
}

export interface GDriveRelayoutExecution {
  planId:      string;
  moved:       number;
  trashed:     number;
  skipped:     number;
  failed:      number;
  /** `from → to` for every applied move, so the caller can re-key its upload cache. */
  applied:     RelayoutMapping[];
  audit:       GDriveRelayoutAuditEntry[];
  completedAt: string;
}

export type GDriveRelayoutExecuteResult =
  | { executed: GDriveRelayoutExecution; plan: GDriveRelayoutPlan; refused?: undefined }
  | { refused: string; plan: GDriveRelayoutPlan; executed?: undefined };

/* ── Which files are in the wrong place (pure) ────────────────────────────── */

/** Every layout a delivered file could be sitting under. Order is the search order. */
const LAYOUT_CANDIDATES: DestExportLayout[] = ['source', 'folders', 'flat'];

/**
 * Compare where each file IS against where the current layout says it belongs.
 *
 * "Where it is" comes from this machine's upload cache rather than from a name search of the remote
 * tree: the cache records the exact path each file was written to, which is both precise and the
 * only evidence that the file at that path is ours to move. A name search would happily match a
 * client's own `01.jpg` in a folder we never wrote to.
 *
 * Nothing here needs to be told the OLD layout. Every layout's path for a file is computable, so
 * the one that has a delivery record IS the old layout — which also means a destination left
 * half-migrated by an interrupted run is planned correctly file by file.
 */
export function planRelayoutMappings(
  jobs:      CloudFileJob[],
  vocabMap:  ReturnType<typeof buildVocabMap>,
  layout:    DestExportLayout,
  delivered: Set<string>,
): RelayoutMappingResult {
  const mappings: RelayoutMapping[] = [];
  const unknown:  string[] = [];
  let inPlace = 0;

  for (const job of jobs) {
    const to = remoteNamesFor(job, vocabMap, layout, '').nestedName;
    if (delivered.has(to)) { inPlace += 1; continue; }

    const from = LAYOUT_CANDIDATES
      .filter(candidate => candidate !== layout)
      .map(candidate => remoteNamesFor(job, vocabMap, candidate, '').nestedName)
      .find(path => path !== to && delivered.has(path));

    if (from) mappings.push({ from, to });
    else unknown.push(to);
  }

  /* Two sources translating to one delivered name is a collision the export already reports; here
     it would plan two moves onto one path, the second of which would be refused at scan time
     anyway. Dropping the duplicates keeps the plan honest about what it will do. */
  const seenTo = new Set<string>();
  const deduped = mappings.filter(mapping => {
    if (seenTo.has(mapping.to)) return false;
    seenTo.add(mapping.to);
    return true;
  });

  return { mappings: deduped, inPlace, unknown };
}

/* ── The walk ─────────────────────────────────────────────────────────────── */

interface WalkedFile {
  child:     GDriveChild;
  parentId:  string;
}

interface WalkedTree {
  /** Rel path (`a/b/file.png`) → the file sitting there. */
  files:       Map<string, WalkedFile>;
  /** Rel path of a folder → its id. */
  folders:     Map<string, string>;
  /** Folder id → its parent's id, for walking back up when pruning. */
  folderParent: Map<string, string>;
  /** Folder id → its rel path, for reporting. */
  folderPath:  Map<string, string>;
  scanned:     number;
  warnings:    string[];
}

async function walkTree(
  target: GDriveRelayoutTarget,
  rootId: string,
  onProgress?: (message: string) => void,
): Promise<WalkedTree> {
  const tree: WalkedTree = {
    files: new Map(), folders: new Map(), folderParent: new Map(), folderPath: new Map(),
    scanned: 0, warnings: [],
  };
  const seen = new Set<string>();

  async function visit(folderId: string, relPath: string): Promise<void> {
    if (seen.has(folderId)) {
      // A Drive node can be reachable through more than one parent; a second visit would index the
      // same file under two paths and plan its move twice.
      tree.warnings.push(`Folder "${relPath || '(root)'}" was reached twice — visited once.`);
      return;
    }
    seen.add(folderId);
    tree.scanned += 1;
    if (tree.scanned > MAX_SCANNED_FOLDERS) {
      throw new Error(`Refusing to scan more than ${MAX_SCANNED_FOLDERS} folders — check the destination's remote path.`);
    }
    onProgress?.(`Reading ${relPath || '(destination root)'}…`);

    const { folders, files } = await listGDriveChildren(target.accessToken, folderId, target.sharedDriveId);
    for (const file of files) {
      const rel = relPath ? `${relPath}/${file.name}` : file.name;
      // First wins, matching the uploader's oldest-wins rule for two files of one name.
      if (!tree.files.has(rel)) tree.files.set(rel, { child: file, parentId: folderId });
    }
    for (const folder of folders) {
      const rel = relPath ? `${relPath}/${folder.name}` : folder.name;
      if (!tree.folders.has(rel)) tree.folders.set(rel, folder.id);
      tree.folderParent.set(folder.id, folderId);
      tree.folderPath.set(folder.id, rel);
      await visit(folder.id, rel);
    }
  }

  await visit(rootId, '');
  tree.folderPath.set(rootId, '');
  return tree;
}

/* ── The plan (pure, given a walked tree) ─────────────────────────────────── */

export function planRelayoutActions(
  tree:     WalkedTree,
  mappings: RelayoutMapping[],
  rootId:   string,
): { actions: RelayoutAction[]; prune: Array<{ folderId: string; path: string }>; skipped: RelayoutSkip[] } {
  const actions: RelayoutAction[] = [];
  const skipped: RelayoutSkip[] = [];
  /** Files this plan will have removed from a folder by the time pruning is considered. */
  const emptied = new Map<string, number>();

  for (const { from, to } of mappings) {
    const found = tree.files.get(from);
    if (!found) {
      // Recorded as delivered but not there: moved by hand, trashed, or delivered from another
      // machine whose cache this is not. The next export uploads it to the new path.
      skipped.push({ path: from, reason: 'not at its recorded path — the next run will upload it' });
      continue;
    }
    if (tree.files.has(to)) {
      skipped.push({ path: to, reason: 'a file is already there — left alone, nothing overwritten' });
      continue;
    }
    const toDir = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    actions.push({
      kind: 'move',
      fileId: found.child.id,
      name: found.child.name,
      from, to,
      fromFolderId: found.parentId,
      toDir,
    });
    emptied.set(found.parentId, (emptied.get(found.parentId) ?? 0) + 1);
  }

  /* A source folder is a prune candidate when this plan empties it — every file it holds is
     moving out and it has no subfolders left behind. Ancestors are then considered the same way,
     deepest first, so `Gallery/Set A` is trashed before `Gallery`. The destination root is never a
     candidate: it is the folder the operator configured, not one we created. */
  const childFolderCount = new Map<string, number>();
  for (const [, parentId] of tree.folderParent) {
    childFolderCount.set(parentId, (childFolderCount.get(parentId) ?? 0) + 1);
  }
  const filesInFolder = new Map<string, number>();
  for (const { parentId } of tree.files.values()) {
    filesInFolder.set(parentId, (filesInFolder.get(parentId) ?? 0) + 1);
  }

  const prune: Array<{ folderId: string; path: string }> = [];
  const pruned = new Set<string>();
  const considerUpwards = (startId: string): void => {
    let id: string | undefined = startId;
    while (id && id !== rootId && !pruned.has(id)) {
      const remainingFiles   = (filesInFolder.get(id) ?? 0) - (emptied.get(id) ?? 0);
      const remainingFolders = (childFolderCount.get(id) ?? 0)
        - [...pruned].filter(p => tree.folderParent.get(p) === id).length;
      if (remainingFiles > 0 || remainingFolders > 0) return;
      pruned.add(id);
      prune.push({ folderId: id, path: tree.folderPath.get(id) ?? '(unknown)' });
      id = tree.folderParent.get(id);
    }
  };
  // Deepest first so a parent is considered only after its children have been marked.
  const sources = [...emptied.keys()].sort(
    (a, b) => (tree.folderPath.get(b) ?? '').split('/').length - (tree.folderPath.get(a) ?? '').split('/').length,
  );
  for (const source of sources) considerUpwards(source);

  return { actions, prune, skipped };
}

async function planFingerprint(value: unknown): Promise<string> {
  const bytes  = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/* ── Scan ─────────────────────────────────────────────────────────────────── */

/** Resolve the destination folder without creating it — a typo in `remotePath` must not mint an
 *  empty folder and then report a spotless, already-migrated tree. */
async function resolveRoot(
  target: GDriveRelayoutTarget,
): Promise<{ id: string; path: string; notices: GDriveDuplicateFolderNotice[] }> {
  const parts = target.remotePath.split('/').map(part => part.trim()).filter(Boolean);
  const sharedDrive = target.sharedDriveId.trim();
  if (!parts.length && !sharedDrive) {
    throw new Error('This destination has no remote path. Refusing to sweep the whole of My Drive — set a remote path first.');
  }
  if (!parts.length) return { id: sharedDrive, path: '(shared drive root)', notices: [] };

  const resolved = await resolveGDriveFolderPathStrict(target.accessToken, parts.join('/'), target.sharedDriveId);
  return { id: resolved.id, path: parts.join('/'), notices: resolved.duplicatePathSegments };
}

/** Read-only. Walks the destination subtree and returns the moves the mappings imply. */
export async function scanGDriveRelayout(
  target:     GDriveRelayoutTarget,
  mappings:   RelayoutMapping[],
  inPlace:    number,
  onProgress?: (message: string) => void,
): Promise<GDriveRelayoutPlan> {
  const root = await resolveRoot(target);
  const tree = await walkTree(target, root.id, onProgress);

  const warnings = [...tree.warnings];
  for (const notice of root.notices) {
    warnings.push(
      `"${notice.path}" is itself duplicated (${notice.count} folders). It is above this ` +
      `destination's folder, so it is left alone — this run works inside ${notice.chosenId}.`);
  }

  const { actions, prune, skipped } = planRelayoutActions(tree, mappings, root.id);

  const plan: Omit<GDriveRelayoutPlan, 'planId'> = {
    rootPath: root.path,
    rootId:   root.id,
    scannedFolders: tree.scanned,
    actions, prune, inPlace, skipped, warnings,
    totals: {
      moves:   actions.length,
      prune:   prune.length,
      inPlace,
      skipped: skipped.length,
    },
  };
  return {
    ...plan,
    planId: await planFingerprint({ rootId: plan.rootId, actions: plan.actions, prune: plan.prune }),
  };
}

/* ── Execute ──────────────────────────────────────────────────────────────── */

/**
 * Re-scan, then apply — but only if the fresh plan matches the one the operator confirmed.
 *
 * The re-scan is not a formality: between the preview and the click, another machine's export may
 * have written into a folder this plan wants to empty and trash.
 *
 * Moves run one at a time rather than 8-wide. They are metadata calls on a tree whose shape the
 * plan already fixed, so the whole thing is seconds either way, and a serial pass means a partial
 * failure leaves a state the next scan can describe exactly.
 */
export async function executeGDriveRelayout(
  target:         GDriveRelayoutTarget,
  mappings:       RelayoutMapping[],
  inPlace:        number,
  expectedPlanId: string,
  onProgress?:    (message: string) => void,
): Promise<GDriveRelayoutExecuteResult> {
  const plan = await scanGDriveRelayout(target, mappings, inPlace, onProgress);
  if (plan.planId !== expectedPlanId) {
    return {
      refused: 'The Drive folders changed since the preview was generated. Review the fresh preview and confirm again.',
      plan,
    };
  }
  if (!plan.actions.length) {
    return { refused: 'Nothing to move — every delivered file is already in its new place.', plan };
  }

  const audit: GDriveRelayoutAuditEntry[] = [];
  const applied: RelayoutMapping[] = [];
  const record = (
    action:  GDriveRelayoutAuditEntry['action'],
    outcome: GDriveRelayoutAuditEntry['outcome'],
    reason?: string,
  ): void => {
    audit.push({ action, outcome, reason, at: new Date().toISOString() });
  };

  /* Every target folder, created once up front and sequentially — the same belt the export uses.
     Drive accepts a second folder of one name in one parent, so eight concurrent moves into a
     not-yet-existing folder is how a destination grows duplicates. */
  const base = target.remotePath.replace(/\/$/, '');
  const dirs = [...new Set(plan.actions.map(action => action.toDir))];
  let folderIds: Map<string, string>;
  try {
    onProgress?.(`Resolving ${dirs.length} destination folder(s)…`);
    folderIds = await ensureGDriveFolderPaths(
      target.accessToken,
      dirs.map(dir => [base, dir].filter(Boolean).join('/')),
      target.sharedDriveId,
      target.destId,
    );
  } catch (error) {
    return {
      refused: `Could not create the destination folders (${error instanceof Error ? error.message : String(error)}) — nothing was moved.`,
      plan,
    };
  }

  let done = 0;
  for (const action of plan.actions) {
    done += 1;
    onProgress?.(`${done}/${plan.actions.length} · ${action.from} → ${action.to}`);
    const toId = folderIds.get([base, action.toDir].filter(Boolean).join('/'));
    if (!toId) {
      record(action, 'failed', 'destination folder could not be resolved');
      continue;
    }
    if (toId === action.fromFolderId) {
      record(action, 'skipped', 'already in the destination folder');
      continue;
    }
    try {
      await moveGDriveChild(target.accessToken, action.fileId, action.fromFolderId, toId);
      applied.push({ from: action.from, to: action.to });
      record(action, 'applied');
    } catch (error) {
      // Keep going: the remaining moves are independent, and a folder whose moves failed simply
      // fails its emptiness check below and is left in place.
      record(action, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  let trashed = 0;
  for (const folder of plan.prune) {
    const entry = { kind: 'trash-folder' as const, folderId: folder.folderId, path: folder.path };
    try {
      // The last check before anything disappears, against Drive itself rather than against the
      // plan: a move that failed above leaves its file here, and this is what notices.
      const remaining = await listGDriveChildren(target.accessToken, folder.folderId, target.sharedDriveId);
      const left = remaining.folders.length + remaining.files.length;
      if (left > 0) {
        record(entry, 'skipped', `still holds ${left} item(s) — left in place`);
        continue;
      }
      await trashGDriveNode(target.accessToken, folder.folderId);
      trashed += 1;
      record(entry, 'applied');
    } catch (error) {
      record(entry, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  return {
    plan,
    executed: {
      planId:  plan.planId,
      moved:   applied.length,
      trashed,
      skipped: audit.filter(e => e.outcome === 'skipped').length,
      failed:  audit.filter(e => e.outcome === 'failed').length,
      applied,
      audit,
      completedAt: new Date().toISOString(),
    },
  };
}

/** Exported for the tests, which build a tree by hand rather than over the network. */
export type { WalkedTree as GDriveRelayoutTree };
export const __test = { walkTree };
