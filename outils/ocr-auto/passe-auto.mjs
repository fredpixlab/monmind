// ==================================================================
// MonCoffre — passe OCR Apple AUTOMATIQUE (Mac-local, quasi temps réel).
//
// Toutes les ~30 min (via launchd) : repère les cartes IMAGE ajoutées APRÈS
// l'import mymind (les cartes historiques ont un id « mm-… » et sont déjà
// traitées par le batch Apple), passe Apple Vision (outil `ocr`) dessus, et
// réécrit le `.md` dans Drive — contenu ET `appProperties.modifieLe`
// (indispensable : c'est ce que l'app compare pour tirer la mise à jour).
// L'app resynchronise ensuite partout. Apple « upgrade » aussi le texte que
// Tesseract avait mis au fil de l'eau (meilleure lecture + mots-clés de scène).
//
// Accès Drive : rclone (remote « gdrive ») UNIQUEMENT pour lister (1 appel) et
// fournir le jeton OAuth. Tout le reste (lecture .md, téléchargement média,
// écriture) passe par l'API Drive DIRECTE par ID — sinon rclone re-liste le
// dossier de 5428 fichiers à chaque accès par chemin (très lent).
//
// Efficace : on ne « voit » que les rares cartes non-« mm- » jamais traitées,
// journalisées dans vues.txt pour ne jamais les repasser.
// ==================================================================
import { readFile, writeFile, mkdir, rm, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const sh = promisify(execFile)

const DIR    = '/Users/fred/monmind-ocr'
const TMP    = `${DIR}/tmp-medias`
const OUT    = `${DIR}/tmp-ocr.json`
const LEDGER = `${DIR}/vues.txt`
const OCR    = `${DIR}/ocr`
const RCLONE = '/opt/homebrew/bin/rclone'
const REMOTE = 'gdrive:MonMind/cartes'
const API    = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const MAX    = 40
const IMG_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif|tiff?)$/i

const rclone = (args) => sh(RCLONE, args, { maxBuffer: 128 * 1024 * 1024 })

function parseFront(txt) {
  if (!txt.startsWith('---\n')) return null
  const fin = txt.indexOf('\n---\n', 4)
  if (fin < 0) return null
  let meta; try { meta = JSON.parse(txt.slice(4, fin)) } catch { return null }
  return { meta, texte: txt.slice(fin + 5) }
}
const serialize = (meta, texte) => `---\n${JSON.stringify(meta)}\n---\n${texte || ''}`

async function jeton() {
  const { stdout } = await rclone(['config', 'dump'])
  return JSON.parse(JSON.parse(stdout).gdrive.token).access_token
}
const dodo = (ms) => new Promise(r => setTimeout(r, ms))
// fetch avec backoff : Drive renvoie 403 (userRateLimitExceeded) ou 429 quand
// les appels sont trop rapprochés → on réessaie en espaçant.
async function fetchRetry(url, opts, essais = 6) {
  for (let i = 0; i < essais; i++) {
    const r = await fetch(url, opts)
    if (r.ok || (r.status !== 403 && r.status !== 429 && r.status < 500)) return r
    await dodo(500 * (i + 1) * (i + 1))   // 0.5s, 2s, 4.5s, 8s, 12.5s
  }
  return fetch(url, opts)
}
const dl = (id, tok) => fetchRetry(`${API}/${id}?alt=media`, { headers: { Authorization: 'Bearer ' + tok } })

