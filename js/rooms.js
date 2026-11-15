'use strict';
/* =====================================================================
   রোল, রুম ও গ্রুপ (সার্ভার-সংযুক্ত), ক্লাস টাইমার, অ্যাপ ইনস্টল
   — কোনো লগইন নেই। রোল ব্যবহারকারী নিজে যেকোনো সময় বদলায়।
   — রুম/গ্রুপ/সদস্য সার্ভারে থাকে, সব ডিভাইসে রিয়েল-টাইমে আপডেট হয়।
   — বোর্ড (লেখা) এই ধাপে এখনো লোকাল; বোর্ড সিঙ্ক পরের ধাপ।
   ===================================================================== */

const LS = {
  role: 'sb.role', name: 'sb.name', mem: 'sb.mem.v2', cur: 'sb.cur.v2', recent: 'sb.recent.v2'
};
const rm = {
  role: null,          // 'teacher' | 'student' | null
  name: '',
  cur: null,           // বর্তমান রুমের কোড
  mem: {},             // code -> memberId (এই ডিভাইসের পরিচয়)
  views: {},           // code -> সার্ভার থেকে পাওয়া রুম-দৃশ্য
  recent: [],          // জানা রুমের কোডের তালিকা
  es: null, esCode: null,
  streamGeneration: 0, streamRetryTimer: null, streamAttempt: 0,
  authUser: null, authUnavailable: false,
  online: true
};
let rmTimer = null;
const rmBC = ('BroadcastChannel' in window) ? new BroadcastChannel('sb-rooms') : null;

/* ---------- স্টোরেজ ---------- */
function rmLoad() {
  try {
    rm.role = localStorage.getItem(LS.role);
    rm.name = localStorage.getItem(LS.name) || '';
    rm.mem = JSON.parse(localStorage.getItem(LS.mem) || '{}') || {};
    rm.cur = localStorage.getItem(LS.cur);
    rm.recent = JSON.parse(localStorage.getItem(LS.recent) || '[]') || [];
  } catch (_) { }
}
function rmPersist() {
  try {
    if (rm.role) localStorage.setItem(LS.role, rm.role);
    localStorage.setItem(LS.name, rm.name);
    localStorage.setItem(LS.mem, JSON.stringify(rm.mem));
    if (rm.cur) localStorage.setItem(LS.cur, rm.cur); else localStorage.removeItem(LS.cur);
    localStorage.setItem(LS.recent, JSON.stringify(rm.recent));
  } catch (_) { toast('স্টোরেজ পূর্ণ — ব্যাকআপ নিন'); }
}
const curView = () => (rm.cur && rm.views[rm.cur]) || null;
const isOwner = v => !!(v && v.you && v.you.isOwner);
const roleName = r => r === 'teacher' ? 'শিক্ষক' : r === 'student' ? 'শিক্ষার্থী' : 'বেছে নেওয়া হয়নি';

/* ---------- API ---------- */
async function api(path, body) {
  const session = await ensureRoomAuth();
  if (!session) throw new Error('ক্লাস ফিচার ব্যবহারের জন্য সাইন ইন করুন।');
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
  } catch (_) {
    rm.online = false; throw new Error('সার্ভারে সংযোগ নেই। ইন্টারনেট দেখুন।');
  }
  rm.online = true;
  let data = {};
  try { data = await res.json(); } catch (_) { }
  if (!res.ok) throw new Error(data.error || `ত্রুটি (${res.status})`);
  return data;
}

