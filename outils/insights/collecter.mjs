// ---------------------------------------------------------------
// Collecteur — Phase 7 (insights). Lit les .md rapatriés du Drive
// (rclone copy gdrive:MonMind/cartes ...), en extrait le texte utile
// et produit deux sorties :
//   • corpus.jsonl        1 carte par ligne, texte INTÉGRAL (archive de travail)
//   • corpus-condense.md  version compacte, pensée pour tenir en UNE passe
// Aucune dépendance npm. Aucune donnée n'est écrite dans le dépôt.
//
// Usage : node outils/insights/collecter.mjs --src ~/MonCoffre-insights/md \
//                                            --out ~/MonCoffre-insights \
//                                            [--extrait 220]
// ---------------------------------------------------------------
import fs from 'fs'
import path from 'path'

const MARQUE_ARTICLE = '\n\n===MONCOFFRE-ARTICLE===\n'
const TAG_PRIVE = 'private'

function arg(nom, defaut) {
  const i = process.argv.indexOf('--' + nom)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : defaut
}
const SRC = arg('src', path.join(process.env.HOME, 'MonCoffre-insights/md'))
const OUT = arg('out', path.join(process.env.HOME, 'MonCoffre-insights'))
const EXTRAIT = parseInt(arg('extrait', '220'), 10)

// Même normalisation que l'app (db.js) : accents retirés, minuscules.
const normTag = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()

// Format d'un .md : ---\n<JSON meta sur une ligne>\n---\n<corps>
// où <corps> = note libre [+ MARQUE_ARTICLE + article Markdown].
function parserMd(contenu) {
  if (!contenu.startsWith('---\n')) return null
  const fin = contenu.indexOf('\n---\n', 4)
  if (fin < 0) return null
  let meta
  try { meta = JSON.parse(contenu.slice(4, fin)) } catch { return null }
  let texte = contenu.slice(fin + 5)
  let article = ''
  const i = texte.indexOf(MARQUE_ARTICLE)
  if (i > -1) { article = texte.slice(i + MARQUE_ARTICLE.length); texte = texte.slice(0, i) }
  return { meta, texte: texte.trim(), article: article.trim() }
}

const domaineDe = url => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}
const jour = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '')
// Compacte les blancs et coupe proprement à N caractères.
function extrait(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const coupe = t.slice(0, n)
  const esp = coupe.lastIndexOf(' ')
  return (esp > n * 0.6 ? coupe.slice(0, esp) : coupe) + '…'
}

// ---- Lecture ---------------------------------------------------
const fichiers = fs.readdirSync(SRC).filter(f => f.endsWith('.md'))
const stat = {
  fichiers: fichiers.length, illisibles: 0, espaces: 0,
  supprimees: 0, privees: 0, vides: 0, retenues: 0,
  parType: {}, domaines: {}, tags: {}, avecOcr: 0, avecArticle: 0,
  dateMin: '', dateMax: ''
}
const cartes = []

for (const f of fichiers) {
  const p = parserMd(fs.readFileSync(path.join(SRC, f), 'utf8'))
  if (!p) { stat.illisibles++; continue }
  const { meta, texte, article } = p
  if (meta.type === 'espace') { stat.espaces++; continue }
  if (meta.supprime) { stat.supprimees++; continue }

  const tags = (meta.tags || []).map(normTag).filter(Boolean)
  // Règle de vie privée : une carte #private ne sort JAMAIS du coffre.
  if (tags.includes(TAG_PRIVE)) { stat.privees++; continue }

  const carte = {
    id: f.replace(/\.md$/, ''),
    type: meta.type || '?',
    date: jour(meta.creeLe),
    titre: (meta.titre || '').trim(),
    url: meta.url || '',
    domaine: domaineDe(meta.url),
    tags,
    note: (meta.note || '').trim(),
    texte,
    texteImage: (meta.texteImage || '').trim(),
    apercu: meta.apercu ? 1 : 0,
    article
  }

  // Une carte sans AUCUN texte exploitable n'apporte rien au portrait
  // (image jamais OCRisée et sans titre ni tag) : comptée, mise de côté.
  const matiere = [carte.titre, carte.note, carte.texte, carte.texteImage, carte.article, carte.tags.join(' ')]
    .join(' ').trim()
  if (!matiere) { stat.vides++; continue }

  stat.retenues++
  stat.parType[carte.type] = (stat.parType[carte.type] || 0) + 1
  if (carte.domaine) stat.domaines[carte.domaine] = (stat.domaines[carte.domaine] || 0) + 1
  carte.tags.forEach(t => { stat.tags[t] = (stat.tags[t] || 0) + 1 })
  if (carte.texteImage) stat.avecOcr++
  if (carte.article) stat.avecArticle++
  if (carte.date) {
    if (!stat.dateMin || carte.date < stat.dateMin) stat.dateMin = carte.date
    if (!stat.dateMax || carte.date > stat.dateMax) stat.dateMax = carte.date
  }
  cartes.push(carte)
}

