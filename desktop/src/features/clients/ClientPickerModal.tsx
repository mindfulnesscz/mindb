import { useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { X, Check, Download, Upload, RefreshCw, ExternalLink } from 'lucide-react';
import { useClientStore } from '../../store/clientStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import { saveEnvironments } from '../../services/environmentService';
import {
  saveActiveClient, loadClientsForEnvironment, exportClientBundle, importClientBundle,
} from '../../services/clientService';
import { loadVocabulary, saveVocabulary } from '../../services/vocabService';
import { clientInitials, type Client } from '../../domain/client';
import css from './ClientPickerModal.module.css';

interface Props { onClose: () => void; }

const PORTAL_BASE = 'http://localhost:5173';

/** DB-first client picker — select client + environment. Identity edits live in the web portal. */
export function ClientPickerModal({ onClose }: Props) {
  const store = useClientStore();
  const { setField } = useSettingsStore();
  const { profile, setStatus } = useAuthStore();
  const { environments, activeEnvId, setActiveEnvId } = useEnvironmentStore();
  const [busy, setBusy] = useState(false);

  const isAdmin = profile?.role === 'admin';
  const env = environments.find(e => e.id === activeEnvId) ?? null;

  function applyClient(client: Client) {
    store.setActiveClientId(client.id);
    setField('sourceFolder', client.sourceFolder);
    setField('targetFolder', client.targetFolder);
    setField('vaultFolder',  client.vaultFolder);
    document.documentElement.style.setProperty('--client-accent', client.brandColor);
    if (activeEnvId) saveActiveClient(activeEnvId, client.id).catch(console.error);
    onClose();
  }

  async function openPortalAdmin() {
    try {
      await open(PORTAL_BASE);
    } catch (e) {
      alert(`Could not open portal: ${e}`);
    }
  }

  async function switchEnvironment(envId: string) {
    if (envId === activeEnvId) return;
    setActiveEnvId(envId);
    store.setClients([]);
    store.setActiveClientId(null);
    await saveEnvironments({ activeId: envId, list: environments });
    setStatus('booting');
    onClose();
  }

  async function refresh() {
    if (!env || !profile) return;
    setBusy(true);
    try {
      const { clients, activeClientId } = await loadClientsForEnvironment(env, profile.role, environments);
      store.setClients(clients);
      store.setActiveClientId(activeClientId);
    } catch (e) {
      alert(`Could not refresh clients: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(client: Client) {
    try {
      const vocab = await loadVocabulary(client.id);
      await exportClientBundle(client, vocab);
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }

  async function handleImport() {
    if (!activeEnvId) return;
    try {
      const result = await importClientBundle(activeEnvId, store.clients);
      if (!result) return;
      await saveVocabulary(result.vocabulary, result.clientId);
      await refresh();
      if (result.containedSecrets) {
        alert('This export file contained credentials (old format). They were NOT imported.');
      }
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  }

  return (
    <div className={css.overlay} onClick={onClose}>
      <div className={css.modal} onClick={e => e.stopPropagation()}>
        <div className={css.header}>
          <span className={css.title}>Clients</span>
          <button className={css.iconBtn} onClick={refresh} title="Refresh from database" disabled={busy}>
            <RefreshCw size={14} />
          </button>
          <button className={css.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {environments.length > 1 && (
          <div className={css.envRow}>
            <span className={css.envLabel}>Environment</span>
            <select
              className={css.envSelect}
              value={activeEnvId ?? ''}
              onChange={e => switchEnvironment(e.target.value)}
            >
              {environments.map(e => (
                <option key={e.id} value={e.id}>{e.name || e.supabaseUrl}</option>
              ))}
            </select>
          </div>
        )}

        <div className={css.list}>
          {store.loadError && (
            <p className={css.empty} style={{ color: 'var(--signal-error)' }}>
              Could not load clients: {store.loadError}
            </p>
          )}
          {!store.loadError && store.clients.length === 0 && (
            <p className={css.empty}>
              {isAdmin
                ? 'No clients in this environment — create one in the web portal.'
                : 'No clients assigned in this environment. Ask an admin to add you via Users → Editor → client checkboxes.'}
            </p>
          )}
          {store.clients.map(client => (
            <div
              key={client.id}
              className={`${css.row}${client.id === store.activeClientId ? ` ${css.rowActive}` : ''}`}
            >
              <button className={css.rowMain} onClick={() => applyClient(client)}>
                <ClientAvatar client={client} size={32} />
                <span className={css.rowName}>{client.name || 'Unnamed client'}</span>
                {client.id === store.activeClientId && (
                  <Check size={14} className={css.activeCheck} />
                )}
              </button>
              <div className={css.rowActions}>
                <button className={css.iconBtn} onClick={() => handleExport(client)} title="Export local config + vocabulary">
                  <Download size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className={css.footer}>
          <button className={css.addBtn} onClick={handleImport}>
            <Upload size={14} />
            Import…
          </button>
          {isAdmin && (
            <button className={css.addBtn} onClick={openPortalAdmin}>
              <ExternalLink size={14} />
              Manage in portal
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ClientAvatar({ client, size }: { client: Client; size: number }) {
  if (client.logoUrl) {
    return (
      <img
        src={client.logoUrl}
        alt={client.name}
        className={css.avatarImg}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={css.avatarInitials}
      style={{
        width:           size,
        height:          size,
        fontSize:        Math.round(size * 0.35),
        backgroundColor: client.brandColor || 'var(--ink-700)',
      }}
    >
      {clientInitials(client.name) || '?'}
    </div>
  );
}
