import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useParams, Link } from 'react-router-dom';
import { MOCK_ASSETS } from '@dc-hub/asset-library';
import AssetDetail from './AssetDetail';
export default function AssetDetailPage() {
    const { id } = useParams();
    const asset = MOCK_ASSETS.find(a => a.id === id);
    if (!asset) {
        return (_jsx("div", { className: "flex items-center justify-center h-screen font-sans text-text-muted", children: _jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-sm mb-3", children: "Asset not found." }), _jsx(Link, { to: "/", className: "text-sm underline text-cosmos-black", children: "Back to gallery" })] }) }));
    }
    return (_jsxs("div", { className: "min-h-screen bg-bg", children: [_jsxs("div", { className: "border-b border-border px-6 py-3 flex items-center gap-3", children: [_jsx("div", { className: "w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center", children: _jsx("span", { className: "text-clear-white text-[10px] font-bold font-sans leading-none", children: "C" }) }), _jsx("span", { className: "text-xs font-sans font-bold uppercase tracking-label text-cosmos-black", children: "DC HUB" }), _jsx("span", { className: "text-border", children: "\u00B7" }), _jsx(Link, { to: "/", className: "text-xs font-sans text-text-muted hover:text-cosmos-black transition-colors", children: "Back to gallery" })] }), _jsx(AssetDetail, { asset: asset, mount: "page" })] }));
}
