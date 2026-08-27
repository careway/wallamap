import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, WallapopError } from './lib/wallapop.js';
import { aggregate, clampCellZ, K_ANONYMITY, MAX_CELL_Z } from './lib/privacy.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MAX_PAGES = 5;                       // 5 x 40 = 200 anuncios por búsqueda
const SEARCH_TTL_MS = 10 * 60 * 1000;      // vida de una búsqueda cacheada
const MAX_SEARCHES = 60;
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

/** searchId -> { at, items, query }. Reagrupar por zoom sale de aquí, no de Wallapop. */
const searches = new Map();
const hits = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { n: 1, reset: now + RATE_LIMIT.windowMs });
    return false;
  }
  entry.n++;
  return entry.n > RATE_LIMIT.max;
}

function num(value, { min = -Infinity, max = Infinity, fallback } = {}) {
  // Ojo: Number(null) y Number('') son 0, así que un parámetro ausente se
  // colaría como un filtro real (minPrice=0, distance=500...). Se descarta antes.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function sweep() {
  const cutoff = Date.now() - SEARCH_TTL_MS;
  for (const [id, entry] of searches) if (entry.at < cutoff) searches.delete(id);
  while (searches.size > MAX_SEARCHES) searches.delete(searches.keys().next().value);
}

/** Respuesta común: celdas para un nivel de zoom concreto. */
function cellsResponse(entry, cellZ, extra = {}) {
  const { cells, stats } = aggregate(entry.items, { cellZ, k: K_ANONYMITY });
  return {
    searchId: entry.id,
    query: entry.query,
    cells,
    stats: { ...stats, maxCellZ: MAX_CELL_Z, fetched: entry.items.length },
    ...extra,
  };
}

async function handleSearch(url, res) {
  const q = url.searchParams;
  const keywords = (q.get('keywords') ?? '').trim().slice(0, 120);
  if (!keywords) return json(res, 400, { error: 'Falta el parámetro "keywords"' });

  const latitude = num(q.get('lat'), { min: -90, max: 90 });
  const longitude = num(q.get('lon'), { min: -180, max: 180 });
  if (latitude === undefined || longitude === undefined) {
    return json(res, 400, { error: 'Faltan las coordenadas del centro de búsqueda (lat/lon)' });
  }

  const params = {
    keywords,
    latitude: Number(latitude.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
    pages: num(q.get('pages'), { min: 1, max: MAX_PAGES, fallback: 3 }),
    minPrice: num(q.get('minPrice'), { min: 0, fallback: undefined }),
    maxPrice: num(q.get('maxPrice'), { min: 0, fallback: undefined }),
    distance: num(q.get('distance'), { min: 500, max: 1_000_000, fallback: undefined }),
    order: q.get('order') ?? 'most_relevance',
  };
  const cellZ = clampCellZ(num(q.get('cellZ'), { fallback: MAX_CELL_Z }));

  sweep();
  const id = createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16);
  let entry = searches.get(id);
  const fresh = entry && Date.now() - entry.at < SEARCH_TTL_MS;

  if (!fresh) {
    const { items, hasMore } = await search(params);
    entry = { id, at: Date.now(), items, hasMore, query: params };
    searches.set(id, entry);
  }

  json(res, 200, cellsResponse(entry, cellZ, { cached: Boolean(fresh), hasMore: entry.hasMore }));
}

/** Reagrupa una búsqueda ya descargada a otro nivel de detalle. */
function handleCells(url, res) {
  const entry = searches.get(url.searchParams.get('searchId') ?? '');
  if (!entry || Date.now() - entry.at > SEARCH_TTL_MS) {
    return json(res, 404, { error: 'La búsqueda ha caducado', expired: true });
  }
  const cellZ = clampCellZ(num(url.searchParams.get('cellZ'), { fallback: MAX_CELL_Z }));
  json(res, 200, cellsResponse(entry, cellZ, { cached: true, hasMore: entry.hasMore }));
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (rel.startsWith('..')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const file = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, {
      'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Método no permitido' });
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, searches: searches.size });

      const ip = req.socket.remoteAddress ?? 'unknown';
      if (url.pathname === '/api/cells') return handleCells(url, res);   // no toca Wallapop
      if (rateLimited(ip)) return json(res, 429, { error: 'Demasiadas búsquedas seguidas, espera un momento' });
      if (url.pathname === '/api/search') return await handleSearch(url, res);
      return json(res, 404, { error: 'Endpoint desconocido' });
    }
    await serveStatic(url.pathname, res);
  } catch (err) {
    if (err instanceof WallapopError) return json(res, err.status ?? 502, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Error interno' });
  }
});

server.listen(PORT, () => {
  console.log(`Wallapop Mapper escuchando en http://localhost:${PORT}`);
});
