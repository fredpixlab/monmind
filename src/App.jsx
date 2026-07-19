import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, ajouterCarte, supprimerCarte, restaurerCarte, majCarte, estUneUrl, creerEspace, supprimerEspace, basculerEpingle, membresEspace, normTag, semerSpacesMymind, DUREE_CORBEILLE } from './db.js'
import { construireIndex, rechercher } from './recherche.js'
import { ajouterMediaDepuisFichier, estMediaSupporte, estFichierOcr, injecterOcr, ocrEnFond } from './ajout-media.js'
import { sync_configuree, API_BASE } from './config.js'
import { initAuth, connecter, estDejaConnecte, deconnecter, synchroniser, BesoinReconnexion, telechargerMediaComplet, rafraichirJeton, purgerCarte, enregistrerSession, aSessionBackend } from './drive.js'
import { lancerImport } from './import-run.js'

// ---------------------------------------------------------------
// MonCoffre — interface façon mymind : accueil (recherche serif +
// mosaïque), vue détail plein écran teintée, écran Espaces en piles.
// Les cartes vivent dans IndexedDB (db.js) et se synchronisent avec
// Google Drive (drive.js).
// ---------------------------------------------------------------

function domaineDe(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

// Une couleur stable par tag (même tag → même couleur), pour les anneaux.
function couleurTag(tag) {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360
  return `hsl(${h}, 60%, 52%)`
}

// Date relative simple (« il y a 3 jours »).
function dateRelative(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return "à l'instant"
  const m = Math.floor(s / 60); if (m < 60) return `il y a ${m} min`
  const h = Math.floor(m / 60); if (h < 24) return `il y a ${h} h`
  const j = Math.floor(h / 24); if (j < 30) return `il y a ${j} j`
  const mo = Math.floor(j / 30); if (mo < 12) return `il y a ${mo} mois`
  return `il y a ${Math.floor(mo / 12)} an(s)`
}

// Couleur dominante d'une image (moyenne sur un petit canvas). Renvoie
// [r,g,b] ou null si l'image est inaccessible (CORS) ou absente.
function couleurDominante(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = 24; c.height = 24
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0, 24, 24)
        const d = ctx.getImageData(0, 0, 24, 24).data
        let r = 0, g = 0, b = 0, n = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++
        }
        if (!n) return resolve(null)
        resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
      } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// --- Capture depuis l'extension navigateur -----------------------
let _extCapture = null
let _extListener = null
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.source !== 'monmind-ext' || !d.capture) return
    _extCapture = d.capture
    if (_extListener) _extListener(d.capture)
  })
}

function creerCarteLien(cap) {
  return ajouterCarte({
    type: 'lien',
    url: cap.url || '',
    titre: (cap.titre || '').trim(),
    apercu: cap.image || '',
    texte: (cap.texte || cap.selection || '').trim()
  })
}

