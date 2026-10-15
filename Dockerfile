# Commander Daily — production image.
#
#   docker build -t commander-daily .
#   docker run -p 3000:3000 -v cd-data:/data \
#     -e SESSION_SECRET=$(openssl rand -hex 32) \
#     -e DATA_FILE=/data/store.json commander-daily
#
# Zero runtime dependencies, so the image is just Node + the source. Works on
# amd64 and arm64 (Arm is what Oracle's Always Free tier gives you).
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/data/store.json

WORKDIR /app

# No package-lock/node_modules stage: the app has no dependencies to install.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests

# Writable volume for the JSON store; on a host with an ephemeral filesystem,
# point STORE_BACKEND=upstash at a KV instead (see DEPLOY.md).
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/server.js"]
