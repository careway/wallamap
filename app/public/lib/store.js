// Orquesta búsqueda + agregación en el navegador. Antes esto vivía en server.js;
// ahora el cliente llama directo a Wallapop (`wallapop.js`) y agrupa por zonas
// (`privacy.js`) sin pasar por ningún backend.
//
// La caché por búsqueda se mantiene: cada cambio de zoom reagrupa los mismos
// anuncios a otro nivel de detalle sin volver a pedirle nada a Wallapop.

import { search } from './wallapop.js';
import { aggregate, clampCellZ, K_ANONYMITY, MAX_CELL_Z } from './privacy.js';

const MAX_PAGES = 5;                    // 5 x 40 = 200 anuncios por búsqueda
const SEARCH_TTL_MS = 10 * 60 * 1000;   // vida de una búsqueda cacheada
const MAX_SEARCHES = 20;

/** id -> { id, at, items, hasMore, query }. Reagrupar por zoom sale de aquí. */
const searches = new Map();

export class ExpiredError extends Error {
  constructor() {
    super('La búsqueda ha caducado');
    this.name = 'ExpiredError';
    this.expired = true;
  }
}

function num(value, { min = -Infinity, max = Infinity, fallback } = {}) {
  // Number(null) y Number('') son 0, así que un parámetro ausente se colaría
  // como filtro real (minPrice=0, distance=500...). Se descarta antes.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Hash estable de una cadena, en hex. Sólo tiene que ser determinista. */
function hashKey(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
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

/**
 * Descarga (o reutiliza de caché) una búsqueda y la agrupa al nivel pedido.
 * @param {object} opts keywords, lat, lon, cellZ, pages, order, minPrice, maxPrice, distance
 */
export async function searchCells(opts) {
  const keywords = (opts.keywords ?? '').trim().slice(0, 120);
  if (!keywords) throw new Error('Falta qué buscar');

  const latitude = num(opts.lat, { min: -90, max: 90 });
  const longitude = num(opts.lon, { min: -180, max: 180 });
  if (latitude === undefined || longitude === undefined) {
    throw new Error('Faltan las coordenadas del centro de búsqueda');
  }

  const params = {
    keywords,
    latitude: Number(latitude.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
    pages: num(opts.pages, { min: 1, max: MAX_PAGES, fallback: 3 }),
    minPrice: num(opts.minPrice, { min: 0, fallback: undefined }),
    maxPrice: num(opts.maxPrice, { min: 0, fallback: undefined }),
    distance: num(opts.distance, { min: 500, max: 1_000_000, fallback: undefined }),
    order: opts.order ?? 'most_relevance',
  };
  const cellZ = clampCellZ(num(opts.cellZ, { fallback: MAX_CELL_Z }));

  sweep();
  const id = hashKey(JSON.stringify(params));
  let entry = searches.get(id);
  const fresh = entry && Date.now() - entry.at < SEARCH_TTL_MS;

  if (!fresh) {
    const { items, hasMore } = await search(params);
    entry = { id, at: Date.now(), items, hasMore, query: params };
    searches.set(id, entry);
  }

  return cellsResponse(entry, cellZ, { cached: Boolean(fresh), hasMore: entry.hasMore });
}

/** Reagrupa una búsqueda ya descargada a otro nivel de detalle. */
export function recell({ searchId, cellZ }) {
  const entry = searches.get(searchId ?? '');
  if (!entry || Date.now() - entry.at > SEARCH_TTL_MS) throw new ExpiredError();
  const z = clampCellZ(num(cellZ, { fallback: MAX_CELL_Z }));
  return cellsResponse(entry, z, { cached: true, hasMore: entry.hasMore });
}
