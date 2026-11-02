// Worker de BacklogMGR para Cloudflare: proxy de SteamGridDB + sincronización.
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
