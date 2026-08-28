// server.js — ANTES de cualquier otro import que use fetch
import { ProxyAgent, setGlobalDispatcher } from 'undici';

if (process.env.HTTPS_PROXY) {
  setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
}

// resto de imports (incluyendo el cliente de Wallapop)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, WallapopError } from './lib/wallapop.js';
import { aggregate, clampCellZ, K_ANONYMITY, MAX_CELL_Z } from './lib/privacy.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MAX_PAGES = 5;                       // 5 x 40 = 200 anuncios por tile
const SESSION_TTL_MS = 10 * 60 * 1000;     // vida de una sesión de búsqueda
const MAX_SESSIONS = 60;
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

// --- búsqueda progresiva ---
// Una sesión es una búsqueda (keywords + filtros) que va acumulando *tiles*:
// cada tile es una petición a Wallapop centrada en un punto, con sus anuncios
// recortados al radio del filtro de distancia. Al panear, el navegador mira si
// el centro cae fuera de los tiles ya traídos y pide otro con /api/extend; el
// servidor lo fusiona con los que ya tenía. Los tiles más viejos se descartan.
//
// Wallapop ignora el parámetro `distance`, así que el radio se aplica aquí.
const MAX_ANCHORS = 14;                    // tiles simultáneos por sesión
const OPEN_TILE_KM = 20;                   // radio de tile cuando no hay filtro de distancia
const TRIM_MARGIN = 1.1;                   // margen al recortar por radio

/** searchId -> { id, at, filters, trim, tileKm, anchors:[{lat,lon,items}] }.
 *  Reagrupar por zoom y fusionar tiles sale de aquí, no de Wallapop. */
const sessions = new Map();
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

function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, entry] of sessions) if (entry.at < cutoff) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function liveSession(id) {
  const entry = sessions.get(id ?? '');
  if (!entry || Date.now() - entry.at > SESSION_TTL_MS) return null;
  return entry;
}

