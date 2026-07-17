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
import { db, upsertDepuisDrive, getReglage, setReglage } from './db.js'
import { CLIENT_ID, DRIVE_SCOPE, DOSSIER_RACINE, DOSSIER_CARTES } from './config.js'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

let tokenClient = null
let jeton = null          // { access_token, expire }  (en mémoire, jamais stocké sur disque)
let racineId = null
let cartesId = null

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
  await attendreGIS()
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: () => {},        // remplacé à chaque demande
    error_callback: () => {}   // idem — évite les blocages si le popup échoue
  })
}

// Demande un jeton d'accès. interactif=true montre l'écran Google
// (consentement) ; sinon on tente en silencieux (prompt:'').
// Garde-fous : délai maximum + gestion de error_callback pour ne JAMAIS
// rester bloqué en attente d'un jeton qui ne vient pas.
function demanderJeton(interactif) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Auth non initialisée'))
    let fini = false
    const finir = (fn, arg) => { if (!fini) { fini = true; clearTimeout(minuteur); fn(arg) } }
    const minuteur = setTimeout(
      () => finir(reject, new BesoinReconnexion('délai dépassé')),
      interactif ? 120000 : 15000
    )
    tokenClient.callback = (rep) => {
      if (rep && rep.error) return finir(reject, new BesoinReconnexion(rep.error))
      jeton = { access_token: rep.access_token, expire: Date.now() + (rep.expires_in - 60) * 1000 }
      finir(resolve, jeton)
    }
    tokenClient.error_callback = (err) => finir(reject, new BesoinReconnexion(err && err.type))
    tokenClient.requestAccessToken({ prompt: interactif ? 'consent' : '' })
  })
}

async function jetonValide() {
  if (jeton && Date.now() < jeton.expire) return jeton.access_token
  console.log('[sync] demande de jeton silencieuse…')
  await demanderJeton(false) // silencieux
  return jeton.access_token
}

// Connexion volontaire (clic sur le bouton). Montre l'écran Google.
export async function connecter() {
  if (!tokenClient) await initAuth()
  await demanderJeton(true)
  await setReglage('driveConnecte', true)
  return true
}

export async function estDejaConnecte() {
  return (await getReglage('driveConnecte', false)) === true
}

export async function deconnecter() {
  jeton = null
  await setReglage('driveConnecte', false)
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
  const limite = '-------monmind' + Math.round(performance.now())
  const parties = [
    `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${limite}\r\nContent-Type: ${contentType}\r\n\r\n`
  ]
  const corps = new Blob([parties[0], parties[1], blob, `\r\n--${limite}--`])
  const url = fileId
    ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`
  const rep = await api(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${limite}` },
    body: corps
  })
  return rep.json()
}

async function supprimerFichier(fileId) {
  await api(`/files/${fileId}`, { method: 'DELETE' })
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
    tags: carte.tags || [], creeLe: carte.creeLe, modifieLe: carte.modifieLe,
    image: nomImage || ''
  }
  return `---\n${JSON.stringify(meta)}\n---\n${carte.texte || ''}`
}

function parserMd(contenu) {
  if (!contenu.startsWith('---\n')) return null
  const fin = contenu.indexOf('\n---\n', 4)
  if (fin === -1) return null
  const meta = JSON.parse(contenu.slice(4, fin))
  const texte = contenu.slice(fin + 5)
  return { meta, texte }
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
export function synchroniser() {
  if (enCours) return enCours
  enCours = _synchroniser().finally(() => { enCours = null })
  return enCours
}

async function _synchroniser() {
  console.log('[sync] début')
  await jetonValide()
  await garantirDossiers()
  console.log('[sync] dossiers OK', { racineId, cartesId })

  const distants = await listerCartesDrive()
  console.log('[sync] fichiers distants :', distants.length)

  // Regroupe les fichiers distants par carte. On accepte plusieurs .md
  // ou images (doublons d'un ancien cycle) pour pouvoir les nettoyer.
  const parCarte = new Map() // cardId -> { mds:[], imgs:[], deleted, md, img }
  for (const f of distants) {
    const id = f.appProperties?.cardId
    if (!id) continue
    const e = parCarte.get(id) || { mds: [], imgs: [] }
    if (f.name.endsWith('.deleted')) e.deleted = f
    else if (f.appProperties?.kind === 'image') e.imgs.push(f)
    else e.mds.push(f)
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

  let envoyees = 0, recues = 0, suppr = 0

  for (const id of tousIds) {
    const locale = localesParId.get(id)
    const dist = parCarte.get(id)

    // 1) Suppression distante → on efface localement
    if (dist?.deleted) {
      if (locale && !locale.supprime) {
        await upsertDepuisDrive({ ...locale, supprime: 1 })
        suppr++
      }
      continue
    }

    // 2) Suppression locale → on propage vers Drive
    if (locale?.supprime) {
      if (dist?.md || dist?.img) {
        if (dist.md) await supprimerFichier(dist.md.id)
        if (dist.img) await supprimerFichier(dist.img.id)
        await televerser(null,
          { name: `${id}.deleted`, parents: [cartesId], appProperties: { cardId: id } },
          new Blob(['supprimé']), 'text/plain')
        suppr++
      }
      continue
    }

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
    }
  }

  await setReglage('derniereSync', Date.now())
  console.log('[sync] terminé', { envoyees, recues, suppr })
  return { envoyees, recues, suppr }
}

async function envoyerCarte(carte, dist) {
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
  const { meta, texte } = parsed

  let image = null
  if (dist.img) image = await telechargerBlob(dist.img.id)

  await upsertDepuisDrive({
    id,
    type: meta.type,
    titre: meta.titre || '',
    url: meta.url || '',
    texte,
    tags: meta.tags || [],
    image,
    supprime: 0,
    creeLe: meta.creeLe,
    modifieLe: meta.modifieLe,
    driveMdId: dist.md.id,
    driveImgId: dist.img?.id || null
  })
}
