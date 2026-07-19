// ==================================================================
// MonMind — moteur de synchronisation Google Drive (Phase 3)
//
// Modèle : « local-first » + « last-write-wins ».
//   - Chaque carte est un fichier <id>.md dans MonMind/cartes/.
//   - Son image éventuelle est un fichier <id>.<ext> à côté.
//   - Une suppression laisse un marqueur <id>.deleted (pierre tombale).
//   - En cas de conflit, la version dont la date modifieLe est la plus
//     récente l'emporte.
//
// Authentification : Google Identity Services (jeton d'accès côté
// navigateur, permission drive.file = l'app ne voit que ses fichiers).
// ==================================================================
import { db, upsertDepuisDrive, getReglage, setReglage, estEchu } from './db.js'
import { CLIENT_ID, DRIVE_SCOPE, DOSSIER_RACINE, DOSSIER_CARTES, API_BASE } from './config.js'
import { typeMime } from './vignette.js'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

// Délai maximum d'un upload, proportionnel à la taille (borné), pour ne
// jamais rester figé sur un fichier bloqué (une erreur est alors levée et
// l'import la retentera au prochain passage).
function delaiUpload(taille = 0) {
  return Math.min(1_200_000, Math.max(120_000, Math.round(taille / 50)))
}
function controleurDelai(ms) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  return { signal: c.signal, fini: () => clearTimeout(t) }
}

let tokenClient = null
let jeton = null          // { access_token, expire }  (persisté dans IndexedDB)
let racineId = null
let cartesId = null
// Certains navigateurs (cookies tiers bloqués) empêchent le renouvellement
// SILENCIEUX du jeton : Google ouvre alors un mini-popup qui se referme
// (popup_closed). Dès qu'on détecte ça, on cesse de tenter le silencieux
// (donc plus de flash) et on demande à l'utilisateur de cliquer « Connecter ».
let silentBloque = false

// ---- Authentification -------------------------------------------

// Attend que le script Google Identity Services soit chargé.
function attendreGIS() {
  return new Promise((resolve, reject) => {
    let essais = 0
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(t); resolve() }
      else if (++essais > 100) { clearInterval(t); reject(new Error('Google Identity Services non chargé')) }
    }, 100)
  })
}

// Erreur spécifique : le jeton n'a pas pu être obtenu sans interaction.
// On l'utilise pour réafficher le bouton « Connecter » plutôt que de
// rester bloqué.
export class BesoinReconnexion extends Error {
  constructor(cause) { super('Reconnexion Google nécessaire' + (cause ? ` (${cause})` : '')); this.name = 'BesoinReconnexion' }
}

export async function initAuth() {
  if (!CLIENT_ID) throw new Error('CLIENT_ID manquant (config.js)')
  silentBloque = (await getReglage('silentBloque', false)) === true
  await attendreGIS()
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: () => {},        // remplacé à chaque demande
    error_callback: () => {}   // idem — évite les blocages si le popup échoue
  })
}

// Demande un jeton d'accès Google.
//   prompt = 'none'    → silencieux (aucune fenêtre) : échoue si Google a
//                        besoin d'une interaction → on affiche « Connecter ».
//   prompt = ''        → montre le sélecteur de compte / le consentement
//                        seulement si nécessaire (clic sur le bouton).
// Garde-fous : délai maximum + error_callback pour ne JAMAIS rester bloqué.
// À chaque succès, le jeton est mémorisé sur le disque (IndexedDB) pour
// survivre aux rechargements de page.
function demanderJeton(prompt) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Auth non initialisée'))
    let fini = false
    const finir = (fn, arg) => { if (!fini) { fini = true; clearTimeout(minuteur); fn(arg) } }
    const minuteur = setTimeout(
      () => finir(reject, new BesoinReconnexion('délai dépassé')),
      prompt === 'none' ? 12000 : 120000
    )
    tokenClient.callback = (rep) => {
      if (rep && rep.error) {
        if (prompt === 'none') marquerSilentBloque()
        return finir(reject, new BesoinReconnexion(rep.error))
      }
      const duree = (rep.expires_in && rep.expires_in > 0) ? rep.expires_in : 3600  // garde-fou
      jeton = { access_token: rep.access_token, expire: Date.now() + (duree - 60) * 1000 }
      setReglage('jeton', jeton).catch(() => {})   // persiste pour les rechargements
      finir(resolve, jeton)
    }
    tokenClient.error_callback = (err) => {
      // Silencieux bloqué (popup_closed / COOP…) → on cesse d'insister.
      if (prompt === 'none') marquerSilentBloque()
      finir(reject, new BesoinReconnexion(err && err.type))
    }
    tokenClient.requestAccessToken({ prompt })
  })
}

