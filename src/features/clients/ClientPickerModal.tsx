import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { Pencil, Trash2, Plus, ChevronLeft, X, Check, Download, Upload } from 'lucide-react';
import { useClientStore } from '../../store/clientStore';
import { useSettingsStore } from '../../store/settingsStore';
import { saveClients, exportClientBundle, importClientBundle } from '../../services/clientService';
import { loadVocabulary, saveVocabulary } from '../../services/vocabService';
import { makeClient, clientInitials, type Client } from '../../domain/client';
import css from './ClientPickerModal.module.css';

interface Props { onClose: () => void; }

type View = 'list' | 'form';

export function ClientPickerModal({ onClose }: Props) {
  const store = useClientStore();
  const { setField } = useSettingsStore();
  const [view, setView] = useState<View>('list');
  const [editing, setEditing] = useState<Client | null>(null);

  function applyClient(client: Client) {
    store.setActiveClientId(client.id);
    setField('sourceFolder', client.sourceFolder);
    setField('targetFolder', client.targetFolder);
    setField('vaultFolder',  client.vaultFolder);
    document.documentElement.style.setProperty('--client-accent', client.brandColor);
    saveClients({ clients: store.clients, activeClientId: client.id }).catch(console.error);
    onClose();
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
    try {
      const result = await importClientBundle();
      if (!result) return;
      const { client, vocabulary } = result;
      const updated = [...store.clients, client];
      store.addClient(client);
      await saveClients({ clients: updated, activeClientId: store.activeClientId });
      await saveVocabulary(vocabulary, client.id);
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  }

  function startAdd() {
    setEditing(makeClient());
    setView('form');
  }

  function startEdit(client: Client) {
    setEditing({ ...client });
    setView('form');
  }

  function handleDelete(id: string) {
    const updated      = store.clients.filter(c => c.id !== id);
    const newActiveId  = store.activeClientId === id ? null : store.activeClientId;
    store.deleteClient(id);
    if (newActiveId === null && store.activeClientId === id) {
      document.documentElement.style.removeProperty('--client-accent');
    }
    saveClients({ clients: updated, activeClientId: newActiveId }).catch(console.error);
  }

  async function handleSave(client: Client) {
    const isNew = !store.clients.find(c => c.id === client.id);
    let updated: Client[];
    if (isNew) {
      updated = [...store.clients, client];
      store.addClient(client);
    } else {
      updated = store.clients.map(c => c.id === client.id ? client : c);
      store.updateClient(client.id, client);
    }
    await saveClients({ clients: updated, activeClientId: store.activeClientId });
    setView('list');
  }

  return (
    <div className={css.overlay} onClick={onClose}>
      <div className={css.modal} onClick={e => e.stopPropagation()}>
        {view === 'list'
          ? <ListView
              clients={store.clients}
              activeClientId={store.activeClientId}
              onSelect={applyClient}
              onEdit={startEdit}
              onDelete={handleDelete}
              onExport={handleExport}
              onAdd={startAdd}
              onImport={handleImport}
              onClose={onClose}
            />
          : <FormView
              initial={editing!}
              onSave={handleSave}
              onBack={() => setView('list')}
              onClose={onClose}
            />
        }
      </div>
    </div>
  );
}

/* ── List view ────────────────────────────────────────────────────────────── */

interface ListProps {
  clients:        Client[];
  activeClientId: string | null;
  onSelect:  (c: Client) => void;
  onEdit:    (c: Client) => void;
  onDelete:  (id: string) => void;
  onExport:  (c: Client) => void;
  onAdd:     () => void;
  onImport:  () => void;
  onClose:   () => void;
}

function ListView({ clients, activeClientId, onSelect, onEdit, onDelete, onExport, onAdd, onImport, onClose }: ListProps) {
  return (
    <>
      <div className={css.header}>
        <span className={css.title}>Clients</span>
        <button className={css.iconBtn} onClick={onClose}><X size={16} /></button>
      </div>

      <div className={css.list}>
        {clients.length === 0 && (
          <p className={css.empty}>No clients yet. Add one to get started.</p>
        )}
        {clients.map(client => (
          <div
            key={client.id}
            className={`${css.row}${client.id === activeClientId ? ` ${css.rowActive}` : ''}`}
          >
            <button className={css.rowMain} onClick={() => onSelect(client)}>
              <ClientAvatar client={client} size={32} />
              <span className={css.rowName}>{client.name || 'Unnamed client'}</span>
              {client.id === activeClientId && (
                <Check size={14} className={css.activeCheck} />
              )}
            </button>
            <div className={css.rowActions}>
              <button className={css.iconBtn} onClick={() => onExport(client)} title="Export client">
                <Download size={14} />
              </button>
              <button className={css.iconBtn} onClick={() => onEdit(client)} title="Edit">
                <Pencil size={14} />
              </button>
              <button className={css.iconBtn} onClick={() => onDelete(client.id)} title="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className={css.footer}>
        <button className={css.addBtn} onClick={onImport} title="Import a client from a .json export file">
          <Upload size={14} />
          Import…
        </button>
        <button className={css.addBtn} onClick={onAdd}>
          <Plus size={14} />
          Add client
        </button>
      </div>
    </>
  );
}

/* ── Form view ────────────────────────────────────────────────────────────── */

interface FormProps {
  initial: Client;
  onSave:  (c: Client) => Promise<void>;
  onBack:  () => void;
  onClose: () => void;
}

function FormView({ initial, onSave, onBack, onClose }: FormProps) {
  const [form, setForm]     = useState<Client>(initial);
  const [saving, setSaving] = useState(false);

  const isNew = !useClientStore.getState().clients.find(c => c.id === initial.id);

  function patch<K extends keyof Client>(key: K, value: Client[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

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
    patch('logoDataUrl', `data:${mime};base64,${btoa(binary)}`);
  }

  async function pickFolder(key: 'sourceFolder' | 'targetFolder' | 'vaultFolder') {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) patch(key, selected as string);
  }

  async function submit() {
    if (!form.name.trim()) return;
    setSaving(true);
    await onSave(form).catch(console.error);
    setSaving(false);
  }

  return (
    <>
      <div className={css.header}>
        <button className={css.iconBtn} onClick={onBack}><ChevronLeft size={16} /></button>
        <span className={css.title}>{isNew ? 'New client' : 'Edit client'}</span>
        <button className={css.iconBtn} onClick={onClose}><X size={16} /></button>
      </div>

      <div className={css.formBody}>
        {/* Identity */}
        <div className={css.section}>
          <div className={css.sectionTitle}>Identity</div>

          <label className={css.field}>
            <span className={css.fieldLabel}>Name</span>
            <input
              className={css.input}
              value={form.name}
              onChange={e => patch('name', e.target.value)}
              placeholder="e.g. ESS Marketing"
              autoFocus
            />
          </label>

          <div className={css.field}>
            <span className={css.fieldLabel}>Logo</span>
            <div className={css.logoRow}>
              <ClientAvatar client={form} size={48} />
              <button className={css.outlineBtn} onClick={pickLogo}>
                {form.logoDataUrl ? 'Change image…' : 'Choose image…'}
              </button>
              {form.logoDataUrl && (
                <button className={css.iconBtn} onClick={() => patch('logoDataUrl', null)} title="Remove">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>Brand colour</span>
            <div className={css.colorRow}>
              <input
                type="color"
                className={css.colorSwatch}
                value={form.brandColor}
                onChange={e => patch('brandColor', e.target.value)}
              />
              <input
                className={`${css.input} ${css.inputMono} ${css.inputColor}`}
                value={form.brandColor}
                onChange={e => {
                  const v = e.target.value;
                  if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) patch('brandColor', v);
                }}
                maxLength={7}
              />
            </div>
          </div>
        </div>

        {/* Folders */}
        <div className={css.section}>
          <div className={css.sectionTitle}>Folders</div>

          {(['sourceFolder', 'targetFolder', 'vaultFolder'] as const).map(key => (
            <div className={css.field} key={key}>
              <span className={css.fieldLabel}>
                {key === 'sourceFolder' ? 'Source' : key === 'targetFolder' ? 'Target' : 'Vault (DAM)'}
              </span>
              <div className={css.folderRow}>
                <input
                  className={`${css.input} ${css.inputMono} ${css.inputFlex}`}
                  value={form[key]}
                  onChange={e => patch(key, e.target.value)}
                  placeholder="Not set"
                />
                <button className={css.outlineBtn} onClick={() => pickFolder(key)}>Browse…</button>
              </div>
            </div>
          ))}
        </div>

      </div>

      <div className={css.footer}>
        <button className={css.outlineBtn} onClick={onBack}>Cancel</button>
        <button
          className={css.saveBtn}
          onClick={submit}
          disabled={!form.name.trim() || saving}
        >
          {saving ? 'Saving…' : 'Save client'}
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
