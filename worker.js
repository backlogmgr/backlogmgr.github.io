// Worker de BacklogMGR para Cloudflare: proxy de SteamGridDB + sincronización + duraciones de HowLongToBeat.
//
// Sincronización: guarda un texto CIFRADO por la app (el Worker nunca ve tus juegos) bajo un identificador
// derivado de tu código. Necesita un almacén KV enlazado con el nombre SYNC (ver README).
//
// Solo acepta peticiones de las direcciones de tu app.
const ALLOWED_HOSTS = ['www.steamgriddb.com'];
// Direcciones desde las que se abre la app (solo https://dominio, sin barra final ni ruta)
const ALLOWED_ORIGINS = [
  'https://backlogmgr.github.io',               // la app publicada en GitHub Pages   
  'https://backlogmgr.backlogmgr.workers.dev'   // copia de la app servida desde Cloudflare (quítala si la borras)
];
const MAX_BYTES = 8 * 1024 * 1024;   // tamaño máximo de los datos sincronizados

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (!allowed) return text('forbidden origin: ' + origin, 403, cors);

    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return sync(req, env, url, cors);
    if (url.pathname === '/hltb') return hltb(url, cors);
    return proxy(req, url, cors);
  }
};

const text = (msg, status, cors) => new Response(msg, {status, headers: cors});
const json = (obj, cors) => new Response(JSON.stringify(obj), {headers: {...cors, 'Content-Type': 'application/json'}});

// ---------- sincronización ----------
// /sync                      → comprobación
// /sync/<id>                 → GET / PUT / DELETE de los datos cifrados
// /sync/<id>/snaps           → GET: fechas de las copias diarias
// /sync/<id>/snap/<AAAAMMDD> → GET / PUT de una copia diaria (caduca a los 14 días)
const SNAP_TTL = 14 * 24 * 3600;

