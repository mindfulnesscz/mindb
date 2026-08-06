import type { CdnGcReport } from '../../../packages/domain/src/cdnGarbageCollection.ts';

export const PRODUCTION_PROJECT_REF = 'knbxyaplaoenrxrpgwcg';

export function deletionConfirmation(orphanCount: number): string {
  return `DELETE ${orphanCount} OBJECTS`;
}

export type ExecutionGuard =
  | { ok: true }
  | { ok: false; code: 'nothing_to_delete' | 'blast_radius' | 'plan_changed' | 'confirmation' | 'production_confirmation'; error: string };

/** Pure destructive-action gate, kept separate so it is unit-testable without Deno or R2. */
export function guardCdnGcExecution(args: {
  report: CdnGcReport;
  currentPlanId: string;
  expectedPlanId?: string;
  confirmation?: string;
  productionConfirmation?: string;
  isProduction: boolean;
}): ExecutionGuard {
  const { report } = args;
  if (report.totals.orphanCount === 0) {
    return { ok: false, code: 'nothing_to_delete', error: 'There are no orphan objects to delete.' };
  }
  if (report.safety.blastRadiusExceeded) {
    return {
      ok: false,
      code: 'blast_radius',
      error: 'The 60% blast-radius gate is exceeded. The Admin GUI cannot override it; use the CLI after investigation.',
    };
  }
  if (!args.expectedPlanId || args.expectedPlanId !== args.currentPlanId) {
    return {
      ok: false,
      code: 'plan_changed',
      error: 'The bucket or asset snapshot changed. Review the fresh analysis before executing.',
    };
  }
  if (args.confirmation !== deletionConfirmation(report.totals.orphanCount)) {
    return {
      ok: false,
      code: 'confirmation',
      error: `Type ${deletionConfirmation(report.totals.orphanCount)} exactly to continue.`,
    };
  }
  if (args.isProduction && args.productionConfirmation !== 'production') {
    return {
      ok: false,
      code: 'production_confirmation',
      error: 'Type production exactly to confirm a production deletion.',
    };
  }
  return { ok: true };
}
