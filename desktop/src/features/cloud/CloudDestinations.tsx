import { useState, useRef, useEffect } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as openBrowser } from '@tauri-apps/plugin-shell';
import { Pencil, ChevronLeft, Copy, Check, RefreshCw, RefreshCcw } from 'lucide-react';
import { useClientStore } from '../../store/clientStore';
import { saveClients, pullCloudDestinations } from '../../services/clientService';
import { useEnvironmentStore } from '../../store/environmentStore';
import { saveLocalClient } from '../../services/clientService';
import {
  connectDropbox, checkDropboxConnection, refreshDropboxToken,
  startOneDriveDeviceCode, pollOneDriveToken, checkOneDriveConnection, refreshOneDriveToken,
  connectGDrive, checkGDriveConnection, refreshGDriveToken,
  type DeviceCodeInfo, delay,
} from '../../services/cloudService';
import {
  tokenStatus, cloudToken,
  type CloudDestination, type DestConfig, type DestType,
  type LocalDestConfig, type DropboxDestConfig, type OneDriveDestConfig, type GDriveDestConfig,
  type CloudToken,
} from '../../domain/client';
import css from './CloudDestinations.module.css';

/* ── Main container — portal owns structure; this UI is credentials only ─── */

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
    saveClients({ clients: updatedClients, activeClientId }).catch(console.error);
    if (activeEnvId) {
      const next = updatedClients.find(c => c.id === activeClient.id);
      if (next) saveLocalClient(activeEnvId, next).catch(console.error);
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

/* ── Destination list ────────────────────────────────────────────────────── */

function DestList({
  dests, clientName, syncing, syncMsg, onSync, onEdit,
}: {
  dests: CloudDestination[];
  clientName: string;
  syncing: boolean;
  syncMsg: string;
  onSync: () => void;
  onEdit: (d: CloudDestination) => void;
}) {
  return (
    <>
      <div className={css.listHeader}>
        <span className={css.listTitle}>
          Cloud destinations
          {clientName && <span className={css.clientLabel}>— {clientName}</span>}
        </span>
        <button className={css.outlineBtn} onClick={onSync} disabled={syncing} title="Pull from portal">
          <RefreshCcw size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      <p className={css.empty} style={{ marginBottom: 'var(--sp-3)' }}>
        Structure (name, remote paths, roles, package export) is managed in the web portal.
        Set local folder paths and connect OAuth here — tokens stay on this machine.
      </p>
      {syncMsg && <p className={css.empty} style={{ marginTop: 0 }}>{syncMsg}</p>}

      {dests.length === 0
        ? <p className={css.empty}>No destinations yet. Add them in the portal Admin drawer, then Sync.</p>
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
                  <span className={css.destPath}>
                    {path || (dest.config.type === 'local' ? 'Set path…' : '—')}
                    {` · ${dest.exportLayout === 'flat' ? 'flat' : dest.includePackages ? 'folders+packages' : 'folders'}`}
                  </span>
                  <span className={css.roleBadge}>{dest.role}</span>
                  <span className={`${css.statusDot} ${statusClass(status)}`} title={statusTitle(status, token)} />
                  <div className={css.rowActions}>
                    <button className={css.iconBtn} onClick={() => onEdit(dest)} title="Connect / credentials">
                      <Pencil size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </>
  );
}

/* ── Credentials form (structure is read-only) ───────────────────────────── */

type AuthPhase = 'idle' | 'connecting' | 'device-code' | 'checking' | 'refreshing' | 'done' | 'error';

function DestCredentialsForm({
  dest, onSave, onBack,
}: {
  dest:   CloudDestination;
  onSave: (d: CloudDestination) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<CloudDestination>(dest);
  const [authPhase, setAuthPhase] = useState<AuthPhase>(() => {
    const tok = cloudToken(dest.config);
    return tok ? 'done' : 'idle';
  });
  const [deviceInfo, setDeviceInfo] = useState<DeviceCodeInfo | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef({ cancelled: false });

  useEffect(() => {
    const sig = cancelRef.current;
    return () => { sig.cancelled = true; };
  }, []);

  function patchConfig(changes: Partial<DestConfig>) {
    setForm(f => ({ ...f, config: { ...f.config, ...changes } as DestConfig }));
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
  const path = cfg.type === 'local' ? cfg.path : cfg.remotePath;

  return (
    <>
      <div className={css.formHeader}>
        <button className={css.iconBtn} onClick={onBack} title="Back"><ChevronLeft size={16} /></button>
        <span className={css.formTitle}>Connect — {dest.name || 'destination'}</span>
      </div>

      <div className={css.formBody}>
        <div className={css.formSection}>
          <div className={css.sectionLabel}>From portal</div>
          <div className={css.fieldGroup}>
            <div className={css.field}>
              <span className={css.fieldLabel}>Name</span>
              <input className={css.input} value={form.name} disabled />
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>Type / role / path</span>
              <input
                className={`${css.input} ${css.inputMono}`}
                value={`${typeLabel(cfg.type)} · ${form.role} · ${path || '—'} · ${form.exportLayout}${form.includePackages ? '+packages' : ''}`}
                disabled
              />
            </div>
          </div>
        </div>

        {cfg.type === 'local' && (
          <div className={css.formSection}>
            <div className={css.sectionLabel}>Local folder (this machine)</div>
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

        {isCloud && (
          <>
            <div className={css.formSection}>
              <div className={css.sectionLabel}>Credentials (this machine)</div>
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
                    onChange={e => patchConfig({ clientId: e.target.value } as Partial<DropboxDestConfig>)}
                    placeholder="From portal, or override locally"
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
                      placeholder="Stored only on this machine"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className={css.formSection}>
              <div className={css.sectionLabel}>Connection</div>
              <div className={css.authBox}>
                {authError && <p className={css.authError}>{authError}</p>}

                {authPhase === 'done' && existingToken && (
                  <div className={css.authStatus}>
                    <span className={`${css.statusDot} ${statusClass(tStatus)}`} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={css.authEmail}>{existingToken.email || 'Connected'}</div>
                      {existingToken.displayName && <div className={css.authName}>{existingToken.displayName}</div>}
                    </div>
                  </div>
                )}

                {(authPhase === 'connecting' || authPhase === 'checking' || authPhase === 'refreshing') && (
                  <div className={css.authStatus}>
                    <span className={css.spinner} />
                    <span className={css.authEmail} style={{ flex: 1 }}>
                      {authPhase === 'refreshing' ? 'Refreshing token…' :
                       authPhase === 'checking'   ? 'Verifying connection…' :
                       cfg.type === 'onedrive'    ? 'Requesting device code…' :
                                                    'Complete sign-in in the browser…'}
                    </span>
                  </div>
                )}

                {authPhase === 'device-code' && deviceInfo && (
                  <div className={css.deviceCode}>
                    <div className={css.deviceCodeRow}>
                      <span className={css.codeChip}>{deviceInfo.userCode}</span>
                      <button className={css.iconBtn} onClick={copyCode} title={copied ? 'Copied!' : 'Copy code'}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                    <p className={css.deviceHint}>
                      Go to <strong>{deviceInfo.verificationUri}</strong>, enter the code, then sign in.
                    </p>
                    <div className={css.authBtns}>
                      <button className={css.outlineBtn} onClick={() => openBrowser(deviceInfo.verificationUri)}>
                        Open browser…
                      </button>
                      <button className={`${css.outlineBtn} ${css.outlineBtnDanger}`} onClick={handleDisconnect} style={{ marginLeft: 'auto' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

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

                {authPhase === 'done' && (
                  <div className={css.authBtns}>
                    <button className={css.outlineBtn} onClick={handleRefresh}>
                      <RefreshCw size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                      Refresh token
                    </button>
                    <button className={css.outlineBtn} onClick={handleConnect}>Reconnect</button>
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
          disabled={busy}
        >
          Save credentials
        </button>
      </div>
    </>
  );
}

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
  if (type === 'dropbox')  return 'PKCE redirect URI: http://localhost:7623/callback';
  if (type === 'onedrive') return 'Enable public client flows in Azure; use tenant id for single-tenant apps.';
  return 'Add http://localhost:7623/callback as an authorised redirect URI. Client secret stays on this machine.';
}
