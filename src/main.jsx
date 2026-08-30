import React from 'react'
import { createRoot } from 'react-dom/client'
import App, { EcranCapture } from './App.jsx'
import './styles.css'
import { registerSW } from 'virtual:pwa-register'

// ------------------------------------------------------------------
// Deux surfaces, pas une.
//
// 1. L'APP (par défaut) : service worker, stockage persistant, Drive…
// 2. La fenêtre de CAPTURE (`?c=1&popup=1` du marque-page, ou `?via=ext`) :
//    elle vit deux secondes, écrit une carte et se referme.
//
// Elles partagent la même base IndexedDB mais PAS les mêmes besoins. Démarrer
// l'app complète dans la fenêtre de capture déclenchait, juste avant qu'elle
// ne se ferme, la demande de stockage persistant (Firefox affiche une vraie
// autorisation à cliquer) et le renouvellement de jeton Google (fenêtre
// accounts.google.com). D'où l'écran qui « disparaît avant qu'on ait le temps
// de cliquer ». On choisit donc la surface AVANT de monter quoi que ce soit.
// ------------------------------------------------------------------
const params = new URLSearchParams(window.location.search)
const modeCapture = params.get('via') === 'ext' ||
                    (!!params.get('c') && params.get('popup') === '1')

if (!modeCapture) {
  // Service worker : mise en cache hors-ligne et mises à jour auto.
  registerSW({ immediate: true })

  // Marque le stockage local comme « persistant » (protégé des nettoyeurs de
  // cache). Sans effet sur la source de vérité (Drive), mais évite de
  // re-télécharger. Sur Firefox, c'est une autorisation explicite : elle ne
  // doit apparaître que dans la vraie app, jamais dans une fenêtre fugace.
  if (navigator.storage?.persist) {
    navigator.storage.persisted?.().then(dejaPersistant => {
      if (!dejaPersistant) navigator.storage.persist().catch(() => {})
    }).catch(() => {})
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {modeCapture ? <EcranCapture /> : <App />}
  </React.StrictMode>
)
