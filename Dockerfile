# Node 22+ es el mínimo que yt-dlp acepta como runtime JS (EJS) para YouTube
FROM node:22-slim

ENV VIRTUAL_ENV=/opt/ytdlp \
    PATH=/opt/ytdlp/bin:$PATH \
    YTDLP_UPDATE_INTERVAL=86400

# yt-dlp lives in its own venv so the entrypoint can upgrade it at runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates && \
    python3 -m venv "$VIRTUAL_ENV" && \
    "$VIRTUAL_ENV/bin/pip" install --no-cache-dir --upgrade pip "yt-dlp[default]" && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p media && chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
