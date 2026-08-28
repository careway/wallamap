// Mapa de resultados agregados.
//
// Todo ocurre en el navegador: `store.js` llama a Wallapop y agrupa por zonas.
// No hay backend. Dos cosas que conviene no romper:
//  1. Los puntos por anuncio (ya difuminados ~1 km por Wallapop) no se pintan:
//     el mapa sólo enseña centros de zona con k-anonimato.
//  2. Las viñetas que aparecen al acercar el mapa se colocan con un hash del id
//     del anuncio, no con su ubicación. Son decorativas y la interfaz lo dice.

import { startSearch, extendSearch, recell, coverageGap, hasSession } from './lib/store.js';
import { installSheet } from './lib/sheet.js';

const DEFAULT_VIEW = { lat: 40.4168, lon: -3.7038, zoom: 12 };
const CELL_Z_OFFSET = 2;      // nivel de celda = zoom del mapa + 2 (~64 px por zona)
const MIN_CELL_Z = 3;
const MAX_CELL_Z = 14;        // suelo de privacidad; el de verdad lo aplica privacy.js
const PIN_SIZE = 46;          // lado de la viñeta, en píxeles
const MAX_PINS = 24;          // tope por zona, para no ahogar el mapa
const ZONE_PREVIEW = 6;      // anuncios visibles al desplegar una zona en el panel

const $ = (id) => document.getElementById(id);
const els = {
  form: $('search-form'), keywords: $('keywords'), submit: $('submit-btn'),
  filters: $('filters'), filtersBtn: $('filters-btn'), filtersClose: $('filters-close'), filtersApply: $('filters-apply'),
  themeToggle: $('theme-toggle'), chips: $('chips'),
  minPrice: $('minPrice'), maxPrice: $('maxPrice'), distance: $('distance'),
  order: $('order'), pages: $('pages'), centerMode: $('center-mode'),
  resultsTitle: $('results-title'), resultsSub: $('results-sub'),
  zoneList: $('zone-list'), empty: $('empty'),
  searchHere: $('search-here'), mapBusy: $('map-busy'),
  locateBtn: $('locate-btn'),
  legend: $('legend'), legendItems: $('legend-items'), legendNote: $('legend-note'),
  legendStrokes: $('legend-strokes'),
  toast: $('toast'),
};

/* ============ tema ============ */
const THEMES = ['auto', 'light', 'dark'];
const urlTheme = new URLSearchParams(location.search).get('theme');
let theme = THEMES.includes(urlTheme) ? urlTheme : (localStorage.getItem('wm-theme') ?? 'auto');
applyTheme();

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.title = `Tema: ${{ auto: 'automático', light: 'claro', dark: 'oscuro' }[theme]}`;
  els.themeToggle.style.opacity = theme === 'auto' ? '' : '1';
}
const isDark = () => theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);

els.themeToggle.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  localStorage.setItem('wm-theme', theme);
  applyTheme();
  applyTileOpacity();
  render(lastResult);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (theme !== 'auto') return;
  applyTileOpacity();
  render(lastResult);
});

/* ============ mapa ============ */
const map = L.map('map', { zoomControl: false, worldCopyJump: true, zoomSnap: 1, attributionControl: true })
  .setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);

const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · anuncios: Wallapop',
  maxZoom: 19,
}).addTo(map);

/** El mapa base va traslúcido sobre el fondo del contenedor: así se recuesta. */
function applyTileOpacity() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--tile-opacity').trim();
  tiles.setOpacity(Number(value) || 0.8);
}
applyTileOpacity();
L.control.zoom({ position: 'bottomleft' }).addTo(map);

const zoneLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);

const cellZFor = (zoom) => Math.max(MIN_CELL_Z, Math.min(MAX_CELL_Z, Math.round(zoom) + CELL_Z_OFFSET));

/* ============ color por densidad ============ */
const BUCKETS = [
  { min: 25, varName: '--d5', label: '25 o más' },
  { min: 11, varName: '--d4', label: '11 – 24' },
  { min: 6,  varName: '--d3', label: '6 – 10' },
  { min: 3,  varName: '--d2', label: '3 – 5' },
  { min: 1,  varName: '--d1', label: '1 – 2' },
];
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const bucketOf = (cell) => BUCKETS.find((b) => cell.count >= b.min) ?? BUCKETS.at(-1);
const colorFor = (cell) => (cell.anonymous ? cssVar('--d-sparse') : cssVar(bucketOf(cell).varName));

