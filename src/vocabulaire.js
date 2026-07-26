// ---------------------------------------------------------------
// Vocabulaire des tags — quels tags sont de VRAIS sujets.
//
// mymind collait des labels de vision par ordinateur sur chaque image
// (« gesture », « eyebrow », « flash photography »…) : 5087 labels pour
// 356 tags de sujet. Ils noient le signal, dans la recherche comme dans
// les insights (Phase 7).
//
// Règle, vérifiée sur les 2385 cartes du coffre de Fred : un tag vu sur
// PLUSIEURS TYPES de cartes (note, lien, vidéo, image) est un tag de SUJET ;
// un tag vu uniquement sur des images est un label de médium — mymind ne
// taguait automatiquement que les visuels. Une note ne reçoit jamais
// « #eyebrow », mais peut très bien être « #ecology ».
//
// ⚠️ Module PUR (aucun import) : il est chargé aussi bien par l'app que par
// les outils node de `outils/insights/`, qui n'ont ni Dexie ni IndexedDB.
// ---------------------------------------------------------------

// Labels de vision qui franchissent la règle par accident (assez d'images
// pour croiser un autre type). Validé avec Fred le 26/07.
export const RETIRES = ['sky', 'water', 'graphics', 'black', 'white', 'wood',
  'human body', 'infrastructure', 'comfort', 'world']

// Catégories esthétiques recalées à tort : elles ne PEUVENT apparaître que
// sur des images, mais décrivent un goût, pas un objet photographié.
export const REPECHES = ['art', 'illustration', 'black-and-white']

// Même notion, deux graphies : on ramène à la forme canonique.
export const FUSIONS = { ia: 'ai', cinema: 'movies' }

// Utiles DANS l'app (tri, intentions) mais muets sur les goûts : conservés
// sur les cartes, écartés du corpus qui sert au portrait.
export const ORGANISATION = ['read later', 'watch later', 'screenshot', 'video']

// Jamais touché : `private` pilote la confidentialité (cf. TAG_PRIVE, App.jsx).
export const INTOUCHABLES = ['private']

// Même normalisation que `normTag` (db.js). Dupliquée ici à dessein : ce
// module doit rester sans import pour être lisible par node.
export const normTag = t => String(t || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()

export const canon = t => FUSIONS[normTag(t)] || normTag(t)

// Construit le vocabulaire à partir des cartes (forme minimale : {type, tags}).
// Les cartes #private comptent : leurs tags de vision méritent le même ménage,
// même si leur contenu ne sort jamais du coffre.
export function construireVocabulaire(cartes) {
  const info = {}
  for (const c of cartes) {
    if (c.type === 'espace') continue
    for (const t of (c.tags || []).map(canon).filter(Boolean)) {
      info[t] = info[t] || { n: 0, types: new Set() }
      info[t].n++
      info[t].types.add(c.type)
    }
  }
  const coffre = new Set(Object.entries(info)
    .filter(([, i]) => i.types.size > 1).map(([t]) => t))
  REPECHES.map(canon).forEach(t => { if (info[t]) coffre.add(t) })
  ORGANISATION.map(canon).forEach(t => { if (info[t]) coffre.add(t) })
  INTOUCHABLES.map(canon).forEach(t => { if (info[t]) coffre.add(t) })
  RETIRES.map(canon).forEach(t => coffre.delete(t))

  const corpus = new Set(coffre)
  ORGANISATION.map(canon).forEach(t => corpus.delete(t))
  INTOUCHABLES.map(canon).forEach(t => corpus.delete(t))

  const comptes = {}
  for (const [t, i] of Object.entries(info)) comptes[t] = i.n
  return { coffre, corpus, comptes }
}

// Ce que deviendrait la liste de tags d'une carte après ménage.
export function tagsNettoyes(tags, coffre) {
  return [...new Set((tags || []).map(canon).filter(t => t && coffre.has(t)))]
}

// Simulation SANS écriture : ce qui changerait si on appliquait le ménage.
// Renvoie de quoi rendre compte à l'utilisateur AVANT de toucher à quoi que
// ce soit — c'est le mode « à blanc ».
export function analyserNettoyage(cartes, vocab) {
  const { coffre } = vocab
  const aTraiter = []
  const retires = {}
  let tagsAvant = 0, tagsApres = 0
  for (const c of cartes) {
    if (c.type === 'espace') continue
    const avant = c.tags || []
    const apres = tagsNettoyes(avant, coffre)
    tagsAvant += avant.length
    tagsApres += apres.length
    const memes = avant.length === apres.length &&
      avant.every((t, i) => t === apres[i])
    if (memes) continue
    avant.map(canon).forEach(t => {
      if (!apres.includes(t)) retires[t] = (retires[t] || 0) + 1
    })
    aTraiter.push({ id: c.id, avant, apres })
  }
  return {
    cartes: cartes.length,
    aTraiter,
    tagsAvant,
    tagsApres,
    topRetires: Object.entries(retires).sort((a, b) => b[1] - a[1]).slice(0, 15)
  }
}
