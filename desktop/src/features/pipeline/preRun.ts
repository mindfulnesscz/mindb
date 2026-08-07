/* The pre-run reads — everything the run needs from the portal before the first stage.
 *
 * There are four of them: the vocabulary (the portal owns tag LABELS), a short-lived client-scoped
 * R2 grant, every asset's current access level, and the client's page-preview cap. They used to be
 * awaited one after another, so a run paid the SUM of four round trips before it touched a file.
 *
 * Nothing here depends on anything else here — in particular the two database reads need only
 * `sbConfig`, never the grant — so they are dispatched together and the run waits for the slowest.
 *
 * **The consequences are still applied in the old order**, and that is the load-bearing part. The
 * log lines, their order, and what each failure falls back to are how an operator reads a run:
 *
 *   - a failed grant still DISABLES the CDN stages, with its line unchanged, and still discards the
 *     other two reads even though they have already finished. `previewPageLimit` decides how many
 *     pages the local render stage produces, so keeping a value the serial version never reached
 *     would change what a degraded run writes to disk;
 *   - a read that throws after the grant succeeded still reports the same line and still stops the
 *     ones behind it, because that is what falling out of the old `try` block did.
 *
 * Each read reports its own duration (they overlap now, so they are STEPS — summing them would
 * claim more time than the run spent). The block as a whole is the ranked phase.
 */

import type { LogType } from '../../store/pipelineStore';
import type { VocabularyData } from '@sotto/domain';
import type { R2Config } from '../../services/pipelineService';
import {
  requestR2Grant, fetchAssetStorageState, fetchPreviewPageLimit, type SupabaseConfig,
} from '../../services/supabaseService';
import { loadVocabulary } from '../../services/vocabService';
import { timeStep } from '../../services/pipeline/timing';

/** A line to emit once the block has joined — deferred so the log order cannot depend on timing. */
export interface PreRunLine { type: LogType; msg: string }

/** A read that reports its own duration and never rejects, so its siblings settle independently. */
type Settled<T> =
  | { ok: true;  value: T;         took: string }
  | { ok: false; error: unknown;   took: string };

function settled<T>(label: string, work: Promise<T>): Promise<Settled<T>> {
  const step = timeStep(label);
  return work.then(
    (value): Settled<T> => ({ ok: true,  value, took: step.done() }),
    (error): Settled<T> => ({ ok: false, error, took: step.done() }),
  );
}

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

export interface VocabularyRefresh {
  /** The refreshed vocabulary, or null when the read failed and the cached copy should be kept. */
  data:  VocabularyData | null;
  fresh: boolean;
  lines: PreRunLine[];
}

/**
 * Refresh the vocabulary from the portal.
 *
 * A failure is not fatal: the run continues on the cached labels, which is why this reports a
 * warning rather than throwing. The caller decides what to do with `data` — this module does not
 * touch the store.
 */
export async function refreshRunVocabulary(
  clientId: string,
  opts: { persistCache: boolean },
): Promise<VocabularyRefresh> {
  const read = await settled('vocabulary refresh', loadVocabulary(clientId, {
    forceFromDb:  true,
    persistCache: opts.persistCache,
    requireDb:    true,
  }));
  if (!read.ok) {
    return {
      data: null, fresh: false,
      lines: [{
        type: 'warn',
        msg:  `  Vocabulary refresh skipped — using cached labels (${read.error}) after ${read.took}`,
      }],
    };
  }
  return {
    data: read.value, fresh: true,
    lines: [{ type: 'dim', msg: `  Vocabulary refreshed from portal in ${read.took}` }],
  };
}

/* ── Storage grant, asset levels, page-preview cap ──────────────────────── */

export interface CdnPrerequisites {
  /** Absent ⇒ the CDN stages are disabled for this run. */
  r2?:               R2Config;
  assetLevels?:      Map<string, string>;
  cdnKeyReferences?: Map<string, Set<string>>;
  previewPageLimit?: number;
  lines:             PreRunLine[];
}

