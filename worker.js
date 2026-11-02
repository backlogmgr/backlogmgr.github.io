// Worker de BacklogMGR para Cloudflare: proxy de SteamGridDB + sincronización.
//
// Sincronización: guarda un texto CIFRADO por la app (el Worker nunca ve tus juegos) bajo un identificador
// derivado de tu código. Necesita un almacén KV enlazado con el nombre SYNC (ver README).
//
// Solo acepta peticiones de las direcciones de tu app.
const ALLOWED_HOSTS = ['www.steamgriddb.com'];
// Direcciones desde las que se abre la app (solo https://dominio, sin barra final ni ruta)
const ALLOWED_ORIGINS = [
  'https://hvck460.github.io',
  'https://backlogmgr.sluacesmartin.workers.dev',
  'https://backlogmgr.app'
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
    return proxy(req, url, cors);
  }
};

const text = (msg, status, cors) => new Response(msg, {status, headers: cors});
const json = (obj, cors) => new Response(JSON.stringify(obj), {headers: {...cors, 'Content-Type': 'application/json'}});

// ---------- sincronización ----------
async function sync(req, env, url, cors) {
  if (!env.SYNC) return text('KV no enlazado: falta el binding SYNC', 500, cors);
  const id = url.pathname.slice('/sync/'.length);
  if (url.pathname === '/sync' || url.pathname === '/sync/') return json({ok: true, kv: true}, cors);
  if (!/^[0-9a-f]{64}$/.test(id)) return text('bad id', 400, cors);
  const key = 'd:' + id;

  if (req.method === 'GET') {
    const v = await env.SYNC.get(key);
    if (v === null) return text('not found', 404, cors);
    return new Response(v, {headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
  }
  if (req.method === 'PUT') {
    if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return text('too large', 413, cors);
    const body = await req.text();
    if (body.length > MAX_BYTES) return text('too large', 413, cors);
    // Comprobación barata (sin interpretar el JSON entero, para no gastar CPU)
    if (!body.startsWith('{"v":1,"iv":"')) return text('bad body', 400, cors);
    await env.SYNC.put(key, body);
    return json({ok: true}, cors);
  }
  if (req.method === 'DELETE') {
    await env.SYNC.delete(key);
    return json({ok: true}, cors);
  }
  return text('method not allowed', 405, cors);
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
