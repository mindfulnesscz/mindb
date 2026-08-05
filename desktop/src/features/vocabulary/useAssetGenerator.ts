/* The shortcode generator and the folder it can seed.
 *
 * Selected tags are held in a Map keyed by shortcode so a tag can be toggled from any column, but the
 * ORDER handed to the filename builder is always entity → angle → format: the code has to be stable
 * regardless of the order the operator happened to click, or the same asset gets two different names.
 */

import { useState } from 'react';
import {
  buildFilenameCode, buildObsidianTags, type Slot, type VocabTag,
} from '@dc-hub/domain';
import { useClientStore } from '../../store/clientStore';
import { saveClients } from '../../services/clientService';
import { reportError } from '../../services/reportError';
import type { Client } from '../../domain/client';
import { createAssetFolder, type VersionState } from './createAssetFolder';

const SLOTS: Slot[] = ['entity', 'angle', 'format'];

export function useAssetGenerator(activeClient: Client | null, allTags: VocabTag[]) {
  const updateClient = useClientStore(s => s.updateClient);

  const [selected, setSelected]       = useState<Map<string, VocabTag>>(new Map());
  const [description, setDescription] = useState('');
  const [version, setVersion]         = useState<VersionState>({ major: '', minor: '', patch: '' });
  const [copied, setCopied]           = useState(false);

  const [folderName, setFolderName]       = useState('');
  const [targetFolder, setTargetFolder]   = useState(activeClient?.lastCreationFolder ?? '');
  const [creating, setCreating]           = useState(false);
  const [createError, setCreateError]     = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [createdDir, setCreatedDir]       = useState<string | null>(null);

  const orderedSelected = SLOTS.flatMap(slot =>
    allTags.filter(t => t.slot === slot && selected.has(t.shortcode))
  );
  const generatedCode  = orderedSelected.length ? buildFilenameCode(orderedSelected, description, version) : '';
  const obsidianResult = buildObsidianTags(orderedSelected);

  const canCreate = !creating && !!generatedCode && !!folderName.trim() && !!targetFolder
    && !!activeClient?.supabaseUrl && !!activeClient?.supabaseAnonKey;

  function toggleTag(tag: VocabTag) {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(tag.shortcode)) next.delete(tag.shortcode);
      else next.set(tag.shortcode, tag);
      return next;
    });
  }

  function deselect(shortcode: string) {
    setSelected(prev => { const next = new Map(prev); next.delete(shortcode); return next; });
  }

  function clear() {
    setSelected(new Map());
    setDescription('');
    setVersion({ major: '', minor: '', patch: '' });
  }

  async function copy() {
    if (!generatedCode) return;
    await navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function create() {
    if (!canCreate || !activeClient) return;
    setCreating(true);
    setCreateError(null);
    setCreateSuccess(null);
    setCreatedDir(null);

    try {
      const { packageDir, folder } = await createAssetFolder({
        stem: generatedCode,
        folderName, targetFolder,
        selectedTags: orderedSelected,
        description, version,
        clientId: activeClient.id,          // DB-first: the picked client IS the DB row
        config: { url: activeClient.supabaseUrl!, anonKey: activeClient.supabaseAnonKey! },
      });

      // Remember where the operator files this client's work, so the next asset defaults to it.
      updateClient(activeClient.id, { lastCreationFolder: targetFolder });
      saveClients({ clients: useClientStore.getState().clients, activeClientId: activeClient.id })
        .catch(e => reportError('config.VocabularyView.saveClients', e));

      setCreatedDir(packageDir);
      setCreateSuccess(`Created "${folder}" — placeholder seeded in OUT, draft asset ready.`);
      setFolderName('');
      clear();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return {
    selected, toggleTag, deselect, clear,
    description, setDescription,
    version, setVersion,
    generatedCode, obsidianResult, copied, copy,
    folderName, setFolderName,
    targetFolder, setTargetFolder,
    creating, createError, createSuccess, createdDir, canCreate, create,
  };
}

export type AssetGenerator = ReturnType<typeof useAssetGenerator>;