async function sync(req, env, url, cors) {
  if (!env.SYNC) return text('KV no enlazado: falta el binding SYNC', 500, cors);
  const parts = url.pathname.split('/').filter(Boolean);      // ['sync', id, ...]
  if (parts.length === 1) return json({ok: true, kv: true}, cors);
  const id = parts[1];
  if (!/^[0-9a-f]{64}$/.test(id)) return text('bad id', 400, cors);
  const key = 'd:' + id;

  if (parts.length === 2) {
    if (req.method === 'GET') {
      const v = await env.SYNC.get(key);
      if (v === null) return text('not found', 404, cors);
      return new Response(v, {headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
    }
    if (req.method === 'PUT') {
      const body = await readBody(req, cors); if (body instanceof Response) return body;
      await env.SYNC.put(key, body);
      return json({ok: true}, cors);
    }
    if (req.method === 'DELETE') {
      await env.SYNC.delete(key);
      const l = await env.SYNC.list({prefix: 's:' + id + ':'});
      for (const k of l.keys) await env.SYNC.delete(k.name);
      return json({ok: true}, cors);
    }
    return text('method not allowed', 405, cors);
  }

  if (parts.length === 3 && parts[2] === 'snaps' && req.method === 'GET') {
    const l = await env.SYNC.list({prefix: 's:' + id + ':'});
    return json({dates: l.keys.map(k => k.name.slice(-8)).sort().reverse()}, cors);
  }

  if (parts.length === 4 && parts[2] === 'snap' && /^\d{8}$/.test(parts[3])) {
    const sk = 's:' + id + ':' + parts[3];
    if (req.method === 'GET') {
      const v = await env.SYNC.get(sk);
      if (v === null) return text('not found', 404, cors);
      return new Response(v, {headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
    }
    if (req.method === 'PUT') {
      if (await env.SYNC.get(sk) !== null) return json({ok: true, kept: true}, cors);   // la primera copia del día es la que vale
      const body = await readBody(req, cors); if (body instanceof Response) return body;
      await env.SYNC.put(sk, body, {expirationTtl: SNAP_TTL});
      return json({ok: true}, cors);
    }
    return text('method not allowed', 405, cors);
  }
  return text('not found', 404, cors);
}

async function readBody(req, cors) {
  if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return text('too large', 413, cors);
  const body = await req.text();
  if (body.length > MAX_BYTES) return text('too large', 413, cors);
  // Comprobación barata (sin interpretar el JSON entero, para no gastar CPU)
  if (!body.startsWith('{"v":1,"iv":"')) return text('bad body', 400, cors);
  return body;
}

// ---------- proxy de SteamGridDB ----------
async function proxy(req, url, cors) {
  if (req.method !== 'GET') return text('method not allowed', 405, cors);
  let target;
  try { target = new URL(url.searchParams.get('url')); }
  catch (_) { return text('bad url', 400, cors); }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.hostname))
    return text('forbidden host', 403, cors);

  const h = new Headers({'Accept': 'application/json', 'User-Agent': 'mi-backlog-proxy'});
  const auth = req.headers.get('Authorization');
  if (auth) h.set('Authorization', auth);
  try {
    const r = await fetch(target.toString(), {headers: h});
    const res = new Response(r.body, r);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch (e) {
    return text('upstream error: ' + e.message, 502, cors);
  }
}

// ---------- HowLongToBeat (NO oficial) ----------
// /hltb?q=<título>   → {ok, results:[{id, name, year, main, plus, full, platforms}]}   (horas; 0 = sin dato)
// /hltb?diag=1       → pasos de la consulta, para ver dónde falla si algún día deja de funcionar
// HowLongToBeat no tiene API pública y renombra su endpoint de vez en cuando (/api/search, /api/find, /api/bleed, /api/search/site…).
// Por eso, si la ruta conocida da 404, el Worker la vuelve a descubrir leyendo los scripts de su propia web.
const HLTB = 'https://howlongtobeat.com';
const HLTB_H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*', 'Origin': HLTB, 'Referer': HLTB + '/'
};
const HLTB_PATHS = ['/api/search/site', '/api/bleed', '/api/search', '/api/find'];   // por orden de probabilidad
let hltbKnown = {path: '', variant: 0};   // lo que funcionó la última vez (se conserva mientras el Worker sigue «caliente»)
const hrs = s => { s = +s || 0; return s > 0 ? Math.max(0.5, Math.round(s / 1800) / 2) : 0; };   // segundos → horas (de 0,5 en 0,5)

async function hltbDiscover(steps) {   // busca en los scripts de la web la ruta que hace GET <ruta>/init?t=
  try {
    const home = await fetch(HLTB + '/', {headers: {...HLTB_H, Accept: 'text/html'}});
    steps.push({step: 'discover home', status: home.status});
    if (!home.ok) return '';
    const html = await home.text(), chunks = [...new Set([...html.matchAll(/["'](\/_next\/static\/chunks\/[^"']+\.js)["']/g)].map(m => m[1]))];
    steps.push({step: 'discover chunks', n: chunks.length});
    // los de «pages/_app» y «layout» suelen ser los que llevan la llamada; se prueban primero
    chunks.sort((a, b) => (/(_app|layout|main|search)/.test(b) ? 1 : 0) - (/(_app|layout|main|search)/.test(a) ? 1 : 0));
    for (const c of chunks.slice(0, 14)) {
      const r = await fetch(HLTB + c, {headers: HLTB_H}); if (!r.ok) continue;
      const m = (await r.text()).match(/["'`](\/api\/[A-Za-z0-9_\-/]+?)\/init\?t=/);
      if (m) { steps.push({step: 'discover found', path: m[1]}); return m[1]; }
    }
  } catch (e) { steps.push({step: 'discover error', note: String(e && e.message || e).slice(0, 80)}); }
  return '';
}

const incl = (values = []) => ({mode: 'include', values});
function hltbPayload(variant, terms, auth) {
  const rt = {min: null, max: null}, gp = {perspective: incl(), flow: incl(), genre: incl()}, base = {userId: 0, sortCategory: 'popular', rangeCategory: 'main', rangeTime: rt, modifier: ''};
  const games = [
    {...base, platform: incl(), gameplay: gp, year: incl()},                                                                  // formato actual (facetas {mode, values})
    {...base, platform: incl(), gameplay: gp, year: {min: '', max: ''}},                                                      // año como rango
    {...base, platform: incl(), gameplay: gp, year: {min: null, max: null}},                                                  // año como rango nulo
    {...base, platform: incl(), gameplay: gp},                                                                                // sin año
    {...base, platform: incl(), gameplay: {...gp, difficulty: incl()}, rangeYear: {min: '', max: ''}},                        // variante intermedia
    {...base, platform: '', gameplay: {perspective: '', flow: '', genre: '', difficulty: ''}, rangeYear: {min: '', max: ''}}   // formato antiguo
  ][variant];
  const body = {searchType: 'games', searchTerms: terms, searchPage: 1, size: 20,
    searchOptions: {games, users: {sortCategory: 'postcount'}, lists: {sortCategory: 'follows'}, filter: '', sort: 0, randomizer: 0}, useCache: true};
  if (auth.hpKey) body[auth.hpKey] = auth.hpVal;
  return body;
}
const HLTB_VARIANTS = 6;

async function hltbToken(path, steps) {   // el token lleva la IP de quien lo pide: se pide y se usa desde el mismo Worker
  const r = await fetch(`${HLTB}${path}/init?t=${Date.now()}`, {headers: HLTB_H});
  steps.push({step: 'init ' + path, status: r.status});
  if (r.status === 429) return {rate: true};
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (j && typeof j.token === 'string' && j.token) return {path, token: j.token, hpKey: j.hpKey, hpVal: j.hpVal};
  steps.push({step: 'init ' + path, note: 'sin token en la respuesta'}); return null;
}

const pick = (g, ...ks) => { for (const k of ks) if (g[k] !== undefined && g[k] !== null) return g[k]; return 0; };
function hltbGame(g) {
  const plat = pick(g, 'profile_platform', 'platforms'), pl = Array.isArray(plat) ? plat : String(plat || '').split(',');
  return {id: +pick(g, 'game_id', 'id') || 0, name: String(pick(g, 'game_name', 'name') || ''), year: +pick(g, 'release_world', 'releaseYear') || 0,
    main: hrs(pick(g, 'comp_main', 'gameplayMain')), plus: hrs(pick(g, 'comp_plus', 'gameplayMainExtra')), full: hrs(pick(g, 'comp_100', 'gameplayCompletionist', 'gameplayComplete')),
    platforms: pl.map(x => String(x).trim()).filter(Boolean)};
}

async function hltb(url, cors) {
  const diag = url.searchParams.get('diag') === '1';
  const q = (diag ? 'Celeste' : (url.searchParams.get('q') || '')).trim().slice(0, 100);
  if (!q) return json({ok: false, error: 'missing q'}, cors);
  const steps = [], fail = error => json({ok: false, error, steps}, cors);
  try {
    // 1) ruta + token
    let auth = null, tried = new Set(), rate = false;
    const attempt = async path => { if (!path || tried.has(path) || auth) return; tried.add(path); const a = await hltbToken(path, steps); if (a && a.rate) rate = true; else if (a) auth = a; };
    await attempt(hltbKnown.path);
    for (const p of HLTB_PATHS) { await attempt(p); if (auth || rate) break; }
    if (!auth && !rate) await attempt(await hltbDiscover(steps));
    if (rate) return fail('rate');
    if (!auth) return fail('token');
    // 2) búsqueda (se prueba el formato que funcionó y, si da error de formato, los demás)
    const terms = q.split(/\s+/).filter(Boolean), order = [hltbKnown.variant, ...[0, 1, 2, 3, 4, 5].filter(v => v !== hltbKnown.variant)];
    for (const v of order.slice(0, HLTB_VARIANTS)) {
      const h = {...HLTB_H, 'Content-Type': 'application/json', 'x-auth-token': auth.token};
      if (auth.hpKey) { h['x-hp-key'] = auth.hpKey; h['x-hp-val'] = auth.hpVal; }
      const r = await fetch(HLTB + auth.path, {method: 'POST', headers: h, body: JSON.stringify(hltbPayload(v, terms, auth))});
      steps.push({step: 'search ' + auth.path + ' v' + v, status: r.status});
      if (r.status === 429) return fail('rate');
      if (!r.ok) { if (diag || v === order[0]) { const t = await r.text().catch(() => ''); steps.push({step: 'body v' + v, note: t.replace(/\s+/g, ' ').slice(0, 120)}); } continue; }   // 400/403 también pueden ser «formato no válido»: se prueba el siguiente
      const d = await r.json().catch(() => null);
      if (!d || !Array.isArray(d.data)) { steps.push({step: 'format', note: 'sin lista de resultados'}); continue; }
      hltbKnown = {path: auth.path, variant: v};
      const results = d.data.slice(0, 20).map(hltbGame); steps.push({step: 'ok', results: results.length});
      return new Response(JSON.stringify({ok: true, results, ...(diag ? {steps} : {})}), {headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': diag ? 'no-store' : 'public, max-age=21600'}});
    }
    return fail('search');
  } catch (e) {
    steps.push({step: 'error', note: String(e && e.message || e).slice(0, 120)});
    return fail('network');
  }
}