/* ---------- রুম-দৃশ্য ও স্ট্রিম ---------- */
function setView(v) {
  if (!v) return;
  rm.views[v.code] = v;
  if (!rm.recent.includes(v.code)) rm.recent.unshift(v.code);
  rm.recent = rm.recent.slice(0, 20);
  rmPersist();
  if (rmBC) rmBC.postMessage(v.code);
  rmRefresh();
}
async function openStream(code) {
  if (!rm.mem[code]) return;
  if (rm.esCode === code && rm.es && rm.es.readyState !== EventSource.CLOSED) return;
  closeStream();
  const generation = rm.streamGeneration;
  try {
    const { ticket } = await api(`/api/rooms/${encodeURIComponent(code)}/stream-ticket`, { memberId: rm.mem[code] });
    if (generation !== rm.streamGeneration || rm.cur !== code) return;
    const es = new EventSource(`/api/rooms/${encodeURIComponent(code)}/stream?t=${encodeURIComponent(ticket)}`);
    rm.es = es; rm.esCode = code;
    es.onopen = () => { rm.streamAttempt = 0; };
    es.addEventListener('state', e => {
      try { rm.views[code] = JSON.parse(e.data); rmRefresh(); } catch (_) { }
    });
    es.addEventListener('board', e => {
      try { rmOnBoard(code, JSON.parse(e.data)); } catch (_) { }
    });
    es.onerror = () => {
      if (rm.es !== es) return;
      es.close(); rm.es = null; rm.esCode = null;
      scheduleStreamReconnect(code, generation);
    };
  } catch (error) {
    if (generation === rm.streamGeneration && rm.cur === code) scheduleStreamReconnect(code, generation);
    if (!rm.authUser) toast('সাইন ইন করে আবার ক্লাসে যুক্ত হন।', 3500);
  }
}
function scheduleStreamReconnect(code, generation) {
  if (generation !== rm.streamGeneration || rm.cur !== code || rm.streamRetryTimer) return;
  rm.streamAttempt = Math.min(rm.streamAttempt + 1, 6);
  const delay = Math.min(30_000, 1000 * 2 ** (rm.streamAttempt - 1));
  rm.streamRetryTimer = setTimeout(() => {
    rm.streamRetryTimer = null;
    openStream(code);
  }, delay);
}
function closeStream() {
  rm.streamGeneration++;
  clearTimeout(rm.streamRetryTimer);
  rm.streamRetryTimer = null;
  if (rm.es) rm.es.close();
  rm.es = null; rm.esCode = null;
}
async function ensureRoomAuth() {
  try {
    const auth = await window.sbAuthReady;
    const current = await auth.getSession();
    if (current) { rm.authUser = current.user; return current; }
    const name = h('input', { class: 'inp', type: 'text', maxlength: 60, autocomplete: 'name', placeholder: 'আপনার নাম' });
    const email = h('input', { class: 'inp', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@example.com' });
    const password = h('input', { class: 'inp', type: 'password', required: true, autocomplete: 'current-password', placeholder: 'কমপক্ষে ৮ অক্ষর' });
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const field = (label, input) => h('label', { class: 'rm-auth-field' }, h('span', {}, label), input);
    const body = h('div', { class: 'rm-auth-form' }, field('নাম (নতুন অ্যাকাউন্টে)', name), field('ইমেইল', email), field('পাসওয়ার্ড', password), status);
    const result = await modal({
      title: 'অনলাইন ক্লাসে সাইন ইন',
      body,
      buttons: [
        { text: 'বাতিল', val: null },
        { text: 'সাইন ইন', act: close => submit(false, close) },
        { text: 'অ্যাকাউন্ট তৈরি', cls: 'pri', act: close => submit(true, close) }
      ]
    });
    if (!result) return null;
    rm.authUser = result.user;
    if (result.user?.name && !rm.name) { rm.name = result.user.name; rmPersist(); }
    renderRmStatus();
    return result;

    async function submit(createAccount, close) {
      if (!email.reportValidity() || !password.reportValidity()) return;
      if (createAccount && !name.value.trim()) { status.textContent = 'নতুন অ্যাকাউন্টে আপনার নাম লিখুন।'; name.focus(); return; }
      status.textContent = 'যাচাই করা হচ্ছে…';
      try {
        const response = createAccount
          ? await auth.signUp({ email: email.value.trim(), password: password.value, name: name.value.trim() })
          : await auth.signIn({ email: email.value.trim(), password: password.value });
        if (response.error) { status.textContent = 'সাইন ইন করা যায়নি। তথ্য যাচাই করে আবার চেষ্টা করুন।'; return; }
        const session = await auth.getSession();
        if (!session) { status.textContent = 'অ্যাকাউন্ট তৈরি হয়েছে, কিন্তু সেশন পাওয়া যায়নি। আবার সাইন ইন করুন।'; return; }
        close(session);
      } catch {
        status.textContent = 'সাইন-ইন পরিষেবা এখন পাওয়া যাচ্ছে না। আবার চেষ্টা করুন।';
      }
    }
  } catch {
    rm.authUnavailable = true;
    toast('সাইন-ইন পরিষেবা এখন পাওয়া যাচ্ছে না।', 3500);
    return null;
  }
}
async function roomSignOut() {
  try {
    const auth = await window.sbAuthReady;
    await auth.signOut();
    rm.authUser = null; rm.cur = null; rm.views = {};
    closeStream(); rmPersist(); renderRmStatus();
    toast('সাইন আউট হয়েছে');
  } catch { toast('সাইন আউট করা যায়নি। আবার চেষ্টা করুন।'); }
}
window.addEventListener('sb-auth-state', event => {
  rm.authUser = event.detail?.user || null;
  rm.authUnavailable = !!event.detail?.unavailable;
  if (rm.authUser?.name && !rm.name) { rm.name = rm.authUser.name; rmPersist(); }
  renderRmStatus();
});
function rmRefresh() {
  if (rmLiveCode && (rm.cur !== rmLiveCode || rm.role !== 'student')) rmEndLive();
  renderRmStatus();
  if (rmRefresh.groupsDraw) rmRefresh.groupsDraw();
  if (rmRefresh.micDraw) rmRefresh.micDraw();
}

async function rmAct(body) {
  const v = curView();
  if (!v) return toast('আগে একটি রুম বেছে নিন');
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(v.code)}/act`, { memberId: rm.mem[v.code], ...body });
    if (r.room) setView(r.room);
    return true;
  } catch (e) { toast(e.message, 3500); return false; }
}

/* ---------- মেনু স্ট্যাটাস বক্স ---------- */
function renderRmStatus() {
  const box = $('#rmStatus'); if (!box) return;
  const v = curView();
  box.replaceChildren(
    h('div', { class: 'rm-line' }, h('b', {}, 'অ্যাকাউন্ট: '), rm.authUser?.email || (rm.authUnavailable ? 'সাইন-ইন পরিষেবা অনুপলব্ধ' : 'সাইন ইন আবশ্যক')),
    h('div', { class: 'rm-line' }, h('b', {}, 'রোল: '), roleName(rm.role)),
    h('div', { class: 'rm-line' }, h('b', {}, 'রুম: '),
      v ? `${v.name} (${v.code})${v.status === 'ended' ? ' — শেষ' : ''}` : 'কোনো রুম নেই'),
    v && v.you && v.you.groupId ? h('div', { class: 'rm-line' }, h('b', {}, 'গ্রুপ: '), (v.groups.find(g => g.id === v.you.groupId) || {}).name || '—') : null,
    h('div', { class: 'rm-line' }, h('small', {}, rm.online ? '● সার্ভার সংযুক্ত' : '○ সার্ভারে সংযোগ নেই')),
    h('button', { class: 'chip', onclick: () => rm.authUser ? roomSignOut() : ensureRoomAuth() }, rm.authUser ? 'সাইন আউট' : 'সাইন ইন / অ্যাকাউন্ট তৈরি'),
    h('button', { class: 'chip', onclick: () => { closeUI(); roleDialog(); } }, 'রোল বদলান')
  );
}

/* ---------- রোল ---------- */
async function roleDialog() {
  const pick = await modal({
    title: 'আপনার রোল',
    body: 'আপনি কোন রোলে আছেন? এটি যেকোনো সময় বদলানো যাবে। কোনো লগইন লাগবে না।',
    buttons: [
      { text: 'শিক্ষার্থী', val: 'student', icon: 'share' },
      { text: 'শিক্ষক', val: 'teacher', cls: 'pri', icon: 'board' },
      { text: 'বাতিল', val: null }
    ]
  });
  if (!pick) return;
  if (pick === rm.role) return toast('আপনি ইতিমধ্যে এই রোলে আছেন');
  rm.role = pick; rmPersist();
  document.body.dataset.role = pick;
  // রুমে থাকলে সার্ভারেও জানানো (মালিক নিজের রোল বদলাতে পারবে না)
  const v = curView();
  if (v && rm.mem[v.code] && !isOwner(v)) await rmAct({ type: 'self.role', role: pick });
  renderRmStatus();
  toast(`রোল: ${roleName(pick)}`);
  if (pick === 'student' && !curView()) toast('রুমে যোগ দিতে মেনু থেকে "রুমে যোগ দিন" বেছে নিন');
}
function requireTeacher() {
  if (rm.role === 'teacher') return true;
  toast('এই কাজ শিক্ষক রোলে করা যাবে — রোল বদলান');
  return false;
}
async function askName() {
  if (rm.name) return rm.name;
  const n = await askText('আপনার নাম (রুমে এই নামে দেখাবে)');
  if (n) { rm.name = n; rmPersist(); }
  return n || null;
}

/* ---------- রুম তৈরি ---------- */
async function roomCreate() {
  if (!requireTeacher()) return;
  const name = await askText('রুমের নাম (যেমন: ইংরেজি ব্যাচ-১)');
  if (!name) return;
  const who = await askName() || 'শিক্ষক';
  try {
    const r = await api('/api/rooms', { name, memberName: who });
    rm.mem[r.room.code] = r.memberId; rm.cur = r.room.code;
    setView(r.room);
    openStream(r.room.code);
    rmPersist();
    await modal({
      title: 'রুম তৈরি হয়েছে',
      body: [h('p', {}, 'এই কোডটি শিক্ষার্থীদের দিন:'), h('div', { class: 'rm-code' }, r.room.code),
        h('p', { class: 'hint' }, 'শিক্ষার্থীরা মেনু → "রুমে যোগ দিন" থেকে যেকোনো জায়গা থেকে এই কোড দিয়ে ঢুকবে।')],
      buttons: [{ text: 'কোড কপি', icon: 'copy', act: c => { navigator.clipboard?.writeText(r.room.code).then(() => toast('কোড কপি হয়েছে')).catch(() => toast('কপি করা যায়নি')); c(true); } },
        { text: 'ঠিক আছে', val: true, cls: 'pri' }]
    });
  } catch (e) { toast(e.message, 4000); }
}

/* ---------- রুমে যোগ ---------- */
async function roomJoin() {
  const code = ((await askText('রুম কোড')) || '').toUpperCase().replace(/\s/g, '');
  if (!code) return;
  const name = await askName() || 'অজ্ঞাত';
  try {
    const r = await api('/api/rooms/join', {
      code, name, role: rm.role || 'student', memberId: rm.mem[code] || undefined
    });
    rm.mem[code] = r.memberId; rm.cur = code;
    setView(r.room);
    openStream(code);
    if (r.room.groups.length && !r.room.you.groupId) await chooseGroup();
    toast(`"${r.room.name}" রুমে যুক্ত হয়েছেন`);
  } catch (e) { toast(e.message, 4000); }
}
async function chooseGroup() {
  const v = curView(); if (!v || !v.groups.length) return;
  const g = await modal({
    title: 'গ্রুপ বেছে নিন', body: 'আপনি কোন গ্রুপে থাকবেন?',
    buttons: [...v.groups.map(x => ({ text: x.name, val: x.id, cls: 'pri' })), { text: 'কোনো গ্রুপ নয়', val: '' }, { text: 'বাতিল', val: null }]
  });
  if (g === null) return;
  await rmAct({ type: 'self.group', groupId: g || null });
}

/* ---------- আমার রুমসমূহ ---------- */
async function roomMine() {
  const box = h('div', { class: 'plist' });
  const codes = rm.recent.filter(c => rm.mem[c]);
  if (!codes.length) box.append(h('p', { class: 'hint' }, 'এখনো কোনো রুমে যোগ দেননি বা তৈরি করেননি।'));
  for (const code of codes) {
    const v = rm.views[code] || { name: code, code, status: '?', members: [], you: {} };
    const cur = code === rm.cur;
    box.append(h('div', { class: 'prow' + (cur ? ' cur' : '') },
      h('button', { class: 'pmain', onclick: () => { modal.close(null); rm.cur = code; rmPersist(); openStream(code); rmRefresh(); toast(`রুম: ${v.name}`); } },
        h('b', {}, v.name + (cur ? ' (চলমান)' : '') + (isOwner(v) ? ' · আমার রুম' : '')),
        h('span', {}, `কোড: ${code} · ${v.status === 'ended' ? 'শেষ' : 'চালু'} · ${(v.members || []).length} জন`)),
      isOwner(v) ? h('button', { class: 'ib sm', 'aria-label': 'শেষ/চালু', onclick: async () => {
        modal.close(null);
        rm.cur = code; rmPersist();
        await rmAct({ type: 'room.status', status: v.status === 'ended' ? 'live' : 'ended' });
      } }, icon('save')) : null));
  }
  await modal({ title: 'আমার রুমসমূহ', body: box, buttons: [{ text: 'বন্ধ', val: null },
    { text: 'নতুন রুম', cls: 'pri', icon: 'plus', act: c => { c(null); roomCreate(); } }] });
}

/* ---------- গ্রুপ ও সদস্য (শিক্ষক) ---------- */
async function roomGroups() {
  const v0 = curView();
  if (!v0) return toast('আগে একটি রুম বেছে নিন');
  const owner = isOwner(v0);
  const body = h('div', { class: 'plist' });
  const draw = () => {
    const v = curView() || v0;
    body.replaceChildren();
    body.append(h('p', { class: 'hint' }, `${v.name} · ${v.members.length} জন`));
    for (const g of v.groups) {
      const mem = v.members.filter(m => m.groupId === g.id);
      body.append(h('div', { class: 'prow' },
        h('div', { class: 'pmain' }, h('b', {}, g.name), h('span', {}, mem.length ? mem.map(m => m.name).join(', ') : 'কোনো সদস্য নেই')),
        owner ? h('button', { class: 'ib sm', 'aria-label': 'নাম বদলান', onclick: async () => { const n = await askText('গ্রুপের নাম', g.name); if (n) { await rmAct({ type: 'group.rename', groupId: g.id, name: n }); } } }, icon('edit')) : null,
        owner ? h('button', { class: 'ib sm danger', 'aria-label': 'মুছুন', onclick: async () => { if (await confirmBox(`"${g.name}" গ্রুপ মুছে যাবে?`, 'মুছুন')) await rmAct({ type: 'group.delete', groupId: g.id }); } }, icon('trash')) : null));
    }
    const ungrouped = v.members.filter(m => !m.groupId);
    if (ungrouped.length) body.append(h('p', { class: 'hint' }, 'গ্রুপ ছাড়া: ' + ungrouped.map(m => m.name).join(', ')));
    if (owner) {
      body.append(h('button', { class: 'chip', onclick: async () => { const n = await askText('নতুন গ্রুপের নাম'); if (n) await rmAct({ type: 'group.add', name: n }); } }, icon('plus'), 'নতুন গ্রুপ'));
      body.append(h('p', { class: 'hint' }, 'সদস্যদের গ্রুপ বদল বা সরিয়ে দিতে নিচের তালিকা ব্যবহার করুন:'));
      for (const m of v.members) {
        if (m.me) continue;
        body.append(h('div', { class: 'prow' },
          h('div', { class: 'pmain' }, h('b', {}, m.name), h('span', {}, roleName(m.role))),
          h('button', { class: 'chip', onclick: async () => {
            const g = await modal({ title: `${m.name} — গ্রুপ`, body: 'নতুন গ্রুপ বেছে নিন',
              buttons: [...v.groups.map(x => ({ text: x.name, val: x.id, cls: 'pri' })), { text: 'গ্রুপ ছাড়া', val: '' }, { text: 'বাতিল', val: null }] });
            if (g === null) return; await rmAct({ type: 'member.move', target: m.id, groupId: g || null }); } }, 'গ্রুপ বদল'),
          h('button', { class: 'ib sm danger', 'aria-label': 'সরান', onclick: async () => { if (await confirmBox(`${m.name} কে রুম থেকে সরাবেন?`, 'সরান')) await rmAct({ type: 'member.remove', target: m.id }); } }, icon('x'))));
      }
    }
  };
  rmRefresh.groupsDraw = draw;
  draw();
  try { await modal({ title: 'গ্রুপ ও সদস্য', body, buttons: [{ text: 'বন্ধ', val: null }] }); }
  finally { rmRefresh.groupsDraw = null; }
}

/* ---------- শিক্ষক-নিয়ন্ত্রিত কথা বলার অনুরোধ ---------- */
async function roomMic() {
  const initial = curView();
  if (!initial) return toast('আগে একটি রুম বেছে নিন');
  const body = h('div', { class: 'plist' });
  const owner = isOwner(initial);
  const draw = () => {
    const v = curView() || initial;
    const mic = v.mic || { queue: [], grant: null, mediaAvailable: false };
    body.replaceChildren();
    if (owner) {
      body.append(h('p', { class: 'hint' }, 'এক সময়ে একজন শিক্ষার্থীকে অনুমতি দেওয়া হয়। শিক্ষক চাইলে যেকোনো সময় অনুমতি বাতিল করতে পারবেন।'));
      if (mic.grant) {
        body.append(h('div', { class: 'prow' },
          h('div', { class: 'pmain' }, h('b', {}, `${mic.grant.name} — অনুমতি অপেক্ষমাণ`), h('span', {}, 'লাইভ অডিও/ভিডিও সংযুক্ত নেই; কোনো অডিও প্রকাশিত হচ্ছে না।')),
          h('button', { class: 'chip danger', onclick: async () => { await rmAct({ type: 'mic.revoke', target: mic.grant.memberId }); draw(); } }, 'অনুমতি বাতিল')));
      }
      if (!mic.queue.length) body.append(h('p', { class: 'hint' }, 'কেউ হাত তোলেনি।'));
      for (const member of mic.queue) {
        body.append(h('div', { class: 'prow' },
          h('div', { class: 'pmain' }, h('b', {}, member.name), h('span', {}, 'কথা বলার অনুরোধ')),
          h('button', { class: 'chip pri', disabled: !!mic.grant, onclick: async () => { await rmAct({ type: 'hand.approve', target: member.id }); draw(); } }, 'অনুমতি দিন'),
          h('button', { class: 'chip', onclick: async () => { await rmAct({ type: 'hand.dismiss', target: member.id }); draw(); } }, 'বাদ দিন')));
      }
      if (!mic.mediaAvailable) body.append(h('p', { class: 'hint' }, 'লাইভ অডিও/ভিডিও প্রকাশনা নিষ্ক্রিয়: LiveKit server credentials যোগ না হওয়া পর্যন্ত অনুমোদন শুধু queue-তে থাকবে।'));
    } else {
      const status = v.you?.micStatus || 'idle';
      const statusText = {
        idle: 'আপনি এখনো কথা বলার অনুরোধ করেননি।',
        hand_raised: 'আপনার অনুরোধ শিক্ষকের queue-তে আছে।',
        approved_waiting: 'শিক্ষক অনুমতি দিয়েছেন। লাইভ অডিও সংযুক্ত না থাকায় এখনো কোনো অডিও পাঠানো হচ্ছে না।',
        permission_ready: 'মাইক্রোফোন অনুমতি প্রস্তুত, কিন্তু live audio connection নেই।',
        revoked: 'শিক্ষক অনুমতি বাতিল করেছেন। চাইলে আবার হাত তুলুন।'
      }[status] || 'কথা বলার অনুরোধের অবস্থা পাওয়া যায়নি।';
      body.append(h('p', { class: 'hint' }, statusText));
      if (status !== 'approved_waiting' && status !== 'permission_ready') {
        body.append(h('button', { class: 'chip pri', onclick: async () => { await rmAct({ type: status === 'hand_raised' ? 'hand.lower' : 'hand.raise' }); draw(); } }, status === 'hand_raised' ? 'হাত নামান' : status === 'revoked' ? 'আবার হাত তুলুন' : 'হাত তুলুন'));
      }
      body.append(h('p', { class: 'hint' }, 'অনুমতি ছাড়া মাইক্রোফোন প্রকাশ হয় না। LiveKit credentials যোগ না হওয়া পর্যন্ত এই রুমে audio/video broadcasting বন্ধ আছে।'));
    }
  };
  rmRefresh.micDraw = draw;
  draw();
  try { await modal({ title: owner ? 'হাত তোলা ও মাইক নিয়ন্ত্রণ' : 'কথা বলার অনুরোধ', body, buttons: [{ text: 'বন্ধ', val: null }] }); }
  finally { rmRefresh.micDraw = null; }
}

/* ---------- ক্লাস টাইমার ---------- */
function timerStart(mins) {
  timerStop(true);
  rmTimer = { end: Date.now() + mins * 60000 };
  rmTimer.handle = setInterval(tickTimer, 1000);
  tickTimer();
}
function timerStop(silent) {
  if (rmTimer) clearInterval(rmTimer.handle);
  rmTimer = null;
  const b = $('#rmTimerBadge'); if (b) b.hidden = true;
  if (!silent) toast('টাইমার বন্ধ');
}
function tickTimer() {
  const b = $('#rmTimerBadge');
  const left = rmTimer.end - Date.now();
  if (left <= 0) {
    timerStop(true);
    toast('সময় শেষ!', 6000);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    return;
  }
  const s = Math.ceil(left / 1000);
  b.hidden = false;
  b.textContent = `⏱ ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
async function timerDialog() {
  if (rmTimer) {
    const stop = await modal({ title: 'ক্লাস টাইমার', body: 'টাইমার চলছে। বন্ধ করতে চান?',
      buttons: [{ text: 'চালু থাকুক', val: false }, { text: 'বন্ধ করুন', cls: 'pri', val: true }] });
    if (stop) timerStop();
    return;
  }
  const v = await askText('কত মিনিটের টাইমার? (যেমন: 10)', '10');
  const mins = parseInt(v, 10);
  if (!mins || mins < 1 || mins > 300) return toast('১ থেকে ৩০০ মিনিটের মধ্যে লিখুন');
  timerStart(mins); toast(`${mins} মিনিটের টাইমার শুরু`);
}

/* ---------- ইনস্টল / ডাউনলোড ---------- */
async function installApp() {
  if (deferredInstall) {
    deferredInstall.prompt();
    const r = await deferredInstall.userChoice;
    deferredInstall = null;
    if (r && r.outcome === 'accepted') toast('ইনস্টল শুরু হয়েছে');
    return;
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return toast('অ্যাপটি ইতিমধ্যে ইনস্টল করা আছে');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  modal({
    title: 'অ্যাপ ইনস্টল করুন',
    body: [
      h('p', {}, 'ইনস্টল করলে হোম স্ক্রিনে আইকন থাকবে এবং ইন্টারনেট ছাড়াও বোর্ড চলবে।'),
      isIOS
        ? h('p', {}, 'iPhone/iPad: Safari-তে শেয়ার বাটন → "Add to Home Screen" বেছে নিন।')
        : h('p', {}, 'Android Chrome: উপরের ⋮ মেনু → "Install app" / "অ্যাপ ইনস্টল করুন"। PC Chrome/Edge: ঠিকানা বারের ডানে ইনস্টল আইকন।'),
      h('p', { class: 'hint' }, 'ইনস্টল শুধু HTTPS ঠিকানায় (অনলাইনে প্রকাশিত) কাজ করে।')
    ],
    buttons: [{ text: 'ঠিক আছে', val: true, cls: 'pri' }]
  });
}


/* ---------- বোর্ড সিঙ্ক (শিক্ষক → শিক্ষার্থী) ----------
   শিক্ষক বোর্ড বদলালে বর্তমান পেজের স্ন্যাপশট সার্ভারে যায়, সার্ভার সব সদস্যকে পাঠায়।
   শিক্ষার্থীর ডিভাইসে সেটি আঁকা হয় — তাদের নিজের নোটে সংরক্ষিত হয় না।
   PDF/ছবির ব্যাকগ্রাউন্ড এখনো সিঙ্ক হয় না (শুধু কালি, আকৃতি, লেখা ও বোর্ডের ধরন)। */
let rmBoardTimer = null;
let rmLiveCode = null;     // শিক্ষার্থীর ডিভাইসে এখন কোন রুমের বোর্ড দেখানো হচ্ছে
let rmSeenSeq = {};
let rmPushed = {};

let rmBgSent = null;   // শেষবার যে পাতার PDF/ছবি-ব্যাকগ্রাউন্ড সার্ভারে গেছে (code:pageId)
function rmBoardPush() {
  if (rm.role !== 'teacher' || !S.page || !S.P) return;
  const v = curView();
  if (!v || !isOwner(v) || v.status === 'ended') return;
  clearTimeout(rmBoardTimer);
  rmBoardTimer = setTimeout(async () => {
    const p = S.page;
    const key = v.code + ':' + p.id;
    const snap = { type: p.type, w: p.w, h: p.h, grid: p.grid, bgc: p.bgc, items: p.items, pageNo: S.P.cur + 1 };
    if (p.blob) {
      snap.bgId = key;
      // PDF/ছবির পাতা: ব্যাকগ্রাউন্ড শুধু একবার পাঠানো হয়
      if (rmBgSent !== key) {
        try { snap.bg = await blobToDataURL(p.blob); rmBgSent = key; } catch (_) { }
      }
    }
    try {
      await api(`/api/rooms/${encodeURIComponent(v.code)}/board`, { memberId: rm.mem[v.code], page: snap });
    } catch (e) { toast('বোর্ড শেয়ার ব্যর্থ: ' + e.message, 3500); }
  }, 350);
}

/* শিক্ষার্থীর স্ক্রিনে শিক্ষকের বোর্ড আঁকা — নিজের নোটের S.page বদলায় না */
const rmBgImgs = new Map();   // bgId -> HTMLImageElement
let rmLastPage = null;
function rmPaintRemote(pg) {
  rmLastPage = pg;
  let bmp = null;
  if (pg.bgId) {
    const im = rmBgImgs.get(pg.bgId);
    if (im && im.complete && im.naturalWidth) bmp = im;
    else if (!im && pg.bg) {
      const ni = new Image();
      rmBgImgs.set(pg.bgId, ni);
      ni.onload = () => { if (rmLastPage) rmPaintRemote(rmLastPage); };
      ni.src = pg.bg;
    }
  }
  const prev = S.page;
  const remote = mkPage({ type: pg.type, w: pg.w, h: pg.h, grid: pg.grid, bgc: pg.bgc, items: pg.items, dirty: false });
  S.page = remote;
  try {
    sizeCanvases();
    const c = els.cvBg.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, els.cvBg.width, els.cvBg.height);
    c.setTransform(RES, 0, 0, RES, 0, 0);
    drawBg(c, remote, bmp);
    redrawInk();
  } finally { S.page = prev; }
}

function rmOnBoard(code, b) {
  if (!b || !b.page) return;
  if (rm.role === 'teacher' && isOwner(rm.views[code])) return;   // নিজের বোর্ড
  if (rmSeenSeq[code] && b.seq <= rmSeenSeq[code]) return;
  rmSeenSeq[code] = b.seq;
  if (rmLiveCode !== code) {
    rmLiveCode = code;
    document.body.classList.add('remote-live');
    toast('শিক্ষকের বোর্ড লাইভ');
  }
  rmPaintRemote(b.page);
}
function rmEndLive() {
  if (!rmLiveCode) return;
  rmLiveCode = null;
  document.body.classList.remove('remote-live');
  if (S.P) showPage(S.P.cur);     // নিজের নোটে ফিরে যাওয়া
}

/* ---------- মেনু যুক্তকরণ ---------- */
const RM_MENU_BLOCK = [
  { sec: 'রোল ও রুম' },
  { id: 'roleSwitch', icon: 'board', text: 'রোল বদলান (শিক্ষক ⇄ শিক্ষার্থী)' },
  { id: 'roomCreate', icon: 'plus', text: 'নতুন রুম তৈরি (শিক্ষক)' },
  { id: 'roomJoin', icon: 'share', text: 'রুমে যোগ দিন (কোড দিয়ে)' },
  { id: 'roomMine', icon: 'folder', text: 'আমার রুমসমূহ' },
  { id: 'roomGroups', icon: 'grid', text: 'গ্রুপ ও সদস্য ব্যবস্থাপনা' },
  { id: 'roomMic', icon: 'share', text: 'হাত তোলা ও মাইক অনুমতি' },
  { sec: 'ক্লাসের সরঞ্জাম' },
  { id: 'timer', icon: 'play', text: 'ক্লাস টাইমার' }
];
const RM_EDIT_ONLY = ['newproj', 'rename', 'addpage', 'pdfimp', 'imgimp', 'swapboard', 'grid', 'clear', 'restore'];

function rmInjectMenu() {
  const at = MENU.findIndex(m => m.sec === 'অ্যাপ');
  MENU.splice(at, 0, ...RM_MENU_BLOCK);
  const inst = MENU.find(m => m.id === 'install'); if (inst) { inst.hidden = false; inst.text = 'অ্যাপ ডাউনলোড / ইনস্টল করুন'; }
  MENU.splice(MENU.findIndex(m => m.id === 'about'), 0, { id: 'help', icon: 'info', text: 'সাহায্য: কিভাবে ব্যবহার করবেন' });
}
const RM_ACTS = {
  roleSwitch: roleDialog, roomCreate, roomJoin, roomMine, roomGroups, roomMic,
  timer: timerDialog, install: installApp,
  help: () => modal({ title: 'সাহায্য', body: [
    h('p', {}, '১. রোল: শিক্ষক হলে রুম ও গ্রুপ বানাবেন। শিক্ষার্থী হলে রুম কোড দিয়ে যোগ দেবেন।'),
    h('p', {}, '২. শিক্ষার্থী রোলে বোর্ড শুধু দেখা যায়, লেখা বা সম্পাদনা করা যায় না।'),
    h('p', {}, '৩. রুম, গ্রুপ ও সদস্য সার্ভারে থাকে, সব ডিভাইসে তাৎক্ষণিক আপডেট হয়।'),
    h('p', {}, '৪. বোর্ডের লেখা এখনো এই ডিভাইসেই সংরক্ষিত — নিয়মিত "ব্যাকআপ ফাইল সংরক্ষণ" করুন।')
  ], buttons: [{ text: 'ঠিক আছে', val: true, cls: 'pri' }] })
};

function rmInitUI() {
  for (const id of RM_EDIT_ONLY) { const el = document.getElementById('mi-' + id); if (el) el.classList.add('ed'); }
  $('#menuList').prepend(h('div', { id: 'rmStatus', class: 'rm-status' }));
  const badge = h('span', { id: 'rmTimerBadge', class: 'rm-timer', hidden: true, onclick: timerDialog });
  $('#topbar').insertBefore(badge, $('#topbar .pager'));
  const orig = menuAct;
  menuAct = async function (id) {
    if (RM_ACTS[id]) { closeUI(); await sleep(60); return RM_ACTS[id](); }
    return orig(id);
  };
  if (rmBC) rmBC.onmessage = e => { /* অন্য ট্যাব বদলালে: লোকাল ক্যাশ নতুন করে নেওয়া */ rmLoad(); rmRefresh(); };
  document.body.dataset.role = rm.role || 'teacher';
  if (rm.cur && rm.mem[rm.cur]) openStream(rm.cur);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && rm.cur) openStream(rm.cur); });
  renderRmStatus();
  if (!rm.role) setTimeout(roleDialog, 600);
}

/* বোর্ড বদল / পাতা বদল হলে শিক্ষকের স্ন্যাপশট পাঠানো */
{
  const _touch = touch;
  touch = function (p) { _touch(p); rmBoardPush(); };
  const _showPage = showPage;
  showPage = async function (i) { const r = await _showPage(i); rmBoardPush(); return r; };
}

/* স্টেট লোড ও মেনু-ডেটা আগেই (ui.js-এর buildMenu চলার আগে) */
rmLoad();
rmInjectMenu();
/* UI বাইন্ডিং: app init() নিজের সিঙ্ক অংশ শেষ করার পরে */
window.addEventListener('DOMContentLoaded', () => { try { rmInitUI(); } catch (e) { console.error('rooms', e); } });
