// ==================================================================
// MonCoffre — ajout de médias par glisser-déposer (image / vidéo / PDF).
//
// Réutilise EXACTEMENT la plomberie de l'import mymind : on génère une
// vignette légère, on pousse le fichier complet + la vignette + le .md
// vers Drive (média « à la demande »), et on n'enregistre en local que la
// carte + sa vignette. Résultat : identique à une carte importée.
// ==================================================================
import { nouvelId, ajouterCarte, mettreCarteImportee } from './db.js'
import { vignetteImage, vignetteVideo, vignettePdf, vignetteDefaut, estVideoExt } from './vignette.js'
import { pousserCarteImportee, estDejaConnecte } from './drive.js'

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
      await ajouterCarte({ type: 'image', titre: base.titre, image: file, mediaExt: ext })
      return 'ok-local'
    }
    return 'besoin-drive'
  }

  if (!(await estDejaConnecte())) return enLocal()

  try {
    const cImport = { ...base, distant: true, vignetteNom: `${base.id}.thumb.jpg` }
    const res = await pousserCarteImportee(cImport, file, vign)
    await mettreCarteImportee({ ...cImport, distant: 1, vignette: vign, image: null, ...res })
    return 'ok'
  } catch (e) {
    console.error('[ajout-media]', e)
    return enLocal()
  }
}
