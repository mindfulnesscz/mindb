import { Folder } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import css from './FolderPicker.module.css';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
}

export function FolderPicker({ label, value, onChange }: Props) {
  async function pick() {
    // `recursive` is what Tauri passes to fs_scope().allow_directory(). Without it the grant is
    // only `<dir>` and `<dir>/*`, so anything deeper than one level is refused by path_policy —
    // which is every real asset, since sources nest project/shoot/OUT folders.
    const selected = await open({ directory: true, multiple: false, recursive: true });
    if (selected && typeof selected === 'string') onChange(selected);
  }

  return (
    <div className={css.row}>
      <label className={css.label}>{label}</label>
      <div className={css.inputRow}>
        <div className={css.pathDisplay} title={value}>
          <Folder size={12} className={css.pathIcon} />
          <span className={css.pathText}>{value || 'Not selected'}</span>
        </div>
        <button className={css.browseBtn} onClick={pick}>Browse</button>
      </div>
    </div>
  );
}
