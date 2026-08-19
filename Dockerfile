FROM node:24-alpine

WORKDIR /app/server

RUN apk add --no-cache iputils

COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/index.js ./index.js
COPY frontend/ /app/frontend/

RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/data/assets.db \
    UPLOAD_DIR=/data/uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "index.js"]
