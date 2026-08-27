// Mapa de resultados agregados.
//
// Todo ocurre en el navegador: `store.js` llama a Wallapop y agrupa por zonas.
// No hay backend. Dos cosas que conviene no romper:
//  1. Los puntos por anuncio (ya difuminados ~1 km por Wallapop) no se pintan:
//     el mapa sólo enseña centros de zona con k-anonimato.
//  2. Las viñetas que aparecen al acercar el mapa se colocan con un hash del id
//     del anuncio, no con su ubicación. Son decorativas y la interfaz lo dice.

import { searchCells, recell } from './lib/store.js';

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
  searchHere: $('search-here'), zoomHint: $('zoom-hint'),
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

function zoneHtml(cell, index, color) {
  const price = cell.price
    ? `${money(cell.price.min)} – ${money(cell.price.max)} · mediana ${money(cell.price.median)}`
    : 'Sin precios';
  return `<li class="zone" data-id="${esc(cell.id)}">
    <div class="zone-top">
      <span class="dot" style="background:${color}"></span>
      <span class="zone-title">${zoneName(cell, index)}</span>
      <span class="zone-count">${cell.count}</span>
    </div>
    <p class="zone-sub">${price}</p>
    <ul class="zone-items">${cell.items.slice(0, ZONE_PREVIEW).map(listItemHtml).join('')}</ul>
    ${cell.count > ZONE_PREVIEW ? `<button class="zone-more" data-more="${esc(cell.id)}">Ver ${plural(cell.count - ZONE_PREVIEW, 'anuncio más', 'anuncios más')} en el mapa →</button>` : ''}
  </li>`;
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
const circles = new Map();      // sólo las zonas con aro dibujado
const zoneBounds = new Map();   // geometría de todas, para poder volar a ellas

function render(result) {
  if (!result) return;
  lastResult = result;
  const { cells, stats } = result;

  zoneLayer.clearLayers();
  pinLayer.clearLayers();
  circles.clear();
  zoneBounds.clear();
  // El panel lista todas las zonas, también las que no se dibujan (fuera de
  // vista, o con el aro demasiado grande), así que su geometría se guarda
  // aparte para que al pulsarlas el mapa pueda ir hasta ellas.
  for (const cell of cells) {
    zoneBounds.set(cell.id, L.latLng(cell.lat, cell.lon).toBounds(cell.radiusKm * 2000));
  }

  const bounds = map.getBounds().pad(0.35);
  let bloomed = 0;
  let imprecisePins = false;
  // Referencia para atenuar el relleno de las zonas grandes.
  const viewportM = map.getBounds().getNorthWest().distanceTo(map.getBounds().getNorthEast());

  cells.forEach((cell, index) => {
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
    if (open) bloomed++;

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
    circle.on('click', () => selectZone(cell.id, false));
    circles.set(cell.id, circle);
    circle.bindPopup(zonePopupHtml(cell, index), { maxWidth: 300, autoPanPadding: [28, 28] });
  });

  renderList(cells);
  renderLegend(cells, stats, imprecisePins);
  renderHeader(result);
  renderZoomHint(stats, bloomed);
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
      .on('click', () => selectZone(cell.id, false))
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

function renderList(cells) {
  els.zoneList.innerHTML = cells.map((cell, i) => zoneHtml(cell, i, colorFor(cell))).join('');
  els.zoneList.querySelectorAll('.zone').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      const more = event.target.closest('.zone-more');
      selectZone(node.dataset.id, true);
      if (more) circles.get(more.dataset.more)?.openPopup();
    });
  });
  els.empty.hidden = cells.length > 0;
  if (cells.length) selectZone(cells[0].id, false);
}

function renderHeader({ cells, stats }) {
  const shown = cells.reduce((n, c) => n + c.count, 0);
  const zones = cells.filter((c) => !c.anonymous);
  const loose = cells.reduce((n, c) => n + (c.anonymous ? c.count : 0), 0);
  els.resultsTitle.innerHTML = `<span class="accent">${shown}</span> anuncios en ${plural(zones.length, 'zona', 'zonas')}`;

  if (!cells.length) { els.resultsSub.textContent = 'Sin resultados'; return; }
  const sizes = zones.map((c) => c.radiusKm * 2);
  els.resultsSub.textContent = [
    sizes.length ? `Zonas de ${km(Math.min(...sizes))} a ${km(Math.max(...sizes))}` : null,
    sizes.length ? `mínimo ${stats.k} anuncios cada una` : null,
    loose ? `${plural(loose, 'suelto', 'sueltos')} sin zona` : null,
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

function renderZoomHint(stats, bloomed) {
  let text;
  if (bloomed) text = `<b>${plural(bloomed, 'zona abierta', 'zonas abiertas')}</b> · posiciones aproximadas dentro de cada una`;
  else if (stats.atFinestLevel) text = '<b>Detalle máximo de zona</b> · acerca más para abrir los anuncios';
  else text = 'Acerca el mapa para <b>afinar las zonas</b>';
  els.zoomHint.innerHTML = text;
  els.zoomHint.hidden = false;
}

function selectZone(id, fly) {
  els.zoneList.querySelectorAll('.zone').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  const node = els.zoneList.querySelector(`.zone[data-id="${CSS.escape(id)}"]`);
  const bounds = zoneBounds.get(id);
  if (fly && bounds) {
    programmaticMove = true;
    map.flyToBounds(bounds.pad(0.35), { duration: 0.5 });
  }
  if (!fly && node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ============ estado y peticiones ============ */
let searchId = null;
let currentCellZ = null;
let keepView = false;
let programmaticMove = false;   // encuadres nuestros: no cuentan como "el usuario se ha movido"
let searchCenter = null;
let inFlight = null;

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
  if (searchId) runSearch();
});

async function currentCenter() {
  if (els.centerMode.value === 'geo' && navigator.geolocation) {
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: 300000 }));
      map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 12));
      return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch {
      toast('No se pudo obtener tu ubicación; uso el centro del mapa.');
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

    const body = await searchCells({
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
    searchId = body.searchId;
    searchCenter = L.latLng(lat, lon);
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

/** Reagrupa la búsqueda ya descargada al nivel que toca para el zoom actual. */
function refreshCells() {
  const cellZ = cellZFor(map.getZoom());
  if (!searchId || cellZ === currentCellZ) return;
  currentCellZ = cellZ;
  try {
    render(recell({ searchId, cellZ }));
  } catch (err) {
    if (err.expired) { searchId = null; runSearch(); return; }
    toast(err.message, 'error');
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
    const needsFetch = searchId && cellZFor(map.getZoom()) !== currentCellZ;
    if (needsFetch) refreshCells();
    else render(lastResult);            // abrir o cerrar zonas no requiere datos nuevos
  }, 180);
});
map.on('moveend', () => {
  // Sólo se ofrece rebuscar si el centro se ha ido lejos del de la búsqueda.
  const drift = searchCenter ? map.getCenter().distanceTo(searchCenter) : 0;
  const viewport = map.getBounds().getNorthWest().distanceTo(map.getBounds().getSouthEast());
  if (programmaticMove) programmaticMove = false;
  else if (searchId && drift > viewport * 0.3) els.searchHere.hidden = false;
  if (lastResult) render(lastResult);   // repuebla lo que entra y sale de vista
  syncUrl();
});

/* ============ eventos de la interfaz ============ */
els.form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
els.searchHere.addEventListener('click', () => { els.centerMode.value = 'map'; runSearch(); });

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
