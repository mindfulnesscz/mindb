import { supabase } from '../lib/supabase'
import type { TagRow, TablesUpdate, Json } from '../lib/database.types'

export interface Tag {
  id: string
  name: string
  key: string | null
  shortcode: string | null
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

function toTag(row: TagRow & { shortcode?: string | null; key?: string | null }): Tag {
  return {
    id: row.id,
    name: row.name,
    key: row.key ?? null,
    shortcode: row.shortcode ?? null,
    dimension: row.dimension as Tag['dimension'],
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
    query = query.or(`client_id.eq.${clientId},client_id.is.null`)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []).map(row => toTag(row as TagRow & { shortcode?: string | null }))
}

export async function fetchTagTrees(clientId?: string): Promise<TagTree[]> {
  const tags = await fetchTags(clientId)
  return buildTree(tags)
}

export async function createTag(input: Omit<Tag, 'id'>): Promise<Tag> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase
    .from('tags')
    .insert({
      name: input.name,
      key: input.key,
      shortcode: input.shortcode,
      dimension: input.dimension,
      parent_id: input.parentId,
      sort_order: input.sortOrder,
      client_id: input.clientId,
    })
    .select()
    .single()

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  return toTag(data as TagRow & { shortcode?: string | null; key?: string | null })
}

export async function updateTag(id: string, input: Partial<Omit<Tag, 'id'>>): Promise<Tag> {
  if (!supabase) throw new Error('Supabase not configured')

  const existing = await supabase
    .from('tags')
    .select('shortcode,name,client_id,dimension')
    .eq('id', id)
    .single()
  const prev = existing.data as {
    shortcode?: string | null
    name?: string
    client_id?: string | null
    dimension?: string
  } | null
  const prevShortcode = prev?.shortcode ?? null
  const prevName = (prev?.name ?? '').trim()

  const patch: TablesUpdate<'tags'> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.key !== undefined) patch.key = input.key
  if (input.shortcode !== undefined) patch.shortcode = input.shortcode
  if (input.dimension !== undefined) patch.dimension = input.dimension
  if (input.parentId !== undefined) patch.parent_id = input.parentId
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder

  const { data, error } = await supabase
    .from('tags')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  const tag = toTag(data as TagRow & { shortcode?: string | null; key?: string | null })

  if (input.shortcode !== undefined && input.shortcode !== prevShortcode && tag.clientId) {
    await enqueueRenameTask({
      clientId: tag.clientId,
      taskType: 'tag_rename',
      payload: { tag_id: id, old_shortcode: prevShortcode, new_shortcode: input.shortcode },
    })
  }

  // Display labels on assets are stored as strings (name / entities / …). When a
  // tag's full name changes on the hub, rewrite those immediately so the gallery
  // doesn't wait for a desktop pipeline run.
  const nextName = tag.name.trim()
  if (
    input.name !== undefined &&
    prevName &&
    nextName &&
    prevName !== nextName &&
    tag.clientId
  ) {
    await rewriteAssetLabelsForTagRename(tag.clientId, prevName, nextName)
  }

  return tag
}

/** Swap a tag display label across client assets (exact array entries + name tokens). */
async function rewriteAssetLabelsForTagRename(
  clientId: string,
  fromLabel: string,
  toLabel: string,
): Promise<void> {
  if (!supabase) return

  const { data: rows, error } = await supabase
    .from('assets')
    .select('id,name,entities,formats,angles,tags')
    .eq('client_id', clientId)

  if (error || !rows?.length) return

  const escaped = fromLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nameTokenRe = new RegExp(`(^|\\s)${escaped}(?=\\s|—|$)`, 'g')

  function mapLabels(list: unknown): string[] | null {
    if (!Array.isArray(list)) return null
    let changed = false
    const next = list.map(item => {
      if (typeof item !== 'string') return item
      if (item === fromLabel) { changed = true; return toLabel }
      return item
    })
    return changed ? (next as string[]) : null
  }

  for (const row of rows as Array<{
    id: string
    name: string
    entities: string[] | null
    formats: string[] | null
    angles: string[] | null
    tags: string[] | null
  }>) {
    const patch: TablesUpdate<'assets'> = {}
    const entities = mapLabels(row.entities)
    const formats = mapLabels(row.formats)
    const angles = mapLabels(row.angles)
    const tagsArr = mapLabels(row.tags)
    if (entities) patch.entities = entities
    if (formats) patch.formats = formats
    if (angles) patch.angles = angles
    if (tagsArr) patch.tags = tagsArr

    if (typeof row.name === 'string' && row.name.includes(fromLabel)) {
      const nextName = row.name.replace(nameTokenRe, `$1${toLabel}`)
      if (nextName !== row.name) patch.name = nextName
    }

    if (!Object.keys(patch).length) continue
    await supabase.from('assets').update(patch).eq('id', row.id)
  }
}

export async function deleteTag(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data: row } = await supabase.from('tags').select('client_id, shortcode').eq('id', id).single()
  const { error } = await supabase.from('tags').delete().eq('id', id)
  if (error) throw new Error(error.message)

  const clientId = (row as { client_id?: string | null } | null)?.client_id
  const shortcode = (row as { shortcode?: string | null } | null)?.shortcode
  if (clientId && shortcode) {
    await enqueueRenameTask({
      clientId,
      taskType: 'tag_delete',
      payload: { tag_id: id, shortcode },
    })
  }
}

export async function enqueueRenameTask(input: {
  clientId: string
  taskType: 'tag_rename' | 'tag_delete' | 'asset_retag'
  payload: Record<string, unknown>
  assetId?: string
}): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data: session } = await supabase.auth.getSession()
  const userId = session.session?.user?.id ?? null

  const { error } = await supabase.from('rename_tasks').insert({
    client_id: input.clientId,
    asset_id: input.assetId ?? null,
    task_type: input.taskType,
    payload: input.payload as Json,
    created_by: userId,
  })
  if (error) throw new Error(error.message)
}
