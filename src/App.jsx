import { useState, useRef, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, ajouterCarte, supprimerCarte, estUneUrl } from './db.js'

// ---------------------------------------------------------------
// MonMind — Phase 1/2 : squelette installable + cartes locales.
// Les cartes vivent dans IndexedDB (voir db.js). La sync Google
// Drive arrivera en Phase 3, les tags IA en Phase 5.
// ---------------------------------------------------------------

function domaineDe(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function Carte({ carte, onOuvrir }) {
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

  // Cliquer une carte : un lien s'ouvre dans un nouvel onglet ;
  // une image ou une note s'ouvre en grand dans la visionneuse.
  function surClic() {
    if (carte.type === 'lien') {
      window.open(carte.url, '_blank', 'noopener')
    } else {
      onOuvrir(carte, src)
    }
  }

  return (
    <article className="carte cliquable" onClick={surClic}>
      {carte.type === 'lien' && <div className="accent-lien" />}
      {src && <img src={src} alt={carte.texte || 'Image sauvegardée'} />}
      {(carte.type !== 'image' || carte.texte) && (
        <div className="contenu">
          {carte.type === 'lien' ? (
            <>
              <p className="lien-titre">{carte.titre || carte.url}</p>
              <p className="lien-domaine">{domaineDe(carte.url)}</p>
            </>
          ) : (
            carte.texte && <p className="texte">{carte.texte}</p>
          )}
          <p className="date">{date}</p>
        </div>
      )}
      <button
        className="supprimer"
        title="Supprimer"
        onClick={e => { e.stopPropagation(); supprimerCarte(carte.id) }}
      >×</button>
    </article>
  )
}

// La visionneuse plein écran (lightbox) pour images et notes.
function Visionneuse({ carte, src, fermer }) {
  useEffect(() => {
    const surTouche = e => { if (e.key === 'Escape') fermer() }
    window.addEventListener('keydown', surTouche)
    return () => window.removeEventListener('keydown', surTouche)
  }, [fermer])

  return (
    <div className="voile-visionneuse" onClick={fermer}>
      <button className="fermer-visionneuse" title="Fermer" onClick={fermer}>×</button>
      <div className="cadre-visionneuse" onClick={e => e.stopPropagation()}>
        {src && <img src={src} alt={carte.texte || 'Image'} />}
        {carte.texte && <p className="legende-visionneuse">{carte.texte}</p>}
      </div>
    </div>
  )
}

function Composeur({ fermer }) {
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

export default function App() {
  const [recherche, setRecherche] = useState('')
  const [composeurOuvert, setComposeurOuvert] = useState(false)
  const [ouverte, setOuverte] = useState(null) // { carte, src } pour la visionneuse

  // useLiveQuery : la grille se met à jour toute seule dès que la
  // base locale change (ajout, suppression…).
  const cartes = useLiveQuery(async () => {
    const toutes = await db.cartes.orderBy('creeLe').reverse().toArray()
    const q = recherche.trim().toLowerCase()
    if (!q) return toutes
    return toutes.filter(c =>
      (c.texte || '').toLowerCase().includes(q) ||
      (c.titre || '').toLowerCase().includes(q) ||
      (c.url || '').toLowerCase().includes(q)
    )
  }, [recherche])

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
        <span className="statut-sync">Local · sync Drive en Phase 3</span>
      </header>

      {cartes && cartes.length === 0 && !recherche && (
        <div className="vide">
          <div className="orbe" />
          <h2>Ton mind est vide. Pour l'instant.</h2>
          <p>
            Garde une pensée, un lien ou une image avec le bouton +.
            Tout reste sur cet appareil — la synchronisation entre tes
            appareils arrive en Phase 3.
          </p>
        </div>
      )}

      <main className="grille">
        {cartes?.map(c => (
          <Carte key={c.id} carte={c} onOuvrir={(carte, src) => setOuverte({ carte, src })} />
        ))}
      </main>

      <button className="ajouter" title="Ajouter" onClick={() => setComposeurOuvert(true)}>+</button>
      {composeurOuvert && <Composeur fermer={() => setComposeurOuvert(false)} />}
      {ouverte && (
        <Visionneuse carte={ouverte.carte} src={ouverte.src} fermer={() => setOuverte(null)} />
      )}
    </>
  )
}
