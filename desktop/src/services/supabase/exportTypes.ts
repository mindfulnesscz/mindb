/* Shared shapes for the asset-export stages.
 *
 * Split out so the stages hand data to each other explicitly instead of closing over one
 * function's locals — that shared mutable state was the reason the sync could not be divided
 * before.
 */

export interface SupabaseExportResult {
  created:        number;
  updated:        number;
  disconnected:   number; // stable-identity rows soft-marked disconnected this run
  errors:         number;
  staleObjectKeys: string[]; // R2 object keys that should be deleted (thumbnails + originals)
}

/** A row already in the database, as the sync needs to see it. */
export interface StableRow {
  id: string;
  stable_id: string;
  child_id: string;
  thumbnail_url: string | null;
  download_key?: string | null;
  parent_id: string | null;
  variant_of: string | null;
  /** Access level as the DATABASE has it — portal-owned after creation, so the pipeline
   *  reads it (for readme.md) but never writes it on an update. See stripPortalOwnedFields. */
  perm?: string | null;
  status?: string | null;
}

/** A top-of-hierarchy row: a single asset's primary, or a gallery parent. */
export interface ParentWrite {
  key: string;                          // `${stable_id}:${child_id}`
  record: Record<string, unknown>;
}

/**
 * A row hanging off a parent. The RELATION is the product distinction, not an implementation
 * detail: `parent_id` is a gallery (many related-but-distinct files → the portal shows a grid),
 * `variant_of` is a rendition set (one deliverable in several formats → the portal shows a
 * picker). Conflating them once made the portal render a 60-chip picker for a photo grid.
 */
export interface ChildWrite {
  key: string;
  record: Record<string, unknown>;
  parentKey: string;
  relation: 'variant_of' | 'parent_id';
}

/** One readme.md per package dir, keyed off the primary's stem so its tags can be re-parsed. */
export interface ReadmeTarget {
  packageDir: string;
  stableId: string;
  stem: string;
  /** What this run WOULD write for a brand-new row. For a row that already exists the readme
   *  shows the database's value instead — perm and status are portal-owned once created, and a
   *  readme asserting the pipeline's default would misreport who can see the asset. */
  perm: string;
  status: string;
}

/** Everything the planning stage produces for the writing stage. */
export interface ExportPlan {
  parentWrites: ParentWrite[];
  childWrites: ChildWrite[];
  readmeTargets: ReadmeTarget[];
  /** Every `${stable_id}:${child_id}` seen on disk this run — the disconnect stage's truth set. */
  currentStableKeys: Set<string>;
}
