// Agregación geográfica con k-anonimato sobre la rejilla de tiles del mapa.
//
// Por qué tiles y no una rejilla en km: los tiles anidan perfectamente (un tile
// de nivel z-1 es exactamente cuatro de nivel z). Como el nivel de agrupación
// sigue al zoom del mapa, el navegador puede pedir varios niveles de la misma
// búsqueda; con celdas anidadas, cruzar dos niveles no acota nada por debajo del
// más fino publicado. Con una rejilla en km sí lo haría: la intersección de una
// celda de 1 km y otra de 2 km puede ser mucho más pequeña que ambas.
//
// Sobre esa rejilla: cada anuncio cae en un tile; un tile sólo se publica si
// reúne al menos K anuncios, y si no, sube al tile padre hasta reunirlos. El
// mapa recibe el centro del tile y cuántos anuncios contiene, nunca coordenadas.

/** Nivel más fino que se publica jamás: ~1,9 km de lado a 40° de latitud. */
export const MAX_CELL_Z = 14;
/** Nivel más grueso al que se sube buscando vecinos: ~115 km de lado. Más
 *  allá el círculo taparía media península sin ganar privacidad real. */
export const SPARSE_FLOOR_Z = 8;
/** Nivel más grueso admitido como punto de partida (vista mundo). */
export const MIN_CELL_Z = 3;
/** Anuncios mínimos para publicar una celda. */
export const K_ANONYMITY = 3;

const EARTH_CIRCUMFERENCE_KM = 40075.017;

export function clampCellZ(z) {
  return Math.max(MIN_CELL_Z, Math.min(MAX_CELL_Z, Math.round(z)));
}

/** Tile (z/x/y) que contiene un punto, en la proyección estándar del mapa. */
export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const latRad = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x: mod(x, n), y: Math.max(0, Math.min(n - 1, y)) };
}

/** Centro geométrico del tile: el único punto que se publica. */
export function tileCenter({ z, x, y }) {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return { lat, lon };
}

