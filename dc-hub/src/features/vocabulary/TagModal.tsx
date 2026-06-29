import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import {
  type Slot, type Subtype, type VocabTag,
  SUBTYPES, ENTITY_PREFIXES, prefixForSubtype,
} from '../../domain/vocabulary';
import { useVocabularyStore } from '../../store/vocabularyStore';
import css from './TagModal.module.css';

interface Props {
  slot:       Slot;
  editIndex?: number; // present = edit mode
  onClose:    () => void;
}

function prefixLabel(subtype: string): string {
  const p = ENTITY_PREFIXES[subtype as keyof typeof ENTITY_PREFIXES];
  if (p === undefined) return '';
  return p === '' ? 'no prefix' : p;
}

export function TagModal({ slot, editIndex, onClose }: Props) {
  const { data, addTag, updateTag } = useVocabularyStore();
  const editing = editIndex !== undefined ? data?.tags[editIndex] : undefined;

  const subtypes = SUBTYPES[slot];
  const [subtype,   setSubtype]   = useState<Subtype>(editing?.subtype ?? subtypes[0]);
  const [distinctive, setDistinct] = useState<string>(() => {
    if (!editing) return '';
    const prefix = prefixForSubtype(slot, editing.subtype);
    return editing.shortcode.startsWith(prefix) ? editing.shortcode.slice(prefix.length) : editing.shortcode;
  });
  const [label,     setLabel]     = useState(editing?.label ?? '');
  const [icon,      setIcon]      = useState(editing?.icon  ?? '');
  const [obsidian,  setObsidian]  = useState(editing?.obsidian_tag ?? '');
  const [errMsg,    setErrMsg]    = useState('');

  /* Reset distinctive part when subtype changes (prefix may change) */
  useEffect(() => {
    if (!editing) setDistinct('');
  }, [subtype]);

  const prefix     = prefixForSubtype(slot, subtype);
  const fullCode   = prefix + distinctive.trim();
  const isEntityDim = slot === 'entity';

  function validate(): boolean {
    if (!distinctive.trim()) { setErrMsg('Shortcode is required.'); return false; }
    if (!label.trim())       { setErrMsg('Label is required.'); return false; }
    if (!obsidian.trim())    { setErrMsg('Obsidian tag is required.'); return false; }

    /* Duplicate check */
    const dup = data?.tags.find((t, i) => t.shortcode === fullCode && i !== editIndex);
    if (dup) { setErrMsg(`Shortcode "${fullCode}" already exists.`); return false; }

    setErrMsg('');
    return true;
  }

  function handleSave() {
    if (!validate()) return;
    const tag: VocabTag = {
      shortcode: fullCode,
      slot,
      subtype,
      label:        label.trim(),
      icon:         icon.trim(),
      obsidian_tag: obsidian.trim(),
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
          {/* Subtype selector */}
          <div className={css.field}>
            <span className={css.fieldLabel}>Subtype</span>
            <div className={css.subtypePills}>
              {subtypes.map(st => (
                <button
                  key={st}
                  className={`${css.subtypePill}${subtype === st ? ` ${css.active}` : ''}`}
                  onClick={() => setSubtype(st)}
                >
                  {st}
                  {isEntityDim && (
                    <span className={css.pillPrefix}>{prefixLabel(st)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Shortcode field */}
          <div className={css.field}>
            <span className={css.fieldLabel}>Shortcode</span>
            <div className={css.fieldRow}>
              {isEntityDim && prefix && (
                <div className={css.prefixLock}>{prefix}</div>
              )}
              <input
                className={`${css.input}${isEntityDim && prefix ? ` ${css.inputWithPrefix}` : ''}`}
                value={distinctive}
                onChange={e => setDistinct(e.target.value)}
                placeholder={isEntityDim ? 'Sln' : 'e.g. Ovw'}
              />
            </div>
            {isEntityDim && (
              <>
                <span className={css.prefixResult}>
                  Result: <span className={css.prefixResultCode}>{fullCode || '—'}</span>
                </span>
                <span className={css.fieldHint}>
                  {prefix
                    ? `Prefix "${prefix}" is derived from subtype "${subtype}" and is locked.`
                    : 'Company subtype — no prefix. Type the full shortcode.'}
                </span>
              </>
            )}
            {!isEntityDim && (
              <span className={css.fieldHint}>Use CamelCase, 2–5 chars.</span>
            )}
          </div>

          {/* Icon + Label */}
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

          {/* Obsidian tags */}
          <div className={css.field}>
            <span className={css.fieldLabel}>Obsidian tags</span>
            <input
              className={css.input}
              value={obsidian}
              onChange={e => setObsidian(e.target.value)}
              placeholder="e.g. sealing  (space-separated)"
            />
            <span className={css.fieldHint}>
              Space-separated. First = most specific. Example: "banner print" → #banner + #print
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
