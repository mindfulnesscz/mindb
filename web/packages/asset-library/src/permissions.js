const VISIBLE_PERMS = {
    public: ['public'],
    member: ['public', 'client'],
    editor: ['public', 'client', 'internal'],
    admin: ['public', 'client', 'internal'],
};
export function canViewAsset(role, asset, viewingClientId) {
    if (!VISIBLE_PERMS[role].includes(asset.perm))
        return false;
    if (role === 'member' && viewingClientId && asset.clientId !== viewingClientId)
        return false;
    return true;
}
export function canRate(role) {
    return role !== 'public';
}
export function canComment(role) {
    return role !== 'public';
}
export function canApprove(role) {
    return role !== 'public';
}
export function canDownload(role, asset) {
    if (role === 'public')
        return false;
    if (role === 'member')
        return asset.status === 'approved' || asset.status === 'published';
    return true;
}
export function canSetStatus(role) {
    return role === 'editor' || role === 'admin';
}
export function canSwitchClient(role) {
    return role === 'editor' || role === 'admin';
}
export function canManageClients(role) {
    return role === 'admin';
}
export function canControlPermission(role) {
    return role === 'admin';
}
