import { supabase } from '../lib/supabase'
import type { TagRow } from '../lib/database.types'

export interface Tag {
  id: string
  name: string
  dimension: 'entity' | 'format' | 'angle'
  parentId: string | null
  sortOrder: number
  clientId: string | null
}

export interface TagTree {
  dimension: 'entity' | 'format' | 'angle'
  roots: TagNode[]
}

export interface TagNode extends Tag {
  children: TagNode[]
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    dimension: row.dimension,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    clientId: row.client_id,
  }
}

function buildTree(tags: Tag[]): TagTree[] {
  const dimensions: Array<'entity' | 'format' | 'angle'> = ['entity', 'format', 'angle']
  return dimensions.map(dim => {
    const dimTags = tags.filter(t => t.dimension === dim)
    const roots = buildNodes(dimTags, null)
    return { dimension: dim, roots }
  })
}

function buildNodes(tags: Tag[], parentId: string | null): TagNode[] {
  return tags
    .filter(t => t.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(t => ({ ...t, children: buildNodes(tags, t.id) }))
}

export async function fetchTags(clientId?: string): Promise<Tag[]> {
  if (!supabase) throw new Error('Supabase not configured')

  let query = supabase
    .from('tags')
    .select('*')
    .order('sort_order')

  if (clientId) {
    // Tags belonging to this client or global tags (client_id is null)
    query = query.or(`client_id.eq.${clientId},client_id.is.null`)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []).map(toTag)
}

export async function fetchTagTrees(clientId?: string): Promise<TagTree[]> {
  const tags = await fetchTags(clientId)
  return buildTree(tags)
}

export async function createTag(
  input: Omit<Tag, 'id'>,
): Promise<Tag> {
  if (!supabase) throw new Error('Supabase not configured')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('tags')
    .insert({
      name: input.name,
      dimension: input.dimension,
      parent_id: input.parentId,
      sort_order: input.sortOrder,
      client_id: input.clientId,
    })
    .select()
    .single() as { data: TagRow | null; error: { message: string } | null }

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  return toTag(data)
}

export async function deleteTag(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('tags').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