/** Lado del tile en km a esa latitud (los tiles encogen hacia los polos). */
export function tileWidthKm({ z }, lat) {
  return (EARTH_CIRCUMFERENCE_KM * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Esquinas del tile, en grados. */
export function tileBounds({ z, x, y }) {
  const n = 2 ** z;
  const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return {
    north: lat(y),
    south: lat(y + 1),
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
  };
}

/** Distancia entre dos puntos en km (esfera). */
function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Punto que se publica para la celda.
 *
 * El centro geométrico del tile deja las burbujas en mitad del campo cuando el
 * mapa está lejos, así que el ancla se calcula donde está de verdad la oferta:
 * el centroide de los anuncios, redondeado a una rejilla fija dos niveles más
 * fina que la celda y nunca más fina que el suelo de privacidad. Al alejarse,
 * eso cae sobre el núcleo urbano; de cerca coincide con el tile de siempre.
 *
 * Lo que se publica del ancla es un nodo de rejilla, no el centroide: su
 * precisión queda acotada por `anchorRadiusKm` y siempre es más gruesa o igual
 * que la celda que ya se publicaba.
 */
function anchorFor(items, tile) {
  const anchorZ = Math.min(tile.z + 2, MAX_CELL_Z);
  const centroid = {
    lat: items.reduce((n, i) => n + i._lat, 0) / items.length,
    lon: items.reduce((n, i) => n + i._lon, 0) / items.length,
  };
  const anchorTile = tileOf(centroid.lat, centroid.lon, anchorZ);
  const center = tileCenter(anchorTile);
  return { center, radiusKm: tileWidthKm(anchorTile, center.lat) / 2 };
}

const parentOf = ({ z, x, y }) => ({ z: z - 1, x: x >> 1, y: y >> 1 });
const keyOf = ({ z, x, y }) => `${z}/${x}/${y}`;
const mod = (v, n) => ((v % n) + n) % n;

function priceStats(items) {
  const prices = items.map((i) => i.price).filter(Number.isFinite).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return {
    min: prices[0],
    max: prices[prices.length - 1],
    median: prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
  };
}

/** Quita del anuncio todo lo que pueda situarlo en el mapa. */
function publicItem(item) {
  return {
    id: item.id,
    title: item.title,
    price: item.price,
    currency: item.currency,
    url: item.url,
    thumb: item.thumb,
    reserved: item.reserved,
    shippable: item.shippable,
  };
}

/**
 * Agrupa los anuncios en celdas publicables.
 * @param {Array} items anuncios normalizados con _lat/_lon
 * @param {object} [opts]
 * @param {number} [opts.cellZ=MAX_CELL_Z] nivel de partida (se recorta al rango permitido)
 * @param {number} [opts.k=K_ANONYMITY]    anuncios mínimos por celda
 * @returns {{cells: Array, stats: object}}
 */
export function aggregate(items, opts = {}) {
  const k = Math.max(1, opts.k ?? K_ANONYMITY);
  const startZ = clampCellZ(opts.cellZ ?? MAX_CELL_Z);

  const cells = [];
  let pending = new Map();   // key -> { tile, items }

  for (const item of items) {
    const tile = tileOf(item._lat, item._lon, startZ);
    const key = keyOf(tile);
    if (!pending.has(key)) pending.set(key, { tile, items: [] });
    pending.get(key).items.push(item);
  }

  // Si la vista ya es más amplia que el suelo, no hay adónde subir.
  const floorZ = Math.min(startZ, SPARSE_FLOOR_Z);

  for (let z = startZ; z >= floorZ && pending.size; z--) {
    const carry = new Map();
    for (const group of pending.values()) {
      // En el nivel más grueso ya no hay adónde subir: se publica como zona amplia.
      if (group.items.length >= k || z === floorZ) {
        cells.push(buildCell(group, group.items.length < k, k));
        continue;
      }
      const parent = parentOf(group.tile);
      const key = keyOf(parent);
      if (!carry.has(key)) carry.set(key, { tile: parent, items: [] });
      carry.get(key).items.push(...group.items);
    }
    pending = carry;
  }

  cells.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const radii = cells.map((c) => c.radiusKm);
  return {
    cells,
    stats: {
      items: items.length,
      zones: cells.length,
      k,
      cellZ: startZ,
      minRadiusKm: radii.length ? Math.min(...radii) : null,
      maxRadiusKm: radii.length ? Math.max(...radii) : null,
      atFinestLevel: startZ >= MAX_CELL_Z,
    },
  };
}

function buildCell({ tile, items }, sparse, k) {
  const anchor = anchorFor(items, tile);
  // El radio es el tamaño nominal de la celda, no la distancia hasta la esquina
  // más lejana: al anclar fuera del centro, cubrir el tile entero hinchaba los
  // círculos hasta el doble. El círculo dice a qué escala está la zona; la
  // garantía de privacidad la dan el mínimo por celda y el grano del ancla.
  const radiusKm = tileWidthKm(tile, anchor.center.lat) / 2;

  return {
    id: keyOf(tile),
    z: tile.z,
    lat: Number(anchor.center.lat.toFixed(5)),
    lon: Number(anchor.center.lon.toFixed(5)),
    radiusKm: Number(radiusKm.toFixed(3)),
    anchorRadiusKm: Number(anchor.radiusKm.toFixed(3)),
    count: items.length,
    anonymous: sparse,
    region: mode(items.map((i) => i._region)),
    // El municipio sólo se nombra si el grupo cumple el mínimo; por debajo de
    // él nos quedamos en la provincia.
    city: items.length >= k ? mode(items.map((i) => i._city)) : null,
    price: priceStats(items),
    items: items
      .slice()
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      .map(publicItem),
  };
}

function mode(values) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of values) {
    if (!v) continue;
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}
