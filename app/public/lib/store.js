// Búsqueda progresiva en el navegador.
//
// Una "sesión" es una búsqueda (keywords + filtros) que va acumulando *tiles*:
// cada tile es una petición a Wallapop centrada en un punto, con sus anuncios
// recortados al radio del filtro de distancia. Al panear el mapa, `coverageGap`
// dice si el centro cae fuera de los tiles ya traídos; si es así, la app pide
// otro tile y `extendSearch` lo fusiona. Los tiles más viejos se descartan.
//
// Wallapop ignora el parámetro `distance`, así que el radio se aplica aquí.

import { search } from './wallapop.js';
import { aggregate, clampCellZ, K_ANONYMITY, MAX_CELL_Z } from './privacy.js';

const MAX_PAGES = 5;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_ANCHORS = 14;             // tiles simultáneos; los más viejos se tiran
const OPEN_TILE_KM = 20;            // radio de tile cuando no hay filtro de distancia
const REFETCH_FRACTION = 0.6;       // se pide tile nuevo si el centro se aleja > tileKm * esto
const VIEWPORT_FRACTION = 0.12;     // ...pero nunca antes de viewport * esto (menos peticiones al alejar)
const TRIM_MARGIN = 1.1;            // margen al recortar por radio

export class ExpiredError extends Error {
  constructor() {
    super('La búsqueda ha caducado');
    this.name = 'ExpiredError';
    this.expired = true;
  }
}

let session = null;
// session = { at, filters:{keywords,pages,minPrice,maxPrice,order}, tileKm, trim, anchors:[{lat,lon,items}] }

function num(value, { min = -Infinity, max = Infinity, fallback } = {}) {
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

/** Unión de todos los tiles, deduplicada por id. */
function pool() {
  const seen = new Set();
  const out = [];
  for (const anchor of session.anchors) {
    for (const item of anchor.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function cellsResponse(cellZ, extra = {}) {
  const items = pool();
  const { cells, stats } = aggregate(items, { cellZ: clampCellZ(cellZ ?? MAX_CELL_Z), k: K_ANONYMITY });
  return {
    cells,
    query: session.filters,
    stats: { ...stats, maxCellZ: MAX_CELL_Z, fetched: items.length, tiles: session.anchors.length },
    ...extra,
  };
}

async function fetchTile(lat, lon) {
  const f = session.filters;
  const { items } = await search({
    keywords: f.keywords,
    latitude: Number(lat.toFixed(4)),
    longitude: Number(lon.toFixed(4)),
    pages: f.pages,
    minPrice: f.minPrice,
    maxPrice: f.maxPrice,
    distance: session.trim ? Math.round(session.tileKm * 1000) : undefined,
    order: f.order,
  });

  const center = { lat, lon };
  const kept = session.trim
    ? items.filter((it) => distanceKm(center, { lat: it._lat, lon: it._lon }) <= session.tileKm * TRIM_MARGIN)
    : items;

  session.anchors.push({ lat, lon, items: kept });
  while (session.anchors.length > MAX_ANCHORS) session.anchors.shift();
  session.at = Date.now();
}

/**
 * Arranca una sesión nueva y trae el primer tile en (lat, lon).
 * @param {object} opts keywords, lat, lon, cellZ, pages, order, minPrice, maxPrice, distance (m)
 */
export async function startSearch(opts) {
  const keywords = (opts.keywords ?? '').trim().slice(0, 120);
  if (!keywords) throw new Error('Falta qué buscar');

  const lat = num(opts.lat, { min: -90, max: 90 });
  const lon = num(opts.lon, { min: -180, max: 180 });
  if (lat === undefined || lon === undefined) throw new Error('Faltan las coordenadas del centro de búsqueda');

  const distM = num(opts.distance, { min: 500, max: 1_000_000, fallback: undefined });
  session = {
    at: Date.now(),
    filters: {
      keywords,
      pages: num(opts.pages, { min: 1, max: MAX_PAGES, fallback: 3 }),
      minPrice: num(opts.minPrice, { min: 0, fallback: undefined }),
      maxPrice: num(opts.maxPrice, { min: 0, fallback: undefined }),
      order: opts.order ?? 'most_relevance',
    },
    trim: distM !== undefined,
    tileKm: distM !== undefined ? Math.min(120, Math.max(3, distM / 1000)) : OPEN_TILE_KM,
    anchors: [],
  };

  await fetchTile(lat, lon);
  return cellsResponse(opts.cellZ, { extended: false });
}

export function hasSession() {
  return Boolean(session) && Date.now() - session.at <= SESSION_TTL_MS;
}

/**
 * ¿El punto (lat, lon) cae fuera de todos los tiles ya traídos?
 * @param {number} viewportKm ancho aproximado del mapa en km (para pedir menos al alejar)
 */
export function coverageGap(lat, lon, viewportKm = 0) {
  if (!session || !session.anchors.length) return false;
  const need = Math.max(session.tileKm * REFETCH_FRACTION, viewportKm * VIEWPORT_FRACTION);
  const nearest = Math.min(...session.anchors.map((a) => distanceKm(a, { lat, lon })));
  return nearest > need;
}

/** Trae un tile más en (lat, lon) y lo fusiona. */
export async function extendSearch({ lat, lon, cellZ }) {
  if (!hasSession()) throw new ExpiredError();
  await fetchTile(lat, lon);
  return cellsResponse(cellZ, { extended: true });
}

/** Reagrupa lo que ya hay a otro nivel de detalle, sin pedir nada. */
export function recell({ cellZ }) {
  if (!hasSession()) throw new ExpiredError();
  return cellsResponse(cellZ, { extended: false });
}
