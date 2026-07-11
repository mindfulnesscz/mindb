import { useState, useEffect } from 'react'
import { supabase, isConfigured } from '../lib/supabase'

export interface TagGroup {
  id: string
  name: string   // empty string = ungrouped (flat rendering)
  items: string[]
}

export interface TagsByDimension {
  entity: string[]
  format: string[]
  angle:  string[]
  groups: {
    entity: TagGroup[]
    format: TagGroup[]
    angle:  TagGroup[]
  }
}

type Dim = 'entity' | 'format' | 'angle'

interface TagRow {
  id: string
  name: string
  dimension: string
  parent_id: string | null
}

function buildGroups(rows: TagRow[], dim: Dim): TagGroup[] {
  const dimRows = rows.filter(r => r.dimension === dim)
  const parentRows = dimRows.filter(r => r.parent_id === null)
  const childRows  = dimRows.filter(r => r.parent_id !== null)

  // Flat structure — no children, return everything as a single unnamed group
  if (childRows.length === 0) {
    return [{ id: '', name: '', items: parentRows.map(r => r.name) }]
  }

  const knownParentIds = new Set(parentRows.map(p => p.id))

  const groups: TagGroup[] = parentRows
    .map(p => ({
      id: p.id,
      name: p.name,
      items: childRows.filter(c => c.parent_id === p.id).map(c => c.name),
    }))
    .filter(g => g.items.length > 0)

  // Orphaned children (parent missing) fall into an unnamed group
  const orphans = childRows.filter(c => !knownParentIds.has(c.parent_id!)).map(c => c.name)
  if (orphans.length > 0) groups.push({ id: '', name: '', items: orphans })

  return groups
}

export function useTags(clientId: string | undefined): TagsByDimension {
  const empty: TagsByDimension = {
    entity: [], format: [], angle: [],
    groups: { entity: [], format: [], angle: [] },
  }
  const [tags, setTags] = useState<TagsByDimension>(empty)

  useEffect(() => {
    if (!clientId || !supabase || !isConfigured()) return
    supabase
      .from('tags' as never)
      .select('id, name, dimension, parent_id')
      .eq('client_id', clientId)
      .order('sort_order')
      .then(({ data }) => {
        const rows = (data ?? []) as TagRow[]

        const entityGroups = buildGroups(rows, 'entity')
        const formatGroups = buildGroups(rows, 'format')
        const angleGroups  = buildGroups(rows, 'angle')

        setTags({
          entity: entityGroups.flatMap(g => g.items),
          format: formatGroups.flatMap(g => g.items),
          angle:  angleGroups.flatMap(g => g.items),
          groups: { entity: entityGroups, format: formatGroups, angle: angleGroups },
        })
      })
  }, [clientId])

  return tags
}