// URL d'affichage d'une carte : image complète locale si on l'a, sinon
// la vignette (cas des médias importés « à la demande »).
function useSrcImage(carte) {
  const [src, setSrc] = useState(null)
  // ⚠️ Dexie/`useLiveQuery` renvoie une NOUVELLE instance de Blob à CHAQUE
  // émission (donc à chaque édition de N'IMPORTE quelle carte). Si on dépend de
  // l'identité du blob, on révoque puis recrée l'URL à chaque fois → un instant
  // l'`<img>` pointe sur une URL révoquée = vignette cassée jusqu'au rechargement.
  // On dépend donc d'une CLÉ STABLE (id + taille du blob) : éditer les tags/notes
  // ne change pas la taille → l'URL de l'image est conservée telle quelle.
  const cle = (carte?.id || '') + ':' + (carte?.image?.size || 0) + ':' + (carte?.vignette?.size || 0)
  useEffect(() => {
    const blob = carte?.image || carte?.vignette
    if (!blob) { setSrc(null); return }
    const u = URL.createObjectURL(blob)
    setSrc(u)
    // Révocation différée : l'ancienne URL reste valide le temps que le nouveau
    // rendu s'affiche, jamais d'image cassée pendant la transition.
    return () => { setTimeout(() => URL.revokeObjectURL(u), 2000) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cle])
  return src
}

// Nombre de colonnes de la mosaïque selon la largeur de l'écran.
function calcColonnes(w) { return w < 560 ? 2 : w < 900 ? 3 : 4 }
function useNbColonnes() {
  const [n, setN] = useState(() => calcColonnes(typeof window !== 'undefined' ? window.innerWidth : 1200))
  useEffect(() => {
    const on = () => setN(calcColonnes(window.innerWidth))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return n
}
// Répartit les cartes en `n` colonnes en round-robin (carte 0→col0, 1→col1…)
// pour que l'ordre chronologique (plus récentes d'abord) se lise ligne par ligne.
function repartirColonnes(items, n) {
  const cols = Array.from({ length: n }, () => [])
  items.forEach((it, i) => cols[i % n].push(it))
  return cols
}

// Miniature d'aperçu d'un lien construite CÔTÉ CLIENT, sans requête réseau ni
// service tiers (respecte la vie privée). YouTube pour l'instant : on extrait
// l'id de la vidéo et on pointe sa vignette officielle. (Les autres sites
// nécessiteraient de crawler leur balise og:image — impossible sans serveur.)
function idYouTube(url) {
  const m = (url || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/)
  return m ? m[1] : null
}
function apercuLien(url) {
  const yt = idYouTube(url)
  return yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null
}

// --- Diagnostic : repérer les cartes « pas carrées » -------------------
// Note dont le contenu se réduit à une image markdown (« ![]() » ou
// « ![](…) ») sans vrai texte : artefact d'import mymind (l'image n'a pas
// suivi). On l'affichera comme « image manquante » plutôt que ce charabia.
const RE_MD_IMG = /!\[[^\]]*\]\([^)]*\)/
function estNoteImageManquante(c) {
  if (c.type !== 'note') return false
  const t = (c.texte || '').trim()
  return !!t && RE_MD_IMG.test(t) && t.replace(RE_MD_IMG, '').trim() === ''
}
// Carte sans rien d'affichable (ni texte, ni titre, ni lien, ni média).
function estCarteVide(c) {
  if (c.type === 'image' || c.type === 'video' || c.type === 'pdf') return false
  return !(c.texte || '').trim() && !(c.titre || '').trim() &&
         !(c.url || '').trim() && !c.apercu && !c.image && !c.vignette
}
// Cartes « privées » : portant le tag `private`. Cachées de la page principale,
// des espaces et de la sérendipité — on ne les voit qu'en cherchant « #private ».
const TAG_PRIVE = 'private'
function estPrivee(c) { return (c.tags || []).some(t => normTag(t) === TAG_PRIVE) }

// Analyse la requête : les jetons « #tag » filtrent sur un tag EXACT (recherche
// précise sur LE TAG, pas sur le mot où qu'il soit dans le contenu). Le reste est
// du texte libre passé à MiniSearch. Ex. « #ia design » → tag « ia » + texte « design ».
function analyserRequete(q) {
  const tags = [], mots = []
  for (const tok of (q || '').trim().split(/\s+/).filter(Boolean)) {
    if (tok[0] === '#' && tok.length > 1) tags.push(normTag(tok.slice(1)))
    else mots.push(tok)
  }
  return { tags: tags.filter(Boolean), texte: mots.join(' ') }
}

// Statistiques + liste des cartes à revoir, calculées en mémoire. Les cartes
// privées sont comptées à part (`privees`), hors des compteurs publics.
function calculerStats(contenu, tousTags, espaces, ocr) {
  const parType = { image: 0, video: 0, note: 0, lien: 0, pdf: 0 }
  const dom = {}
  let yt = 0, tw = 0, social = 0, liensSansApercu = 0, privees = 0, total = 0
  const aRevoir = []
  for (const c of contenu) {
    if (estPrivee(c)) { privees++; continue }
    total++
    if (parType[c.type] != null) parType[c.type]++
    if (c.type === 'lien') {
      const d = domaineDe(c.url || '')
      if (d) dom[d] = (dom[d] || 0) + 1
      if (idYouTube(c.url)) yt++
      else if (/(^|\.)(twitter\.com|x\.com|t\.co)$/.test(d)) tw++
      else if (/(instagram\.com|threads\.(net|com)|bsky\.app|mastodon)/.test(d)) social++
      if (!c.apercu && !idYouTube(c.url)) liensSansApercu++
    }
    if (estNoteImageManquante(c) || estCarteVide(c)) aRevoir.push(c)
  }
  const topDom = Object.entries(dom).sort((a, b) => b[1] - a[1]).slice(0, 12)
  return {
    total, parType, yt, tw, social, liensSansApercu, topDom,
    nbTags: tousTags.length, nbEspaces: espaces.length, ocr, aRevoir, privees
  }
}

// --- Une carte dans la mosaïque ----------------------------------
// Pas de bouton de suppression ici : dans la grille, on ne veut qu'ouvrir la
// carte (un × flottant façon « fermer » sur chaque vignette est déroutant et
// risqué — suppression trop facile). La suppression se fait dans la carte
// OUVERTE (vue détail, bouton 🗑), comme sur mymind.
function Carte({ carte, onOuvrir }) {
  const src = useSrcImage(carte)
  const apercu = carte.type === 'lien' ? (carte.apercu || apercuLien(carte.url)) : null

  // La « légende » sous la carte (façon mymind) : le texte d'une image/vidéo,
  // ou le domaine d'un lien.
  const legende = (carte.type === 'image' || carte.type === 'video')
    ? (carte.texte || '')
    : carte.type === 'pdf'
      ? (carte.titre || 'PDF')
      : carte.type === 'lien'
        ? domaineDe(carte.url)
        : ''

  return (
    <div className="brique">
      <article className="carte cliquable" onClick={() => onOuvrir(carte, src)}>
        {carte.type === 'lien' && !apercu && <div className="accent-lien" />}
        {carte.type === 'lien' && apercu && (
          <img className="apercu-lien" src={apercu} alt="" loading="lazy"
               onError={e => { e.currentTarget.style.display = 'none' }} />
        )}
        {src && carte.type === 'video' && (
          <div className="media-poster"><img src={src} alt="" /><span className="play-badge">▶</span></div>
        )}
        {src && carte.type !== 'video' && <img src={src} alt={carte.texte || 'Image'} />}

        {carte.type === 'lien' && (
          <div className="contenu">
            <p className="lien-titre">{carte.titre || carte.url}</p>
            {carte.texte && <p className="texte lien-extrait">{carte.texte}</p>}
          </div>
        )}
        {carte.type === 'note' && carte.texte && (
          <div className="contenu">
            {estNoteImageManquante(carte)
              ? <p className="note-manquante">Image non importée</p>
              : <p className="texte note-serif">{carte.texte}</p>}
          </div>
        )}
      </article>
      {legende && <p className="legende">{legende}</p>}
    </div>
  )
}

// Rend un article capturé (Markdown léger : titres #, listes -, citations >,
// **gras**) en éléments React — sans dépendance ni innerHTML (donc sûr). Le
// vieux texte brut (sans marqueurs) passe naturellement en paragraphes.
function fragmentsGras(txt, cle) {
  const out = []
  const re = /\*\*([^*]+)\*\*/g
  let dernier = 0, m, i = 0
  while ((m = re.exec(txt))) {
    if (m.index > dernier) out.push(txt.slice(dernier, m.index))
    out.push(<strong key={cle + '-' + (i++)}>{m[1]}</strong>)
    dernier = m.index + m[0].length
  }
  if (dernier < txt.length) out.push(txt.slice(dernier))
  return out
}

function RenduLecture({ texte }) {
  const blocs = (texte || '').split(/\n{2,}/)
  const elems = []
  let liste = null
  const viderListe = () => { if (liste) { elems.push(<ul className="ml-ul" key={'ul' + elems.length}>{liste}</ul>); liste = null } }
  blocs.forEach((b, i) => {
    const t = b.trim()
    if (!t) return
    const h = t.match(/^(#{1,6})\s+([\s\S]*)$/)
    if (h) {
      viderListe()
      const n = h[1].length
      const cont = fragmentsGras(h[2].replace(/\s+/g, ' ').trim(), 'h' + i)
      if (n <= 1) elems.push(<h2 className="ml-h ml-h1" key={i}>{cont}</h2>)
      else if (n === 2) elems.push(<h3 className="ml-h ml-h2" key={i}>{cont}</h3>)
      else elems.push(<h4 className="ml-h ml-h3" key={i}>{cont}</h4>)
      return
    }
    if (/^-\s+/.test(t)) {
      if (!liste) liste = []
      t.split('\n').forEach((l, j) => {
        const li = l.replace(/^-\s+/, '').trim()
        if (li) liste.push(<li key={i + '-' + j}>{fragmentsGras(li, 'li' + i + j)}</li>)
      })
      return
    }
    viderListe()
    if (/^>\s?/.test(t)) {
      elems.push(<blockquote className="ml-q" key={i}>{fragmentsGras(t.replace(/^>\s?/gm, '').trim(), 'q' + i)}</blockquote>)
      return
    }
    elems.push(<p className="ml-p" key={i}>{fragmentsGras(t, 'p' + i)}</p>)
  })
  viderListe()
  return <div className="dc-lecture-texte">{elems}</div>
}

// --- Vue DÉTAIL plein écran (façon mymind) -----------------------
function Detail({ carte, src, espaces = [], tousTags = [], fermer, onModif, onSupprimer, onNaviguer }) {
  const [tags, setTags] = useState(carte.tags || [])
  const [nouveauTag, setNouveauTag] = useState('')
  const [ajoutTag, setAjoutTag] = useState(false)
  const [mesEspaces, setMesEspaces] = useState(carte.espaces || [])
  const champNote = carte.type === 'note' ? 'texte' : 'note'
  const [note, setNote] = useState(carte[champNote] || '')
  const [titreEdit, setTitreEdit] = useState(carte.titre || '')
  const [teinte, setTeinte] = useState(null)
  const [nouvelEspaceOuvert, setNouvelEspaceOuvert] = useState(false)
  const [nomNouvelEspace, setNomNouvelEspace] = useState('')
  const [pleinSrc, setPleinSrc] = useState(null)     // image complète (depuis Drive)
  const [chargePlein, setChargePlein] = useState(false) // téléchargement HD en cours
  const [pleinErreur, setPleinErreur] = useState(false) // HD indisponible (jeton/hors-ligne)
  const [videoSrc, setVideoSrc] = useState(null)     // vidéo complète (depuis Drive)
  const [chargeMedia, setChargeMedia] = useState(false)
  const [videoErreur, setVideoErreur] = useState(false)
  const videoRef = useRef(null)
  // Panneau d'infos (tags / note / espaces) : FERMÉ par défaut sur desktop, il
  // glisse depuis la droite quand on tire l'onglet. Sur mobile il reste sous le
  // média (voir CSS) et cet état n'a aucun effet. L'état PERSISTE quand on
  // navigue ← → : ouvert une fois, il reste ouvert sur les cartes suivantes.
  const [panneauOuvert, setPanneauOuvert] = useState(false)

  // Image affichée : la complète si chargée, sinon la vignette / l'aperçu.
  // `vignetteSrc` est recalculée depuis la carte → la navigation ← → affiche
  // tout de suite la vignette de la carte suivante, même sans `src` fourni.
  const vignetteSrc = useSrcImage(carte)
  const image = pleinSrc || src || vignetteSrc || (carte.type === 'lien' ? (carte.apercu || apercuLien(carte.url)) : null)
  const aMediaDrive = !!carte.driveMediaId
  // Lien YouTube : on peut lire la vidéo directement dans la carte (embed).
  const ytId = carte.type === 'lien' ? idYouTube(carte.url) : null
  const [lireYt, setLireYt] = useState(false)

  // Mode « Lecture » : capture hors-ligne du contenu d'un article (via le
  // backend /lire). Le texte est rangé dans la carte (champ `article`) et
  // synchronisé par Drive → il reste lisible même si la page d'origine meurt.
  const [captureEtat, setCaptureEtat] = useState('idle')  // idle | charge | erreur
  const [lectureOuverte, setLectureOuverte] = useState(false)
  const peutCapturer = carte.type === 'lien' && carte.url && !ytId && API_BASE
  async function capturerArticle() {
    if (!peutCapturer) return
    setCaptureEtat('charge')
    try {
      const r = await fetch(`${API_BASE}/lire?url=${encodeURIComponent(carte.url)}`)
      const j = await r.json()
      if (!j || j.erreur || !j.texte) { setCaptureEtat('erreur'); return }
      const maj = { article: j.texte, articleLe: Date.now() }
      if (!(carte.titre || '').trim() && j.titre) maj.titre = j.titre
      await majCarte(carte.id, maj)
      setCaptureEtat('idle'); setLectureOuverte(true)
      onModif && onModif()
    } catch { setCaptureEtat('erreur') }
  }
  // Réinitialise l'affichage « Lecture » quand on navigue vers une autre carte.
  useEffect(() => { setLectureOuverte(false); setCaptureEtat('idle') }, [carte.id])

  useEffect(() => {
    const surTouche = e => { if (e.key === 'Escape') fermer() }
    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [fermer])

  // Navigation au SWIPE (mobile) : un glissement horizontal passe à la carte
  // précédente / suivante — l'équivalent tactile des flèches ← → du clavier,
  // puisqu'il n'y a pas de flèches sur téléphone. On distingue un vrai swipe
  // horizontal d'un défilement vertical (le panneau se lit en scrollant) en
  // exigeant que le déplacement en X domine nettement celui en Y.
  const toucheDebut = useRef(null)
  function surTouchStart(e) {
    if (e.touches.length !== 1) { toucheDebut.current = null; return }
    const t = e.touches[0]
    toucheDebut.current = { x: t.clientX, y: t.clientY }
  }
  function surTouchEnd(e) {
    const d = toucheDebut.current
    toucheDebut.current = null
    if (!d || !onNaviguer) return
    const t = e.changedTouches[0]
    const dx = t.clientX - d.x, dy = t.clientY - d.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      onNaviguer(dx < 0 ? 1 : -1)   // glisser vers la gauche = carte suivante
    }
  }

  // Média « à la demande » : pour une image importée, on va chercher le
  // fichier complet dans Drive dès l'ouverture (la vignette s'affiche en
  // attendant). Pour une vidéo, on attend le clic « lecture ».
  useEffect(() => {
    let vivant = true, url = null
    // On repart de zéro à CHAQUE carte (navigation ← →) : sinon l'image HD de
    // la carte précédente resterait affichée le temps du nouveau téléchargement.
    setPleinSrc(null); setPleinErreur(false); setChargePlein(false)
    if (carte.distant && carte.type === 'image' && carte.driveMediaId) {
      setChargePlein(true)
      ;(async () => {
        try {
          let b
          try {
            b = await telechargerMediaComplet(carte.driveMediaId)
          } catch (e) {
            // Cause n°1 d'une image qui reste floue : le jeton Drive a expiré et
            // le téléchargement HD échoue en silence. On tente un rafraîchissement
            // silencieux, puis un seul nouvel essai avant d'abandonner proprement.
            await rafraichirJeton().catch(() => {})
            b = await telechargerMediaComplet(carte.driveMediaId)
          }
          if (!vivant) return
          url = URL.createObjectURL(b); setPleinSrc(url)
        } catch (e) {
          if (vivant) setPleinErreur(true)
        } finally {
          if (vivant) setChargePlein(false)
        }
      })()
    }
    return () => { vivant = false; if (url) URL.revokeObjectURL(url) }
  }, [carte.distant, carte.type, carte.driveMediaId])

  async function chargerVideo() {
    if (videoSrc || chargeMedia) return
    setChargeMedia(true)
    try {
      const b = carte.driveMediaId ? await telechargerMediaComplet(carte.driveMediaId) : null
      if (b) {
        // Ces vidéos sont renvoyées par Drive en « video/quicktime » (conteneur
        // .mov), un type que Chrome REFUSE de lire — alors que le codec interne
        // est du H.264/MP4, parfaitement lisible. On ré-étiquette donc le blob
        // en « video/mp4 » : le démuxeur de Chrome accepte alors le fichier.
        const type = (!b.type || /quicktime|octet-stream/.test(b.type)) ? 'video/mp4' : b.type
        const blob = type === b.type ? b : b.slice(0, b.size, type)
        setVideoSrc(URL.createObjectURL(blob))
      }
    } catch (e) { console.error('[video]', e); setVideoErreur(true) }
    setChargeMedia(false)
  }

  // Filet de sécurité : si la vidéo n'a même pas chargé ses métadonnées au
  // bout de 12 s (lecteur bloqué sur certains navigateurs / fichiers), on
  // bascule sur le repli « Ouvrir dans Drive / Télécharger » plutôt que de
  // laisser tourner la roue indéfiniment.
  useEffect(() => {
    if (!videoSrc) return
    const t = setTimeout(() => {
      const v = videoRef.current
      if (v && v.readyState < 1) { setVideoErreur(true); setVideoSrc(null) }
    }, 12000)
    return () => clearTimeout(t)
  }, [videoSrc])

  // Couleur dominante de l'image → fond teinté du panneau.
  useEffect(() => {
    let vivant = true
    couleurDominante(image).then(c => { if (vivant && c) setTeinte(c) })
    return () => { vivant = false }
  }, [image])

  function ajouterTag() {
    const t = nouveauTag.trim().toLowerCase()
    setNouveauTag(''); setAjoutTag(false)
    if (!t || tags.includes(t)) return
    const maj = [...tags, t]
    setTags(maj)
    majCarte(carte.id, { tags: maj }).then(onModif)
  }
  function retirerTag(t) {
    const maj = tags.filter(x => x !== t)
    setTags(maj)
    majCarte(carte.id, { tags: maj }).then(onModif)
  }
  function sauverNote() {
    if (note !== (carte[champNote] || '')) majCarte(carte.id, { [champNote]: note }).then(onModif)
  }
  function sauverTitre() {
    const t = titreEdit.trim()
    if (t !== (carte.titre || '')) majCarte(carte.id, { titre: t }).then(onModif)
  }
  function basculerEspace(id) {
    const epingler = !mesEspaces.includes(id)
    basculerEpingle({ ...carte, espaces: mesEspaces }, id, epingler)
      .then(maj => { setMesEspaces(maj); onModif() })
  }
  function jeter() {
    if (onSupprimer) { onSupprimer(carte); fermer() }
    else supprimerCarte(carte.id).then(() => { onModif(); fermer() })
  }
  const telechargeable = carte.type === 'image' || carte.type === 'video' ||
    (carte.type === 'lien' && !!carte.apercu)

  // Télécharge le média complet en local (image / vidéo / aperçu).
  async function telecharger() {
    let href, ext, revoke = false
    if (carte.driveMediaId) {
      const b = await telechargerMediaComplet(carte.driveMediaId)
      href = URL.createObjectURL(b); revoke = true
      ext = carte.mediaExt || (b.type.split('/')[1] || 'bin')
    } else if (carte.image) {
      href = URL.createObjectURL(carte.image); revoke = true
      ext = carte.image.type.split('/')[1] || 'png'
    } else if (carte.type === 'lien' && carte.apercu) {
      href = carte.apercu; ext = 'jpg'
    } else return
    const nom = (carte.titre || carte.texte || 'monmind').trim().slice(0, 40).replace(/[^\w\-]+/g, '-') || 'monmind'
    const a = document.createElement('a')
    a.href = href; a.download = `${nom}.${ext}`
    document.body.appendChild(a); a.click(); a.remove()
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10000)
  }
  // Crée un nouvel espace et y épingle directement cette carte.
  async function creerEspaceEtEpingler() {
    const nom = nomNouvelEspace.trim()
    setNomNouvelEspace(''); setNouvelEspaceOuvert(false)
    if (!nom) return
    const e = await creerEspace(nom)
    const maj = mesEspaces.includes(e.id) ? mesEspaces : [...mesEspaces, e.id]
    await majCarte(carte.id, { espaces: maj })
    setMesEspaces(maj); onModif()
  }

  const fond = teinte
    ? `rgb(${teinte[0]}, ${teinte[1]}, ${teinte[2]})`
    : 'hsl(222, 22%, 22%)'
  const titrePlaceholder = carte.type === 'note' ? 'Note' : carte.type === 'image' ? 'Image'
    : carte.type === 'video' ? 'Vidéo' : carte.type === 'pdf' ? 'PDF' : (domaineDe(carte.url) || 'Sans titre')

  return (
    <div className="detail-voile" style={{ background: fond }} onClick={fermer}
         onTouchStart={surTouchStart} onTouchEnd={surTouchEnd}>
      <button className="detail-fermer" title="Fermer" onClick={fermer}>×</button>

      <div className={'detail-scene' + (panneauOuvert ? ' panneau-ouvert' : '')}
           onClick={e => e.stopPropagation()}>
        {/* Colonne gauche : le contenu */}
        <div className="detail-contenu">
          {carte.type === 'lien' && (
            <div className="dc-carte">
              {carte.titre && <h1 className="dc-titre">{carte.titre}</h1>}
              {carte.url && (
                <a className="dc-source" href={carte.url} target="_blank" rel="noreferrer">
                  {domaineDe(carte.url)} ↗
                </a>
              )}
              {ytId ? (
                lireYt ? (
                  <div className="dc-yt">
                    <iframe
                      src={`https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0`}
                      title="Lecteur YouTube" allowFullScreen
                      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                    />
                  </div>
                ) : (
                  <div className="dc-yt dc-yt-poster" onClick={() => setLireYt(true)}>
                    {image && <img src={image} alt="" onError={e => { e.currentTarget.style.display = 'none' }} />}
                    <button className="play-badge grand" title="Lire la vidéo">▶</button>
                  </div>
                )
              ) : (
                image && <img className="dc-image" src={image} alt=""
                              onError={e => { e.currentTarget.style.display = 'none' }} />
              )}
              {carte.texte && <div className="dc-texte">{carte.texte}</div>}

              {peutCapturer && (
                <div className="dc-lecture">
                  {carte.article ? (
                    <>
                      <button className="dc-lecture-titre" onClick={() => setLectureOuverte(o => !o)}>
                        <span>📖 Lecture</span>
                        <span className="dc-lecture-chevron">{lectureOuverte ? '▾' : '▸'}</span>
                      </button>
                      {lectureOuverte && (
                        <div className="dc-lecture-corps">
                          <RenduLecture texte={carte.article} />
                          <div className="dc-lecture-pied">
                            Capturé {carte.articleLe ? dateRelative(carte.articleLe) : ''}
                            <button className="dc-lecture-maj" onClick={capturerArticle}
                                    disabled={captureEtat === 'charge'}>
                              {captureEtat === 'charge' ? 'Capture…' : 'Actualiser'}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <button className="dc-lecture-capturer" onClick={capturerArticle}
                            disabled={captureEtat === 'charge'}>
                      {captureEtat === 'charge' ? 'Capture en cours…'
                        : captureEtat === 'erreur' ? 'Article illisible — réessayer'
                        : '📖 Capturer l’article (lecture hors-ligne)'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {carte.type === 'image' && image && (
            <div className="dc-image-enveloppe">
              <img className="dc-image-nue" src={image} alt={carte.texte || 'Image'} />
              {aMediaDrive && chargePlein && !pleinSrc && (
                <span className="dc-hd dc-hd-charge">Chargement HD…</span>
              )}
              {aMediaDrive && pleinErreur && !pleinSrc && (
                <span className="dc-hd dc-hd-echec" title="Reconnecte Google Drive (à gauche) pour charger la version haute résolution.">
                  Aperçu — HD indisponible, reconnecte Drive
                </span>
              )}
            </div>
          )}
          {carte.type === 'pdf' && (
            <div className="dc-video-poster dc-video-echec">
              {image && <img className="dc-image-nue" src={image} alt="" />}
              <div className="dc-video-msg">
                <p>Document PDF</p>
                <div className="dc-video-actions">
                  {carte.driveMediaId && (
                    <a className="bouton-principal" target="_blank" rel="noreferrer"
                       href={`https://drive.google.com/file/d/${carte.driveMediaId}/view`}>Ouvrir dans Drive</a>
                  )}
                  <button className="bouton-lien" onClick={telecharger}>Télécharger</button>
                </div>
              </div>
            </div>
          )}
          {carte.type === 'video' && (
            videoErreur ? (
              <div className="dc-video-poster dc-video-echec">
                {image && <img className="dc-image-nue" src={image} alt="" />}
                <div className="dc-video-msg">
                  <p>Cette vidéo ne se lit pas directement ici.</p>
                  <div className="dc-video-actions">
                    {carte.driveMediaId && (
                      <a className="bouton-principal" target="_blank" rel="noreferrer"
                         href={`https://drive.google.com/file/d/${carte.driveMediaId}/view`}>▶ Ouvrir dans Drive</a>
                    )}
                    <button className="bouton-lien" onClick={telecharger}>Télécharger</button>
                  </div>
                </div>
              </div>
            ) : videoSrc ? (
              <video ref={videoRef} className="dc-video" src={videoSrc} controls autoPlay playsInline
                     onError={() => { setVideoSrc(null); setVideoErreur(true) }} />
            ) : (
              <div className="dc-video-poster" onClick={chargerVideo}>
                {image && <img className="dc-image-nue" src={image} alt="" />}
                <button className="play-badge grand" title="Lire la vidéo">{chargeMedia ? '…' : '▶'}</button>
              </div>
            )
          )}
          {carte.type === 'note' && (
            <div className="dc-carte dc-note">
              {estNoteImageManquante(carte)
                ? <p className="note-manquante grand">Image non importée depuis mymind</p>
                : <p className="dc-note-texte">{carte.texte}</p>}
            </div>
          )}

          {/* Onglet : ouvre / referme le panneau d'infos. Placé DANS le contenu
              pour s'ancrer au média. Desktop : tab vertical au bord droit du
              média. Mobile : barre fixée en bas (voir CSS). */}
          <button
            className="detail-onglet"
            onClick={() => setPanneauOuvert(o => !o)}
            title={panneauOuvert ? 'Masquer les infos' : 'Tags, note & espaces'}
            aria-label={panneauOuvert ? 'Masquer le panneau d’infos' : 'Afficher le panneau d’infos'}
          >
            <span className="detail-onglet-fleche">{panneauOuvert ? '›' : '‹'}</span>
            <span className="detail-onglet-txt">Infos</span>
          </button>
        </div>

        {/* Colonne droite : le panneau d'infos */}
        <aside className="detail-panneau">
          <div className="dp-haut">
            <textarea
              className="dp-titre dp-titre-champ" rows={1} value={titreEdit}
              placeholder={titrePlaceholder}
              onChange={e => setTitreEdit(e.target.value)}
              onBlur={sauverTitre}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() } }}
            />
            <p className="dp-date">{dateRelative(carte.creeLe)}</p>

            <div className="dp-label">Tags</div>
            <div className="tags-editeur">
              <button className="tag-ajout" onClick={() => setAjoutTag(true)}>+ tag</button>
              {tags.map(t => (
                <span key={t} className="tag-chip">
                  <span className="anneau" style={{ borderColor: couleurTag(t) }} />
                  {t}
                  <button title="Retirer" onClick={() => retirerTag(t)}>×</button>
                </span>
              ))}
              {ajoutTag && (
                <input
                  className="tag-input" autoFocus placeholder="nom du tag…"
                  list="tags-connus" value={nouveauTag}
                  onChange={e => setNouveauTag(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); ajouterTag() }
                    if (e.key === 'Escape') { setNouveauTag(''); setAjoutTag(false) }
                  }}
                  onBlur={ajouterTag}
                />
              )}
              <datalist id="tags-connus">
                {tousTags.filter(t => !tags.includes(t)).map(t => <option key={t} value={t} />)}
              </datalist>
            </div>

            <div className="dp-label">Note</div>
            <textarea
              className="note-editeur" placeholder="Écris une note…"
              value={note} onChange={e => setNote(e.target.value)} onBlur={sauverNote}
            />

            {espaces.length > 0 && (
              <>
                <div className="dp-label">Espaces</div>
                <div className="espaces-editeur">
                  {espaces.map(e => (
                    <button
                      key={e.id}
                      className={'espace-toggle' + (mesEspaces.includes(e.id) ? ' actif' : '')}
                      onClick={() => basculerEspace(e.id)}
                    >{mesEspaces.includes(e.id) ? '✓ ' : '+ '}{e.titre}</button>
                  ))}
                </div>
              </>
            )}
          </div>

          {nouvelEspaceOuvert && (
            <div className="dp-nouvel-espace">
              <input
                autoFocus className="espace-nouveau-champ" placeholder="Nom du nouvel espace…"
                value={nomNouvelEspace} onChange={e => setNomNouvelEspace(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') creerEspaceEtEpingler()
                  if (e.key === 'Escape') { setNomNouvelEspace(''); setNouvelEspaceOuvert(false) }
                }}
                onBlur={creerEspaceEtEpingler}
              />
            </div>
          )}

          <div className="dp-actions">
            {telechargeable && (
              <button className="dp-icone" title="Télécharger en local" onClick={telecharger}>↓</button>
            )}
            <button className="dp-icone" title="Ranger dans un nouvel espace"
                    onClick={() => setNouvelEspaceOuvert(v => !v)}>◯</button>
            <button className="dp-icone dp-jeter" title="Supprimer" onClick={jeter}>🗑</button>
          </div>
        </aside>
      </div>
    </div>
  )
}

// --- Composeur (ajout d'une carte) -------------------------------
function Composeur({ fermer, onAjout, tousTags = [] }) {
  const [texte, setTexte] = useState('')
  const [image, setImage] = useState(null)   // image → carte image locale (+ OCR)
  const [media, setMedia] = useState(null)   // vidéo / PDF → média « à la demande » (Drive)
  const [apercu, setApercu] = useState(null)
  const [tags, setTags] = useState([])       // tags attribués DÈS l'ajout
  const [tagSaisie, setTagSaisie] = useState('')
  const [envoi, setEnvoi] = useState(false)  // envoi d'un média vers Drive en cours
  const [erreur, setErreur] = useState(null)
  const fichierRef = useRef(null)
  const zoneRef = useRef(null)

  useEffect(() => { zoneRef.current?.focus() }, [])

  // Tri d'un fichier choisi (bouton ou collage) : image → aperçu local ;
  // vidéo / PDF → média « à la demande » (vignette + fichier envoyé dans Drive).
  function choisirFichier(fichier) {
    if (!fichier) return
    setErreur(null)
    if (fichier.type.startsWith('image/')) {
      setImage(fichier); setMedia(null)
      setApercu(URL.createObjectURL(fichier))
    } else if (estMediaSupporte(fichier)) {
      setMedia(fichier); setImage(null)
      setApercu(fichier.type.startsWith('video/') ? URL.createObjectURL(fichier) : null)
    } else {
      setImage(null); setMedia(null); setApercu(null)
      setErreur('Format non pris en charge (images, vidéos, PDF).')
    }
  }
  function surCollage(e) {
    const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); choisirFichier(item.getAsFile()) }
  }
  // Tags saisis à l'ajout : normalisés (minuscule) et dédoublonnés, comme dans
  // le panneau de détail. `list` + `<datalist>` fournissent l'auto-complétion
  // à partir des tags déjà existants.
  function ajouterTagLocal(brut) {
    const t = (brut ?? tagSaisie).trim().toLowerCase()
    setTagSaisie('')
    if (!t || tags.includes(t)) return
    setTags([...tags, t])
  }
  function retirerTagLocal(t) { setTags(tags.filter(x => x !== t)) }

  const aMedia = !!(image || media)
  async function enregistrer() {
    if (envoi) return
    const propre = texte.trim()
    if (!propre && !aMedia) return
    // Inclut un tag encore tapé dans le champ mais pas « validé » par Entrée.
    const enAttente = tagSaisie.trim().toLowerCase()
    const tagsFinal = enAttente && !tags.includes(enAttente) ? [...tags, enAttente] : tags
    if (image) {
      const c = await ajouterCarte({ type: 'image', image, texte: propre, tags: tagsFinal })
      ocrEnFond(c.id, image)
    } else if (media) {
      // Vidéo / PDF → même plomberie que le glisser-déposer : vignette locale
      // + fichier complet envoyé dans Drive (chargé à la demande ensuite).
      setEnvoi(true)
      let r
      try { r = await ajouterMediaDepuisFichier(media, { texte: propre, tags: tagsFinal }) }
      catch (e) { console.error('[composeur-media]', e); r = 'erreur' }
      setEnvoi(false)
      if (r === 'besoin-drive') {
        setErreur('Connecte Google Drive (à gauche) pour ajouter une vidéo ou un PDF.')
        return
      }
      if (r === 'erreur' || r === 'ignore') {
        setErreur("Ce fichier n'a pas pu être ajouté. Réessaie ou choisis-en un autre.")
        return
      }
    } else if (estUneUrl(propre)) {
      await ajouterCarte({ type: 'lien', url: propre, titre: '', tags: tagsFinal })
    } else {
      await ajouterCarte({ type: 'note', texte: propre, tags: tagsFinal })
    }
    onAjout?.()
    fermer()
  }

  return (
    <div className="voile" onClick={e => { if (e.target === e.currentTarget && !envoi) fermer() }}>
      <div className="composeur">
        <textarea
          ref={zoneRef}
          placeholder="Une pensée, un lien, une image, une vidéo…"
          value={texte}
          onChange={e => setTexte(e.target.value)}
          onPaste={surCollage}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) enregistrer()
            if (e.key === 'Escape' && !envoi) fermer()
          }}
        />
        {apercu && image && <img className="apercu-image" src={apercu} alt="Aperçu" />}
        {apercu && media && <video className="apercu-image" src={apercu} controls playsInline muted />}
        {media && !apercu && <p className="apercu-fichier">📄 {media.name || 'Document'}</p>}
        {erreur && <p className="import-erreur">{erreur}</p>}

        {/* Tags attribués dès l'ajout — auto-complétés par les tags existants. */}
        <div className="composeur-tags">
          {tags.map(t => (
            <span key={t} className="tag-chip">
              <span className="anneau" style={{ borderColor: couleurTag(t) }} />
              {t}
              <button title="Retirer" onClick={() => retirerTagLocal(t)}>×</button>
            </span>
          ))}
          <input
            className="tag-input" placeholder="+ tag" list="composeur-tags-connus"
            value={tagSaisie}
            onChange={e => setTagSaisie(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); ajouterTagLocal() }
              if (e.key === 'Backspace' && !tagSaisie && tags.length) retirerTagLocal(tags[tags.length - 1])
            }}
            onBlur={() => ajouterTagLocal()}
          />
          <datalist id="composeur-tags-connus">
            {tousTags.filter(t => !tags.includes(t)).map(t => <option key={t} value={t} />)}
          </datalist>
        </div>

        <div className="actions">
          <button className="bouton-second" onClick={() => fichierRef.current.click()}>
            Photo, vidéo, PDF
          </button>
          <input
            ref={fichierRef} type="file" accept="image/*,video/*,application/pdf" hidden
            onChange={e => choisirFichier(e.target.files[0])}
          />
          <button
            className="bouton-principal"
            disabled={(!texte.trim() && !aMedia) || envoi}
            onClick={enregistrer}
          >{envoi ? 'Envoi…' : 'Garder'}</button>
        </div>
      </div>
    </div>
  )
}

