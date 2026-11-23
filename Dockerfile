FROM node:26-slim

# Links the GHCR package to the repo.
LABEL org.opencontainers.image.source="https://github.com/rhapsody008/zy-assistant"

WORKDIR /srv/app

# Runtime deps only: @slack/bolt. Node runs the TypeScript directly.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

ENV DB_PATH=/data/state.db
USER node

CMD ["node", "src/main.ts", "run"]
