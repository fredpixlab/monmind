// ==================================================================
// MonMind — génération de vignettes légères.
//
// Pour une bibliothèque volumineuse (import mymind : 4,6 Go), on ne
// garde PAS les fichiers complets sur chaque appareil : le fichier
// complet vit dans Drive, et chaque appareil ne stocke qu'une petite
// « vignette » (miniature) pour l'affichage instantané de la grille.
// La vue détail va chercher le fichier complet dans Drive à la demande.
// ==================================================================

const TAILLE_VIGNETTE = 640   // côté max de la miniature (px)
const QUALITE = 0.72          // qualité JPEG de la miniature

// Dessine une source (image bitmap ou vidéo) réduite dans un canvas et
// renvoie un Blob JPEG.
function canvasVersBlob(source, largeur, hauteur) {
  const ratio = Math.min(1, TAILLE_VIGNETTE / Math.max(largeur, hauteur))
  const w = Math.max(1, Math.round(largeur * ratio))
  const h = Math.max(1, Math.round(hauteur * ratio))
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d').drawImage(source, 0, 0, w, h)
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', QUALITE))
}

// Vignette d'une image (Blob/File) → Blob JPEG réduit.
export function vignetteImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = async () => {
      try {
        const v = await canvasVersBlob(img, img.naturalWidth, img.naturalHeight)
        URL.revokeObjectURL(url)
        resolve(v)
      } catch (e) { URL.revokeObjectURL(url); reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image illisible')) }
    img.src = url
  })
}

// Vignette (image poster) d'une vidéo (Blob/File) → Blob JPEG.
// On capture une image vers ~1 s (ou le début si la vidéo est courte).
export function vignetteVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'metadata'
    let fait = false
    const finir = (fn, arg) => { if (!fait) { fait = true; clearTimeout(minuteur); URL.revokeObjectURL(url); fn(arg) } }
    // Délai de sécurité : certains formats (ex. .mov) ne déclenchent NI
    // « loadedmetadata » NI « error » dans Chrome → sans ça, ça fige.
    const minuteur = setTimeout(() => finir(reject, new Error('vidéo : délai vignette dépassé')), 12000)
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 2)
    }
    v.onseeked = async () => {
      try {
        const vign = await canvasVersBlob(v, v.videoWidth || 640, v.videoHeight || 360)
        finir(resolve, vign)
      } catch (e) { finir(reject, e) }
    }
    v.onerror = () => finir(reject, new Error('vidéo illisible'))
    v.src = url
  })
}

// Extension → type MIME (pour l'upload vers Drive).
export function typeMime(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
    pdf: 'application/pdf'
  }
  return map[(ext || '').toLowerCase()] || 'application/octet-stream'
}

export function estVideoExt(ext) {
  return ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes((ext || '').toLowerCase())
}

// Vignette de secours (si le navigateur ne sait pas décoder le média,
// ex. certains .mov) : une tuile neutre pour que la carte existe quand même.
export function vignetteDefaut(video = false) {
  const c = document.createElement('canvas')
  c.width = 480; c.height = 360
  const x = c.getContext('2d')
  const g = x.createLinearGradient(0, 0, 480, 360)
  g.addColorStop(0, video ? '#2a2f3a' : '#8a8f9c')
  g.addColorStop(1, video ? '#12151c' : '#6b7180')
  x.fillStyle = g; x.fillRect(0, 0, 480, 360)
  if (video) {
    x.fillStyle = 'rgba(255,255,255,.9)'
    x.beginPath(); x.moveTo(210, 150); x.lineTo(210, 210); x.lineTo(265, 180); x.closePath(); x.fill()
  }
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.8))
}
