'use strict';
/* ===== IndexedDB: প্রজেক্ট / পাতা / ছবি (blob) ===== */
const DB_NAME = 'smartboard-studio';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('pages', { keyPath: 'id' }).createIndex('pid', 'pid');
      d.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function dbGet(store, key) { const d = await openDB(); return rq(d.transaction(store).objectStore(store).get(key)); }
async function dbAll(store) { const d = await openDB(); return rq(d.transaction(store).objectStore(store).getAll()); }
async function dbPagesOf(pid) { const d = await openDB(); return rq(d.transaction('pages').objectStore('pages').index('pid').getAll(pid)); }

/* ops: [{s:'store', t:'put'|'delete', k?:key, v?:value}] — একই ট্রানজেকশনে */
async function dbBatch(ops) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const tx = d.transaction([...new Set(ops.map(o => o.s))], 'readwrite');
    for (const o of ops) {
      const st = tx.objectStore(o.s);
      if (o.t === 'put') (o.k !== undefined ? st.put(o.v, o.k) : st.put(o.v));
      else st.delete(o.k);
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('tx aborted'));
  });
}

/* প্রজেক্টের সব ডেটা লোড করে মেমরি-মডেল বানায় */
async function loadProject(id) {
  const meta = await dbGet('projects', id);
  if (!meta) return null;
  const rows = await dbPagesOf(id);
  const byId = new Map(rows.map(r => [r.id, r]));
  const pages = [];
  for (const pid of meta.order) {
    const r = byId.get(pid);
    if (!r) continue;
    const blob = (r.type === 'pdf' || r.type === 'img') ? await dbGet('blobs', pid) : null;
    pages.push(mkPage({ ...r, blob, dirty: false, blobDirty: false }));
  }
  if (!pages.length) pages.push(mkPage({ type: 'black' }));
  return { id: meta.id, name: meta.name, pages, cur: clamp(meta.cur || 0, 0, pages.length - 1), deleted: new Set(), created: meta.created };
}

async function deleteProject(id) {
  const rows = await dbPagesOf(id);
  const ops = [{ s: 'projects', t: 'delete', k: id }];
  for (const r of rows) { ops.push({ s: 'pages', t: 'delete', k: r.id }); ops.push({ s: 'blobs', t: 'delete', k: r.id }); }
  await dbBatch(ops);
}
