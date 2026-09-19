// FLIGHT CLUB — fc2.js : 100% fetch-based, no navigation, self-diagnosing
(async () => {
  const out = { steps: [], api: {}, pages: {}, js: {}, actions: {}, results: {} };

  // ---- on-screen overlay (readable without console) ----
  const ov = document.createElement('div');
  ov.id = 'fc-overlay';
  ov.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483647;background:#111;color:#7CFC00;font:12px/1.5 monospace;width:520px;max-height:45vh;overflow:auto;border:2px solid #7CFC00;padding:10px;white-space:pre-wrap;word-break:break-all';
  document.body.appendChild(ov);
  const pushOv = (s) => { ov.textContent = (ov.textContent + s + '\n').slice(-3500); ov.scrollTop = ov.scrollHeight; };

  const log = (s) => { out.steps.push(s); pushOv(s); console.log('[fc]', s); };
  const rnd = () => Math.random().toString(36).slice(2, 10);
  const USER = 'fcprobe' + rnd();
  const PASS = 'FcPr0be!' + rnd().toUpperCase();
  log('RUNNING on ' + location.host);
  log('creds: ' + USER + ' / ' + PASS);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const get = async (p) => {
    try {
      const r = await fetch(p, { credentials: 'include' });
      const b = await r.text();
      out.pages[p] = { status: r.status, ct: r.headers.get('content-type'), body: b };
      log('GET ' + p + ' -> ' + r.status);
      return { status: r.status, body: b };
    } catch (e) { out.pages[p] = { error: String(e) }; log('GET ' + p + ' ERR ' + e); return null; }
  };

  // 1) public pages
  for (const p of ['/', '/login', '/register', '/docs/legacy-import', '/console']) await get(p);

  // 2) discover server-action ids from flight data
  const extractActions = (html) => {
    const ids = new Set();
    if (typeof html !== 'string') return ids;
    for (const m of html.matchAll(/A([0-9a-f]{16,80})/g)) ids.add(m[1]);
    for (const m of html.matchAll(/\\?"A([0-9a-f]{16,80})\\?"/g)) ids.add(m[1]);
    return ids;
  };
  for (const p of ['/login', '/register']) {
    out.actions[p] = [...extractActions(out.pages[p] && out.pages[p].body)];
    log('action ids ' + p + ': ' + JSON.stringify(out.actions[p]));
  }

  // 3) try POST /api/register and /api/login (plain handlers)
  const namePairs = [
    { callsign: USER, clearance: PASS },
    { username: USER, password: PASS },
    { callsign: USER, password: PASS },
    { username: USER, clearance: PASS },
  ];
  const tryApi = async (path, bodyObj, ct, extraHeaders) => {
    try {
      const headers = Object.assign({}, extraHeaders || {});
      if (ct === 'json') headers['Content-Type'] = 'application/json';
      else headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const r = await fetch(path, { method: 'POST', credentials: 'include', headers,
        body: ct === 'json' ? JSON.stringify(bodyObj) : new URLSearchParams(bodyObj).toString() });
      const t = await r.text();
      const entry = { status: r.status, body: t.slice(0, 2500), setCookie: r.headers.get('set-cookie'), ct: r.headers.get('content-type') };
      out.api[path + ':' + ct + (extraHeaders ? ':' + JSON.stringify(extraHeaders) : '')] = entry;
      log('POST ' + path + ' (' + ct + ') -> ' + r.status + ' ' + t.slice(0, 160).replace(/\s+/g, ' '));
      return entry;
    } catch (e) { log('POST ' + path + ' ERR ' + e); return null; }
  };
  let registered = false, loggedIn = false;
  for (const np of namePairs) {
    const e = await tryApi('/api/register', np, 'json');
    if (e && (e.status === 200 || e.status === 302 || e.setCookie || /created|success/i.test(e.body))) { registered = true; break; }
  }
  log('plain /api/register worked: ' + registered);
  for (const np of namePairs) {
    const e = await tryApi('/api/login', np, 'json');
    if (e && (e.status === 200 || e.status === 302 || e.setCookie)) { loggedIn = true; break; }
  }
  log('plain /api/login worked: ' + loggedIn);

  // 4) if not logged in: try Next.js server-action POSTs using discovered ids
  if (!loggedIn) {
    const postAction = async (path, id, bodyObj) => {
      try {
        const r = await fetch(path, { method: 'POST', credentials: 'include',
          headers: { 'Next-Action': id, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(bodyObj).toString() });
        const t = await r.text();
        const entry = { status: r.status, body: t.slice(0, 3000), setCookie: r.headers.get('set-cookie'), ct: r.headers.get('content-type') };
        out.results[path + '#' + id.slice(0, 12)] = entry;
        log('ACTION POST ' + path + ' ' + id.slice(0, 12) + ' -> ' + r.status + ' ' + t.slice(0, 160).replace(/\s+/g, ' '));
        return entry;
      } catch (e) { log('ACTION POST ' + path + ' ERR ' + e); return null; }
    };
    const regIds = out.actions['/register'] || [];
    const logIds = out.actions['/login'] || [];
    for (const id of regIds.slice(0, 4)) {
      const e = await postAction('/register', id, { callsign: USER, clearance: PASS });
      if (e && (e.status === 200 && /console|redirect|success/i.test(e.body))) { registered = true; }
      await sleep(300);
    }
    for (const id of logIds.slice(0, 4)) {
      const e = await postAction('/login', id, { callsign: USER, clearance: PASS });
      if (e && (e.status === 200 && /console|redirect/i.test(e.body))) { loggedIn = true; break; }
      await sleep(300);
    }
    // also try username/password flavor on first login id if still not in
    if (!loggedIn && logIds.length) {
      const e = await postAction('/login', logIds[0], { username: USER, password: PASS });
      if (e && (e.status === 200 && /console|redirect/i.test(e.body))) loggedIn = true;
    }
  }
  log('registered=' + registered + ' loggedIn=' + loggedIn + ' cookie=' + document.cookie);

  // 5) re-fetch /console (maybe authorized now)
  await get('/console');

  // 6) collect all JS chunks referenced anywhere + public page assets
  const srcs = new Set();
  const addSrcs = (h) => {
    if (typeof h !== 'string') return;
    for (const m of h.matchAll(/src="([^"]+\.js)"/g)) srcs.add(m[1]);
    for (const m of h.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.(?:js|css))"/g)) srcs.add(m[1]);
  };
  for (const p in out.pages) addSrcs(out.pages[p].body);
  for (const s of [...srcs].sort()) {
    try {
      const r = await fetch(s, { credentials: 'include' });
      out.js[s] = { status: r.status, body: await r.text() };
      log('asset ' + s + ' -> ' + r.status);
    } catch (e) { out.js[s] = { error: String(e) }; }
  }

  const blob = new Blob([JSON.stringify(out, null, 0)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'flightclub-dump.json';
  document.body.appendChild(a); a.click(); a.remove();
  log('DONE — attach flightclub-dump.json (' + (blob.size / 1024).toFixed(1) + 'KB)');
  ov.textContent += '\n===== DONE (attach flightclub-dump.json) =====\n';
})().catch(e => {
  console.log('[fc] FATAL', e);
  const o = document.getElementById('fc-overlay');
  if (o) { o.style.color = '#ff6b6b'; o.textContent += '\n===== FATAL: ' + e + ' =====\n'; }
});
