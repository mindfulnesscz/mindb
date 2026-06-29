#!/usr/bin/env python3
"""
patch_vocab_search.py -- adds search to vocab-manager.py
Run:  cd /Users/petrmucha/Sites/localhost/dc-hub && python3 patch_vocab_search.py
"""
from pathlib import Path

TARGET = Path(__file__).parent / 'vocab-manager.py'
src = TARGET.read_text(encoding='utf-8')

# ── 1. CSS: add search bar + result highlight styles ─────────────────────────
OLD_CSS = "  --radius:   8px;\n}"
NEW_CSS = """\
  --radius:   8px;
}

/* ── Search bar ── */
.search-wrap { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.search-input {
  width: 100%; background: var(--surf2); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-family: var(--font);
  font-size: 12px; padding: 7px 10px 7px 30px; outline: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%236b6b80' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: 9px center;
}
.search-input:focus { border-color: var(--blue); }
.search-input::placeholder { color: var(--muted); }
.search-clear { position: absolute; right: 20px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px;
  line-height: 1; padding: 2px 4px; display: none; }
.search-clear.visible { display: block; }
.search-bar-wrap { position: relative; }

/* ── Search results ── */
.search-count { font-size: 11px; color: var(--muted); margin-bottom: 16px; }
mark { background: #ffb83d33; color: var(--warn); border-radius: 2px; padding: 0 1px; }
.no-results { color: var(--muted); padding: 40px 0; text-align: center; font-size: 13px; }"""

src = src.replace("  --radius:   8px;\n}", NEW_CSS, 1)

# ── 2. HTML: add search bar between .brand and first nav-section ──────────────
OLD_NAV = '  <div class="nav-section">Dimensions</div>'
NEW_NAV = """\
  <div class="search-wrap">
    <div class="search-bar-wrap">
      <input class="search-input" id="search-input" type="text"
             placeholder="Search tags…" oninput="onSearch(this.value)"
             onkeydown="if(event.key==='Escape'){clearSearch()}">
      <button class="search-clear" id="search-clear" onclick="clearSearch()" title="Clear">×</button>
    </div>
  </div>
  <div class="nav-section">Dimensions</div>"""

src = src.replace(OLD_NAV, NEW_NAV, 1)

# ── 3. JS: add search logic before init() ─────────────────────────────────────
OLD_INIT = "async function init() {"
NEW_INIT = """\
// ── Search ───────────────────────────────────────────────────────────────────

function onSearch(q) {
  const btn = document.getElementById('search-clear');
  btn.classList.toggle('visible', q.length > 0);
  if (!q.trim()) { showPage(currentPage); return; }
  renderSearch(q.trim());
}

function clearSearch() {
  const inp = document.getElementById('search-input');
  inp.value = '';
  document.getElementById('search-clear').classList.remove('visible');
  showPage(currentPage);
  inp.focus();
}

function highlight(text, q) {
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  return text.replace(new RegExp(escaped, 'gi'), m => `<mark>${m}</mark>`);
}

function renderSearch(q) {
  // Deactivate nav items during search
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const ql = q.toLowerCase();
  const hits = VOCAB.tags.filter(t =>
    t.shortcode.toLowerCase().includes(ql) ||
    t.label.toLowerCase().includes(ql) ||
    t.obsidian_tag.toLowerCase().includes(ql) ||
    t.subtype.toLowerCase().includes(ql)
  );

  const DIM_COLORS = { entity: 'badge-entity', angle: 'badge-angle', format: 'badge-format' };

  let rows = '';
  if (!hits.length) {
    rows = `<tr><td colspan="7"><div class="no-results">No tags match "${q}"</div></td></tr>`;
  } else {
    hits.forEach(t => {
      const idx = VOCAB.tags.indexOf(t);
      const obsTags = t.obsidian_tag.split(' ').map(o =>
        `<span class="obs-tag">#${highlight(o, q)}</span>`).join('');
      rows += `<tr>
        <td><span class="badge ${DIM_COLORS[t.slot]}">${t.slot}</span></td>
        <td class="icon-cell">${t.icon || '—'}</td>
        <td><span class="code">${highlight(t.shortcode, q)}</span></td>
        <td>${highlight(t.label, q)}</td>
        <td><span class="subtype-pill sp-${t.subtype}">${highlight(t.subtype, q)}</span></td>
        <td><div class="obs-tags">${obsTags}</div></td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="openEdit(${idx})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTag(${idx})">Delete</button>
          </div>
        </td>
      </tr>`;
    });
  }

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Search results</div>
        <div class="page-sub">Searching across all dimensions for <strong>"${q}"</strong></div>
      </div>
      <button class="btn" onclick="clearSearch()">Clear search</button>
    </div>
    <div class="search-count">${hits.length} tag${hits.length !== 1 ? 's' : ''} found</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Dimension</th><th>Icon</th><th>Shortcode</th><th>Label</th>
          <th>Subtype</th><th>Obsidian tags</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function init() {"""

src = src.replace("async function init() {", NEW_INIT, 1)

# ── 4. Verify & write ─────────────────────────────────────────────────────────
checks = [
    ('search CSS',   '.search-input {' in src),
    ('search HTML',  'id="search-input"' in src),
    ('search JS',    'function renderSearch' in src),
    ('onSearch',     'function onSearch' in src),
    ('highlight',    'function highlight' in src),
]
all_ok = True
for name, ok in checks:
    print(f'  {"v" if ok else "x"}  {name}')
    if not ok: all_ok = False

if not all_ok:
    print('  Some checks failed — file NOT written.')
    raise SystemExit(1)

TARGET.write_text(src, encoding='utf-8')
print(f'  v  Written {TARGET}')
Path(__file__).unlink()
print('  v  patch deleted')
print()
print('  Restart vocab-manager.py to pick up the changes.')