/* ============ utilidades ============ */
const euro = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const money = (n) => (Number.isFinite(n) ? euro.format(n) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const plural_word = (n, one, many) => `${n === 1 ? one : many}`;

function km(value) {
  if (value >= 10) return `${Math.round(value)} km`;
  if (value >= 1) return `${value.toFixed(1).replace('.0', '')} km`;
  return `${Math.round(value * 1000)} m`;
}

/** Hash estable de una cadena → [0, 2π). Sirve para colocar viñetas sin usar la ubicación real. */
function angleFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) / 2 ** 32) * Math.PI * 2;
}

/**
 * Reparte n puntos en espiral áurea dentro de la zona. La posición depende del
 * id de la celda y del índice, nunca de dónde está el anuncio.
 */
function scatter(cell, n, spreadKm = cell.radiusKm) {
  const seed = angleFrom(cell.id);
  const spread = spreadKm * 0.74;
  const cosLat = Math.max(Math.cos((cell.lat * Math.PI) / 180), 0.05);
  return Array.from({ length: n }, (_, i) => {
    const r = n === 1 ? spread * 0.45 : spread * Math.sqrt((i + 0.55) / n);
    const a = seed + i * 2.3999632;
    return [cell.lat + (r * Math.sin(a)) / 110.574, cell.lon + (r * Math.cos(a)) / (111.32 * cosLat)];
  });
}

function toast(message, kind = 'info') {
  els.toast.hidden = !message;
  els.toast.textContent = message ?? '';
  els.toast.className = `toast${kind === 'error' ? ' error' : ''}`;
}

/* ============ plantillas ============ */
const thumbOf = (item) => (item.thumb
  ? `<img src="${esc(item.thumb)}" alt="" loading="lazy">`
  : '<span class="thumb-fallback"></span>');

function zoneName(cell, index) {
  const place = esc(cell.city || cell.region || 'Zona');
  // Una celda dispersa no describe un área: no se etiqueta con kilómetros.
  return `${index + 1}. ${place}${cell.anonymous ? ' · suelto' : ` · ${km(cell.radiusKm * 2)}`}`;
}

function listItemHtml(item) {
  return `<li><a class="zone-item" href="${esc(item.url ?? '#')}" target="_blank" rel="noopener noreferrer">
    ${thumbOf(item)}
    <span class="zone-item-title">${esc(item.title)}${item.reserved ? ' <span class="tag">reservado</span>' : ''}</span>
    <span class="zone-item-price">${money(item.price)}</span>
  </a></li>`;
}

function zonePopupHtml(cell, index) {
  const price = cell.price ? `${money(cell.price.min)} – ${money(cell.price.max)}` : 'sin precio';
  return `<div class="popup">
    <h3>${zoneName(cell, index)}</h3>
    <p class="popup-sub">${plural(cell.count, 'anuncio', 'anuncios')} · ${price}</p>
    <ul>${cell.items.slice(0, 30).map(listItemHtml).join('')}</ul>
    <p class="disclaimer">${cell.anonymous
      ? 'Por debajo del mínimo por zona: de estos anuncios sólo se publica la provincia.'
      : `Están en torno a esta zona de ${km(cell.radiusKm * 2)}, sin más precisión.`}</p>
  </div>`;
}

/* --- listado agrupado por población (no por celda del mapa) --- */

const placeKeyOf = (cell) => cell.city || cell.region || 'Otras zonas';
const placeColor = (place) => (place.precise ? cssVar(bucketOf(place).varName) : cssVar('--d-sparse'));

function priceSummary(items) {
  const prices = items.map((i) => i.price).filter(Number.isFinite).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return {
    min: prices[0],
    max: prices[prices.length - 1],
    median: prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
  };
}

/** Junta las celdas del mapa en poblaciones. Hereda el orden de `cells` (por
 *  cercanía al centro): la primera aparición de una población marca su sitio. */
function buildPlaces(cells) {
  const byKey = new Map();
  for (const cell of cells) {
    const key = placeKeyOf(cell);
    let place = byKey.get(key);
    if (!place) {
      place = { key, name: key, cells: [], items: [], count: 0, precise: false };
      byKey.set(key, place);
    }
    place.cells.push(cell);
    place.items.push(...cell.items);
    place.count += cell.count;
    if (!cell.anonymous) place.precise = true;
  }
  const places = [...byKey.values()];
  for (const place of places) {
    place.items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    place.price = priceSummary(place.items);
  }
  return places;
}

