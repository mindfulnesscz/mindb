import { canViewAsset } from './permissions.js';
export function applyFilters(assets, filters, role, viewingClientId) {
    return assets.filter(asset => {
        if (!canViewAsset(role, asset, viewingClientId))
            return false;
        if (filters.latestOnly && !asset.latest)
            return false;
        if (filters.status.length > 0 && !filters.status.includes(asset.status))
            return false;
        if (filters.entityTypes.length > 0 && !filters.entityTypes.includes(asset.entityType))
            return false;
        const entityPool = asset.entities?.length ? asset.entities : [asset.entity];
        if (filters.entities.length > 0 && !filters.entities.some(e => entityPool.includes(e)))
            return false;
        if (filters.formats.length > 0 && !filters.formats.some(f => asset.formats.includes(f)))
            return false;
        const anglePool = asset.angles?.length ? asset.angles : [asset.angle];
        if (filters.angles.length > 0 && !filters.angles.some(g => anglePool.includes(g)))
            return false;
        if (filters.perms.length > 0 && !filters.perms.includes(asset.perm))
            return false;
        if (filters.search.trim()) {
            const q = filters.search.toLowerCase();
            const matchesName = asset.name.toLowerCase().includes(q);
            const matchesEntity = asset.entity.toLowerCase().includes(q);
            const matchesFormat = asset.formats.some(f => f.toLowerCase().includes(q));
            if (!matchesName && !matchesEntity && !matchesFormat)
                return false;
        }
        return true;
    });
}
export function getDefaultFilters() {
    return {
        search: '',
        latestOnly: false,
        status: [],
        entityTypes: [],
        entities: [],
        formats: [],
        angles: [],
        perms: [],
    };
}
export function countByStatus(assets) {
    return assets.reduce((acc, a) => {
        acc[a.status] = (acc[a.status] ?? 0) + 1;
        return acc;
    }, {});
}
