/* One editable leaf row. Values are drafts until Save — see ../tags/useTagAdmin.ts. */

import type { Tag } from '../../../services/tagService'
import type { TagDraft } from './useTagAdmin'

export function LeafRow({
  tag,
  draft,
  onDraft,
  onSave,
  onDelete,
}: {
  tag: Tag
  draft?: TagDraft
  onDraft: (patch: Partial<TagDraft>) => void
  onSave: () => void
  onDelete: () => void
}) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2">
        <input
          value={draft?.name ?? tag.name}
          onChange={e => onDraft({ name: e.target.value })}
          className="w-full border border-border rounded-sm px-2 py-1 bg-bg"
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={draft?.shortcode ?? tag.shortcode ?? ''}
          onChange={e => onDraft({ shortcode: e.target.value })}
          className="w-full border border-border rounded-sm px-2 py-1 font-mono bg-bg"
          maxLength={12}
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={draft?.key ?? tag.key ?? ''}
          onChange={e => onDraft({ key: e.target.value })}
          className="w-full border border-border rounded-sm px-2 py-1 font-mono text-[11px] bg-bg"
        />
      </td>
      <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
        <button type="button" onClick={onSave} className="text-[11px] hover:underline">Save</button>
        <button type="button" onClick={onDelete} className="text-[11px] text-signal-error hover:underline">Del</button>
      </td>
    </tr>
  )
}
