# Wallapop Mapper — versión cliente

Mostrador web de Wallapop: buscas un producto y ves **dónde hay oferta**, no dónde
está cada anuncio. El detalle de las zonas sigue al zoom del mapa y, cuando te
acercas del todo, cada anuncio aparece como una viñeta con su foto dentro de su
zona.

Esta rama (`cliente-side`) **no tiene backend**: el navegador llama directamente a
Wallapop y hace la agregación. El servidor sólo sirve ficheros estáticos. La
versión con backend Node + proxy de egress está en `main`.

```
cd app/public && python3 -m http.server 3000     # http://localhost:3000
```

Vale cualquier servidor de estáticos; hace falta servir por HTTP (no `file://`)
porque `app.js` usa módulos ES. Leaflet, los tiles de OpenStreetMap y la
tipografía Inter se cargan por CDN.

## De dónde salen las ubicaciones

Wallapop **no publica la dirección exacta**. Para cada anuncio devuelve un punto
desplazado al azar dentro de un radio (~1 km), fijo por anuncio. Es "este
vendedor está por este barrio", no su portal.

Encima de eso, el cliente agrupa antes de dibujar nada:

1. **Rejilla de tiles, no de kilómetros.** Cada anuncio cae en un tile de la
   proyección estándar del mapa. Se eligió tiles porque *anidan*: un tile es
   exactamente cuatro del nivel siguiente. Como el nivel de agrupación sigue al
   zoom, cruzar dos niveles de la misma búsqueda no acota nada por debajo del más
   fino dibujado. Con una rejilla en km sí lo haría.
2. **k-anonimato.** Una celda sólo se dibuja si reúne al menos `K_ANONYMITY`
   anuncios (3). Si no llega, sube al tile padre y lo reintenta.
3. **El punto dibujado es un nodo de rejilla, no un centroide.** El ancla se
   calcula donde está de verdad la oferta (centroide de los anuncios) pero
   **redondeada a una rejilla fija dos niveles más fina que la celda** y nunca
   más fina que el suelo de privacidad. Su precisión queda acotada en
   `anchorRadiusKm`.
4. **Suelo de resolución.** Nunca se baja de `MAX_CELL_Z` (nivel 14, ~1,9 km de
   lado a la latitud de la península), por mucho que se acerque el mapa.
5. **Sin círculos gigantes.** Lo que ni reuniendo vecinos llega a 3 no forma
   zona: sale **uno a uno**, repartido alrededor del ancla y avisando de que de
   esos anuncios sólo se conserva la provincia.
6. **Las viñetas no son posiciones.** Cuando una zona se abre, cada anuncio se
   dibuja repartido en espiral áurea **dentro de su zona**: la posición sale de
   un hash del id de la celda y del índice, **nunca de la ubicación**. La
   interfaz lo dice en la leyenda y en cada popup.
7. **Nada de código postal.** `postal_code` y las coordenadas por anuncio se
   descartan en `normalizeItem()`; sólo se conserva la provincia para etiquetar.

Diferencia con `main`: allí la agregación la hacía el servidor y las coordenadas
por anuncio no llegaban al navegador. Aquí sí llegan (ya difuminadas por
Wallapop) y viven sólo en memoria mientras dura la búsqueda; nunca se pintan.
`clampCellZ()` sigue recortando cualquier `cellZ` que llegue por la URL.

## Cómo se comporta el mapa

| Zoom del mapa | Qué se ve |
|---|---|
| lejos | Zonas grandes (nivel de celda = zoom + 2) ancladas sobre el núcleo urbano, con el número de anuncios dentro del círculo |
| medio | Las zonas se afinan al acercarse, hasta el suelo de ~1,9 km |
| cerca | Cuando el círculo da de sí, la zona **se abre**: sus anuncios se reparten por dentro con foto y precio |
| cualquiera | Los anuncios sueltos (por debajo del mínimo) siempre van de uno en uno |

Que una zona se abra no depende de un umbral de zoom escrito a mano, sino de si
sus viñetas caben dentro del círculo sin pisarse (`fitsInside()`).

Cada cambio de zoom **no vuelve a pedirle nada a Wallapop**: `store.js` guarda los
anuncios en memoria (10 min) y `recell()` los reagrupa al vuelo.

## Búsqueda progresiva

Una búsqueda es una **sesión** que va acumulando *tiles*: cada tile es una
petición a Wallapop centrada en un punto, con sus anuncios recortados al radio
del filtro de distancia (Wallapop ignora el parámetro `distance`, así que el
recorte se hace en el cliente — por eso "10 km" ahora significa 10 km de verdad).

Al **parar de mover el mapa**, si el centro del recuadro cae fuera de los tiles
ya traídos (`coverageGap()`), la app pide otro tile ahí y lo fusiona sin mover la
vista. Así la cobertura crece conforme exploras. Se guardan como mucho ~14 tiles;
los más viejos se descartan. El botón **"Buscar en esta zona"** fuerza el mismo
tile manualmente (y aparece solo si hace falta).

## Estructura

| Fichero | Qué hace |
|---|---|
| `app/public/index.html` | Interfaz: mapa Leaflet, panel de zonas, filtros. |
| `app/public/app.js` | Render del mapa, viñetas, tema, estado y URL. |
| `app/public/lib/store.js` | Sesión de búsqueda progresiva: tiles, recorte por radio, `coverageGap()`, agregación. Antes era `server.js`. |
| `app/public/lib/wallapop.js` | Cliente del endpoint de búsqueda, paginación y `normalizeItem()`. |
| `app/public/lib/privacy.js` | Rejilla de tiles y agregación con k-anonimato. `aggregate()` es pura. |
| `docker-compose.yaml` | `nginx` sirviendo `app/public`, nginx-proxy-manager (TLS) y duckdns. |

## Aviso sobre la fuente de datos

`api.wallapop.com/api/v3/search` **no es una API pública documentada**. Hoy
funciona sin autenticación (requiere `source=search_box`, coordenadas y la
cabecera `X-DeviceOS`) y **admite CORS desde cualquier origen**, que es lo que
hace posible esta versión sin backend. Cualquiera de esas dos cosas puede cambiar
sin aviso; si cierran el CORS habría que volver a un proxy propio (ver `main`).
Todo lo que depende del formato está aislado en `wallapop.js`. Úsalo a un ritmo
razonable y respeta los términos de servicio de Wallapop.
