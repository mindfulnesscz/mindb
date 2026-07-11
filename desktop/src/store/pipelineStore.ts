import { create } from 'zustand';

export type LogType = 'section' | 'info' | 'success' | 'skip' | 'warn' | 'error' | 'dim' | 'disconnected';

export interface LogLine {
  id:        string;
  timestamp: string;
  type:      LogType;
  message:   string;
}

export interface Issue {
  id:       string;
  category: 'skipped' | 'disconnected' | 'version-conflict' | 'error';
  file:     string;
  reason:   string;
}

export interface RunStats {
  packages:     number;
  copied:       number;
  skipped:      number;
  errors:       number;
  pubFolders:   number;
  published:    number;
  thumbnails:   number;
  notes:        number;
  disconnected: number; // local target-folder files no longer in source (Publish step)
  // CDN — thumbnail uploads (runCdnUpload)
  cdnThumbUploaded:  number;
  cdnThumbCached:    number; // local mtime/size match — skipped without hashing or a network call
  cdnThumbUnchanged: number; // content-hash matched what's already on R2
  // CDN — original file uploads (runOriginalUpload)
  cdnOrigUploaded:   number;
  cdnOrigCached:     number;
  cdnOrigUnchanged:  number;
}

export interface SupabaseSyncSummary {
  created:      number;
  updated:      number;
  disconnected: number; // stable-identity rows soft-marked disconnected this run
  deleted:      number; // legacy rows hard-deleted this run
  errors:       number;
}

export type RunStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'error';

interface PipelineStore {
  runStatus:   RunStatus;
  progress:    number; // 0–100
  lastRunLabel: string;
  stats:       RunStats;
  supabaseSync: SupabaseSyncSummary | null; // last Supabase sync result, set once per run
  log:         LogLine[];
  issues:      Issue[];

  startRun:    () => void;
  stopRun:     () => void;
  setProgress: (p: number) => void;
  appendLog:   (type: LogType, message: string) => void;
  clearLog:    () => void;
  addIssue:    (issue: Omit<Issue, 'id'>) => void;
  clearIssues: () => void;
  finishRun:   (stats: RunStats, hasIssues: boolean) => void;
  setSupabaseSync: (summary: SupabaseSyncSummary) => void;
  resetStats:  () => void;
}

const EMPTY_STATS: RunStats = {
  packages: 0, copied: 0, skipped: 0, errors: 0,
  pubFolders: 0, published: 0, thumbnails: 0, notes: 0, disconnected: 0,
  cdnThumbUploaded: 0, cdnThumbCached: 0, cdnThumbUnchanged: 0,
  cdnOrigUploaded: 0, cdnOrigCached: 0, cdnOrigUnchanged: 0,
};

let _idCounter = 0;
function uid() { return String(++_idCounter); }

function now() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

export const usePipelineStore = create<PipelineStore>((set) => ({
  runStatus:    'idle',
  progress:     0,
  lastRunLabel: '',
  stats:        { ...EMPTY_STATS },
  supabaseSync: null,
  log:          [],
  issues:       [],

  startRun: () =>
    set({ runStatus: 'running', progress: 0, issues: [], supabaseSync: null }),

  stopRun: () => set({ runStatus: 'stopping' }),

  setProgress: (p) => set({ progress: p }),

  appendLog: (type, message) =>
    set(state => ({
      log: [...state.log, { id: uid(), timestamp: now(), type, message }],
    })),

  clearLog: () => set({ log: [] }),

  addIssue: (issue) =>
    set(state => ({
      issues: [...state.issues, { ...issue, id: uid() }],
    })),

  clearIssues: () => set({ issues: [] }),

  finishRun: (stats, hasIssues) =>
    set({
      runStatus:    'completed',
      progress:     100,
      stats,
      lastRunLabel: hasIssues ? 'completed with issues' : 'completed',
    }),

  setSupabaseSync: (summary) => set({ supabaseSync: summary }),

  resetStats: () => set({ stats: { ...EMPTY_STATS } }),
}));
