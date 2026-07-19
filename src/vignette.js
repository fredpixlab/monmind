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
// On capture une image un peu APRÈS le début (beaucoup de films / clips
// ouvrent sur du noir ou des titres). Deux fiabilisations par rapport à une
// capture naïve :
//   1. On attend que la frame soit VRAIMENT peinte avant de dessiner
//      (`requestVideoFrameCallback` si dispo, sinon petit délai) — sans ça,
//      `drawImage` juste après `seeked` produit souvent un canvas NOIR.
//   2. On teste la luminosité : si l'image est quasi noire, on retente plus
//      loin dans la vidéo (1 s → 2,5 s → 5 s → 9 s, bornés par la durée).
export function vignetteVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'auto'
    let fait = false
    const finir = (fn, arg) => { if (!fait) { fait = true; clearTimeout(minuteur); URL.revokeObjectURL(url); fn(arg) } }
    // Délai de sécurité : certains formats (ex. .mov) ne déclenchent NI
    // « loadeddata » NI « error » dans Chrome → sans ça, ça fige.
    const minuteur = setTimeout(() => finir(reject, new Error('vidéo : délai vignette dépassé')), 15000)

    let essais = [], idx = 0, meilleur = null   // `meilleur` = dernier rendu si tout est noir
    const seekProchain = () => {
      if (idx >= essais.length) {
        // On n'a trouvé que du noir : on garde quand même la dernière image
        // (mieux qu'un échec → repli sur tuile neutre).
        return finir(meilleur ? resolve : reject, meilleur || new Error('vidéo : image noire'))
      }
      try { v.currentTime = essais[idx++] } catch { finir(reject, new Error('vidéo : seek impossible')) }
    }
    v.onloadeddata = () => {
      const d = (v.duration && isFinite(v.duration)) ? v.duration : 0
      const cands = d
        ? [Math.min(1, d * 0.1), Math.min(2.5, d * 0.25), Math.min(5, d * 0.5), Math.min(9, d * 0.75)]
        : [1, 2.5, 5]
      essais = [...new Set(cands.map(t => Math.max(0, +(+t).toFixed(2))))]
      seekProchain()
    }
    const capter = async () => {
      try {
        const largeur = v.videoWidth || 640, hauteur = v.videoHeight || 360
        const ratio = Math.min(1, TAILLE_VIGNETTE / Math.max(largeur, hauteur))
        const w = Math.max(1, Math.round(largeur * ratio)), h = Math.max(1, Math.round(hauteur * ratio))
        const c = document.createElement('canvas'); c.width = w; c.height = h
        const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, w, h)
        const noir = estPresqueNoir(ctx, w, h)
        const b = await new Promise(r => c.toBlob(x => r(x), 'image/jpeg', QUALITE))
        if (b && !noir) return finir(resolve, b)   // image exploitable
        if (b) meilleur = b                          // on la garde en dernier recours
        seekProchain()                               // sinon on tente plus loin
      } catch (e) { finir(reject, e) }
    }
    v.onseeked = () => {
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => capter())
      else setTimeout(capter, 130)   // laisse le temps au rendu de la frame
    }
    v.onerror = () => finir(reject, new Error('vidéo illisible'))
    v.src = url
  })
}

// Vrai si l'image du canvas est quasi entièrement noire (film ouvrant sur du
// noir, frame pas encore rendue…). Échantillonne 1 pixel sur ~40 pour rester
// léger, calcule la luminance moyenne.
function estPresqueNoir(ctx, w, h) {
  try {
    const { data } = ctx.getImageData(0, 0, w, h)
    let somme = 0, n = 0
    for (let i = 0; i < data.length; i += 4 * 40) {
      somme += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++
    }
    return n > 0 && somme / n < 16   // < ~6 % de luminance = quasi noir
  } catch { return false }
}

// Vignette « couverture » pour un PDF (on ne rend pas la 1re page : tuile
// document propre avec un bandeau rouge « PDF »). Léger, sans dépendance.
export function vignettePdf() {
  const c = document.createElement('canvas')
  c.width = 480; c.height = 620
  const x = c.getContext('2d')
  x.fillStyle = '#efece6'; x.fillRect(0, 0, 480, 620)
  // feuille
  x.fillStyle = '#ffffff'; x.fillRect(70, 55, 340, 500)
  x.strokeStyle = '#d9d5cc'; x.lineWidth = 2; x.strokeRect(70, 55, 340, 500)
  // lignes de texte factices
  x.fillStyle = '#d5d0c6'
  for (let i = 0; i < 8; i++) x.fillRect(100, 100 + i * 34, 280 - (i % 3) * 46, 9)
  // bandeau PDF
  x.fillStyle = '#e0463a'; x.fillRect(70, 470, 340, 85)
  x.fillStyle = '#ffffff'; x.font = 'bold 46px sans-serif'; x.textAlign = 'center'
  x.fillText('PDF', 240, 528)
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.85))
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
