FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=7000 \
    HOST=0.0.0.0 \
    CONFIG_FILE=/data/config.json \
    CACHE_DIR=/data/cache

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# su-exec: cedere i privilegi all'entrypoint dopo il chown del volume
# ffmpeg + ttf-dejavu: video di errore "a schermo" della diagnostica stream
# (STREAM DIAG) e rilevazione risoluzione/codec con ffprobe nei log live
RUN apk add --no-cache su-exec ffmpeg ttf-dejavu \
    && mkdir -p /data \
    && addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 7000

# parte come root SOLO per sistemare il volume, poi l'entrypoint passa ad "app"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
