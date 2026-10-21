#!/bin/sh
set -e

VENV_BIN="/opt/ytdlp/bin"
INTERVAL="${YTDLP_UPDATE_INTERVAL:-86400}"

update_ytdlp() {
  echo "[ytdlp-update] Checking for yt-dlp updates..."
  # [default] trae yt-dlp-ejs, que debe actualizarse junto a yt-dlp
  if "$VENV_BIN/pip" install --no-cache-dir --upgrade "yt-dlp[default]" >/tmp/ytdlp-update.log 2>&1; then
    echo "[ytdlp-update] yt-dlp version: $("$VENV_BIN/yt-dlp" --version)"
  else
    echo "[ytdlp-update] Update failed, keeping version $("$VENV_BIN/yt-dlp" --version)"
    tail -n 5 /tmp/ytdlp-update.log
  fi
}

if [ "$INTERVAL" != "0" ]; then
  while true; do
    update_ytdlp
    sleep "$INTERVAL"
  done &
fi

exec "$@"
