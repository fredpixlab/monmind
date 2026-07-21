# MonMind

Ton second cerveau visuel — un remplaçant de mymind dont **les données restent chez toi** (dossier Google Drive), utilisable sur Mac, iPad et iPhone en PWA, sans App Store.

Le plan complet du projet est dans le projet Claude « Remplacer mymind ».

## État d'avancement

- [x] **Phase 1** — Squelette PWA installable (grille, composeur, base locale IndexedDB)
- [x] Phase 2 (partielle) — Cartes note / lien / image en local
- [x] **Phase 3** — Synchronisation Google Drive ✅ 2026-07-21
- [ ] Phase 4 — Capture (bookmarklet Mac, Raccourci iOS, photos/vidéos)
- [ ] Phase 5 — Tags IA automatiques, couleurs dominantes
- [x] Phase 6 — Recherche avancée, Smart Spaces, Serendipity ✅ 2026-07-21
- [ ] Phase 7 — Connecteur Claude (portrait de mes goûts)
- [x] Phase 8 — Migration depuis mymind ✅ 2026-07-21

## Architecture (résumé)

L'app est **local-first** : chaque appareil garde une copie complète des cartes dans IndexedDB (`src/db.js`), ce qui la rend instantanée et utilisable hors ligne. Le service worker (généré par `vite-plugin-pwa`) met l'app en cache pour l'installation. En Phase 3, un moteur de sync poussera les cartes vers un dossier `MonMind/` de Google Drive, source de vérité partagée entre les appareils — et lisible par Claude via son connecteur Drive.

## Développement

```bash
npm install       # une seule fois
npm run icons     # régénérer les icônes si besoin
npm run dev       # serveur local
npm run build     # build de production (dossier dist/)
```

## Déploiement

Automatique : chaque push sur `main` déclenche le workflow GitHub Actions qui publie sur GitHub Pages → https://fredpixlab.github.io/monmind/

(Pré-requis fait une seule fois : Settings → Pages → Source = « GitHub Actions ».)
