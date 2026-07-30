/* The right-hand generator: the shortcode the selection builds, and the folder it can seed.
 *
 * All of its state lives in ../useAssetGenerator.ts, because the tag columns select into the same
 * state and the seeded folder is built from it.
 */

import { FolderOpen } from 'lucide-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { FolderTargetPicker } from '../../../components/FolderTargetPicker';
import type { AssetGenerator } from '../useAssetGenerator';
import css from '../VocabularyView.module.css';

export function GeneratorPanel({ gen }: { gen: AssetGenerator }) {
  return (
    <aside className={css.genPanel}>
      <div className={css.resultBlock}>
        <div className={css.resultLabel}>Generated shortcode</div>
        <div className={css.resultCode}>
          {gen.generatedCode
            ? gen.generatedCode
            : <span className={css.resultEmpty}>Select tags to build a filename</span>
          }
        </div>
        <button className={css.btnCopy} onClick={gen.copy} disabled={!gen.generatedCode}>
          {gen.copied ? '✓ Copied' : 'Copy'}
        </button>
        <hr className={css.obsDivider} />
        <div className={css.resultLabel} style={{ marginTop: 12 }}>Obsidian tags</div>
        {gen.obsidianResult.length > 0
          ? <div className={css.obsTags}>
              {gen.obsidianResult.map(t => <span key={t} className={css.obsTag}>#{t}</span>)}
            </div>
          : <span className={css.obsEmpty}>—</span>
        }
      </div>

      <div>
        <div className={css.genLabel}>Description</div>
        <input
          className={css.descInput}
          placeholder="Optional description"
          value={gen.description}
          onChange={e => gen.setDescription(e.target.value)}
        />
      </div>

      <div>
        <div className={css.genLabel}>Version</div>
        <div className={css.versionRow}>
          <span className={css.verSep}>v</span>
          <input className={css.verInput} type="number" min={0} placeholder="1"
            value={gen.version.major} onChange={e => gen.setVersion(v => ({ ...v, major: e.target.value }))} />
          <span className={css.verSep}>-</span>
          <input className={css.verInput} type="number" min={0} placeholder="0"
            value={gen.version.minor} onChange={e => gen.setVersion(v => ({ ...v, minor: e.target.value }))} />
          <span className={css.verSep}>-</span>
          <input className={css.verInput} type="number" min={0} placeholder="0"
            value={gen.version.patch} onChange={e => gen.setVersion(v => ({ ...v, patch: e.target.value }))} />
        </div>
      </div>

      {gen.selected.size > 0 && (
        <button className={css.btnClear} onClick={gen.clear}>Clear selection</button>
      )}

      <hr className={css.obsDivider} />

      <div>
        <div className={css.genLabel}>Folder name</div>
        <input
          className={css.descInput}
          placeholder="Sealing overview"
          value={gen.folderName}
          onChange={e => gen.setFolderName(e.target.value)}
        />
      </div>

      <FolderTargetPicker label="Target parent folder" value={gen.targetFolder} onChange={gen.setTargetFolder} />

      {gen.createError   && <p className={css.errorText}>{gen.createError}</p>}
      {gen.createSuccess && <p className={css.successText}>{gen.createSuccess}</p>}

      <button className={css.btnCopy} onClick={gen.create} disabled={!gen.canCreate}>
        {gen.creating ? 'Creating…' : 'Create asset folder'}
      </button>

      {gen.createdDir && (
        <button className={css.btnClear} onClick={() => revealItemInDir(gen.createdDir!)}>
          <FolderOpen size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
          Reveal in Finder
        </button>
      )}
    </aside>
  );
}