// Plus ancien d'abord : l'ordre chronologique rend lisibles les phases
// et les intérêts qui naissent ou s'éteignent (apport n°3 du cahier).
cartes.sort((a, b) => (a.date || '').localeCompare(b.date || ''))

// ---- Sorties ---------------------------------------------------
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'corpus.jsonl'), cartes.map(c => JSON.stringify(c)).join('\n') + '\n')

// Condensé : une ligne par carte. On garde ce qui porte du SENS (titre, tags,
// source, date) + un extrait du meilleur texte disponible. Objectif : que les
// ~2300 cartes tiennent dans un seul contexte, sans passe de résumé par IA.
const lignes = cartes.map(c => {
  const corps = extrait(c.note || c.texte || c.article || c.texteImage, EXTRAIT)
  const bouts = [
    `- [${c.date || '????-??-??'}] (${c.type}${c.domaine ? ' · ' + c.domaine : ''})`,
    c.titre ? ` ${c.titre}` : '',
    c.tags.length ? ` — ${c.tags.map(t => '#' + t).join(' ')}` : '',
    corps ? ` · ${corps}` : ''
  ]
  return bouts.join('')
})
const entete = [
  `# Corpus condensé — MonCoffre`,
  `Généré le ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${cartes.length} cartes`,
  `Période : ${stat.dateMin} → ${stat.dateMax} · cartes #private exclues (${stat.privees})`,
  ''
].join('\n')
fs.writeFileSync(path.join(OUT, 'corpus-condense.md'), entete + lignes.join('\n') + '\n')

// ---- Bilan à l'écran -------------------------------------------
const octets = f => fs.statSync(path.join(OUT, f)).size
// Estimation grossière et volontairement prudente : ~4 caractères par token.
const enTokens = o => Math.round(o / 4 / 1000) + 'k'
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `${k} (${v})`).join(', ')

stat.tokensCondense = enTokens(octets('corpus-condense.md'))
stat.tokensIntegral = enTokens(octets('corpus.jsonl'))
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stat, null, 2))

console.log(`Fichiers lus        : ${stat.fichiers}`)
console.log(`  espaces           : ${stat.espaces}`)
console.log(`  en corbeille      : ${stat.supprimees}`)
console.log(`  #private exclues  : ${stat.privees}`)
console.log(`  sans texte        : ${stat.vides}`)
console.log(`  illisibles        : ${stat.illisibles}`)
console.log(`CARTES RETENUES     : ${stat.retenues}   (${stat.dateMin} → ${stat.dateMax})`)
console.log(`  par type          : ${top(stat.parType, 8)}`)
console.log(`  avec OCR          : ${stat.avecOcr} · avec article : ${stat.avecArticle}`)
console.log(`  tags distincts    : ${Object.keys(stat.tags).length} · top : ${top(stat.tags, 12)}`)
console.log(`  sources           : ${top(stat.domaines, 8)}`)
console.log(`corpus.jsonl        : ${(octets('corpus.jsonl') / 1e6).toFixed(2)} Mo  (~${stat.tokensIntegral} tokens)`)
console.log(`corpus-condense.md  : ${(octets('corpus-condense.md') / 1e6).toFixed(2)} Mo  (~${stat.tokensCondense} tokens)`)
