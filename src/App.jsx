import { useState, useRef, useEffect, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, ajouterCarte, supprimerCarte, majCarte, estUneUrl, creerEspace, supprimerEspace, basculerEpingle } from './db.js'
import { sync_configuree } from './config.js'
import { initAuth, connecter, estDejaConnecte, deconnecter, synchroniser, BesoinReconnexion } from './drive.js'

// ---------------------------------------------------------------
// MonMind — Phase 3 : squelette + cartes locales + sync Google Drive.
// Les cartes vivent dans IndexedDB (voir db.js) et se synchronisent
// avec ton dossier Google Drive (voir drive.js). Tags IA en Phase 5.
// ---------------------------------------------------------------

function domaineDe(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

// --- Capture depuis l'extension navigateur -----------------------
// L'extension ouvre l'app avec ?via=ext puis, via son pont (bridge.js),
// envoie le contenu lisible de la page par postMessage. On écoute ça
// dès le chargement du module (avant même le montage de React).
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

// Crée une carte-lien à partir d'une capture (extension, bookmarklet…).
function creerCarteLien(cap) {
  return ajouterCarte({
    type: 'lien',
    url: cap.url || '',
    titre: (cap.titre || '').trim(),
    apercu: cap.image || '',
    texte: (cap.texte || cap.selection || '').trim() // contenu lisible de la page
  })
}

function Carte({ carte, onOuvrir, onModif }) {
  // Pour les images stockées en Blob, on fabrique une URL d'affichage
  // (et on la libère quand la carte disparaît de l'écran).
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (carte.image) {
      const u = URL.createObjectURL(carte.image)
      setSrc(u)
      return () => URL.revokeObjectURL(u)
    }
  }, [carte.image])

  const date = new Date(carte.creeLe).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'short'
  })

  // Cliquer une carte ouvre sa vue détail (contenu, tags, note).
  function surClic() {
    onOuvrir(carte, src)
  }

  return (
    <article className="carte cliquable" onClick={surClic}>
      {carte.type === 'lien' && !carte.apercu && <div className="accent-lien" />}
      {carte.type === 'lien' && carte.apercu && (
        <img className="apercu-lien" src={carte.apercu} alt="" loading="lazy"
             onError={e => { e.currentTarget.style.display = 'none' }} />
      )}
      {src && <img src={src} alt={carte.texte || 'Image sauvegardée'} />}
      {(carte.type !== 'image' || carte.texte) && (
        <div className="contenu">
          {carte.type === 'lien' ? (
            <>
              <p className="lien-titre">{carte.titre || carte.url}</p>
              <p className="lien-domaine">{domaineDe(carte.url)}</p>
              {carte.texte && <p className="texte lien-extrait">{carte.texte}</p>}
            </>
          ) : (
            carte.texte && <p className="texte">{carte.texte}</p>
          )}
          {carte.tags && carte.tags.length > 0 && (
            <div className="carte-tags">
              {carte.tags.slice(0, 4).map(t => <span key={t} className="mini-tag">{t}</span>)}
            </div>
          )}
          <p className="date">{date}</p>
        </div>
      )}
      <button
        className="supprimer"
        title="Supprimer"
        onClick={e => { e.stopPropagation(); supprimerCarte(carte.id).then(onModif) }}
      >×</button>
    </article>
  )
}

