/* Sync with the portal — publish local leaf edits, then reload.
 *
 * Direction matters. The portal owns tag LABELS, so a plain reload is the normal case; publishing
 * first only happens when this machine has unpublished edits (`dirty`). Reloading without publishing
 * would silently discard them, and publishing a stale cache would overwrite portal renames — so the
 * operator is asked which one they mean, in those words.
 */

import { useState } from 'react';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { syncTagsFromVocabulary } from '../../services/supabaseService';
import { loadVocabulary } from '../../services/vocabService';
import type { Client } from '../../domain/client';

export interface VocabSync {
  syncing:  boolean;
  syncMsg:  string | null;
  syncError: string | null;
  sync:     () => Promise<void>;
  dismiss:  () => void;
}

export function useVocabSync(activeClient: Client | null): VocabSync {
  const { data, setData, markClean } = useVocabularyStore();
  const dirty = useVocabularyStore(s => s.dirty);

  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function sync() {
    if (!activeClient) return;
    if (!activeClient.supabaseUrl || !activeClient.supabaseAnonKey) {
      setSyncError('Client has no Supabase connection.');
      return;
    }
    if (!data) return;

    const willPublish = dirty;
    if (willPublish && !window.confirm(
      `Sync with portal for "${activeClient.name}"?\n\n` +
      'Local leaf changes will be published, then vocabulary is reloaded from the database.',
    )) return;
    if (!willPublish && !window.confirm(
      `Reload vocabulary from portal for "${activeClient.name}"?`,
    )) return;

    setSyncing(true);
    setSyncMsg(null);
    setSyncError(null);
    const lines: string[] = [];
    try {
      if (willPublish) {
        const result = await syncTagsFromVocabulary(
          data,
          activeClient.id,
          { url: activeClient.supabaseUrl, anonKey: activeClient.supabaseAnonKey },
          (_type, msg) => { lines.push(msg); },
        );
        markClean();
        lines.push(`Published: ${result.created} created · ${result.updated} updated · ${result.deleted} deleted`);
      }
      const fresh = await loadVocabulary(activeClient.id, { forceFromDb: true });
      setData(fresh, { dirty: false });
      setSyncMsg(
        willPublish
          ? `Synced — ${fresh.tags.length} leaf tag(s), ${fresh.parentGroups?.length ?? 0} group(s) from portal`
          : `Reloaded ${fresh.tags.length} leaf tag(s) from portal`,
      );
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
      // The per-tag log is only useful when the sync failed partway through.
      if (lines.length) console.warn(lines.join('\n'));
    } finally {
      setSyncing(false);
    }
  }

  return {
    syncing, syncMsg, syncError, sync,
    dismiss: () => { setSyncMsg(null); setSyncError(null); },
  };
}
