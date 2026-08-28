# Puesta en marcha

Cómo levantar Wallapop Mapper y entrar desde `localhost`. Tres formas, de menos
a más piezas: sin Docker, sólo la app en Docker, y la pila completa tal como
corre en el servidor.

## Qué hace falta

- **Sin Docker:** Node ≥ 18.
- **Con Docker:** Docker Engine con el plugin `compose` (`docker compose version`).

No hace falta ninguna clave para buscar: `api.wallapop.com` responde sin
autenticación. El token de DuckDNS sólo entra en juego en la pila completa.

## 1. Sin Docker (lo más rápido para trastear)

```bash
cd app
npm ci
npm start
```

Abre <http://localhost:3000>. La única dependencia es `undici`, y sólo se usa
para salir por un proxy; sin `HTTPS_PROXY` en el entorno, el servidor va directo
a Wallapop.

Para recargar al guardar: `npm run dev`.

## 2. Docker, sólo la app → `localhost:3000`

Esta es la forma recomendada de probar la imagen real sin montar el dominio.

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yml \
  up -d --build wallamap squid_proxy localhost_bridge
```

Abre <http://127.0.0.1:3000>.

Levanta tres contenedores:

| Contenedor | Papel |
|---|---|
| `wallamap` | La app Node. Sólo en `red_privada`, sin puerto publicado. |
| `squid_proxy` | Su única salida a internet; deja pasar sólo `api.wallapop.com`. |
| `wallamap_localhost` | Puente de `127.0.0.1:3000` a `wallamap:3000`. Sólo para local. |

Se nombran los tres servicios a propósito: así no se arrancan de paso
nginx-proxy-manager ni duckdns, que en local no pintan nada. Y como
`docker-compose.local.yml` no se carga sola (hay que pasarla con `-f`), en el
servidor `docker compose up -d` a secas sigue levantando la pila de siempre.

### Por qué un contenedor puente y no un `ports:` en la app

Parece que bastaría con añadirle a `wallamap` un `ports: ['3000:3000']`. No
funciona: la app vive sólo en `red_privada`, que está declarada
`internal: true`, y **Docker no publica puertos de un contenedor que sólo está
en una red interna**. El binding se acepta sin quejarse y luego no existe —
`docker compose ps` deja la columna de puertos vacía y `curl` no conecta.

La otra salida sería meter a `wallamap` en una red no interna, pero eso le abre
una ruta a internet por fuera de squid, que es justo lo que la arquitectura
quiere evitar. Con el puente, `wallamap` se queda exactamente como en producción
y quien está a caballo entre las dos redes es un proxy tonto — el mismo papel
que hace nginx-proxy-manager en el servidor.

El puente escucha en `127.0.0.1`, así que el puerto no queda expuesto al resto
de la red de casa.

### Comprobar que va

```bash
# 1. El servidor responde
curl http://127.0.0.1:3000/api/health
# {"ok":true,"searches":0}

# 2. Una búsqueda de verdad (sale por squid)
curl "http://127.0.0.1:3000/api/search?keywords=bicicleta&lat=40.4168&lon=-3.7038&distance=10000&pages=1"

# 3. Squid la ha visto pasar
docker exec squid_proxy tail -3 /var/log/squid/access.log
# ... TCP_TUNNEL/200 ... CONNECT api.wallapop.com:443 ...
```

Y que el cerrojo de salida está echado:

```bash
# La app no llega a internet por su cuenta: ni resuelve el nombre
docker exec -e HTTPS_PROXY= -e HTTP_PROXY= wallamap wget -O /dev/null https://example.com
# wget: bad address 'example.com'

