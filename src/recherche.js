// ---------------------------------------------------------------
// Recherche — moteur de MonCoffre, en TROIS couches.
//
//  1. GRAMMAIRE (analyserRequete) : #tag, site:domaine, "phrase exacte",
//     -exclusion. Ce sont des FILTRES durs, appliqués avant tout classement.
//  2. INDEX MiniSearch sur le texte libre restant : accents pliés, préfixes
//     (recherche au fil de la frappe), fautes tolérées, classement par
//     pertinence.
//  3. Passe « COLLÉE ». MiniSearch découpe en MOTS entiers : « legrandcontinent.eu »
//     forme UN SEUL mot, donc « grand continent » ne le trouvait JAMAIS. On garde
//     donc par carte une version de ses champs courts (titre, url, tags, note)
//     sans espaces ni ponctuation, et on y cherche la requête elle aussi collée :
//     « grand continent » → « grandcontinent » ⊂ « legrandcontinenteu ». ✓
//     Ces cartes arrivent APRÈS les résultats classés par pertinence.
//
// L'index ne contient que du texte + l'id ; aucune donnée n'en sort.
// ---------------------------------------------------------------
import MiniSearch from 'minisearch'
import { normTag } from './db.js'

// Plie les accents et met en minuscules — appliqué À LA FOIS aux termes
// indexés et aux termes de la requête, donc « café » et « cafe » se rejoignent.
export function normaliser(terme) {
  return terme
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[̀-ͯ]', 'g'), '') // supprime les accents
}

// Version « collée » : normalisée PUIS débarrassée de tout ce qui n'est ni
// lettre ni chiffre. C'est la clé de la couche 3 : elle efface la frontière
// entre « grand continent », « grand-continent » et « legrandcontinent.eu ».
export function colle(txt) {
  return normaliser(String(txt == null ? '' : txt)).replace(/[^a-z0-9]+/g, '')
}

// Mots outils : écartés de l'index ET de la requête. Sans ça, « le grand
// continent » exigeait aussi un mot commençant par « le » (recherche par
// préfixe) — « lecture », « level »… — et le classement partait dans le décor.
const MOTS_OUTILS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'au', 'aux',
  'et', 'ou', 'a', 'en', 'dans', 'sur', 'pour', 'par', 'avec', 'sans', 'ce',
  'ces', 'que', 'qui', 'the', 'of', 'and', 'to', 'in', 'on', 'for', 'is', 'it'
])

// `texteImage` = texte lu DANS l'image par Apple Vision (OCR) + mots-clés de
// scène. Champ cherchable mais non affiché.
const CHAMPS = ['texte', 'titre', 'url', 'note', 'tags', 'texteImage']

// Champs COURTS : ceux qui portent les noms soudés (domaine, tag, titre).
// Seuls eux alimentent la passe collée — inutile d'y verser des articles
// entiers, ça coûterait de la mémoire pour rien.
const CHAMPS_COURTS = ['titre', 'url', 'tags', 'note']

// Poids : un mot trouvé dans le titre ou un tag compte plus que le même mot
// noyé dans l'OCR d'une capture d'écran.
const POIDS = { titre: 4, tags: 4, url: 3, note: 2, texte: 1, texteImage: 1 }

const valeur = (doc, champ) => {
  const v = doc[champ]
  if (Array.isArray(v)) return v.join(' ')
  return v == null ? '' : String(v)
}

// Tout le texte cherchable d'une carte, pour les filtres « phrase » et
// « exclusion » (calculé à la volée : ces opérateurs sont rares).
function texteCarte(c) {
  return CHAMPS.map(f => valeur(c, f)).join(' ')
}

function domaine(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return String(url || '') }
}