async function patch(id, contenu, cardId, now, tok) {
  const b = 'moncoffreBOUND' + now
  const meta = JSON.stringify({ appProperties: { cardId, type: 'image', modifieLe: String(now) } })
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
             + `--${b}\r\nContent-Type: text/markdown\r\n\r\n${contenu}\r\n--${b}--`
  const url = `${UPLOAD}/${id}?uploadType=multipart`
  const rep = await fetchRetry(url, { method: 'PATCH',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': `multipart/related; boundary=${b}` }, body })
  return rep.ok
}

async function main() {
  const t0 = new Date().toISOString()
  await mkdir(DIR, { recursive: true })

  // 0) Rafraîchit le jeton (rclone le renouvelle en tapant l'API) + le récupère.
  await rclone(['about', 'gdrive:']).catch(() => {})
  const fichiers = JSON.parse((await rclone(['lsjson', REMOTE, '--files-only'])).stdout)
  const idParNom = new Map(fichiers.map(f => [f.Name, f.ID]))
  const tok = await jeton()

  // 1) Journal des carteIds déjà vues.
  const vues = new Set(existsSync(LEDGER)
    ? (await readFile(LEDGER, 'utf8')).split('\n').map(s => s.trim()).filter(Boolean) : [])

  // 2) Candidates : .md ajoutés par l'app (id NON « mm- »), jamais vus.
  const candNoms = fichiers.map(f => f.Name)
    .filter(n => n.endsWith('.md') && !n.startsWith('mm-') && !vues.has(n.slice(0, -3)))
    .slice(0, MAX)
  if (!candNoms.length) { console.log(t0, 'rien à faire'); return }

  // 3) Lire ces .md (API par ID) ; ne garder que les IMAGES avec média.
  const cand = []
  for (const nom of candNoms) {
    const cardId = nom.slice(0, -3)
    let p = null
    try { const r = await dl(idParNom.get(nom), tok); if (r.ok) p = parseFront(await r.text()) } catch {}
    if (!p || p.meta.type !== 'image' || !p.meta.image) {
      await appendFile(LEDGER, cardId + '\n')   // note/lien/illisible → vu, on n'y revient plus
      continue
    }
    cand.push({ cardId, nom, media: p.meta.image, meta: p.meta, texte: p.texte })
  }
  if (!cand.length) { console.log(t0, 'aucune image à traiter (que des notes/liens)'); return }

  // 4) Télécharger les médias (API par ID) puis OCR Apple sur le dossier.
  await rm(TMP, { recursive: true, force: true }); await mkdir(TMP, { recursive: true })
  for (const c of cand) {
    const mid = idParNom.get(c.media)
    try {
      const r = mid ? await dl(mid, tok) : null
      if (r && r.ok) await writeFile(`${TMP}/${c.media}`, Buffer.from(await r.arrayBuffer()))
      else { c.err = 1; console.error('  DL-FAIL', c.media, 'mid=' + !!mid, 'status=' + (r && r.status)) }
    } catch (e) { c.err = 1; console.error('  DL-THROW', c.media, e && e.message) }
  }
  await sh(OCR, [TMP, OUT], { maxBuffer: 128 * 1024 * 1024 })
  const parId = new Map()
  for (const e of JSON.parse(await readFile(OUT, 'utf8'))) if (e && e.id) parId.set(e.id, e)

  // 5) Injecter texteImage (contenu + appProperties.modifieLe) ; marquer vues.
  const now = Date.now()
  let enrichies = 0, vides = 0, erreurs = 0
  for (const c of cand) {
    if (c.err) { erreurs++; continue }   // média absent → on réessaiera au prochain run
    const r = parId.get(c.media.replace(IMG_EXT, '')) || parId.get(c.cardId)
    const bouts = []
    if (r?.texte) bouts.push(String(r.texte))
    if (Array.isArray(r?.labels) && r.labels.length) bouts.push(r.labels.join(' '))
    const ti = bouts.join(' ').replace(/\s+/g, ' ').trim()
    if (!ti) { await appendFile(LEDGER, c.cardId + '\n'); vides++; continue }
    c.meta.texteImage = ti; c.meta.modifieLe = now
    if (await patch(idParNom.get(c.nom), serialize(c.meta, c.texte), c.cardId, now, tok)) {
      await appendFile(LEDGER, c.cardId + '\n'); enrichies++
    } else erreurs++
  }
  console.log(t0, `enrichies=${enrichies} vides=${vides} erreurs=${erreurs} candidats=${cand.length}`)
}

main().catch(e => { console.error(new Date().toISOString(), 'ERREUR', e && e.message); process.exit(1) })
