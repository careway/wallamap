// Hoja inferior arrastrable para la lista de zonas en móvil.
//
// Plegada al arrancar (sólo se ve la cabecera con el recuento); el usuario la
// arrastra hacia arriba —desde el asa o la cabecera— para ver la lista. Tres
// posiciones: plegada, media, casi completa; al soltar salta a la más cercana.
// Un toque (sin arrastrar) alterna entre plegada y media.
//
// En escritorio no hace nada: la lista va en su sitio de siempre.

const MOBILE = matchMedia('(max-width: 820px)');

export function installSheet(panel) {
  if (!panel) return;

  const head = panel.querySelector('.results-head');
  const grip = panel.querySelector('.sheet-grip');
  const handles = [grip, head].filter(Boolean);

  const collapsedH = () => Math.round((head?.offsetHeight ?? 52) + 20);
  const points = () => {
    const vh = window.innerHeight;
    return [collapsedH(), Math.round(vh * 0.5), Math.round(vh * 0.9)];
  };

  let idx = 0;

  const setH = (h) => { panel.style.height = `${Math.round(h)}px`; };

  function snap(i) {
    const p = points();
    idx = Math.max(0, Math.min(p.length - 1, i));
    setH(p[idx]);
    grip?.setAttribute('aria-expanded', String(idx > 0));
  }

  function enable() {
    panel.classList.add('sheet');
    snap(idx);
  }
  function disable() {
    panel.classList.remove('sheet', 'is-dragging');
    panel.style.height = '';
    idx = 0;
  }

  let startY = 0;
  let startH = 0;
  let dragging = false;
  let moved = false;

  function onDown(event) {
    if (!MOBILE.matches) return;
    dragging = true;
    moved = false;
    startY = event.clientY;
    startH = panel.getBoundingClientRect().height;
    panel.classList.add('is-dragging');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onMove(event) {
    if (!dragging) return;
    const dy = startY - event.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const p = points();
    setH(Math.max(p[0] - 24, Math.min(p.at(-1) + 24, startH + dy)));
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    if (!moved) { snap(idx === 0 ? 1 : 0); return; }   // toque = alternar
    const h = panel.getBoundingClientRect().height;
    const p = points();
    let best = 0;
    let bestD = Infinity;
    p.forEach((v, i) => {
      const d = Math.abs(v - h);
      if (d < bestD) { bestD = d; best = i; }
    });
    snap(best);
  }

  for (const el of handles) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }
  grip?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      snap(idx === 0 ? 1 : 0);
    }
  });

  MOBILE.addEventListener('change', () => (MOBILE.matches ? enable() : disable()));
  window.addEventListener('resize', () => { if (MOBILE.matches && !dragging) snap(idx); });

  // La cabecera cambia de alto al llegar resultados; si está plegada, reajusta.
  if (head && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (MOBILE.matches && idx === 0 && !dragging) snap(0);
    }).observe(head);
  }

  if (MOBILE.matches) enable();
}
