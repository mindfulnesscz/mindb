import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { NavRail } from './app/NavRail';
import { PipelineView } from './features/pipeline/PipelineView';
import { VocabularyView } from './features/vocabulary/VocabularyView';
import { SettingsView } from './features/settings/SettingsView';
import { LoginView } from './features/auth/LoginView';
import { useAppStore } from './store/appStore';
import { useVocabularyStore } from './store/vocabularyStore';
import { useSettingsStore } from './store/settingsStore';
import { useClientStore } from './store/clientStore';
import { useAuthStore } from './store/authStore';
import { loadVocabulary, saveVocabulary } from './services/vocabService';
import { loadSettings, saveSettings } from './services/settingsService';
import { loadClientsForEnvironment, saveLocalClient, pullCloudDestinations } from './services/clientService';
import { loadEnvironments } from './services/environmentService';
import { useEnvironmentStore } from './store/environmentStore';
import { switchAuthClient, getSession, loadProfile, DESKTOP_ROLES } from './services/authService';
import './styles/tokens.css';
import './styles/global.css';
import css from './App.module.css';

export default function App() {
  const active = useAppStore(s => s.active);
  const { setData: setVocab }     = useVocabularyStore();
  const { setSettings, markClean, setField } = useSettingsStore();
  const { setClients, setActiveClientId, updateClient, clients, activeClientId } = useClientStore();
  const { status: authStatus, setStatus: setAuthStatus, setServer, setProfile, profile } = useAuthStore();
  const { environments, activeEnvId, setEnvironments, setActiveEnvId } = useEnvironmentStore();

  /* Boot: load environments once. */
  const envsLoaded = useRef(false);
  const authRunId = useRef(0);
  useEffect(() => {
    loadEnvironments().then(envs => {
      setEnvironments(envs.list);
      setActiveEnvId(envs.activeId);
      envsLoaded.current = true;
      if (!envs.activeId) setAuthStatus('unconfigured');
    }).catch(() => setAuthStatus('unconfigured'));
  }, []);

  /* Localhost reveal bridge for the web portal ("Reveal in Finder"). */
  useEffect(() => {
    invoke('start_reveal_bridge').catch(console.error);
  }, []);

  /* Keep bridge clientId → sourceFolder map in sync with the active client. */
  useEffect(() => {
    const client = clients.find(c => c.id === activeClientId) ?? null;
    if (!client) return;
    invoke('set_reveal_client_root', {
      clientId: client.id,
      sourceFolder: client.sourceFolder ?? '',
    }).catch(console.error);
  }, [activeClientId, clients]);

  /* The gate: authenticate against the ACTIVE environment. Re-runs on
     environment switch; a cached session for that environment (supabase-js
     keys storage by project) signs straight in without a new magic link. */
  useEffect(() => {
    if (!envsLoaded.current || !activeEnvId) return;
    const env = useEnvironmentStore.getState().environments.find(e => e.id === activeEnvId) ?? null;
    if (!env || !env.supabaseUrl || !env.anonKey) { setAuthStatus('unconfigured'); return; }

    const runId = ++authRunId.current;
    (async () => {
      setAuthStatus('booting');
      setProfile(null);
      setServer({ url: env.supabaseUrl, anonKey: env.anonKey });
      useClientStore.getState().setClients([]);
      useClientStore.getState().setActiveClientId(null);
      try {
        await switchAuthClient({ url: env.supabaseUrl, anonKey: env.anonKey });
        if (authRunId.current !== runId) return;
        const session = await getSession();
        if (authRunId.current !== runId) return;
        if (!session) { setAuthStatus('signedOut'); return; }
        const profile = await loadProfile();
        if (authRunId.current !== runId) return;
        if (!DESKTOP_ROLES.includes(profile.role)) { setAuthStatus('denied'); return; }
        setProfile(profile);
        setAuthStatus('signedIn');
      } catch (e) {
        if (authRunId.current !== runId) return;
        console.error('Auth failed for environment:', e);
        setAuthStatus('signedOut');
      }
    })();
  }, [activeEnvId]);

  /* Boot: settings are auth-independent */
  useEffect(() => {
    loadSettings().then(s => { setSettings(s); markClean(); }).catch(console.error);
  }, []);

  /* Clients are DB-first: fetched per environment once signed in, filtered by
     membership (admins see all), merged with this machine's local config. */
  const activeEnv = environments.find(e => e.id === activeEnvId) ?? null;
  useEffect(() => {
    if (authStatus !== 'signedIn' || !profile || !activeEnv) return;
    useClientStore.getState().setLoadError(null);
    loadClientsForEnvironment(activeEnv, profile.role, environments)
      .then(({ clients, activeClientId }) => {
        setClients(clients);
        setActiveClientId(activeClientId);
      })
      .catch(e => {
        console.error(e);
        useClientStore.getState().setLoadError(String(e instanceof Error ? e.message : e));
      });
  }, [authStatus, activeEnvId, activeEnv?.supabaseUrl, activeEnv?.anonKey]);

  /* Track whether this is the first client load so we don't double-save on boot */
  const vocabClientRef = useRef<string | null | undefined>(undefined);

  /* Apply client brand colour + reload per-client vocabulary when active client changes */
  useEffect(() => {
    const client = clients.find(c => c.id === activeClientId) ?? null;
    if (client) {
      document.documentElement.style.setProperty('--client-accent', client.brandColor);
      setField('sourceFolder', client.sourceFolder);
      setField('targetFolder', client.targetFolder);
      setField('vaultFolder',  client.vaultFolder);
    } else {
      document.documentElement.style.removeProperty('--client-accent');
    }

    /* Reload vocabulary for this client (or the seed when no client selected) */
    if (vocabClientRef.current !== activeClientId) {
      const prevDirty = useVocabularyStore.getState().dirty;
      const prevId = vocabClientRef.current;
      // Flush dirty edits for the client we're leaving before switching.
      if (prevDirty && prevId && useVocabularyStore.getState().data) {
        saveVocabulary(useVocabularyStore.getState().data!, prevId).catch(console.error);
      }
      vocabClientRef.current = activeClientId;
      // Default: DB. Unpublished local cache (_unpublished) is kept by loadVocabulary.
      loadVocabulary(activeClientId)
        .then(d => setVocab(d, { dirty: !!d._unpublished }))
        .catch(console.error);
    }
  }, [activeClientId, clients]);

  /* Pull shared cloud destination definitions from Supabase once per client switch —
     guarded separately from the effect above so it doesn't re-fire on every local
     clients mutation (including the one this pull itself triggers). */
  const cloudSyncClientRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (cloudSyncClientRef.current === activeClientId) return;
    cloudSyncClientRef.current = activeClientId;
    const client = useClientStore.getState().clients.find(c => c.id === activeClientId) ?? null;
    if (!client) return;
    pullCloudDestinations(client).then(merged => {
      if (!merged || JSON.stringify(merged) === JSON.stringify(client.cloudDestinations)) return;
      updateClient(client.id, { cloudDestinations: merged });
      const updated = useClientStore.getState().clients.find(c => c.id === client.id);
      if (updated && activeEnvId) return saveLocalClient(activeEnvId, updated);
    }).catch(console.error);
  }, [activeClientId]);

  /* Persist vocabulary on change — only when dirty (user edits), never overwrite
     the cache with the empty seed / a mid-load stale store while switching clients. */
  const vocabData = useVocabularyStore(s => s.data);
  const vocabDirty = useVocabularyStore(s => s.dirty);
  useEffect(() => {
    if (vocabDirty && vocabData && vocabClientRef.current) {
      saveVocabulary({ ...vocabData, _unpublished: true }, vocabClientRef.current).catch(console.error);
    }
  }, [vocabData, vocabDirty]);

  /* Persist settings when dirty */
  const settings = useSettingsStore(s => s.settings);
  const dirty    = useSettingsStore(s => s.dirty);
  useEffect(() => {
    if (dirty) saveSettings(settings).then(markClean).catch(console.error);
  }, [settings, dirty]);

  /* The gate: nothing operational renders without a staff session. A visible
     splash while booting — never a blank window; getSession is also
     timeout-guarded in authService so this state always resolves. */
  if (authStatus === 'booting') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--paper-cream)', color: 'var(--gray-500)',
        fontFamily: '"Commissioner", sans-serif', fontSize: '0.9rem',
      }}>
        Connecting…
      </div>
    );
  }
  if (authStatus !== 'signedIn') return <LoginView />;

  return (
    <div className={css.shell}>
      <NavRail />
      <main className={css.main}>
        {active === 'pipeline'   && <PipelineView />}
        {active === 'vocabulary' && <VocabularyView />}
        {active === 'settings'   && <SettingsView />}
      </main>
    </div>
  );
}
