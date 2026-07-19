import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Tampon de build (date + heure de Paris), figé au moment du `vite build`.
// Injecté tel quel dans l'app via `define` (constante `__BUILD__`) → affiché
// dans la vue Statistiques pour vérifier d'un coup d'œil qu'on a la dernière
// version déployée. ⚠️ Comme cette valeur change à chaque build, le hash du
// bundle n'est plus identique cloud/Mac/CI : on vérifie la fidélité par le
// `shasum` des FICHIERS SOURCE, pas par le nom du bundle.
function tamponBuild() {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date())
  const g = t => (parts.find(p => p.type === t) || {}).value || ''
  return `${g('day')}/${g('month')}/${g('year')} à ${g('hour')}h${g('minute')}`
}

// `base` correspond au nom du repo GitHub : l'app sera servie sur
// https://fredpixlab.github.io/monmind/
export default defineConfig({
  base: '/monmind/',
  define: {
    __BUILD__: JSON.stringify(tamponBuild())
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'MonCoffre',
        short_name: 'MonCoffre',
        description: 'Ton second cerveau visuel — données chez toi.',
        lang: 'fr',
        start_url: '/monmind/',
        scope: '/monmind/',
        display: 'standalone',
        background_color: '#faf9f7',
        theme_color: '#faf9f7',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        navigateFallback: '/monmind/index.html'
      }
    })
  ]
})
