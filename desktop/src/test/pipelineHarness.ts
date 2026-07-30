/* Shared fixtures for the pipeline characterization tests.
 *
 * These tests drive the real `runPipeline` against the virtual filesystem in ./vfs, so
 * they characterize the orchestration as it actually runs — not a reimplementation of it.
 * That is the point: Phase 2 will move this code into stage modules, and these tests must
 * keep passing across that move without being rewritten.
 */

import type { AppSettings } from '../store/settingsStore';
import type { LogType, RunStats } from '../store/pipelineStore';
import { type VocabularyData, type VocabTag } from '@dc-hub/domain';

export const SRC = '/src';
export const DST = '/dst';

/** Settings with every stage OFF — each test enables only the stage it characterizes. */
export function makeSettings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    sourceFolder: SRC,
    targetFolder: DST,
    onedriveFlatFolder: '',
    vaultFolder: '',

    doThumbnails: false,
    doDistribute: false,
    doPublish: false,
    doFlatExport: false,
    doObsidian: false,
    doCdnOriginals: false,

    dryRun: false,
    keepHighestVersion: true,
    preserveStructure: false,

    packagePrefix: '[00] 📦',
    outFolder: '[03] OUT',
    excludeMark: '⦰',

    thumbWidth: '640',
    thumbQuality: '70',
    damDepth: '1',
    ...over,
  };
}

const tag = (shortcode: string, slot: VocabTag['slot'], label: string): VocabTag =>
  ({ shortcode, slot, parentGroup: null, label, key: label.toLowerCase(), icon: '' });

/** A minimal three-dimension vocabulary, enough to exercise name translation. */
export const VOCAB: VocabularyData = {
  _schema_version: '4.0.0',
  _comment: 'test fixture',
  tags: [
    tag('PRD', 'entity', 'Product'),
    tag('ACQ', 'entity', 'Acquisition'),
    tag('OVR', 'angle', 'Overview'),
    tag('SlD', 'format', 'Slides'),
    tag('Gll', 'format', 'Gallery'),
  ],
};

export interface CapturedRun {
  ctx: Record<string, unknown>;
  logs: Array<{ type: LogType; msg: string }>;
  issues: Array<{ category: string; file: string; reason: string }>;
  stats: RunStats | null;
  /** Log messages of a given type, for asserting on user-visible reporting. */
  logsOfType(type: LogType): string[];
  /** True when any log line contains `needle`. */
  logged(needle: string): boolean;
}

/**
 * Build a RunContext plus the captors for everything it reports. Typed loosely on purpose:
 * the harness must not need updating every time RunContext grows an optional field.
 */
export function makeCtx(settings: AppSettings, over: Record<string, unknown> = {}): CapturedRun {
  const logs: CapturedRun['logs'] = [];
  const issues: CapturedRun['issues'] = [];
  const captured: CapturedRun = {
    ctx: {},
    logs,
    issues,
    stats: null,
    logsOfType: (type: LogType) => logs.filter(l => l.type === type).map(l => l.msg),
    logged: (needle: string) => logs.some(l => l.msg.includes(needle)),
  };

  captured.ctx = {
    settings,
    vocab: VOCAB,
    appendLog: (type: LogType, msg: string) => { logs.push({ type, msg }); },
    addIssue: (i: { category: string; file: string; reason: string }) => { issues.push(i); },
    setProgress: () => {},
    finishRun: (stats: RunStats) => { captured.stats = stats; },
    processedPackages: [] as string[],
    collectedAssets: [] as string[],
    cdnUrls: new Map<string, string>(),
    originalUrls: new Map<string, string>(),
    cloudUrls: new Map<string, unknown>(),
    ...over,
  };

  return captured;
}

/** R2 config fixture — `keyPrefix` mirrors the per-client bucket scoping in production. */
export const R2 = {
  endpoint: 'https://r2.example.com',
  accessKeyId: 'ak',
  secretKey: 'sk',
  sessionToken: 'st',
  bucket: 'dchub-test',
  publicDomain: 'https://cdn.example.com',
  keyPrefix: 'client-abc/',
};