function marquerSilentBloque() {
  silentBloque = true
  setReglage('silentBloque', true).catch(() => {})
}

// Recharge le jeton persisté (au démarrage), s'il est encore valide.
async function chargerJetonPersiste() {
  if (jeton) return
  const j = await getReglage('jeton')
  if (j && j.access_token && Date.now() < j.expire) jeton = j
}

// --- Session « backend » (connexion Drive permanente, Phase B) ----------
// Si l'app a un `sid` (jeton de session émis par le Worker après OAuth), on
// obtient les access_tokens Drive via le backend (POST /token) au lieu du
// renouvellement silencieux GIS — bloqué par Safari. Le sid vit dans IndexedDB
// et voyage en en-tête Authorization (pas un cookie tiers). Sinon, on garde
// tout le mécanisme GIS d'origine (repli).
async function sidCourant() { return API_BASE ? await getReglage('sid', null) : null }
export async function enregistrerSession(sid) { await setReglage('sid', sid) }
export async function aSessionBackend() { return !!(await sidCourant()) }

async function jetonViaBackend() {
  const sid = await sidCourant()
  if (!sid) return null
  if (jeton && Date.now() < jeton.expire) return jeton.access_token
  const rep = await fetch(API_BASE + '/token', { method: 'POST', headers: { Authorization: 'Bearer ' + sid } })
  if (rep.status === 401) { await setReglage('sid', null); return null } // session morte → repli GIS
  if (!rep.ok) throw new Error('token backend ' + rep.status)
  const j = await rep.json()
  const duree = (j.expires_in && j.expires_in > 0) ? j.expires_in : 3600
  jeton = { access_token: j.access_token, expire: Date.now() + (duree - 60) * 1000 }
  await setReglage('jeton', jeton).catch(() => {})
  return j.access_token
}

// Le jeton courant s'il est valide, SANS jamais déclencher de fenêtre Google.
// Utilisé par l'affichage (ouverture d'une carte) : pas de popup surprise.
export async function jetonPret() {
  const b = await jetonViaBackend().catch(() => null)
  if (b) return b
  if (!jeton) await chargerJetonPersiste()
  return (jeton && Date.now() < jeton.expire) ? jeton.access_token : null
}

async function jetonValide() {
  const b = await jetonViaBackend().catch(() => null)
  if (b) return b
  if (!jeton) await chargerJetonPersiste()
  if (jeton && Date.now() < jeton.expire) return jeton.access_token
  // Silencieux connu comme bloqué → inutile de retenter (ça ne ferait que
  // clignoter) : on demande une reconnexion volontaire.
  if (silentBloque) throw new BesoinReconnexion('silencieux bloqué')
  await demanderJeton('none')
  return jeton.access_token
}

// Rafraîchit le jeton en tâche de fond quand il lui reste peu de validité.
// Avec une session backend : passe par le Worker (marche partout, Safari inclus).
// Sinon : renouvellement silencieux GIS, SEULEMENT s'il fonctionne sur ce navigateur.
export async function rafraichirJeton() {
  if (await sidCourant()) {
    if (!jeton || Date.now() > jeton.expire - 5 * 60 * 1000) { await jetonViaBackend().catch(() => {}) }
    return
  }
  if (silentBloque) return
  if (!jeton) await chargerJetonPersiste()
  if (!jeton) return
  if (Date.now() > jeton.expire - 5 * 60 * 1000) {
    try { await demanderJeton('none') } catch { /* on retentera plus tard */ }
  }
}

// Connexion volontaire (clic sur le bouton). Avec un backend : redirige vers le
// consentement Google (offline) → connexion PERMANENTE (le Worker garde le
// refresh_token). Sans backend : ancien flux GIS (jeton 1 h, popup).
export async function connecter() {
  if (API_BASE) {
    window.location.href = API_BASE + '/login'
    return new Promise(() => {}) // la page navigue ailleurs ; ne se résout pas
  }
  if (!tokenClient) await initAuth()
  await demanderJeton('')
  silentBloque = false
  await setReglage('silentBloque', false).catch(() => {})
  await setReglage('driveConnecte', true)
  return true
}

