// ------------------------------------------------------------------
// Réglages de connexion à Google Drive.
// CLIENT_ID = la « carte d'identité » de l'app auprès de Google.
// Il n'est PAS secret (visible dans toutes les apps web) et sera
// rempli une fois le projet Google Cloud créé.
// ------------------------------------------------------------------

export const CLIENT_ID = '791212169245-v98msguu6c4fl19t8075l0ktij7t5hp3.apps.googleusercontent.com'

// Permission volontairement étroite : l'app ne voit QUE les fichiers
// qu'elle a elle-même créés (le dossier MonMind), jamais le reste du Drive.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

// Nom des dossiers créés dans ton Drive.
export const DOSSIER_RACINE = 'MonMind'
export const DOSSIER_CARTES = 'cartes'

export const sync_configuree = () => CLIENT_ID.length > 0
