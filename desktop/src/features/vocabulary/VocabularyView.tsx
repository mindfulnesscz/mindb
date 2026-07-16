import { useState } from 'react';
import { ChevronRight, Pencil, Trash2, Check, Plus, Search, X, FolderOpen, Upload, Download } from 'lucide-react';
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  type Slot, type VocabTag,
  SLOT_LABELS, parentGroupsForSlot,
  buildFilenameCode, buildObsidianTags,
} from '../../domain/vocabulary';
import { generateStableId, appendStableId } from '../../domain/stableId';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { useClientStore } from '../../store/clientStore';
import { saveClients } from '../../services/clientService';
import { createDraftAsset, fetchExistingStableIds, syncTagsFromVocabulary } from '../../services/supabaseService';
import { loadVocabulary, saveVocabulary } from '../../services/vocabService';
import { writeReadme, README_FILENAME } from '../../services/readmeService';
import { FolderTargetPicker } from '../../components/FolderTargetPicker';
import { TagModal } from './TagModal';
import css from './VocabularyView.module.css';

const SLOTS: Slot[] = ['entity', 'angle', 'format'];

interface VersionState { major: string; minor: string; patch: string }

// SHA-256 of an empty byte array — a well-known constant, no need to compute it. The
// placeholder file seeded into OUT starts empty, so this is its correct manifest hash
// until the real deliverable replaces it.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function VocabularyView() {
  const { data, deleteTag, setData, markClean } = useVocabularyStore();
  const allTags = data?.tags ?? [];
  const dirty = useVocabularyStore(s => s.dirty);

  const { clients, activeClientId, updateClient } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;

  /* Vocabulary state */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [modalOpen,  setModalOpen]  = useState(false);
  const [modalSlot,  setModalSlot]  = useState<Slot>('entity');
  const [editIndex,  setEditIndex]  = useState<number | undefined>(undefined);
  const [search,     setSearch]     = useState('');
  const [publishing, setPublishing] = useState(false);
  const [reloading,  setReloading]  = useState(false);
  const [syncMsg,    setSyncMsg]    = useState<string | null>(null);
  const [syncError,  setSyncError]  = useState<string | null>(null);

  /* Generator state */
  const [selected,     setSelected]     = useState<Map<string, VocabTag>>(new Map());
  const [description,  setDescription]  = useState('');
  const [version,      setVersion]      = useState<VersionState>({ major: '', minor: '', patch: '' });
  const [copied,       setCopied]        = useState(false);

  /* Seed-folder state */
  const [folderName,     setFolderName]     = useState('');
  const [targetFolder,   setTargetFolder]   = useState(activeClient?.lastCreationFolder ?? '');
  const [creating,       setCreating]       = useState(false);
  const [createError,    setCreateError]    = useState<string | null>(null);
  const [createSuccess,  setCreateSuccess]  = useState<string | null>(null);
  const [createdDir,     setCreatedDir]     = useState<string | null>(null);

  function toggleGroup(key: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleTag(tag: VocabTag) {
    setSelected(prev => {
      const next = new Map(prev);
      next.has(tag.shortcode) ? next.delete(tag.shortcode) : next.set(tag.shortcode, tag);
      return next;
    });
  }

  function openAdd(slot: Slot) {
    setModalSlot(slot);
    setEditIndex(undefined);
    setModalOpen(true);
  }

  function openEdit(globalIdx: number, slot: Slot) {
    setModalSlot(slot);
    setEditIndex(globalIdx);
    setModalOpen(true);
  }

  function handleDelete(globalIdx: number) {
    const tag = data?.tags[globalIdx];
    if (!tag) return;
    if (confirm(`Delete "${tag.shortcode} — ${tag.label}"?\nThis cannot be undone.`)) {
      deleteTag(globalIdx);
      setSelected(prev => { const next = new Map(prev); next.delete(tag.shortcode); return next; });
    }
  }

  function clearGenerator() {
    setSelected(new Map());
    setDescription('');
    setVersion({ major: '', minor: '', patch: '' });
  }

  async function handlePublish() {
    if (!activeClient || !data) return;
    if (!activeClient.supabaseUrl || !activeClient.supabaseAnonKey) {
      setSyncError('Client has no Supabase connection.');
      return;
    }
    if (!window.confirm(
      `Publish ${data.tags.length} local tag(s) to the portal for "${activeClient.name}"?\n\n` +
      'This upserts groups and leaves, and removes portal shortcoded tags that are no longer in your local vocabulary.',
    )) return;

    setPublishing(true);
    setSyncMsg(null);
    setSyncError(null);
    const lines: string[] = [];
    try {
      const result = await syncTagsFromVocabulary(
        data,
        activeClient.id,
        { url: activeClient.supabaseUrl, anonKey: activeClient.supabaseAnonKey },
        (_type, msg) => { lines.push(msg); },
      );
      markClean();
      await saveVocabulary({ ...data, _unpublished: false }, activeClient.id).catch(console.warn);
      setSyncMsg(`Published: ${result.created} created · ${result.updated} updated · ${result.deleted} deleted`);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
      if (lines.length) console.warn(lines.join('\n'));
    } finally {
      setPublishing(false);
    }
  }

  async function handleReloadFromPortal() {
    if (!activeClientId) return;
    if (!window.confirm(
      'Reload tags from the portal?\n\nThis replaces your local vocabulary cache for this client. Unpublished local edits will be lost.',
    )) return;

    setReloading(true);
    setSyncMsg(null);
    setSyncError(null);
    try {
      const fresh = await loadVocabulary(activeClientId, { forceFromDb: true });
      setData(fresh, { dirty: false });
      setSyncMsg(`Reloaded ${fresh.tags.length} tag(s) from portal`);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  }

  const q = search.trim().toLowerCase();

  const orderedSelected = SLOTS.flatMap(slot =>
    allTags.filter(t => t.slot === slot && selected.has(t.shortcode))
  );
  const generatedCode  = orderedSelected.length ? buildFilenameCode(orderedSelected, description, version) : '';
  const obsidianResult = buildObsidianTags(orderedSelected);

  async function handleCopy() {
    if (!generatedCode) return;
    await navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const canCreate = !creating && !!generatedCode && !!folderName.trim() && !!targetFolder
    && !!activeClient?.supabaseUrl && !!activeClient?.supabaseAnonKey;

  async function handleCreateFolder() {
    if (!canCreate || !activeClient) return;
    setCreating(true);
    setCreateError(null);
    setCreateSuccess(null);
    setCreatedDir(null);

    try {
      const stem = generatedCode;
      const byLabel = (slot: Slot) => orderedSelected.filter(t => t.slot === slot).map(t => t.label);
      const name    = [...orderedSelected.map(t => t.label), description.trim()].filter(Boolean).join(' ');
      const versionStr = version.major !== ''
        ? `${version.major || '1'}-${version.minor || '0'}-${version.patch || '0'}`
        : '0-1-0';

      const config = { url: activeClient.supabaseUrl, anonKey: activeClient.supabaseAnonKey };
      const clientId = activeClient.id; // DB-first: the picked client IS the DB row

      // Collision-check against every stable_id this client already has — same approach
      // migrate-identity.ts uses, so a fresh asset can never clash with an existing folder.
      const taken      = await fetchExistingStableIds(clientId, config);
      const stableId   = generateStableId(taken);
      // Folder identifier is the short, user-typed folder name — never the long tag-derived
      // name, and never the bracket-coded file stem (folder names can't contain parentheses).
      const folder     = appendStableId(folderName.trim(), stableId);
      const packageDir = `${targetFolder}/${folder}`;

      await mkdir(packageDir, { recursive: true });
      await mkdir(`${packageDir}/IN`, { recursive: true });
      await mkdir(`${packageDir}/WRK`, { recursive: true });
      await mkdir(`${packageDir}/OUT`, { recursive: true });

      // Seed an empty placeholder named after the generated shortcode — no extension, so
      // the pipeline scanner (isPublishableFile requires a dot) ignores it until you
      // replace it with the real file. Manifest reserves child_id 'c1' for it up front,
      // so the first real sync updates this row instead of creating a duplicate.
      await writeTextFile(`${packageDir}/OUT/${stem}`, '');
      await writeTextFile(
        `${packageDir}/.dchub.json`,
        JSON.stringify({
          stable_id: stableId,
          children: { [stem]: { child_id: 'c1', sha256: EMPTY_SHA256 } },
          updated_at: new Date().toISOString(),
        }, null, 2),
      );
      await writeReadme(packageDir, {
        name: name || stem, stableId, status: 'draft', version: versionStr, perm: 'internal',
        tags: orderedSelected, stats: null,
      });

      try {
        await createDraftAsset({
          clientId, stableId, name: name || stem,
          entities: byLabel('entity'), angles: byLabel('angle'), formats: byLabel('format'),
          tags: orderedSelected.map(t => t.label),
          // No primary-tag concept in this flow — see conversation history if that
          // changes; the columns stay nullable for whenever that's revisited.
          primaryEntityId: null, primaryAngleId: null, primaryFormatId: null,
        }, config);
      } catch (e) {
        throw new Error(`Folder + ${README_FILENAME} were created, but the Supabase draft row failed: ${e instanceof Error ? e.message : e}`);
      }

      updateClient(activeClient.id, { lastCreationFolder: targetFolder });
      saveClients({ clients: useClientStore.getState().clients, activeClientId }).catch(console.error);

      setCreatedDir(packageDir);
      setCreateSuccess(`Created "${folder}" — placeholder seeded in OUT, draft asset ready.`);
      setFolderName('');
      setSelected(new Map());
      setDescription('');
      setVersion({ major: '', minor: '', patch: '' });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className={css.root}>
      {/* ── Header ── */}
      <div className={css.header}>
        <span className={css.title}>Vocabulary</span>
        <div className={css.headerRight}>
          <div className={css.searchWrap}>
            <Search size={14} className={css.searchIcon} />
            <input
              className={css.searchInput}
              placeholder="Search tags…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className={css.searchClearBtn} onClick={() => setSearch('')}>
                <X size={12} />
              </button>
            )}
          </div>
          <button
            className={css.btnSync}
            onClick={handleReloadFromPortal}
            disabled={reloading || publishing || !activeClientId}
            title="Replace local cache with portal tags"
          >
            <Download size={13} />
            {reloading ? 'Reloading…' : 'Reload'}
          </button>
          <button
            className={css.btnPublish}
            onClick={handlePublish}
            disabled={publishing || reloading || !activeClient?.supabaseUrl}
            title="Push local vocabulary to portal (public.tags)"
          >
            <Upload size={13} />
            {publishing ? 'Publishing…' : dirty ? 'Publish*' : 'Publish'}
          </button>
        </div>
      </div>
      {(syncMsg || syncError) && (
        <div className={`${css.syncBanner}${syncError ? ` ${css.syncBannerError}` : ''}`}>
          {syncError ?? syncMsg}
          <button className={css.syncBannerDismiss} onClick={() => { setSyncMsg(null); setSyncError(null); }}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── 4-column body ── */}
      <div className={css.body}>
        {SLOTS.map(slot => (
          <DimColumn
            key={slot}
            slot={slot}
            allTags={allTags}
            selected={selected}
            searchQuery={q}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            onToggleTag={toggleTag}
            onAdd={() => openAdd(slot)}
            onEdit={idx => openEdit(idx, slot)}
            onDelete={handleDelete}
          />
        ))}

        {/* ── Generator panel ── */}
        <aside className={css.genPanel}>
          <div className={css.resultBlock}>
            <div className={css.resultLabel}>Generated shortcode</div>
            <div className={css.resultCode}>
              {generatedCode
                ? generatedCode
                : <span className={css.resultEmpty}>Select tags to build a filename</span>
              }
            </div>
            <button className={css.btnCopy} onClick={handleCopy} disabled={!generatedCode}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <hr className={css.obsDivider} />
            <div className={css.resultLabel} style={{ marginTop: 12 }}>Obsidian tags</div>
            {obsidianResult.length > 0
              ? <div className={css.obsTags}>
                  {obsidianResult.map(t => <span key={t} className={css.obsTag}>#{t}</span>)}
                </div>
              : <span className={css.obsEmpty}>—</span>
            }
          </div>

          <div>
            <div className={css.genLabel}>Description</div>
            <input
              className={css.descInput}
              placeholder="Optional description"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          <div>
            <div className={css.genLabel}>Version</div>
            <div className={css.versionRow}>
              <span className={css.verSep}>v</span>
              <input className={css.verInput} type="number" min={0} placeholder="1"
                value={version.major} onChange={e => setVersion(v => ({ ...v, major: e.target.value }))} />
              <span className={css.verSep}>-</span>
              <input className={css.verInput} type="number" min={0} placeholder="0"
                value={version.minor} onChange={e => setVersion(v => ({ ...v, minor: e.target.value }))} />
              <span className={css.verSep}>-</span>
              <input className={css.verInput} type="number" min={0} placeholder="0"
                value={version.patch} onChange={e => setVersion(v => ({ ...v, patch: e.target.value }))} />
            </div>
          </div>

          {selected.size > 0 && (
            <button className={css.btnClear} onClick={clearGenerator}>Clear selection</button>
          )}

          <hr className={css.obsDivider} />

          <div>
            <div className={css.genLabel}>Folder name</div>
            <input
              className={css.descInput}
              placeholder="Sealing overview"
              value={folderName}
              onChange={e => setFolderName(e.target.value)}
            />
          </div>

          <FolderTargetPicker label="Target parent folder" value={targetFolder} onChange={setTargetFolder} />

          {createError   && <p className={css.errorText}>{createError}</p>}
          {createSuccess && <p className={css.successText}>{createSuccess}</p>}

          <button className={css.btnCopy} onClick={handleCreateFolder} disabled={!canCreate}>
            {creating ? 'Creating…' : 'Create asset folder'}
          </button>

          {createdDir && (
            <button className={css.btnClear} onClick={() => revealItemInDir(createdDir)}>
              <FolderOpen size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
              Reveal in Finder
            </button>
          )}
        </aside>
      </div>

      {modalOpen && (
        <TagModal slot={modalSlot} editIndex={editIndex} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}

/* ── Dimension column ─────────────────────────────────────────────────────── */

interface DimColProps {
  slot:            Slot;
  allTags:         VocabTag[];
  selected:        Map<string, VocabTag>;
  searchQuery:     string;
  collapsedGroups: Set<string>;
  onToggleGroup:   (key: string) => void;
  onToggleTag:     (tag: VocabTag) => void;
  onAdd:           () => void;
  onEdit:          (globalIdx: number) => void;
  onDelete:        (globalIdx: number) => void;
}

function DimColumn({
  slot, allTags, selected, searchQuery, collapsedGroups,
  onToggleGroup, onToggleTag, onAdd, onEdit, onDelete,
}: DimColProps) {
  const slotTags  = allTags.filter(t => t.slot === slot);
  const searching = searchQuery.length > 0;

  const matches = (tag: VocabTag) =>
    !searching ||
    tag.label.toLowerCase().includes(searchQuery) ||
    tag.shortcode.toLowerCase().includes(searchQuery);

  return (
    <div className={css.dimCol}>
      <div className={css.dimColHead}>
        <span className={css.dimColLabel}>{SLOT_LABELS[slot]}</span>
        <button className={css.btnAddCol} onClick={onAdd} title={`Add ${slot} tag`}>
          <Plus size={13} />
        </button>
      </div>

      <div className={css.dimColScroll}>
        {parentGroupsForSlot(slotTags, slot).map(groupName => {
          const group = slotTags.filter(t =>
            matches(t) &&
            (groupName === 'Ungrouped' ? !t.parentGroup : t.parentGroup === groupName)
          );
          if (!group.length) return null;

          const groupKey = `${slot}-${groupName}`;
          const isOpen   = searching || !collapsedGroups.has(groupKey);

          return (
            <div key={groupKey}>
              <div className={css.subtypeHead} onClick={() => onToggleGroup(groupKey)}>
                <ChevronRight
                  size={11}
                  className={`${css.subtypeCaret}${isOpen ? ` ${css.open}` : ''}`}
                />
                <span className={css.subtypeLabel}>{groupName}</span>
                <span className={css.subtypeCount}>{group.length}</span>
              </div>

              {isOpen && group.map(tag => {
                const globalIdx = allTags.indexOf(tag);
                const isSel     = selected.has(tag.shortcode);
                return (
                  <div
                    key={tag.shortcode}
                    className={`${css.tagRow}${isSel ? ` ${css.tagRowSel}` : ''}`}
                    onClick={() => onToggleTag(tag)}
                  >
                    <div className={css.tagCheck}>
                      {isSel && <Check size={9} strokeWidth={3} />}
                    </div>
                    {tag.icon && <span className={css.tagIcon}>{tag.icon}</span>}
                    <span className={css.tagLabel}>{tag.label}</span>
                    <span className={css.tagCode}>{tag.shortcode}</span>
                    <div className={css.tagActions} onClick={e => e.stopPropagation()}>
                      <button
                        className={css.tagActionBtn}
                        onClick={() => onEdit(globalIdx)}
                        title="Edit"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        className={`${css.tagActionBtn} ${css.tagActionDelete}`}
                        onClick={() => onDelete(globalIdx)}
                        title="Delete"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
