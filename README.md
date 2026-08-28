# Wallapop Mapper

Mostrador web de Wallapop: buscas un producto y ves **dónde hay oferta**, no dónde
está cada anuncio. El detalle de las zonas sigue al zoom del mapa y, cuando te
acercas del todo, cada anuncio aparece como una viñeta con su foto dentro de su
zona.

Quien habla con Wallapop es el **servidor**: el navegador sólo llama a `/api/*` y
nunca recibe coordenadas por anuncio. (La variante sin backend, que llama a
Wallapop desde el navegador, vive en la rama `cliente-side`.)

```
cd app
npm ci
npm start          # http://localhost:3000
```

Node ≥ 18 (usa `fetch` nativo). La única dependencia es `undici`, y sólo para
poder salir por un proxy (`HTTPS_PROXY`) en el despliegue con Docker. Leaflet, los
tiles de OpenStreetMap y la tipografía Inter se cargan por CDN.

Con Docker, para entrar desde `localhost:3000`:

```
docker compose -f docker-compose.yaml -f docker-compose.local.yml \
  up -d --build wallamap squid_proxy localhost_bridge
```

El contenedor de la app va en una red **interna** y sale a Wallapop únicamente a
través de `squid`, que sólo permite `api.wallapop.com` (`squid/squid.conf`).
Delante van nginx-proxy-manager (TLS) y duckdns, que es lo que levanta
`docker compose up -d` a secas en el servidor.

**[setup.md](setup.md)** lo cuenta paso a paso: las tres formas de arrancarlo,
por qué la app no puede publicar un puerto ella misma, cómo comprobar que el
cerrojo de salida está echado y qué mirar cuando algo no arranca.

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

Lo único posicional que sí baja al navegador son los **centros de los tiles ya
traídos** (`anchors`): son puntos que ha elegido el propio usuario moviendo el
mapa, no ubicaciones de anuncios, y sirven para que el cliente decida solo si
hace falta pedir más sin una petición por cada paneo.

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
los anuncios de la sesión bajo un `searchId` (10 min) y `/api/cells` los reagrupa
al vuelo. El color de cada zona codifica cuántos anuncios contiene (rampa
secuencial de un solo tono, validada para daltonismo y contraste, y recorrida al
revés en tema oscuro para que "más" siga siendo "más visible").

## Búsqueda progresiva

Una búsqueda es una **sesión** en el servidor que va acumulando *tiles*: cada
tile es una petición a Wallapop centrada en un punto, con sus anuncios recortados
al radio del filtro de distancia (Wallapop ignora el parámetro `distance`, así que
el recorte se hace en `server.js` — por eso "10 km" significa 10 km de verdad).

Al **parar de mover el mapa**, si el centro del recuadro cae fuera de los tiles ya
traídos (`coverageGap()` en el cliente, sobre los `anchors` que devuelve la API),
la app pide otro tile ahí con `/api/extend` y el servidor lo fusiona con los que
ya tenía, sin mover la vista. Así la cobertura crece conforme exploras. Se
guardan como mucho ~14 tiles por sesión; los más viejos se descartan. El botón
**"Buscar en esta zona"** fuerza el mismo tile manualmente (y aparece solo si
hace falta).

Cada búsqueda abre su propia sesión: como los tiles se van acumulando con el
paneo, compartirlas entre navegadores mezclaría ciudades ajenas en el mapa.

## El listado

La lista agrupa por **población** (`city`, o la provincia si el grupo no llega al
mínimo), no por celda del mapa: el mapa sigue dibujando un círculo por celda,
pero el panel junta las de un mismo municipio en una entrada con su rango de
precios y sus anuncios ordenados de más barato a más caro.

Se ordena por **cercanía al centro del mapa**: lo que tienes enfocado sale
primero, y se reordena al panear. Empate: más anuncios antes. La numeración de
las burbujas del mapa sigue a la del listado.

En **móvil** la lista es una hoja inferior arrastrable (`lib/sheet.js`): plegada
al arrancar, se sube desde el asa o la cabecera y encaja en tres posiciones; un
toque alterna entre plegada y media. El buscador se queda arriba.

## Mi ubicación

El botón azul de la esquina inferior derecha pide la ubicación, pinta un **punto
azul** (con halo de precisión) y vuela hasta allí con zoom. Mientras el punto es
el centro, la búsqueda va centrada en la persona; **en cuanto mueves el mapa**,
vuelve al modo "centro del mapa". El punto se queda y se sigue con
`watchPosition`. El selector "Centro de búsqueda" de los filtros hace lo mismo.

## Estructura

| Fichero | Qué hace |
|---|---|
| `app/server.js` | Estáticos, `/api/search`, `/api/extend`, `/api/cells`, sesiones de búsqueda progresiva y límite de 30 peticiones/min por IP. |
| `app/lib/wallapop.js` | Cliente del endpoint de búsqueda, paginación y normalización de anuncios. |
| `app/lib/privacy.js` | Rejilla de tiles y agregación con k-anonimato. `aggregate()` es pura y testeable. |
| `app/public/app.js` | Render del mapa, viñetas, listado, tema, estado y URL. |
| `app/public/lib/sheet.js` | Hoja inferior arrastrable de la lista en móvil. |
| `app/Dockerfile`, `docker-compose.yaml`, `squid/` | Despliegue: la app en red interna, con salida a Wallapop sólo vía squid. |

## API

`GET /api/search` — abre una sesión, trae su primer tile y agrupa.

| Parámetro | Por defecto | Notas |
|---|---|---|
| `keywords` | — | obligatorio |
| `lat`, `lon` | — | obligatorio, centro del primer tile |
| `pages` | 3 | 40 anuncios por página, máximo 5 |
| `minPrice`, `maxPrice`, `distance` | — | `distance` en metros; fija el radio del tile |
| `order` | `most_relevance` | `newest`, `price_low_to_high`, `price_high_to_low`, `closest` |
| `cellZ` | 14 | nivel de agrupación pedido; se recorta a [3, 14] |

`GET /api/extend?searchId=…&lat=…&lon=…&cellZ=…` — trae un tile más en ese punto
y lo fusiona con los de la sesión.

`GET /api/cells?searchId=…&cellZ=…` — reagrupa lo ya descargado sin tocar
Wallapop.

`/api/extend` y `/api/cells` devuelven `404 {expired:true}` si la sesión ha
caducado; el cliente lo trata relanzando la búsqueda.

Respuesta: `{ searchId, query, cells: [{ id, z, lat, lon, radiusKm, anchorRadiusKm, count, anonymous, region, city, price, items }], anchors, tileKm, stats }`.
`lat`/`lon` son el ancla publicada, `radiusKm` la escala de la zona y
`anchorRadiusKm` la precisión del ancla. `city` sólo aparece si el grupo cumple
el mínimo; por debajo se queda en `region`. `anchors` son los centros de los
tiles ya traídos y `tileKm` su radio.

La interfaz refleja búsqueda y encuadre en la URL (`lat`, `lon`, `z`, `theme`),
así que un enlace se abre igual que se dejó.

## Aviso sobre la fuente de datos

`api.wallapop.com/api/v3/search` **no es una API pública documentada**. Funciona
hoy sin autenticación —requiere `source=search_box`, coordenadas y la cabecera
`X-DeviceOS`—, pero puede cambiar, exigir firma o bloquear por volumen sin previo
aviso. Por eso el proyecto cachea por sesión, limita el ritmo y aísla todo lo que
depende de su formato en `lib/wallapop.js`: si algo se rompe, se arregla en
`normalizeItem()`. Úsalo a un ritmo razonable y respeta los términos de servicio
de Wallapop.
