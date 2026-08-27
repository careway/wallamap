# Wallapop Mapper

Mostrador web de Wallapop: buscas un producto y ves **dónde hay oferta**, no dónde
está cada anuncio. El detalle de las zonas sigue al zoom del mapa y, cuando te
acercas del todo, cada anuncio aparece como una viñeta con su foto dentro de su
zona.

```
npm start          # http://localhost:3000
```

Sin dependencias: sólo Node ≥ 18 (usa `fetch` nativo). Leaflet, los tiles de
OpenStreetMap y la tipografía Inter se cargan por CDN.

## Cómo protege la ubicación

Punto de partida: **las coordenadas de los anuncios no salen del servidor**.
`lib/wallapop.js` las marca como internas (`_lat`, `_lon`) y `lib/privacy.js` las
convierte en zonas antes de responder. Al navegador sólo llegan título, precio,
foto, enlace y el centro de una celda.

1. **Rejilla de tiles, no de kilómetros.** Cada anuncio cae en un tile de la
   proyección estándar del mapa. Se eligió tiles precisamente porque
   *anidan*: un tile es exactamente cuatro del nivel siguiente. Como el nivel de
   agrupación sigue al zoom, el navegador puede pedir varios niveles de la misma
   búsqueda, y con celdas anidadas cruzar dos niveles no acota nada por debajo
   del más fino publicado. Con una rejilla en km sí lo haría: la intersección de
   una celda de 1 km con otra de 2 km puede ser mucho más pequeña que ambas.
2. **k-anonimato.** Una celda sólo se publica si reúne al menos `K_ANONYMITY`
   anuncios (3). Si no llega, sube al tile padre y lo reintenta.
3. **El punto publicado es un nodo de rejilla, no un centroide.** El centro
   geométrico del tile dejaba las burbujas en mitad del campo cuando el mapa
   está lejos, así que el ancla se calcula donde está de verdad la oferta: el
   centroide de los anuncios **redondeado a una rejilla fija dos niveles más
   fina que la celda** y nunca más fina que el suelo de privacidad. Al alejarse
   eso cae sobre el núcleo urbano; de cerca coincide con el tile de siempre. Lo
   que se publica es el nodo, con su precisión acotada en `anchorRadiusKm`.
4. **Suelo de resolución.** Nunca se baja de `MAX_CELL_Z` (nivel 14, ~1,9 km de
   lado a la latitud de la península), por mucho que se acerque el mapa.
5. **Sin círculos gigantes.** Lo que ni reuniendo vecinos llega a 3 no forma
   zona: dibujar un círculo de 100 km no dice nada. Esos anuncios salen **uno a
   uno**, con su foto, repartidos alrededor del ancla y avisando de que de ellos
   sólo se publica la provincia.
6. **Las viñetas no son posiciones.** Cuando una zona se abre, cada anuncio se
   dibuja con su foto repartido en espiral áurea **dentro de su zona**, que es
   exactamente el margen de indeterminación que se publica de él: la posición sale de
   un hash del id de la celda y del índice del anuncio, **nunca de su ubicación
   real**. La interfaz lo dice en la leyenda y en cada popup. El círculo marca
   la escala de la zona, no una frontera exacta.
7. **Nada de código postal.** `postal_code` y las coordenadas se descartan; sólo
   se conserva la provincia para etiquetar la zona.

No hay controles de privacidad en la interfaz: los parámetros son constantes del
servidor (`lib/privacy.js`) y el cliente no puede pedir más detalle del permitido
—`clampCellZ()` recorta cualquier `cellZ` que llegue por la URL.

## Cómo se comporta el mapa

| Zoom del mapa | Qué se ve |
|---|---|
| lejos | Zonas grandes (nivel de celda = zoom + 2) ancladas sobre el núcleo urbano, con el número de anuncios dentro del círculo |
| medio | Las zonas se afinan al acercarse, hasta el suelo de ~1,9 km |
| cerca | Cuando el círculo da de sí, la zona **se abre**: sus anuncios se reparten por dentro con foto y precio |
| cualquiera | Los anuncios sueltos (por debajo del mínimo) siempre van de uno en uno |

Que una zona se abra o no **no depende de un umbral de zoom escrito a mano**,
sino de si sus viñetas caben dentro del círculo sin pisarse (`fitsInside()`):
con el reparto en espiral la separación típica es ~2·(0,74·R)/√n, y se exige
que supere el ancho de una viñeta. Al acercarse, el círculo crece y el grupo se
abre solo. Sólo se abren las zonas del nivel en curso: una ampliada tiene sitio
de sobra, pero repartir sus anuncios por media ciudad haría pasar por detallado
justo lo que es más impreciso.

Cada cambio de zoom **no vuelve a pedirle nada a Wallapop**: el servidor guarda
los anuncios de la búsqueda bajo un `searchId` (10 min) y `/api/cells` los
reagrupa al vuelo. El color de cada zona codifica cuántos anuncios contiene
(rampa secuencial de un solo tono, validada para daltonismo y contraste, y
recorrida al revés en tema oscuro para que "más" siga siendo "más visible").

## Estructura

| Fichero | Qué hace |
|---|---|
| `server.js` | Estáticos, `/api/search`, `/api/cells`, caché por búsqueda y límite de 30 búsquedas/min por IP. |
| `lib/wallapop.js` | Cliente del endpoint de búsqueda, paginación y normalización de anuncios. |
| `lib/privacy.js` | Rejilla de tiles y agregación con k-anonimato. `aggregate()` es pura y testeable. |
| `public/` | Interfaz: mapa Leaflet, panel de zonas, filtros, viñetas y tema claro/oscuro. |

## API

`GET /api/search` — descarga y agrupa.

| Parámetro | Por defecto | Notas |
|---|---|---|
| `keywords` | — | obligatorio |
| `lat`, `lon` | — | obligatorio, centro de la búsqueda |
| `pages` | 3 | 40 anuncios por página, máximo 5 |
| `minPrice`, `maxPrice`, `distance` | — | `distance` en metros |
| `order` | `most_relevance` | `newest`, `price_low_to_high`, `price_high_to_low`, `closest` |
| `cellZ` | 14 | nivel de agrupación pedido; se recorta a [3, 14] |

`GET /api/cells?searchId=…&cellZ=…` — reagrupa una búsqueda ya descargada sin
tocar Wallapop. Devuelve `404 {expired:true}` si ha caducado.

Respuesta: `{ searchId, query, cells: [{ id, z, lat, lon, radiusKm, anchorRadiusKm, count, anonymous, region, city, price, items }], stats }`.
`lat`/`lon` son el ancla publicada, `radiusKm` la escala de la zona y
`anchorRadiusKm` la precisión del ancla. `city` sólo aparece si el grupo cumple
el mínimo; por debajo se queda en `region`.

La interfaz refleja búsqueda y encuadre en la URL (`lat`, `lon`, `z`, `theme`),
así que un enlace se abre igual que se dejó.

## Aviso sobre la fuente de datos

`api.wallapop.com/api/v3/search` **no es una API pública documentada**. Funciona
hoy sin autenticación —requiere `source=search_box` y coordenadas—, pero puede
cambiar, exigir firma o bloquear por volumen sin previo aviso. Por eso el
proyecto cachea, limita el ritmo y aísla todo lo que depende de su formato en
`lib/wallapop.js`: si algo se rompe, se arregla en `normalizeItem()`. Úsalo a un
ritmo razonable y respeta los términos de servicio de Wallapop.
