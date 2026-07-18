#!/bin/bash
# Lanceur de la passe OCR Apple automatique (appelé par launchd toutes les ~30 min).
# PATH explicite (launchd démarre avec un environnement minimal).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DIR="/Users/fred/monmind-ocr"
LOG="$DIR/passe-auto.log"
LOCK="/tmp/moncoffre-ocr.lockdir"

# Verrou simple (macOS n'a pas flock) : si une passe tourne déjà, on sort.
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Rotation légère du log (garde les 800 dernières lignes).
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 800 ]; then tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi

NODE="$(command -v node)"; [ -z "$NODE" ] && NODE="/opt/homebrew/bin/node"
"$NODE" "$DIR/passe-auto.mjs" >> "$LOG" 2>&1
