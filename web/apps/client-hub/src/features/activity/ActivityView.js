import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export default function ActivityView() {
    return (_jsxs("div", { className: "max-w-[760px] mx-auto px-5 py-8", children: [_jsx("h1", { className: "font-serif text-2xl font-medium text-cosmos-black mb-6", children: "Activity" }), _jsx("p", { className: "font-sans text-sm text-text-muted", children: "What moved on the work relevant to you \u2014 newest first." }), _jsx("div", { className: "mt-8 space-y-0", children: [
                    { actor: 'Jana K.', action: 'approved', asset: 'Sealing — pitch deck', time: '2 hours ago' },
                    { actor: 'Petr Mucha', action: 'uploaded', asset: 'Brand film — cut 03', time: '1 day ago' },
                    { actor: 'Jana K.', action: 'requested changes on', asset: 'Spring campaign — hero', time: '2 days ago' },
                ].map((item, i) => (_jsxs("div", { className: "flex items-start gap-4 py-4 border-b border-hairline", children: [_jsx("div", { className: "w-8 h-8 rounded-[28%_38%] bg-gray-150 shrink-0" }), _jsxs("div", { className: "text-sm font-sans text-cosmos-black", children: [_jsx("span", { className: "font-semibold", children: item.actor }), ' ', item.action, ' ', _jsx("span", { className: "font-semibold", children: item.asset })] }), _jsx("span", { className: "ml-auto text-[11px] font-sans text-text-muted whitespace-nowrap", children: item.time })] }, i))) })] }));
}
