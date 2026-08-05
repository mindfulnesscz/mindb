/* Tag admin — the portal's view of a client's taxonomy.
 *
 * Parent groups are portal-only; leaves (the shortcodes that go into filenames) are shared with
 * desktop. The group/leaf/orphan distinction is derived rather than stored — see ./tags/tagTree.ts.
 *
 *   ./tags/tagTree      what a row IS, and how a dimension's rows arrange
 *   ./tags/useTagAdmin  load, drafts, create, save, import, export
 *   ./tags/GroupCard    a group and its leaves
 *   ./tags/LeafTable    the editable leaf table, used in both places leaves are listed
 */

import type { Client } from '@dc-hub/asset-library'
import type { Tag } from '../../services/tagService'
import { buildDimensionTree, dimLabel } from './tags/tagTree'
import { useTagAdmin } from './tags/useTagAdmin'
import { GroupCard } from './tags/GroupCard'
import { LeafTable } from './tags/LeafTable'

const DIMENSIONS: Tag['dimension'][] = ['entity', 'angle', 'format']

export function TagsAdmin({
  client,
  onClientUpdated,
}: {
  client: Client
  onClientUpdated?: () => void
}) {
  const admin = useTagAdmin(client, onClientUpdated)

  if (admin.loading) return <p className="text-sm text-text-muted">Loading tags…</p>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 p-3 border border-border rounded-sm bg-surface-sunken">
        <input
          ref={admin.fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => void admin.importFile(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={admin.importing}
          onClick={() => admin.fileRef.current?.click()}
          className="px-3 py-1.5 text-[11px] font-sans font-semibold border border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors disabled:opacity-40"
        >
          {admin.importing ? 'Importing…' : 'Import from JSON'}
        </button>
        <button
          type="button"
          disabled={admin.importing || admin.tags.length === 0}
          onClick={admin.exportJson}
          className="px-3 py-1.5 text-[11px] font-sans font-semibold border border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors disabled:opacity-40"
        >
          Export JSON
        </button>
        <a
          href="/taxonomy.sample.json"
          download="taxonomy.sample.json"
          className="text-[11px] font-sans text-text-muted hover:text-cosmos-black underline"
        >
          Download sample JSON
        </a>
        <span className="text-[11px] font-sans text-text-subtle">
          Parent groups are portal-only. Leaves (shortcodes) can also be added from desktop.
        </span>
      </div>
      {admin.importMsg && <p className="text-[11px] font-sans text-cosmos-black">{admin.importMsg}</p>}
      {admin.error && <p className="text-sm font-sans text-signal-error">{admin.error}</p>}

      {DIMENSIONS.map(dim => {
        const tree = buildDimensionTree(admin.tags, dim)
        const loose = [...tree.ungroupedLeaves, ...tree.orphanLeaves]

        return (
          <section key={dim} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-sans font-bold uppercase tracking-label text-text-muted">
                {dimLabel(client, dim)}
              </h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void admin.addGroup(dim)}
                  className="text-[11px] font-sans text-text-muted hover:text-cosmos-black"
                >
                  + Group
                </button>
                <button
                  type="button"
                  onClick={() => void admin.addLeaf(dim, null)}
                  className="text-[11px] font-sans text-text-muted hover:text-cosmos-black"
                >
                  + Ungrouped leaf
                </button>
              </div>
            </div>

            {!tree.groups.length && !loose.length && (
              <p className="text-[11px] font-sans text-text-subtle border border-border rounded-sm px-3 py-4">
                No tags yet — add a parent group, import JSON, or add an ungrouped leaf.
              </p>
            )}

            {tree.groups.map(group => (
              <GroupCard
                key={group.id}
                group={group}
                leaves={tree.leavesOf(group.id)}
                admin={admin}
                onAddLeaf={() => void admin.addLeaf(dim, group.id)}
              />
            ))}

            {loose.length > 0 && (
              <div className="border border-border rounded-sm overflow-hidden">
                <div className="px-3 py-2 bg-surface-sunken border-b border-border text-[10px] font-sans uppercase tracking-label text-text-muted">
                  Ungrouped leaves
                </div>
                <LeafTable leaves={loose} admin={admin} />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
