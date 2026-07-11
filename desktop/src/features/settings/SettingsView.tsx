import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { useClientStore } from '../../store/clientStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import { useAuthStore } from '../../store/authStore';
import { saveEnvironments, makeEnvironment } from '../../services/environmentService';
import { checkSupabaseConnection } from '../../services/supabaseService';
import { CloudDestinations } from '../cloud/CloudDestinations';
import css from './SettingsView.module.css';

export function SettingsView() {
  const { settings, setField, markClean } = useSettingsStore();
  const [savedMsg, setSavedMsg] = useState('');

  function handleSave() {
    markClean();
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 2000);
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>Settings</span>
        <div className={css.headerActions}>
          {savedMsg && <span className={css.savedMsg}>{savedMsg}</span>}
          <button className={css.btnSave} onClick={handleSave}>Save</button>
        </div>
      </div>

      <div className={css.scroll}>
        <div className={css.grid}>
          {/* Folder patterns */}
          <div className={css.card}>
            <div className={css.cardTitle}>Folder patterns</div>
            <div className={css.fields}>
              <div className={css.field}>
                <span className={css.fieldLabel}>Filter mode</span>
                <div className={css.segmentedControl}>
                  {(['blacklist', 'whitelist'] as const).map(mode => (
                    <button
                      key={mode}
                      className={`${css.segment}${settings.filterMode === mode ? ` ${css.active}` : ''}`}
                      onClick={() => setField('filterMode', mode)}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <Field
                label="Package folder prefix"
                value={settings.packagePrefix}
                onChange={v => setField('packagePrefix', v)}
                mono
              />
              <Field
                label="Output folder name"
                value={settings.outFolder}
                onChange={v => setField('outFolder', v)}
                mono
              />
              <Field
                label="Exclude mark (blacklist)"
                value={settings.excludeMark}
                onChange={v => setField('excludeMark', v)}
                mono
              />
              <Field
                label="Include mark (whitelist)"
                value={settings.includeMark}
                onChange={v => setField('includeMark', v)}
                mono
              />
            </div>
          </div>

          {/* Thumbnails & DAM */}
          <div className={css.card}>
            <div className={css.cardTitle}>Thumbnails & DAM</div>
            <div className={css.fields}>
              <Field
                label="Thumbnail width (px)"
                value={settings.thumbWidth}
                onChange={v => setField('thumbWidth', v)}
                type="number"
                hint="Width of generated WebP thumbnails"
              />
              <Field
                label="Thumbnail quality (0–100)"
                value={settings.thumbQuality}
                onChange={v => setField('thumbQuality', v)}
                type="number"
                hint="WebP quality. 70 is a good default."
              />
              <Field
                label="DAM folder depth"
                value={settings.damDepth}
                onChange={v => setField('damDepth', v)}
                type="number"
                hint="0 = flat vault. 1 = one folder level per scope."
              />
            </div>
          </div>

          {/* Cloud destinations — full width */}
          <div className={css.card} style={{ gridColumn: '1 / -1' }}>
            <CloudDestinations />
          </div>

          {/* Environment — connection shared by every client on this backend */}
          <div className={css.card} style={{ gridColumn: '1 / -1' }}>
            <EnvironmentSettings />
          </div>

          {/* CDN — Cloudflare R2 per active client */}
          <div className={css.card} style={{ gridColumn: '1 / -1' }}>
            <R2ClientSettings />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Environment settings — the connection every client on this backend shares ── */

type CheckStatus = 'idle' | 'checking' | 'ok' | 'error';

function EnvironmentSettings() {
  const { environments, activeEnvId, setEnvironments, setActiveEnvId } = useEnvironmentStore();
  const activeEnv = environments.find(e => e.id === activeEnvId) ?? null;

  async function activate(envId: string) {
    if (envId === activeEnvId) return;
    setActiveEnvId(envId);
    await saveEnvironments({ activeId: envId, list: environments }).catch(console.error);
    // App.tsx re-authenticates against the new environment; with no cached
    // session for it, the login gate appears — that's expected.
    useAuthStore.getState().setStatus('booting');
  }

  async function addEnvironment() {
    const env = makeEnvironment({ name: 'New environment' });
    const list = [...environments, env];
    setEnvironments(list);
    await saveEnvironments({ activeId: activeEnvId, list }).catch(console.error);
  }

  async function removeEnvironment(envId: string) {
    if (envId === activeEnvId) return; // the active one can't be removed
    const env = environments.find(e => e.id === envId);
    if (!confirm(`Remove environment "${env?.name || env?.supabaseUrl}"? Its machine-local client config stays on disk.`)) return;
    const list = environments.filter(e => e.id !== envId);
    setEnvironments(list);
    await saveEnvironments({ activeId: activeEnvId, list }).catch(console.error);
  }

  const [name,       setName]       = useState(activeEnv?.name        ?? '');
  const [url,        setUrl]        = useState(activeEnv?.supabaseUrl ?? '');
  const [serviceKey, setServiceKey] = useState(activeEnv?.serviceKey  ?? '');
  const [anonKey,    setAnonKey]    = useState(activeEnv?.anonKey     ?? '');
  const [status,     setStatus]     = useState<CheckStatus>('idle');
  const [msg,        setMsg]        = useState('');

  useEffect(() => {
    setName      (activeEnv?.name        ?? '');
    setUrl       (activeEnv?.supabaseUrl ?? '');
    setServiceKey(activeEnv?.serviceKey  ?? '');
    setAnonKey   (activeEnv?.anonKey     ?? '');
    setStatus('idle');
    setMsg('');
  }, [activeEnv?.id]);

  async function handleBlur() {
    if (!activeEnv) return;
    const updated = environments.map(e => e.id === activeEnv.id
      ? { ...e, name: name.trim(), supabaseUrl: url.trim().replace(/\/+$/, ''), serviceKey: serviceKey.trim(), anonKey: anonKey.trim() }
      : e);
    setEnvironments(updated);
    await saveEnvironments({ activeId: activeEnvId, list: updated }).catch(console.error);
  }

  async function checkConnection() {
    if (!url || !serviceKey) return;
    setStatus('checking');
    setMsg('');
    const result = await checkSupabaseConnection(url, serviceKey);
    setMsg(result.message);
    setStatus(result.ok ? 'ok' : 'error');
  }

  const dotColor = status === 'ok'       ? '#4ade80'
                 : status === 'error'    ? 'var(--signal-error)'
                 : status === 'checking' ? '#facc15'
                 : 'var(--gray-300)';

  return (
    <>
      <div className={css.cardTitle}>Environments</div>

      {environments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {environments.map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
                <input
                  type="radio"
                  name="active-environment"
                  checked={e.id === activeEnvId}
                  onChange={() => activate(e.id)}
                />
                <strong>{e.name || 'Unnamed'}</strong>
                <span style={{ color: 'var(--gray-500)', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                  {e.supabaseUrl || 'no URL'}
                </span>
              </label>
              {e.id !== activeEnvId && (
                <button className={css.btnSave} style={{ padding: '4px 10px' }} onClick={() => removeEnvironment(e.id)}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <div>
            <button className={css.btnSave} style={{ padding: '6px 12px' }} onClick={addEnvironment}>
              + Add environment
            </button>
          </div>
        </div>
      )}

      {!activeEnv ? (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-subtle)', margin: 0 }}>
          No environment configured — sign out and use “Configure server” on the login screen.
        </p>
      ) : (
        <div className={css.fields}>
          <div className={css.field}>
            <span className={css.fieldLabel}>Environment name</span>
            <input
              className={css.input}
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={handleBlur}
              placeholder="Production / Staging / Local"
            />
            <span className={css.fieldHint}>
              Shared by every client on this backend. Changing the URL or anon key takes effect after a sign-out.
            </span>
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Project URL</span>
            <input
              className={`${css.input} ${css.inputMono}`}
              value={url}
              onChange={e => setUrl(e.target.value)}
              onBlur={handleBlur}
              placeholder="https://xxxxxxxxxxxx.supabase.co"
            />
            <span className={css.fieldHint}>
              Found in Supabase → Project Settings → API → Project URL.
            </span>
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Secret key (service role)</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className={`${css.input} ${css.inputMono}`}
                type="password"
                value={serviceKey}
                onChange={e => setServiceKey(e.target.value)}
                onBlur={handleBlur}
                placeholder="eyJhbGci…"
                style={{ flex: 1 }}
              />
              <button
                className={css.btnSave}
                onClick={checkConnection}
                disabled={!url || !serviceKey || status === 'checking'}
                style={{ flexShrink: 0, padding: '7px 12px' }}
              >
                {status === 'checking' ? 'Checking…' : 'Check'}
              </button>
              <span
                style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
                title={msg || (status === 'idle' ? 'Not checked yet' : '')}
              />
            </div>
            {msg && (
              <span
                className={css.fieldHint}
                style={{ color: status === 'ok' ? '#22c55e' : status === 'error' ? 'var(--signal-error)' : undefined }}
              >
                {msg}
              </span>
            )}
            <span className={css.fieldHint}>
              Used by the pipeline to write assets (bypasses RLS). Keep private — never share this key.
            </span>
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Public API key (anon)</span>
            <input
              className={`${css.input} ${css.inputMono}`}
              type="password"
              value={anonKey}
              onChange={e => setAnonKey(e.target.value)}
              onBlur={handleBlur}
              placeholder="eyJhbGci…"
            />
            <span className={css.fieldHint}>
              Used by the web portal for client-facing access. Safe to embed in the frontend — this is the anon/public key, not the secret one.
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/* ── R2 CDN per-client settings ──────────────────────────────────────────── */

function R2ClientSettings() {
  const store        = useClientStore();
  const activeClient = store.clients.find(c => c.id === store.activeClientId) ?? null;

  const [endpoint,     setEndpoint]     = useState(activeClient?.r2Endpoint     ?? '');
  const [accessKeyId,  setAccessKeyId]  = useState(activeClient?.r2AccessKeyId  ?? '');
  const [secretKey,    setSecretKey]    = useState(activeClient?.r2SecretKey    ?? '');
  const [bucket,       setBucket]       = useState(activeClient?.r2Bucket       ?? '');
  const [publicDomain, setPublicDomain] = useState(activeClient?.r2PublicDomain ?? '');
  const [status,       setStatus]       = useState<CheckStatus>('idle');
  const [msg,          setMsg]          = useState('');

  useEffect(() => {
    setEndpoint    (activeClient?.r2Endpoint     ?? '');
    setAccessKeyId (activeClient?.r2AccessKeyId  ?? '');
    setSecretKey   (activeClient?.r2SecretKey    ?? '');
    setBucket      (activeClient?.r2Bucket       ?? '');
    setPublicDomain(activeClient?.r2PublicDomain ?? '');
    setStatus('idle');
    setMsg('');
  }, [activeClient?.id]);

  async function persist(patch: Partial<typeof activeClient>) {
    if (!activeClient) return;
    store.updateClient(activeClient.id, patch as Parameters<typeof store.updateClient>[1]);
    const envId = useEnvironmentStore.getState().activeEnvId;
    const updated = useClientStore.getState().clients.find(c => c.id === activeClient.id);
    if (envId && updated) {
      const { saveLocalClient } = await import('../../services/clientService');
      await saveLocalClient(envId, updated).catch(console.error);
    }
  }

  async function checkConnection() {
    if (!endpoint || !accessKeyId || !secretKey || !bucket) return;
    setStatus('checking');
    setMsg('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke<string>('check_r2_connection', {
        endpoint:     endpoint.trim(),
        bucket:       bucket.trim(),
        accessKeyId:  accessKeyId.trim(),
        secretKey:    secretKey.trim(),
      });
      setMsg('Connected');
      setStatus('ok');
    } catch (e) {
      setMsg(String(e));
      setStatus('error');
    }
  }

  const dotColor = status === 'ok'       ? '#4ade80'
                 : status === 'error'    ? 'var(--signal-error)'
                 : status === 'checking' ? '#facc15'
                 : 'var(--gray-300)';

  const canCheck = !!(endpoint && accessKeyId && secretKey && bucket);

  return (
    <>
      <div className={css.cardTitle}>CDN — Cloudflare R2</div>
      {!activeClient ? (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-subtle)', margin: 0 }}>
          Select a client to configure CDN.
        </p>
      ) : (
        <div className={css.fields}>
          <div className={css.field}>
            <span className={css.fieldLabel}>R2 Endpoint — {activeClient.name}</span>
            <input
              className={`${css.input} ${css.inputMono}`}
              value={endpoint}
              onChange={e => setEndpoint(e.target.value)}
              onBlur={() => persist({ r2Endpoint: endpoint.trim() })}
              placeholder="https://abc123.r2.cloudflarestorage.com"
            />
            <span className={css.fieldHint}>
              Jurisdiction-specific S3 endpoint from Cloudflare R2 → Manage R2 API tokens.
            </span>
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Bucket name</span>
            <input
              className={`${css.input} ${css.inputMono}`}
              value={bucket}
              onChange={e => setBucket(e.target.value)}
              onBlur={() => persist({ r2Bucket: bucket.trim() })}
              placeholder="dc-hub-ess"
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Public domain</span>
            <input
              className={`${css.input} ${css.inputMono}`}
              value={publicDomain}
              onChange={e => setPublicDomain(e.target.value)}
              onBlur={() => persist({ r2PublicDomain: publicDomain.trim() })}
              placeholder="https://cdn.disruptcollective.com"
            />
            <span className={css.fieldHint}>
              Custom domain mapped to this bucket (no trailing slash). Thumbnails are served from here.
            </span>
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Access Key ID</span>
            <input
              className={`${css.input} ${css.inputMono}`}
              value={accessKeyId}
              onChange={e => setAccessKeyId(e.target.value)}
              onBlur={() => persist({ r2AccessKeyId: accessKeyId.trim() })}
              placeholder="8a28b84f…"
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>Secret Access Key</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className={`${css.input} ${css.inputMono}`}
                type="password"
                value={secretKey}
                onChange={e => setSecretKey(e.target.value)}
                onBlur={() => persist({ r2SecretKey: secretKey.trim() })}
                placeholder="••••••••••••••••"
                style={{ flex: 1 }}
              />
              <button
                className={css.btnSave}
                onClick={checkConnection}
                disabled={!canCheck || status === 'checking'}
                style={{ flexShrink: 0, padding: '7px 12px' }}
              >
                {status === 'checking' ? 'Checking…' : 'Check'}
              </button>
              <span
                style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
                title={msg || (status === 'idle' ? 'Not checked yet' : '')}
              />
            </div>
            {msg && (
              <span
                className={css.fieldHint}
                style={{ color: status === 'ok' ? '#22c55e' : status === 'error' ? 'var(--signal-error)' : undefined }}
              >
                {msg}
              </span>
            )}
            <span className={css.fieldHint}>
              The Cloudflare API token (<code>cfat_…</code>) is not needed — only the S3 Access Key ID and Secret.
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/* ── Generic labelled input ──────────────────────────────────────────────── */

function Field({
  label, value, onChange, type = 'text', hint, mono, password,
}: {
  label:    string;
  value:    string;
  onChange: (v: string) => void;
  type?:    string;
  hint?:    string;
  mono?:    boolean;
  password?: boolean;
}) {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <input
        className={`${css.input}${mono ? ` ${css.inputMono}` : ''}${password ? ` ${css.inputPassword}` : ''}`}
        type={password ? 'password' : type}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {hint && <span className={css.fieldHint}>{hint}</span>}
    </div>
  );
}