// Vue DÉTAIL d'une carte : contenu (image / article), tags éditables,
// et une note personnelle. Façon panneau de détail de mymind.
function Detail({ carte, src, espaces = [], fermer, onModif }) {
  const [tags, setTags] = useState(carte.tags || [])
  const [nouveauTag, setNouveauTag] = useState('')
  const [mesEspaces, setMesEspaces] = useState(carte.espaces || [])
  // Pour une carte-note, la « note » édite son texte ; sinon un champ à part.
  const champNote = carte.type === 'note' ? 'texte' : 'note'
  const [note, setNote] = useState(carte[champNote] || '')

  useEffect(() => {
    const surTouche = e => { if (e.key === 'Escape') fermer() }
    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [fermer])

  function ajouterTag() {
    const t = nouveauTag.trim().toLowerCase()
    setNouveauTag('')
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
  function basculerEspace(espaceId) {
    const epingler = !mesEspaces.includes(espaceId)
    basculerEpingle({ ...carte, espaces: mesEspaces }, espaceId, epingler)
      .then(maj => { setMesEspaces(maj); onModif() })
  }

  const image = src || (carte.type === 'lien' ? carte.apercu : null)

  return (
    <div className="voile-visionneuse" onClick={fermer}>
      <button className="fermer-visionneuse" title="Fermer" onClick={fermer}>×</button>
      <div className="cadre-detail" onClick={e => e.stopPropagation()}>
        {/* --- Contenu --- */}
        {carte.type === 'lien' && (
          <>
            {carte.titre && <h1 className="detail-titre">{carte.titre}</h1>}
            {carte.url && (
              <a className="lecture-source" href={carte.url} target="_blank" rel="noreferrer">
                {domaineDe(carte.url)} ↗
              </a>
            )}
            {image && <img className="detail-image" src={image} alt=""
                           onError={e => { e.currentTarget.style.display = 'none' }} />}
            {carte.texte && <div className="lecture-texte">{carte.texte}</div>}
          </>
        )}
        {carte.type === 'image' && src && (
          <img className="detail-image" src={src} alt={carte.texte || 'Image'} />
        )}

        {/* --- Tags --- */}
        <div className="detail-section">
          <div className="detail-label">Tags</div>
          <div className="tags-editeur">
            {tags.map(t => (
              <span key={t} className="tag-chip">
                {t}
                <button title="Retirer" onClick={() => retirerTag(t)}>×</button>
              </span>
            ))}
            <input
              className="tag-input"
              placeholder="+ tag"
              value={nouveauTag}
              onChange={e => setNouveauTag(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); ajouterTag() } }}
              onBlur={ajouterTag}
            />
          </div>
        </div>

        {/* --- Note --- */}
        <div className="detail-section">
          <div className="detail-label">{carte.type === 'note' ? 'Note' : 'Ta note'}</div>
          <textarea
            className="note-editeur"
            placeholder="Écris une note…"
            value={note}
            onChange={e => setNote(e.target.value)}
            onBlur={sauverNote}
          />
        </div>

        {/* --- Espaces (épinglage manuel) --- */}
        {espaces.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">Espaces</div>
            <div className="espaces-editeur">
              {espaces.map(e => (
                <button
                  key={e.id}
                  className={'espace-toggle' + (mesEspaces.includes(e.id) ? ' actif' : '')}
                  onClick={() => basculerEspace(e.id)}
                >
                  {mesEspaces.includes(e.id) ? '✓ ' : '+ '}{e.titre}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

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

  // Coller une image directement dans le composeur (Cmd+V)
  function surCollage(e) {
    const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); choisirImage(item.getAsFile()) }
  }

  async function enregistrer() {
    const propre = texte.trim()
    if (!propre && !image) return
    if (image) {
      await ajouterCarte({ type: 'image', image, texte: propre })
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

// Petit crochet qui gère toute la synchronisation Drive.
function useSync() {
  const [etat, setEtat] = useState('inconnu') // inconnu | deconnecte | pret | sync | ok | erreur
  const timer = useRef(null)

  const lancer = useCallback(async () => {
    if (!sync_configuree()) return
    setEtat('sync')
    try {
      await synchroniser()
      setEtat('ok')
    } catch (e) {
      console.error('[sync]', e)
      // Jeton perdu / non renouvelable en silence → on réaffiche le
      // bouton « Connecter » au lieu de rester bloqué sur « Sync… ».
      if (e instanceof BesoinReconnexion || e?.name === 'BesoinReconnexion') {
        await deconnecter().catch(() => {})
        setEtat('deconnecte')
      } else {
        setEtat('erreur')
      }
    }
  }, [])

  // Planifie une sync (anti-rebond) après une modification locale.
  const planifier = useCallback(() => {
    if (!sync_configuree()) return
    clearTimeout(timer.current)
    timer.current = setTimeout(lancer, 1500)
  }, [lancer])

  // Au démarrage : si déjà connecté, on initialise et on synchronise.
  useEffect(() => {
    if (!sync_configuree()) { setEtat('non_configure'); return }
    (async () => {
      await initAuth()
      if (await estDejaConnecte()) { setEtat('pret'); lancer() }
      else setEtat('deconnecte')
    })().catch(e => { console.error(e); setEtat('erreur') })

    // Sync périodique + à chaque retour sur l'onglet
    const intervalle = setInterval(lancer, 60000)
    const surFocus = () => lancer()
    window.addEventListener('focus', surFocus)
    return () => { clearInterval(intervalle); window.removeEventListener('focus', surFocus) }
  }, [lancer])

  const brancher = useCallback(async () => {
    try { await connecter(); setEtat('pret'); lancer() }
    catch (e) { console.error(e); setEtat('erreur') }
  }, [lancer])

  return { etat, brancher, planifier, lancer }
}

function StatutSync({ etat, brancher, lancer }) {
  if (etat === 'non_configure') return <span className="statut-sync">Local — Drive bientôt</span>
  if (etat === 'deconnecte' || etat === 'inconnu')
    return <button className="bouton-drive" onClick={brancher}>Connecter Google Drive</button>
  const libelle = { sync: 'Synchronisation…', ok: 'Synchronisé ✓', pret: 'Synchronisé ✓', erreur: 'Erreur de sync' }[etat] || ''
  return (
    <button className="statut-sync cliquable-sync" title="Synchroniser maintenant" onClick={lancer}>
      {etat === 'sync' && <span className="point-sync" />}{libelle}
    </button>
  )
}

// Capture externe : l'app est ouverte avec des paramètres d'URL
// (?c=1&type=lien&url=…&titre=…&img=…&note=…) par le bookmarklet Mac ou
// le Raccourci iOS. On crée la carte, on synchronise, et on confirme.
// Lit les paramètres de capture depuis l'URL, une fois, au démarrage.
// (?c=1&type=…&url=…&titre=…&img=…&note=…) — bookmarklet Mac / Raccourci iOS.
function lireCapture() {
  const p = new URLSearchParams(window.location.search)
  if (!p.get('c')) return null
  if (p.get('via') === 'ext') return null // géré par le mode extension
  return {
    type: p.get('type') === 'note' ? 'note' : 'lien',
    url: p.get('url') || '',
    titre: (p.get('titre') || '').trim(),
    apercu: p.get('img') || '',
    note: (p.get('note') || '').trim(),
    popup: p.get('popup') === '1'
  }
}

// Vue dédiée affichée dans la petite fenêtre ouverte par l'extension :
// reçoit le contenu de la page, crée la carte, confirme. La fenêtre est
// refermée par l'extension au bout de quelques secondes.
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
          <h2>Gardé dans MonMind ✓</h2>
          <p className="ce-titre">{carte.titre || carte.url}</p>
        </>
      )}
      {erreur && <p className="ce-etat">Impossible de garder cette page.</p>}
    </div>
  )
}

export default function App() {
  const [modeExt] = useState(() => new URLSearchParams(window.location.search).get('via') === 'ext')
  const [recherche, setRecherche] = useState('')
  const [composeurOuvert, setComposeurOuvert] = useState(false)
  const [ouverte, setOuverte] = useState(null) // { carte, src } pour la visionneuse
  // Capture lue SYNCHRONIQUEMENT à l'init (garantit que la confirmation
  // s'affiche dès le premier rendu, contrairement à un setState async).
  const [capture, setCapture] = useState(lireCapture)
  const sync = useSync()

  // Crée réellement la carte à partir des paramètres de capture (une fois).
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
      // Ouverte en petite fenêtre par le bookmarklet : on referme la
      // fenêtre après avoir montré la confirmation (l'utilisateur reste
      // sur sa page). Sinon (onglet iOS), la confirmation se ferme au clic.
      if (capture.popup) setTimeout(() => window.close(), 2200)
    })().catch(e => console.error('[capture]', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [tagActif, setTagActif] = useState(null)
  const [espaceActif, setEspaceActif] = useState(null) // id d'un espace, ou null (Tout)

  // useLiveQuery : la grille se met à jour toute seule dès que la base
  // change. On sépare les espaces (cartes de type 'espace') des cartes de
  // contenu, on calcule la liste des tags, et on filtre la grille par
  // espace + tag + recherche.
  const donnees = useLiveQuery(async () => {
    const toutes = await db.cartes.orderBy('creeLe').reverse().toArray()
    const visibles = toutes.filter(c => !c.supprime)
    const espaces = visibles
      .filter(c => c.type === 'espace')
      .sort((a, b) => (a.titre || '').localeCompare(b.titre || ''))
    const contenu = visibles.filter(c => c.type !== 'espace')

    const compte = {}
    contenu.forEach(c => (c.tags || []).forEach(t => { compte[t] = (compte[t] || 0) + 1 }))
    const tags = Object.entries(compte).sort((a, b) => b[1] - a[1]).map(([t]) => t)

    let liste = contenu
    if (espaceActif) liste = liste.filter(c => (c.espaces || []).includes(espaceActif))
    if (tagActif) liste = liste.filter(c => (c.tags || []).includes(tagActif))
    const q = recherche.trim().toLowerCase()
    if (q) liste = liste.filter(c =>
      (c.texte || '').toLowerCase().includes(q) ||
      (c.titre || '').toLowerCase().includes(q) ||
      (c.url || '').toLowerCase().includes(q) ||
      (c.note || '').toLowerCase().includes(q) ||
      (c.tags || []).some(t => t.includes(q))
    )
    return { liste, tags, espaces }
  }, [recherche, tagActif, espaceActif])
  const cartes = donnees?.liste
  const tousTags = donnees?.tags || []
  const espaces = donnees?.espaces || []

  // Si l'espace actif est supprimé ailleurs, on revient sur « Tout ».
  useEffect(() => {
    if (espaceActif && !espaces.some(e => e.id === espaceActif)) setEspaceActif(null)
  }, [espaces, espaceActif])

  const [creationEspace, setCreationEspace] = useState(false)
  const [nomEspace, setNomEspace] = useState('')

  async function validerNouvelEspace() {
    const nom = nomEspace.trim()
    setNomEspace('')
    setCreationEspace(false)
    if (!nom) return
    const e = await creerEspace(nom)
    setEspaceActif(e.id)
    sync.planifier()
  }

  function supprimerEspaceActif() {
    const e = espaces.find(x => x.id === espaceActif)
    if (!e) return
    if (!window.confirm(`Supprimer l'espace « ${e.titre} » ? (les cartes ne sont pas supprimées)`)) return
    supprimerEspace(e.id).then(() => { setEspaceActif(null); sync.planifier() })
  }

  // Mode extension : petite fenêtre de capture dédiée (pas la grille).
  if (modeExt) return <CaptureExt />

  return (
    <>
      <header className="barre">
        <div className="logo"><span className="pastille" />MonMind</div>
        <input
          className="recherche"
          type="search"
          placeholder="Rechercher dans ton mind…"
          value={recherche}
          onChange={e => setRecherche(e.target.value)}
        />
        <StatutSync etat={sync.etat} brancher={sync.brancher} lancer={sync.lancer} />
      </header>

      <nav className="barre-espaces">
        <button
          className={'espace-onglet' + (espaceActif === null ? ' actif' : '')}
          onClick={() => setEspaceActif(null)}
        >Tout</button>
        {espaces.map(e => (
          <button
            key={e.id}
            className={'espace-onglet' + (espaceActif === e.id ? ' actif' : '')}
            onClick={() => setEspaceActif(e.id)}
          >{e.titre}</button>
        ))}
        {creationEspace ? (
          <input
            className="espace-nouveau-champ"
            autoFocus
            placeholder="Nom de l'espace…"
            value={nomEspace}
            onChange={e => setNomEspace(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') validerNouvelEspace()
              if (e.key === 'Escape') { setNomEspace(''); setCreationEspace(false) }
            }}
            onBlur={validerNouvelEspace}
          />
        ) : (
          <button className="espace-onglet espace-ajouter" onClick={() => setCreationEspace(true)}>
            ＋ Espace
          </button>
        )}
        {espaceActif && (
          <button className="espace-supprimer" title="Supprimer cet espace" onClick={supprimerEspaceActif}>
            Supprimer l'espace
          </button>
        )}
      </nav>

      {tousTags.length > 0 && (
        <div className="barre-tags">
          {tousTags.map(t => (
            <button
              key={t}
              className={'pastille-tag' + (tagActif === t ? ' actif' : '')}
              onClick={() => setTagActif(tagActif === t ? null : t)}
            >{t}</button>
          ))}
        </div>
      )}

      {cartes && cartes.length === 0 && !recherche && !tagActif && !espaceActif && (
        <div className="vide">
          <div className="orbe" />
          <h2>Ton mind est vide. Pour l'instant.</h2>
          <p>
            Garde une pensée, un lien ou une image avec le bouton +.
            Connecte Google Drive en haut à droite pour retrouver tes
            cartes sur tous tes appareils.
          </p>
          <p style={{ marginTop: 18 }}>
            <a className="lien-config" href="capturer.html">
              Configurer la capture (Mac & iPhone) →
            </a>
          </p>
        </div>
      )}

      {cartes && cartes.length === 0 && espaceActif && !recherche && !tagActif && (
        <div className="vide">
          <div className="orbe" />
          <h2>Cet espace est vide.</h2>
          <p>
            Ouvre une carte et épingle-la à cet espace depuis sa vue détail
            (section « Espaces »).
          </p>
        </div>
      )}

      <main className="grille">
        {cartes?.map(c => (
          <Carte
            key={c.id}
            carte={c}
            onOuvrir={(carte, src) => setOuverte({ carte, src })}
            onModif={sync.planifier}
          />
        ))}
      </main>

      <button className="ajouter" title="Ajouter" onClick={() => setComposeurOuvert(true)}>+</button>
      {composeurOuvert && (
        <Composeur fermer={() => setComposeurOuvert(false)} onAjout={sync.planifier} />
      )}
      {ouverte && (
        <Detail
          key={ouverte.carte.id}
          carte={ouverte.carte}
          src={ouverte.src}
          espaces={espaces}
          fermer={() => setOuverte(null)}
          onModif={sync.planifier}
        />
      )}
      {capture && (
        <div className="toast-capture" onClick={fermerCapture} title="Fermer">
          <span className="coche">✓</span>
          <div>
            <strong>Gardé dans MonMind</strong>
            <p>{capture.titre || capture.url || capture.note || 'Nouvelle carte'}</p>
          </div>
        </div>
      )}
    </>
  )
}
