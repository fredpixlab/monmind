// Vérification visuelle : ouvre le build, ajoute des cartes, capture des écrans.
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => {
  let p = req.url.replace(/^\/monmind/, '').split('?')[0]
  if (p === '/' || p === '') p = '/index.html'
  const f = join('dist', p)
  if (existsSync(f)) {
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
    res.end(readFileSync(f))
  } else {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(readFileSync('dist/index.html'))
  }
}).listen(4173)

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const erreurs = []
page.on('pageerror', e => erreurs.push(String(e)))
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()) })

await page.goto('http://localhost:4173/monmind/')
await page.waitForTimeout(800)
await page.screenshot({ path: 'capture-vide.png' })

// Ajoute une note
await page.click('.ajouter')
await page.fill('textarea', 'Le design, c\'est de l\'intelligence rendue visible.')
await page.click('.bouton-principal')
await page.waitForTimeout(300)
// Ajoute un lien
await page.click('.ajouter')
await page.fill('textarea', 'https://mymind.com/')
await page.click('.bouton-principal')
await page.waitForTimeout(300)
// Encore deux notes pour la grille
for (const t of ['Idée : re-tagger toutes mes images mymind avec l\'IA au moment de la migration.', 'Palette préférée : menthe, lavande, pêche — tons doux, jamais saturés.']) {
  await page.click('.ajouter')
  await page.fill('textarea', t)
  await page.click('.bouton-principal')
  await page.waitForTimeout(300)
}
await page.screenshot({ path: 'capture-cartes.png' })

// Vue iPhone
const iphone = await browser.newPage({ viewport: { width: 390, height: 844 } })
await iphone.goto('http://localhost:4173/monmind/')
await iphone.waitForTimeout(600)
await iphone.screenshot({ path: 'capture-iphone.png' })

// Manifest + SW présents ?
const manifest = await page.evaluate(async () => {
  const r = await fetch('/monmind/manifest.webmanifest'); return r.ok
})
console.log('Manifest accessible :', manifest)
console.log('Erreurs JS :', erreurs.length ? erreurs : 'aucune')

await browser.close()
server.close()
