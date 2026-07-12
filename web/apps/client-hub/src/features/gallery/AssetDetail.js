import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useMemo, useRef } from 'react';
import { canApprove, canDownload, canRate, canComment, MOCK_COMMENTS } from '@dc-hub/asset-library';
import { useRole } from '../../context/RoleContext';
import { useAuth } from '../../context/AuthContext';
import { webAssetActions } from '../../lib/assetActions';
import { updateAssetStatus, fetchChildAssets, fetchVariants, updateAssetPerm, deleteAsset } from '../../services/assetService';
import { fetchComments, addComment, deleteComment } from '../../services/commentService';
import { fetchMyRating, upsertRating } from '../../services/ratingService';
import { trackEvent, fetchEventCounts } from '../../services/eventService';
import { isConfigured } from '../../lib/supabase';
// Good-practice naming convention: variants of one asset share the same tags and differ
// only in a distinguishing bit of text/tag before the version. So the asset's displayed
// name is the tags common to every variant, and each variant's own label is just its
// distinguishing part — not the full (repetitive) name.
function labelSet(a) {
    return new Set([
        ...(a.entities?.length ? a.entities : [a.entity].filter(Boolean)),
        ...(a.angles?.length ? a.angles : [a.angle].filter(Boolean)),
        ...a.formats,
        ...(a.tagsAll ?? []),
    ]);
}
function sharedLabels(rows) {
    if (rows.length === 0)
        return [];
    const sets = rows.map(labelSet);
    return [...sets[0]].filter(label => sets.every(s => s.has(label)));
}
function uniqueLabel(row, shared) {
    let rest = row.name;
    for (const label of shared)
        rest = rest.split(label).join(' ');
    rest = rest.replace(/\s+/g, ' ').replace(/^[\s—-]+|[\s—-]+$/g, '').trim();
    return rest || row.name;
}
const STATUS_OPTIONS = [
    { value: 'draft', label: 'Draft' },
    { value: 'review', label: 'In review' },
    { value: 'approved', label: 'Approved' },
    { value: 'published', label: 'Published' },
    { value: 'archived', label: 'Archived' },
    { value: 'disconnected', label: 'Disconnected' },
];
const PERM_OPTIONS = [
    { value: 'public', label: 'Public' },
    { value: 'client', label: 'Client' },
    { value: 'internal', label: 'Internal' },
];
function matchesActiveFacets(a, facets) {
    if (!facets)
        return false;
    const entityPool = a.entities?.length ? a.entities : [a.entity];
    const anglePool = a.angles?.length ? a.angles : [a.angle];
    return ((facets.entities?.some(e => entityPool.includes(e)) ?? false) ||
        (facets.formats?.some(f => a.formats.includes(f)) ?? false) ||
        (facets.angles?.some(g => anglePool.includes(g)) ?? false));
}
function StarRating({ value, onChange }) {
    const [hovered, setHovered] = useState(0);
    const [selected, setSelected] = useState(value);
    // Sync when parent value changes (initial DB load)
    useEffect(() => { setSelected(value); }, [value]);
    const display = hovered || selected;
    return (_jsx("div", { className: "flex items-center gap-0.5", children: [1, 2, 3, 4, 5].map(n => (_jsx("button", { type: "button", onClick: () => { setSelected(n); onChange?.(n); }, onMouseEnter: () => onChange && setHovered(n), onMouseLeave: () => onChange && setHovered(0), className: `text-xl leading-none transition-colors ${n <= display ? 'text-cosmos-black' : 'text-gray-300'} ${onChange ? 'cursor-pointer' : 'cursor-default'}`, "aria-label": `Rate ${n} star${n > 1 ? 's' : ''}`, children: "\u2605" }, n))) }));
}
export default function AssetDetail({ asset, onClose, mount, onStatusChange, activeFacets }) {
    const { role, activeClient } = useRole();
    const { session } = useAuth();
    const userId = session?.user?.id ?? null;
    const [myRating, setMyRating] = useState(0);
    const [ratingSaved, setRatingSaved] = useState(false);
    const [note, setNote] = useState('');
    const [currentStatus, setCurrentStatus] = useState(asset.status);
    const [currentPerm, setCurrentPerm] = useState(asset.perm);
    const [statusBusy, setStatusBusy] = useState(false);
    const [statusError, setStatusError] = useState(null);
    const [permBusy, setPermBusy] = useState(false);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState(null);
    const [children, setChildren] = useState([]);
    const [childView, setChildView] = useState('grid');
    const [carouselIdx, setCarouselIdx] = useState(0);
    // Folder-based stable identity variants (Task 3) — format/size siblings of this asset,
    // distinct from legacy gallery `children` above (those are preview images, not download choices).
    const [variants, setVariants] = useState([]);
    const [selectedVariantId, setSelectedVariantId] = useState(asset.id);
    // Whichever variant actually matched the active gallery filter (e.g. a tag that only lives
    // on this one variant) leads the list, rather than sitting wherever it falls alphabetically.
    const sortedVariants = useMemo(() => {
        if (!activeFacets)
            return variants;
        return [...variants].sort((a, b) => {
            const aMatch = matchesActiveFacets(a, activeFacets);
            const bMatch = matchesActiveFacets(b, activeFacets);
            return aMatch === bMatch ? 0 : aMatch ? -1 : 1;
        });
    }, [variants, activeFacets]);
    const selectedAsset = sortedVariants.find(v => v.id === selectedVariantId) ?? asset;
    const shared = sortedVariants.length > 0 ? sharedLabels([asset, ...sortedVariants]) : [];
    const displayName = shared.length > 0 ? shared.join(' ') : asset.name;
    // Comments
    const [comments, setComments] = useState([]);
    const [commentInput, setCommentInput] = useState('');
    const [commentBusy, setCommentBusy] = useState(false);
    const [commentThanks, setCommentThanks] = useState(false);
    const thanksTimerRef = useRef(null);
    const [eventCounts, setEventCounts] = useState({ views: 0, downloads: 0 });
    const accent = activeClient?.accent ?? '#161616';
    const isStaff = role === 'admin' || role === 'editor';
    // Track view + load event counts
    useEffect(() => {
        if (!isConfigured())
            return;
        trackEvent(asset.id, 'view', userId, role).catch(() => { });
        if (isStaff)
            fetchEventCounts(asset.id).then(setEventCounts).catch(console.error);
    }, [asset.id]);
    // Load children (legacy gallery preview images) and variants (Task 3 format/size siblings)
    useEffect(() => {
        if ((asset.childCount ?? 0) > 0) {
            fetchChildAssets(asset.id).then(setChildren).catch(console.error);
            fetchVariants(asset.id).then(setVariants).catch(console.error);
        }
        else {
            setChildren([]);
            setVariants([]);
        }
        setCarouselIdx(0);
        setSelectedVariantId(asset.id);
    }, [asset.id, asset.childCount]);
    // Reset local status/perm when asset changes
    useEffect(() => {
        setCurrentStatus(asset.status);
        setCurrentPerm(asset.perm);
        setStatusError(null);
    }, [asset.id]);
    // Load user's existing rating on mount / asset change
    useEffect(() => {
        if (!userId || !canRate(role))
            return;
        if (!isConfigured())
            return;
        fetchMyRating(asset.id, userId).then(setMyRating).catch(console.error);
    }, [asset.id, userId, role]);
    // Load comments on mount / asset change
    useEffect(() => {
        if (!canComment(role))
            return;
        if (isConfigured()) {
            fetchComments(asset.id).then(setComments).catch(console.error);
        }
        else {
            // Fallback to mock comments
            const mock = MOCK_COMMENTS.filter(c => c.assetId === asset.id);
            const realMock = mock.map(c => ({
                id: c.id,
                assetId: c.assetId,
                userId: '',
                authorName: c.author,
                authorInitials: c.author.split(' ').map(w => w[0]).join('').slice(0, 2),
                authorRole: c.role,
                body: c.body,
                createdAt: c.createdAt,
            }));
            setComments(realMock);
        }
    }, [asset.id, role]);
    // Cleanup thanks timer on unmount
    useEffect(() => {
        return () => {
            if (thanksTimerRef.current)
                clearTimeout(thanksTimerRef.current);
        };
    }, []);
    async function handleStatusChange(newStatus) {
        if (newStatus === currentStatus || statusBusy)
            return;
        setStatusBusy(true);
        setStatusError(null);
        try {
            await updateAssetStatus(asset.id, newStatus);
            setCurrentStatus(newStatus);
            onStatusChange?.();
        }
        catch (err) {
            setStatusError(err instanceof Error ? err.message : 'Failed to update status');
        }
        finally {
            setStatusBusy(false);
        }
    }
    async function handleApprove() {
        await handleStatusChange('approved');
    }
    async function handleDelete() {
        if (deleteBusy)
            return;
        if (!window.confirm(`Permanently delete "${asset.name}"? This cannot be undone.`))
            return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await deleteAsset(asset.id);
            onStatusChange?.();
            onClose?.();
        }
        catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Failed to delete asset');
            setDeleteBusy(false);
        }
    }
    async function handlePermChange(newPerm) {
        if (newPerm === currentPerm || permBusy)
            return;
        setPermBusy(true);
        try {
            await updateAssetPerm(asset.id, newPerm);
            setCurrentPerm(newPerm);
        }
        catch (err) {
            console.error('Failed to update perm:', err);
        }
        finally {
            setPermBusy(false);
        }
    }
    async function handleRatingChange(value) {
        setMyRating(value);
        if (!userId)
            return;
        try {
            await upsertRating(asset.id, userId, value);
            setRatingSaved(true);
            setTimeout(() => setRatingSaved(false), 2000);
        }
        catch (err) {
            console.error('Failed to save rating:', err);
        }
    }
    async function handleSubmitComment() {
        const body = commentInput.trim();
        if (!body || !userId || commentBusy)
            return;
        setCommentBusy(true);
        try {
            const newComment = await addComment(asset.id, userId, body);
            setComments(prev => [...prev, newComment]);
            setCommentInput('');
            setCommentThanks(true);
            if (thanksTimerRef.current)
                clearTimeout(thanksTimerRef.current);
            thanksTimerRef.current = setTimeout(() => setCommentThanks(false), 3000);
        }
        catch (err) {
            console.error('Failed to add comment:', err);
        }
        finally {
            setCommentBusy(false);
        }
    }
    async function handleDeleteComment(id) {
        try {
            await deleteComment(id);
            setComments(prev => prev.filter(c => c.id !== id));
        }
        catch (err) {
            console.error('Failed to delete comment:', err);
        }
    }
    function handleCommentKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmitComment();
        }
    }
    const content = (_jsxs("div", { className: "flex flex-col h-full overflow-y-auto bg-bg", children: [onClose && (_jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-b border-border shrink-0", children: [_jsxs("span", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: [activeClient?.name ?? '', " \u00B7 ", asset.version] }), _jsx("button", { onClick: onClose, className: "text-text-muted hover:text-cosmos-black transition-colors text-lg leading-none", "aria-label": "Close", children: "\u00D7" })] })), _jsxs("div", { className: "px-6 py-5 space-y-6", children: [children.length > 0 ? (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: ["Files \u00B7 ", children.length] }), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => setChildView('grid'), className: `text-[10px] font-sans font-bold uppercase tracking-label px-2 py-1 rounded-chip border transition-colors ${childView === 'grid'
                                                    ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                                                    : 'border-border text-text-muted hover:border-cosmos-black'}`, children: "Grid" }), _jsx("button", { onClick: () => { setChildView('carousel'); setCarouselIdx(0); }, className: `text-[10px] font-sans font-bold uppercase tracking-label px-2 py-1 rounded-chip border transition-colors ${childView === 'carousel'
                                                    ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                                                    : 'border-border text-text-muted hover:border-cosmos-black'}`, children: "Slide" })] })] }), childView === 'grid' ? (_jsx("div", { className: "grid grid-cols-2 gap-2", children: children.map((child, i) => (_jsx("div", { className: "aspect-video bg-gray-150 rounded-sm overflow-hidden relative", children: child.thumbnailUrl
                                        ? _jsx("img", { referrerPolicy: "no-referrer", src: child.thumbnailUrl, alt: child.name, className: "w-full h-full object-cover" })
                                        : _jsx("div", { className: "w-full h-full bg-gray-150 flex items-center justify-center text-text-muted text-xs font-sans", children: i + 1 }) }, child.id))) })) : (_jsxs("div", { className: "relative", children: [_jsx("div", { className: "aspect-video bg-gray-150 rounded-sm overflow-hidden", children: children[carouselIdx]?.thumbnailUrl
                                            ? _jsx("img", { referrerPolicy: "no-referrer", src: children[carouselIdx].thumbnailUrl, alt: children[carouselIdx].name, className: "w-full h-full object-cover" })
                                            : _jsx("div", { className: "w-full h-full bg-gray-150" }) }), _jsxs("div", { className: "flex items-center justify-between mt-2", children: [_jsx("button", { onClick: () => setCarouselIdx(i => Math.max(0, i - 1)), disabled: carouselIdx === 0, className: "text-sm font-sans px-3 py-1 border border-border rounded-sm disabled:opacity-30 hover:border-cosmos-black transition-colors", children: "\u2190" }), _jsxs("span", { className: "text-[11px] font-sans text-text-muted", children: [carouselIdx + 1, " / ", children.length] }), _jsx("button", { onClick: () => setCarouselIdx(i => Math.min(children.length - 1, i + 1)), disabled: carouselIdx === children.length - 1, className: "text-sm font-sans px-3 py-1 border border-border rounded-sm disabled:opacity-30 hover:border-cosmos-black transition-colors", children: "\u2192" })] })] }))] })) : (_jsx("div", { className: "aspect-video bg-gray-150 rounded-sm overflow-hidden", children: selectedAsset.thumbnailUrl
                            ? _jsx("img", { referrerPolicy: "no-referrer", src: selectedAsset.thumbnailUrl, alt: selectedAsset.name, className: "w-full h-full object-cover" })
                            : _jsx("div", { className: "w-full h-full bg-gray-150" }) })), _jsxs("div", { children: [_jsx("h2", { className: "font-serif text-xl font-medium text-cosmos-black leading-tight tracking-tight mb-1", children: displayName }), _jsxs("p", { className: "text-[11px] font-sans text-text-muted", children: [activeClient?.name, " \u00B7 ", asset.version, " \u00B7 updated recently"] })] }), _jsxs("div", { className: "flex flex-wrap gap-1.5", children: [_jsx("span", { className: "text-[11px] font-sans font-medium bg-gray-150 px-2 py-1 rounded-chip", children: asset.entity }), asset.formats.map(f => (_jsx("span", { className: "text-[11px] font-sans font-medium bg-gray-150 px-2 py-1 rounded-chip", children: f }, f)))] }), sortedVariants.length > 0 && (_jsxs("div", { children: [_jsxs("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2", children: ["Variants \u00B7 ", sortedVariants.length + 1] }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: [asset, ...sortedVariants].map((v, i) => (_jsx("button", { onClick: () => setSelectedVariantId(v.id), title: v.name, className: `text-[11px] font-sans font-medium px-2.5 py-1.5 rounded-chip border transition-colors max-w-35 truncate ${selectedVariantId === v.id
                                        ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                                        : 'border-border text-text-muted hover:border-cosmos-black'}`, children: uniqueLabel(v, shared) || v.name || `Variant ${i + 1}` }, v.id))) })] })), isStaff && (_jsxs("div", { className: "flex gap-4 text-[11px] font-sans text-text-muted", children: [_jsxs("span", { children: ["\uD83D\uDC41 ", eventCounts.views, " views"] }), _jsxs("span", { children: ["\u2193 ", eventCounts.downloads, " downloads"] })] })), canRate(role) && (_jsxs("div", { className: "border border-border rounded-sm p-4 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2", children: "Your rating" }), _jsx(StarRating, { value: myRating, onChange: handleRatingChange }), ratingSaved && (_jsx("p", { className: "text-[10px] font-sans text-text-muted mt-1 transition-opacity", children: "Saved" }))] }), _jsxs("div", { className: "text-right", children: [_jsx("p", { className: "font-serif text-3xl font-medium leading-none text-cosmos-black", children: asset.avg.toFixed(1) }), _jsxs("p", { className: "text-[11px] font-sans text-text-muted mt-1", children: [asset.count, " ratings"] })] })] })), isStaff && (_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: "Status" }), _jsxs("div", { className: "flex gap-2 items-center", children: [_jsx("select", { value: currentStatus, onChange: e => handleStatusChange(e.target.value), disabled: statusBusy, className: "flex-1 text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg text-cosmos-black focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed", children: STATUS_OPTIONS.map(o => (_jsx("option", { value: o.value, children: o.label }, o.value))) }), (currentStatus === 'review' || currentStatus === 'draft') && (_jsx("button", { onClick: handleApprove, disabled: statusBusy, className: "px-4 py-2 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed", style: { backgroundColor: accent, boxShadow: `3px 3px 0 #161616` }, children: statusBusy ? '…' : '✓ Approve' })), currentStatus === 'disconnected' && (_jsx("button", { onClick: handleDelete, disabled: deleteBusy, className: "px-4 py-2 text-sm font-sans font-semibold text-red-600 border border-red-600 rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed", children: deleteBusy ? '…' : 'Delete permanently' }))] }), statusError && (_jsx("p", { className: "text-xs font-sans text-red-600", children: statusError })), deleteError && (_jsx("p", { className: "text-xs font-sans text-red-600", children: deleteError }))] })), isStaff && (_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: "Visibility" }), _jsx("select", { value: currentPerm, onChange: e => handlePermChange(e.target.value), disabled: permBusy, className: "w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg text-cosmos-black focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed", children: PERM_OPTIONS.map(o => (_jsx("option", { value: o.value, children: o.label }, o.value))) })] })), canApprove(role) && !isStaff && (_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted", children: "Your decision" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: handleApprove, disabled: statusBusy, className: "flex-1 py-2.5 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed", style: {
                                            backgroundColor: accent,
                                            boxShadow: `5px 5px 0 #161616`,
                                        }, children: statusBusy ? '…' : '✓ Approve' }), _jsx("button", { className: "flex-1 py-2.5 text-sm font-sans font-semibold border border-cosmos-black rounded-sm text-cosmos-black hover:bg-gray-100 transition-colors", children: "\u21A9 Request changes" })] }), _jsx("textarea", { value: note, onChange: e => setNote(e.target.value), placeholder: "Add a note for the team (optional)\u2026", rows: 2, className: "w-full text-sm font-sans border border-border rounded-sm px-3 py-2 resize-none placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors" })] })), canDownload(role, asset) && (_jsx("button", { onClick: () => {
                            trackEvent(selectedAsset.id, 'download', userId, role).catch(() => { });
                            setEventCounts(c => ({ ...c, downloads: c.downloads + 1 }));
                            webAssetActions.download?.(selectedAsset);
                        }, className: "w-full py-3 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px", style: {
                            backgroundColor: accent,
                            boxShadow: `5px 5px 0 #161616`,
                        }, children: "\u2193 Download" })), canComment(role) && (_jsxs("div", { children: [_jsxs("p", { className: "text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-3", children: ["Comments \u00B7 ", comments.length] }), _jsx("div", { className: "space-y-4", children: comments.map(c => (_jsxs("div", { className: "flex gap-3", children: [_jsx("div", { className: "w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0", children: _jsx("span", { className: "text-clear-white text-[9px] font-bold font-sans", children: c.authorInitials }) }), _jsxs("div", { className: "flex-1", children: [_jsxs("div", { className: "flex items-center gap-2 mb-0.5", children: [_jsx("span", { className: "text-sm font-sans font-semibold text-cosmos-black", children: c.authorName }), _jsx("span", { className: "text-[9px] font-sans font-bold uppercase tracking-label border border-border px-1.5 py-0.5 rounded-chip text-text-muted", children: c.authorRole }), isStaff && (_jsx("button", { onClick: () => handleDeleteComment(c.id), className: "ml-auto text-text-muted hover:text-cosmos-black transition-colors text-base leading-none", "aria-label": "Delete comment", children: "\u00D7" }))] }), _jsx("p", { className: "text-sm font-sans text-cosmos-black leading-snug", children: c.body })] })] }, c.id))) }), _jsxs("div", { className: "mt-4 space-y-2", children: [commentThanks && (_jsx("p", { className: "text-[11px] font-sans text-text-muted transition-opacity", children: "Thank you for your comment!" })), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "text", value: commentInput, onChange: e => setCommentInput(e.target.value), onKeyDown: handleCommentKeyDown, placeholder: "Add a comment\u2026", disabled: commentBusy || !userId, className: "flex-1 text-sm font-sans border border-border rounded-sm px-3 py-2 placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50" }), _jsx("button", { onClick: handleSubmitComment, disabled: commentBusy || !commentInput.trim() || !userId, className: "px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed", children: commentBusy ? '…' : 'Send' })] })] })] }))] })] }));
    if (mount === 'page')
        return _jsx("div", { className: "max-w-xl mx-auto py-10 px-5", children: content });
    return (_jsx("div", { className: "w-[400px] shrink-0 border-l border-border h-full overflow-hidden", style: { animation: `dc-drawer-in var(--duration-base) var(--ease-dc) both` }, children: content }));
}
