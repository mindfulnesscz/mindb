import { useState } from 'react';
import { Check } from 'lucide-react';
import {
  type Slot, SUBTYPES, SLOT_LABELS,
  buildFilenameCode, buildObsidianTags,
  type VocabTag,
} from '../../domain/vocabulary';
import { useVocabularyStore } from '../../store/vocabularyStore';
import css from './GeneratorView.module.css';

const SLOTS: Slot[] = ['entity', 'angle', 'format'];

interface VersionState { major: string; minor: string; patch: string }

export function GeneratorView() {
  const data = useVocabularyStore(s => s.data);
  const tags = data?.tags ?? [];

  /* Selection: shortcode → tag */
  const [selected, setSelected] = useState<Map<string, VocabTag>>(new Map());
  const [description, setDescription] = useState('');
  const [version, setVersion]  = useState<VersionState>({ major: '', minor: '', patch: '' });
  const [copied, setCopied]    = useState(false);

  function toggleTag(tag: VocabTag) {
    setSelected(prev => {
      const next = new Map(prev);
      next.has(tag.shortcode) ? next.delete(tag.shortcode) : next.set(tag.shortcode, tag);
      return next;
    });
  }

  function clearAll() {
    setSelected(new Map());
    setDescription('');
    setVersion({ major: '', minor: '', patch: '' });
  }

  /* Build ordered selection: entity → angle → format, then vocab order within */
  const orderedSelected: VocabTag[] = SLOTS.flatMap(slot =>
    tags.filter(t => t.slot === slot && selected.has(t.shortcode))
  );

  const generatedCode  = orderedSelected.length
    ? buildFilenameCode(orderedSelected, description, version)
    : '';
  const obsidianResult = buildObsidianTags(orderedSelected);

  async function handleCopy() {
    if (!generatedCode) return;
    await navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className={css.root}>
      {/* Header */}
      <div className={css.header}>
        <div className={css.headerLeft}>
          <div className={css.title}>Shortcode generator</div>
          <div className={css.subtitle}>Select tags across dimensions, add description and version</div>
        </div>
        <button className={css.btnClear} onClick={clearAll}>Clear all</button>
      </div>

      <div className={css.body}>
        {/* Dimension panels */}
        <div className={css.dimPanels}>
          {SLOTS.map(slot => {
            const slotTags = tags.filter(t => t.slot === slot);
            const subtypes = SUBTYPES[slot];

            return (
              <div key={slot} className={css.dimPanel}>
                <div className={css.dimPanelHead}>
                  <span className={css.dimPanelLabel}>{SLOT_LABELS[slot]}</span>
                </div>
                <div className={css.dimPanelScroll}>
                  {subtypes.map(sub => {
                    const group = slotTags.filter(t => t.subtype === sub);
                    if (!group.length) return null;
                    return (
                      <div key={sub}>
                        <div className={css.dimSubgroup}>{sub}</div>
                        {group.map(tag => {
                          const isSelected = selected.has(tag.shortcode);
                          return (
                            <div
                              key={tag.shortcode}
                              className={`${css.dimTag}${isSelected ? ` ${css.dimTagSelected}` : ''}`}
                              onClick={() => toggleTag(tag)}
                            >
                              <div className={css.dimCheck}>
                                {isSelected && <Check size={10} color="white" strokeWidth={3} />}
                              </div>
                              <span className={css.dimTagLabel}>
                                {tag.icon ? `${tag.icon} ` : ''}{tag.label}
                              </span>
                              <span className={css.dimTagCode}>{tag.shortcode}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Result rail */}
        <aside className={css.resultRail}>
          {/* Generated code block */}
          <div className={css.resultBlock}>
            <div className={css.resultLabel}>Generated shortcode</div>
            <div className={css.resultCode}>
              {generatedCode || <span className={css.resultEmpty}>Select tags below</span>}
            </div>
            <button className={css.btnCopy} onClick={handleCopy} disabled={!generatedCode}>
              {copied ? '✓ Copied!' : 'Copy'}
            </button>
            <hr className={css.obsDivider} />
            <div className={css.resultLabel} style={{ marginTop: 12 }}>Obsidian tags</div>
            {obsidianResult.length > 0 ? (
              <div className={css.obsTags}>
                {obsidianResult.map(t => (
                  <span key={t} className={css.obsTag}>#{t}</span>
                ))}
              </div>
            ) : (
              <span className={css.obsEmpty}>—</span>
            )}
          </div>

          {/* Description */}
          <div>
            <div className={css.sectionLabel}>Description</div>
            <input
              className={css.descInput}
              placeholder="Sealing overview (optional)"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          {/* Version */}
          <div>
            <div className={css.sectionLabel}>Version</div>
            <div className={css.versionRow}>
              <span className={css.verLabel}>v</span>
              <input
                className={css.verInput}
                type="number"
                min={0}
                placeholder="1"
                value={version.major}
                onChange={e => setVersion(v => ({ ...v, major: e.target.value }))}
              />
              <span className={css.verLabel}>-</span>
              <input
                className={css.verInput}
                type="number"
                min={0}
                placeholder="0"
                value={version.minor}
                onChange={e => setVersion(v => ({ ...v, minor: e.target.value }))}
              />
              <span className={css.verLabel}>-</span>
              <input
                className={css.verInput}
                type="number"
                min={0}
                placeholder="0"
                value={version.patch}
                onChange={e => setVersion(v => ({ ...v, patch: e.target.value }))}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
