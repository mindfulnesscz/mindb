import { useEffect } from 'react';
import { NavRail } from './app/NavRail';
import { PipelineView } from './features/pipeline/PipelineView';
import { VocabularyView } from './features/vocabulary/VocabularyView';
import { GeneratorView } from './features/generator/GeneratorView';
import { SettingsView } from './features/settings/SettingsView';
import { useAppStore } from './store/appStore';
import { useVocabularyStore } from './store/vocabularyStore';
import { useSettingsStore } from './store/settingsStore';
import { loadVocabulary, saveVocabulary } from './services/vocabService';
import { loadSettings, saveSettings } from './services/settingsService';
import './styles/tokens.css';
import './styles/global.css';
import css from './App.module.css';

export default function App() {
  const active = useAppStore(s => s.active);
  const { setData: setVocab } = useVocabularyStore();
  const { setSettings, markClean } = useSettingsStore();

  /* Load vocabulary and settings on mount */
  useEffect(() => {
    loadVocabulary().then(setVocab).catch(console.error);
    loadSettings().then(s => { setSettings(s); markClean(); }).catch(console.error);
  }, []);

  /* Persist vocabulary whenever it changes */
  const vocabData = useVocabularyStore(s => s.data);
  useEffect(() => {
    if (vocabData) saveVocabulary(vocabData).catch(console.error);
  }, [vocabData]);

  /* Persist settings whenever dirty */
  const settings = useSettingsStore(s => s.settings);
  const dirty    = useSettingsStore(s => s.dirty);
  useEffect(() => {
    if (dirty) {
      saveSettings(settings).then(markClean).catch(console.error);
    }
  }, [settings, dirty]);

  return (
    <div className={css.shell}>
      <NavRail />
      <main className={css.main}>
        {active === 'pipeline'   && <PipelineView />}
        {active === 'vocabulary' && <VocabularyView />}
        {active === 'generator'  && <GeneratorView />}
        {active === 'settings'   && <SettingsView />}
      </main>
    </div>
  );
}
