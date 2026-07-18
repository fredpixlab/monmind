import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, ajouterCarte, supprimerCarte, restaurerCarte, majCarte, estUneUrl, creerEspace, supprimerEspace, basculerEpingle, membresEspace, semerSpacesMymind, DUREE_CORBEILLE } from './db.js'
import { construireIndex, rechercher } from './recherche.js'
import { ajouterMediaDepuisFichier, estMediaSupporte, estFichierOcr, injecterOcr, ocrEnFond } from './ajout-media.js'
import { sync_configuree } from './config.js'
import { initAuth, connecter, estDejaConnecte, deconnecter, synchroniser, BesoinReconnexion, telechargerMediaComplet, rafraichirJeton, purgerCarte } from './drive.js'
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
  useEffect(() => {
    const blob = carte?.image || carte?.vignette
    if (blob) {
      const u = URL.createObjectURL(blob)
      setSrc(u)
      return () => URL.revokeObjectURL(u)
    } else {
      setSrc(null)
    }
  }, [carte?.image, carte?.vignette])
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

// --- Une carte dans la mosaïque ----------------------------------
function Carte({ carte, onOuvrir, onModif, onSupprimer }) {
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
            <p className="texte note-serif">{carte.texte}</p>
          </div>
        )}

        <button
          className="supprimer"
          title="Supprimer"
          onClick={e => { e.stopPropagation(); onSupprimer ? onSupprimer(carte) : supprimerCarte(carte.id).then(onModif) }}
        >×</button>
      </article>
      {legende && <p className="legende">{legende}</p>}
    </div>
  )
}

// --- Vue DÉTAIL plein écran (façon mymind) -----------------------
function Detail({ carte, src, espaces = [], tousTags = [], fermer, onModif, onSupprimer }) {
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
  const [videoSrc, setVideoSrc] = useState(null)     // vidéo complète (depuis Drive)
  const [chargeMedia, setChargeMedia] = useState(false)
  const [videoErreur, setVideoErreur] = useState(false)
  const videoRef = useRef(null)

  // Image affichée : la complète si chargée, sinon la vignette / l'aperçu.
  const image = pleinSrc || src || (carte.type === 'lien' ? (carte.apercu || apercuLien(carte.url)) : null)
  const aMediaDrive = !!carte.driveMediaId

  useEffect(() => {
    const surTouche = e => { if (e.key === 'Escape') fermer() }
    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [fermer])

  // Média « à la demande » : pour une image importée, on va chercher le
  // fichier complet dans Drive dès l'ouverture (la vignette s'affiche en
  // attendant). Pour une vidéo, on attend le clic « lecture ».
  useEffect(() => {
    let vivant = true, url = null
    if (carte.distant && carte.type === 'image' && carte.driveMediaId) {
      telechargerMediaComplet(carte.driveMediaId)
        .then(b => { if (!vivant) return; url = URL.createObjectURL(b); setPleinSrc(url) })
        .catch(() => {})
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
    <div className="detail-voile" style={{ background: fond }} onClick={fermer}>
      <button className="detail-fermer" title="Fermer" onClick={fermer}>×</button>

      <div className="detail-scene" onClick={e => e.stopPropagation()}>
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
              {image && <img className="dc-image" src={image} alt=""
                             onError={e => { e.currentTarget.style.display = 'none' }} />}
              {carte.texte && <div className="dc-texte">{carte.texte}</div>}
            </div>
          )}
          {carte.type === 'image' && image && (
            <img className="dc-image-nue" src={image} alt={carte.texte || 'Image'} />
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
              <p className="dc-note-texte">{carte.texte}</p>
            </div>
          )}
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
function Composeur({ fermer, onAjout }) {
  const [texte, setTexte] = useState('')
  const [image, setImage] = useState(null)
  const [apercu, setApercu] = useState(null)
  const fichierRef = useRef(null)
  const zoneRef = useRef(null)

  useEffect(() => { zoneRef.current?.focus() }, [])

  function choisirImage(fichier) {
    if (!fichier?.type.startsWith('image/')) return
    setImage(fichier)
    setApercu(URL.createObjectURL(fichier))
  }
  function surCollage(e) {
    const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); choisirImage(item.getAsFile()) }
  }
  async function enregistrer() {
    const propre = texte.trim()
    if (!propre && !image) return
    if (image) {
      const c = await ajouterCarte({ type: 'image', image, texte: propre })
      ocrEnFond(c.id, image)
    } else if (estUneUrl(propre)) {
      await ajouterCarte({ type: 'lien', url: propre, titre: '' })
    } else {
      await ajouterCarte({ type: 'note', texte: propre })
    }
    onAjout?.()
    fermer()
  }

  return (
    <div className="voile" onClick={e => { if (e.target === e.currentTarget) fermer() }}>
      <div className="composeur">
        <textarea
          ref={zoneRef}
          placeholder="Une pensée, un lien, une image collée…"
          value={texte}
          onChange={e => setTexte(e.target.value)}
          onPaste={surCollage}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) enregistrer()
            if (e.key === 'Escape') fermer()
          }}
        />
        {apercu && <img className="apercu-image" src={apercu} alt="Aperçu" />}
        <div className="actions">
          <button className="bouton-second" onClick={() => fichierRef.current.click()}>
            Photo / image
          </button>
          <input
            ref={fichierRef} type="file" accept="image/*" hidden
            onChange={e => choisirImage(e.target.files[0])}
          />
          <button
            className="bouton-principal"
            disabled={!texte.trim() && !image}
            onClick={enregistrer}
          >Garder</button>
        </div>
      </div>
    </div>
  )
}

