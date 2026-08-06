/* One dimension column — entity, angle or format.
 *
 * Groups come from the portal, so a group the portal defines is shown even when it holds no tags yet
 * (that is how an operator sees where to file a new one). While searching, empty groups are hidden and
 * collapsed ones open, because a search that hides its own matches is worse than no search.
 */

import { ChevronRight, Pencil, Trash2, Check, Plus } from 'lucide-react';
import { parentGroupsForSlot, type Slot, type VocabTag } from '@sotto/domain';
import { useVocabularyStore } from '../../../store/vocabularyStore';
import css from '../VocabularyView.module.css';

interface DimColProps {
  slot:            Slot;
  dimLabel:        string;
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

export function DimColumn({
  slot, dimLabel, allTags, selected, searchQuery, collapsedGroups,
  onToggleGroup, onToggleTag, onAdd, onEdit, onDelete,
}: DimColProps) {
  const portalGroups = useVocabularyStore(s => s.data?.parentGroups);
  const slotTags  = allTags.filter(t => t.slot === slot);
  const searching = searchQuery.length > 0;

  const matches = (tag: VocabTag) =>
    !searching ||
    tag.label.toLowerCase().includes(searchQuery) ||
    tag.shortcode.toLowerCase().includes(searchQuery);

  const groupNames = parentGroupsForSlot(slotTags, slot, portalGroups);

  return (
    <div className={css.dimCol}>
      <div className={css.dimColHead}>
        <span className={css.dimColLabel}>{dimLabel}</span>
        <button className={css.btnAddCol} onClick={onAdd} title={`Add ${slot} tag`}>
          <Plus size={13} />
        </button>
      </div>

      <div className={css.dimColScroll}>
        {groupNames.map(groupName => {
          const group = slotTags.filter(t =>
            matches(t) &&
            (groupName === 'Ungrouped' ? !t.parentGroup : t.parentGroup === groupName)
          );
          const isPortalGroup = groupName !== 'Ungrouped'
            && (portalGroups ?? []).some(g => g.slot === slot && g.name === groupName);
          if (!group.length && !isPortalGroup) return null;
          if (!group.length && searching) return null;

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
