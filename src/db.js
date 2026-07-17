// ---------------------------------------------------------------
// La base de données LOCALE de MonMind (IndexedDB, via Dexie).
// Chaque appareil garde ici sa copie complète des cartes : c'est ce
// qui rend l'app instantanée et utilisable hors ligne.
// En Phase 3, un moteur de sync poussera/tirera ces cartes vers
// ton dossier Google Drive (la « source de vérité » partagée).
// ---------------------------------------------------------------
import Dexie from 'dexie'

export const db = new Dexie('monmind')

// Le schéma d'une carte :
//   id        : identifiant unique (généré)
//   type      : 'note' | 'lien' | 'image'
//   texte     : contenu de la note, ou commentaire
//   url       : pour les liens
//   titre     : titre du lien ou de la note
//   image     : le fichier image (Blob), stocké tel quel
//   tags      : rempli par l'IA en Phase 5
//   creeLe    : date de création (timestamp)
//   modifieLe : date de dernière modification — servira à la sync
db.version(1).stores({
  // On n'indexe que les champs sur lesquels on cherche/tri :
  cartes: 'id, type, creeLe, modifieLe'
})

export function nouvelId() {
  return crypto.randomUUID()
}

export async function ajouterCarte(carte) {
  const maintenant = Date.now()
  const complete = {
    id: nouvelId(),
    tags: [],
    creeLe: maintenant,
    modifieLe: maintenant,
    ...carte
  }
  await db.cartes.add(complete)
  return complete
}

export async function supprimerCarte(id) {
  await db.cartes.delete(id)
}

const REGEX_URL = /^https?:\/\/\S+$/i

// Détecte si un texte collé est en réalité un lien.
export function estUneUrl(texte) {
  return REGEX_URL.test(texte.trim())
}
