import { useEffect, useState } from 'react';
import { Folder, FolderInput } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { stat } from '@tauri-apps/plugin-fs';
import css from './FolderTargetPicker.module.css';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
}

// Native OS drag-drop is window-scoped in Tauri (no per-element target), so this
// listens globally while mounted. Safe because this is the only drop target on screen.
export function FolderTargetPicker({ label, value, onChange }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    const unlistenPromise = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === 'over') {
        setDragOver(true);
        return;
      }
      if (event.payload.type === 'leave') {
        setDragOver(false);
        return;
      }
      if (event.payload.type === 'drop') {
        setDragOver(false);
        const path = event.payload.paths[0];
        if (!path) return;
        try {
          const info = await stat(path);
          if (!info.isDirectory) {
            setDropError('Drop a folder, not a file.');
            return;
          }
          setDropError(null);
          onChange(path);
        } catch {
          setDropError('Could not read the dropped item.');
        }
      }
    });
    return () => { unlistenPromise.then(unlisten => unlisten()); };
  }, [onChange]);

  async function pick() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === 'string') {
      setDropError(null);
      onChange(selected);
    }
  }

  return (
    <div className={css.row}>
      <label className={css.label}>{label}</label>
      <div className={`${css.dropZone}${dragOver ? ` ${css.dragOver}` : ''}`}>
        <div className={css.inputRow}>
          <div className={css.pathDisplay} title={value}>
            <Folder size={12} className={css.pathIcon} />
            <span className={css.pathText}>{value || 'Not selected'}</span>
          </div>
          <button className={css.browseBtn} onClick={pick}>Browse</button>
        </div>
        <div className={css.dropHint}>
          <FolderInput size={11} />
          <span>or drag a folder here</span>
        </div>
      </div>
      {dropError && <p className={css.dropErr}>{dropError}</p>}
    </div>
  );
}
