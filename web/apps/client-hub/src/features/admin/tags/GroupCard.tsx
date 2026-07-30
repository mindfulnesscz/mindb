/* A parent group and its leaves.
 *
 * The group's own name and key are editable here; its shortcode is not, because a group that gained
 * one would start appearing in filenames as though it were a leaf.
 */

import type { Tag } from '../../../services/tagService'
import { LeafTable } from './LeafTable'
import type { TagAdmin } from './useTagAdmin'

export function GroupCard({
  group, leaves, admin, onAddLeaf,
}: {
  group: Tag
  leaves: Tag[]
  admin: TagAdmin
  onAddLeaf: () => void
}) {
  const draft = admin.draft[group.id]

  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-sunken border-b border-border">
        <span className="text-[10px] font-sans uppercase tracking-label text-text-muted shrink-0">Group</span>
        <input
          value={draft?.name ?? group.name}
          onChange={e => admin.patchDraft(group.id, { name: e.target.value })}
          className="flex-1 min-w-0 border border-border rounded-sm px-2 py-1 text-sm font-sans font-semibold bg-bg"
        />
        <input
          value={draft?.key ?? group.key ?? ''}
          onChange={e => admin.patchDraft(group.id, { key: e.target.value })}
          className="w-48 border border-border rounded-sm px-2 py-1 text-[11px] font-mono bg-bg"
          placeholder="key"
          title="Stable key"
        />
        <button type="button" onClick={() => void admin.saveTag(group)} className="text-[11px] hover:underline shrink-0">Save</button>
        <button
          type="button"
          onClick={() => {
            // Deleting a group takes its leaves with it, and those shortcodes are in filenames.
            if (leaves.length && !window.confirm(`Delete group “${group.name}” and its ${leaves.length} leaf tag(s)?`)) return
            void admin.removeTag(group.id)
          }}
          className="text-[11px] text-signal-error hover:underline shrink-0"
        >
          Del
        </button>
        <button
          type="button"
          onClick={onAddLeaf}
          className="text-[11px] font-sans text-cosmos-black hover:underline shrink-0"
        >
          + Leaf
        </button>
      </div>
      <LeafTable leaves={leaves} admin={admin} emptyText="No leaves in this group yet." />
    </div>
  )
}
