import { supabase } from '../lib/supabase';
function toTag(row) {
    return {
        id: row.id,
        name: row.name,
        dimension: row.dimension,
        parentId: row.parent_id,
        sortOrder: row.sort_order,
        clientId: row.client_id,
    };
}
function buildTree(tags) {
    const dimensions = ['entity', 'format', 'angle'];
    return dimensions.map(dim => {
        const dimTags = tags.filter(t => t.dimension === dim);
        const roots = buildNodes(dimTags, null);
        return { dimension: dim, roots };
    });
}
function buildNodes(tags, parentId) {
    return tags
        .filter(t => t.parentId === parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(t => ({ ...t, children: buildNodes(tags, t.id) }));
}
export async function fetchTags(clientId) {
    if (!supabase)
        throw new Error('Supabase not configured');
    let query = supabase
        .from('tags')
        .select('*')
        .order('sort_order');
    if (clientId) {
        // Tags belonging to this client or global tags (client_id is null)
        query = query.or(`client_id.eq.${clientId},client_id.is.null`);
    }
    const { data, error } = await query;
    if (error)
        throw new Error(error.message);
    return (data ?? []).map(toTag);
}
export async function fetchTagTrees(clientId) {
    const tags = await fetchTags(clientId);
    return buildTree(tags);
}
export async function createTag(input) {
    if (!supabase)
        throw new Error('Supabase not configured');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase
        .from('tags')
        .insert({
        name: input.name,
        dimension: input.dimension,
        parent_id: input.parentId,
        sort_order: input.sortOrder,
        client_id: input.clientId,
    })
        .select()
        .single();
    if (error || !data)
        throw new Error(error?.message ?? 'No data returned');
    return toTag(data);
}
export async function deleteTag(id) {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { error } = await supabase.from('tags').delete().eq('id', id);
    if (error)
        throw new Error(error.message);
}