function placeHtml(place, index) {
  const p = place.price;
  const priceLine = p ? `${money(p.min)} – ${money(p.max)} · mediana ${money(p.median)}` : 'Sin precios';
  const preview = place.items.slice(0, ZONE_PREVIEW).map(listItemHtml).join('');
  const rest = place.items.slice(ZONE_PREVIEW);
  return `<li class="zone" data-id="${esc(place.key)}">
    <div class="zone-top">
      <span class="dot" style="background:${placeColor(place)}"></span>
      <span class="zone-title">${index + 1}. ${esc(place.name)}${place.precise ? '' : ' · sólo provincia'}</span>
      <span class="zone-count">${place.count}</span>
    </div>
    <p class="zone-sub">${priceLine}</p>
    <ul class="zone-items">${preview}</ul>
    ${rest.length ? `<ul class="zone-items zone-rest" hidden>${rest.map(listItemHtml).join('')}</ul>
      <button class="zone-more" type="button">Ver ${plural(rest.length, 'anuncio más', 'anuncios más')}</button>` : ''}
  </li>`;
}

function itemPopupHtml(item, cell, loose = false) {
  return `<div class="popup"><div class="popup-item">
      ${item.thumb ? `<img src="${esc(item.thumb)}" alt="">` : '<span class="thumb-fallback"></span>'}
      <span class="meta">
        <a href="${esc(item.url ?? '#')}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        <span class="price">${money(item.price)}</span>
        ${item.shippable ? '<span class="tag">envío</span>' : ''}
      </span>
    </div>
    <p class="disclaimer">${loose
      ? `Posición decorativa: de este anuncio sólo sabemos la provincia${cell.region ? ` (${esc(cell.region)})` : ''}.`
      : `Posición decorativa: sólo sabemos que está en torno a esta zona de ${km(cell.radiusKm * 2)}.`}</p>
  </div>`;
}

/* ============ render ============ */
let lastResult = null;
let selectedZoneId = null;      // clave de la población seleccionada; se conserva entre re-renders
const zoneBounds = new Map();   // población -> bounds, para volar a ella

function render(result) {
  if (!result) return;
  lastResult = result;
  const { stats } = result;

  // La lista (y la numeración de las burbujas) va por cercanía al centro del
  // mapa: lo que tienes enfocado sale primero. Empate: más anuncios antes.
  const center = map.getCenter();
  const distToCenter = new Map(
    result.cells.map((c) => [c.id, center.distanceTo([c.lat, c.lon])]),
  );
  const cells = result.cells
    .slice()
    .sort((a, b) => distToCenter.get(a.id) - distToCenter.get(b.id) || b.count - a.count);

  zoneLayer.clearLayers();
  pinLayer.clearLayers();
  zoneBounds.clear();

  // El listado agrupa por población; el mapa sigue dibujando un círculo por celda.
  const places = buildPlaces(cells);
  const placeIndexOf = new Map(places.map((p, i) => [p.key, i]));
  for (const place of places) {
    let b = null;
    for (const c of place.cells) {
      const cb = L.latLng(c.lat, c.lon).toBounds(Math.max(c.radiusKm, 1) * 2000);
      b = b ? b.extend(cb) : cb;
    }
    zoneBounds.set(place.key, b);
  }

  const bounds = map.getBounds().pad(0.35);
  let imprecisePins = false;
  // Referencia para atenuar el relleno de las zonas grandes.
  const viewportM = map.getBounds().getNorthWest().distanceTo(map.getBounds().getNorthEast());

  cells.forEach((cell) => {
    const index = placeIndexOf.get(placeKeyOf(cell));   // nº de la población en el listado
    const color = colorFor(cell);
    // Si el centro no está en pantalla sólo se vería un arco suelto: no aporta
    // nada y el panel lateral ya lista la zona.
    const inView = bounds.contains([cell.lat, cell.lon]);
    if (!inView) return;
    // Por debajo del mínimo no hay zona que dibujar: un círculo de decenas de
    // km no dice nada. Se muestran los anuncios de uno en uno, repartidos en el
    // entorno del ancla y avisando de que la posición es aproximada.
    if (cell.anonymous) {
      renderPins(cell, index, { spreadKm: cell.anchorRadiusKm, loose: true });
      imprecisePins = true;
      return;
    }
    // "Ampliada" = ha tenido que subir de nivel por falta de anuncios. Se dibuja
    // en contorno discontinuo y sin relleno: menos precisa, menos peso visual.
    const widened = cell.z < stats.cellZ;
    const screenShare = (cell.radiusKm * 1000) / viewportM;
    // Las zonas precisas siempre se dibujan (son del tamaño del nivel en curso).
    // Las ampliadas sólo si su aro es pequeño respecto a la vista: uno que cruza
    // media pantalla no informa de nada y se queda en su chapa discontinua.
    const ringFits = !widened || screenShare * 2 < 0.25;

    // Si el círculo da de sí, el grupo se abre: los anuncios se reparten por
    // dentro, que es exactamente el margen de incertidumbre que publicamos de
    // ellos. Si no caben sin pisarse, se queda la cifra.
    //
    // Las zonas ampliadas también se abren, y su reparto ocupa todo su radio:
    // amontonarlas en una chapa sugería un punto concreto, cuando justamente
    // son las menos precisas. Sus viñetas van marcadas como tales.
    const open = fitsInside(cell);

    if (open) {
      renderPins(cell, index, { imprecise: widened });
      imprecisePins ||= widened;
    }
    else renderCount(cell, index, color, widened);

    if (!ringFits) return;   // el aro sólo se dibuja si cabe en la vista

    const circle = L.circle([cell.lat, cell.lon], {
      radius: cell.radiusKm * 1000,
      color,
      // El trazo dice cuánta precisión hay, no si la zona está abierta:
      // continuo = zona del nivel en curso, discontinuo = zona ampliada.
      weight: widened ? 1.5 : 2.5,
      opacity: widened ? 0.6 : 1,
      dashArray: widened ? '7 7' : null,
      fillColor: color,
      // Abierta, el relleno cede para que se lean las viñetas de dentro.
      fillOpacity: widened ? 0.03 : Math.max(0.05, (open ? 0.1 : 0.22) - screenShare * 0.4),
      className: 'zone-circle',
    }).addTo(zoneLayer);
    circle.on('click', () => selectZone(placeKeyOf(cell), false));
    circle.bindPopup(zonePopupHtml(cell, index), { maxWidth: 300, autoPanPadding: [28, 28] });
  });

  renderList(places);
  renderLegend(cells, stats, imprecisePins);
  renderHeader(result, places);
}

