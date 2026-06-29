import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { type Slot, SUBTYPES, SLOT_LABELS, SLOT_DESCRIPTIONS, ENTITY_PREFIXES } from '../../domain/vocabulary';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { TagModal } from './TagModal';
import css from './VocabularyView.module.css';

const SLOTS: Slot[] = ['entity', 'angle', 'format'];

export function VocabularyView() {
  const { data, deleteTag } = useVocabularyStore();
  const [activeSlot, setActiveSlot] = useState<Slot>('entity');
  const [modalOpen,  setModalOpen]  = useState(false);
  const [editIndex,  setEditIndex]  = useState<number | undefined>(undefined);

  /* Which subtype groups are collapsed (default: all expanded) */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(key: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const tags = data?.tags.filter(t => t.slot === activeSlot) ?? [];

  function openAdd() { setEditIndex(undefined); setModalOpen(true); }
  function openEdit(idx: number) { setEditIndex(idx); setModalOpen(true); }

  async function handleDelete(globalIdx: number) {
    const tag = data?.tags[globalIdx];
    if (!tag) return;
    if (confirm(`Delete "${tag.shortcode} — ${tag.label}"?\nThis cannot be undone.`)) {
      deleteTag(globalIdx);
    }
  }

  return (
    <div className={css.root}>
      {/* Header */}
      <div className={css.header}>
        <div className={css.headerTop}>
          <div className={css.headerLeft}>
            <div className={css.dimTitle}>
              {SLOT_LABELS[activeSlot]}
              <span className={css.countPill}>{tags.length} tags</span>
            </div>
            <div className={css.dimSub}>{SLOT_DESCRIPTIONS[activeSlot]}</div>
          </div>
          <button className={css.btnAddTag} onClick={openAdd}>+ Add tag</button>
        </div>

        {/* Dimension tabs */}
        <div className={css.tabs}>
          {SLOTS.map(slot => (
            <button
              key={slot}
              className={`${css.tab}${activeSlot === slot ? ` ${css.active}` : ''}`}
              onClick={() => setActiveSlot(slot)}
            >
              {SLOT_LABELS[slot]}
            </button>
          ))}
        </div>
      </div>

      {/* Tag table */}
      <div className={css.tableScroll}>
        <table className={css.table}>
          <thead className={css.tableHead}>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>Shortcode</th>
              <th>Label</th>
              <th>Subtype</th>
              <th>Obsidian tags</th>
              <th style={{ width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {SUBTYPES[activeSlot].map(subtype => {
              const group = tags.filter(t => t.subtype === subtype);
              if (!group.length) return null;
              const groupKey  = `${activeSlot}-${subtype}`;
              const isOpen    = !collapsedGroups.has(groupKey);
              const prefix    = activeSlot === 'entity'
                ? ENTITY_PREFIXES[subtype as keyof typeof ENTITY_PREFIXES] ?? ''
                : '';

              return [
                /* Group header row */
                <tr key={groupKey} className={css.groupRow}>
                  <td colSpan={6}>
                    <div
                      className={css.groupRowInner}
                      onClick={() => toggleGroup(groupKey)}
                    >
                      <ChevronRight
                        size={13}
                        className={`${css.groupCaret}${isOpen ? ` ${css.open}` : ''}`}
                      />
                      <span className={css.groupLabel}>{subtype}</span>
                      {activeSlot === 'entity' && (
                        <span className={css.groupPrefix}>
                          {prefix ? `prefix ${prefix}` : 'no prefix'}
                        </span>
                      )}
                      <span className={css.groupCount}>{group.length}</span>
                    </div>
                  </td>
                </tr>,

                /* Tag rows */
                ...(isOpen ? group.map(tag => {
                  const globalIdx = data!.tags.indexOf(tag);
                  return (
                    <tr key={tag.shortcode} className={css.tagRow}>
                      <td style={{ textAlign: 'center', fontSize: 16 }}>
                        {tag.icon || '—'}
                      </td>
                      <td>
                        <span className={css.shortcodeChip}>{tag.shortcode}</span>
                      </td>
                      <td style={{ fontSize: 'var(--text-sm)' }}>{tag.label}</td>
                      <td>
                        <span className={css.subtypePill}>{tag.subtype}</span>
                      </td>
                      <td>
                        <div className={css.obsTags}>
                          {tag.obsidian_tag.split(' ').filter(Boolean).map(t => (
                            <span key={t} className={css.obsTag}>#{t}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className={css.actions}>
                          <button
                            className={css.btnAction}
                            onClick={() => openEdit(globalIdx)}
                          >
                            Edit
                          </button>
                          <button
                            className={`${css.btnAction} ${css.btnActionDelete}`}
                            onClick={() => handleDelete(globalIdx)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }) : []),
              ];
            })}
          </tbody>
        </table>
      </div>

      {/* Add/Edit modal */}
      {modalOpen && (
        <TagModal
          slot={activeSlot}
          editIndex={editIndex}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
