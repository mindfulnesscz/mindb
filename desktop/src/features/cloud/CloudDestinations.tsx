/* Cloud destinations — the portal owns their structure, this machine owns their credentials.
 *
 * That split is the whole design of this screen. Name, remote path, role and package-export shape come
 * from the portal (Sync pulls them); the local folder path and the OAuth tokens never leave this
 * machine. A write here therefore persists LOCALLY only — to the clients file and, when an environment
 * is active, to that environment's own copy.
 *
 *   ./panels/DestList              the list
 *   ./panels/DestCredentialsForm   one destination's credentials
 *   ./useDestAuth + ./connectDest  the connect/refresh flow, including the device-code wait
 */

import { useState } from 'react';
import { useClientStore } from '../../store/clientStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import { saveClients, saveLocalClient, pullCloudDestinations } from '../../services/clientService';
import { reportError } from '../../services/reportError';
import type { CloudDestination } from '../../domain/client';
import { DestList } from './panels/DestList';
import { DestCredentialsForm } from './panels/DestCredentialsForm';
import css from './CloudDestinations.module.css';

export function CloudDestinations() {
  const { clients, activeClientId, updateClient } = useClientStore();
  const activeEnvId = useEnvironmentStore(s => s.activeEnvId);
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<CloudDestination | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  if (!activeClient) {
    return <p className={css.noClient}>Select a client to manage cloud destinations.</p>;
  }

  const dests = activeClient.cloudDestinations;

  function persistLocal(updated: CloudDestination[]) {
    if (!activeClient) return;
    updateClient(activeClient.id, { cloudDestinations: updated });
    const updatedClients = clients.map(c => c.id === activeClientId
      ? { ...c, cloudDestinations: updated } : c);
    saveClients({ clients: updatedClients, activeClientId })
      .catch(e => reportError('config.CloudDestinations.saveClients', e));
    if (activeEnvId) {
      const next = updatedClients.find(c => c.id === activeClient.id);
      if (next) saveLocalClient(activeEnvId, next)
        .catch(e => reportError('config.CloudDestinations.saveLocalClient', e));
    }
  }

  function handleSave(dest: CloudDestination) {
    persistLocal(dests.map(d => d.id === dest.id ? dest : d));
    setView('list');
  }

  async function handleSync() {
    if (!activeClient || syncing) return;
    setSyncing(true);
    setSyncMsg('');
    try {
      const merged = await pullCloudDestinations(activeClient);
      if (!merged) {
        setSyncMsg('Could not reach portal — check environment connection.');
        return;
      }
      persistLocal(merged);
      setSyncMsg(merged.length
        ? `Synced ${merged.length} destination${merged.length === 1 ? '' : 's'} from portal.`
        : 'No destinations in portal yet — add them under Admin → client.');
    } catch (e) {
      setSyncMsg(String(e).replace(/^Error:\s*/i, ''));
    } finally {
      setSyncing(false);
    }
  }

  function startEdit(dest: CloudDestination) {
    setEditing(dest);
    setView('form');
  }

  return view === 'list'
    ? (
      <DestList
        dests={dests}
        clientName={activeClient.name}
        syncing={syncing}
        syncMsg={syncMsg}
        onSync={handleSync}
        onEdit={startEdit}
      />
    )
    : editing
      ? (
        <DestCredentialsForm
          dest={editing}
          onSave={handleSave}
          onBack={() => setView('list')}
        />
      )
      : null;
}
