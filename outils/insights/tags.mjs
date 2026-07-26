// ---------------------------------------------------------------
// Génère la liste des tags retenus à partir des .md rapatriés du Drive.
//
// La RÈGLE et les ajustements vivent dans `src/vocabulaire.js`, partagé avec
// l'app (fonction « Ménage des tags » de la vue 📊) : une seule source de
// vérité, sinon le corpus et le coffre finiraient par diverger.
//
// Sortie : ~/MonCoffre-insights/tags-retenus.json — hors dépôt, car ce repo
// est public et 350 mots-clés personnels dessinent un portrait assez précis.
// Régénérable à tout moment : node outils/insights/tags.mjs
// ---------------------------------------------------------------
import fs from 'fs'
import path from 'path'
import { construireVocabulaire, canon } from '../../src/vocabulaire.js'

export { canon }

// Lit les .md et en tire la forme minimale attendue par le vocabulaire.
export function lireCartes(srcMd) {
  const cartes = []
  for (const f of fs.readdirSync(srcMd).filter(f => f.endsWith('.md'))) {
    const c = fs.readFileSync(path.join(srcMd, f), 'utf8')
    const fin = c.indexOf('\n---\n', 4); if (fin < 0) continue
    let m; try { m = JSON.parse(c.slice(4, fin)) } catch { continue }
    // Mêmes exclusions que l'app : les espaces ne sont pas du contenu, et la
    // corbeille ne doit pas peser sur le vocabulaire.
    if (m.type === 'espace' || m.supprime) continue
    cartes.push({ id: f.replace(/\.md$/, ''), type: m.type, tags: m.tags || [], source: m.source || '' })
  }
  return cartes
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = path.join(process.env.HOME, 'MonCoffre-insights')
  const cartes = lireCartes(path.join(base, 'md'))
  const v = construireVocabulaire(cartes)
  const tri = s => [...s].sort((a, b) => (v.comptes[b] || 0) - (v.comptes[a] || 0))
  const liste = {
    genereLe: new Date().toISOString().slice(0, 10),
    regle: 'tag vu sur plusieurs types de cartes, + repêchages − retraits (src/vocabulaire.js)',
    cartes: cartes.length,
    coffre: tri(v.coffre),   // à conserver sur les cartes
    corpus: tri(v.corpus),   // à exposer au portrait
    comptes: Object.fromEntries(tri(v.coffre).map(t => [t, v.comptes[t] || 0]))
  }
  fs.writeFileSync(path.join(base, 'tags-retenus.json'), JSON.stringify(liste, null, 2))
  console.log(`${cartes.length} cartes · coffre ${liste.coffre.length} tags · corpus ${liste.corpus.length} tags`)
  console.log('20 premiers :', liste.coffre.slice(0, 20).join(', '))
}
