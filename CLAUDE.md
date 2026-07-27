# CLAUDE.md — monmind / MonCoffre

> ⚠️ **CE DÉPÔT EST PUBLIC.** github.com/fredpixlab/monmind — lisible par n'importe qui.
> GitHub Pages gratuit l'impose (c'est lui qui sert l'app).

## Règle absolue : aucune note de travail ici

Pas de journal, pas de plan d'attaque, pas de réflexion stratégique, pas
d'identifiants d'infrastructure, pas de données personnelles de Fred.
**L'historique git est définitif** : un fichier commité puis supprimé reste
clonable par tout le monde, pour toujours.

Tout ça vit dans le carnet privé :

- **Journal technique** → `~/Github/fred-ops/perso/monmind/journal-technique.md`
- **Carte du projet** → `~/Github/fred-ops/perso/monmind/overview.md`

Ce qui a le droit d'être ici : le **code**, et une doc d'usage qui ne révèle
rien (README, worker/README).

## Ce qui est déjà public, et pourquoi c'est acceptable

- `src/config.js` → `CLIENT_ID` Google : **non secret par conception**, il part
  dans le navigateur de chaque visiteur.
- `worker/wrangler.toml` → id du namespace KV : un identifiant, pas une clé
  (inutilisable sans jeton d'API Cloudflare).
- Les secrets réels (`TOKEN_KEY`, `GOOGLE_CLIENT_SECRET`) sont posés par
  `wrangler secret put` et **ne sont pas dans le dépôt**.
- ❌ **L'id de compte Cloudflare n'est PAS ici et ne doit pas y arriver.**

## Données personnelles : hors dépôt

`~/MonCoffre-insights/` (corpus, `tags-retenus.json`, sauvegardes des `.md`).
Le vocabulaire de tags de Fred dessine un portrait précis de ses centres
d'intérêt : il ne doit jamais être versionné ici. Seuls les **scripts**
(`outils/insights/`) le sont ; ils recalculent tout à la volée.

## Avant toute mise en ligne d'un nouveau fichier

Se demander : « est-ce que je serais à l'aise que ça soit lu par un inconnu,
ou par un client ? » Si non → carnet privé.

Contrôle automatique : `~/Github/fred-ops/scripts/audit-passation.sh monmind`
