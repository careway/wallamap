// Cliente del endpoint público de búsqueda de Wallapop.
// No es una API oficial: puede cambiar sin aviso. Todo lo que dependa de su
// forma exacta está aislado aquí (normalizeItem) para poder arreglarlo en un sitio.

const SEARCH_URL = 'https://api.wallapop.com/api/v3/search';

const ORDERS = new Set(['most_relevance', 'newest', 'price_low_to_high', 'price_high_to_low', 'closest']);

export class WallapopError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WallapopError';
    this.status = status;
  }
}

function buildUrl(params) {
  const url = new URL(SEARCH_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

async function fetchPage(params, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(buildUrl(params), {
      headers: {
        // Única cabecera que el endpoint exige: sin ella (o vacía) responde 403.
        // No hace falta falsear User-Agent / Origin / Referer.
        'X-DeviceOS': '0',
        'Accept': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new WallapopError(
        `Wallapop respondió ${res.status}: ${body.slice(0, 200)}`,
        res.status === 429 ? 429 : 502,
      );
    }
    return await res.json();
  } catch (err) {
    if (err instanceof WallapopError) throw err;
    if (err.name === 'AbortError') throw new WallapopError('Wallapop tardó demasiado en responder', 504);
    throw new WallapopError(`No se pudo contactar con Wallapop: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// Aplana la respuesta: los items pueden venir en una sección única o en varias.
function extractItems(json) {
  const data = json?.data;
  if (!data) return [];
  const sections = data.sections ?? (data.section ? [data.section] : []);
  const out = [];
  for (const section of sections) {
    for (const item of section?.payload?.items ?? []) out.push(item);
  }
  return out;
}

function normalizeItem(raw) {
  const loc = raw?.location;
  const lat = Number(loc?.latitude);
  const lon = Number(loc?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const image = raw?.images?.[0]?.urls;
  return {
    id: String(raw.id),
    title: String(raw.title ?? '').trim(),
    price: Number(raw?.price?.amount ?? NaN),
    currency: raw?.price?.currency ?? 'EUR',
    url: raw.web_slug ? `https://es.wallapop.com/item/${raw.web_slug}` : null,
    thumb: image?.small ?? image?.medium ?? null,
    reserved: Boolean(raw?.reserved?.flag),
    shippable: Boolean(raw?.shipping?.item_is_shippable),
    createdAt: Number(raw?.created_at) || null,
    // Datos sensibles: se usan sólo en el servidor para agregar y nunca se envían al navegador.
    _lat: lat,
    _lon: lon,
    _region: loc?.region2 || loc?.region || null,
    _city: loc?.city || null,
  };
}

/**
 * Busca en Wallapop y devuelve items normalizados, deduplicados por id.
 * @param {object} opts
 * @param {string} opts.keywords
 * @param {number} opts.latitude  centro de búsqueda
 * @param {number} opts.longitude
 * @param {number} [opts.pages=2]      páginas a recorrer (40 items cada una)
 * @param {number} [opts.minPrice]
 * @param {number} [opts.maxPrice]
 * @param {number} [opts.distance]     radio en metros
 * @param {string} [opts.order='most_relevance']
 */
export async function search(opts) {
  const {
    keywords, latitude, longitude,
    pages = 2, minPrice, maxPrice, distance, order = 'most_relevance',
  } = opts;

  const base = {
    source: 'search_box',
    keywords,
    latitude,
    longitude,
    order_by: ORDERS.has(order) ? order : 'most_relevance',
    min_sale_price: minPrice,
    max_sale_price: maxPrice,
    distance,
  };

  const items = [];
  const seen = new Set();
  let nextPage;
  let fetched = 0;

  for (let page = 0; page < pages; page++) {
    const json = await fetchPage(nextPage ? { ...base, next_page: nextPage } : base);
    const raw = extractItems(json);
    fetched += raw.length;
    for (const r of raw) {
      const item = normalizeItem(r);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    nextPage = json?.meta?.next_page;
    if (!nextPage || raw.length === 0) break;
  }

  return { items, pagesFetched: Math.min(pages, Math.ceil(fetched / 40) || 1), hasMore: Boolean(nextPage) };
}