// Construit l'index. Renvoie { mini, colles } : le moteur MiniSearch ET la
// table id → texte collé des champs courts (couche 3). À rappeler seulement
// quand la liste des cartes change (via useMemo), pas à chaque frappe.
export function construireIndex(cartes) {
  const mini = new MiniSearch({
    fields: CHAMPS,
    idField: 'id',
    // Un mot outil renvoie null → MiniSearch l'écarte, à l'indexation
    // comme dans la requête.
    processTerm: (terme) => {
      const n = normaliser(terme)
      return MOTS_OUTILS.has(n) ? null : n
    },
    extractField: valeur,
    searchOptions: {
      prefix: true,          // recherche au fil de la frappe
      boost: POIDS,
      // Tolérance aux fautes en NOMBRE DE LETTRES, pas en pourcentage.
      // Avec 0.2, « continent » (9 lettres) autorisait round(9×0.2) = 2 fautes :
      // il ramenait « content », « continue », « contingent ». Une seule faute
      // au-delà de 5 lettres, aucune en dessous : c'est ce qu'on veut d'une
      // recherche « précise ».
      fuzzy: (terme) => (terme.length <= 5 ? false : 1),
      combineWith: 'AND'     // tous les mots doivent matcher
    }
  })
  const liste = cartes || []
  mini.addAll(liste)
  const colles = new Map()
  for (const c of liste) colles.set(c.id, colle(CHAMPS_COURTS.map(f => valeur(c, f)).join(' ')))
  return { mini, colles }
}

// ---- Grammaire de requête ----------------------------------------------
// #tag              → la carte porte ce tag (match exact, tolérant casse/ponctuation)
// site:domaine      → la carte est un lien de ce domaine  (alias : domaine:)
// "phrase exacte"   → cette suite de mots, dans cet ordre
// -mot              → exclut les cartes qui contiennent ce mot
// le reste          → texte libre confié à MiniSearch
export function analyserRequete(q) {
  const tags = [], sites = [], phrases = [], exclus = [], mots = []
  // Un jeton = soit "une phrase entre guillemets", soit une suite sans espace.
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(String(q || '')))) {
    if (m[1] != null) {                       // "phrase exacte"
      const p = colle(m[1]); if (p) phrases.push(p)
      continue
    }
    const tok = m[2]
    if (tok[0] === '#' && tok.length > 1) {   // #tag
      const t = normTag(tok.slice(1)); if (t) tags.push(t)
      continue
    }
    if (tok[0] === '-' && tok.length > 1) {   // -exclusion
      const x = colle(tok.slice(1)); if (x) exclus.push(x)
      continue
    }
    const s = tok.match(/^(?:site|domaine):(.+)$/i)
    if (s) {                                  // site:domaine
      const d = colle(s[1]); if (d) sites.push(d)
      continue
    }
    mots.push(tok)
  }
  return { tags, sites, phrases, exclus, texte: mots.join(' ') }
}

// Applique les filtres DURS (site:, "phrase", -exclusion) à une liste de
// cartes. Les #tag restent gérés côté App (ils croisent les espaces).
// Tout passe par la forme collée : la ponctuation et les espaces ne comptent
// pas, donc « sam altman » retrouve aussi « sam-altman » dans une URL.
export function filtrerRequete(liste, req) {
  let out = liste
  if (req.sites.length) {
    out = out.filter(c => {
      const d = colle(domaine(c.url || ''))
      return d && req.sites.some(s => d.includes(s))
    })
  }
  if (req.phrases.length || req.exclus.length) {
    out = out.filter(c => {
      const h = colle(texteCarte(c))
      if (!req.phrases.every(p => h.includes(p))) return false
      return !req.exclus.some(x => h.includes(x))
    })
  }
  return out
}

// Renvoie les ids qui matchent le TEXTE LIBRE, dans l'ordre de pertinence,
// puis (couche 3) les cartes dont un champ court contient la requête collée.
// `null` = « pas de recherche plein-texte active » → l'appelant garde son
// ordre par date.
export function rechercher(index, requete) {
  const q = String(requete || '').trim()
  if (!index || !q) return null
  const ids = index.mini.search(q).map(r => r.id)
  const vus = new Set(ids)
  const cq = colle(q)
  if (cq.length >= 3) {
    for (const [id, court] of index.colles) {
      if (!vus.has(id) && court.includes(cq)) { ids.push(id); vus.add(id) }
    }
  }
  return ids
}