/** Unión de todos los tiles de la sesión, deduplicada por id. */
function pool(entry) {
  const seen = new Set();
  const out = [];
  for (const anchor of entry.anchors) {
    for (const item of anchor.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * Respuesta común: celdas para un nivel de zoom concreto.
 *
 * Va con los centros de los tiles (`anchors`) y su radio: son puntos que ha
 * elegido el usuario moviendo el mapa, no ubicaciones de anuncios, así que
 * publicarlos no rompe nada y le ahorra al navegador una petición por paneo
 * para saber si la zona que mira ya está cubierta.
 */
function cellsResponse(entry, cellZ, extra = {}) {
  const items = pool(entry);
  const { cells, stats } = aggregate(items, { cellZ: clampCellZ(cellZ ?? MAX_CELL_Z), k: K_ANONYMITY });
  return {
    searchId: entry.id,
    query: entry.filters,
    cells,
    anchors: entry.anchors.map((a) => ({ lat: a.lat, lon: a.lon })),
    tileKm: entry.tileKm,
    stats: { ...stats, maxCellZ: MAX_CELL_Z, fetched: items.length, tiles: entry.anchors.length },
    ...extra,
  };
}

/** Trae un tile centrado en (lat, lon) y lo fusiona en la sesión. */
async function fetchTile(entry, lat, lon) {
  const f = entry.filters;
  const { items } = await search({
    keywords: f.keywords,
    latitude: Number(lat.toFixed(4)),
    longitude: Number(lon.toFixed(4)),
    pages: f.pages,
    minPrice: f.minPrice,
    maxPrice: f.maxPrice,
    distance: entry.trim ? Math.round(entry.tileKm * 1000) : undefined,
    order: f.order,
  });

  const center = { lat, lon };
  const kept = entry.trim
    ? items.filter((it) => distanceKm(center, { lat: it._lat, lon: it._lon }) <= entry.tileKm * TRIM_MARGIN)
    : items;

  entry.anchors.push({ lat, lon, items: kept });
  while (entry.anchors.length > MAX_ANCHORS) entry.anchors.shift();
  entry.at = Date.now();
}

/** Arranca una sesión nueva y trae su primer tile. */
async function handleSearch(url, res) {
  const q = url.searchParams;
  const keywords = (q.get('keywords') ?? '').trim().slice(0, 120);
  if (!keywords) return json(res, 400, { error: 'Falta el parámetro "keywords"' });

  const latitude = num(q.get('lat'), { min: -90, max: 90 });
  const longitude = num(q.get('lon'), { min: -180, max: 180 });
  if (latitude === undefined || longitude === undefined) {
    return json(res, 400, { error: 'Faltan las coordenadas del centro de búsqueda (lat/lon)' });
  }

  const distM = num(q.get('distance'), { min: 500, max: 1_000_000, fallback: undefined });
  const cellZ = clampCellZ(num(q.get('cellZ'), { fallback: MAX_CELL_Z }));

  sweep();
  // Cada búsqueda abre su propia sesión: como los tiles se van acumulando con el
  // paneo, compartirla entre navegadores mezclaría ciudades ajenas en el mapa.
  const entry = {
    id: randomBytes(8).toString('hex'),
    at: Date.now(),
    filters: {
      keywords,
      pages: num(q.get('pages'), { min: 1, max: MAX_PAGES, fallback: 3 }),
      minPrice: num(q.get('minPrice'), { min: 0, fallback: undefined }),
      maxPrice: num(q.get('maxPrice'), { min: 0, fallback: undefined }),
      order: q.get('order') ?? 'most_relevance',
    },
    trim: distM !== undefined,
    tileKm: distM !== undefined ? Math.min(120, Math.max(3, distM / 1000)) : OPEN_TILE_KM,
    anchors: [],
  };

  await fetchTile(entry, latitude, longitude);
  sessions.set(entry.id, entry);

  json(res, 200, cellsResponse(entry, cellZ, { extended: false }));
}

/** Trae un tile más para una sesión viva y devuelve el conjunto fusionado. */
async function handleExtend(url, res) {
  const entry = liveSession(url.searchParams.get('searchId'));
  if (!entry) return json(res, 404, { error: 'La búsqueda ha caducado', expired: true });

  const latitude = num(url.searchParams.get('lat'), { min: -90, max: 90 });
  const longitude = num(url.searchParams.get('lon'), { min: -180, max: 180 });
  if (latitude === undefined || longitude === undefined) {
    return json(res, 400, { error: 'Faltan las coordenadas del centro (lat/lon)' });
  }

  const cellZ = clampCellZ(num(url.searchParams.get('cellZ'), { fallback: MAX_CELL_Z }));
  await fetchTile(entry, latitude, longitude);
  json(res, 200, cellsResponse(entry, cellZ, { extended: true }));
}

/** Reagrupa lo ya descargado a otro nivel de detalle. No toca Wallapop. */
function handleCells(url, res) {
  const entry = liveSession(url.searchParams.get('searchId'));
  if (!entry) return json(res, 404, { error: 'La búsqueda ha caducado', expired: true });
  const cellZ = clampCellZ(num(url.searchParams.get('cellZ'), { fallback: MAX_CELL_Z }));
  json(res, 200, cellsResponse(entry, cellZ, { extended: false }));
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
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, searches: sessions.size });

      const ip = req.socket.remoteAddress ?? 'unknown';
      if (url.pathname === '/api/cells') return handleCells(url, res);   // no toca Wallapop
      if (rateLimited(ip)) return json(res, 429, { error: 'Demasiadas búsquedas seguidas, espera un momento' });
      if (url.pathname === '/api/search') return await handleSearch(url, res);
      if (url.pathname === '/api/extend') return await handleExtend(url, res);
      return json(res, 404, { error: 'Endpoint desconocido' });
    }
    await serveStatic(url.pathname, res);
  } catch (err) {
    if (err instanceof WallapopError) return json(res, err.status ?? 502, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Error interno' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Wallapop Mapper escuchando en http://localhost:${PORT}`);
});
