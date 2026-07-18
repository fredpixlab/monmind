// ---------------------------------------------------------------
// La base de données LOCALE de MonMind (IndexedDB, via Dexie).
// Chaque appareil garde ici sa copie complète des cartes.
// Le moteur de sync (drive.js) échange ces cartes avec Google Drive.
// ---------------------------------------------------------------
import Dexie from 'dexie'

export const db = new Dexie('monmind')

// v1 : schéma initial (cartes locales)
db.version(1).stores({
  cartes: 'id, type, creeLe, modifieLe'
})

// v2 : ajoute la synchronisation
//   supprime  : 0/1 — « pierre tombale » pour propager les suppressions
//   reglages  : petite table clé/valeur (dossiers Drive, dernière sync…)
db.version(2).stores({
  cartes: 'id, type, creeLe, modifieLe, supprime',
  reglages: 'cle'
})

export function nouvelId() {
  return crypto.randomUUID()
}

// --- Cartes ---------------------------------------------------

export async function ajouterCarte(carte) {
  const maintenant = Date.now()
  const complete = {
    id: nouvelId(),
    tags: [],
    espaces: [],   // identifiants des espaces où la carte est épinglée
    supprime: 0,
    creeLe: maintenant,
    modifieLe: maintenant,
    ...carte
  }
  await db.cartes.add(complete)
  return complete
}

// --- Espaces (« Spaces ») -------------------------------------
// Un espace est simplement une carte de type 'espace'. Il profite donc
// du même moteur de synchronisation que les autres cartes (aucun code de
// sync en plus). Son « titre » est le nom de l'espace. Les cartes de
// contenu mémorisent les espaces où elles sont épinglées dans `espaces`.

export async function creerEspace(nom) {
  return ajouterCarte({ type: 'espace', titre: nom.trim() })
}

// --- Spaces « intelligents » (liste par tag, façon mymind) ----
// Un espace peut porter un champ `tag` : son contenu est alors DYNAMIQUE
// (toutes les cartes qui ont ce tag), au lieu d'un épinglage manuel.

