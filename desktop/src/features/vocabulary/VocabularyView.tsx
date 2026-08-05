/* Vocabulary — three tag columns and the generator that turns a selection into an asset.
 *
 *   ./useVocabSync          publish local leaf edits / reload from the portal
 *   ./useAssetGenerator     the selection, the generated shortcode, the seeded folder
 *   ./createAssetFolder     the folder-seeding itself — where a stable_id is minted
 *   ./panels/DimColumn      one dimension column
 *   ./panels/GeneratorPanel the right-hand panel
 *
 * The columns and the generator share one selection, which is why it lives here rather than in either.
 */

import { useState } from 'react';
import { Search, X, RefreshCw } from 'lucide-react';
import { type Slot, dimensionLabelForSlot } from '@sotto/domain';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { useClientStore } from '../../store/clientStore';
import { TagModal } from './TagModal';
import { DimColumn } from './panels/DimColumn';
import { GeneratorPanel } from './panels/GeneratorPanel';
import { useVocabSync } from './useVocabSync';
import { useAssetGenerator } from './useAssetGenerator';
import css from './VocabularyView.module.css';

const SLOTS: Slot[] = ['entity', 'angle', 'format'];

export function VocabularyView() {
  const { data, deleteTag } = useVocabularyStore();
  const allTags = data?.tags ?? [];
  const dirty   = useVocabularyStore(s => s.dirty);

  const { clients, activeClientId } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSlot, setModalSlot] = useState<Slot>('entity');
  const [editIndex, setEditIndex] = useState<number | undefined>(undefined);
  const [search, setSearch]       = useState('');

  const sync = useVocabSync(activeClient);
  const gen  = useAssetGenerator(activeClient, allTags);

  function toggleGroup(key: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
      // Drop it from the generator too, or the next shortcode carries a tag that no longer exists.
      gen.deselect(tag.shortcode);
    }
  }

  const q = search.trim().toLowerCase();

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
            className={css.btnPublish}
            onClick={sync.sync}
            disabled={sync.syncing || !activeClient?.supabaseUrl}
            title={dirty
              ? 'Publish local leaf changes, then reload from portal'
              : 'Reload vocabulary from portal'}
          >
            <RefreshCw size={13} />
            {sync.syncing ? 'Syncing…' : dirty ? 'Sync*' : 'Sync'}
          </button>
        </div>
      </div>
      {(sync.syncMsg || sync.syncError) && (
        <div className={`${css.syncBanner}${sync.syncError ? ` ${css.syncBannerError}` : ''}`}>
          {sync.syncError ?? sync.syncMsg}
          <button className={css.syncBannerDismiss} onClick={sync.dismiss}>
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
            dimLabel={dimensionLabelForSlot(activeClient, slot)}
            allTags={allTags}
            selected={gen.selected}
            searchQuery={q}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            onToggleTag={gen.toggleTag}
            onAdd={() => openAdd(slot)}
            onEdit={idx => openEdit(idx, slot)}
            onDelete={handleDelete}
          />
        ))}

        <GeneratorPanel gen={gen} />
      </div>

      {modalOpen && (
        <TagModal slot={modalSlot} editIndex={editIndex} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}
