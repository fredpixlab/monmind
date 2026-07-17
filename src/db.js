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
  await db.cartes.update(id, { supprime: 1, modifieLe: Date.now() })
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