export async function estDejaConnecte() {
  if (await sidCourant()) return true
  return (await getReglage('driveConnecte', false)) === true
}

// Ne touche PAS au `sid` : une erreur transitoire ne doit pas casser la session
// permanente (le sid n'est effacé que sur un vrai 401 du backend, ou logout).
export async function deconnecter() {
  jeton = null
  await setReglage('driveConnecte', false)
  await setReglage('jeton', null)
}

// ---- Appels Drive bas niveau ------------------------------------

async function api(chemin, options = {}) {
  const token = await jetonValide()
  const rep = await fetch(chemin.startsWith('http') ? chemin : API + chemin, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) }
  })
  if (!rep.ok) {
    const txt = await rep.text()
    throw new Error(`Drive ${rep.status}: ${txt.slice(0, 200)}`)
  }
  return rep
}

async function trouverDossier(nom, parentId) {
  const q = [
    `name='${nom}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    parentId ? `'${parentId}' in parents` : "'root' in parents"
  ].join(' and ')
  const rep = await api(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`)
  const data = await rep.json()
  return data.files[0]?.id || null
}

async function creerDossier(nom, parentId) {
  const rep = await api('/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: nom,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    })
  })
  return (await rep.json()).id
}

// Garantit l'existence de MonMind/ et MonMind/cartes/ (mémorise les IDs).
async function garantirDossiers() {
  racineId = await getReglage('racineId')
  cartesId = await getReglage('cartesId')
  if (racineId && cartesId) return
  racineId = racineId || await trouverDossier(DOSSIER_RACINE, null) || await creerDossier(DOSSIER_RACINE, null)
  cartesId = cartesId || await trouverDossier(DOSSIER_CARTES, racineId) || await creerDossier(DOSSIER_CARTES, racineId)
  await setReglage('racineId', racineId)
  await setReglage('cartesId', cartesId)
}

// Envoi multipart (métadonnées + contenu) : création ou mise à jour.
async function televerser(fileId, metadata, blob, contentType) {
  // À la MISE À JOUR (PATCH), Drive interdit le champ `parents` dans le
  // corps (« The parents field is not directly writable in update requests »).
  // On ne l'envoie donc que pour une création (POST).
  const meta = fileId
    ? Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== 'parents'))
    : metadata
  const limite = '-------monmind' + Math.round(performance.now())
  const parties = [
    `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${limite}\r\nContent-Type: ${contentType}\r\n\r\n`
  ]
  const corps = new Blob([parties[0], parties[1], blob, `\r\n--${limite}--`])
  const url = fileId
    ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`
  const d = controleurDelai(delaiUpload(blob?.size))
  let rep
  try {
    rep = await api(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${limite}` },
      body: corps,
      signal: d.signal
    })
  } finally { d.fini() }
  return rep.json()
}

async function supprimerFichier(fileId) {
  await api(`/files/${fileId}`, { method: 'DELETE' })
}

// Purge immédiate d'une carte (bouton « Supprimer définitivement » de la
// corbeille) : efface ses fichiers Drive connus + pose la pierre tombale.
// L'appelant retire ensuite la carte locale. Nécessite d'être connecté.
export async function purgerCarte(carte) {
  await jetonValide()
  await garantirDossiers()
  for (const fid of [carte.driveMdId, carte.driveMediaId, carte.driveVignetteId, carte.driveImgId]) {
    if (fid) await supprimerFichier(fid).catch(() => {})
  }
  await televerser(null,
    { name: `${carte.id}.deleted`, parents: [cartesId], appProperties: { cardId: carte.id } },
    new Blob(['supprimé']), 'text/plain')
}

