import { useState, useRef, useEffect } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as openBrowser } from '@tauri-apps/plugin-shell';
import { Pencil, Trash2, Plus, ChevronLeft, Copy, Check, RefreshCw } from 'lucide-react';
import { useClientStore } from '../../store/clientStore';
import { saveClients, pushCloudDestinations } from '../../services/clientService';
import {
  connectDropbox, checkDropboxConnection, refreshDropboxToken,
  startOneDriveDeviceCode, pollOneDriveToken, checkOneDriveConnection, refreshOneDriveToken,
  connectGDrive, checkGDriveConnection, refreshGDriveToken,
  type DeviceCodeInfo, delay,
} from '../../services/cloudService';
import {
  makeDestination, tokenStatus, cloudToken,
  type CloudDestination, type DestConfig, type DestType, type DestRole,
  type LocalDestConfig, type DropboxDestConfig, type OneDriveDestConfig, type GDriveDestConfig,
  type CloudToken,
} from '../../domain/client';
import css from './CloudDestinations.module.css';

/* ── Main container ──────────────────────────────────────────────────────── */

export function CloudDestinations() {
  const { clients, activeClientId, updateClient } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;
  const [view, setView]   = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<CloudDestination | null>(null);

  if (!activeClient) {
    return <p className={css.noClient}>Select a client to manage cloud destinations.</p>;
  }

  const dests = activeClient.cloudDestinations;

  function persist(updated: CloudDestination[]) {
    if (!activeClient) return;
    updateClient(activeClient.id, { cloudDestinations: updated });
    const updatedClients = clients.map(c => c.id === activeClientId
      ? { ...c, cloudDestinations: updated } : c);
    saveClients({ clients: updatedClients, activeClientId }).catch(console.error);
    pushCloudDestinations({ ...activeClient, cloudDestinations: updated }).catch(console.error);
  }

  function handleSave(dest: CloudDestination) {
    const isNew = !dests.find(d => d.id === dest.id);
    persist(isNew ? [...dests, dest] : dests.map(d => d.id === dest.id ? dest : d));
    setView('list');
  }

  function handleDelete(id: string) {
    persist(dests.filter(d => d.id !== id));
  }

  function startAdd() {
    setEditing(null);
    setView('form');
  }

  function startEdit(dest: CloudDestination) {
    setEditing(dest);
    setView('form');
  }

  return view === 'list'
    ? <DestList
        dests={dests}
        clientName={activeClient.name}
        onAdd={startAdd}
        onEdit={startEdit}
        onDelete={handleDelete}
      />
    : <DestForm
        dest={editing ?? makeDestination()}
        onSave={handleSave}
        onBack={() => setView('list')}
      />;
}

/* ── Destination list ────────────────────────────────────────────────────── */

