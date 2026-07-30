/* Pipeline types — the run contract.
 *
 * Kept in its own module so damService and supabaseService can name a RunContext without
 * importing the orchestrator, which imports them back. That cycle was type-only and harmless,
 * but it is gone now.
 */

import type { AppSettings } from '../../store/settingsStore';
import type { LogType, RunStats } from '../../store/pipelineStore';
import type { VocabularyData } from '@dc-hub/domain';
import type { CloudDestination, DestExportLayout } from '../../domain/client';

export interface CloudUrlEntry {
  destId?:  string;  // CloudDestination.id — preferred match key in the portal
  provider: string;  // 'dropbox' | 'onedrive' | 'gdrive'
  name:     string;  // destination name (from CloudDestination.name)
  url:      string;  // sharing link
}

export interface R2Config {
  endpoint:     string;
  accessKeyId:  string;
  secretKey:    string;
  sessionToken: string;
  bucket:       string;
  publicDomain: string;
  keyPrefix:    string;  // e.g. "{client_id}/" — prepended to all object keys
}

export interface RunContext {
  settings:          AppSettings;
  vocab:             VocabularyData;
  appendLog:         (type: LogType, msg: string) => void;
  addIssue:          (i: { category: 'skipped'|'disconnected'|'version-conflict'|'error'; file: string; reason: string }) => void;
  setProgress:       (p: number) => void;
  finishRun:         (stats: RunStats, hasIssues: boolean) => void;
  processedPackages?: string[];
  collectedAssets?:  string[]; // populated once by runPipeline, stems used for Supabase sync
  r2?:               R2Config;                             // CDN upload config; omit to skip CDN step
  // absPath-keyed, NOT stem-keyed: display names repeat across packages, and a name key
  // lets one package's URL land on another's row (F-5). See cdnStemKey in supabaseService.
  cdnUrls?:          Map<string, string>;                  // absPath → public CDN URL of the thumbnail
  originalUrls?:     Map<string, string>;                  // absPath → public CDN URL of the original file
  cloudUrls?:        Map<string, CloudUrlEntry[]>;         // destId:stem (stem fallback) → cloud sharing URLs
  cloudDestinations?: CloudDestination[];                  // active cloud destinations to export to
  /** Local publish shape from the checked local destination. */
  localExportLayout?: DestExportLayout;
  localIncludePackages?: boolean;
  /** absPath → identity (per file), plus cdnStemKey(absPath) → identity (shared thumbnail). */
  cdnIdentity?:      Map<string, { stableId: string; childId: string }>;
  storageKeyPrefix?: string;  // mirrors r2.keyPrefix when CDN enabled
}


export interface VersionEntry {
  file:      string;
  stem:      string;
  version:   string;
  shortcode: string;
}

export interface AssetVersions {
  /** Display shortcode (version-stripped stem) — the map is keyed by identity, not by this. */
  shortcode: string;
  current: VersionEntry | null;
  history: VersionEntry[];
}


export type { RunStats };
