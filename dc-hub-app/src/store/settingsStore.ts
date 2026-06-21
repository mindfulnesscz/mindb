import { create } from 'zustand';
import type { FilterMode } from '../domain/naming';

export interface AppSettings {
  /* Paths */
  sourceFolder:      string;
  targetFolder:      string;
  onedriveFlatFolder: string;
  vaultFolder:       string;

  /* Tasks */
  doThumbnails:   boolean;
  doDistribute:   boolean;
  doPublish:      boolean;
  doFlatExport:   boolean;
  doObsidian:     boolean;

  /* Run options */
  dryRun:            boolean;
  keepHighestVersion: boolean;
  preserveStructure:  boolean;

  /* Folder patterns */
  packagePrefix: string;
  outFolder:     string;
  excludeMark:   string;
  includeMark:   string;
  filterMode:    FilterMode;

  /* Thumbnails & DAM */
  thumbWidth:   string;
  thumbQuality: string;
  damDepth:     string;

  /* Cloud credentials */
  dropboxAppKey:      string;
  dropboxToken:       string;
  dropboxRefreshToken: string;
  onedriveClientId:   string;
  onedriveTenantId:   string;
  onedriveToken:      string;
  onedriveRefreshToken: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sourceFolder:      '',
  targetFolder:      '',
  onedriveFlatFolder: '',
  vaultFolder:       '',

  doThumbnails:   false,
  doDistribute:   true,
  doPublish:      false,
  doFlatExport:   false,
  doObsidian:     false,

  dryRun:            false,
  keepHighestVersion: false,
  preserveStructure:  false,

  packagePrefix: '[00] 📦',
  outFolder:     '[03] OUT',
  excludeMark:   '⦰',
  includeMark:   '🏁',
  filterMode:    'blacklist',

  thumbWidth:   '640',
  thumbQuality: '70',
  damDepth:     '1',

  dropboxAppKey:      '',
  dropboxToken:       '',
  dropboxRefreshToken: '',
  onedriveClientId:   '',
  onedriveTenantId:   'common',
  onedriveToken:      '',
  onedriveRefreshToken: '',
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
