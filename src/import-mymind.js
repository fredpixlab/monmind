// ==================================================================
// MonMind — import depuis un export mymind (« Export my mind »).
//
// L'export mymind est un dossier contenant `cards.csv` (une ligne par
// carte) + les fichiers média (images, vidéos, PDF) nommés d'après l'id
// de la carte. Ce module s'occupe UNIQUEMENT du CSV → cartes MonMind.
// Le rattachement des fichiers et l'upload sont gérés ailleurs.
//
// Colonnes du CSV : id,type,title,url,content,note,tags,created
// ==================================================================

// --- Parseur CSV robuste (RFC 4180 : gère guillemets, virgules et
//     retours à la ligne à l'intérieur des champs). ---------------
export function parserCSV(texte) {
  // Retire un éventuel BOM.
  if (texte.charCodeAt(0) === 0xfeff) texte = texte.slice(1)
  const lignes = []
  let champ = '', ligne = [], dansGuillemets = false
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i]
    if (dansGuillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { champ += '"'; i++ }
        else dansGuillemets = false
      } else champ += c
    } else {
      if (c === '"') dansGuillemets = true
      else if (c === ',') { ligne.push(champ); champ = '' }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { ligne.push(champ); lignes.push(ligne); ligne = []; champ = '' }
      else champ += c
    }
  }
  // Dernière ligne éventuelle sans \n final.
  if (champ.length || ligne.length) { ligne.push(champ); lignes.push(ligne) }
  if (!lignes.length) return []
  const entetes = lignes[0].map(h => h.trim())
  return lignes.slice(1)
    .filter(l => l.length && l.some(v => v !== ''))
    .map(l => Object.fromEntries(entetes.map((h, i) => [h, l[i] ?? ''])))
}

// --- Correspondance des types mymind → types MonMind ------------
// Notes / citations / surlignages → carte 'note'
const TYPES_NOTE = new Set(['Note', 'Content', 'Quotation'])
// Ces types portent un média téléchargé dans le dossier de l'export.
const TYPE_IMAGE = 'Image'
const TYPE_VIDEO = 'Video'
// Tout le reste (avec une URL) → carte 'lien'.

// Nettoie et dédoublonne les tags (insensible à la casse, minuscules
// pour rester cohérent avec les tags saisis à la main dans l'app).
export function normaliserTags(brut) {
  const vus = new Set()
  const out = []
  for (let t of (brut || '').split(',')) {
    t = t.trim().toLowerCase()
    if (t && !vus.has(t)) { vus.add(t); out.push(t) }
  }
  return out
}

// Transforme une ligne du CSV en carte MonMind (ou null si à ignorer).
// `besoinAsset` indique qu'un fichier média doit être rattaché ensuite ;
// `sourceId` est l'id mymind, utilisé pour retrouver le fichier.
export function mapperLigne(row) {
  const type = (row.type || '').trim()
  if (type === 'Placeholder') return null

  const titre = (row.title || '').trim()
  const url = (row.url || '').trim()
  const contenu = (row.content || '').trim()
  const note = (row.note || '').trim()
  const tags = normaliserTags(row.tags)
  const t = Date.parse(row.created)
  const creeLe = Number.isFinite(t) ? t : Date.now()

  let typeMonmind, besoinAsset = false
  if (type === TYPE_IMAGE) { typeMonmind = 'image'; besoinAsset = true }
  else if (type === TYPE_VIDEO) { typeMonmind = 'video'; besoinAsset = true }
  else if (TYPES_NOTE.has(type)) typeMonmind = 'note'
  else typeMonmind = 'lien'

  // Cartes vides sans intérêt (pas de texte, pas d'url, pas de média).
  if (!besoinAsset && !url && !contenu && !titre && !note && !tags.length) return null
  // Un « lien » sans URL ni contenu n'a rien à montrer.
  if (typeMonmind === 'lien' && !url && !contenu && !titre) return null

  const carte = {
    id: 'mm-' + row.id,           // idempotent : réimporter n'ajoute pas de doublon
    type: typeMonmind,
    titre,
    url,
    apercu: '',
    tags,
    note,
    // Pour une note, le texte principal = le contenu ; sinon on garde le
    // contenu (surlignage d'article, etc.) comme texte de la carte.
    texte: contenu,
    espaces: [],
    supprime: 0,
    creeLe,
    modifieLe: creeLe,
    source: 'mymind',
    sourceId: row.id
  }
  return { carte, besoinAsset }
}

// Mappe tout un CSV → { cartes, statsParType, avecAsset }.
export function mapperCSV(texte) {
  const rows = parserCSV(texte)
  const cartes = []
  const statsParType = {}
  let avecAsset = 0
  for (const row of rows) {
    const r = mapperLigne(row)
    if (!r) continue
    cartes.push(r.carte)
    statsParType[r.carte.type] = (statsParType[r.carte.type] || 0) + 1
    if (r.besoinAsset) avecAsset++
  }
  return { cartes, statsParType, avecAsset, lignes: rows.length }
}