// Upload « resumable » (pour les gros fichiers : vidéos, grosses images).
// L'upload multipart simple est limité à ~5 Mo ; au-delà, on ouvre une
// session resumable puis on envoie le contenu.
async function televerserResumable(metadata, blob, contentType) {
  const token = await jetonValide()
  const dInit = controleurDelai(60_000)
  let initRep
  try {
    initRep = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,modifiedTime`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(blob.size)
      },
      body: JSON.stringify(metadata),
      signal: dInit.signal
    })
  } finally { dInit.fini() }
  if (!initRep.ok) throw new Error(`Drive resumable init ${initRep.status}: ${(await initRep.text()).slice(0, 200)}`)
  const session = initRep.headers.get('Location')
  if (!session) throw new Error('Drive resumable : session URI manquante')
  const dPut = controleurDelai(delaiUpload(blob.size))
  let putRep
  try {
    putRep = await fetch(session, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob, signal: dPut.signal })
  } finally { dPut.fini() }
  if (!putRep.ok) throw new Error(`Drive resumable put ${putRep.status}: ${(await putRep.text()).slice(0, 200)}`)
  return putRep.json()
}

// Choisit multipart (petit) ou resumable (gros) selon la taille.
function televerserFichier(metadata, blob, contentType) {
  return blob.size > 5 * 1024 * 1024
    ? televerserResumable(metadata, blob, contentType)
    : televerser(null, metadata, blob, contentType)
}

// Pousse une carte importée (média « à la demande ») vers Drive :
//   <id>.<ext>       le fichier complet (image/vidéo/pdf)
//   <id>.thumb.jpg   la vignette (miniature légère)
//   <id>.md          les métadonnées
// L'appareil ne gardera en local que la vignette ; le fichier complet
// sera récupéré depuis Drive à la demande.
export async function pousserCarteImportee(carte, fichier, vignetteBlob) {
  await jetonValide()
  await garantirDossiers()
  const ext = (carte.mediaExt || 'bin').toLowerCase()

  const nomMedia = `${carte.id}.${ext}`
  const media = await televerserFichier(
    { name: nomMedia, parents: [cartesId], appProperties: { cardId: carte.id, kind: 'media', type: carte.type } },
    fichier, fichier.type || typeMime(ext)
  )

  const nomVign = `${carte.id}.thumb.jpg`
  const vign = await televerser(null,
    { name: nomVign, parents: [cartesId], appProperties: { cardId: carte.id, kind: 'vignette' } },
    vignetteBlob, 'image/jpeg')

  const contenu = serialiserMd({ ...carte, vignetteNom: nomVign }, nomMedia)
  const md = await televerser(null,
    { name: `${carte.id}.md`, parents: [cartesId],
      appProperties: { cardId: carte.id, modifieLe: String(carte.modifieLe), type: carte.type } },
    new Blob([contenu]), 'text/markdown')

  return { driveMediaId: media.id, driveVignetteId: vign.id, driveMdId: md.id, vignetteNom: nomVign }
}

// Pousse une carte importée SANS média (note / lien) : juste le .md.
export async function pousserCarteTexte(carte) {
  await jetonValide()
  await garantirDossiers()
  const contenu = serialiserMd(carte, '')
  const md = await televerser(null,
    { name: `${carte.id}.md`, parents: [cartesId],
      appProperties: { cardId: carte.id, modifieLe: String(carte.modifieLe), type: carte.type } },
    new Blob([contenu]), 'text/markdown')
  return { driveMdId: md.id }
}

// Récupère un fichier complet depuis Drive (vue détail, à la demande).
// Récupère un fichier complet depuis Drive (vue détail / téléchargement).
// N'utilise QUE le jeton déjà valide : si le jeton est expiré, on lève une
// erreur (l'appelant se contente alors d'afficher la vignette) — jamais de
// popup Google surprise pendant la simple ouverture d'une carte.
export async function telechargerMediaComplet(driveId) {
  const token = await jetonPret()
  if (!token) throw new BesoinReconnexion('jeton expiré')
  const rep = await fetch(`${API}/files/${driveId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + token }
  })
  if (!rep.ok) throw new Error(`Drive ${rep.status}`)
  return rep.blob()
}