/** Tinta legible sobre un color de la rampa (que va de teal claro a casi negro). */
function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#04302a' : '#f2fbf9';
}

/**
 * ¿Caben los anuncios de la celda repartidos dentro de su círculo?
 *
 * Con el reparto en espiral, la separación típica entre viñetas es
 * ~2·(0,74·R)/√n; se exige que supere el ancho de una viñeta. De ahí sale un
 * aforo que sólo depende del radio en pantalla: al acercarse, el círculo crece
 * y el grupo se abre solo, sin umbrales de zoom escritos a mano.
 */
function fitsInside(cell) {
  const pxRadius = (cell.radiusKm * 1000) / metersPerPixel(cell.lat);
  const capacity = Math.floor(((1.48 * pxRadius) / (PIN_SIZE * 1.15)) ** 2);
  return cell.count <= Math.min(capacity, MAX_PINS);
}

/** Metros por píxel a esta latitud y zoom: sirve para saber cuánto ocupa la zona. */
function metersPerPixel(lat) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
}

/**
 * La cifra va dentro del círculo, no encima: se centra en él y se escala a su
 * tamaño. Si la zona es tan pequeña que no cabe el número, el círculo se
 * resuelve como disco sólido con la cifra dentro — sigue siendo el mismo dato.
 */
