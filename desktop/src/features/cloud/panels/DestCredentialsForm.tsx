/* The credentials form for one destination.
 *
 * Everything from the portal is shown disabled; what this machine owns — the local folder, the app
 * credentials, the OAuth token — is editable. The connect/refresh/disconnect state machine lives in
 * ../useDestAuth.ts, and the flow it drives in ../connectDest.ts.
 */

import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as openBrowser } from '@tauri-apps/plugin-shell';
import { ChevronLeft, Copy, Check, RefreshCw } from 'lucide-react';
import { resolveSharePointDrive } from '../../../services/cloudService';
import {
  tokenStatus, cloudToken,
  type CloudDestination, type DestConfig,
  type LocalDestConfig, type DropboxDestConfig, type OneDriveDestConfig, type GDriveDestConfig,
} from '../../../domain/client';
import { typeLabel, statusClass, credHint, layoutLabel } from '../destLabels';
import { useDestAuth } from '../useDestAuth';
import { GDriveDedupeCard } from './GDriveDedupeCard';
import css from '../CloudDestinations.module.css';

export function DestCredentialsForm({
  dest, onSave, onBack,
}: {
  dest:   CloudDestination;
  onSave: (d: CloudDestination) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<CloudDestination>(dest);
  const [driveResolving, setDriveResolving] = useState(false);
  const [driveMsg, setDriveMsg] = useState('');

  const cfg = form.config;
  const {
    authPhase, deviceInfo, authError, copied, busy,
    connect: handleConnect, refresh: handleRefresh, disconnect: handleDisconnect, copyCode,
  } = useDestAuth(
    cfg,
    token => setForm(f => ({ ...f, config: { ...f.config, token } as DestConfig })),
    !!cloudToken(dest.config),
  );

  function patchConfig(changes: Partial<DestConfig>) {
    setForm(f => ({ ...f, config: { ...f.config, ...changes } as DestConfig }));
  }

  async function pickFolder() {
    // recursive: grant the whole subtree, not just one level. See pipeline/FolderPicker for why.
    const selected = await openDialog({ directory: true, multiple: false, recursive: true });
    if (selected) patchConfig({ path: selected as string } as Partial<LocalDestConfig>);
  }

  const isCloud = cfg.type !== 'local';
  const existingToken = isCloud ? (cfg as DropboxDestConfig | OneDriveDestConfig | GDriveDestConfig).token : null;
  const tStatus = existingToken ? tokenStatus(existingToken) : 'none';
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
                value={`${typeLabel(cfg.type)} · ${form.role} · ${path || '—'} · ${layoutLabel(form)}`}
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
                {cfg.type === 'onedrive' && (
                  <div className={css.field}>
                    <span className={css.fieldLabel}>SharePoint site URL (shared delivery)</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className={`${css.input} ${css.inputMono}`}
                        style={{ flex: 1 }}
                        value={(cfg as OneDriveDestConfig).siteUrl ?? ''}
                        onChange={e => patchConfig({ siteUrl: e.target.value } as Partial<OneDriveDestConfig>)}
                        placeholder="https://contoso.sharepoint.com/sites/Clients"
                      />
                      <button
                        type="button"
                        className={css.btnSave}
                        disabled={driveResolving || !existingToken || !((cfg as OneDriveDestConfig).siteUrl ?? '').trim()}
                        onClick={async () => {
                          setDriveResolving(true); setDriveMsg('');
                          try {
                            const { driveId, driveName } = await resolveSharePointDrive(
                              existingToken!.accessToken,
                              (cfg as OneDriveDestConfig).siteUrl ?? '',
                            );
                            patchConfig({ driveId } as Partial<OneDriveDestConfig>);
                            setDriveMsg(`Resolved: ${driveName}`);
                          } catch (e) {
                            setDriveMsg(e instanceof Error ? e.message : String(e));
                          } finally {
                            setDriveResolving(false);
                          }
                        }}
                      >
                        {driveResolving ? 'Resolving…' : 'Resolve drive'}
                      </button>
                    </div>
                    <span className={css.fieldHint}>
                      {(cfg as OneDriveDestConfig).driveId
                        ? `Drive ID: ${(cfg as OneDriveDestConfig).driveId}`
                        : 'Leave blank to upload to the signed-in user’s personal OneDrive. Connect first, then resolve.'}
                      {driveMsg && ` — ${driveMsg}`}
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

            {cfg.type === 'gdrive' && (
              <GDriveDedupeCard cfg={cfg as GDriveDestConfig} destName={form.name || 'this destination'} />
            )}
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
