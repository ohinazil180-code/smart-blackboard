'use strict';
/* ===== ছোট ইউটিলিটি ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

function icon(name, cls) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'ic ' + (cls || ''));
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ===== মোডাল ডায়ালগ ===== */
function modal({ title, body, buttons, cls, dismiss = true }) {
  return new Promise(res => {
    const root = $('#modal');
    $('.card', root).className = 'card ' + (cls || '');
    $('#mTitle').textContent = title || '';
    const bodies = (Array.isArray(body) ? body : [body]).filter(Boolean);
    $('#mBody').replaceChildren(...bodies.map(x => (typeof x === 'string' ? h('p', {}, x) : x)));
    const btns = $('#mBtns');
    btns.replaceChildren();
    const close = v => { root.hidden = true; root.onclick = null; res(v); };
    for (const b of buttons || [{ text: 'ঠিক আছে', val: true, cls: 'pri' }]) {
      btns.append(h('button', {
        class: 'btn ' + (b.cls || ''),
        onclick: () => (b.act ? b.act(close) : close(b.val))
      }, b.icon ? icon(b.icon) : null, b.text));
    }
    root.hidden = false;
    root.onclick = e => { if (e.target === root && dismiss) close(null); };
    modal.close = close;
  });
}
const confirmBox = (msg, ok = 'হ্যাঁ') => modal({
  title: 'নিশ্চিত করুন', body: msg,
  buttons: [{ text: 'বাতিল', val: false }, { text: ok, val: true, cls: 'pri' }]
}).then(v => v === true);

async function askText(title, value = '', placeholder = '') {
  const inp = h('input', { type: 'text', class: 'inp', value, placeholder, maxlength: 80 });
  const p = modal({
    title, body: inp,
    buttons: [{ text: 'বাতিল', val: null }, { text: 'ঠিক আছে', cls: 'pri', act: c => c(inp.value.trim()) }]
  });
  setTimeout(() => { inp.focus(); inp.select(); }, 80);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') modal.close(inp.value.trim()); });
  const v = await p;
  return v === null || v === '' ? null : v;
}

/* ===== ব্যস্ততা ওভারলে ===== */
let busyCancel = null;
function busy(msg, pct, onCancel) {
  const b = $('#busy');
  b.hidden = false;
  $('#busyMsg').textContent = msg;
  const bar = $('#busyBar');
  bar.style.width = (pct == null ? 0 : Math.round(pct * 100)) + '%';
  bar.parentElement.style.visibility = pct == null ? 'hidden' : 'visible';
  busyCancel = onCancel || null;
  $('#busyCancel').hidden = !onCancel;
}
const busyOff = () => { $('#busy').hidden = true; busyCancel = null; };

function canvasToBlob(c, type = 'image/jpeg', q = 0.9) {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob ব্যর্থ'))), type, q));
}
function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'note';
function blobToDataURL(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }
const absURL = p => new URL(p, location.href).href;
