// ---------------------------------------------------------------
// Vocabulaire retenu — Phase 7.
// mymind collait des labels de vision par ordinateur sur chaque image
// (« gesture », « eyebrow », « flash photography »…). Ils noient les tags
// que Fred a réellement posés. Règle de tri, validée sur les données :
//
//   un tag vu sur PLUSIEURS TYPES de cartes (note, lien, vidéo, image) est
//   un tag de SUJET ; un tag vu uniquement sur des images est un label de
//   médium — mymind ne taguait automatiquement que les visuels.
//
// La règle sépare 356 tags de sujet de 5087 labels. Elle se trompe dans les
// deux sens à la marge : d'où les deux listes d'ajustement ci-dessous, seule
// partie « à la main », validée avec Fred le 26/07.
//
// Sortie : ~/MonCoffre-insights/tags-retenus.json (hors dépôt : c'est le
// vocabulaire personnel de Fred, et ce repo est public). Régénérable à tout
// moment par `node outils/insights/tags.mjs`.
// ---------------------------------------------------------------
import fs from 'fs'
import path from 'path'

// Labels de vision qui ont franchi la règle (vus sur plusieurs types par accident).
export const RETIRES = ['sky', 'water', 'graphics', 'black', 'white', 'wood',
  'human body', 'infrastructure', 'comfort', 'world']

// Catégories esthétiques recalées à tort : elles ne PEUVENT apparaître que
// sur des images, mais décrivent un goût, pas un objet photographié.
export const REPECHES = ['art', 'illustration', 'black-and-white']

// Même notion, deux graphies : on ramène la clé à sa forme canonique.
export const FUSIONS = { ia: 'ai', cinema: 'movies' }

// Utiles DANS l'app (tri, intentions) mais muets sur les goûts : gardés dans
// le coffre, écartés du corpus qui sert au portrait.
export const ORGANISATION = ['read later', 'watch later', 'screenshot', 'video']

export const norm = t => String(t || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
export const canon = t => FUSIONS[norm(t)] || norm(t)

// ---- Génération de la liste (lit les .md rapatriés) -------------
export function construire(srcMd) {
  const info = {}
  for (const f of fs.readdirSync(srcMd).filter(f => f.endsWith('.md'))) {
    const c = fs.readFileSync(path.join(srcMd, f), 'utf8')
    const fin = c.indexOf('\n---\n', 4); if (fin < 0) continue
    let m; try { m = JSON.parse(c.slice(4, fin)) } catch { continue }
    if (m.type === 'espace' || m.supprime) continue
    // Les cartes #private comptent ici : leurs tags de vision doivent être
    // nettoyés comme les autres, même si leur contenu ne sort jamais du coffre.
    for (const t of (m.tags || []).map(canon).filter(Boolean)) {
      info[t] = info[t] || { n: 0, types: new Set() }
      info[t].n++; info[t].types.add(m.type)
    }
  }
  const auto = Object.entries(info).filter(([, i]) => i.types.size > 1).map(([t]) => t)
  const coffre = new Set([...auto, ...REPECHES.map(canon), ...ORGANISATION.map(canon)])
  RETIRES.map(canon).forEach(t => coffre.delete(t))
  const corpus = new Set(coffre)
  ORGANISATION.map(canon).forEach(t => corpus.delete(t))
  const tri = s => [...s].sort((a, b) => (info[b]?.n || 0) - (info[a]?.n || 0))
  return {
    genereLe: new Date().toISOString().slice(0, 10),
    regle: 'tag vu sur plusieurs types de cartes, + repêchages − retraits',
    fusions: FUSIONS,
    coffre: tri(coffre),          // à conserver sur les cartes
    corpus: tri(corpus),          // à exposer au portrait
    comptes: Object.fromEntries(tri(coffre).map(t => [t, info[t]?.n || 0]))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = path.join(process.env.HOME, 'MonCoffre-insights')
  const liste = construire(path.join(base, 'md'))
  fs.writeFileSync(path.join(base, 'tags-retenus.json'), JSON.stringify(liste, null, 2))
  console.log(`coffre : ${liste.coffre.length} tags · corpus : ${liste.corpus.length} tags`)
  console.log('20 premiers :', liste.coffre.slice(0, 20).join(', '))
  console.log('20 derniers :', liste.coffre.slice(-20).join(', '))
}