/** The grant, validated, plus the half of its log line that describes it. */
async function pipelineGrant(
  sbConfig: SupabaseConfig, clientId: string, clientName: string,
): Promise<{ r2: R2Config; describe: string }> {
  const grant = await requestR2Grant(sbConfig, clientId);
  // A pipeline grant without the gated half means the environment is half-provisioned.
  // Refusing here is the point: uploading anyway would put client and internal assets on
  // the public domain, and the run would report success.
  if (!grant.gatedBucket || !grant.gatedDomain || !grant.gatedAccessKeyId) {
    throw new Error(
      'storage grant has no gated tier — set R2_GATED_BUCKET and R2_GATED_DOMAIN function '
      + 'secrets for this environment. Refusing to publish to the public bucket.',
    );
  }
  return {
    r2: {
      endpoint:     grant.endpoint,
      accessKeyId:  grant.accessKeyId,
      secretKey:    grant.secretAccessKey,
      sessionToken: grant.sessionToken,
      bucket:       grant.bucket,
      publicDomain: grant.publicDomain,
      keyPrefix:    grant.keyPrefix,
      clientId:     grant.clientId ?? clientId,
      gatedBucket:       grant.gatedBucket,
      gatedDomain:       grant.gatedDomain,
      gatedAccessKeyId:  grant.gatedAccessKeyId,
      gatedSecretKey:    grant.gatedSecretAccessKey!,
      gatedSessionToken: grant.gatedSessionToken!,
    },
    describe:
      `Storage grant issued for "${clientName}" (public ${grant.bucket} · gated ${grant.gatedBucket}`
      + `, expires ${new Date(grant.expiresAt).toLocaleTimeString()})`,
  };
}

/**
 * The three CDN prerequisites, read concurrently and applied in series.
 *
 * Object keys carry the access level, so the upload stages need each asset's CURRENT level before
 * they write; the same read indexes live URL/key references for safe pruning. A failed read routes
 * assets at the restrictive create-time default and disables pruning, because the pipeline cannot
 * prove a stale key is unshared. How many pages of a document get previewed is an admin setting on
 * the client row, and a failed read leaves it undefined so the pipeline uses the documented default
 * rather than an unbounded render.
 */
export async function loadCdnPrerequisites(a: {
  sbConfig:   SupabaseConfig;
  clientId:   string;
  clientName: string;
}): Promise<CdnPrerequisites> {
  const [grant, storage, limit] = await Promise.all([
    settled('R2 grant',            pipelineGrant(a.sbConfig, a.clientId, a.clientName)),
    settled('asset storage state', fetchAssetStorageState(a.clientId, a.sbConfig)),
    settled('page-preview limit',  fetchPreviewPageLimit(a.clientId, a.sbConfig)),
  ]);

  /* One line, one meaning: whatever failed, the run says so and stops using what came after it —
     exactly what leaving the old `try` block did. */
  const disabled = (e: unknown): PreRunLine =>
    ({ type: 'error', msg: `  ✕  CDN steps disabled — ${e}` });

  if (!grant.ok) return { lines: [disabled(grant.error)] };
  const lines: PreRunLine[] = [
    { type: 'dim', msg: `  ${grant.value.describe} in ${grant.took}` },
  ];
  const r2 = grant.value.r2;

  if (!storage.ok) return { r2, lines: [...lines, disabled(storage.error)] };
  const assetLevels      = storage.value?.levels ?? new Map<string, string>();
  const cdnKeyReferences = storage.value?.references ?? undefined;
  lines.push({
    type: 'dim',
    msg:  `  ${assetLevels.size} known asset level(s) loaded for key routing in ${storage.took}`,
  });
  if (!cdnKeyReferences) {
    lines.push({
      type: 'warn',
      msg:  '  CDN row references unavailable — stale thumbnail/original pruning disabled for safety',
    });
  }

  if (!limit.ok) return { r2, assetLevels, cdnKeyReferences, lines: [...lines, disabled(limit.error)] };
  const previewPageLimit = limit.value ?? undefined;
  if (previewPageLimit !== undefined) {
    lines.push({
      type: 'dim',
      msg:  `  Page-preview limit for this client: ${previewPageLimit} (read in ${limit.took})`,
    });
  }

  return { r2, assetLevels, cdnKeyReferences, previewPageLimit, lines };
}
