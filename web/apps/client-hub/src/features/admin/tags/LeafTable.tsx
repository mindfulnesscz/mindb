/* The leaf table — the same three editable columns wherever leaves are listed. */

import type { Tag } from '../../../services/tagService'
import { LeafRow } from './LeafRow'
import type { TagAdmin } from './useTagAdmin'

export function LeafTable({
  leaves, admin, emptyText,
}: {
  leaves: Tag[]
  admin: TagAdmin
  emptyText?: string
}) {
  return (
    <table className="w-full text-sm font-sans">
      <thead className="text-[10px] uppercase tracking-label text-text-muted">
        <tr>
          <th className="text-left px-3 py-1.5 font-normal">Leaf</th>
          <th className="text-left px-3 py-1.5 font-normal w-28">Shortcode</th>
          <th className="text-left px-3 py-1.5 font-normal">Key</th>
          <th className="w-24" />
        </tr>
      </thead>
      <tbody>
        {leaves.map(tag => (
          <LeafRow
            key={tag.id}
            tag={tag}
            draft={admin.draft[tag.id]}
            onDraft={patch => admin.patchDraft(tag.id, patch)}
            onSave={() => void admin.saveTag(tag)}
            onDelete={() => void admin.removeTag(tag.id)}
          />
        ))}
        {!leaves.length && emptyText && (
          <tr>
            <td colSpan={4} className="px-3 py-3 text-[11px] text-text-subtle">{emptyText}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
