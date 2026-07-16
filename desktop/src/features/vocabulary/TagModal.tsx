import { useState } from 'react';
import { X } from 'lucide-react';
import {
  type Slot, type VocabTag,
  parentGroupsForSlot,
} from '../../domain/vocabulary';
import { useVocabularyStore } from '../../store/vocabularyStore';
import css from './TagModal.module.css';

interface Props {
  slot:       Slot;
  editIndex?: number; // present = edit mode
  onClose:    () => void;
}

export function TagModal({ slot, editIndex, onClose }: Props) {
  const { data, addTag, updateTag } = useVocabularyStore();
  const editing = editIndex !== undefined ? data?.tags[editIndex] : undefined;
  const allTags = data?.tags ?? [];
  const existingGroups = parentGroupsForSlot(allTags, slot).filter(g => g !== 'Ungrouped');

  const [parentGroup, setParentGroup] = useState(editing?.parentGroup ?? existingGroups[0] ?? '');
  const [shortcode, setShortcode]     = useState(editing?.shortcode ?? '');
  const [label, setLabel]             = useState(editing?.label ?? '');
  const [key, setKey]                 = useState(editing?.key ?? '');
  const [icon, setIcon]               = useState(editing?.icon ?? '');
  const [errMsg, setErrMsg]           = useState('');

  function validate(): boolean {
    if (!shortcode.trim()) { setErrMsg('Shortcode is required.'); return false; }
    if (!label.trim())     { setErrMsg('Label is required.'); return false; }
    if (!key.trim())       { setErrMsg('Key is required (used as Obsidian tag).'); return false; }

    const dup = data?.tags.find((t, i) => t.shortcode === shortcode.trim() && i !== editIndex);
    if (dup) { setErrMsg(`Shortcode "${shortcode.trim()}" already exists.`); return false; }

    const keyDup = data?.tags.find((t, i) => t.key === key.trim() && i !== editIndex);
    if (keyDup) { setErrMsg(`Key "${key.trim()}" already exists.`); return false; }

    setErrMsg('');
    return true;
  }

  function handleSave() {
    if (!validate()) return;
    const tag: VocabTag = {
      shortcode: shortcode.trim(),
      slot,
      parentGroup: parentGroup.trim() || null,
      label: label.trim(),
      key: key.trim(),
      icon: icon.trim(),
    };
    if (editIndex !== undefined) updateTag(editIndex, tag);
    else addTag(tag);
    onClose();
  }

  return (
    <div className={css.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={css.modal}>
        <div className={css.modalHead}>
          <span className={css.modalTitle}>
            {editIndex !== undefined ? `Edit — ${editing?.shortcode}` : `Add ${slot} tag`}
          </span>
          <button className={css.btnClose} onClick={onClose}><X size={18} /></button>
        </div>

        <div className={css.modalBody}>
          <div className={css.field}>
            <span className={css.fieldLabel}>Parent group</span>
            <input
              className={css.input}
              list={`parent-groups-${slot}`}
              value={parentGroup}
              onChange={e => setParentGroup(e.target.value)}
              placeholder="Optional — matches portal parent tag name"
            />
            <datalist id={`parent-groups-${slot}`}>
              {existingGroups.map(g => <option key={g} value={g} />)}
            </datalist>
            <span className={css.fieldHint}>
              Groups come from the portal tag tree (`parent_key`). Leave empty for ungrouped.
            </span>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>Shortcode</span>
            <input
              className={css.input}
              value={shortcode}
              onChange={e => setShortcode(e.target.value)}
              placeholder="e.g. p-Sln or Ovw"
            />
            <span className={css.fieldHint}>Filename token. Use any prefix convention you need (e.g. p-, c-).</span>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div className={css.field} style={{ width: 80, flexShrink: 0 }}>
              <span className={css.fieldLabel}>Icon</span>
              <input
                className={css.input}
                value={icon}
                onChange={e => setIcon(e.target.value)}
                placeholder="🎪"
                style={{ textAlign: 'center' }}
              />
            </div>
            <div className={css.field} style={{ flex: 1 }}>
              <span className={css.fieldLabel}>Label</span>
              <input
                className={css.input}
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="Human-readable name"
              />
            </div>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>Key (Obsidian tag)</span>
            <input
              className={css.input}
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="e.g. entity.product.sealing"
            />
            <span className={css.fieldHint}>
              Stable taxonomy key. Written as a single Obsidian tag on export.
            </span>
          </div>

          {errMsg && <span className={css.error}>{errMsg}</span>}
        </div>

        <div className={css.modalFoot}>
          <button className={css.btnCancel} onClick={onClose}>Cancel</button>
          <button className={css.btnSave} onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
