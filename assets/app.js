/* Instinct · Mido — chat client
   One file, no build step. Runs on the website, inside the Windows app and inside the Android app. */
(() => {
  'use strict';

  const CFG = Object.assign(
    {
      apiBase: '',
      appKey: '',
      platform: 'web',
      version: '1.0.0',
      releasesUrl: 'https://github.com/Mohamedmostafa2011/mido-instinct/actions/workflows/apps.yml',
    },
    window.MIDO_CONFIG || {}
  );
  const IS_APP = !!CFG.appKey;
  const NAMES = { mido: 'Mido', instinct: 'Instinct' };
  const LS = { key: 'mido.passkey', as: 'mido.as', notify: 'mido.notify', drafts: 'mido.drafts', last: 'mido.lastChat' };
  const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const narrow = () => matchMedia('(max-width: 760px)').matches;

  const $ = (s) => document.querySelector(s);
  const store = {
    get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* */ } },
  };

  const S = {
    key: '', as: 'instinct', role: 'mido', via: 'web', storage: 'redis',
    ver: undefined, chats: [], chatMap: new Map(),
    openId: null, msgs: [], count: 0, rev: -1, loaded: false,
    pending: [], replyTo: null, editing: null, focusMsg: null,
    presence: { online: false },
    filter: 'all', search: '', results: null,
    lastKeyAt: 0, typingSent: false, lastTypingAt: 0, lastHeartbeat: 0,
    syncing: false, again: false, timer: null, failures: 0, firstLoad: true, started: false,
  };
  const other = () => (S.role === 'mido' ? 'instinct' : 'mido');

  /* ------------------------------------------------------------------ api */

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'X-Mido-Key': S.key };
    if (!IS_APP) headers['X-Mido-As'] = S.as;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(CFG.apiBase + '/api/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      const e = new Error('Can’t reach the server'); e.status = 0; throw e;
    }
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) { const e = new Error(data.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
    return data;
  }

  /* ------------------------------------------------------------- helpers */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(raw) {
    const codes = [];
    const links = [];
    let s = raw.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    const link = (href, text) => { links.push('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'); return '\u0001' + (links.length - 1) + '\u0001'; };
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t));
    s = s.replace(/\bhttps?:\/\/[^\s<\u0001]+[^\s<.,:;"')\]!?\u0001]/g, (u) => link(u, u));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[i]);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[i]) + '</code>');
    return s;
  }

  function md(src) {
    const out = [];
    String(src).split('```').forEach((part, idx) => {
      if (idx % 2 === 1) {
        const code = part.replace(/^[\w+-]*\n/, '').replace(/\n$/, '');
        out.push('<pre><code>' + esc(code) + '</code></pre>');
        return;
      }
      let para = [];
      let list = null;
      const flushP = () => { if (para.length) { out.push('<p dir="auto">' + para.map(inline).join('<br>') + '</p>'); para = []; } };
      const flushL = () => { if (list) { out.push('<' + list.t + ' dir="auto">' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.t + '>'); list = null; } };
      const into = (t, text) => { flushP(); if (!list || list.t !== t) { flushL(); list = { t, items: [] }; } list.items.push(text); };
      for (const line of part.split('\n')) {
        let m;
        if (!line.trim()) { flushP(); flushL(); continue; }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushP(); flushL(); out.push('<hr>'); continue; }
        if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { into('ul', m[1]); continue; }
        if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { into('ol', m[1]); continue; }
        if ((m = line.match(/^\s*>\s?(.*)$/))) { flushP(); flushL(); out.push('<blockquote dir="auto">' + inline(m[1]) + '</blockquote>'); continue; }
        if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) { flushP(); flushL(); out.push('<h4 dir="auto">' + inline(m[1]) + '</h4>'); continue; }
        flushL();
        para.push(line);
      }
      flushP(); flushL();
    });
    return out.join('');
  }

  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const DAY = 86400000;
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function fmtListTime(t) {
    const today = startOfDay(Date.now());
    if (t >= today) return fmtTime(t);
    if (t >= today - DAY) return 'Yesterday';
    if (t >= today - 6 * DAY) return new Date(t).toLocaleDateString([], { weekday: 'short' });
    const d = new Date(t);
    return d.toLocaleDateString([], d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function dayLabel(t) {
    const today = startOfDay(Date.now());
    if (t >= today) return 'Today';
    if (t >= today - DAY) return 'Yesterday';
    return new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400 && t >= startOfDay(Date.now())) return 'today at ' + fmtTime(t);
    if (t >= startOfDay(Date.now()) - DAY) return 'yesterday at ' + fmtTime(t);
    return 'on ' + new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  const icon = (id) => '<svg class="i" aria-hidden="true"><use href="#' + id + '"/></svg>';
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  function dialog({ title, text = '', input = null, ok = 'OK', danger = false }) {
    const d = $('#dialog');
    $('#dialog-title').textContent = title;
    $('#dialog-text').textContent = text;
    const inp = $('#dialog-input');
    inp.hidden = input === null;
    inp.value = input || '';
    const okBtn = $('#dialog-ok');
    okBtn.textContent = ok;
    okBtn.className = 'btn' + (danger ? ' danger' : '');
    return new Promise((resolve) => {
      d.onclose = () => resolve(d.returnValue === 'ok' ? (input === null ? true : inp.value.trim()) : null);
      d.returnValue = '';
      d.showModal();
      if (input !== null) { inp.focus(); inp.select(); }
    });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch { toast('Couldn’t copy'); }
      ta.remove();
    }
  }

  /* --------------------------------------------------------------- screens */

  function showSplash(text, retry = false) {
    $('#gate').hidden = true; $('#shell').hidden = true;
    $('#splash').hidden = false;
    $('#splash-text').textContent = text;
    $('#splash-retry').hidden = !retry;
  }

  function showGate(error = '') {
    $('#splash').hidden = true; $('#shell').hidden = true;
    $('#gate').hidden = false;
    $('#gate-error').textContent = error;
    const saved = store.get(LS.as, 'instinct');
    const radio = document.querySelector('input[name="as"][value="' + saved + '"]');
    if (radio) radio.checked = true;
    setTimeout(() => $('#gate-key').focus(), 50);
  }

  async function boot() {
    if (IS_APP) {
      S.key = CFG.appKey;
    } else {
      const u = new URL(location.href);
      if (u.searchParams.has('key')) {
        store.set(LS.key, u.searchParams.get('key'));
        const as = u.searchParams.get('as');
        if (as === 'mido' || as === 'instinct') store.set(LS.as, as);
        u.searchParams.delete('key'); u.searchParams.delete('as');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      }
      S.key = store.get(LS.key, '');
      S.as = store.get(LS.as, 'instinct');
      if (!S.key) return showGate();
    }
    connect();
  }

  async function connect() {
    showSplash('Opening your chats');
    try {
      const s = await api('session');
      S.role = s.role; S.via = s.via; S.storage = s.storage;
      enterShell();
    } catch (e) {
      if (e.status === 401 && !IS_APP) { store.del(LS.key); showGate('That passkey didn’t work. Try again.'); return; }
      if (e.status === 401) return showSplash('This app’s built-in key doesn’t match the server. Install the latest build.', true);
      if (e.status === 503) return showSplash(e.message, true);
      showSplash('Can’t reach the server. Check the connection and try again.', true);
    }
  }

  $('#splash-retry').addEventListener('click', connect);

  $('#gate-peek').addEventListener('click', () => {
    const k = $('#gate-key');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('#gate-peek').setAttribute('aria-label', k.type === 'password' ? 'Show passkey' : 'Hide passkey');
  });

  $('#gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const key = $('#gate-key').value.trim();
    const as = (document.querySelector('input[name="as"]:checked') || {}).value || 'instinct';
    if (!key) return;
    const btn = $('#gate-submit');
    btn.disabled = true;
    $('#gate-error').textContent = '';
    S.key = key; S.as = as;
    try {
      const s = await api('session');
      store.set(LS.key, key); store.set(LS.as, as);
      S.role = s.role; S.via = s.via; S.storage = s.storage;
      enterShell();
    } catch (e) {
      $('#gate-error').textContent = e.status === 401 ? 'That passkey didn’t work' : e.message;
      $('#gate-key').select();
    } finally {
      btn.disabled = false;
    }
  });

  function enterShell() {
    $('#splash').hidden = true; $('#gate').hidden = true; $('#shell').hidden = false;
    const name = NAMES[S.role];
    $('#me-name').textContent = name;
    $('#me-avatar').textContent = name[0];
    $('#me-sub').textContent = CFG.platform === 'windows' ? 'Windows app' : CFG.platform === 'android' ? 'Android app' : 'Signed in on the web';
    $('#input').placeholder = S.role === 'mido' ? 'Text Instinct' : 'Reply to Mido';
    document.querySelector('[data-filter="waiting"]').firstChild.textContent = S.role === 'instinct' ? 'Needs reply ' : 'Waiting ';

    const last = store.get(LS.last + '.' + S.role);
    if (last && !narrow()) openChat(last, { quiet: true });
    else startNew({ quiet: true });

    if (!S.started) {
      S.started = true;
      setInterval(renderPresence, 15000);
    }
    sync();
  }

  function signOut() {
    store.del(LS.key);
    clearTimeout(S.timer);
    S.ver = undefined; S.chats = []; S.chatMap = new Map(); S.firstLoad = true;
    $('#gate-key').value = '';
    showGate();
  }

  /* ------------------------------------------------------------------ sync */

  const pageActive = () => !document.hidden && document.hasFocus();
  const isTyping = () => !!$('#input').value.trim() && Date.now() - S.lastKeyAt < 6000 && !S.editing;

  function schedule() {
    clearTimeout(S.timer);
    let ms = document.hidden ? 30000 : document.hasFocus() ? 3000 : 8000;
    if (!document.hidden && S.presence.online && S.presence.chat === S.openId) ms = Math.min(ms, 2000);
    if (S.failures) ms = Math.min(30000, 2000 * 2 ** Math.min(S.failures, 4));
    S.timer = setTimeout(sync, ms);
  }

  async function sync() {
    if ($('#shell').hidden) return;
    if (S.syncing) { S.again = true; return; }
    S.syncing = true;
    clearTimeout(S.timer);

    const now = Date.now();
    const typing = isTyping();
    const body = { ver: S.ver, chat: S.openId, count: S.count, rev: S.rev };
    if (now - S.lastHeartbeat > 20000) { body.heartbeat = true; body.typing = typing; }
    if (typing !== S.typingSent || (typing && now - S.lastTypingAt > 4000)) body.typing = typing;
    const open = S.chatMap.get(S.openId);
    if (open && open.unread && pageActive()) body.read = S.openId;

    try {
      const d = await api('sync', { method: 'POST', body });
      if (body.typing !== undefined) { S.lastHeartbeat = now; S.typingSent = body.typing; if (body.typing) S.lastTypingAt = now; }
      if (body.read && open) open.unread = false;
      apply(d);
      if (S.failures) { S.failures = 0; renderPresence(); }
    } catch (e) {
      if (e.status === 401) { S.syncing = false; return IS_APP ? connect() : signOut(); }
      S.failures++;
      renderPresence();
    } finally {
      S.syncing = false;
      if (S.again) { S.again = false; sync(); } else schedule();
    }
  }

  function apply(d) {
    S.presence = d.presence || { online: false };
    if (d.storage) S.storage = d.storage;
    if (d.changed) {
      const prev = S.chatMap;
      S.ver = d.ver;
      S.chats = d.chats || [];
      S.chatMap = new Map(S.chats.map((c) => [c.id, c]));
      maybeNotify(prev);
      const o = d.open;
      if (o && o.id === S.openId) {
        if (o.missing) {
          if (S.loaded || S.msgs.length) toast('That chat was deleted');
          store.del(LS.last + '.' + S.role);
          startNew({ quiet: true });
        } else {
          if (o.reset) S.msgs = o.messages; else S.msgs.push(...o.messages);
          S.count = o.count; S.rev = o.rev;
          const first = !S.loaded;
          S.loaded = true;
          renderMessages(first || o.reset);
        }
      }
      renderList();
      renderHead();
      renderBadge();
      renderStorage();
    }
    renderPresence();
  }

  /* --------------------------------------------------------- notifications */

  function maybeNotify(prev) {
    if (S.firstLoad) { S.firstLoad = false; return; }
    for (const c of S.chats) {
      const last = c.last;
      if (!last || last.from === S.role || last.deleted) continue;
      const p = prev.get(c.id);
      if (p && p.last && p.last.at >= last.at) continue;
      if (pageActive() && c.id === S.openId) continue;
      notify(NAMES[last.from] + ' · ' + c.title, last.text, c.id);
    }
  }

  function notificationsOn() { return store.get(LS.notify, 'on') !== 'off'; }

  function notify(title, body, chatId) {
    if (!notificationsOn()) return;
    const native = window.midoNative;
    if (native && native.flash) native.flash();
    const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if (cap) {
      cap.schedule({ notifications: [{ id: Math.floor(Math.random() * 2e9), title, body: clip(body, 200), extra: { chatId } }] }).catch(() => {});
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body: clip(body, 200), tag: chatId, icon: 'assets/img/icon-512.png' });
        n.onclick = () => { window.focus(); if (native && native.show) native.show(); openChat(chatId); n.close(); };
      } catch { /* some webviews throw */ }
    }
  }

  async function toggleNotifications() {
    if (notificationsOn()) { store.set(LS.notify, 'off'); toast('Notifications off'); return; }
    store.set(LS.notify, 'on');
    const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if (cap) { try { await cap.requestPermissions(); } catch { /* */ } }
    else if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* */ } }
    toast('Notifications on');
  }

  /* ----------------------------------------------------------- navigation */

  function resetThread() {
    S.msgs = []; S.count = 0; S.rev = -1; S.loaded = false; S.pending = [];
    setReply(null); setEditing(null);
    $('#messages').innerHTML = '';
    $('#typing').hidden = true;
  }

  function openChat(id, { focusMsg = null, quiet = false } = {}) {
    saveDraft();
    if (S.openId !== id) resetThread();
    S.openId = id;
    S.focusMsg = focusMsg;
    store.set(LS.last + '.' + S.role, id);
    $('#shell').classList.add('viewing');
    $('#empty').hidden = true;
    loadDraft();
    renderHead();
    renderList();
    if (S.loaded && focusMsg !== null) renderMessages(true);
    S.ver = undefined;
    if (!quiet) sync();
    if (!TOUCH) $('#input').focus();
  }

  function startNew({ quiet = false } = {}) {
    saveDraft();
    resetThread();
    S.openId = null;
    store.del(LS.last + '.' + S.role);
    if (!quiet) $('#shell').classList.add('viewing');
    loadDraft();
    renderEmpty();
    renderHead();
    renderList();
    if (!quiet && !TOUCH) $('#input').focus();
  }

  function backToList() {
    saveDraft();
    $('#shell').classList.remove('viewing');
    $('#search').blur();
  }

  /* --------------------------------------------------------------- render */

  function renderStorage() {
    const n = $('#storage-note');
    if (S.storage === 'memory') {
      n.hidden = false;
      n.textContent = 'Storage isn’t connected yet, so chats can disappear. Add Upstash Redis to this project in Vercel to keep them for good.';
    } else n.hidden = true;
  }

  function renderBadge() {
    const n = S.chats.reduce((a, c) => a + (c.unreadCount || 0), 0);
    const waiting = S.role === 'instinct' ? S.chats.filter((c) => c.needsReply).length : 0;
    const count = Math.max(n, waiting);
    document.title = (count ? '(' + count + ') ' : '') + 'Instinct';
    if (window.midoNative && window.midoNative.setBadge) window.midoNative.setBadge(count);
  }

  function renderEmpty() {
    const box = $('#empty');
    box.hidden = false;
    const sug = $('#suggestions');
    sug.innerHTML = '';
    if (S.role === 'mido') {
      $('#empty-title').textContent = 'What should Instinct take care of?';
      $('#empty-sub').textContent = 'Messages here are saved. Instinct reads them and replies in this chat, the same way it answers your texts.';
      const ideas = [
        ['i-apples', 'Order ingredients for a new recipe'],
        ['i-train', 'Book a train home for the weekend'],
        ['i-tulip', 'Send flowers to a friend'],
        ['i-racket', 'Find a court for the weekend'],
      ];
      for (const [ic, text] of ideas) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'suggestion';
        b.innerHTML = icon(ic) + '<span>' + esc(text) + '</span>';
        b.addEventListener('click', () => { const i = $('#input'); i.value = text; autosize(); updateSend(); i.focus(); i.setSelectionRange(text.length, text.length); });
        sug.appendChild(b);
      }
    } else {
      const waiting = S.chats.filter((c) => c.needsReply).sort((a, b) => (a.last?.at || 0) - (b.last?.at || 0));
      $('#empty-title').textContent = waiting.length ? (waiting.length === 1 ? 'One chat needs a reply' : waiting.length + ' chats need a reply') : 'Mido’s messages land here';
      $('#empty-sub').textContent = waiting.length
        ? 'Chats marked “Needs reply” end with a message from Mido. Open one, read it and answer in the box at the bottom.'
        : 'Nothing is waiting right now. New messages from Mido show up in the list on the left. You can also start a chat with Mido below.';
      if (waiting.length) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn';
        b.textContent = 'Open the oldest one';
        b.addEventListener('click', () => openChat(waiting[0].id));
        sug.appendChild(b);
        sug.style.display = 'block';
        sug.style.textAlign = 'center';
      } else { sug.style.display = ''; sug.style.textAlign = ''; }
    }
  }

  function renderHead() {
    const chat = S.chatMap.get(S.openId);
    const draft = !S.openId;
    $('#thread-name').textContent = draft ? (S.role === 'mido' ? 'Instinct' : 'Mido') : chat ? chat.title : ' ';
    $('#thread-actions').hidden = draft;
    const pin = $('#pin-btn');
    const pinned = !!(chat && chat.pinned);
    pin.classList.toggle('on', pinned);
    pin.setAttribute('aria-label', pinned ? 'Unpin chat' : 'Pin chat');
    pin.title = pinned ? 'Unpin' : 'Pin';
    if (draft && !$('#empty').hidden && S.role === 'instinct') renderEmpty();
    renderPresence();
  }

  function renderPresence() {
    const p = S.presence || {};
    const name = NAMES[other()];
    const st = $('#thread-status');
    // In a new chat the header already shows the other name, so drop the prefix there
    const pre = S.openId ? name + ' · ' : '';
    let text;
    if (S.failures > 1) text = 'Reconnecting…';
    else if (p.typing && p.chat === S.openId && S.openId) text = name + ' is typing…';
    else if (p.online) text = pre + (pre ? 'here now' : 'Here now');
    else if (p.at) text = pre + (pre ? 'last seen ' : 'Last seen ') + ago(p.at);
    else text = pre + (S.role === 'mido' ? (pre ? 'text anytime' : 'Text anytime') : (pre ? 'private line' : 'Private line'));
    st.classList.toggle('online', !!p.online && S.failures < 2);
    $('#thread-status-text').textContent = text;

    const showTyping = !!(p.typing && S.openId && p.chat === S.openId);
    const t = $('#typing');
    if (t.hidden === showTyping) {
      const nearBottom = isNearBottom();
      t.hidden = !showTyping;
      $('#typing-label').textContent = name + ' is typing';
      if (nearBottom) scrollToBottom();
    }
  }

  function groupOf(c) {
    if (c.pinned) return 'Pinned';
    const t = c.updatedAt;
    const today = startOfDay(Date.now());
    if (t >= today) return 'Today';
    if (t >= today - DAY) return 'Yesterday';
    if (t >= today - 6 * DAY) return 'This week';
    return 'Earlier';
  }

  function chatRow(c) {
    const b = document.createElement('button');
    b.className = 'chat-row' + (c.unread ? ' unread' : '');
    b.dataset.id = c.id;
    if (c.id === S.openId) b.setAttribute('aria-current', 'true');
    const mine = c.last && c.last.from === S.role;
    const plain = (t) => t.replace(/```/g, '').replace(/(\*\*|__|~~|`)/g, '').replace(/^\s*([-*•]|\d+[.)]|#+|>)\s+/gm, '').replace(/\s+/g, ' ');
    const preview = c.last ? (c.last.deleted ? 'Message deleted' : (mine ? 'You: ' : '') + plain(c.last.text)) : 'No messages yet';
    let tag = '';
    let status = '';
    if (c.needsReply && S.role === 'instinct') { tag = '<span class="chat-row-tag"><span class="tag-wait hl-under">Needs reply</span></span>'; status = 'Needs reply' + (c.unread ? ', unread' : ''); }
    else if (c.unreadCount) { tag = '<span class="chat-row-tag tag-count">' + c.unreadCount + '</span>'; status = c.unreadCount + ' unread'; }
    else if (c.needsReply) { tag = '<span class="chat-row-tag" style="color:var(--ink-3)">Waiting</span>'; status = 'Waiting for Instinct'; }
    b.innerHTML =
      '<span class="chat-row-title">' + (c.pinned ? icon('i-pin') : '') + '<span dir="auto">' + esc(c.title) + '</span></span>' +
      '<span class="chat-row-time">' + (c.last ? fmtListTime(c.last.at) : '') + '</span>' +
      '<span class="chat-row-preview" dir="auto">' + esc(preview) + '</span>' + tag;
    b.setAttribute('aria-label', c.title + (status ? ', ' + status : '') + (c.last ? ', last message ' + fmtListTime(c.last.at) : ''));
    return b;
  }

  function renderList() {
    const list = $('#chat-list');
    const q = S.search.trim().toLowerCase();
    let chats = S.chats;
    const waitingN = chats.filter((c) => c.needsReply).length;
    const unreadN = chats.filter((c) => c.unread).length;
    $('#waiting-count').textContent = waitingN || '';
    $('#unread-count').textContent = unreadN || '';
    if (S.filter === 'waiting') chats = chats.filter((c) => c.needsReply);
    if (S.filter === 'unread') chats = chats.filter((c) => c.unread);
    if (q) chats = chats.filter((c) => c.title.toLowerCase().includes(q) || (c.last && c.last.text.toLowerCase().includes(q)));

    const frag = document.createDocumentFragment();
    let group = null;
    for (const c of chats) {
      const g = q ? 'Chats' : groupOf(c);
      if (g !== group) {
        group = g;
        const l = document.createElement('div'); l.className = 'group-label'; l.textContent = g;
        frag.appendChild(l);
      }
      frag.appendChild(chatRow(c));
    }
    if (q && S.results && S.results.length) {
      const l = document.createElement('div'); l.className = 'group-label'; l.textContent = 'In messages';
      frag.appendChild(l);
      for (const r of S.results) {
        if (r.i === null) continue;
        const b = document.createElement('button');
        b.className = 'chat-row result-row';
        b.dataset.id = r.chat; b.dataset.i = r.i;
        const snip = esc(r.snippet).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => '<mark>' + m + '</mark>');
        b.innerHTML = '<span class="chat-row-title"><span dir="auto">' + esc(r.title) + '</span></span><span class="chat-row-preview" dir="auto">' + (r.from ? esc(NAMES[r.from]) + ': ' : '') + snip + '</span>';
        frag.appendChild(b);
      }
    }
    if (!chats.length && !(q && S.results && S.results.length)) {
      const e = document.createElement('p'); e.className = 'list-empty';
      e.textContent = q ? 'No chats match “' + S.search.trim() + '”'
        : S.filter === 'waiting' ? (S.role === 'instinct' ? 'Nothing needs a reply' : 'Instinct has answered everything')
        : S.filter === 'unread' ? 'You’re all caught up'
        : S.role === 'mido' ? 'Your chats with Instinct will be listed here' : 'Chats with Mido will be listed here';
      frag.appendChild(e);
    }
    list.replaceChildren(frag);
  }

  const isNearBottom = () => { const s = $('#scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 140; };
  const scrollToBottom = () => { const s = $('#scroller'); s.scrollTop = s.scrollHeight; };

  function renderMessages(jump) {
    const ol = $('#messages');
    const near = isNearBottom();
    const prevTop = $('#scroller').scrollTop;
    const ids = new Set(S.msgs.map((m) => m.id));
    S.pending = S.pending.filter((p) => !(p.id && ids.has(p.id)));
    const items = S.msgs.concat(S.pending.map((p) => ({ ...p, from: S.role, pending: true })));
    if (S.openId || items.length) $('#empty').hidden = true;

    const chat = S.chatMap.get(S.openId);
    const seenAt = chat ? chat.seenAt || 0 : 0;
    let lastMine = -1;
    items.forEach((m, k) => { if (m.from === S.role && !m.deleted) lastMine = k; });

    const frag = document.createDocumentFragment();
    let prev = null;
    items.forEach((m, k) => {
      if (!prev || startOfDay(prev.at) !== startOfDay(m.at)) {
        const d = document.createElement('li'); d.className = 'day'; d.innerHTML = '<span>' + esc(dayLabel(m.at)) + '</span>';
        frag.appendChild(d);
      }
      const next = items[k + 1];
      const groupStart = !prev || prev.from !== m.from || m.at - prev.at > 5 * 60000 || startOfDay(prev.at) !== startOfDay(m.at);
      const groupEnd = !next || next.from !== m.from || next.at - m.at > 5 * 60000 || startOfDay(next.at) !== startOfDay(m.at);
      const mine = m.from === S.role;

      const li = document.createElement('li');
      li.className = 'msg' + (mine ? ' mine' : '') + (groupStart ? ' group-start' : '') + (m.pending ? ' pending' : '');
      if (m.i !== undefined) li.dataset.i = m.i;
      if (m.tempId) li.dataset.temp = m.tempId;
      li.setAttribute('aria-label', NAMES[m.from] + ' at ' + fmtTime(m.at));

      let quote = '';
      if (m.replyTo && !m.deleted) {
        quote = '<button type="button" class="quote" data-act="goto" data-ref="' + esc(m.replyTo.id) + '"><b>' + esc(m.replyTo.from === S.role ? 'You' : NAMES[m.replyTo.from]) + '</b> · ' + esc(m.replyTo.text) + '</button>';
      }
      const body = m.deleted ? '<span>Message deleted</span>' : md(m.text);
      let actions = '';
      if (!m.pending && !m.deleted) {
        actions = '<span class="msg-actions">' +
          '<button type="button" class="icon-btn" data-act="reply" aria-label="Reply" title="Reply">' + icon('i-reply') + '</button>' +
          '<button type="button" class="icon-btn" data-act="copy" aria-label="Copy" title="Copy">' + icon('i-copy') + '</button>' +
          (mine ? '<button type="button" class="icon-btn" data-act="edit" aria-label="Edit" title="Edit">' + icon('i-pencil') + '</button>' +
                  '<button type="button" class="icon-btn" data-act="delete" aria-label="Delete" title="Delete">' + icon('i-trash') + '</button>' : '') +
          '</span>';
      }
      li.innerHTML = '<div class="msg-row"><div class="bubble' + (m.deleted ? ' deleted' : '') + '">' + quote + body + '</div>' + actions + '</div>';

      let meta = '';
      if (m.pending) {
        meta = m.state === 'failed' ? 'Not sent · <button type="button" class="retry" data-act="retry">Try again</button>' : 'Sending…';
      } else if (groupEnd || k === lastMine) {
        meta = esc(fmtTime(m.at)) + (m.editedAt ? ' · edited' : '');
        if (k === lastMine && mine) meta += ' · ' + (seenAt >= m.at ? 'Seen' : 'Sent');
      }
      if (meta) {
        const metaEl = document.createElement('div'); metaEl.className = 'msg-meta'; metaEl.innerHTML = meta;
        li.appendChild(metaEl);
      }
      frag.appendChild(li);
      prev = m;
    });
    ol.replaceChildren(frag);

    if (S.focusMsg !== null && S.loaded) {
      const target = ol.querySelector('[data-i="' + S.focusMsg + '"]');
      S.focusMsg = null;
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1800);
        return;
      }
    }
    if (jump || near) scrollToBottom();
    else $('#scroller').scrollTop = prevTop;
  }

  /* ------------------------------------------------------------- composer */

  const input = $('#input');

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  function updateSend() { $('#send').disabled = !input.value.trim(); }

  function drafts() { try { return JSON.parse(store.get(LS.drafts, '{}')) || {}; } catch { return {}; } }
  function saveDraft() {
    if (S.editing) return;
    const d = drafts();
    const k = S.openId || '_new';
    if (input.value.trim()) d[k] = input.value; else delete d[k];
    store.set(LS.drafts, JSON.stringify(d));
  }
  function loadDraft() {
    input.value = drafts()[S.openId || '_new'] || '';
    autosize(); updateSend();
  }

  function setReply(m) {
    S.replyTo = m ? { id: m.id, from: m.from, text: clip(m.text.replace(/\s+/g, ' '), 140) } : null;
    if (m) S.editing = null;
    renderChip();
  }
  function setEditing(m) {
    if (m && !S.editing) saveDraft();
    S.editing = m ? { i: m.i, chat: S.openId } : null;
    if (m) { S.replyTo = null; input.value = m.text; autosize(); updateSend(); input.focus(); }
    renderChip();
  }
  function renderChip() {
    const chip = $('#composer-chip');
    if (S.editing) {
      chip.hidden = false;
      chip.querySelector('use').setAttribute('href', '#i-pencil');
      $('#composer-chip-text').textContent = 'Editing your message';
    } else if (S.replyTo) {
      chip.hidden = false;
      chip.querySelector('use').setAttribute('href', '#i-reply');
      $('#composer-chip-text').textContent = 'Replying to ' + (S.replyTo.from === S.role ? 'yourself' : NAMES[S.replyTo.from]) + ': ' + S.replyTo.text;
    } else chip.hidden = true;
  }
  $('#composer-chip-x').addEventListener('click', () => {
    const wasEditing = !!S.editing;
    S.replyTo = null; S.editing = null; renderChip();
    if (wasEditing) loadDraft();
    input.focus();
  });

  let typingKick;
  input.addEventListener('input', () => {
    autosize(); updateSend();
    S.lastKeyAt = Date.now();
    if (!S.typingSent && input.value.trim() && !S.editing) {
      clearTimeout(typingKick);
      typingKick = setTimeout(sync, 250);
    }
    clearTimeout(input._save);
    input._save = setTimeout(saveDraft, 400);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH) { e.preventDefault(); $('#composer').requestSubmit(); }
    if (e.key === 'Escape' && (S.replyTo || S.editing)) { e.preventDefault(); $('#composer-chip-x').click(); }
    if (e.key === 'ArrowUp' && !input.value && !S.editing) {
      const mine = [...S.msgs].reverse().find((m) => m.from === S.role && !m.deleted);
      if (mine) { e.preventDefault(); setEditing(mine); }
    }
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    if (S.editing) {
      const ed = S.editing;
      setEditing(null);
      input.value = ''; autosize(); updateSend();
      loadDraft();
      try { await api('messages', { method: 'PATCH', body: { chat: ed.chat, i: ed.i, text } }); sync(); }
      catch (err) { toast(err.message); }
      return;
    }

    const p = { tempId: 't' + Date.now() + Math.random().toString(36).slice(2, 6), text, replyTo: S.replyTo, at: Date.now(), state: 'sending' };
    S.pending.push(p);
    input.value = ''; autosize(); updateSend();
    setReply(null);
    const d = drafts(); delete d[S.openId || '_new']; store.set(LS.drafts, JSON.stringify(d));
    $('#empty').hidden = true;
    renderMessages(true);
    sendPending(p);
  });

  async function sendPending(p) {
    const chatId = S.openId;
    p.state = 'sending';
    try {
      const d = await api('messages', { method: 'POST', body: { chat: chatId, text: p.text, replyTo: p.replyTo } });
      p.id = d.message.id; p.state = 'sent';
      if (!chatId && !S.openId) {
        S.openId = d.chat.id;
        S.loaded = true; // pending stays visible until sync brings the real message
        store.set(LS.last + '.' + S.role, d.chat.id);
        $('#shell').classList.add('viewing');
      }
      S.ver = undefined;
      sync();
    } catch (err) {
      p.state = 'failed';
      renderMessages(false);
      toast(err.message);
    }
  }

  /* --------------------------------------------------------------- events */

  $('#messages').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const li = e.target.closest('.msg');
    if (!btn) {
      if (TOUCH && li && !e.target.closest('a')) {
        document.querySelectorAll('.msg.show-actions').forEach((x) => x !== li && x.classList.remove('show-actions'));
        li.classList.toggle('show-actions');
      }
      return;
    }
    const act = btn.dataset.act;
    if (act === 'retry') {
      const p = S.pending.find((x) => x.tempId === li.dataset.temp);
      if (p) { p.state = 'sending'; renderMessages(false); sendPending(p); }
      return;
    }
    if (act === 'goto') {
      const ref = S.msgs.find((m) => m.id === btn.dataset.ref);
      const target = ref && $('#messages').querySelector('[data-i="' + ref.i + '"]');
      if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1600); }
      return;
    }
    const m = S.msgs.find((x) => String(x.i) === li.dataset.i);
    if (!m) return;
    if (act === 'reply') { setReply(m); input.focus(); }
    if (act === 'copy') copy(m.text);
    if (act === 'edit') setEditing(m);
    if (act === 'delete') {
      const ok = await dialog({ title: 'Delete this message?', text: 'It will be removed for both of you.', ok: 'Delete', danger: true });
      if (!ok) return;
      try { await api('messages', { method: 'DELETE', body: { chat: S.openId, i: m.i } }); sync(); }
      catch (err) { toast(err.message); }
    }
  });

  $('#chat-list').addEventListener('click', (e) => {
    const row = e.target.closest('.chat-row');
    if (!row) return;
    const i = row.dataset.i;
    openChat(row.dataset.id, { focusMsg: i !== undefined ? Number(i) : null });
  });

  document.querySelectorAll('.filter').forEach((f) => f.addEventListener('click', () => {
    S.filter = f.dataset.filter;
    document.querySelectorAll('.filter').forEach((x) => x.setAttribute('aria-selected', String(x === f)));
    renderList();
  }));

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    S.search = e.target.value;
    S.results = null;
    renderList();
    clearTimeout(searchTimer);
    const q = S.search.trim();
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      try {
        const d = await api('search?q=' + encodeURIComponent(q));
        if (S.search.trim() === q) { S.results = d.results; renderList(); }
      } catch { /* ignore */ }
    }, 350);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; S.search = ''; S.results = null; renderList(); e.target.blur(); }
    if (e.key === 'Enter') { const first = $('#chat-list .chat-row'); if (first) first.click(); }
  });

  $('#new-chat').addEventListener('click', () => startNew());
  $('#back-btn').addEventListener('click', backToList);

  $('#pin-btn').addEventListener('click', async () => {
    const c = S.chatMap.get(S.openId); if (!c) return;
    try { await api('chats', { method: 'PATCH', body: { id: c.id, pinned: !c.pinned } }); toast(c.pinned ? 'Unpinned' : 'Pinned'); S.ver = undefined; sync(); }
    catch (err) { toast(err.message); }
  });
  $('#rename-btn').addEventListener('click', async () => {
    const c = S.chatMap.get(S.openId); if (!c) return;
    const title = await dialog({ title: 'Rename chat', input: c.title, ok: 'Save' });
    if (!title || title === c.title) return;
    try { await api('chats', { method: 'PATCH', body: { id: c.id, title } }); S.ver = undefined; sync(); }
    catch (err) { toast(err.message); }
  });
  $('#delete-btn').addEventListener('click', async () => {
    const c = S.chatMap.get(S.openId); if (!c) return;
    const ok = await dialog({ title: 'Delete this chat?', text: '“' + c.title + '” and all its messages will be removed for both of you. This can’t be undone.', ok: 'Delete chat', danger: true });
    if (!ok) return;
    try {
      await api('chats', { method: 'DELETE', body: { id: c.id } });
      toast('Chat deleted');
      startNew({ quiet: true });
      if (narrow()) backToList();
      S.ver = undefined; sync();
    } catch (err) { toast(err.message); }
  });

  /* menu */
  const menu = $('#menu');
  const menuBtn = $('#menu-btn');
  function openMenu() {
    const items = [];
    const hasNotify = ('Notification' in window) || (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications);
    if (hasNotify) items.push(['notify', 'i-bell', 'Notifications', notificationsOn() ? 'On' : 'Off']);
    if (!IS_APP) {
      items.push(['switch', 'i-swap', 'Switch to ' + NAMES[other()], '']);
      items.push(['link', 'i-link', 'Copy sign-in link', '']);
      items.push(['apps', 'i-download', 'Get the Windows and Android apps', '']);
      items.push('hr');
      items.push(['signout', 'i-logout', 'Sign out', '', 'danger']);
    } else {
      items.push(['apps', 'i-download', 'Check for a newer version', '']);
    }
    menu.innerHTML = items.map((it) => it === 'hr' ? '<hr>' :
      '<button role="menuitem" data-m="' + it[0] + '" class="' + (it[4] || '') + '">' + icon(it[1]) + '<span>' + esc(it[2]) + '</span>' + (it[3] ? '<span class="menu-meta">' + esc(it[3]) + '</span>' : '') + '</button>').join('') +
      '<hr><button role="menuitem" disabled style="cursor:default;color:var(--ink-3);font-size:12px">Version ' + esc(CFG.version) + ' · ' + esc(S.storage === 'redis' ? 'saved in the cloud' : S.storage === 'file' ? 'saved locally' : 'not saved yet') + '</button>';
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('button:not([disabled])'); if (first) first.focus();
  }
  function closeMenu() { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    closeMenu();
    const m = b.dataset.m;
    if (m === 'notify') toggleNotifications();
    if (m === 'switch') {
      S.as = other(); store.set(LS.as, S.as);
      S.ver = undefined; S.firstLoad = true; S.lastHeartbeat = 0;
      connect();
    }
    if (m === 'link') {
      const url = location.origin + location.pathname + '?key=' + encodeURIComponent(S.key) + '&as=instinct';
      copy(url);
    }
    if (m === 'apps') window.open(CFG.releasesUrl, '_blank', 'noopener');
    if (m === 'signout') {
      const ok = await dialog({ title: 'Sign out of this browser?', text: 'You’ll need the passkey to open the chats here again.', ok: 'Sign out', danger: true });
      if (ok) signOut();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (narrow()) backToList(); $('#search').focus(); }
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); menuBtn.focus(); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); else saveDraft(); });
  window.addEventListener('focus', () => sync());
  window.addEventListener('online', () => sync());

  /* Android back button inside the app */
  const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (capApp) {
    capApp.addListener('backButton', () => {
      if (!$('#dialog').open && $('#shell').classList.contains('viewing') && narrow()) backToList();
      else capApp.minimizeApp ? capApp.minimizeApp() : capApp.exitApp();
    });
    capApp.addListener('resume', () => sync());
  }
  const capNotif = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (capNotif) {
    capNotif.addListener('localNotificationActionPerformed', (a) => { const id = a?.notification?.extra?.chatId; if (id) openChat(id); });
    if (notificationsOn()) capNotif.requestPermissions().catch(() => {});
  }
  if (window.midoNative && window.midoNative.onOpenChat) window.midoNative.onOpenChat((id) => openChat(id));

  boot();
})();
