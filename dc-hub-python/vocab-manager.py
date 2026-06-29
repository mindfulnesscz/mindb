#!/usr/bin/env python3
"""
vocab-manager.py -- dc-hub vocabulary editor
Run:  python3 vocab-manager.py
Opens a local browser UI to edit, add, delete vocabulary tags
and generate shortcode strings with version numbers.
No dependencies beyond the Python standard library.
"""

import json
import re
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

VOCAB_PATH = Path(__file__).parent / "vocabulary.json"
PORT = 7734


def load_vocab():
    with open(VOCAB_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_vocab(data):
    with open(VOCAB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dc-hub · vocabulary</title>
<style>
:root {
  --bg:       #0e0e11;
  --surf:     #17171c;
  --surf2:    #1e1e25;
  --border:   #2a2a35;
  --accent:   #7fff6e;
  --blue:     #3d9bff;
  --warn:     #ffb83d;
  --danger:   #ff5e5e;
  --text:     #e8e8f0;
  --muted:    #6b6b80;
  --radius:   8px;
  --font:     'Courier New', monospace;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: var(--font);
       font-size: 13px; min-height: 100vh; }

/* ── Layout ── */
.shell { display: flex; height: 100vh; overflow: hidden; }
.sidebar { width: 220px; min-width: 220px; background: var(--surf);
           border-right: 1px solid var(--border); display: flex;
           flex-direction: column; overflow-y: auto; }
.main { flex: 1; overflow-y: auto; padding: 28px 32px; }

/* ── Sidebar nav ── */
.brand { padding: 18px 20px 12px; font-size: 15px; font-weight: 700;
         color: var(--accent); letter-spacing: .04em; border-bottom: 1px solid var(--border); }
.brand span { color: var(--muted); font-weight: 400; font-size: 11px;
              display: block; margin-top: 2px; letter-spacing: .06em; }
.nav-section { padding: 14px 20px 6px; font-size: 10px; font-weight: 700;
               color: var(--muted); letter-spacing: .1em; text-transform: uppercase; }
.nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 20px;
            cursor: pointer; color: var(--muted); border-left: 2px solid transparent;
            transition: all .12s; }
.nav-item:hover { color: var(--text); background: var(--surf2); }
.nav-item.active { color: var(--accent); border-left-color: var(--accent);
                   background: var(--surf2); }
.nav-item .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.dot-entity  { background: #7fff6e; }
.dot-angle   { background: #3d9bff; }
.dot-format  { background: #ffb83d; }
.nav-divider { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
.nav-item-gen { color: var(--text); }
.nav-item-gen.active { color: var(--bg); background: var(--accent);
                       border-left-color: var(--accent); }

/* ── Page header ── */
.page-header { display: flex; align-items: center; justify-content: space-between;
               margin-bottom: 24px; }
.page-title { font-size: 18px; font-weight: 700; }
.page-sub { color: var(--muted); font-size: 11px; margin-top: 3px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 20px;
         font-size: 10px; font-weight: 700; letter-spacing: .06em; }
.badge-entity { background: #7fff6e22; color: #7fff6e; }
.badge-angle  { background: #3d9bff22; color: #3d9bff; }
.badge-format { background: #ffb83d22; color: #ffb83d; }

/* ── Table ── */
.tbl-wrap { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th { background: var(--surf2); color: var(--muted); font-size: 10px; font-weight: 700;
     letter-spacing: .08em; text-transform: uppercase; padding: 10px 14px;
     text-align: left; border-bottom: 1px solid var(--border); }
td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: var(--surf2); }
.code { font-family: var(--font); background: var(--surf2); border: 1px solid var(--border);
        border-radius: 4px; padding: 2px 7px; font-size: 12px; }
.obs-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.obs-tag { background: var(--surf2); border: 1px solid var(--border); border-radius: 20px;
           padding: 1px 7px; font-size: 11px; color: var(--muted); }
.subtype-pill { padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 600; }
.sp-company  { background:#7fff6e18; color:#7fff6e; }
.sp-product  { background:#3d9bff18; color:#3d9bff; }
.sp-customer { background:#ff9f3d18; color:#ff9f3d; }
.sp-partner  { background:#d97fff18; color:#d97fff; }
.sp-event    { background:#ff5e5e18; color:#ff5e5e; }
.sp-sales-mktg { background:#3d9bff18; color:#3d9bff; }
.sp-content    { background:#7fff6e18; color:#7fff6e; }
.sp-context    { background:#ffb83d18; color:#ffb83d; }
.sp-document   { background:#3d9bff18; color:#3d9bff; }
.sp-media      { background:#7fff6e18; color:#7fff6e; }
.sp-image-var  { background:#ffb83d18; color:#ffb83d; }
.icon-cell { font-size: 16px; }

/* ── Buttons ── */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
       border-radius: var(--radius); border: 1px solid var(--border); background: transparent;
       color: var(--text); font-family: var(--font); font-size: 12px;
       cursor: pointer; transition: all .12s; }
.btn:hover { background: var(--surf2); border-color: var(--muted); }
.btn-primary { background: var(--accent); border-color: var(--accent);
               color: #000; font-weight: 700; }
.btn-primary:hover { background: #9fffb0; border-color: #9fffb0; }
.btn-danger  { color: var(--danger); border-color: var(--danger); }
.btn-danger:hover { background: #ff5e5e22; }
.btn-sm { padding: 4px 8px; font-size: 11px; }
.btn-group { display: flex; gap: 6px; }

/* ── Subtable grouping ── */
.group-header td { background: var(--surf); color: var(--muted); font-size: 10px;
                   font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
                   padding: 6px 14px; }

/* ── Modal ── */
.modal-bg { position: fixed; inset: 0; background: #0009; display: flex;
            align-items: center; justify-content: center; z-index: 100;
            opacity: 0; pointer-events: none; transition: opacity .15s; }
.modal-bg.open { opacity: 1; pointer-events: all; }
.modal { background: var(--surf); border: 1px solid var(--border);
         border-radius: 12px; width: 480px; max-width: 96vw; overflow: hidden; }
.modal-head { padding: 18px 20px; border-bottom: 1px solid var(--border);
              font-weight: 700; font-size: 14px; display: flex;
              justify-content: space-between; align-items: center; }
.modal-close { background: none; border: none; color: var(--muted); font-size: 18px;
               cursor: pointer; padding: 0 4px; line-height: 1; }
.modal-close:hover { color: var(--text); }
.modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.modal-foot { padding: 14px 20px; border-top: 1px solid var(--border);
              display: flex; justify-content: flex-end; gap: 8px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: 11px; color: var(--muted); font-weight: 700;
               letter-spacing: .06em; text-transform: uppercase; }
.field input, .field select { background: var(--surf2); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-family: var(--font);
  font-size: 13px; padding: 8px 10px; width: 100%; outline: none; }
.field input:focus, .field select:focus { border-color: var(--blue); }
.field .hint { font-size: 11px; color: var(--muted); }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }

/* ── Generator ── */
.gen-wrap { display: flex; flex-direction: column; gap: 24px; }
.gen-dims { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
.dim-panel { background: var(--surf); border: 1px solid var(--border);
             border-radius: var(--radius); overflow: hidden; }
.dim-head { padding: 10px 14px; font-size: 10px; font-weight: 700;
            letter-spacing: .1em; text-transform: uppercase;
            border-bottom: 1px solid var(--border); }
.dim-head-entity { color: #7fff6e; background: #7fff6e0a; }
.dim-head-angle  { color: #3d9bff; background: #3d9bff0a; }
.dim-head-format { color: #ffb83d; background: #ffb83d0a; }
.dim-subgroup { padding: 8px 0 2px 14px; font-size: 9px; font-weight: 700;
                color: var(--muted); letter-spacing: .1em; text-transform: uppercase; }
.dim-tag { display: flex; align-items: center; gap: 8px; padding: 6px 14px;
           cursor: pointer; transition: background .1s; }
.dim-tag:hover { background: var(--surf2); }
.dim-tag.selected { background: var(--surf2); }
.dim-tag.selected .dim-check { border-color: var(--accent); background: var(--accent); }
.dim-check { width: 14px; height: 14px; border: 1px solid var(--border); border-radius: 3px;
             flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.dim-check svg { display: none; }
.dim-tag.selected .dim-check svg { display: block; }
.dim-label { flex: 1; }
.dim-code { font-size: 10px; color: var(--muted); }

.result-box { background: var(--surf); border: 1px solid var(--border);
              border-radius: var(--radius); padding: 20px; }
.result-label { font-size: 10px; color: var(--muted); font-weight: 700;
                letter-spacing: .1em; text-transform: uppercase; margin-bottom: 12px; }
.result-code { font-size: 20px; font-weight: 700; color: var(--text);
               font-family: var(--font); word-break: break-all;
               min-height: 30px; margin-bottom: 16px; }
.result-code .seg-entity { color: #7fff6e; }
.result-code .seg-angle  { color: #3d9bff; }
.result-code .seg-format { color: #ffb83d; }
.result-code .seg-desc   { color: var(--muted); }
.result-code .seg-ver    { color: var(--text); }
.result-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.ver-inputs { display: flex; gap: 6px; align-items: center; }
.ver-inputs input { width: 52px; background: var(--surf2); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-family: var(--font);
  font-size: 13px; padding: 6px 8px; text-align: center; outline: none; }
.ver-inputs input:focus { border-color: var(--blue); }
.ver-sep { color: var(--muted); }
.desc-input { flex: 1; min-width: 160px; background: var(--surf2); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-family: var(--font);
  font-size: 13px; padding: 6px 10px; outline: none; }
.desc-input:focus { border-color: var(--blue); }
.obs-preview { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.obs-preview-label { font-size: 10px; color: var(--muted); margin-bottom: 6px;
                     letter-spacing: .08em; text-transform: uppercase; }
.obs-preview-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.obs-preview-tag  { background: var(--surf2); border: 1px solid var(--border);
                    border-radius: 20px; padding: 2px 8px; font-size: 11px; color: var(--muted); }

/* ── Toast ── */
.toast { position: fixed; bottom: 24px; right: 24px; background: var(--surf);
         border: 1px solid var(--border); border-radius: var(--radius);
         padding: 10px 16px; font-size: 12px; opacity: 0; transform: translateY(8px);
         transition: all .2s; pointer-events: none; z-index: 200; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.ok   { border-color: var(--accent); color: var(--accent); }
.toast.err  { border-color: var(--danger); color: var(--danger); }
</style>
</head>
<body>
<div class="shell">

<!-- Sidebar -->
<nav class="sidebar">
  <div class="brand">dc-hub <span>vocabulary manager</span></div>
  <div class="nav-section">Dimensions</div>
  <div class="nav-item active" data-page="entity" onclick="showPage('entity')">
    <div class="dot dot-entity"></div>Entity
  </div>
  <div class="nav-item" data-page="angle" onclick="showPage('angle')">
    <div class="dot dot-angle"></div>Angle
  </div>
  <div class="nav-item" data-page="format" onclick="showPage('format')">
    <div class="dot dot-format"></div>Format
  </div>
  <hr class="nav-divider">
  <div class="nav-section">Tools</div>
  <div class="nav-item nav-item-gen" data-page="generator" onclick="showPage('generator')">
    <div class="dot" style="background:var(--text)"></div>Shortcode generator
  </div>
</nav>

<!-- Main -->
<main class="main" id="main"></main>
</div>

<!-- Modal -->
<div class="modal-bg" id="modal-bg">
  <div class="modal">
    <div class="modal-head">
      <span id="modal-title">Add tag</span>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="modal-save" onclick="saveModal()">Save</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
let VOCAB = null;
let currentPage = 'entity';
let modalMode = null; // 'add' | 'edit'
let modalSlot = null;
let editIndex = null;

const SUBTYPES = {
  entity:  ['company','product','customer','partner','event'],
  angle:   ['sales-mktg','content','context'],
  format:  ['document','media','image-var'],
};
const PREFIXES = {
  company: '', product: 'p-', customer: 'c-', partner: 'x-', event: 'e-',
};
const DIM_LABELS = { entity: 'Entity', angle: 'Angle', format: 'Format' };

async function init() {
  const r = await fetch('/api/vocab');
  VOCAB = await r.json();
  showPage('entity');
}

function showPage(p) {
  currentPage = p;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === p);
  });
  const main = document.getElementById('main');
  if (p === 'generator') { renderGenerator(main); return; }
  renderDimension(main, p);
}

// ── Dimension page ──────────────────────────────────────────────────────────

function renderDimension(main, slot) {
  const tags = VOCAB.tags.filter(t => t.slot === slot);
  const subtypes = SUBTYPES[slot];
  const dim = DIM_LABELS[slot];
  const badgeCls = `badge-${slot}`;

  let rows = '';
  subtypes.forEach(sub => {
    const group = tags.filter(t => t.subtype === sub);
    if (!group.length) return;
    rows += `<tr class="group-header"><td colspan="6">${sub}</td></tr>`;
    group.forEach(t => {
      const idx = VOCAB.tags.indexOf(t);
      const obsTags = t.obsidian_tag.split(' ').map(o =>
        `<span class="obs-tag">#${o}</span>`).join('');
      rows += `<tr>
        <td class="icon-cell">${t.icon || '—'}</td>
        <td><span class="code">${t.shortcode}</span></td>
        <td>${t.label}</td>
        <td><span class="subtype-pill sp-${sub}">${sub}</span></td>
        <td><div class="obs-tags">${obsTags}</div></td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="openEdit(${idx})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTag(${idx})">Delete</button>
          </div>
        </td>
      </tr>`;
    });
  });

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${dim} <span class="badge ${badgeCls}">${tags.length} tags</span></div>
        <div class="page-sub">Tags that answer "what is this asset about?"</div>
      </div>
      <button class="btn btn-primary" onclick="openAdd('${slot}')">+ Add tag</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Icon</th><th>Shortcode</th><th>Label</th>
          <th>Subtype</th><th>Obsidian tags</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Modal ────────────────────────────────────────────────────────────────────

function buildModalBody(slot, tag) {
  const subtypes = SUBTYPES[slot];
  const subOpts = subtypes.map(s =>
    `<option value="${s}" ${tag && tag.subtype===s ? 'selected' : ''}>${s}</option>`
  ).join('');

  const prefixHint = slot === 'entity'
    ? '<div class="hint">Entity prefix rules: p- product, c- customer, x- partner, e- event, ESS (no prefix)</div>'
    : '<div class="hint">Use CamelCase, 3-5 chars. No prefix needed.</div>';

  const obsHint = '<div class="hint">Space-separated Obsidian tags. First = most specific. e.g. "banner print" → #banner + #print</div>';

  return `
    <div class="field-row">
      <div class="field">
        <label>Shortcode</label>
        <input id="f-shortcode" value="${tag ? tag.shortcode : ''}" placeholder="e.g. p-New">
        ${prefixHint}
      </div>
      <div class="field">
        <label>Icon <span style="color:var(--muted);font-weight:400">(optional)</span></label>
        <input id="f-icon" value="${tag ? tag.icon : ''}" placeholder="🎪">
      </div>
    </div>
    <div class="field">
      <label>Label</label>
      <input id="f-label" value="${tag ? tag.label : ''}" placeholder="Human-readable name">
    </div>
    <div class="field">
      <label>Subtype</label>
      <select id="f-subtype">${subOpts}</select>
    </div>
    <div class="field">
      <label>Obsidian tags</label>
      <input id="f-obsidian" value="${tag ? tag.obsidian_tag : ''}" placeholder="e.g. banner print">
      ${obsHint}
    </div>`;
}

function openAdd(slot) {
  modalMode = 'add'; modalSlot = slot; editIndex = null;
  document.getElementById('modal-title').textContent = `Add ${DIM_LABELS[slot]} tag`;
  document.getElementById('modal-body').innerHTML = buildModalBody(slot, null);
  document.getElementById('modal-bg').classList.add('open');
}

function openEdit(idx) {
  const tag = VOCAB.tags[idx];
  modalMode = 'edit'; modalSlot = tag.slot; editIndex = idx;
  document.getElementById('modal-title').textContent = `Edit — ${tag.shortcode}`;
  document.getElementById('modal-body').innerHTML = buildModalBody(tag.slot, tag);
  document.getElementById('modal-bg').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
}

async function saveModal() {
  const sc = document.getElementById('f-shortcode').value.trim();
  const label = document.getElementById('f-label').value.trim();
  const subtype = document.getElementById('f-subtype').value;
  const obsidian = document.getElementById('f-obsidian').value.trim();
  const icon = document.getElementById('f-icon').value.trim();

  if (!sc || !label || !obsidian) { toast('Fill in shortcode, label and obsidian tags', 'err'); return; }

  // Duplicate check (skip self on edit)
  const dup = VOCAB.tags.find((t, i) => t.shortcode === sc && i !== editIndex);
  if (dup) { toast(`Shortcode "${sc}" already exists`, 'err'); return; }

  const entry = { shortcode: sc, slot: modalSlot, subtype, label, obsidian_tag: obsidian, icon };

  if (modalMode === 'add') {
    VOCAB.tags.push(entry);
  } else {
    VOCAB.tags[editIndex] = entry;
  }

  await persist();
  closeModal();
  showPage(currentPage);
  toast(modalMode === 'add' ? `Added ${sc}` : `Saved ${sc}`, 'ok');
}

async function deleteTag(idx) {
  const tag = VOCAB.tags[idx];
  if (!confirm(`Delete "${tag.shortcode} — ${tag.label}"?\nThis cannot be undone.`)) return;
  VOCAB.tags.splice(idx, 1);
  await persist();
  showPage(currentPage);
  toast(`Deleted ${tag.shortcode}`, 'ok');
}

// ── Generator ────────────────────────────────────────────────────────────────

function renderGenerator(main) {
  const dims = ['entity', 'angle', 'format'];
  const colors = { entity: '#7fff6e', angle: '#3d9bff', format: '#ffb83d' };

  let panels = '';
  dims.forEach(dim => {
    const subtypes = SUBTYPES[dim];
    let inner = '';
    subtypes.forEach(sub => {
      const group = VOCAB.tags.filter(t => t.slot === dim && t.subtype === sub);
      if (!group.length) return;
      inner += `<div class="dim-subgroup">${sub}</div>`;
      group.forEach(t => {
        inner += `<div class="dim-tag" id="dt-${t.shortcode}" onclick="toggleTag('${t.shortcode}','${dim}')">
          <div class="dim-check">
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
              <path d="M1 4l3 3 5-6" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="dim-label">${t.icon ? t.icon + ' ' : ''}${t.label}</div>
          <div class="dim-code">${t.shortcode}</div>
        </div>`;
      });
    });

    panels += `<div class="dim-panel">
      <div class="dim-head dim-head-${dim}">${DIM_LABELS[dim]}</div>
      ${inner}
    </div>`;
  });

  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Shortcode generator</div>
        <div class="page-sub">Select tags across dimensions, add description and version</div>
      </div>
      <button class="btn" onclick="clearGen()">Clear all</button>
    </div>
    <div class="gen-wrap">
      <div class="gen-dims">${panels}</div>
      <div class="result-box">
        <div class="result-label">Generated shortcode</div>
        <div class="result-code" id="gen-result">—</div>
        <div class="result-controls">
          <input class="desc-input" id="gen-desc" placeholder="Description (optional)" oninput="updateGen()">
          <div class="ver-inputs">
            <span class="ver-sep" style="color:var(--muted);font-size:12px">v</span>
            <input id="ver-maj" type="number" min="0" value="" placeholder="1" oninput="updateGen()">
            <span class="ver-sep">-</span>
            <input id="ver-min" type="number" min="0" value="" placeholder="0" oninput="updateGen()">
            <span class="ver-sep">-</span>
            <input id="ver-pat" type="number" min="0" value="" placeholder="0" oninput="updateGen()">
          </div>
          <button class="btn btn-primary" id="copy-btn" onclick="copyGen()">Copy</button>
        </div>
        <div class="obs-preview">
          <div class="obs-preview-label">Obsidian tags that will be generated</div>
          <div class="obs-preview-tags" id="gen-obs"></div>
        </div>
      </div>
    </div>`;

  genState = {};
  updateGen();
}

let genState = {}; // shortcode -> slot

function toggleTag(sc, slot) {
  const el = document.getElementById('dt-' + sc);
  if (genState[sc]) {
    delete genState[sc];
    el.classList.remove('selected');
  } else {
    genState[sc] = slot;
    el.classList.add('selected');
  }
  updateGen();
}

function clearGen() {
  genState = {};
  document.querySelectorAll('.dim-tag.selected').forEach(e => e.classList.remove('selected'));
  document.getElementById('gen-desc').value = '';
  document.getElementById('ver-maj').value = '';
  document.getElementById('ver-min').value = '';
  document.getElementById('ver-pat').value = '';
  updateGen();
}

function updateGen() {
  const order = ['entity','angle','format'];
  // Sort selected tags: by dimension order, then by position in vocab
  const selected = Object.keys(genState).sort((a, b) => {
    const ai = order.indexOf(genState[a]);
    const bi = order.indexOf(genState[b]);
    if (ai !== bi) return ai - bi;
    return VOCAB.tags.findIndex(t=>t.shortcode===a) - VOCAB.tags.findIndex(t=>t.shortcode===b);
  });

  const desc = document.getElementById('gen-desc')?.value.trim() || '';
  const maj = document.getElementById('ver-maj')?.value;
  const min = document.getElementById('ver-min')?.value;
  const pat = document.getElementById('ver-pat')?.value;
  const hasVer = maj !== '';

  // Build colored HTML
  let html = '';
  if (!selected.length) { html = '<span style="color:var(--muted)">select tags below</span>'; }
  else {
    selected.forEach(sc => {
      const slot = genState[sc];
      html += `<span class="seg-${slot}">(${sc})</span>`;
    });
    if (desc) html += `<span class="seg-desc"> ${desc}</span>`;
    if (hasVer) {
      const v = `v${maj||'1'}-${min||'0'}-${pat||'0'}`;
      html += `<span class="seg-ver"> ${v}</span>`;
    }
  }
  document.getElementById('gen-result').innerHTML = html;

  // Obsidian tags
  const obsSet = [];
  selected.forEach(sc => {
    const entry = VOCAB.tags.find(t => t.shortcode === sc);
    if (!entry) return;
    entry.obsidian_tag.split(' ').forEach(o => {
      if (!obsSet.includes(o)) obsSet.push(o);
    });
  });
  obsSet.push('dam');
  const obsTags = document.getElementById('gen-obs');
  if (obsTags) {
    obsTags.innerHTML = obsSet.map(o => `<span class="obs-preview-tag">#${o}</span>`).join('');
  }
}

function copyGen() {
  const order = ['entity','angle','format'];
  const selected = Object.keys(genState).sort((a, b) => {
    const ai = order.indexOf(genState[a]);
    const bi = order.indexOf(genState[b]);
    if (ai !== bi) return ai - bi;
    return VOCAB.tags.findIndex(t=>t.shortcode===a) - VOCAB.tags.findIndex(t=>t.shortcode===b);
  });
  if (!selected.length) { toast('Select at least one tag', 'err'); return; }

  const desc = document.getElementById('gen-desc')?.value.trim() || '';
  const maj = document.getElementById('ver-maj')?.value;
  const min = document.getElementById('ver-min')?.value;
  const pat = document.getElementById('ver-pat')?.value;
  const hasVer = maj !== '';

  let code = selected.map(sc => `(${sc})`).join('');
  if (desc) code += ` ${desc}`;
  if (hasVer) code += ` v${maj||'1'}-${min||'0'}-${pat||'0'}`;

  navigator.clipboard.writeText(code).then(() => toast('Copied!', 'ok'));
}

// ── Persist ──────────────────────────────────────────────────────────────────

async function persist() {
  const r = await fetch('/api/vocab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VOCAB),
  });
  if (!r.ok) toast('Save failed', 'err');
}

// ── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── Close modal on bg click ──────────────────────────────────────────────────
document.getElementById('modal-bg').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

init();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # suppress server noise

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/" or path == "":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML.encode("utf-8"))
        elif path == "/api/vocab":
            data = load_vocab()
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/vocab":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                save_vocab(data)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()


def main():
    server = HTTPServer(("localhost", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"  vocab-manager running at {url}")
    print(f"  editing: {VOCAB_PATH}")
    print(f"  press Ctrl+C to stop\n")
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")


if __name__ == "__main__":
    main()
