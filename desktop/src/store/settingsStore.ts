import { create } from 'zustand';

export interface AppSettings {
  /* Paths */
  sourceFolder:      string;
  targetFolder:      string;
  vaultFolder:       string;

  /* Tasks */
  doThumbnails:   boolean;
  doDistribute:   boolean;
  doPublish:      boolean;
  doFlatExport:   boolean;
  doObsidian:     boolean;
  doCdnOriginals: boolean;

  /* Run options */
  dryRun: boolean;
  /** Opt out of the blast-radius tripwire for one run — see services/guardrail.ts. */
  allowLargeDeletions: boolean;

  /* Folder patterns */
  packagePrefix: string;
  outFolder:     string;
  excludeMark:   string;

  /* Thumbnails & DAM */
  thumbWidth:   string;
  thumbQuality: string;
  damDepth:     string;

}

export const DEFAULT_SETTINGS: AppSettings = {
  sourceFolder:      '',
  targetFolder:      '',
  vaultFolder:       '',

  doThumbnails:   false,
  doDistribute:   true,
  doPublish:      true,
  doFlatExport:   false,
  doObsidian:     false,
  doCdnOriginals: true,

  dryRun:             false,
  allowLargeDeletions: false,

  packagePrefix: '[00] 📦',
  outFolder:     '[03] OUT',
  excludeMark:   '⦰',

  thumbWidth:   '640',
  thumbQuality: '70',
  damDepth:     '1',

};

interface SettingsStore {
  settings: AppSettings;
  dirty: boolean;
  setField: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  setSettings: (s: AppSettings) => void;
  markClean: () => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  dirty: false,
  setField: (key, value) =>
    set(state => ({
      settings: { ...state.settings, [key]: value },
      dirty: true,
    })),
  setSettings: (s) => set({ settings: s, dirty: true }),
  markClean: () => set({ dirty: false }),
}));
