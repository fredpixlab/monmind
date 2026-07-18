# OCR Apple automatique (Mac-local)

Agent qui passe **Apple Vision** sur les nouvelles images de MonCoffre toutes les
30 min et réécrit le texte reconnu (+ mots-clés de scène) dans Drive. L'app
resynchronise ensuite sur tous les appareils.

## Installer sur un Mac

```bash
cd ~/Github/monmind && git pull
bash outils/ocr-auto/installer.sh
```

L'installateur copie les scripts dans `~/monmind-ocr`, compile l'outil Apple
Vision, installe rclone au besoin, lance l'autorisation Google (un clic
« Autoriser »), et installe l'agent launchd.

> ⚠️ L'agent ne traite les nouvelles images **que quand ce Mac est allumé**.
> Sur un Mac souvent éteint (portable), la mise à jour se fait par à-coups.

## Fichiers

- `passe-auto.mjs` — le cœur (liste via rclone, télécharge/écrit via l'API Drive par ID, OCR, injecte `texteImage` + `appProperties.modifieLe`).
- `passe-auto.sh` — lanceur launchd (PATH, verrou, rotation du log).
- `com.fred.moncoffre-ocr.plist` — agent launchd (`StartInterval 1800`).
- `ocr.swift` — outil Apple Vision (compilé en `ocr` par l'installateur).
- `installer.sh` — installation en une commande.

## Vérifs

```bash
launchctl list | grep moncoffre     # 2e colonne = 0 → OK
tail -f ~/monmind-ocr/passe-auto.log
```
