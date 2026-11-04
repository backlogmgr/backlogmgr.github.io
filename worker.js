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
  'https://hvck460.github.io',                  // dirección antigua de la app (quítala cuando ya no la uses)
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
// /hltb?q=<título>   → {ok, results:[{id, name, year, main, plus, full}]}   (horas; 0 = sin dato)
// /hltb?diag=1       → pasos de la consulta, para ver dónde falla si algún día deja de funcionar
// HowLongToBeat no tiene API pública: esto usa los mismos endpoints que su web y puede romperse si ellos los cambian.
const HLTB = 'https://howlongtobeat.com';
const HLTB_H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*', 'Origin': HLTB, 'Referer': HLTB + '/'
};
const hrs = s => { s = +s || 0; return s > 0 ? Math.max(0.5, Math.round(s / 1800) / 2) : 0; };   // segundos → horas (de 0,5 en 0,5)

async function hltb(url, cors) {
  const diag = url.searchParams.get('diag') === '1';
  const q = (diag ? 'Celeste' : (url.searchParams.get('q') || '')).trim().slice(0, 100);
  if (!q) return json({ok: false, error: 'missing q'}, cors);
  const steps = [], fail = (error) => json({ok: false, error, steps}, cors);
  try {
    // 1) token de búsqueda (lleva la IP de quien lo pide: por eso se pide y se usa desde el mismo Worker)
    let auth = null;
    for (const path of ['/api/search', '/api/find']) {
      const r = await fetch(`${HLTB}${path}/init?t=${Date.now()}`, {headers: HLTB_H});
      steps.push({step: 'init ' + path, status: r.status});
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (j && j.token) { auth = {path, token: j.token, hpKey: j.hpKey, hpVal: j.hpVal}; break; }
      steps.push({step: 'init ' + path, note: 'sin token en la respuesta'});
    }
    if (!auth) return fail('token');
    // 2) búsqueda
    const body = {
      searchType: 'games', searchTerms: q.split(/\s+/).filter(Boolean), searchPage: 1, size: 20,
      searchOptions: {
        games: {userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: {min: null, max: null},
          gameplay: {perspective: '', flow: '', genre: '', difficulty: ''}, rangeYear: {min: '', max: ''}, modifier: ''},
        users: {sortCategory: 'postcount'}, lists: {sortCategory: 'follows'}, filter: '', sort: 0, randomizer: 0
      },
      useCache: true
    };
    const h = {...HLTB_H, 'Content-Type': 'application/json', 'x-auth-token': auth.token};
    if (auth.hpKey) { h['x-hp-key'] = auth.hpKey; h['x-hp-val'] = auth.hpVal; body[auth.hpKey] = auth.hpVal; }
    const r = await fetch(HLTB + auth.path, {method: 'POST', headers: h, body: JSON.stringify(body)});
    steps.push({step: 'search ' + auth.path, status: r.status});
    if (!r.ok) return fail('search');
    const d = await r.json().catch(() => null);
    if (!d || !Array.isArray(d.data)) return fail('format');
    const results = d.data.slice(0, 20).map(g => ({id: +g.game_id || 0, name: String(g.game_name || ''), year: +g.release_world || 0, main: hrs(g.comp_main), plus: hrs(g.comp_plus), full: hrs(g.comp_100)}));
    steps.push({step: 'ok', results: results.length});
    return new Response(JSON.stringify({ok: true, results, ...(diag ? {steps} : {})}), {headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': diag ? 'no-store' : 'public, max-age=21600'}});
  } catch (e) {
    steps.push({step: 'error', note: String(e && e.message || e).slice(0, 120)});
    return fail('network');
  }
}
