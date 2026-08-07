import { create } from 'zustand';
import { addBreadcrumb } from '../services/reportError';

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
  pagePreviews: number; // per-page document previews written this run
  notes:        number;
  disconnected: number; // local target-folder files no longer in source (Publish step)
  // CDN — thumbnail uploads (runCdnUpload)
  cdnThumbUploaded:  number;
  cdnThumbCached:    number; // local mtime/size match — skipped without hashing or a network call
  cdnThumbUnchanged: number; // content-hash matched what's already on R2
  // CDN — per-page document previews (runPagesUpload)
  cdnPagesUploaded:  number;
  cdnPagesCached:    number;
  cdnPagesUnchanged: number;
  // CDN — original file uploads (runOriginalUpload)
  cdnOrigUploaded:   number;
  cdnOrigCached:     number;
  cdnOrigUnchanged:  number;
}

export interface SupabaseSyncSummary {
  created:      number;
  updated:      number;
  disconnected: number; // stable-identity rows soft-marked disconnected this run
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
  /** Push any buffered log lines and progress into the store immediately. See `appendLog`. */
  flushLog:    () => void;
  clearLog:    () => void;
  addIssue:    (issue: Omit<Issue, 'id'>) => void;
  clearIssues: () => void;
  finishRun:   (stats: RunStats, hasIssues: boolean) => void;
  setSupabaseSync: (summary: SupabaseSyncSummary) => void;
  resetStats:  () => void;
}

const EMPTY_STATS: RunStats = {
  packages: 0, copied: 0, skipped: 0, errors: 0,
  pubFolders: 0, published: 0, thumbnails: 0, pagePreviews: 0, notes: 0, disconnected: 0,
  cdnThumbUploaded: 0, cdnThumbCached: 0, cdnThumbUnchanged: 0,
  cdnPagesUploaded: 0, cdnPagesCached: 0, cdnPagesUnchanged: 0,
  cdnOrigUploaded: 0, cdnOrigCached: 0, cdnOrigUnchanged: 0,
};

let _idCounter = 0;
function uid() { return String(++_idCounter); }

function now() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

/* How long a non-section log line may sit in the buffer, and the shortest gap between two progress
   updates. Both exist for the same reason: a run emits a line and a progress tick PER FILE, and
   every one of those was its own Zustand set() — a React render of the log panel and the progress
   bar, on the main thread, competing with the run that produced it. On a large library that is
   thousands of renders whose only visible effect is a number moving by a fraction of a percent.

   100 ms is chosen to be invisible to a human reading a scrolling log while being ~1/50th of the
   renders a fast stage used to cause. Nothing about WHAT is logged changed — the lines, their
   order, their types and their timestamps are identical; only the moment the store hears about
   them moves. */
const LOG_FLUSH_MS         = 100;
const PROGRESS_THROTTLE_MS = 100;

export const usePipelineStore = create<PipelineStore>((set) => {
  /* Buffered lines, and the timer that will drain them. Closure state rather than module state so
     it cannot be reached (or forgotten) from anywhere but the actions below. */
  let pendingLines: LogLine[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  let lastProgressAt = 0;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingProgress: number | null = null;

  const cancelFlushTimer = () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  };
  const cancelProgressTimer = () => {
    if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null; }
    pendingProgress = null;
  };

  const flush = () => {
    cancelFlushTimer();
    if (pendingProgress !== null) {
      const p = pendingProgress;
      cancelProgressTimer();
      lastProgressAt = Date.now();
      set({ progress: p });
    }
    if (!pendingLines.length) return;
    const batch = pendingLines;
    pendingLines = [];
    set(state => ({ log: [...state.log, ...batch] }));
  };

  return {
    runStatus:    'idle',
    progress:     0,
    lastRunLabel: '',
    stats:        { ...EMPTY_STATS },
    supabaseSync: null,
    log:          [],
    issues:       [],

    startRun: () => {
      pendingLines = [];
      cancelFlushTimer();
      cancelProgressTimer();
      lastProgressAt = 0;
      set({ runStatus: 'running', progress: 0, issues: [], supabaseSync: null });
    },

    stopRun: () => set({ runStatus: 'stopping' }),

    /* Throttled to ~10 Hz, with the last value ALWAYS delivered: a trailing timer carries whatever
       arrived during the quiet window, so a stage that ends at 100% never leaves the bar at 97%. */
    setProgress: (p) => {
      const at = Date.now();
      if (at - lastProgressAt >= PROGRESS_THROTTLE_MS) {
        cancelProgressTimer();
        lastProgressAt = at;
        set({ progress: p });
        return;
      }
      pendingProgress = p;
      if (progressTimer === null) {
        progressTimer = setTimeout(() => {
          progressTimer = null;
          const value = pendingProgress;
          pendingProgress = null;
          lastProgressAt = Date.now();
          if (value !== null) set({ progress: value });
        }, PROGRESS_THROTTLE_MS - (at - lastProgressAt));
      }
    },

    /**
     * Buffers the line and schedules a flush ~100 ms out.
     *
     * SECTION lines flush synchronously. They are the run's structure — the stage banners a tail is
     * read by and the breadcrumbs an error report is attributed to — so a banner arriving up to
     * 100 ms after the work it announces would read as a stall, and a crash inside a stage would
     * lose the lines that said where it was. Everything buffered before the banner goes out with
     * it, so ORDER IS ALWAYS PRESERVED; batching never reorders a log.
     */
    appendLog: (type, message) => {
      // Stage headings become breadcrumbs, so a later reportError says WHERE in the run it happened.
      // Only sections: a trail of individual file lines would push out the stage that matters.
      if (type === 'section') addBreadcrumb(message);
      pendingLines.push({ id: uid(), timestamp: now(), type, message });
      if (type === 'section') { flush(); return; }
      if (flushTimer === null) flushTimer = setTimeout(flush, LOG_FLUSH_MS);
    },

    flushLog: flush,

    clearLog: () => {
      pendingLines = [];
      cancelFlushTimer();
      set({ log: [] });
    },

    addIssue: (issue) =>
      set(state => ({
        issues: [...state.issues, { ...issue, id: uid() }],
      })),

    clearIssues: () => set({ issues: [] }),

    /* The run is over, so everything still buffered belongs in the log BEFORE the completed state
       lands — and the trailing progress timer is cancelled, or a stale percentage would arrive
       after the bar had already been set to 100. */
    finishRun: (stats, hasIssues) => {
      flush();
      cancelProgressTimer();
      set({
        runStatus:    'completed',
        progress:     100,
        stats,
        lastRunLabel: hasIssues ? 'completed with issues' : 'completed',
      });
    },

    setSupabaseSync: (summary) => set({ supabaseSync: summary }),

    resetStats: () => set({ stats: { ...EMPTY_STATS } }),
  };
});
