# MonCoffre — backend (Cloudflare Worker)

Backend minuscule et optionnel. L'app MonCoffre fonctionne sans lui ; il ajoute
deux choses qui, elles, ont besoin d'un serveur :

- **Phase A — aperçus de liens** (`/preview`) : récupère l'image d'aperçu
  (og:image / twitter:image) et le titre d'une URL, et le texte des tweets
  (oEmbed). Sans état, ne stocke rien. Règle les liens « sans aperçu ».
- **Phase B — connexion Drive permanente** (`/login`, `/callback`, `/token`,
  à venir) : garde un refresh_token Google chiffré pour ne plus avoir à
  reconnecter Drive (Safari inclus). Scope limité à `drive.file`.

## Déploiement (une fois)

Prérequis : un compte **Cloudflare** (gratuit) et `wrangler`.

```
# sur le Mac, dans ce dossier
npm install
npx wrangler login          # ouvre le navigateur → autoriser Cloudflare
npx wrangler deploy         # publie → URL type https://moncoffre-api.<sous-domaine>.workers.dev
```

`wrangler deploy` affiche l'URL publique du Worker. On la mettra ensuite dans
la config de l'app (`src/config.js`, champ `API_BASE`).

## Test rapide

```
curl "https://moncoffre-api.<sous-domaine>.workers.dev/preview?url=https://www.lemonde.fr"
```

Doit renvoyer un JSON `{ image, titre, ... }`.

## Notes

- Aucun secret en Phase A. La Phase B ajoutera un binding KV (jeton chiffré) et
  des secrets OAuth via `wrangler secret put …` (jamais dans le repo).
- Le Worker ne voit jamais le contenu de tes cartes : en Phase B, c'est toujours
  le navigateur qui parle à Google Drive ; le Worker ne fait que fabriquer des
  jetons d'accès.