# Y por el proxy, todo lo que no sea Wallapop se deniega
docker exec -e http_proxy=http://squid_proxy:3128 wallamap wget -O /dev/null http://example.com/
# wget: server returned error: HTTP/1.1 403 Forbidden
```

## 3. La pila completa (como en el servidor)

Añade nginx-proxy-manager (TLS y entrada por el 80/443) y duckdns (el dominio
dinámico). Requiere los puertos 80, 443 y 81 del host libres.

Primero el token de DuckDNS, en un `.env` junto al `docker-compose.yaml`:

```bash
echo 'DUCKDNS_TOKEN=tu-token' > .env
```

Está en el `.gitignore`. Sin él, compose avisa (`variable is not set`) y el
contenedor de duckdns arranca pero no actualiza nada.

```bash
docker compose up -d --build
```

Ahora `wallamap` sigue sin puerto publicado: se entra **a través de
nginx-proxy-manager**, que sí está en las dos redes.

1. Abre el panel en <http://localhost:81>. En el primer arranque
   nginx-proxy-manager pide sus credenciales iniciales
   (`admin@example.com` / `changeme`) y obliga a cambiarlas.
2. *Hosts → Proxy Hosts → Add Proxy Host*:
   - **Domain Names:** el dominio de duckdns (o `localhost` para probar).
   - **Scheme:** `http`
   - **Forward Hostname / IP:** `wallamap`
   - **Forward Port:** `3000`
3. En la pestaña **SSL**, *Request a new SSL Certificate* si el dominio ya apunta
   aquí.

Con el proxy host apuntando a `localhost`, la app queda en <http://localhost>.

El bind del panel es `81:81`, es decir, todas las interfaces. Si prefieres que
sólo se vea desde la máquina, cámbialo en `docker-compose.yaml` por
`127.0.0.1:81:81` (o por la IP de la LAN, como estaba antes).

La primera vez, Docker crea `proxy/data/` y `proxy/letsencrypt/` como **root**;
ahí viven la base de datos y las claves privadas del proxy, y por eso están
ignorados en git.

## Cómo se conectan las redes

```
                 red_publica
                      │
          ┌───────────┴───────────┐
          │   nginx-proxy-manager │  :80 :443 :81
          └───────────┬───────────┘
                      │  red_privada  (internal: true — sin salida)
          ┌───────────┴───────────┐
          │        wallamap       │  :3000
          └───────────┬───────────┘
                      │  red_privada
          ┌───────────┴───────────┐
          │         squid         │  :3128 — sólo api.wallapop.com
          └───────────┬───────────┘
                      │  red_egress
                   internet
```

En local, `wallamap_localhost` ocupa el sitio de nginx-proxy-manager: cuelga de
`red_privada` y de una `red_local` que sí sale al host.

## Comandos útiles

```bash
# Logs de la app
docker compose logs -f wallamap

# Reconstruir tras tocar código
docker compose -f docker-compose.yaml -f docker-compose.local.yml \
  up -d --build wallamap

# Parar y borrar contenedores y redes (los datos del proxy se quedan)
docker compose -f docker-compose.yaml -f docker-compose.local.yml down
```

## Si algo no arranca

| Síntoma | Qué pasa |
|---|---|
| `curl: (7) Failed to connect` al 3000 y `docker compose ps` no muestra `127.0.0.1:3000->3000/tcp` | Falta el `-f docker-compose.local.yml`, o intentaste publicar el puerto en `wallamap` (ver arriba: red interna). |
| `bind: address already in use` | Otro proceso tiene el 3000 (o el 80/443/81). Míralo con `ss -ltnp` y cambia el puerto del host en el `ports:`. |
| La app carga pero las búsquedas dan `502` | El contenedor no sale a Wallapop. Mira `docker exec squid_proxy tail /var/log/squid/access.log`: si aparece `TCP_DENIED`, es la ACL de `squid/squid.conf`. |
| `variable is not set: DUCKDNS_TOKEN` | Falta el `.env`. Es inofensivo si no levantas `duckdns`. |
| Wallapop devuelve `403` | El endpoint exige la cabecera `X-DeviceOS`; la pone `app/lib/wallapop.js`. Si cambió el contrato, se arregla ahí. |

## Nota sobre la fuente de datos

`api.wallapop.com/api/v3/search` no es una API pública documentada: puede
cambiar, exigir firma o bloquear por volumen sin aviso. El servidor cachea por
sesión y limita a 30 peticiones por minuto y por IP. Úsalo a un ritmo razonable.
