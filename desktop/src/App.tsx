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
import { loadClients, saveClients, pullCloudDestinations } from './services/clientService';
import {
  loadAuthServer, initAuthClient, getSession, loadProfile, DESKTOP_ROLES,
} from './services/authService';
import './styles/tokens.css';
import './styles/global.css';
import css from './App.module.css';

export default function App() {
  const active = useAppStore(s => s.active);
  const { setData: setVocab }     = useVocabularyStore();
  const { setSettings, markClean, setField } = useSettingsStore();
  const { setClients, setActiveClientId, updateClient, clients, activeClientId } = useClientStore();
  const { status: authStatus, setStatus: setAuthStatus, setServer, setProfile } = useAuthStore();

  /* Boot: resolve auth first — the gate. A cached session (auto-refreshed by
     supabase-js) signs straight in; anything else lands on the login screen. */
  useEffect(() => {
    (async () => {
      const server = await loadAuthServer();
      if (!server) { setAuthStatus('unconfigured'); return; }
      setServer(server);
      initAuthClient(server);
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
  }, []);

  /* Boot: load settings and clients (vocab loads below once clientId is known) */
  useEffect(() => {
    loadSettings().then(s => { setSettings(s); markClean(); }).catch(console.error);
    loadClients().then(({ clients, activeClientId }) => {
      setClients(clients);
      setActiveClientId(activeClientId);
    }).catch(console.error);
  }, []);

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
      return saveClients({ clients: useClientStore.getState().clients, activeClientId: client.id });
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
