FROM node:18-alpine

WORKDIR /usr/src/app

# Copiamos solo los manifiestos primero (mejor cache de capas)
COPY package*.json ./

RUN npm ci --omit=dev

# Ahora copiamos el resto del código
COPY . .

USER node

CMD ["node", "server.js"]