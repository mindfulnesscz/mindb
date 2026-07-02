import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { DEFAULT_SETTINGS, type AppSettings } from '../store/settingsStore';

let _settingsPath: string | null = null;

async function getSettingsPath(): Promise<string> {
  if (_settingsPath) return _settingsPath;
  const dir = await appDataDir();
  _settingsPath = await join(dir, 'settings.json');
  return _settingsPath;
}

export async function loadSettings(): Promise<AppSettings> {
  const path = await getSettingsPath();
  let fileExists = false;
  try { fileExists = await exists(path); } catch { fileExists = false; }

  if (!fileExists) return { ...DEFAULT_SETTINGS };

  const text = await readTextFile(path);
  const raw  = JSON.parse(text) as Record<string, unknown>;

  /* Merge with defaults so new fields always appear */
  return { ...DEFAULT_SETTINGS, ...mapRawToSettings(raw) };
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const dir  = await appDataDir();
  const path = await getSettingsPath();
  await mkdir(dir, { recursive: true });
  await writeTextFile(path, JSON.stringify(s, null, 2));
}

/* Map snake_case Python settings → camelCase TypeScript */
function mapRawToSettings(raw: Record<string, unknown>): Partial<AppSettings> {
  const m: Partial<AppSettings> = {};
  const str  = (v: unknown) => typeof v === 'string' ? v : undefined;
  const bool = (v: unknown) => typeof v === 'boolean' ? v : undefined;

  if (str(raw.source_folder))        m.sourceFolder      = str(raw.source_folder)!;
  if (str(raw.target_folder))        m.targetFolder      = str(raw.target_folder)!;
  if (str(raw.onedrive_flat_folder)) m.onedriveFlatFolder = str(raw.onedrive_flat_folder)!;
  if (str(raw.vault_folder))         m.vaultFolder        = str(raw.vault_folder)!;
  if (bool(raw.do_thumbnails) !== undefined) m.doThumbnails   = raw.do_thumbnails as boolean;
  if (bool(raw.do_distribute) !== undefined) m.doDistribute   = raw.do_distribute as boolean;
  if (bool(raw.do_publish)    !== undefined) m.doPublish      = raw.do_publish as boolean;
  if (bool(raw.do_flat_export)!== undefined) m.doFlatExport   = raw.do_flat_export as boolean;
  if (bool(raw.do_obsidian)   !== undefined) m.doObsidian     = raw.do_obsidian as boolean;
  if (str(raw.package_prefix)) m.packagePrefix = str(raw.package_prefix)!;
  if (str(raw.out_folder))     m.outFolder      = str(raw.out_folder)!;
  if (str(raw.exclude_mark))   m.excludeMark    = str(raw.exclude_mark)!;
  if (str(raw.include_mark))   m.includeMark    = str(raw.include_mark)!;
  if (str(raw.filter_mode))    m.filterMode     = str(raw.filter_mode) as AppSettings['filterMode'];
  if (str(raw.thumb_width))    m.thumbWidth     = str(raw.thumb_width)!;
  if (str(raw.thumb_quality))  m.thumbQuality   = str(raw.thumb_quality)!;
  if (str(raw.dam_depth))      m.damDepth       = str(raw.dam_depth)!;
  /* Also support direct camelCase (our own saved format) */
  return { ...m, ...pickCamel(raw) };
}

function pickCamel(raw: Record<string, unknown>): Partial<AppSettings> {
  const out: Record<string, unknown> = {};
  const camels = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];
  for (const k of camels) {
    if (k in raw) out[k] = raw[k];
  }
  return out as Partial<AppSettings>;
}
