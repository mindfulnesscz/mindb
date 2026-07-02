import { useState } from 'react';
import { ChevronRight, Pencil, Trash2, Check, Plus, Search, X } from 'lucide-react';
import {
  type Slot, type VocabTag,
  SUBTYPES, SLOT_LABELS, ENTITY_PREFIXES,
  buildFilenameCode, buildObsidianTags,
} from '../../domain/vocabulary';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { TagModal } from './TagModal';
import css from './VocabularyView.module.css';

const SLOTS: Slot[] = ['entity', 'angle', 'format'];

interface VersionState { major: string; minor: string; patch: string }

export function VocabularyView() {
  const { data, deleteTag } = useVocabularyStore();
  const allTags = data?.tags ?? [];

  /* Vocabulary state */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [modalOpen,  setModalOpen]  = useState(false);
  const [modalSlot,  setModalSlot]  = useState<Slot>('entity');
  const [editIndex,  setEditIndex]  = useState<number | undefined>(undefined);
  const [search,     setSearch]     = useState('');

  /* Generator state */
  const [selected,     setSelected]     = useState<Map<string, VocabTag>>(new Map());
  const [description,  setDescription]  = useState('');
  const [version,      setVersion]      = useState<VersionState>({ major: '', minor: '', patch: '' });
  const [copied,       setCopied]        = useState(false);

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
        </div>
      </div>

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
        {SUBTYPES[slot].map(subtype => {
          const group = slotTags.filter(t => t.subtype === subtype && matches(t));
          if (!group.length) return null;

          const groupKey = `${slot}-${subtype}`;
          const isOpen   = searching || !collapsedGroups.has(groupKey);
          const prefix   = slot === 'entity'
            ? (ENTITY_PREFIXES[subtype as keyof typeof ENTITY_PREFIXES] ?? '')
            : '';

          return (
            <div key={groupKey}>
              <div className={css.subtypeHead} onClick={() => onToggleGroup(groupKey)}>
                <ChevronRight
                  size={11}
                  className={`${css.subtypeCaret}${isOpen ? ` ${css.open}` : ''}`}
                />
                <span className={css.subtypeLabel}>{subtype}</span>
                {slot === 'entity' && prefix && (
                  <span className={css.subtypePrefix}>{prefix}</span>
                )}
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