// --- Synchronisation Drive ---------------------------------------
function useSync() {
  const [etat, setEtat] = useState('inconnu')
  const timer = useRef(null)

  const lancer = useCallback(async () => {
    if (!sync_configuree()) return
    setEtat('sync')
    try {
      await synchroniser()
      setEtat('ok')
    } catch (e) {
      console.error('[sync]', e)
      if (e instanceof BesoinReconnexion || e?.name === 'BesoinReconnexion') {
        await deconnecter().catch(() => {})
        setEtat('deconnecte')
      } else {
        setEtat('erreur')
      }
    }
  }, [])

  const planifier = useCallback(() => {
    if (!sync_configuree()) return
    clearTimeout(timer.current)
    timer.current = setTimeout(lancer, 1500)
  }, [lancer])

  useEffect(() => {
    if (!sync_configuree()) { setEtat('non_configure'); return }
    (async () => {
      await initAuth()
      if (await estDejaConnecte()) { setEtat('pret'); lancer() }
      else setEtat('deconnecte')
    })().catch(e => { console.error(e); setEtat('erreur') })

    // Garde le jeton frais en tâche de fond (toutes les 2 min) pour qu'aucun
    // rafraîchissement Google n'apparaisse pendant l'ouverture d'une carte.
    const gardeJeton = setInterval(() => { rafraichirJeton().catch(() => {}) }, 120000)
    const intervalle = setInterval(lancer, 60000)
    const surFocus = () => lancer()
    window.addEventListener('focus', surFocus)
    return () => { clearInterval(intervalle); clearInterval(gardeJeton); window.removeEventListener('focus', surFocus) }
  }, [lancer])

  const brancher = useCallback(async () => {
    try { await connecter(); setEtat('pret'); lancer() }
    catch (e) { console.error(e); setEtat('erreur') }
  }, [lancer])

  return { etat, brancher, planifier, lancer }
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

    return { tags, espaces, contenu, corbeille }
  }, [])

  const tousTags = base?.tags || []
  const espaces = base?.espaces || []
  const contenu = useMemo(() => base?.contenu || [], [base])
  const corbeille = base?.corbeille || []

  // Index plein-texte MiniSearch : reconstruit UNIQUEMENT quand la liste
  // des cartes change (pas à chaque frappe). ~2300 cartes → construction
  // quasi instantanée, gardée en mémoire ensuite.
  const index = useMemo(() => construireIndex(contenu), [contenu])

  // Liste affichée : filtres espace/tag, puis recherche plein-texte classée
  // par pertinence. Recalculée à chaque frappe, mais sans reconstruire l'index.
  const cartes = useMemo(() => {
    if (!base) return undefined // encore en chargement → évite un flash « vide »
    let liste = contenu
    if (espaceActif) {
      const esp = espaces.find(e => e.id === espaceActif)
      liste = esp ? membresEspace(esp, liste) : liste
    }
    if (tagActif) liste = liste.filter(c => (c.tags || []).includes(tagActif))
    const ordre = rechercher(index, recherche)
    if (ordre) {
      const rang = new Map(ordre.map((id, i) => [id, i]))
      liste = liste
        .filter(c => rang.has(c.id))
        .sort((a, b) => rang.get(a.id) - rang.get(b.id))
    }
    return liste
  }, [base, contenu, index, recherche, tagActif, espaceActif])

  useEffect(() => {
    if (espaceActif && !espaces.some(e => e.id === espaceActif)) setEspaceActif(null)
  }, [espaces, espaceActif])

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
  function lancerSerendipity() {
    const a = [...contenu]
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
  const serenGhosts = contenu.filter(c => !serenQueue.includes(c.id) && (c.image || c.apercu)).slice(0, 6)
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
                           onOuvrir={(carte, src) => setOuverte({ carte, src })}
                           onModif={sync.planifier}
                           onSupprimer={demanderSuppression} />
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
                  membres={membresEspace(e, contenu)}
                  onOuvrir={ouvrirEspace}
                />
              ))}
            </div>
          </>
        )}

        {/* ====== VUE SERENDIPITY ====== */}
        {vue === 'serendipity' && (
          contenu.length === 0 ? (
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
      </div>

      {/* ---- Bouton + ---- */}
      <button className="ajouter" title="Ajouter" onClick={() => setComposeurOuvert(true)}>+</button>

      {composeurOuvert && <Composeur fermer={() => setComposeurOuvert(false)} onAjout={sync.planifier} />}
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
    </div>
  )
}