async function listerCartesDrive() {
  const fichiers = []
  let pageToken = null
  do {
    const params = new URLSearchParams({
      q: `'${cartesId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,appProperties)',
      pageSize: '1000'
    })
    if (pageToken) params.set('pageToken', pageToken)
    const rep = await api(`/files?${params}`)
    const data = await rep.json()
    fichiers.push(...data.files)
    pageToken = data.nextPageToken
  } while (pageToken)
  return fichiers
}

async function telechargerTexte(fileId) {
  const rep = await api(`/files/${fileId}?alt=media`)
  return rep.text()
}

async function telechargerBlob(fileId) {
  const rep = await api(`/files/${fileId}?alt=media`)
  return rep.blob()
}

// ---- Sérialisation d'une carte en .md ---------------------------
// Format : ---\n<JSON metadata sur une ligne>\n---\n<texte>
// Lisible par un humain et par Claude, tout en étant sûr à re-parser.

function extensionImage(blob) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }
  return map[blob?.type] || 'bin'
}

function serialiserMd(carte, nomImage) {
  const meta = {
    v: 1, type: carte.type, titre: carte.titre || '', url: carte.url || '',
    apercu: carte.apercu || '', tags: carte.tags || [], note: carte.note || '',
    espaces: carte.espaces || [],   // appartenance aux espaces (pin manuel)
    tag: carte.tag || '',           // pour un espace « intelligent » : son tag
    texteImage: carte.texteImage || '', // OCR + mots-clés (Apple Vision), cherchable
    // État corbeille (propagé aux autres appareils sans effacer les fichiers).
    supprime: carte.supprime ? 1 : 0,
    supprimeLe: carte.supprimeLe || 0,
    creeLe: carte.creeLe, modifieLe: carte.modifieLe,
    image: nomImage || '',
    // Médias « à la demande » (import mymind) : le fichier complet vit
    // dans Drive, l'appareil ne garde qu'une vignette.
    distant: carte.distant ? 1 : 0,
    mediaExt: carte.mediaExt || '',
    vignette: carte.vignetteNom || '',
    source: carte.source || '', sourceId: carte.sourceId || '',
    articleLe: carte.articleLe || 0   // date de capture du « Lecture » (0 = aucun)
  }
  // L'article capturé (mode « Lecture ») est rangé dans le corps du .md, après
  // un séparateur : ainsi le texte lisible vit EN CLAIR dans Drive et survit si
  // la page d'origine disparaît. Le corps normal (note libre) reste en premier.
  let corps = carte.texte || ''
  if (carte.article) corps += MARQUE_ARTICLE + carte.article
  return `---\n${JSON.stringify(meta)}\n---\n${corps}`
}

const MARQUE_ARTICLE = '\n\n===MONCOFFRE-ARTICLE===\n'

function parserMd(contenu) {
  if (!contenu.startsWith('---\n')) return null
  const fin = contenu.indexOf('\n---\n', 4)
  if (fin === -1) return null
  const meta = JSON.parse(contenu.slice(4, fin))
  let texte = contenu.slice(fin + 5)
  let article = ''
  const iSep = texte.indexOf(MARQUE_ARTICLE)
  if (iSep !== -1) {
    article = texte.slice(iSep + MARQUE_ARTICLE.length)
    texte = texte.slice(0, iSep)
  }
  return { meta, texte, article }
}

// ---- La synchronisation complète --------------------------------

function choisirDernier(liste, cle) {
  if (!liste || !liste.length) return null
  return liste.reduce((a, b) => (cle(b) >= cle(a) ? b : a))
}

// Un seul cycle de synchronisation à la fois : sans ce verrou, deux
// cycles lancés presque simultanément (ex. clic « Connecter » + retour
// de focus) peuvent créer des fichiers en double sur Drive.
let enCours = null
// Pendant un import massif, on met la sync périodique en pause pour éviter
// qu'elle ne pousse en double des cartes que l'import est en train d'écrire.
let importEnCours = false
export function marquerImport(actif) { importEnCours = actif }
// `onProgress({ recues, total })` (optionnel) est appelé au fil du
// téléchargement des cartes depuis Drive → alimente le compteur discret de
// l'interface. `total` = nombre de cartes à recevoir (nouvelles ou plus
// récentes côté Drive) ; `recues` = combien sont déjà arrivées.
export function synchroniser(onProgress) {
  if (importEnCours) return Promise.resolve(null)
  if (enCours) return enCours
  enCours = _synchroniser(onProgress).finally(() => { enCours = null })
  return enCours
}

async function _synchroniser(onProgress) {
  console.log('[sync] début')
  await jetonValide()
  await garantirDossiers()
  console.log('[sync] dossiers OK', { racineId, cartesId })

  const distants = await listerCartesDrive()
  console.log('[sync] fichiers distants :', distants.length)

  // Regroupe les fichiers distants par carte. On accepte plusieurs .md
  // ou images (doublons d'un ancien cycle) pour pouvoir les nettoyer.
  const parCarte = new Map() // cardId -> { mds:[], imgs:[], deleted, md, img, media, vignette }
  for (const f of distants) {
    const id = f.appProperties?.cardId
    if (!id) continue
    const e = parCarte.get(id) || { mds: [], imgs: [] }
    const kind = f.appProperties?.kind
    if (f.name.endsWith('.deleted')) e.deleted = f
    else if (kind === 'image') e.imgs.push(f)      // legacy : image locale complète
    else if (kind === 'media') e.media = f          // import : fichier complet (à la demande)
    else if (kind === 'vignette') e.vignette = f    // import : miniature
    else e.mds.push(f)                              // .md (métadonnées)
    parCarte.set(id, e)
  }

  // Pré-passe anti-doublons : on ne garde que le .md le plus récent et
  // une seule image par carte, et on supprime les doublons résiduels.
  for (const e of parCarte.values()) {
    e.md = choisirDernier(e.mds, f => Number(f.appProperties?.modifieLe || 0))
    e.img = e.imgs[0] || null
    for (const x of e.mds) if (e.md && x.id !== e.md.id) await supprimerFichier(x.id).catch(() => {})
    for (const x of e.imgs) if (e.img && x.id !== e.img.id) await supprimerFichier(x.id).catch(() => {})
  }

  const locales = await db.cartes.toArray()
  const localesParId = new Map(locales.map(c => [c.id, c]))
  const tousIds = new Set([...localesParId.keys(), ...parCarte.keys()])

  // Combien de cartes vont être TÉLÉCHARGÉES depuis Drive (compteur « X / Y »).
  // On reproduit ici la décision « réception » du grand parcours ci-dessous :
  // ni tombstone, ni carte échue, pas d'envoi, et Drive plus récent (ou carte
  // absente en local).
  let aRecevoir = 0
  for (const id of tousIds) {
    const locale = localesParId.get(id)
    const dist = parCarte.get(id)
    if (dist?.deleted) continue
    if (locale?.supprime && estEchu(locale)) continue
    const modLocale = locale?.modifieLe || 0
    const modDist = dist?.md ? Number(dist.md.appProperties?.modifieLe || 0) : 0
    const envoi = locale && (!dist?.md || modLocale > modDist)
    if (!envoi && dist?.md && (!locale || modDist > modLocale)) aRecevoir++
  }
  if (onProgress) onProgress({ recues: 0, total: aRecevoir })

  let envoyees = 0, recues = 0, suppr = 0

  for (const id of tousIds) {
    const locale = localesParId.get(id)
    const dist = parCarte.get(id)

    // 1) Tombstone distant = carte PURGÉE ailleurs (après ses 30 jours) → on
    //    l'efface définitivement en local aussi.
    if (dist?.deleted) {
      if (locale) { await db.cartes.delete(id); suppr++ }
      continue
    }

    // 2) Carte en corbeille depuis PLUS de 30 jours → purge définitive :
    //    on efface les fichiers Drive, on pose la pierre tombale, et on
    //    retire la carte localement.
    if (locale?.supprime && estEchu(locale)) {
      if (dist?.md) await supprimerFichier(dist.md.id)
      if (dist?.img) await supprimerFichier(dist.img.id)
      if (dist?.media) await supprimerFichier(dist.media.id)
      if (dist?.vignette) await supprimerFichier(dist.vignette.id)
      await televerser(null,
        { name: `${id}.deleted`, parents: [cartesId], appProperties: { cardId: id } },
        new Blob(['supprimé']), 'text/plain')
      await db.cartes.delete(id)
      suppr++
      continue
    }

    // NB : une carte en corbeille NON échue n'est PAS traitée ici — elle suit
    // le flux normal ci-dessous. Son .md porte supprime:1 + supprimeLe : il est
    // téléversé / reçu comme une simple mise à jour, donc l'état « corbeille »
    // se propage à tous les appareils SANS effacer les fichiers (récupérables
    // pendant 30 jours).

    const modLocale = locale?.modifieLe || 0
    const modDist = dist?.md ? Number(dist.md.appProperties?.modifieLe || 0) : 0

    // 3) Présente localement, plus récente (ou absente du Drive) → envoi
    if (locale && (!dist?.md || modLocale > modDist)) {
      await envoyerCarte(locale, dist)
      envoyees++
      continue
    }

    // 4) Présente sur Drive, plus récente (ou absente en local) → réception
    if (dist?.md && (!locale || modDist > modLocale)) {
      await recevoirCarte(id, dist)
      recues++
      if (onProgress) onProgress({ recues, total: aRecevoir })
    }
  }

  await setReglage('derniereSync', Date.now())
  console.log('[sync] terminé', { envoyees, recues, suppr })
  return { envoyees, recues, suppr }
}

async function envoyerCarte(carte, dist) {
  // Carte à média « à la demande » (import) : le fichier complet et la
  // vignette vivent déjà dans Drive et ne sont jamais renvoyés d'ici.
  // On ne (ré)écrit que le .md — utile si l'utilisateur édite ses tags/note.
  if (carte.distant) {
    const nomMedia = carte.mediaExt ? `${carte.id}.${carte.mediaExt}` : ''
    const contenu = serialiserMd(carte, nomMedia)
    const r = await televerser(dist?.md?.id || carte.driveMdId || null,
      { name: `${carte.id}.md`, parents: [cartesId],
        appProperties: { cardId: carte.id, modifieLe: String(carte.modifieLe), type: carte.type } },
      new Blob([contenu]), 'text/markdown')
    await db.cartes.update(carte.id, { driveMdId: r.id })
    return
  }

  let nomImage = ''
  let imgId = carte.driveImgId || dist?.img?.id || null

  // Image d'abord (si présente et pas encore envoyée)
  if (carte.image) {
    nomImage = `${carte.id}.${extensionImage(carte.image)}`
    const metaImg = { name: nomImage, parents: [cartesId], appProperties: { cardId: carte.id, kind: 'image' } }
    if (!imgId) {
      const r = await televerser(null, metaImg, carte.image, carte.image.type || 'application/octet-stream')
      imgId = r.id
    }
  }

  const contenu = serialiserMd(carte, nomImage)
  const metaMd = {
    name: `${carte.id}.md`, parents: [cartesId],
    appProperties: { cardId: carte.id, modifieLe: String(carte.modifieLe), type: carte.type }
  }
  const r = await televerser(dist?.md?.id || carte.driveMdId || null, metaMd, new Blob([contenu]), 'text/markdown')

  // Mémorise les IDs Drive sur la carte locale (moins d'appels ensuite)
  await db.cartes.update(carte.id, { driveMdId: r.id, driveImgId: imgId })
}

async function recevoirCarte(id, dist) {
  const contenu = await telechargerTexte(dist.md.id)
  const parsed = parserMd(contenu)
  if (!parsed) return
  const { meta, texte, article } = parsed

  const base = {
    id,
    type: meta.type,
    titre: meta.titre || '',
    url: meta.url || '',
    apercu: meta.apercu || '',
    texte,
    article: article || '',
    articleLe: meta.articleLe || 0,
    note: meta.note || '',
    tags: meta.tags || [],
    espaces: meta.espaces || [],
    tag: meta.tag || '',
    texteImage: meta.texteImage || '',
    supprime: meta.supprime ? 1 : 0,
    supprimeLe: meta.supprimeLe || 0,
    creeLe: meta.creeLe,
    modifieLe: meta.modifieLe,
    driveMdId: dist.md.id
  }

  if (meta.distant) {
    // Média « à la demande » : on ne télécharge QUE la vignette (légère).
    // Le fichier complet reste dans Drive et sera chargé au besoin.
    let vignette = null
    if (dist.vignette) vignette = await telechargerBlob(dist.vignette.id).catch(() => null)
    await upsertDepuisDrive({
      ...base,
      distant: 1,
      mediaExt: meta.mediaExt || '',
      vignette,
      vignetteNom: meta.vignette || '',
      image: null,
      driveMediaId: dist.media?.id || null,
      driveVignetteId: dist.vignette?.id || null,
      source: meta.source || '',
      sourceId: meta.sourceId || ''
    })
  } else {
    let image = null
    if (dist.img) image = await telechargerBlob(dist.img.id)
    await upsertDepuisDrive({ ...base, image, driveImgId: dist.img?.id || null })
  }
}
