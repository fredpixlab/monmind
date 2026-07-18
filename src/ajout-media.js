// ==================================================================
// MonCoffre — ajout de médias par glisser-déposer (image / vidéo / PDF).
//
// Réutilise EXACTEMENT la plomberie de l'import mymind : on génère une
// vignette légère, on pousse le fichier complet + la vignette + le .md
// vers Drive (média « à la demande »), et on n'enregistre en local que la
// carte + sa vignette. Résultat : identique à une carte importée.
// ==================================================================
import { db, nouvelId, majCarte, mettreCarteImportee } from './db.js'
import { vignetteImage, vignetteVideo, vignettePdf, vignetteDefaut, estVideoExt } from './vignette.js'
import { pousserCarteImportee, estDejaConnecte, synchroniser } from './drive.js'

const EXT_IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp']

// Déduit (type, ext) d'un fichier depuis son type MIME puis son extension.
function typeEtExt(file) {
  const nom = file.name || ''
  const pt = nom.lastIndexOf('.')
  let ext = pt > -1 ? nom.slice(pt + 1).toLowerCase() : ''
  const mime = (file.type || '').toLowerCase()

  let type = null
  if (mime.startsWith('image/') || EXT_IMAGE.includes(ext)) type = 'image'
  else if (mime.startsWith('video/') || estVideoExt(ext)) type = 'video'
  else if (mime === 'application/pdf' || ext === 'pdf') type = 'pdf'

  if (!ext) {
    if (type === 'image') ext = (mime.split('/')[1] || 'jpg')
    else if (type === 'video') ext = 'mp4'
    else if (type === 'pdf') ext = 'pdf'
  }
  return { type, ext }
}

// Un fichier est-il un média qu'on sait ajouter ?
export function estMediaSupporte(file) {
  return typeEtExt(file).type !== null
}

// --- Injection des résultats OCR (Apple Vision) -------------------
// Le fichier .json (produit par l'outil Swift local) contient un tableau
// [{ id, texte, labels[] }] où `id` = sourceId mymind (nom du fichier image
// sans extension). On remplit le champ cherchable `texteImage` des cartes.

export function estFichierOcr(file) {
  return /\.json$/i.test(file.name || '') || (file.type || '').includes('json')
}

export async function injecterOcr(file) {
  let data
  try { data = JSON.parse(await file.text()) } catch { return { erreur: 'json' } }
  if (!Array.isArray(data)) return { erreur: 'format' }

  const parId = new Map()
  for (const e of data) {
    if (!e || !e.id) continue
    const bouts = []
    if (e.texte) bouts.push(String(e.texte))
    if (Array.isArray(e.labels) && e.labels.length) bouts.push(e.labels.join(' '))
    const ti = bouts.join(' ').replace(/\s+/g, ' ').trim()
    if (ti) parId.set(e.id, ti)
  }
  if (!parId.size) return { maj: 0, total: 0 }

  const toutes = await db.cartes.toArray()
  let maj = 0
  for (const c of toutes) {
    if (c.sourceId && parId.has(c.sourceId)) {
      const ti = parId.get(c.sourceId)
      if (c.texteImage !== ti) { await majCarte(c.id, { texteImage: ti }); maj++ }
    }
  }
  return { maj, total: parId.size }
}

// Fabrique la vignette adaptée au type (repli sur une tuile neutre).
async function fabriquerVignette(file, type) {
  try {
    if (type === 'image') return await vignetteImage(file)
    if (type === 'video') return await vignetteVideo(file)
    return await vignettePdf()
  } catch {
    return await vignetteDefaut(type === 'video')
  }
}

// OCR « au fil de l'eau » dans le NAVIGATEUR (Tesseract, chargé à la demande) :
// dès qu'une image est ajoutée, on lit le texte qu'elle contient (FR + EN) en
// tâche de fond et on le range dans le champ cherchable `texteImage`. Marche
// partout, y compris iPhone/iPad, 100 % en local. (Qualité un cran sous le
// moteur Apple → la passe Apple mensuelle affine les ajouts récents.)
export async function ocrEnFond(cardId, file) {
  try {
    const { default: Tesseract } = await import('tesseract.js')
    const { data } = await Tesseract.recognize(file, 'fra+eng')
    const ti = (data?.text || '').replace(/\s+/g, ' ').trim()
    if (ti) {
      await majCarte(cardId, { texteImage: ti })
      try { await synchroniser() } catch { /* la sync périodique rattrapera */ }
    }
  } catch (e) {
    console.error('[ocr-navigateur]', e)
  }
}

// Ajoute un fichier déposé. Renvoie 'ok' | 'ok-local' | 'ignore' | 'besoin-drive'.
export async function ajouterMediaDepuisFichier(file) {
  const { type, ext } = typeEtExt(file)
  if (!type) return 'ignore'

  const vign = await fabriquerVignette(file, type)
  const maintenant = Date.now()
  const base = {
    id: nouvelId(), type, titre: (file.name || '').replace(/\.[^.]+$/, ''),
    texte: '', url: '', tags: [], espaces: [], mediaExt: ext,
    creeLe: maintenant, modifieLe: maintenant
  }

  // Repli local (image seulement : le blob vit en local et se synchronise
  // ensuite ; vidéo/PDF ont besoin de Drive tout de suite pour le média).
  const enLocal = async () => {
    if (type === 'image') {
      // Id maîtrisé (put) pour pouvoir remplir texteImage après l'OCR.
      await mettreCarteImportee({ ...base, distant: 0, image: file, supprime: 0 })
      ocrEnFond(base.id, file)
      return 'ok-local'
    }
    return 'besoin-drive'
  }

  if (!(await estDejaConnecte())) return enLocal()

  try {
    const cImport = { ...base, distant: true, vignetteNom: `${base.id}.thumb.jpg` }
    const res = await pousserCarteImportee(cImport, file, vign)
    await mettreCarteImportee({ ...cImport, distant: 1, vignette: vign, image: null, ...res })
    if (type === 'image') ocrEnFond(base.id, file)
    return 'ok'
  } catch (e) {
    console.error('[ajout-media]', e)
    return enLocal()
  }
}
