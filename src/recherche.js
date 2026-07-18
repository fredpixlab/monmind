// ---------------------------------------------------------------
// Recherche plein-texte — moteur MiniSearch pour MonCoffre.
//
// La recherche « façon mymind » balayait déjà texte/titre/url/note/tags,
// mais en sous-chaîne brute : elle ratait les accents (« cafe » ≠ « café »),
// les fautes de frappe, et l'ordre des mots. MiniSearch corrige tout ça :
//   - accents pliés (normalisation NFD) → « cafe » trouve « café »
//   - recherche par préfixe → « cuis » trouve « cuisine » (recherche au fil de la frappe)
//   - tolérance aux fautes (fuzzy) → « recete » trouve « recette »
//   - ordre des mots libre → « italienne cuisine » trouve « cuisine italienne »
//   - résultats classés par PERTINENCE (et non plus par date)
//
// L'index ne contient que du texte + l'id ; aucune donnée n'en sort.
// ---------------------------------------------------------------
import MiniSearch from 'minisearch'

// Plie les accents et met en minuscules — appliqué À LA FOIS aux termes
// indexés et aux termes de la requête, donc « café » et « cafe » se rejoignent.
export function normaliser(terme) {
  return terme
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[\u0300-\u036f]', 'g'), '') // supprime les diacritiques (accents)
}

// `texteImage` = texte lu DANS l'image par Apple Vision (OCR) + mots-clés de
// scène. Champ cherchable mais non affiché → on retrouve une carte par ce qui
// est écrit sur l'image.
const CHAMPS = ['texte', 'titre', 'url', 'note', 'tags', 'texteImage']

// Construit un index MiniSearch à partir des cartes de contenu.
// À rappeler seulement quand la liste des cartes change (via useMemo),
// pas à chaque frappe.
export function construireIndex(cartes) {
  const mini = new MiniSearch({
    fields: CHAMPS,
    idField: 'id',
    processTerm: normaliser,
    // Les tags sont un tableau → on les aplatit en texte indexable.
    extractField: (doc, champ) => {
      const v = doc[champ]
      if (Array.isArray(v)) return v.join(' ')
      return v == null ? '' : String(v)
    },
    searchOptions: {
      prefix: true,          // recherche au fil de la frappe
      fuzzy: 0.2,            // tolère ~20 % de caractères en écart (fautes de frappe)
      combineWith: 'AND'     // tous les mots doivent matcher (recherche précise)
    }
  })
  mini.addAll(cartes || [])
  return mini
}

// Renvoie les ids des cartes qui matchent, DANS L'ORDRE DE PERTINENCE.
export function rechercher(index, requete) {
  const q = (requete || '').trim()
  if (!index || !q) return null // null = « pas de recherche active »
  return index.search(q).map(r => r.id)
}
