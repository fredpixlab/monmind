// Génère les icônes PWA à partir d'un SVG (l'orbe dégradé signature).
// Usage : npm run icons
import sharp from 'sharp'
import { mkdirSync } from 'fs'

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(175,55%,72%)"/>
      <stop offset=".5" stop-color="hsl(255,62%,76%)"/>
      <stop offset="1" stop-color="hsl(22,88%,78%)"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="hsl(40,23%,97%)"/>
  <circle cx="256" cy="256" r="${256 - pad}" fill="url(#g)"/>
</svg>`

mkdirSync('public/icons', { recursive: true })

const jobs = [
  ['public/icons/icon-192.png', 192, 96],
  ['public/icons/icon-512.png', 512, 96],
  // maskable : plus de marge (zone de sécurité ~20%)
  ['public/icons/icon-maskable-512.png', 512, 150],
  ['public/icons/apple-touch-icon.png', 180, 110]
]

for (const [sortie, taille, pad] of jobs) {
  await sharp(Buffer.from(svg(pad))).resize(taille, taille).png().toFile(sortie)
  console.log('✓', sortie)
}