// Normalise un tag pour comparer sans se soucier de la casse ni de la
// ponctuation : « B/A » == « b/a » == « ba », « Good vibes » == « good-vibes ».
export function normTag(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Les membres d'un espace : par tag s'il est « intelligent », sinon par
// épinglage manuel (`espaces`). Fonctionne pour les deux sortes d'espaces.
export function membresEspace(espace, cartes) {
  if (!espace) return []
  if (espace.tag) {
    // Space « intelligent » : une carte en fait partie si elle porte le tag
    // (un des alias, séparés par des virgules, ex. « ai,ia ») OU si elle y a
    // été épinglée à la main (panneau de détail). Union des deux → l'épinglage
    // manuel fonctionne aussi sur les spaces par tag.
    const cibles = espace.tag.split(',').map(normTag).filter(Boolean)
    return cartes.filter(c =>
      (c.espaces || []).includes(espace.id) ||
      (c.tags || []).some(t => cibles.includes(normTag(t)))
    )
  }
  return cartes.filter(c => (c.espaces || []).includes(espace.id))
}

// Les 22 spaces de mymind à recréer (le titre affiché EST le tag).
export const SPACES_MYMIND = [
  'IA', 'Fitness', 'Recipe', 'Tools', 'Madmen', 'Ads', 'Learn', 'B/A',
  'Good vibes', 'Health', 'Web', 'Meme', 'Portrait', 'Prod', 'Movies',
  'Ecology', 'Architecture', 'Vision', 'Travel', 'Youth', 'Quote', 'History'
]

// Id DÉTERMINISTE dérivé du NOM (pas du tag) → reste stable même si on
// ajuste un alias plus tard, et évite les doublons entre appareils.
function idEspaceTag(nom) {
  return 'esp-tag-' + normTag(nom)
}

// Certains spaces mymind ont un nom FR/abrégé alors que les cartes sont
// auto-taggées en anglais → alias explicite (plusieurs séparés par virgule).
const ALIAS_TAG = { 'IA': 'ai,ia' }

// Crée (une fois) les spaces-tags manquants. Id déterministe → aucun doublon
// même si deux appareils sèment avant de se synchroniser (le même id fusionne
// proprement via last-write-wins). Le drapeau `spacesMymindSemes` évite de
// ressusciter un space que Fred aurait effacé.
export async function semerSpacesMymind() {
  if (await getReglage('spacesMymindSemes', false)) return 0
  let n = 0
  for (const nom of SPACES_MYMIND) {
    const id = idEspaceTag(nom)
    const tag = ALIAS_TAG[nom] || nom.trim().toLowerCase()
    if (!(await db.cartes.get(id))) {
      const maintenant = Date.now()
      await db.cartes.put({
        id, type: 'espace', titre: nom, tag,
        tags: [], espaces: [], supprime: 0,
        creeLe: maintenant, modifieLe: maintenant
      })
      n++
    }
  }
  await setReglage('spacesMymindSemes', true)
  return n
}

export async function renommerEspace(id, nom) {
  await majCarte(id, { titre: nom.trim() })
}

export async function supprimerEspace(id) {
  await supprimerCarte(id) // suppression douce → se propage aux autres appareils
}

// Épingle ou retire une carte d'un espace.
export async function basculerEpingle(carte, espaceId, epingler) {
  const actuels = carte.espaces || []
  const maj = epingler
    ? (actuels.includes(espaceId) ? actuels : [...actuels, espaceId])
    : actuels.filter(e => e !== espaceId)
  await majCarte(carte.id, { espaces: maj })
  return maj
}

// Suppression « douce » : on garde la carte mais on la marque supprimée
// et on met à jour sa date, pour que l'effacement se propage aux autres
// appareils via Drive. Le vrai effacement des fichiers Drive est fait
// par le moteur de sync.
export async function supprimerCarte(id) {
  const t = Date.now()
  await db.cartes.update(id, { supprime: 1, supprimeLe: t, modifieLe: t })
}

// Durée de rétention en corbeille avant effacement définitif.
export const DUREE_CORBEILLE = 30 * 24 * 60 * 60 * 1000 // 30 jours

// Restaure une carte de la corbeille (annulation / bouton « Restaurer »).
export async function restaurerCarte(id) {
  await db.cartes.update(id, { supprime: 0, supprimeLe: 0, modifieLe: Date.now() })
}

// Une carte est « échue » quand elle est en corbeille depuis plus de 30 jours
// → le moteur de sync l'efface alors pour de bon (fichiers Drive + tombstone).
export function estEchu(carte) {
  return !!(carte && carte.supprime && carte.supprimeLe &&
    (Date.now() - carte.supprimeLe >= DUREE_CORBEILLE))
}

// Modifie une carte (tags, note, titre…) et met à jour sa date pour que
// le changement se synchronise sur les autres appareils.
export async function majCarte(id, changements) {
  await db.cartes.update(id, { ...changements, modifieLe: Date.now() })
}

// Insère/met à jour une carte reçue depuis Drive (sans toucher aux dates).
export async function upsertDepuisDrive(carte) {
  await db.cartes.put(carte)
}

export async function getCarte(id) {
  return db.cartes.get(id)
}

// Enregistre une carte importée (upsert par id, idempotent).
export async function mettreCarteImportee(carte) {
  await db.cartes.put(carte)
}

// Toutes les cartes visibles (non supprimées), les plus récentes d'abord.
export async function cartesVisibles() {
  const toutes = await db.cartes.orderBy('creeLe').reverse().toArray()
  return toutes.filter(c => !c.supprime)
}

// --- Réglages (clé/valeur) -----------------------------------

export async function getReglage(cle, defaut = null) {
  const r = await db.reglages.get(cle)
  return r ? r.valeur : defaut
}

export async function setReglage(cle, valeur) {
  await db.reglages.put({ cle, valeur })
}

// --- Utilitaires ---------------------------------------------

const REGEX_URL = /^https?:\/\/\S+$/i
export function estUneUrl(texte) {
  return REGEX_URL.test(texte.trim())
}
