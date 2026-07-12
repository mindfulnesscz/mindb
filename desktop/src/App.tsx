import { useEffect, useRef } from 'react';
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
import { initAuthClient, getSession, loadProfile, DESKTOP_ROLES } from './services/authService';
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
  useEffect(() => {
    loadEnvironments().then(envs => {
      setEnvironments(envs.list);
      setActiveEnvId(envs.activeId);
      envsLoaded.current = true;
      if (!envs.activeId) setAuthStatus('unconfigured');
    }).catch(() => setAuthStatus('unconfigured'));
  }, []);

  /* The gate: authenticate against the ACTIVE environment. Re-runs on
     environment switch; a cached session for that environment (supabase-js
     keys storage by project) signs straight in without a new magic link. */
  useEffect(() => {
    if (!envsLoaded.current || !activeEnvId) return;
    const env = environments.find(e => e.id === activeEnvId) ?? null;
    if (!env || !env.supabaseUrl || !env.anonKey) { setAuthStatus('unconfigured'); return; }
    (async () => {
      setServer({ url: env.supabaseUrl, anonKey: env.anonKey });
      initAuthClient({ url: env.supabaseUrl, anonKey: env.anonKey });
      try {
        const session = await getSession();
        if (!session) { setAuthStatus('signedOut'); return; }
        const profile = await loadProfile();
        if (!DESKTOP_ROLES.includes(profile.role)) { setAuthStatus('denied'); return; }
        setProfile(profile);
        setAuthStatus('signedIn');
      } catch {
        setAuthStatus('signedOut');
      }
    })().catch(() => setAuthStatus('signedOut'));
  }, [activeEnvId, environments]);

  /* Boot: settings are auth-independent */
  useEffect(() => {
    loadSettings().then(s => { setSettings(s); markClean(); }).catch(console.error);
  }, []);

  /* Clients are DB-first: fetched per environment once signed in, filtered by
     membership (admins see all), merged with this machine's local config.
     The env's connection values are part of the deps: editing them in
     Settings must re-merge, or the pipeline would run on stale values. */
  const activeEnv = environments.find(e => e.id === activeEnvId) ?? null;
  useEffect(() => {
    if (authStatus !== 'signedIn' || !profile || !activeEnv) return;
    loadClientsForEnvironment(activeEnv, profile.role, environments)
      .then(({ clients, activeClientId }) => {
        setClients(clients);
        setActiveClientId(activeClientId);
      })
      .catch(console.error);
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
      vocabClientRef.current = activeClientId;
      loadVocabulary(activeClientId).then(setVocab).catch(console.error);
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

  /* Persist vocabulary on change — scoped to the currently active client.
     Using the ref instead of the activeClientId closure avoids stale-capture
     when the client changes while a vocab load is in flight. */
  const vocabData = useVocabularyStore(s => s.data);
  useEffect(() => {
    if (vocabData && vocabClientRef.current !== undefined) {
      saveVocabulary(vocabData, vocabClientRef.current).catch(console.error);
    }
  }, [vocabData]);

  /* Persist settings when dirty */
  const settings = useSettingsStore(s => s.settings);
  const dirty    = useSettingsStore(s => s.dirty);
  useEffect(() => {
    if (dirty) saveSettings(settings).then(markClean).catch(console.error);
  }, [settings, dirty]);

  /* The gate: nothing operational renders without a staff session. */
  if (authStatus === 'booting') return null;
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
