#!/bin/bash
# ==================================================================
# MonCoffre — installe l'agent OCR Apple AUTOMATIQUE sur CE Mac.
# À lancer depuis le repo :  bash outils/ocr-auto/installer.sh
# Idempotent : relançable sans risque.
# ==================================================================
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/monmind-ocr"
UID_="$(id -u)"
mkdir -p "$DEST"

echo "→ Copie des scripts dans $DEST"
cp "$SRC/passe-auto.mjs" "$SRC/passe-auto.sh" "$SRC/ocr.swift" "$DEST/"
chmod +x "$DEST/passe-auto.sh"

echo "→ Compilation de l'outil Apple Vision (natif macOS, sans dépendance)"
( cd "$DEST" && swiftc -O ocr.swift -o ocr )

if ! command -v rclone >/dev/null 2>&1; then
  echo "→ Installation de rclone (Homebrew)…"
  brew install rclone
fi

if ! rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  echo "→ Autorisation Google Drive : une fenêtre va s'ouvrir."
  echo "  Choisis fredpixlab@gmail.com puis « Autoriser » (écran « app non vérifiée » → Avancé → Accéder)."
  rclone config create gdrive drive scope drive
else
  echo "→ Remote rclone « gdrive » déjà configuré."
fi

echo "→ Installation de l'agent launchd (toutes les 30 min)"
PLIST="$HOME/Library/LaunchAgents/com.fred.moncoffre-ocr.plist"
cp "$SRC/com.fred.moncoffre-ocr.plist" "$PLIST"
launchctl bootout "gui/$UID_/com.fred.moncoffre-ocr" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" "$PLIST"

echo ""
echo "✓ Terminé. L'agent tourne et se relancera toutes les 30 min."
echo "  Vérif état   : launchctl list | grep moncoffre   (2e colonne = 0 → OK)"
echo "  Voir le log  : tail -f $DEST/passe-auto.log"
