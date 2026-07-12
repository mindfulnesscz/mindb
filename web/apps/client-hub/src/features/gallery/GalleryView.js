import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getDefaultFilters } from '@dc-hub/asset-library';
import { useAssets } from '../../hooks/useAssets';
import { useTags } from '../../hooks/useTags';
import { deleteDisconnectedAssets } from '../../services/assetService';
import AssetDetail from './AssetDetail';
const STATUS_LABELS = {
    draft: 'Draft',
    review: 'In review',
    approved: 'Approved',
    published: 'Published',
    archived: 'Archived',
    disconnected: 'Disconnected',
};
// ── Asset card ────────────────────────────────────────────────
function AssetCard({ asset, onClick, role }) {
    return (_jsxs("button", { onClick: onClick, className: "group text-left w-full border border-border rounded-sm overflow-hidden bg-surface hover:border-cosmos-black transition-colors duration-base", children: [_jsxs("div", { className: "relative aspect-video bg-gray-150 overflow-hidden", children: [asset.thumbnailUrl
                        ? _jsx("img", { referrerPolicy: "no-referrer", src: asset.thumbnailUrl, alt: asset.name, className: "w-full h-full object-cover" })
                        : _jsx("div", { className: "w-full h-full bg-gray-150" }), _jsxs("div", { className: "absolute top-2 left-2 flex gap-1", children: [_jsx("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-clear-white px-1.5 py-0.5 rounded-chip", children: STATUS_LABELS[asset.status] }), (asset.childCount ?? 0) > 0 && (_jsxs("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-cosmos-black text-clear-white px-1.5 py-0.5 rounded-chip", children: [asset.childCount, " files"] }))] }), !asset.latest && (_jsx("div", { className: "absolute bottom-2 left-2 text-[9px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-clear-white/90 px-1.5 py-0.5 rounded-chip", children: "older version" })), asset.approval === 'pending' && (_jsx("div", { className: "absolute bottom-2 right-2 text-[9px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-clear-white/90 px-1.5 py-0.5 rounded-chip", children: "awaiting you" }))] }), _jsxs("div", { className: "px-3 pt-2.5 pb-3", children: [_jsx("h3", { className: "font-sans text-sm font-semibold text-cosmos-black leading-tight mb-2", children: asset.name }), _jsxs("div", { className: "flex flex-wrap gap-1 mb-3", children: [_jsx("span", { className: "text-[11px] font-sans font-medium bg-gray-150 px-2 py-0.5 rounded-chip", children: asset.entity }), asset.formats.map(f => (_jsx("span", { className: "text-[11px] font-sans font-medium bg-gray-150 px-2 py-0.5 rounded-chip", children: f }, f))), _jsx("span", { className: "text-[11px] font-sans font-medium border border-border px-2 py-0.5 rounded-chip text-text-muted", children: asset.version })] }), _jsxs("div", { className: "flex items-center gap-3 text-text-muted text-xs font-sans", children: [role !== 'public' && (_jsxs("span", { children: ["\u2605 ", asset.avg.toFixed(1), " (", asset.count, ")"] })), role !== 'public' && _jsxs("span", { children: ["\uD83D\uDCAC ", asset.comments] }), _jsx("span", { className: "ml-auto", children: "\u2193" })] })] })] }));
}
// ── Skeletons ─────────────────────────────────────────────────
function CardSkeleton() {
    return (_jsxs("div", { className: "border border-border rounded-sm overflow-hidden bg-surface animate-pulse", children: [_jsx("div", { className: "aspect-video bg-gray-150" }), _jsxs("div", { className: "p-3 space-y-2", children: [_jsx("div", { className: "h-3.5 bg-gray-150 rounded-chip w-3/4" }), _jsx("div", { className: "h-3 bg-gray-150 rounded-chip w-1/2" })] })] }));
}
function EmptyState({ reason }) {
    const copy = {
        'no-assets': { heading: 'No assets yet.', body: 'Nothing has been delivered to this workspace yet.' },
        'filtered': { heading: 'No matches.', body: 'Nothing fits the current filters. Try clearing some.' },
        'no-access': { heading: 'Nothing to see here.', body: "You don't have access to any assets in this workspace." },
    };
    const { heading, body } = copy[reason];
    return (_jsxs("div", { className: "flex flex-col items-center justify-center h-full text-center px-8", children: [_jsx("p", { className: "font-serif text-xl font-medium text-cosmos-black mb-2", children: heading }), _jsx("p", { className: "font-sans text-sm text-text-muted", children: body })] }));
}
// ── Filters rail ──────────────────────────────────────────────
const STATUS_KEYS_STAFF = ['review', 'approved', 'published', 'draft', 'archived', 'disconnected'];
const STATUS_KEYS_CLIENT = ['review', 'approved', 'published', 'draft'];
function TagItems({ items, filterKey, selected, onToggle, }) {
    return (_jsx("div", { className: "space-y-0.5", children: [...new Set(items)].map(item => (_jsxs("label", { className: "flex items-center gap-2 py-0.5 cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: selected?.includes(item) ?? false, onChange: () => onToggle(filterKey, item), className: "rounded-chip border-border accent-cosmos-black" }), _jsx("span", { className: "text-sm font-sans text-cosmos-black truncate", children: item })] }, item))) }));
}
function TagSubGroup({ group, filterKey, selected, onToggle, onClear, collapseKey, }) {
    const [open, setOpen] = useState(true);
    useEffect(() => { if (collapseKey > 0)
        setOpen(false); }, [collapseKey]);
    const sel = selected ?? [];
    const activeCount = group.items.filter(i => sel.includes(i)).length;
    if (!group.name) {
        return _jsx(TagItems, { items: group.items, filterKey: filterKey, selected: sel, onToggle: onToggle });
    }
    return (_jsxs("div", { className: "mb-1", children: [_jsxs("div", { className: "flex items-center", children: [_jsxs("button", { onClick: () => setOpen(o => !o), className: "flex items-center gap-1 text-[10px] font-sans font-semibold uppercase tracking-label text-text-muted/60 flex-1 text-left py-0.5 hover:text-text-muted transition-colors", children: [_jsx("span", { className: "w-3", children: open ? '−' : '+' }), _jsx("span", { className: "flex-1", children: group.name }), activeCount > 0 && (_jsx("span", { className: "text-[9px] bg-cosmos-black text-clear-white rounded-pill px-1.5 py-0.5 leading-tight", children: activeCount }))] }), activeCount > 0 && (_jsx("button", { onClick: e => { e.stopPropagation(); onClear(group.items); }, className: "ml-1 text-[17px] leading-none text-text-muted hover:text-cosmos-black transition-colors", title: `Clear ${group.name}`, children: "\u00D7" }))] }), _jsx("div", { className: open ? 'mt-0.5 pl-3' : 'hidden', children: _jsx(TagItems, { items: group.items, filterKey: filterKey, selected: sel, onToggle: onToggle }) })] }));
}
function TagSection({ label, filterKey, items, groups, selected, filterQuery, open, collapseKey, onToggle, onClearSection, onClearGroup, onToggleItem, }) {
    const q = (filterQuery ?? '').toLowerCase().trim();
    const safeItems = items ?? [];
    const filteredItems = q ? safeItems.filter(i => i.toLowerCase().includes(q)) : safeItems;
    const filteredGroups = groups
        ? (q
            ? groups.map(g => ({ ...g, items: g.items.filter(i => i.toLowerCase().includes(q)) })).filter(g => g.items.length > 0)
            : groups)
        : undefined;
    if (filteredItems.length === 0 && !filteredGroups?.some(g => g.items.length > 0))
        return null;
    const useGroups = filteredGroups && filteredGroups.length > 0 && (filteredGroups.length > 1 || filteredGroups[0].name !== '');
    const selectedCount = selected?.length ?? 0;
    return (_jsxs("div", { className: "mb-3", children: [_jsxs("div", { className: "flex items-center", children: [_jsxs("button", { onClick: onToggle, className: "flex items-center gap-1 text-[10px] font-sans font-bold uppercase tracking-label text-text-muted flex-1 text-left py-0.5 hover:text-cosmos-black transition-colors", children: [_jsx("span", { className: "w-3", children: open ? '−' : '+' }), _jsx("span", { className: "flex-1", children: label }), selectedCount > 0 && (_jsx("span", { className: "text-[9px] bg-cosmos-black text-clear-white rounded-pill px-1.5 py-0.5 leading-tight", children: selectedCount }))] }), selectedCount > 0 && (_jsx("button", { onClick: onClearSection, className: "ml-1 text-[17px] leading-none text-text-muted hover:text-cosmos-black transition-colors", title: `Clear all ${label}`, children: "\u00D7" }))] }), _jsx("div", { className: open ? 'mt-1 pl-4' : 'hidden', children: useGroups ? (_jsx("div", { className: "space-y-0.5", children: filteredGroups.map((g, i) => (_jsx(TagSubGroup, { group: g, filterKey: filterKey, selected: selected, onToggle: onToggleItem, onClear: onClearGroup, collapseKey: collapseKey }, g.id || i))) })) : (_jsx(TagItems, { items: filteredItems, filterKey: filterKey, selected: selected, onToggle: onToggleItem })) })] }));
}
function FiltersRail({ filters, onChange, onHide, tags, statusCounts, statusKeys, isStaff, clientId, onDeletedDisconnected, }) {
    const [filterQuery, setFilterQuery] = useState('');
    const [sectionsOpen, setSectionsOpen] = useState({ entity: true, format: true, angle: true });
    const [collapseKey, setCollapseKey] = useState(0);
    const [deletingDisconnected, setDeletingDisconnected] = useState(false);
    async function handleDeleteDisconnected() {
        if (!clientId || deletingDisconnected)
            return;
        const count = statusCounts.disconnected ?? 0;
        if (!count)
            return;
        if (!window.confirm(`Permanently delete ${count} disconnected asset${count === 1 ? '' : 's'}? This cannot be undone.`))
            return;
        setDeletingDisconnected(true);
        try {
            const { deleted, blocked } = await deleteDisconnectedAssets(clientId);
            if (blocked.length) {
                window.alert(`Deleted ${deleted}. Skipped ${blocked.length} still referenced by other assets: ${blocked.join(', ')}`);
            }
            onDeletedDisconnected();
        }
        catch (err) {
            window.alert(err instanceof Error ? err.message : 'Failed to delete disconnected assets');
        }
        finally {
            setDeletingDisconnected(false);
        }
    }
    function toggleSection(k) {
        setSectionsOpen(s => ({ ...s, [k]: !s[k] }));
    }
    function collapseAll() {
        setSectionsOpen({ entity: false, format: false, angle: false });
        setCollapseKey(k => k + 1);
    }
    function toggleTag(key, val) {
        const cur = filters[key] ?? [];
        onChange({ ...filters, [key]: cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val] });
    }
    function clearSection(key) {
        onChange({ ...filters, [key]: [] });
    }
    function clearGroup(key, groupItems) {
        const cur = filters[key] ?? [];
        onChange({ ...filters, [key]: cur.filter(x => !groupItems.includes(x)) });
    }
    return (_jsxs("aside", { className: "w-[236px] shrink-0 border-r border-border overflow-y-auto bg-surface p-4", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsx("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: "Filters" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { onClick: collapseAll, className: "text-[17px] leading-none text-text-muted hover:text-cosmos-black transition-colors", title: "Collapse all", children: "\u229F" }), _jsx("button", { onClick: onHide, className: "text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors", children: "Hide" })] })] }), _jsx("input", { type: "search", placeholder: "Search filters\u2026", value: filterQuery, onChange: e => setFilterQuery(e.target.value), className: "w-full text-xs font-sans border border-border rounded-sm px-2 py-1 mb-4 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" }), _jsxs("label", { className: "flex items-center gap-2 mb-5 cursor-pointer select-none", children: [_jsx("div", { onClick: () => onChange({ ...filters, latestOnly: !filters.latestOnly }), className: `w-9 h-5 rounded-pill relative shrink-0 transition-colors duration-base cursor-pointer ${filters.latestOnly ? 'bg-cosmos-black' : 'bg-gray-300'}`, children: _jsx("span", { className: `absolute top-0.5 w-4 h-4 bg-clear-white rounded-pill transition-transform duration-base ${filters.latestOnly ? 'translate-x-4' : 'translate-x-0.5'}` }) }), _jsx("span", { className: "text-sm font-sans text-cosmos-black", children: "Latest version only" })] }), _jsxs("div", { className: "mb-5", children: [_jsx("div", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2", children: "\u2014 Status" }), statusKeys.map(s => (_jsxs("label", { className: "flex items-center justify-between py-0.5 cursor-pointer select-none", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "checkbox", checked: filters.status.includes(s), onChange: e => onChange({
                                            ...filters,
                                            status: e.target.checked
                                                ? [...filters.status, s]
                                                : filters.status.filter(x => x !== s),
                                        }), className: "rounded-chip border-border accent-cosmos-black" }), _jsx("span", { className: "text-sm font-sans text-cosmos-black", children: STATUS_LABELS[s] })] }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-xs font-sans text-text-muted", children: statusCounts[s] ?? 0 }), isStaff && s === 'disconnected' && (statusCounts.disconnected ?? 0) > 0 && (_jsx("button", { type: "button", onClick: e => { e.preventDefault(); e.stopPropagation(); handleDeleteDisconnected(); }, disabled: deletingDisconnected, title: "Delete all disconnected assets permanently", className: "text-xs text-red-600 hover:text-red-700 disabled:opacity-50 disabled:cursor-not-allowed", children: deletingDisconnected ? '…' : '🗑' }))] })] }, s)))] }), _jsx(TagSection, { label: "Entity", filterKey: "entities", items: tags.entity, groups: tags.groups.entity, selected: filters.entities, filterQuery: filterQuery, open: sectionsOpen.entity, collapseKey: collapseKey, onToggle: () => toggleSection('entity'), onClearSection: () => clearSection('entities'), onClearGroup: items => clearGroup('entities', items), onToggleItem: toggleTag }), _jsx(TagSection, { label: "Format", filterKey: "formats", items: tags.format, groups: tags.groups.format, selected: filters.formats, filterQuery: filterQuery, open: sectionsOpen.format, collapseKey: collapseKey, onToggle: () => toggleSection('format'), onClearSection: () => clearSection('formats'), onClearGroup: items => clearGroup('formats', items), onToggleItem: toggleTag }), _jsx(TagSection, { label: "Angle", filterKey: "angles", items: tags.angle, groups: tags.groups.angle, selected: filters.angles, filterQuery: filterQuery, open: sectionsOpen.angle, collapseKey: collapseKey, onToggle: () => toggleSection('angle'), onClearSection: () => clearSection('angles'), onClearGroup: items => clearGroup('angles', items), onToggleItem: toggleTag })] }));
}
// ── Gallery view ──────────────────────────────────────────────
export default function GalleryView() {
    const { role, activeClient } = useRole();
    const [filters, setFilters] = useState(getDefaultFilters());
    const [selectedId, setSelectedId] = useState(null);
    const [railVisible, setRailVisible] = useState(true);
    const isStaff = role === 'admin' || role === 'editor';
    const statusKeys = isStaff ? STATUS_KEYS_STAFF : STATUS_KEYS_CLIENT;
    const clientId = activeClient?.id;
    // Stable empty filters — used only for the options pool, never changes → fetches once per client
    const stableFilters = useMemo(() => getDefaultFilters(), []);
    const { assets: optionPool } = useAssets(stableFilters, role, clientId);
    const { assets, total, loading, error, usingMock, reload } = useAssets(filters, role, clientId);
    const tags = useTags(clientId);
    const statusCounts = assets.reduce((acc, a) => {
        acc[a.status] = (acc[a.status] ?? 0) + 1;
        return acc;
    }, {});
    // Derive options from the stable unfiltered pool so options never disappear when filters are active.
    // useTags overrides when available (preserves sort_order from DB).
    const derivedEntities = [...new Set(optionPool.map(a => a.entity).filter(Boolean))].sort();
    const derivedFormats = [...new Set(optionPool.flatMap(a => a.formats ?? []))].sort();
    const derivedAngles = [...new Set(optionPool.map(a => a.angle).filter(Boolean))].sort();
    const effectiveTags = {
        entity: tags.entity.length > 0 ? tags.entity : derivedEntities,
        format: tags.format.length > 0 ? tags.format : derivedFormats,
        angle: tags.angle.length > 0 ? tags.angle : derivedAngles,
        groups: tags.groups,
    };
    const hasFiltersApplied = (filters.status?.length ?? 0) > 0 ||
        (filters.entityTypes?.length ?? 0) > 0 ||
        (filters.entities?.length ?? 0) > 0 ||
        (filters.formats?.length ?? 0) > 0 ||
        (filters.angles?.length ?? 0) > 0 ||
        (filters.perms?.length ?? 0) > 0 ||
        filters.search?.trim() !== '' ||
        filters.latestOnly;
    const selectedAsset = selectedId ? assets.find(a => a.id === selectedId) ?? null : null;
    function emptyReason() {
        if (hasFiltersApplied)
            return 'filtered';
        if (role === 'public')
            return 'no-access';
        return 'no-assets';
    }
    return (_jsxs("div", { className: "flex h-full overflow-hidden", children: [railVisible && (_jsx(FiltersRail, { filters: filters, onChange: setFilters, onHide: () => setRailVisible(false), tags: effectiveTags, statusCounts: statusCounts, statusKeys: statusKeys, isStaff: isStaff, clientId: clientId, onDeletedDisconnected: () => reload() })), _jsxs("div", { className: "flex-1 flex flex-col overflow-hidden", children: [_jsxs("div", { className: "flex items-center gap-3 px-5 py-3 border-b border-border shrink-0", children: [!railVisible && (_jsx("button", { onClick: () => setRailVisible(true), className: "text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors mr-1", children: "Filters" })), _jsx("input", { type: "search", placeholder: "Search assets\u2026", value: filters.search, onChange: e => setFilters(f => ({ ...f, search: e.target.value })), className: "flex-1 text-sm font-sans border border-border rounded-sm px-3 py-1.5 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" }), _jsxs("span", { className: "text-[11px] font-sans text-text-muted whitespace-nowrap", children: [loading ? '—' : `${assets.length} of ${total} assets`, usingMock && _jsx("span", { className: "ml-1 opacity-50", children: "(demo)" })] }), _jsx("button", { className: "text-sm font-sans border border-border rounded-sm px-3 py-1.5 bg-bg text-cosmos-black hover:border-cosmos-black transition-colors whitespace-nowrap", children: "Newest \u2193" })] }), _jsx("div", { className: "flex-1 overflow-y-auto p-5", children: error ? (_jsxs("div", { className: "flex flex-col items-center justify-center h-full text-center px-8", children: [_jsx("p", { className: "font-serif text-lg font-medium text-cosmos-black mb-2", children: "Connection error" }), _jsx("p", { className: "font-sans text-sm text-text-muted max-w-sm", children: error })] })) : loading ? (_jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4", children: Array.from({ length: 6 }).map((_, i) => _jsx(CardSkeleton, {}, i)) })) : assets.length === 0 ? (_jsx(EmptyState, { reason: emptyReason() })) : (_jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4", children: assets.map(asset => (_jsx(AssetCard, { asset: asset, onClick: () => setSelectedId(asset.id), role: role }, asset.id))) })) })] }), selectedAsset && (_jsx(AssetDetail, { asset: selectedAsset, onClose: () => setSelectedId(null), mount: "drawer", onStatusChange: () => reload(), activeFacets: { entities: filters.entities, formats: filters.formats, angles: filters.angles } }))] }));
}
