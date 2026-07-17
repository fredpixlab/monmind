import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// `base` correspond au nom du repo GitHub : l'app sera servie sur
// https://fredpixlab.github.io/monmind/
export default defineConfig({
  base: '/monmind/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'MonMind',
        short_name: 'MonMind',
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