function renderCount(cell, index, color, widened) {
  const pxRadius = (cell.radiusKm * 1000) / metersPerPixel(cell.lat);
  // Compacta si no cabe la cifra dentro del círculo, o si la zona es de las
  // ampliadas: ahí el círculo es enorme y la cifra quedaría suelta en medio.
  const compact = widened || pxRadius < 17;
  const size = compact ? 32 : Math.min(Math.round(pxRadius * 2), 160);
  const fontSize = compact ? 12.5 : Math.max(12, Math.min(pxRadius * 0.5, 26));

  const marker = L.marker([cell.lat, cell.lon], {
    icon: L.divIcon({
      className: 'zone-count-icon',
      html: `<span class="zone-count-label${compact ? ' is-dot' : ''}${widened ? ' is-widened' : ''}"
        style="--size:${size}px; --fs:${fontSize.toFixed(1)}px; --c:${color}; --ink:${inkFor(color)}">${cell.count}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    }),
    keyboard: false,
    interactive: compact,   // si no, el clic lo recibe el círculo grande
  }).addTo(zoneLayer);

  if (compact) {
    marker
      .on('click', () => selectZone(placeKeyOf(cell), false))
      .bindPopup(zonePopupHtml(cell, index), { maxWidth: 300, autoPanPadding: [28, 28] });
  }
}

/**
 * Reparte los anuncios de la celda por dentro de su área. Sólo se llama cuando
 * caben todos (ver `fitsInside`) o cuando son anuncios sueltos, así que aquí no
 * hay recorte ni "+N": lo que se ve es el grupo entero.
 */
function renderPins(cell, index, { spreadKm = cell.radiusKm, loose = false, imprecise = loose } = {}) {
  const spots = scatter(cell, cell.count, spreadKm);

  cell.items.forEach((item, i) => {
    L.marker(spots[i], {
      icon: L.divIcon({
        className: `pin${imprecise ? ' is-loose' : ''}`,
        html: `<span class="pin-inner">${thumbOf(item)}<span class="pin-price">${money(item.price)}</span></span>`,
        iconSize: [PIN_SIZE, PIN_SIZE],
        iconAnchor: [PIN_SIZE / 2, PIN_SIZE / 2],
      }),
      riseOnHover: true,
      title: item.title,
    })
      .addTo(pinLayer)
      .bindPopup(itemPopupHtml(item, cell, loose), { maxWidth: 290, autoPanPadding: [28, 28] });
  });
}

function renderList(places) {
  const prevScroll = els.zoneList.scrollTop;
  els.zoneList.innerHTML = places.map((p, i) => placeHtml(p, i)).join('');
  els.zoneList.scrollTop = prevScroll;   // no saltar al principio en cada re-render
  els.zoneList.querySelectorAll('.zone').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      const more = event.target.closest('.zone-more');
      if (more) {
        const rest = node.querySelector('.zone-rest');
        const wasOpen = !rest.hidden;
        rest.hidden = wasOpen;
        more.textContent = wasOpen
          ? `Ver ${plural(rest.children.length, 'anuncio más', 'anuncios más')}`
          : 'Ver menos';
        return;
      }
      selectZone(node.dataset.id, true);
    });
  });
  els.empty.hidden = places.length > 0;

  // Conserva la población seleccionada entre re-renders; sólo hace scroll cuando
  // no hay ninguna válida que mantener.
  const keep = selectedZoneId && places.some((p) => p.key === selectedZoneId);
  if (keep) {
    els.zoneList.querySelectorAll('.zone').forEach((n) => n.classList.toggle('active', n.dataset.id === selectedZoneId));
  } else if (places.length) {
    selectZone(places[0].key, false);
  }
}

function renderHeader({ cells }, places) {
  const shown = cells.reduce((n, c) => n + c.count, 0);
  els.resultsTitle.innerHTML =
    `<span class="accent">${shown}</span> ${plural_word(shown, 'anuncio', 'anuncios')} en ${plural(places.length, 'población', 'poblaciones')}`;

  if (!places.length) { els.resultsSub.textContent = 'Sin resultados'; return; }
  const onlyProv = places.filter((p) => !p.precise).length;
  els.resultsSub.textContent = [
    'Ordenadas por cercanía al centro del mapa',
    onlyProv ? `${plural(onlyProv, 'población', 'poblaciones')} sólo por provincia` : null,
  ].filter(Boolean).join(' · ');
}

function renderLegend(cells, stats, imprecisePins) {
  const present = new Set(cells.filter((c) => !c.anonymous).map((c) => bucketOf(c).varName));
  els.legendItems.innerHTML = BUCKETS
    .filter((b) => present.has(b.varName))
    .map((b) => `<li><span class="swatch" style="background:${cssVar(b.varName)}"></span>${b.label} anuncios</li>`)
    .join('');

  // El trazo del círculo es la otra variable que hay que leer: cuánta
  // precisión hay detrás de la zona.
  const strokes = [
    cells.some((c) => !c.anonymous && c.z >= stats.cellZ)
      && ['ring', 'Trazo continuo: zona al detalle actual'],
    cells.some((c) => !c.anonymous && c.z < stats.cellZ)
      && ['ring is-dashed', 'Trazo discontinuo: zona ampliada, menos precisa'],
    imprecisePins
      && ['pin-swatch', 'Viñeta punteada: repartida por todo el área'],
    cells.some((c) => c.anonymous)
      && ['pin-swatch is-lone', 'Anuncio suelto: sólo se conoce la provincia'],
  ].filter(Boolean);
  els.legendStrokes.innerHTML = strokes
    .map(([cls, label]) => `<li><span class="swatch ${cls}"></span>${label}</li>`).join('');
  els.legendStrokes.previousElementSibling.hidden = !strokes.length;

  els.legendNote.textContent = 'Dentro de cada zona la posición es decorativa: nunca es la del anuncio.';
  els.legend.hidden = !cells.length;
}

function selectZone(id, fly) {
  selectedZoneId = id;
  els.zoneList.querySelectorAll('.zone').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  const node = els.zoneList.querySelector(`.zone[data-id="${CSS.escape(id)}"]`);
  const bounds = zoneBounds.get(id);
  if (fly && bounds) {
    programmaticMove = true;
    map.flyToBounds(bounds.pad(0.3), { duration: 0.5, maxZoom: 14 });
  }
  if (!fly && node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ============ estado y peticiones ============ */
let currentCellZ = null;
let keepView = false;
let programmaticMove = false;   // encuadres nuestros: no cuentan como "el usuario se ha movido"
let inFlight = null;
let extending = false;          // hay un tile en vuelo por paneo
let extendTimer = null;

function filterParams() {
  const p = new URLSearchParams({ pages: els.pages.value, order: els.order.value });
  if (els.minPrice.value) p.set('minPrice', els.minPrice.value);
  if (els.maxPrice.value) p.set('maxPrice', els.maxPrice.value);
  if (els.distance.value) p.set('distance', els.distance.value);
  return p;
}

function renderChips() {
  const labels = [];
  if (els.minPrice.value || els.maxPrice.value) {
    labels.push(['price', `${els.minPrice.value ? `${els.minPrice.value} €` : '0 €'} – ${els.maxPrice.value ? `${els.maxPrice.value} €` : '∞'}`]);
  }
  if (els.distance.value) labels.push(['distance', `${Number(els.distance.value) / 1000} km`]);
  if (els.order.value !== 'most_relevance') {
    labels.push(['order', els.order.selectedOptions[0].textContent]);
  }
  els.chips.innerHTML = labels
    .map(([key, text]) => `<span class="chip">${esc(text)}<button data-clear="${key}" aria-label="Quitar filtro">×</button></span>`)
    .join('');
  els.chips.hidden = !labels.length;
}

els.chips.addEventListener('click', (event) => {
  const key = event.target.dataset?.clear;
  if (!key) return;
  if (key === 'price') { els.minPrice.value = ''; els.maxPrice.value = ''; }
  if (key === 'distance') els.distance.value = '';
  if (key === 'order') els.order.value = 'most_relevance';
  renderChips();
  if (hasSession()) runSearch();
});

/* ============ ubicación del usuario ============ */
let lastUserPos = null;        // GeolocationPosition más reciente
let geoWatchId = null;
let userDot = null;
let userHalo = null;

function getUserPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 9000, maximumAge: 60000,
    });
  });
}

/** Pinta (o mueve) el punto azul y su halo de precisión. */
function drawUserLocation(pos) {
  lastUserPos = pos;
  const ll = [pos.coords.latitude, pos.coords.longitude];
  const acc = pos.coords.accuracy || 0;
  if (!userDot) {
    userHalo = L.circle(ll, {
      radius: acc, color: cssVar('--geo'), weight: 1, opacity: 0.3,
      fillColor: cssVar('--geo'), fillOpacity: 0.1, interactive: false,
    }).addTo(map);
    userDot = L.marker(ll, {
      icon: L.divIcon({ className: 'user-dot', html: '<span></span>', iconSize: [21, 21], iconAnchor: [10.5, 10.5] }),
      interactive: false, keyboard: false, zIndexOffset: 1000,
    }).addTo(map);
  } else {
    userDot.setLatLng(ll);
    userHalo.setLatLng(ll).setRadius(acc);
  }
}

function setGeoMode(on) {
  els.centerMode.value = on ? 'geo' : 'map';
  els.locateBtn.classList.toggle('active', on);
  els.locateBtn.setAttribute('aria-pressed', String(on));
}

function startGeoWatch() {
  if (geoWatchId !== null || !navigator.geolocation) return;
  geoWatchId = navigator.geolocation.watchPosition(
    drawUserLocation, () => {}, { enableHighAccuracy: true, maximumAge: 30000 },
  );
}

/** Botón de ubicación: sitúa el punto, vuela allí y busca centrado en la persona. */
async function locateMe() {
  if (!navigator.geolocation) { toast('Tu navegador no comparte la ubicación', 'error'); return; }
  els.locateBtn.classList.add('busy');
  try {
    const pos = await getUserPosition();
    drawUserLocation(pos);
    startGeoWatch();
    setGeoMode(true);
    keepView = true;                 // que runSearch no reencuadre a los resultados
    programmaticMove = true;
    map.flyTo([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 14), { duration: 0.6 });
    if (els.keywords.value.trim()) runSearch();
  } catch (err) {
    toast(err && err.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener tu ubicación', 'error');
  } finally {
    els.locateBtn.classList.remove('busy');
  }
}

async function currentCenter() {
  if (els.centerMode.value === 'geo') {
    if (lastUserPos && Date.now() - lastUserPos.timestamp < 120000) {
      return { lat: lastUserPos.coords.latitude, lon: lastUserPos.coords.longitude };
    }
    if (navigator.geolocation) {
      try {
        const pos = await getUserPosition();
        drawUserLocation(pos);
        return { lat: pos.coords.latitude, lon: pos.coords.longitude };
      } catch {
        toast('No se pudo obtener tu ubicación; uso el centro del mapa.');
      }
    }
  }
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

function setLoading(on) {
  els.submit.disabled = on;
  els.submit.textContent = on ? 'Buscando…' : 'Buscar';
  if (on) {
    els.empty.hidden = true;
    els.zoneList.innerHTML = '<div class="skeleton">' + '<div></div>'.repeat(5) + '</div>';
  }
}

async function runSearch() {
  const keywords = els.keywords.value.trim();
  if (!keywords) return;

  setLoading(true);
  toast(null);
  const run = (inFlight = Symbol('search'));   // marca la petición en curso; una posterior la invalida

  try {
    const { lat, lon } = await currentCenter();
    currentCellZ = cellZFor(map.getZoom());
    const params = filterParams();
    params.set('keywords', keywords);
    params.set('lat', lat.toFixed(4));
    params.set('lon', lon.toFixed(4));
    params.set('cellZ', currentCellZ);

    const body = await startSearch({
      keywords,
      lat: lat.toFixed(4),
      lon: lon.toFixed(4),
      cellZ: currentCellZ,
      pages: els.pages.value,
      order: els.order.value,
      minPrice: els.minPrice.value || undefined,
      maxPrice: els.maxPrice.value || undefined,
      distance: els.distance.value || undefined,
    });
    if (inFlight !== run) return;   // ha entrado otra búsqueda mientras descargábamos
    els.searchHere.hidden = true;

    if (!body.cells.length) {
      showEmpty(keywords);
      render({ cells: [], stats: body.stats });
      syncUrl(params);
      return;
    }

    render(body);
    if (keepView) keepView = false;   // un enlace compartido manda sobre el encuadre automático
    else {
      programmaticMove = true;
      map.fitBounds(L.latLngBounds(body.cells.map((c) => [c.lat, c.lon])).pad(0.28), { maxZoom: 13, animate: true });
    }
    syncUrl(params);
  } catch (err) {
    if (inFlight !== run) return;   // una búsqueda posterior manda: su error, no el nuestro
    toast(err.message, 'error');
    els.zoneList.innerHTML = '';
  } finally {
    if (inFlight === run) {
      setLoading(false);
      inFlight = null;
    }
  }
}

/** Reagrupa lo ya descargado al nivel que toca para el zoom actual. */
function refreshCells() {
  const cellZ = cellZFor(map.getZoom());
  if (!hasSession() || cellZ === currentCellZ) return;
  currentCellZ = cellZ;
  try {
    render(recell({ cellZ }));
  } catch (err) {
    if (err.expired) { runSearch(); return; }
    toast(err.message, 'error');
  }
}

/** Ancho aproximado del mapa en km, para decidir cada cuánto pedir tiles. */
function viewportKm() {
  const b = map.getBounds();
  return b.getNorthWest().distanceTo(b.getNorthEast()) / 1000;
}

/** Muestra el indicador de "trayendo esta zona". */
function setBusy(on) {
  els.mapBusy.hidden = !on;
}

/**
 * Al parar el mapa: si el centro cae fuera de los tiles ya traídos, pide otro y
 * lo fusiona sin mover la vista. Se llama con debounce desde 'moveend'.
 */
async function autoExtend() {
  if (extending || !hasSession()) return;
  const c = map.getCenter();
  if (!coverageGap(c.lat, c.lng, viewportKm())) return;

  extending = true;
  setBusy(true);
  try {
    currentCellZ = cellZFor(map.getZoom());
    render(await extendSearch({ lat: c.lat, lon: c.lng, cellZ: currentCellZ }));
    els.searchHere.hidden = true;   // zona ya cubierta
    syncUrl();
  } catch (err) {
    if (err.expired) { runSearch(); return; }
    // Fallo de red en una extensión: no se toca la vista; se reintenta al siguiente paneo.
  } finally {
    extending = false;
    setBusy(false);
  }
}

/** Fuerza traer la zona del centro actual aunque ya esté cubierta. */
async function extendHere() {
  if (!hasSession()) { els.centerMode.value = 'map'; runSearch(); return; }
  const c = map.getCenter();
  setBusy(true);
  try {
    currentCellZ = cellZFor(map.getZoom());
    render(await extendSearch({ lat: c.lat, lon: c.lng, cellZ: currentCellZ }));
    els.searchHere.hidden = true;
    syncUrl();
  } catch (err) {
    if (err.expired) runSearch();
    else toast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function showEmpty(keywords) {
  els.empty.innerHTML = `<h3>Nada por aquí</h3><p>No hay anuncios de “${esc(keywords)}” con estos filtros. Prueba a ampliar el radio o quitar el tope de precio.</p>`;
  els.empty.hidden = false;
  els.legend.hidden = true;
  els.zoneList.innerHTML = '';
}

let lastQuery = null;
/** La URL refleja búsqueda + encuadre actual, así que un enlace se abre igual. */
function syncUrl(params) {
  if (params) { lastQuery = new URLSearchParams(params); lastQuery.delete('cellZ'); }
  if (!lastQuery) return;
  const url = new URLSearchParams(lastQuery);
  const c = map.getCenter();
  url.set('lat', c.lat.toFixed(4));
  url.set('lon', c.lng.toFixed(4));
  url.set('z', String(map.getZoom()));
  if (theme !== 'auto') url.set('theme', theme);
  history.replaceState(null, '', `?${url}`);
}

/* ============ eventos del mapa ============ */
let zoomTimer;
map.on('zoomend', () => {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    const needsFetch = hasSession() && cellZFor(map.getZoom()) !== currentCellZ;
    if (needsFetch) refreshCells();
    else render(lastResult);            // abrir o cerrar zonas no requiere datos nuevos
  }, 180);
});
map.on('moveend', () => {
  const wasProgrammatic = programmaticMove;
  programmaticMove = false;
  if (lastResult) render(lastResult);   // repuebla lo que entra y sale de vista
  syncUrl();
  if (wasProgrammatic) return;

  // El usuario ha movido el mapa: se busca centrado en el mapa, no en la persona.
  if (els.centerMode.value === 'geo') setGeoMode(false);

  // El botón manual y el auto-fetch se guían por lo mismo: ¿el centro cae fuera
  // de los tiles ya traídos? El botón aparece ya; el auto-fetch salta tras la
  // pausa y, si va bien, lo oculta. Si falla, el botón se queda para reintentar.
  const c = map.getCenter();
  if (hasSession() && coverageGap(c.lat, c.lng, viewportKm())) els.searchHere.hidden = false;

  clearTimeout(extendTimer);
  extendTimer = setTimeout(autoExtend, 450);
});

/* ============ eventos de la interfaz ============ */
els.form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
els.searchHere.addEventListener('click', extendHere);
els.locateBtn.addEventListener('click', locateMe);
els.centerMode.addEventListener('change', () => {
  if (els.centerMode.value === 'geo') locateMe();
  else els.locateBtn.classList.remove('active');
});

const toggleFilters = (open) => {
  els.filters.hidden = !open;
  els.filtersBtn.setAttribute('aria-expanded', String(open));
};
els.filtersBtn.addEventListener('click', () => toggleFilters(els.filters.hidden));
els.filtersClose.addEventListener('click', () => toggleFilters(false));
els.filtersApply.addEventListener('click', () => {
  toggleFilters(false);
  renderChips();
  if (els.keywords.value.trim()) runSearch();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleFilters(false);
  if (e.key === '/' && document.activeElement !== els.keywords) { e.preventDefault(); els.keywords.focus(); }
});

/* ============ arranque ============ */
installSheet($('results'));

(function boot() {
  const q = new URLSearchParams(location.search);
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  const zoom = Number(q.get('z'));
  if (q.get('lat') && Number.isFinite(lat) && Number.isFinite(lon)) {
    map.setView([lat, lon], Number.isFinite(zoom) && zoom ? zoom : DEFAULT_VIEW.zoom);
    keepView = Boolean(q.get('z'));
  }
  if (!q.get('keywords')) { renderChips(); return; }

  els.keywords.value = q.get('keywords');
  for (const [param, el] of Object.entries({
    pages: els.pages, order: els.order, minPrice: els.minPrice, maxPrice: els.maxPrice, distance: els.distance,
  })) if (q.has(param)) el.value = q.get(param);
  renderChips();
  runSearch();
})();
