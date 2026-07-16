import { supabase } from '../lib/supabase'
import type { Client } from '@dc-hub/asset-library'
import type { ClientRow, TablesUpdate } from '../lib/database.types'

export function toClient(row: ClientRow): Client {
  const labels = (row as ClientRow & { dimension_labels?: { entity?: string; angle?: string; format?: string } | null }).dimension_labels
  return {
    id:              row.id,
    name:            row.name,
    slug:            row.slug ?? undefined,
    accent:          row.accent,
    initials:        row.initials,
    logoUrl:         row.logo_url ?? undefined,
    website:         row.website ?? undefined,
    portalBg:        row.portal_bg ?? undefined,
    domainWhitelist: row.domain_whitelist,
    dimensionLabels: labels ? {
      entity: labels.entity ?? 'Entity',
      angle:  labels.angle  ?? 'Angle',
      format: labels.format ?? 'Format',
    } : undefined,
  }
}

export async function fetchClients(): Promise<Client[]> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name')

  if (error) throw new Error(error.message)
  return (data ?? []).map(toClient)
}

export async function createClient(input: Omit<Client, 'id'>): Promise<Client> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase
    .from('clients')
    .insert({
      name:             input.name,
      slug:             input.slug ?? null,
      accent:           input.accent,
      initials:         input.initials,
      logo_url:         input.logoUrl ?? null,
      website:          input.website ?? null,
      portal_bg:        input.portalBg ?? null,
      domain_whitelist: input.domainWhitelist ?? [],
      dimension_labels: input.dimensionLabels ?? { entity: 'Entity', angle: 'Angle', format: 'Format' },
    })
    .select()
    .single()

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  return toClient(data as ClientRow)
}

export async function updateClient(id: string, input: Partial<Omit<Client, 'id'>>): Promise<Client> {
  if (!supabase) throw new Error('Supabase not configured')

  const patch: TablesUpdate<'clients'> = {}
  if (input.name      !== undefined) patch.name             = input.name
  if (input.slug      !== undefined) patch.slug             = input.slug || null
  if (input.accent    !== undefined) patch.accent           = input.accent
  if (input.initials  !== undefined) patch.initials         = input.initials
  if (input.logoUrl   !== undefined) patch.logo_url         = input.logoUrl || null
  if (input.website   !== undefined) patch.website          = input.website || null
  if (input.portalBg  !== undefined) patch.portal_bg        = input.portalBg || null
  if (input.domainWhitelist !== undefined) patch.domain_whitelist = input.domainWhitelist
  const dim = (input as Client & { dimensionLabels?: Client['dimensionLabels'] }).dimensionLabels
  if (dim !== undefined) patch.dimension_labels = dim

  const { data, error } = await supabase
    .from('clients')
    .update(patch)
    .eq('id', id)
    .select()
    .single() as { data: ClientRow | null; error: { message: string } | null }

  if (error || !data) throw new Error(error?.message ?? 'No data returned')
  return toClient(data as ClientRow)
}

export async function deleteClient(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
