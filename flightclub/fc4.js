// FLIGHT CLUB — fc4.js : plain form-POST login/register, HTML-aware, overlay logging
(async () => {
  const out = { steps: [], pages: {}, js: {}, attempts: [] };

  // ---- on-screen overlay ----
  const ov = document.createElement('div');
  ov.id = 'fc-overlay';
  ov.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483647;background:#111;color:#7CFC00;font:12px/1.5 monospace;width:560px;max-height:45vh;overflow:auto;border:2px solid #7CFC00;padding:10px;white-space:pre-wrap;word-break:break-all';
  document.body.appendChild(ov);
  const log = (s) => { out.steps.push(s); ov.textContent = (ov.textContent + s + '\n').slice(-4000); ov.scrollTop = ov.scrollHeight; console.log('[fc]', s); };

  const rnd = () => Math.random().toString(36).slice(2, 10);
  const USER = 'fcprobe' + rnd();
  const PASS = 'FcPr0be!' + rnd().toUpperCase();
  log('RUNNING on ' + location.host);
  log('creds: ' + USER + ' / ' + PASS);

  const get = async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    const b = await r.text();
    out.pages[p] = { status: r.status, ct: r.headers.get('content-type'), body: b };
    log('GET ' + p + ' -> ' + r.status);
    return out.pages[p];
  };

  // 1) raw pages
  for (const p of ['/login', '/register', '/console', '/', '/docs/legacy-import']) await get(p);

  // 2) parse form markup
  const parseForm = (html) => {
    if (!html || typeof html.body !== 'string') return null;
    const m = html.body.match(/<form[^>]*>/i);
    if (!m) return { raw: 'NO <form> TAG' };
    const attrs = {};
    for (const a of m[0].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2];
    const inputs = [];
    for (const i of html.body.matchAll(/<input[^>]*>/gi)) {
      const t = i[0];
      const name = (t.match(/name="([^"]*)"/) || [])[1];
      const type = (t.match(/type="([^"]*)"/) || [])[1] || 'text';
      const value = (t.match(/value="([^"]*)"/) || [])[1];
      const id = (t.match(/id="([^"]*)"/) || [])[1];
      inputs.push({ name, type, value: value ? value.slice(0, 120) : null, id });
    }
    return { tag: m[0], attrs, inputs };
  };
  for (const p of ['/login', '/register']) {
    const f = parseForm(out.pages[p]);
    out['formInfo' + p] = f;
    log('FORM ' + p + ': ' + JSON.stringify(f).slice(0, 500));
  }

  // 3) form-encoded POSTs to the PAGE urls with every name combo
  const hidden = (html) => {
    const h = {};
    if (!html || typeof html.body !== 'string') return h;
    for (const i of html.body.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const name = (i[0].match(/name="([^"]*)"/) || [])[1];
      const value = (i[0].match(/value="([^"]*)"/) || [])[1] || '';
      if (name) h[name] = value;
    }
    return h;
  };
  const hReg = hidden(out.pages['/register']);
  const hLog = hidden(out.pages['/login']);
  log('hidden /register: ' + JSON.stringify(hReg) + '  hidden /login: ' + JSON.stringify(hLog));

  const namePairs = [
    { callsign: USER, clearance: PASS },
    { username: USER, password: PASS },
    { callsign: USER, password: PASS },
    { username: USER, clearance: PASS },
  ];
  const postForm = async (path, bodyObj, extraHidden) => {
    const body = Object.assign({}, extraHidden || {}, bodyObj);
    try {
      const r = await fetch(path, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      const t = await r.text();
      const entry = { path, fields: Object.keys(bodyObj), status: r.status, finalUrl: r.url, setCookie: r.headers.get('set-cookie'), ct: r.headers.get('content-type'), body: t.slice(0, 1500) };
      out.attempts.push(entry);
      log('POST ' + path + ' [' + Object.keys(bodyObj).join(',') + '] -> ' + r.status + ' final=' + r.url.split(location.host)[1] + ' cookie=' + (r.headers.get('set-cookie') || '').slice(0, 60) + ' :: ' + t.slice(0, 120).replace(/\s+/g, ' '));
      return entry;
    } catch (e) { log('POST ' + path + ' ERR ' + e); return null; }
  };

  let registered = false;
  for (const np of namePairs) {
    const e = await postForm('/register', np, hReg);
    if (e && (e.status === 200 || e.setCookie) && !/not found|404/i.test(e.body)) { registered = true; log('REGISTER OK via ' + Object.keys(np).join(',')); break; }
  }
  log('register success: ' + registered);

  let loggedIn = false;
  for (const np of namePairs) {
    const e = await postForm('/login', np, hLog);
    if (e && (e.status === 200 || e.setCookie) && !/not found|404/i.test(e.body)) { loggedIn = true; break; }
  }
  log('login success: ' + loggedIn + ' | cookie=' + document.cookie);

  // 4) if logged in — grab console
  if (loggedIn) {
    await get('/console');
    log('console status: ' + out.pages['/console'].status);
  }

  // 5) collect JS chunks
  const srcs = new Set();
  for (const p in out.pages) {
    const b = out.pages[p].body;
    if (typeof b !== 'string') continue;
    for (const m of b.matchAll(/src="([^"]+\.js)"/g)) srcs.add(m[1]);
    for (const m of b.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.(?:js|css))"/g)) srcs.add(m[1]);
  }
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
