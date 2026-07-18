import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
// Enregistre le service worker (mise en cache hors-ligne, mises à jour auto)
import { registerSW } from 'virtual:pwa-register'

registerSW({ immediate: true })

// Demande au navigateur de marquer le stockage local comme « persistant »
// (protégé de l'effacement automatique / des nettoyeurs de cache). Sans
// effet sur la source de vérité (Drive), mais évite de re-télécharger.
if (navigator.storage?.persist) {
  navigator.storage.persisted?.().then(dejaPersistant => {
    if (!dejaPersistant) navigator.storage.persist().catch(() => {})
  }).catch(() => {})
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