function DestList({
  dests, clientName, onAdd, onEdit, onDelete,
}: {
  dests: CloudDestination[];
  clientName: string;
  onAdd: () => void;
  onEdit: (d: CloudDestination) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <div className={css.listHeader}>
        <span className={css.listTitle}>
          Cloud destinations
          {clientName && <span className={css.clientLabel}>— {clientName}</span>}
        </span>
      </div>

      {dests.length === 0
        ? <p className={css.empty}>No destinations yet. Add one to enable cloud export.</p>
        : (
          <div className={css.destList}>
            {dests.map(dest => {
              const token  = cloudToken(dest.config);
              const status = dest.config.type === 'local' ? 'none' : tokenStatus(token);
              const path   = dest.config.type === 'local'
                ? dest.config.path
                : dest.config.remotePath;
              return (
                <div key={dest.id} className={css.destRow}>
                  <span className={`${css.destTypeTag} ${typeClass(dest.config.type)}`}>
                    {typeLabel(dest.config.type)}
                  </span>
                  <span className={css.destName}>{dest.name || 'Unnamed'}</span>
                  <span className={css.destPath}>{path || '—'}</span>
                  <span className={css.roleBadge}>{dest.role}</span>
                  <span className={`${css.statusDot} ${statusClass(status)}`} title={statusTitle(status, token)} />
                  <div className={css.rowActions}>
                    <button className={css.iconBtn} onClick={() => onEdit(dest)} title="Edit"><Pencil size={14} /></button>
                    <button className={`${css.iconBtn} ${css.iconBtnDanger}`} onClick={() => onDelete(dest.id)} title="Delete"><Trash2 size={14} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      }

      <button className={css.addBtn} onClick={onAdd}>
        <Plus size={14} /> Add destination
      </button>
    </>
  );
}

/* ── Destination form ────────────────────────────────────────────────────── */

type AuthPhase = 'idle' | 'connecting' | 'device-code' | 'checking' | 'refreshing' | 'done' | 'error';

function DestForm({
  dest, onSave, onBack,
}: {
  dest:   CloudDestination;
  onSave: (d: CloudDestination) => void;
  onBack: () => void;
}) {
  const [form, setForm]     = useState<CloudDestination>(dest);
  const [authPhase, setAuthPhase]   = useState<AuthPhase>(() => {
    const tok = cloudToken(dest.config);
    return tok ? 'done' : 'idle';
  });
  const [deviceInfo, setDeviceInfo] = useState<DeviceCodeInfo | null>(null);
  const [authError, setAuthError]   = useState<string | null>(null);
  const [copied, setCopied]         = useState(false);
  const cancelRef = useRef({ cancelled: false });

  useEffect(() => {
    const sig = cancelRef.current;
    return () => { sig.cancelled = true; };
  }, []);

  function patch(changes: Partial<CloudDestination>) {
    setForm(f => ({ ...f, ...changes }));
  }

  function patchConfig(changes: Partial<DestConfig>) {
    setForm(f => ({ ...f, config: { ...f.config, ...changes } as DestConfig }));
  }

  function setType(type: DestType) {
    const base = { id: form.config.type === type ? (form.config as any).clientId ?? '' : '', remotePath: '', token: null };
    let config: DestConfig;
    if (type === 'local')    config = { type, path: (form.config as LocalDestConfig).path ?? '' };
    else if (type === 'dropbox')  config = { type, clientId: base.id, remotePath: base.remotePath, token: null };
    else if (type === 'onedrive') config = { type, clientId: base.id, tenantId: form.config.type === 'onedrive' ? form.config.tenantId : 'common', remotePath: base.remotePath, token: null };
    else                          config = { type, clientId: base.id, clientSecret: '', sharedDriveId: form.config.type === 'gdrive' ? form.config.sharedDriveId : '', remotePath: base.remotePath, token: null };
    setForm(f => ({ ...f, config }));
    setAuthPhase('idle');
    setAuthError(null);
    setDeviceInfo(null);
  }

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) patchConfig({ path: selected as string } as Partial<LocalDestConfig>);
  }

  async function handleConnect() {
    const cfg = form.config;
    if (cfg.type === 'local') return;

    setAuthPhase('connecting');
    setAuthError(null);
    setDeviceInfo(null);
    cancelRef.current.cancelled = false;

    try {
      let token: CloudToken;

      if (cfg.type === 'dropbox') {
        token = await connectDropbox(cfg.clientId);
      } else if (cfg.type === 'onedrive') {
        const info = await startOneDriveDeviceCode(cfg.clientId, cfg.tenantId);
        setDeviceInfo(info);
        setAuthPhase('device-code');
        // Poll until token or cancelled
        token = null!;
        const deadline = Date.now() + info.expiresIn * 1000;
        const intervalMs = (info.interval + 1) * 1000;
        while (!cancelRef.current.cancelled && !token && Date.now() < deadline) {
          await delay(intervalMs);
          if (cancelRef.current.cancelled) return;
          const result = await pollOneDriveToken(cfg.clientId, cfg.tenantId, info.deviceCode, info.interval, cancelRef.current);
          if (result) token = result;
        }
        if (!token) throw new Error('Authorization timed out or was cancelled.');
      } else {
        token = await connectGDrive(cfg.clientId, cfg.clientSecret);
      }

      if (cancelRef.current.cancelled) return;

      setAuthPhase('checking');
      const info = cfg.type === 'dropbox'
        ? await checkDropboxConnection(token.accessToken)
        : cfg.type === 'onedrive'
        ? await checkOneDriveConnection(token.accessToken)
        : await checkGDriveConnection(token.accessToken);

      token.email       = info.email;
      token.displayName = info.displayName;

      setForm(f => ({ ...f, config: { ...f.config, token } as DestConfig }));
      setAuthPhase('done');
    } catch (e) {
      if (!cancelRef.current.cancelled) {
        setAuthError(String(e).replace(/^Error:\s*/i, ''));
        setAuthPhase('error');
      }
    }
  }

  async function handleRefresh() {
    const cfg = form.config;
    if (cfg.type === 'local' || !cfg.token) return;
    setAuthPhase('refreshing');
    setAuthError(null);
    try {
      let updates: Partial<CloudToken>;
      if (cfg.type === 'dropbox')  updates = await refreshDropboxToken(cfg.clientId, cfg.token.refreshToken);
      else if (cfg.type === 'onedrive') updates = await refreshOneDriveToken(cfg.clientId, cfg.tenantId, cfg.token.refreshToken);
      else                              updates = await refreshGDriveToken(cfg.clientId, cfg.clientSecret, cfg.token.refreshToken);
      const newToken = { ...cfg.token, ...updates };
      setForm(f => ({ ...f, config: { ...f.config, token: newToken } as DestConfig }));
      setAuthPhase('done');
    } catch (e) {
      setAuthError(String(e).replace(/^Error:\s*/i, ''));
      setAuthPhase('error');
    }
  }

  function handleDisconnect() {
    cancelRef.current.cancelled = true;
    setForm(f => ({ ...f, config: { ...f.config, token: null } as DestConfig }));
    setAuthPhase('idle');
    setAuthError(null);
    setDeviceInfo(null);
  }

  async function copyCode() {
    if (!deviceInfo) return;
    await navigator.clipboard.writeText(deviceInfo.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const cfg = form.config;
  const isCloud = cfg.type !== 'local';
  const existingToken = isCloud ? (cfg as DropboxDestConfig | OneDriveDestConfig | GDriveDestConfig).token : null;
  const tStatus = existingToken ? tokenStatus(existingToken) : 'none';
  const busy = authPhase === 'connecting' || authPhase === 'device-code' || authPhase === 'checking' || authPhase === 'refreshing';

  return (
    <>
      <div className={css.formHeader}>
        <button className={css.iconBtn} onClick={onBack} title="Back"><ChevronLeft size={16} /></button>
        <span className={css.formTitle}>{dest.name ? `Edit — ${dest.name}` : 'New destination'}</span>
      </div>

      <div className={css.formBody}>

        {/* ── Identity ── */}
        <div className={css.formSection}>
          <div className={css.sectionLabel}>Identity</div>
          <div className={css.fieldGroup}>
            <div className={css.field}>
              <span className={css.fieldLabel}>Name</span>
              <input
                className={css.input}
                value={form.name}
                onChange={e => patch({ name: e.target.value })}
                placeholder="e.g. Internal Team, Client Deliverables"
                autoFocus
              />
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>Role</span>
              <div className={css.segRow}>
                {(['internal', 'client'] as DestRole[]).map(r => (
                  <button
                    key={r}
                    className={`${css.seg}${form.role === r ? ` ${css.segActive}` : ''}`}
                    onClick={() => patch({ role: r })}
                  >
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Type ── */}
        <div className={css.formSection}>
          <div className={css.sectionLabel}>Type</div>
          <div className={css.typeRow}>
            {(['local', 'dropbox', 'onedrive', 'gdrive'] as DestType[]).map(t => (
              <button
                key={t}
                className={`${css.typeBtn}${cfg.type === t ? ` ${css.typeBtnActive}` : ''}`}
                onClick={() => setType(t)}
              >
                {typeLabel(t)}
              </button>
            ))}
          </div>
        </div>

        {/* ── Local config ── */}
        {cfg.type === 'local' && (
          <div className={css.formSection}>
            <div className={css.sectionLabel}>Folder</div>
            <div className={css.field}>
              <div className={css.folderRow}>
                <input
                  className={`${css.input} ${css.inputMono}`}
                  value={(cfg as LocalDestConfig).path}
                  onChange={e => patchConfig({ path: e.target.value } as Partial<LocalDestConfig>)}
                  placeholder="Not set"
                />
                <button className={css.outlineBtn} onClick={pickFolder}>Browse…</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Cloud config ── */}
        {isCloud && (
          <>
            <div className={css.formSection}>
              <div className={css.sectionLabel}>Credentials</div>
              <div className={css.fieldGroup}>
                <div className={css.field}>
                  <span className={css.fieldLabel}>
                    {cfg.type === 'dropbox'  ? 'Dropbox App Key' :
                     cfg.type === 'onedrive' ? 'Azure App (Client ID)' :
                                               'Google Client ID'}
                  </span>
                  <input
                    className={`${css.input} ${css.inputMono}`}
                    value={(cfg as DropboxDestConfig).clientId}
                    onChange={e => patchConfig({ clientId: e.target.value } as any)}
                    placeholder={
                      cfg.type === 'dropbox'  ? 'From Dropbox App Console → Settings' :
                      cfg.type === 'onedrive' ? 'From Azure Portal → App registrations' :
                                                'From Google Cloud Console → Credentials'
                    }
                  />
                  <span className={css.fieldHint}>{credHint(cfg.type)}</span>
                </div>
                {cfg.type === 'onedrive' && (
                  <div className={css.field}>
                    <span className={css.fieldLabel}>Azure Tenant ID</span>
                    <input
                      className={`${css.input} ${css.inputMono}`}
                      value={(cfg as OneDriveDestConfig).tenantId ?? ''}
                      onChange={e => patchConfig({ tenantId: e.target.value } as Partial<OneDriveDestConfig>)}
                      placeholder="common"
                    />
                    <span className={css.fieldHint}>
                      Use "common" for personal/multi-tenant apps. If the app registration's Supported account types
                      is "Single tenant" / "My organization only", enter the Directory (tenant) ID from the app's Overview page instead.
                    </span>
                  </div>
                )}
                {cfg.type === 'gdrive' && (
                  <div className={css.field}>
                    <span className={css.fieldLabel}>Google Client Secret</span>
                    <input
                      className={`${css.input} ${css.inputMono}`}
                      type="password"
                      value={(cfg as GDriveDestConfig).clientSecret}
                      onChange={e => patchConfig({ clientSecret: e.target.value } as Partial<GDriveDestConfig>)}
                      placeholder="From Google Cloud Console → Credentials"
                    />
                  </div>
                )}
                {cfg.type === 'gdrive' && (
                  <div className={css.field}>
                    <span className={css.fieldLabel}>Shared Drive ID</span>
                    <input
                      className={`${css.input} ${css.inputMono}`}
                      value={(cfg as GDriveDestConfig).sharedDriveId ?? ''}
                      onChange={e => patchConfig({ sharedDriveId: e.target.value } as Partial<GDriveDestConfig>)}
                      placeholder="Leave blank to use the signed-in account's own My Drive"
                    />
                    <span className={css.fieldHint}>
                      Set this so every teammate's uploads land in one shared Drive instead of whoever connected's
                      personal My Drive. Find it in Google Drive → open the Shared Drive → copy the ID from the URL
                      (after /folders/).
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className={css.formSection}>
              <div className={css.sectionLabel}>Remote folder</div>
              <div className={css.field}>
                <input
                  className={`${css.input} ${css.inputMono}`}
                  value={(cfg as DropboxDestConfig).remotePath}
                  onChange={e => patchConfig({ remotePath: e.target.value } as any)}
                  placeholder={
                    cfg.type === 'dropbox'  ? '/DC Hub/ClientName/Exports' :
                    cfg.type === 'onedrive' ? '/DC Hub/ClientName/Exports' :
                                              'DC Hub/ClientName/Exports'
                  }
                />
                <span className={css.fieldHint}>Path within your cloud storage where files will be uploaded.</span>
              </div>
            </div>

            <div className={css.formSection}>
              <div className={css.sectionLabel}>Export options</div>
              <div className={css.fieldGroup}>
                <label className={css.toggleRow}>
                  <input
                    type="checkbox"
                    className={css.toggle}
                    checked={form.flatExport}
                    onChange={e => patch({ flatExport: e.target.checked })}
                  />
                  <span className={css.toggleLabel}>Flat export — dump all files into one folder (ignore subfolder structure)</span>
                </label>
                <label className={css.toggleRow}>
                  <input
                    type="checkbox"
                    className={css.toggle}
                    checked={form.generateLink}
                    onChange={e => patch({ generateLink: e.target.checked })}
                  />
                  <span className={css.toggleLabel}>Generate sharing link after upload</span>
                </label>
              </div>
            </div>

            {/* ── Auth section ── */}
            <div className={css.formSection}>
              <div className={css.sectionLabel}>Connection</div>
              <div className={css.authBox}>

                {/* Error */}
                {authError && <p className={css.authError}>{authError}</p>}

                {/* Connected */}
                {authPhase === 'done' && existingToken && (
                  <div className={css.authStatus}>
                    <span className={`${css.statusDot} ${statusClass(tStatus)}`} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={css.authEmail}>{existingToken.email || 'Connected'}</div>
                      {existingToken.displayName && <div className={css.authName}>{existingToken.displayName}</div>}
                      {tStatus !== 'fresh' && (
                        <div className={css.authName} style={{ color: tStatus === 'expired' ? 'var(--signal-error)' : '#facc15' }}>
                          {tStatus === 'expired' ? 'Token expired — refresh or reconnect' : 'Expires soon'}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Connecting / checking */}
                {(authPhase === 'connecting' || authPhase === 'checking' || authPhase === 'refreshing') && (
                  <div className={css.authStatus}>
                    <span className={css.spinner} />
                    <span className={css.authEmail} style={{ flex: 1 }}>
                      {authPhase === 'refreshing' ? 'Refreshing token…' :
                       authPhase === 'checking'   ? 'Verifying connection…' :
                       cfg.type === 'onedrive'    ? 'Requesting device code…' :
                                                    'Complete sign-in in the browser…'}
                    </span>
                    {(authPhase === 'connecting') && (
                      <button
                        className={`${css.outlineBtn} ${css.outlineBtnDanger}`}
                        onClick={handleDisconnect}
                        style={{ marginLeft: 'auto', flexShrink: 0 }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}

                {/* OneDrive device code */}
                {authPhase === 'device-code' && deviceInfo && (
                  <div className={css.deviceCode}>
                    <div className={css.deviceCodeRow}>
                      <span className={css.codeChip}>{deviceInfo.userCode}</span>
                      <button className={css.iconBtn} onClick={copyCode} title={copied ? 'Copied!' : 'Copy code'}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                    <p className={css.deviceHint}>
                      Go to <strong>{deviceInfo.verificationUri}</strong>, enter the code above, then sign in with your Microsoft account.
                      The app will detect when you've authorised it.
                    </p>
                    <div className={css.authBtns}>
                      <button className={css.outlineBtn} onClick={() => openBrowser(deviceInfo.verificationUri)}>
                        Open browser…
                      </button>
                      <span className={css.spinner} style={{ marginLeft: 'var(--sp-2)' }} />
                      <span className={css.authName} style={{ marginLeft: 'var(--sp-1)' }}>Waiting…</span>
                      <button className={`${css.outlineBtn} ${css.outlineBtnDanger}`} onClick={handleDisconnect} style={{ marginLeft: 'auto' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Idle / error state — show connect button */}
                {(authPhase === 'idle' || authPhase === 'error') && (
                  <div className={css.authBtns}>
                    <button
                      className={css.connectBtn}
                      onClick={handleConnect}
                      disabled={!(cfg as DropboxDestConfig).clientId?.trim() ||
                                (cfg.type === 'gdrive' && !(cfg as GDriveDestConfig).clientSecret?.trim())}
                    >
                      Connect to {typeLabel(cfg.type)}
                    </button>
                  </div>
                )}

                {/* Connected — refresh / reconnect / disconnect */}
                {authPhase === 'done' && (
                  <div className={css.authBtns}>
                    <button className={css.outlineBtn} onClick={handleRefresh} title="Refresh token without re-authorising">
                      <RefreshCw size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                      Refresh token
                    </button>
                    <button className={css.outlineBtn} onClick={handleConnect}>
                      Reconnect
                    </button>
                    <button className={`${css.outlineBtn} ${css.outlineBtnDanger}`} onClick={handleDisconnect}>
                      Disconnect
                    </button>
                  </div>
                )}

              </div>
            </div>
          </>
        )}

      </div>

      <div className={css.formFooter}>
        <button className={css.outlineBtn} onClick={onBack}>Cancel</button>
        <button
          className={css.saveBtn}
          onClick={() => onSave(form)}
          disabled={!form.name.trim() || busy}
        >
          Save destination
        </button>
      </div>
    </>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function typeLabel(t: DestType): string {
  return t === 'local' ? 'Local' : t === 'dropbox' ? 'Dropbox' : t === 'onedrive' ? 'OneDrive' : 'Google Drive';
}

function typeClass(t: DestType): string {
  return t === 'local' ? css.typeLocal : t === 'dropbox' ? css.typeDropbox : t === 'onedrive' ? css.typeOnedrive : css.typeGdrive;
}

function statusClass(s: ReturnType<typeof tokenStatus>): string {
  return s === 'fresh' ? css.statusFresh : s === 'expiring' ? css.statusExpiring : s === 'expired' ? css.statusExpired : css.statusNone;
}

function statusTitle(s: ReturnType<typeof tokenStatus>, token: CloudToken | null): string {
  if (!token) return 'Not connected';
  if (s === 'fresh')    return `Connected — ${token.email}`;
  if (s === 'expiring') return `Expires soon — ${token.email}`;
  if (s === 'expired')  return `Expired — reconnect needed`;
  return 'Not connected';
}

function credHint(type: DestType): string {
  if (type === 'dropbox')  return 'Create an app at dropbox.com/developers → App Console. Use PKCE, redirect URI: http://localhost:7623/callback';
  if (type === 'onedrive') return 'Register an app in Azure Portal, enable "Allow public client flows" (Authentication), and add Mobile/Desktop redirect URIs. Set the Tenant ID below to match the app\'s Supported account types.';
  return 'Create OAuth 2.0 credentials in Google Cloud Console. Add http://localhost:7623/callback as an authorised redirect URI.';
}
