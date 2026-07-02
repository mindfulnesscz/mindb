import { useEffect, useRef } from 'react';
import { NavRail } from './app/NavRail';
import { PipelineView } from './features/pipeline/PipelineView';
import { VocabularyView } from './features/vocabulary/VocabularyView';
import { SettingsView } from './features/settings/SettingsView';
import { useAppStore } from './store/appStore';
import { useVocabularyStore } from './store/vocabularyStore';
import { useSettingsStore } from './store/settingsStore';
import { useClientStore } from './store/clientStore';
import { loadVocabulary, saveVocabulary } from './services/vocabService';
import { loadSettings, saveSettings } from './services/settingsService';
import { loadClients } from './services/clientService';
import './styles/tokens.css';
import './styles/global.css';
import css from './App.module.css';

export default function App() {
  const active = useAppStore(s => s.active);
  const { setData: setVocab }     = useVocabularyStore();
  const { setSettings, markClean, setField } = useSettingsStore();
  const { setClients, setActiveClientId, clients, activeClientId } = useClientStore();

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
