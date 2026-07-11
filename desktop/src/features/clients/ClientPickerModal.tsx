import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { Pencil, Plus, ChevronLeft, X, Check, Download, Upload, RefreshCw } from 'lucide-react';
import { useClientStore } from '../../store/clientStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import { saveEnvironments } from '../../services/environmentService';
import {
  saveActiveClient, saveLocalClient, createDbClient, updateDbClient,
  loadClientsForEnvironment, exportClientBundle, importClientBundle,
} from '../../services/clientService';
import { loadVocabulary, saveVocabulary } from '../../services/vocabService';
import { clientInitials, type Client } from '../../domain/client';
import css from './ClientPickerModal.module.css';

interface Props { onClose: () => void; }

type View = 'list' | 'form';

/** Clients are DB-first: this picker lists what the database says exists for
 * the active environment (membership-filtered; admins see all). Editing a
 * client writes name/colour to the DB; logo and folders stay machine-local. */
export function ClientPickerModal({ onClose }: Props) {
  const store = useClientStore();
  const { setField } = useSettingsStore();
  const { profile, setStatus } = useAuthStore();
  const { environments, activeEnvId, setActiveEnvId } = useEnvironmentStore();
  const [view, setView] = useState<View>('list');
  const [editing, setEditing] = useState<Client | null>(null);
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

  async function switchEnvironment(envId: string) {
    if (envId === activeEnvId) return;
    setActiveEnvId(envId);
    store.setClients([]);
    store.setActiveClientId(null);
    await saveEnvironments({ activeId: envId, list: environments });
    // App.tsx reacts to the env change: re-auths (cached session or the gate)
    // and reloads this environment's clients.
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
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  }

  function startAdd() {
    if (!isAdmin) return;
    setEditing(null);
    setView('form');
  }

  function startEdit(client: Client) {
    if (!isAdmin) return;
    setEditing({ ...client });
    setView('form');
  }

  async function handleSave(name: string, accent: string, logoDataUrl: string | null) {
    if (!activeEnvId) return;
    setBusy(true);
    try {
      if (editing) {
        await updateDbClient(editing.id, { name, accent });
        store.updateClient(editing.id, { name, brandColor: accent, logoDataUrl });
        const updated = useClientStore.getState().clients.find(c => c.id === editing.id);
        if (updated) await saveLocalClient(activeEnvId, updated);
      } else {
        await createDbClient(name, accent);
        await refresh();
      }
      setView('list');
    } catch (e) {
      alert(`Save failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={css.overlay} onClick={onClose}>
      <div className={css.modal} onClick={e => e.stopPropagation()}>
        {view === 'list' ? (
          <>
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
              {store.clients.length === 0 && (
                <p className={css.empty}>
                  No clients in this environment{isAdmin ? ' — add one below.' : ' are assigned to you. Ask an admin for access.'}
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
                    {isAdmin && (
                      <button className={css.iconBtn} onClick={() => startEdit(client)} title="Edit (writes to database)">
                        <Pencil size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className={css.footer}>
              <button className={css.addBtn} onClick={handleImport} title="Import local config + vocabulary for an existing client">
                <Upload size={14} />
                Import…
              </button>
              {isAdmin && (
                <button className={css.addBtn} onClick={startAdd}>
                  <Plus size={14} />
                  Add client
                </button>
              )}
            </div>
          </>
        ) : (
          <ClientForm
            initial={editing}
            busy={busy}
            onSave={handleSave}
            onBack={() => setView('list')}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

/* ── Form (admin): name + colour go to the DB; logo stays machine-local ──── */

interface FormProps {
  initial: Client | null;
  busy:    boolean;
  onSave:  (name: string, accent: string, logoDataUrl: string | null) => Promise<void>;
  onBack:  () => void;
  onClose: () => void;
}

function ClientForm({ initial, busy, onSave, onBack, onClose }: FormProps) {
  const [name, setName]     = useState(initial?.name ?? '');
  const [accent, setAccent] = useState(initial?.brandColor ?? '#161616');
  const [logo, setLogo]     = useState<string | null>(initial?.logoDataUrl ?? null);

  async function pickLogo() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (!selected) return;
    const bytes = await readFile(selected as string);
    const ext   = (selected as string).split('.').pop()?.toLowerCase() ?? 'png';
    const mime  = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    let binary  = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    setLogo(`data:${mime};base64,${btoa(binary)}`);
  }

  const preview: Client = {
    ...(initial ?? ({} as Client)),
    name, brandColor: accent, logoDataUrl: logo,
  } as Client;

  return (
    <>
      <div className={css.header}>
        <button className={css.iconBtn} onClick={onBack}><ChevronLeft size={16} /></button>
        <span className={css.title}>{initial ? 'Edit client' : 'New client'}</span>
        <button className={css.iconBtn} onClick={onClose}><X size={16} /></button>
      </div>

      <div className={css.formBody}>
        <div className={css.section}>
          <div className={css.sectionTitle}>Identity (stored in the database)</div>

          <label className={css.field}>
            <span className={css.fieldLabel}>Name</span>
            <input
              className={css.input}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. ESS Marketing"
              autoFocus
            />
          </label>

          <div className={css.field}>
            <span className={css.fieldLabel}>Brand colour</span>
            <div className={css.colorRow}>
              <input
                type="color"
                className={css.colorSwatch}
                value={accent}
                onChange={e => setAccent(e.target.value)}
              />
              <input
                className={`${css.input} ${css.inputMono} ${css.inputColor}`}
                value={accent}
                onChange={e => {
                  const v = e.target.value;
                  if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) setAccent(v);
                }}
                maxLength={7}
              />
            </div>
          </div>
        </div>

        {initial && (
          <div className={css.section}>
            <div className={css.sectionTitle}>Logo (this machine only)</div>
            <div className={css.logoRow}>
              <ClientAvatar client={preview} size={48} />
              <button className={css.outlineBtn} onClick={pickLogo}>
                {logo ? 'Change image…' : 'Choose image…'}
              </button>
              {logo && (
                <button className={css.iconBtn} onClick={() => setLogo(null)} title="Remove">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={css.footer}>
        <button className={css.outlineBtn} onClick={onBack}>Cancel</button>
        <button
          className={css.saveBtn}
          onClick={() => onSave(name.trim(), accent, logo)}
          disabled={!name.trim() || busy}
        >
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Create client'}
        </button>
      </div>
    </>
  );
}

/* ── Shared avatar ────────────────────────────────────────────────────────── */

export function ClientAvatar({ client, size }: { client: Client; size: number }) {
  if (client.logoDataUrl) {
    return (
      <img
        src={client.logoDataUrl}
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
