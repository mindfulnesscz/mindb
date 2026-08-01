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

/* Two tiers of delivery. Which one an object goes to is decided per asset from its effective
   level (see @dc-hub/domain `storageTarget`), so the pipeline holds credentials for both. */
export interface R2Config {
  endpoint:     string;
  accessKeyId:  string;
  secretKey:    string;
  sessionToken: string;
  bucket:       string;
  publicDomain: string;
  keyPrefix:    string;  // e.g. "{client_id}/" — legacy prefix helper, kept for branding uploads
  clientId:     string;  // object keys are built from this directly
  /** Gated bucket — no public access; the cdn-gate Worker is its only door. */
  gatedBucket:       string;
  gatedDomain:       string;
  gatedAccessKeyId:  string;
  gatedSecretKey:    string;
  gatedSessionToken: string;
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
  /** `${stable_id}:${child_id}` → effective access level, read from the DB before uploading.
   *  The level is part of the object key and picks the bucket, and `perm` is portal-owned, so
   *  the database is the only place that knows it. Absent key ⇒ a new asset. */
  assetLevels?:      Map<string, string>;
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