// --- Synchronisation Drive ---------------------------------------
function useSync() {
  const [etat, setEtat] = useState('inconnu')
  const [progression, setProgression] = useState(null) // { recues, total } — gros téléchargement en cours
  const [permanent, setPermanent] = useState(false)    // session backend (connexion Drive permanente)
  const timer = useRef(null)
  const dernierTick = useRef(0)

  // Compteur de téléchargement : on limite la fréquence des mises à jour
  // (~toutes les 300 ms) pour ne pas re-rendre l'app à chaque carte reçue,
  // mais on force l'affichage du tout dernier « X / X ».
  const surProgression = useCallback((p) => {
    if (!p || !p.total) { setProgression(null); return }
    const now = Date.now()
    if (p.recues >= p.total || now - dernierTick.current > 300) {
      dernierTick.current = now
      setProgression({ recues: p.recues, total: p.total })
    }
  }, [])

  const lancer = useCallback(async () => {
    if (!sync_configuree()) return
    setEtat('sync')
    try {
      await synchroniser(surProgression)
      setEtat('ok')
    } catch (e) {
      console.error('[sync]', e)
      if (e instanceof BesoinReconnexion || e?.name === 'BesoinReconnexion') {
        await deconnecter().catch(() => {})
        setEtat('deconnecte')
      } else {
        setEtat('erreur')
      }
    } finally {
      setProgression(null)
    }
  }, [surProgression])

  const planifier = useCallback(() => {
    if (!sync_configuree()) return
    clearTimeout(timer.current)
    timer.current = setTimeout(lancer, 1500)
  }, [lancer])

  useEffect(() => {
    if (!sync_configuree()) { setEtat('non_configure'); return }
    (async () => {
      // Retour du backend après connexion permanente : #connexion=<sid> (le sid
      // arrive dans le fragment, jamais envoyé aux serveurs). On l'enregistre et
      // on nettoie l'URL.
      const m = window.location.hash.match(/[#&]connexion=([^&]+)/)
      if (m) {
        await enregistrerSession(decodeURIComponent(m[1])).catch(() => {})
        history.replaceState(null, '', window.location.pathname + window.location.search)
      }
      await initAuth()
      setPermanent(await aSessionBackend())
      if (await estDejaConnecte()) { setEtat('pret'); lancer() }
      else setEtat('deconnecte')
    })().catch(e => { console.error(e); setEtat('erreur') })

    // Garde le jeton frais en tâche de fond (toutes les 2 min) pour qu'aucun
    // rafraîchissement Google n'apparaisse pendant l'ouverture d'une carte.
    const gardeJeton = setInterval(() => { rafraichirJeton().catch(() => {}) }, 120000)
    // Synchro périodique : quand l'app est VISIBLE, on rafraîchit souvent (30 s)
    // pour que les cartes ajoutées sur un autre appareil (ex. une vidéo depuis
    // l'iPhone) apparaissent toutes seules sur le bureau, sans geste. Quand
    // l'app est cachée, on ne poll pas (batterie / quota) : le retour à l'écran
    // déclenche une synchro immédiate via `visibilitychange` ci-dessous.
    const intervalle = setInterval(() => {
      if (document.visibilityState === 'visible') lancer()
    }, 30000)
    const surRetour = () => { if (document.visibilityState === 'visible') lancer() }
    window.addEventListener('focus', surRetour)
    document.addEventListener('visibilitychange', surRetour)
    return () => {
      clearInterval(intervalle); clearInterval(gardeJeton)
      window.removeEventListener('focus', surRetour)
      document.removeEventListener('visibilitychange', surRetour)
    }
  }, [lancer])

  const brancher = useCallback(async () => {
    try { await connecter(); setEtat('pret'); lancer() }
    catch (e) { console.error(e); setEtat('erreur') }
  }, [lancer])

  return { etat, brancher, planifier, lancer, progression, permanent }
}

function StatutSync({ etat, brancher, lancer }) {
  if (etat === 'non_configure') return <span className="rail-sync" title="Local">●</span>
  if (etat === 'deconnecte' || etat === 'inconnu')
    return <button className="rail-bouton rail-connecter" title="Connecter Google Drive" onClick={brancher}>Drive</button>
  const titre = { sync: 'Synchronisation…', ok: 'Synchronisé', pret: 'Synchronisé', erreur: 'Erreur de sync' }[etat] || ''
  return (
    <button className={'rail-sync cliquable ' + etat} title={titre + ' — cliquer pour synchroniser'} onClick={lancer}>
      {etat === 'sync' ? <span className="point-sync" /> : '●'}
    </button>
  )
}

// --- Capture externe (bookmarklet / iOS) -------------------------
function lireCapture() {
  const p = new URLSearchParams(window.location.search)
  if (!p.get('c')) return null
  if (p.get('via') === 'ext') return null
  return {
    type: p.get('type') === 'note' ? 'note' : 'lien',
    url: p.get('url') || '',
    titre: (p.get('titre') || '').trim(),
    apercu: p.get('img') || '',
    note: (p.get('note') || '').trim(),
    popup: p.get('popup') === '1'
  }
}

function CaptureExt() {
  const [carte, setCarte] = useState(null)
  const [erreur, setErreur] = useState(false)
  useEffect(() => {
    let fait = false
    const traiter = async (cap) => {
      if (fait) return
      fait = true
      try {
        const c = await creerCarteLien(cap)
        setCarte(c)
        if (sync_configuree() && await estDejaConnecte()) synchroniser().catch(() => {})
      } catch (e) { console.error('[capture-ext]', e); setErreur(true) }
    }
    if (_extCapture) traiter(_extCapture)
    _extListener = traiter
    return () => { _extListener = null }
  }, [])
  return (
    <div className="capture-ext">
      <div className="orbe" />
      {!carte && !erreur && <p className="ce-etat">Enregistrement…</p>}
      {carte && (
        <>
          <h2>Gardé dans MonCoffre ✓</h2>
          <p className="ce-titre">{carte.titre || carte.url}</p>
        </>
      )}
      {erreur && <p className="ce-etat">Impossible de garder cette page.</p>}
    </div>
  )
}

// --- Une pile de cartes pour l'écran Espaces ---------------------
function Vignette({ carte }) {
  const src = useSrcImage(carte)
  const img = src || (carte.type === 'lien' ? carte.apercu : null)
  if (img) return <img className="pile-img" src={img} alt="" onError={e => { e.currentTarget.style.display = 'none' }} />
  return <div className="pile-note"><span>{(carte.texte || carte.titre || '').slice(0, 90)}</span></div>
}

function PileEspace({ espace, membres, onOuvrir }) {
  const apercu = membres.slice(0, 5)
  return (
    <button className="pile" onClick={() => onOuvrir(espace)}>
      <div className="pile-tas">
        {apercu.length === 0 && <div className="pile-vide">Espace vide</div>}
        {apercu.map((c, i) => (
          <div className={'pile-feuille f' + i} key={c.id}><Vignette carte={c} /></div>
        ))}
      </div>
      <div className="pile-legende">
        <span className="anneau" style={{ borderColor: couleurTag(espace.titre || 'espace') }} />
        {espace.titre}
        <span className="pile-compte">{membres.length}</span>
      </div>
    </button>
  )
}

// --- Une carte dans la corbeille (restaurer / supprimer définitivement) ---
function joursAvantPurge(carte, duree) {
  const reste = duree - (Date.now() - (carte.supprimeLe || 0))
  return Math.max(0, Math.ceil(reste / (24 * 3600 * 1000)))
}
function LigneCorbeille({ carte, duree, onRestaurer, onPurger }) {
  const jours = joursAvantPurge(carte, duree)
  const etiquette = carte.titre || carte.texte || domaineDe(carte.url || '') || 'Carte'
  return (
    <div className="brique corbeille-item">
      <div className="corbeille-apercu"><Vignette carte={carte} /></div>
      <p className="corbeille-titre">{etiquette.slice(0, 80)}</p>
      <p className="corbeille-delai">Purge dans {jours} j</p>
      <div className="corbeille-actions">
        <button className="bouton-second" onClick={onRestaurer}>Restaurer</button>
        <button className="bouton-danger" onClick={onPurger}>Supprimer</button>
      </div>
    </div>
  )
}

// --- Serendipity : une carte mise en avant, Oublier / Garder -----
function CarteFocus({ carte }) {
  const src = useSrcImage(carte)
  const image = src || (carte.type === 'lien' ? carte.apercu : null)
  return (
    <div className="focus-carte">
      {carte.type === 'image' && src && <img className="focus-image" src={src} alt="" />}
      {carte.type === 'lien' && (
        <>
          {image && <img className="focus-apercu" src={image} alt=""
                         onError={e => { e.currentTarget.style.display = 'none' }} />}
          <div className="focus-corps">
            <h2 className="focus-titre">{carte.titre || carte.url}</h2>
            {carte.texte && <p className="focus-extrait">{carte.texte}</p>}
            <p className="focus-source">{domaineDe(carte.url)}</p>
          </div>
        </>
      )}
      {carte.type === 'note' && (
        <div className="focus-corps"><p className="focus-note">{carte.texte}</p></div>
      )}
    </div>
  )
}

function VueSerendipity({ file, idx, ghosts, onGarder, onOublier, onRecommencer }) {
  const carte = idx < file.length ? file[idx] : undefined
  // Saute automatiquement les cartes déjà disparues (oubliées/supprimées).
  useEffect(() => {
    if (idx < file.length && !file[idx]) onGarder()
  }, [idx, file, onGarder])

  if (idx >= file.length) {
    return (
      <div className="seren">
        <div className="seren-fin">
          <div className="orbe" />
          <h2>C'est tout pour cette fois.</h2>
          <p>Reviens quand tu veux retomber par hasard sur tes cartes.</p>
          <button className="bouton-creer-espace" onClick={onRecommencer}>↻ Recommencer</button>
        </div>
      </div>
    )
  }
  if (!carte) return <div className="seren" />  // en cours de saut
  return (
    <div className="seren">
      <div className="seren-nuees">
        {ghosts.map((g, i) => <div className={'nuee n' + i} key={g.id}><Vignette carte={g} /></div>)}
      </div>
      <div className="seren-scene">
        <div className="seren-carte" key={carte.id}><CarteFocus carte={carte} /></div>
        <div className="seren-actions">
          <button className="seren-bouton" onClick={onOublier}>Oublier</button>
          <button className="seren-bouton garder" onClick={onGarder}>Garder</button>
        </div>
        <p className="seren-compteur">{idx + 1} / {file.length}</p>
      </div>
    </div>
  )
}

// --- Écran d'import depuis mymind --------------------------------
function ImportMymind({ pret, brancher, fermer, onModif }) {
  const [prog, setProg] = useState(null)
  const [enCours, setEnCours] = useState(false)
  const [err, setErr] = useState(null)
  const supporte = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  async function choisir() {
    setErr(null)
    let handle
    try { handle = await window.showDirectoryPicker({ mode: 'read' }) }
    catch { return } // annulé par l'utilisateur
    setEnCours(true)
    try {
      await lancerImport(handle, p => setProg({ ...p }))
      onModif?.()
    } catch (e) { console.error('[import]', e); setErr(e.message || "Erreur pendant l'import") }
    setEnCours(false)
  }

  const pct = prog ? Math.round((prog.faits / (prog.total || 1)) * 100) : 0

  return (
    <div className="voile" onClick={e => { if (e.target === e.currentTarget && !enCours) fermer() }}>
      <div className="composeur import-boite">
        <h2 className="import-titre">Importer depuis mymind</h2>

        {!supporte && (
          <p className="import-note">Cet import a besoin de <strong>Chrome</strong> (ou Edge) sur ordinateur pour lire un dossier local. Ouvre MonCoffre dans Chrome pour importer.</p>
        )}

        {supporte && !pret && !prog && (
          <>
            <p className="import-note">Connecte d'abord <strong>Google Drive</strong> : c'est là que l'import déposera tes fichiers.</p>
            <button className="bouton-principal" onClick={brancher}>Connecter Google Drive</button>
          </>
        )}

        {supporte && pret && !prog && !enCours && (
          <>
            <p className="import-note">Choisis le dossier de ton export mymind (celui qui contient <code>cards.csv</code> et les fichiers). MonCoffre va lire le CSV, recréer tes cartes, et envoyer les médias dans ton Drive. <strong>Garde cet onglet ouvert</strong> pendant l'opération — ça peut durer un bon moment (plusieurs Go).</p>
            <button className="bouton-principal" onClick={choisir}>Choisir le dossier de l'export…</button>
          </>
        )}

        {prog && (
          <div className="import-prog">
            <div className="import-barre"><div className="import-jauge" style={{ width: pct + '%' }} /></div>
            <p className="import-compte">
              {prog.faits} / {prog.total}
              {prog.phase === 'sync' && ' — finalisation des textes…'}
              {prog.phase === 'fini' && ' — terminé ✓'}
            </p>
            <p className="import-detail">
              {prog.medias || 0} médias · {prog.textes || 0} textes
              {prog.sautes ? ` · ${prog.sautes} déjà faits` : ''}
              {prog.manquants ? ` · ${prog.manquants} fichiers manquants` : ''}
              {prog.erreurs ? ` · ${prog.erreurs} erreurs` : ''}
            </p>
          </div>
        )}

        {prog?.phase === 'auth' && (
          <>
            <p className="import-erreur">La connexion Google a expiré pendant l'import. Reconnecte Drive puis relance — l'import <strong>reprendra où il s'est arrêté</strong>.</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button className="bouton-second" onClick={brancher}>Reconnecter Drive</button>
              <button className="bouton-principal" onClick={choisir}>Reprendre l'import…</button>
            </div>
          </>
        )}

        {err && <p className="import-erreur">{err}</p>}
        {prog?.phase === 'fini' && (
          <button className="bouton-principal" onClick={fermer} style={{ marginTop: 8 }}>Fermer</button>
        )}
      </div>
    </div>
  )
}

// --- Vue Statistiques + diagnostic -------------------------------
function VueStats({ contenu, tousTags, espaces, ocr, onOuvrir }) {
  const s = useMemo(() => calculerStats(contenu, tousTags, espaces, ocr), [contenu, tousTags, espaces, ocr])
  const tuiles = [
    { n: s.total, l: 'cartes' },
    { n: s.parType.image, l: 'images' },
    { n: s.parType.video, l: 'vidéos' },
    { n: s.parType.note, l: 'notes' },
    { n: s.parType.lien, l: 'liens' },
    { n: s.parType.pdf, l: 'PDF' },
    { n: s.yt, l: 'YouTube' },
    { n: s.tw, l: 'Twitter / X' },
    { n: s.social, l: 'autres réseaux' },
    { n: s.nbTags, l: 'tags' },
    { n: s.nbEspaces, l: 'espaces' },
    { n: `${s.ocr.faites} / ${s.ocr.total}`, l: 'images lues (OCR)' },
    ...(s.privees ? [{ n: s.privees, l: 'privées 🔒' }] : []),
  ]
  const max = s.topDom.length ? s.topDom[0][1] : 1
  return (
    <>
      <div className="entete-vue"><h1 className="titre-serif">Statistiques</h1></div>

      <div className="stats-tuiles">
        {tuiles.map((t, i) => (
          <div className="stat-tuile" key={i}>
            <div className="stat-nb">{t.n}</div>
            <div className="stat-lbl">{t.l}</div>
          </div>
        ))}
      </div>

      {s.topDom.length > 0 && (
        <div className="stats-bloc">
          <h2 className="stats-titre">Sites les plus enregistrés</h2>
          <div className="stats-domaines">
            {s.topDom.map(([d, n]) => (
              <div className="stat-dom" key={d}>
                <span className="stat-dom-nom">{d}</span>
                <span className="stat-dom-barre"><span style={{ width: (n / max * 100) + '%' }} /></span>
                <span className="stat-dom-nb">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="stats-bloc">
        <h2 className="stats-titre">À revoir</h2>
        <p className="stats-note">
          <strong>{s.liensSansApercu}</strong> lien{s.liensSansApercu > 1 ? 's' : ''} sans image d'aperçu
          (surtout Twitter / X). Ces sites bloquent la récupération d'une vignette côté navigateur —
          une vraie prévisualisation demanderait un petit serveur. Les cartes restent lisibles (titre + texte).
        </p>
        {s.aRevoir.length === 0 ? (
          <p className="stats-note">Aucune carte vide ou cassée. ✓</p>
        ) : (
          <>
            <p className="stats-note">
              <strong>{s.aRevoir.length}</strong> carte{s.aRevoir.length > 1 ? 's' : ''} vide{s.aRevoir.length > 1 ? 's' : ''}
              {' '}ou dont l'image n'a pas été importée — clique pour l'ouvrir et la corriger ou la supprimer :
            </p>
            <div className="stats-revoir">
              {s.aRevoir.map(c => (
                <button className="revoir-item" key={c.id} onClick={() => onOuvrir({ carte: c })}>
                  <span className="revoir-type">{c.type}</span>
                  <span className="revoir-txt">{(c.titre || c.texte || c.url || '(vide)').slice(0, 70) || '(vide)'}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}

// =================================================================
export default function App() {
  const [modeExt] = useState(() => new URLSearchParams(window.location.search).get('via') === 'ext')
  const [vue, setVue] = useState('tout') // tout | espaces | serendipity
  const [recherche, setRecherche] = useState('')
  const [composeurOuvert, setComposeurOuvert] = useState(false)
  const [ouverte, setOuverte] = useState(null)
  const [capture, setCapture] = useState(lireCapture)
  const [tagActif, setTagActif] = useState(null)
  const [espaceActif, setEspaceActif] = useState(null)
  const [creationEspace, setCreationEspace] = useState(false)
  const [nomEspace, setNomEspace] = useState('')
  const [importOuvert, setImportOuvert] = useState(false)
  const [serenQueue, setSerenQueue] = useState([]) // ids des cartes mises en avant
  const [serenIdx, setSerenIdx] = useState(0)
  const [annulSuppr, setAnnulSuppr] = useState(null) // carte récemment supprimée (bandeau « Annuler »)
  const timerAnnul = useRef(null)
  const nbCol = useNbColonnes()
  const [survolFichier, setSurvolFichier] = useState(false) // un fichier est glissé au-dessus
  const [depotEnCours, setDepotEnCours] = useState(false)   // ajout média en cours
  const [depotMsg, setDepotMsg] = useState(null)            // toast de résultat du dépôt
  const dragCompteur = useRef(0)
  const timerDepot = useRef(null)
  const sync = useSync()

  // Suppression avec fenêtre d'annulation : la carte part en corbeille
  // (récupérable 30 jours) et un bandeau « Annuler » s'affiche ~7 s.
  function demanderSuppression(carte) {
    supprimerCarte(carte.id).then(() => {
      setAnnulSuppr(carte)
      clearTimeout(timerAnnul.current)
      timerAnnul.current = setTimeout(() => setAnnulSuppr(null), 7000)
      sync.planifier()
    })
  }
  function annulerSuppression() {
    const c = annulSuppr
    if (!c) return
    clearTimeout(timerAnnul.current)
    setAnnulSuppr(null)
    restaurerCarte(c.id).then(() => sync.planifier())
  }
  // Restaure une carte depuis la corbeille.
  function restaurerDepuisCorbeille(carte) {
    restaurerCarte(carte.id).then(() => sync.planifier())
  }
  // Supprime définitivement une carte (efface les fichiers Drive tout de suite).
  // Hors-ligne : on marque la carte comme échue → la sync la purgera plus tard.
  function purgerDefinitivement(carte) {
    purgerCarte(carte)
      .then(() => db.cartes.delete(carte.id))
      .catch(() => majCarte(carte.id, { supprimeLe: 1 }))
      .finally(() => sync.planifier())
  }
  function viderCorbeille() {
    if (!corbeille.length) return
    if (!window.confirm(`Vider la corbeille ? ${corbeille.length} carte(s) seront supprimées définitivement.`)) return
    corbeille.forEach(purgerDefinitivement)
  }

  // --- Glisser-déposer de médias (image / vidéo / PDF) dans la fenêtre ---
  function contientFichiers(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files')
  }
  function onDragEnter(e) {
    if (!contientFichiers(e)) return
    e.preventDefault()
    dragCompteur.current++
    setSurvolFichier(true)
  }
  function onDragOver(e) { if (contientFichiers(e)) e.preventDefault() }
  function onDragLeave(e) {
    if (!contientFichiers(e)) return
    dragCompteur.current = Math.max(0, dragCompteur.current - 1)
    if (dragCompteur.current === 0) setSurvolFichier(false)
  }
  function toastDepot(msg) {
    setDepotMsg(msg)
    clearTimeout(timerDepot.current)
    timerDepot.current = setTimeout(() => setDepotMsg(null), 4500)
  }
  async function onDrop(e) {
    if (!contientFichiers(e)) return
    e.preventDefault()
    dragCompteur.current = 0
    setSurvolFichier(false)
    const fichiers = Array.from(e.dataTransfer?.files || [])
    // Fichier de résultats OCR (Apple Vision) → on enrichit les cartes.
    const ocr = fichiers.find(estFichierOcr)
    if (ocr) {
      setDepotEnCours(true)
      let r
      try { r = await injecterOcr(ocr) }
      catch (err) { console.error('[ocr-inject]', err); r = { erreur: 'exception' } }
      finally { setDepotEnCours(false) }
      sync.planifier()
      toastDepot(r?.erreur ? 'Fichier OCR illisible'
        : `OCR v2 — ${r.maj} enrichies · ${r.matchees}/${r.scannees} reconnues`)
      return
    }
    const medias = fichiers.filter(estMediaSupporte)
    if (!medias.length) { toastDepot('Formats acceptés : images, vidéos, PDF.'); return }
    setDepotEnCours(true)
    let ok = 0, besoinDrive = 0
    for (const f of medias) {
      try { (await ajouterMediaDepuisFichier(f)) === 'besoin-drive' ? besoinDrive++ : ok++ }
      catch (err) { console.error('[depot]', err) }
    }
    setDepotEnCours(false)
    sync.planifier()
    let msg = ok ? `${ok} média${ok > 1 ? 's' : ''} ajouté${ok > 1 ? 's' : ''}` : ''
    if (besoinDrive) msg += (msg ? ' · ' : '') + `${besoinDrive} en attente : connecte Google Drive`
    toastDepot(msg || 'Rien ajouté')
  }

  // Capture (bookmarklet / iOS) — création réelle de la carte, une fois.
  const syncRef = useRef(sync.planifier)
  syncRef.current = sync.planifier
  const fermerCapture = useCallback(() => setCapture(null), [])
  useEffect(() => {
    if (!capture) return
    ;(async () => {
      if (capture.type === 'note') {
        await ajouterCarte({ type: 'note', texte: capture.note })
      } else {
        await ajouterCarte({
          type: 'lien', url: capture.url, titre: capture.titre,
          apercu: capture.apercu, texte: capture.note
        })
      }
      window.history.replaceState(null, '', import.meta.env.BASE_URL)
      syncRef.current?.()
      if (capture.popup) setTimeout(() => window.close(), 2200)
    })().catch(e => console.error('[capture]', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Recrée UNE FOIS les 22 spaces « mymind » (listes intelligentes par tag),
  // puis synchronise pour les propager aux autres appareils.
  useEffect(() => {
    semerSpacesMymind().then(n => { if (n) syncRef.current?.() }).catch(() => {})
  }, [])

  // Données : sépare espaces / contenu, calcule les tags. Ce chargement
  // ne dépend PAS de la recherche — il se relance seulement quand la base
  // change (dexie-react-hooks suit la table `cartes`). Le filtrage et la
  // recherche plein-texte sont faits plus bas, en mémoire.
  const base = useLiveQuery(async () => {
    const toutes = await db.cartes.orderBy('creeLe').reverse().toArray()
    const visibles = toutes.filter(c => !c.supprime)
    const espaces = visibles
      .filter(c => c.type === 'espace')
      .sort((a, b) => (a.titre || '').localeCompare(b.titre || ''))
    const contenu = visibles.filter(c => c.type !== 'espace')

    const compte = {}
    contenu.forEach(c => (c.tags || []).forEach(t => { compte[t] = (compte[t] || 0) + 1 }))
    const tags = Object.entries(compte).sort((a, b) => b[1] - a[1]).map(([t]) => t)

    // Corbeille : cartes supprimées (récupérables 30 jours), plus récentes d'abord.
    const corbeille = toutes
      .filter(c => c.supprime && c.type !== 'espace')
      .sort((a, b) => (b.supprimeLe || 0) - (a.supprimeLe || 0))

    // Avancement OCR : combien d'images portent déjà du texte reconnu.
    const imgs = contenu.filter(c => c.type === 'image')
    const ocr = { total: imgs.length, faites: imgs.filter(c => (c.texteImage || '').trim()).length }

    return { tags, espaces, contenu, corbeille, ocr }
  }, [])

  const tousTags = base?.tags || []
  const espaces = base?.espaces || []
  const contenu = useMemo(() => base?.contenu || [], [base])
  const corbeille = base?.corbeille || []
  const ocr = base?.ocr || { total: 0, faites: 0 }

  // Contenu « public » : sans les cartes privées. C'est ce qu'on montre par
  // défaut (accueil, espaces, sérendipité). L'index plein-texte, lui, garde
  // TOUTES les cartes pour que « #private » puisse les retrouver.
  const contenuPublic = useMemo(() => contenu.filter(c => !estPrivee(c)), [contenu])

  // Index plein-texte MiniSearch : reconstruit UNIQUEMENT quand la liste
  // des cartes change (pas à chaque frappe). ~2300 cartes → construction
  // quasi instantanée, gardée en mémoire ensuite.
  const index = useMemo(() => construireIndex(contenu), [contenu])

  // Liste affichée : filtres espace / tag / #tag, puis recherche plein-texte
  // classée par pertinence. Recalculée à chaque frappe, sans reconstruire l'index.
  const cartes = useMemo(() => {
    if (!base) return undefined // encore en chargement → évite un flash « vide »
    const { tags: tagsRech, texte } = analyserRequete(recherche)
    const veutPrive = tagsRech.includes(TAG_PRIVE)
    // Les cartes privées sont cachées PARTOUT, sauf si on cherche « #private ».
    let liste = veutPrive ? contenu : contenuPublic
    if (espaceActif) {
      const esp = espaces.find(e => e.id === espaceActif)
      liste = esp ? membresEspace(esp, liste) : liste
    }
    if (tagActif) liste = liste.filter(c => (c.tags || []).includes(tagActif))
    // Filtres « #tag » explicites : match EXACT du tag (tolérant casse/ponctuation).
    if (tagsRech.length) {
      liste = liste.filter(c => {
        const set = (c.tags || []).map(normTag)
        return tagsRech.every(t => set.includes(t))
      })
    }
    // Le reste de la requête = texte libre → MiniSearch (classé par pertinence).
    const ordre = texte ? rechercher(index, texte) : null
    if (ordre) {
      const rang = new Map(ordre.map((id, i) => [id, i]))
      liste = liste
        .filter(c => rang.has(c.id))
        .sort((a, b) => rang.get(a.id) - rang.get(b.id))
    }
    return liste
  }, [base, contenu, contenuPublic, index, recherche, tagActif, espaceActif, espaces])

  useEffect(() => {
    if (espaceActif && !espaces.some(e => e.id === espaceActif)) setEspaceActif(null)
  }, [espaces, espaceActif])

  // Enrichissement des APERÇUS de liens via le backend (Phase A), une fois par
  // session. Pour chaque carte lien sans aperçu (hors YouTube) et pas encore
  // tentée, on demande au Worker `/preview` une image (og:image) + un texte
  // (tweet). On range le résultat dans la carte : l'image se synchronise partout
  // (champ `apercu`), et on marque la carte « tentée » (local) pour ne pas y
  // revenir. Doux (6 en parallèle, petite pause). Une erreur RÉSEAU n'est pas
  // marquée → on réessaiera (ex. le temps que le certificat du Worker soit prêt).
  const enrichLance = useRef(false)
  useEffect(() => {
    if (modeExt || !API_BASE || enrichLance.current || !contenu.length) return
    enrichLance.current = true
    ;(async () => {
      // Cartes lien à enrichir : aperçu OU titre manquant (YouTube compris : on
      // récupère le titre de la vidéo). `enrichi` = déjà tenté (marqueur local).
      const aFaire = contenu.filter(c =>
        c.type === 'lien' && c.url && !c.enrichi && (!c.apercu || !(c.titre || '').trim()))
      for (let i = 0; i < aFaire.length; i += 6) {
        const lot = aFaire.slice(i, i + 6)
        const updates = []
        let besoinSync = false
        await Promise.all(lot.map(async c => {
          try {
            const r = await fetch(`${API_BASE}/preview?url=${encodeURIComponent(c.url)}`)
            if (!r.ok) return // KO serveur → pas de marquage, on retentera
            const j = await r.json()
            const ch = { enrichi: 1 }
            if (j.image && !c.apercu) { ch.apercu = j.image; besoinSync = true }
            if (j.titre && !(c.titre || '').trim()) { ch.titre = j.titre; besoinSync = true }
            const extrait = j.texte || j.desc   // tweet, ou description (metas) du site
            if (extrait && !(c.texte || '').trim()) { ch.texte = extrait; besoinSync = true }
            if (ch.apercu || ch.titre || ch.texte) ch.modifieLe = Date.now() // change réel → à synchroniser
            updates.push({ key: c.id, changes: ch })
          } catch { /* réseau KO → on retentera plus tard */ }
        }))
        if (updates.length) await db.cartes.bulkUpdate(updates)
        if (besoinSync) syncRef.current?.()
        await new Promise(r => setTimeout(r, 500))
      }
    })().catch(e => console.error('[enrichir-lien]', e))
  }, [contenu, modeExt])

  // Passe à la carte précédente / suivante dans l'ordre affiché (façon mymind).
  // Partagé par les flèches ← → du clavier (desktop) ET le swipe (mobile).
  const naviguer = useCallback(delta => {
    if (!cartes || !cartes.length) return
    setOuverte(o => {
      if (!o) return o
      const i = cartes.findIndex(c => c.id === o.carte.id)
      if (i < 0) return o
      const j = i + delta
      return (j >= 0 && j < cartes.length) ? { carte: cartes[j] } : o
    })
  }, [cartes])

  // Navigation clavier dans la carte ouverte : ← / →. Ignoré quand on tape
  // dans un champ (titre, note, tag) pour ne pas gêner l'édition.
  useEffect(() => {
    if (!ouverte) return
    const surTouche = e => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowRight') { e.preventDefault(); naviguer(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); naviguer(-1) }
    }
    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [ouverte, naviguer])

  async function validerNouvelEspace() {
    const nom = nomEspace.trim()
    setNomEspace(''); setCreationEspace(false)
    if (!nom) return
    const e = await creerEspace(nom)
    setEspaceActif(e.id); setVue('tout')
    sync.planifier()
  }
  function supprimerEspaceActif() {
    const e = espaces.find(x => x.id === espaceActif)
    if (!e) return
    if (!window.confirm(`Supprimer l'espace « ${e.titre} » ? (les cartes ne sont pas supprimées)`)) return
    supprimerEspace(e.id).then(() => { setEspaceActif(null); sync.planifier() })
  }
  function ouvrirEspace(e) { setEspaceActif(e.id); setTagActif(null); setVue('tout') }

  if (modeExt) return <CaptureExt />

  const espaceCourant = espaceActif ? espaces.find(e => e.id === espaceActif) : null

  // Serendipity : tire ~10 cartes au hasard et les met en avant une à une.
  // (Sur le contenu PUBLIC : la sérendipité ne fait jamais surgir de carte privée.)
  function lancerSerendipity() {
    const a = [...contenuPublic]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    setSerenQueue(a.slice(0, 10).map(c => c.id))
    setSerenIdx(0)
    setVue('serendipity')
  }
  // File alignée sur la queue (null si la carte a été oubliée/supprimée),
  // pour que l'index reste stable même après un « Oublier ».
  const serenFile = serenQueue.map(id => contenu.find(c => c.id === id) || null)
  const serenGhosts = contenuPublic.filter(c => !serenQueue.includes(c.id) && (c.image || c.apercu)).slice(0, 6)
  function serenGarder() { setSerenIdx(i => i + 1) }
  function serenOublier() {
    const c = serenFile[serenIdx]
    if (c) supprimerCarte(c.id).then(sync.planifier)
    setSerenIdx(i => i + 1)
  }

  return (
    <div className="app" onDragEnter={onDragEnter} onDragOver={onDragOver}
         onDragLeave={onDragLeave} onDrop={onDrop}>
      {/* ---- Rail gauche ---- */}
      <aside className="rail">
        <div className="rail-orbe" />
        <div className="rail-marque">MonCoffre</div>
        <div className="rail-bas">
          <StatutSync etat={sync.etat} brancher={sync.brancher} lancer={sync.lancer} />
          {API_BASE && !sync.permanent && (
            <button className="rail-bouton rail-permanent" title="Connexion Drive permanente (recommandé) — reste connecté partout, Safari compris"
                    onClick={sync.brancher}>🔒</button>
          )}
          <button className="rail-bouton" title="Statistiques" onClick={() => setVue('stats')}>📊</button>
          <button className="rail-bouton rail-corbeille" title="Corbeille" onClick={() => setVue('corbeille')}>
            🗑{corbeille.length > 0 && <span className="rail-badge">{corbeille.length}</span>}
          </button>
          <button className="rail-bouton" title="Importer depuis mymind" onClick={() => setImportOuvert(true)}>↓↓</button>
          <a className="rail-bouton" href="capturer.html" title="Configurer la capture">⚙</a>
        </div>
      </aside>

      {/* ---- Zone principale ---- */}
      <div className="zone">
        <nav className="nav-haut">
          <button className={'nav-lien' + (vue === 'tout' ? ' actif' : '')}
                  onClick={() => { setVue('tout'); setEspaceActif(null); setTagActif(null); setRecherche('') }}>Tout</button>
          <button className={'nav-lien' + (vue === 'espaces' ? ' actif' : '')}
                  onClick={() => setVue('espaces')}>Espaces</button>
          <button className={'nav-lien' + (vue === 'serendipity' ? ' actif' : '')}
                  onClick={lancerSerendipity}>Serendipity</button>
        </nav>

        {/* ====== VUE TOUT ====== */}
        {vue === 'tout' && (
          <>
            <div className="hero">
              <input
                className="hero-recherche"
                type="search"
                placeholder="Rechercher dans mon coffre…"
                value={recherche}
                onChange={e => setRecherche(e.target.value)}
              />
              {ocr.total > 0 && ocr.faites < ocr.total && (
                <p className="hero-ocr" title="Texte lu dans les images (OCR). Se complète au fil des synchros et de la passe Apple mensuelle.">
                  Reconnaissance du texte des images : {ocr.faites} / {ocr.total}
                  {' '}({Math.round(ocr.faites / ocr.total * 100)} %)
                </p>
              )}
              {ocr.total > 0 && ocr.faites >= ocr.total && (
                <p className="hero-ocr hero-ocr-ok" title="Toutes les images portent du texte reconnu.">
                  ✓ Texte reconnu sur les {ocr.total} images
                </p>
              )}
              {!recherche && (
                <p className="hero-astuce">
                  Astuce : <code>#tag</code> cherche un tag précis (ex. <code>#recipe</code>, <code>#ia</code>) —
                  plutôt que le mot où qu'il soit dans le contenu.
                </p>
              )}
            </div>

            {espaceCourant && (
              <div className="fil-espace">
                <span className="anneau" style={{ borderColor: couleurTag(espaceCourant.titre || 'e') }} />
                <strong>{espaceCourant.titre}</strong>
                <button className="fil-fermer" onClick={() => setEspaceActif(null)}>✕ tout revoir</button>
                <button className="fil-supprimer" onClick={supprimerEspaceActif}>Supprimer l'espace</button>
              </div>
            )}

            {espaces.length > 0 && (
              <div className="barre-tags">
                {espaces.map(e => (
                  <button
                    key={e.id}
                    className={'pastille-tag' + (espaceActif === e.id ? ' actif' : '')}
                    onClick={() => setEspaceActif(espaceActif === e.id ? null : e.id)}
                  >
                    <span className="anneau" style={{ borderColor: couleurTag(e.titre || 'e') }} />{e.titre}
                  </button>
                ))}
              </div>
            )}

            {cartes && cartes.length === 0 && !recherche && !tagActif && !espaceActif && (
              <div className="vide">
                <div className="orbe" />
                <h2>Ton mind est vide. Pour l'instant.</h2>
                <p>Garde une pensée, un lien ou une image avec le bouton +.
                   Connecte Google Drive (à gauche) pour retrouver tes cartes partout.</p>
                <p style={{ marginTop: 18 }}>
                  <a className="lien-config" href="capturer.html">Configurer la capture (Mac &amp; iPhone) →</a>
                </p>
              </div>
            )}
            {cartes && cartes.length === 0 && espaceActif && !recherche && !tagActif && (
              <div className="vide">
                <div className="orbe" />
                <h2>Cet espace est vide.</h2>
                <p>Ouvre une carte et épingle-la à cet espace depuis sa vue détail.</p>
              </div>
            )}
            {cartes && cartes.length === 0 && (recherche || tagActif) && (
              <div className="vide"><h2>Rien trouvé.</h2><p>Essaie un autre mot ou un autre tag.</p></div>
            )}

            <main className="grille-cols">
              {repartirColonnes(cartes || [], nbCol).map((col, i) => (
                <div className="grille-col" key={i}>
                  {col.map(c => (
                    <Carte key={c.id} carte={c}
                           onOuvrir={(carte, src) => setOuverte({ carte, src })} />
                  ))}
                </div>
              ))}
            </main>
          </>
        )}

        {/* ====== VUE ESPACES ====== */}
        {vue === 'espaces' && (
          <>
            <div className="entete-vue">
              <h1 className="titre-serif">Tous les espaces</h1>
              {creationEspace ? (
                <input
                  className="espace-nouveau-champ" autoFocus placeholder="Nom de l'espace…"
                  value={nomEspace} onChange={e => setNomEspace(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') validerNouvelEspace()
                    if (e.key === 'Escape') { setNomEspace(''); setCreationEspace(false) }
                  }}
                  onBlur={validerNouvelEspace}
                />
              ) : (
                <button className="bouton-creer-espace" onClick={() => setCreationEspace(true)}>
                  <span className="anneau" style={{ borderColor: 'hsl(18, 85%, 55%)' }} />Créer un espace
                </button>
              )}
            </div>

            {espaces.length === 0 && (
              <div className="vide">
                <div className="orbe" />
                <h2>Aucun espace pour l'instant.</h2>
                <p>Crée un espace pour regrouper des cartes (projets, idées, envies…),
                   puis épingle des cartes dedans depuis leur vue détail.</p>
              </div>
            )}

            <div className="piles">
              {espaces.map(e => (
                <PileEspace
                  key={e.id}
                  espace={e}
                  membres={membresEspace(e, contenuPublic)}
                  onOuvrir={ouvrirEspace}
                />
              ))}
            </div>
          </>
        )}

        {/* ====== VUE SERENDIPITY ====== */}
        {vue === 'serendipity' && (
          contenuPublic.length === 0 ? (
            <div className="vide"><div className="orbe" /><h2>Rien à redécouvrir encore.</h2>
              <p>Garde quelques cartes, puis reviens ici pour retomber dessus par hasard.</p></div>
          ) : (
            <VueSerendipity
              file={serenFile}
              idx={serenIdx}
              ghosts={serenGhosts}
              onGarder={serenGarder}
              onOublier={serenOublier}
              onRecommencer={lancerSerendipity}
            />
          )
        )}

        {/* ====== VUE CORBEILLE ====== */}
        {vue === 'corbeille' && (
          <>
            <div className="entete-vue">
              <h1 className="titre-serif">Corbeille</h1>
              {corbeille.length > 0 && (
                <button className="bouton-creer-espace" onClick={viderCorbeille}>
                  <span className="anneau" style={{ borderColor: 'hsl(6, 60%, 55%)' }} />Vider la corbeille
                </button>
              )}
            </div>

            {corbeille.length === 0 ? (
              <div className="vide">
                <div className="orbe" />
                <h2>La corbeille est vide.</h2>
                <p>Les cartes supprimées atterrissent ici et restent récupérables
                   pendant 30 jours avant d'être effacées pour de bon.</p>
              </div>
            ) : (
              <>
                <p className="corbeille-note">Les cartes sont conservées 30 jours, puis effacées définitivement (fichiers Drive compris).</p>
                <main className="grille">
                  {corbeille.map(c => (
                    <LigneCorbeille
                      key={c.id}
                      carte={c}
                      duree={DUREE_CORBEILLE}
                      onRestaurer={() => restaurerDepuisCorbeille(c)}
                      onPurger={() => purgerDefinitivement(c)}
                    />
                  ))}
                </main>
              </>
            )}
          </>
        )}

        {/* ====== VUE STATISTIQUES ====== */}
        {vue === 'stats' && (
          <VueStats contenu={contenu} tousTags={tousTags} espaces={espaces} ocr={ocr}
                    onOuvrir={(o) => setOuverte(o)} />
        )}
      </div>

      {/* ---- Bouton + ---- */}
      <button className="ajouter" title="Ajouter" onClick={() => setComposeurOuvert(true)}>+</button>

      {composeurOuvert && <Composeur fermer={() => setComposeurOuvert(false)} onAjout={sync.planifier} tousTags={tousTags} />}
      {importOuvert && (
        <ImportMymind
          pret={['ok', 'pret', 'sync'].includes(sync.etat)}
          brancher={sync.brancher}
          fermer={() => setImportOuvert(false)}
          onModif={sync.planifier}
        />
      )}
      {ouverte && (
        <Detail
          key={ouverte.carte.id}
          carte={ouverte.carte}
          src={ouverte.src}
          espaces={espaces}
          tousTags={tousTags}
          fermer={() => setOuverte(null)}
          onModif={sync.planifier}
          onSupprimer={demanderSuppression}
          onNaviguer={naviguer}
        />
      )}
      {capture && (
        <div className="toast-capture" onClick={fermerCapture} title="Fermer">
          <span className="coche">✓</span>
          <div>
            <strong>Gardé dans MonCoffre</strong>
            <p>{capture.titre || capture.url || capture.note || 'Nouvelle carte'}</p>
          </div>
        </div>
      )}
      {annulSuppr && (
        <div className="toast-annul">
          <span>Carte supprimée</span>
          <button onClick={annulerSuppression}>Annuler</button>
        </div>
      )}
      {(survolFichier || depotEnCours) && (
        <div className="depot-voile">
          <div className="depot-carte">
            <div className="depot-orbe" />
            <strong>{depotEnCours ? 'Ajout au coffre…' : 'Dépose pour ajouter au coffre'}</strong>
            <p>Images · Vidéos · PDF</p>
          </div>
        </div>
      )}
      {depotMsg && (
        <div className="toast-annul depot-toast"><span>{depotMsg}</span></div>
      )}
      {sync.progression && sync.progression.recues < sync.progression.total && (
        <div className="sync-compteur" title="Cartes en cours de téléchargement depuis Google Drive">
          <span className="sync-compteur-point" />
          {sync.progression.recues} / {sync.progression.total}
        </div>
      )}
    </div>
  )
}
