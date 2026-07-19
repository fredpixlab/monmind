// ==================================================================
// MonCoffre — backend (Cloudflare Worker).
//
// PHASE A : APERÇUS de liens.  GET /preview?url=<lien>
//   → { image, titre, desc?, texte?, dom, erreur? }. Sans état.
//
// PHASE B : CONNEXION DRIVE PERMANENTE (contourne le blocage Safari du
//   renouvellement silencieux). Le Worker garde un refresh_token Google
//   CHIFFRÉ (KV) et fabrique des jetons d'accès courts à la demande. Il NE
//   voit JAMAIS le contenu des cartes : c'est toujours le navigateur qui parle
//   à Drive. Scope limité à drive.file.
//     GET  /login     → redirige vers le consentement Google (offline).
//     GET  /callback  → échange le code, stocke le refresh_token chiffré,
//                       renvoie l'app avec un identifiant de session (#connexion=).
//     POST /token     → (Authorization: Bearer <sid>) renvoie un access_token frais.
//
//   Anti-Safari : la session (sid) vit dans IndexedDB côté app et voyage en
//   en-tête Authorization — PAS un cookie tiers (que Safari bloquerait).
//
// Secrets (wrangler secret put) : GOOGLE_CLIENT_SECRET, TOKEN_KEY.
// Vars (wrangler.toml) : GOOGLE_CLIENT_ID, REDIRECT_URI, APP_RETOUR.
// KV : JETONS (états OAuth éphémères + sessions).
// ==================================================================

const UA = 'Mozilla/5.0 (compatible; MonCoffreBot/1.0; +https://fredpixlab.github.io/monmind/)'
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email'
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))
    if (url.pathname === '/preview') return preview(url, ctx)
    if (url.pathname === '/lire') return lire(url, ctx)
    if (url.pathname === '/login') return login(url, env)
    if (url.pathname === '/callback') return callback(url, env)
    if (url.pathname === '/token' && request.method === 'POST') return token(request, env)
    if (url.pathname === '/logout' && request.method === 'POST') return logout(request, env)
    if (url.pathname === '/' || url.pathname === '/health') {
      return cors(json({ ok: true, service: 'moncoffre-api', phases: 'A (preview) + B (drive)' }))
    }
    return cors(json({ erreur: 'route inconnue' }, 404))
  }
}

// ================= PHASE A : aperçus =================
async function preview(reqUrl, ctx) {
  const cible = reqUrl.searchParams.get('url')
  if (!cible || !/^https?:\/\//i.test(cible)) return cors(json({ erreur: 'url invalide' }, 400))
  const cache = caches.default
  const key = new Request('https://moncoffre-cache.local/preview?u=' + encodeURIComponent(cible))
  const cached = await cache.match(key)
  if (cached) return cors(cached)
  let data
  try { data = await extraire(cible) }
  catch (e) { data = { erreur: 'inaccessible', dom: domaine(cible) } }
  const resp = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + (data && data.erreur ? 86400 : 604800)
    }
  })
  ctx.waitUntil(cache.put(key, resp.clone()))
  return cors(resp)
}

function domaine(u) { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

// Décode les entités HTML les plus courantes (« &mdash; », « &#39; », etc.).
function decode(s) {
  if (!s) return s
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n) } catch { return _ } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&amp;/g, '&')
}

function idYouTube(u) {
  const m = (u || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/)
  return m ? m[1] : null
}

async function extraire(cible) {
  const d = domaine(cible)
  if (idYouTube(cible)) return await youtube(cible, d)
  if (/(^|\.)(twitter\.com|x\.com)$/.test(d)) return await twitter(cible, d)
  return await ogImage(cible, d)
}

// YouTube : oEmbed officiel (titre de la vidéo + miniature + chaîne), sans clé.
async function youtube(cible, d) {
  const api = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(cible)
  const r = await fetch(api, { headers: { 'User-Agent': UA } })
  if (!r.ok) return { erreur: 'oembed yt ' + r.status, dom: d }
  const j = await r.json().catch(() => null)
  if (!j) return { erreur: 'oembed yt illisible', dom: d }
  return { image: j.thumbnail_url || '', titre: decode(j.title || '').slice(0, 200), texte: '', dom: d }
}

async function ogImage(cible, d) {
  const ctrl = new AbortController()
  const minuteur = setTimeout(() => ctrl.abort(), 8000)
  let r
  try {
    r = await fetch(cible, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow', signal: ctrl.signal, cf: { cacheTtl: 3600 }
    })
  } finally { clearTimeout(minuteur) }
  if (!r.ok) return { erreur: 'http ' + r.status, dom: d }
  const ct = (r.headers.get('content-type') || '')
  if (!/text\/html|xml/i.test(ct)) return { erreur: 'pas du HTML', dom: d }
  const f = { image: '', titre: '', desc: '', t: '' }
  const rw = new HTMLRewriter()
    .on('meta', {
      element(el) {
        const p = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase()
        const c = el.getAttribute('content') || ''
        if (!c) return
        if (!f.image && (p === 'og:image' || p === 'og:image:secure_url' || p === 'og:image:url' || p === 'twitter:image' || p === 'twitter:image:src')) f.image = c
        if (!f.titre && (p === 'og:title' || p === 'twitter:title')) f.titre = c
        if (!f.desc && (p === 'og:description' || p === 'twitter:description' || p === 'description')) f.desc = c
      }
    })
    .on('title', { text(t) { if (t.text) f.t += t.text } })
  await rw.transform(r).arrayBuffer()
  const titre = decode((f.titre || f.t || '').replace(/\s+/g, ' ').trim()).slice(0, 200)
  let image = ''
  if (f.image) { try { image = new URL(f.image, cible).toString() } catch { image = '' } }
  return { image, titre, desc: decode((f.desc || '').replace(/\s+/g, ' ').trim()).slice(0, 300), dom: d }
}

async function twitter(cible, d) {
  const api = 'https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=' + encodeURIComponent(cible)
  const r = await fetch(api, { headers: { 'User-Agent': UA } })
  if (!r.ok) return { erreur: 'oembed ' + r.status, dom: d }
  const j = await r.json().catch(() => null)
  if (!j) return { erreur: 'oembed illisible', dom: d }
  const texte = decode((j.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
  return { image: '', titre: (j.author_name || '').slice(0, 120), texte: texte.slice(0, 400), dom: d }
}

// ================= LECTURE : article hors-ligne =================
// GET /lire?url=<lien> → { titre, texte, longueur, dom, erreur? }
// Extrait le contenu LISIBLE de la page (mode « Lecture » façon Readability) :
// titre + corps de l'article nettoyé (sans menus, pub, scripts). L'app le range
// dans la carte → disponible hors connexion, et survit si la page disparaît.
async function lire(reqUrl, ctx) {
  const cible = reqUrl.searchParams.get('url')
  if (!cible || !/^https?:\/\//i.test(cible)) return cors(json({ erreur: 'url invalide' }, 400))
  const cache = caches.default
  const key = new Request('https://moncoffre-cache.local/lire?u=' + encodeURIComponent(cible))
  const cached = await cache.match(key)
  if (cached) return cors(cached)
  let data
  try { data = await extraireArticle(cible) }
  catch (e) { data = { erreur: 'illisible', dom: domaine(cible) } }
  const resp = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + (data && data.erreur ? 3600 : 604800)
    }
  })
  ctx.waitUntil(cache.put(key, resp.clone()))
  return cors(resp)
}

// Extraction en STREAMING via HTMLRewriter (parseur Rust natif de Cloudflare) :
// quelques ms de CPU au lieu de ~90 ms pour Readability+DOM — indispensable pour
// tenir sous la limite de 10 ms CPU du plan Workers gratuit. Heuristique : on
// garde le texte des blocs de contenu (p, titres, listes, citations) et on ignore
// les zones de « chrome » (nav, header, footer, aside, scripts, formulaires…).
async function extraireArticle(cible) {
  const d = domaine(cible)
  const ctrl = new AbortController()
  const minuteur = setTimeout(() => ctrl.abort(), 12000)
  let r
  try {
    r = await fetch(cible, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctrl.signal })
  } finally { clearTimeout(minuteur) }
  if (!r.ok) return { erreur: 'http ' + r.status, dom: d }
  const ct = (r.headers.get('content-type') || '')
  if (!/text\/html|xml/i.test(ct)) return { erreur: 'pas du HTML', dom: d }

  // État partagé entre les gestionnaires (le flux est traité dans l'ordre du doc).
  const S = { saut: 0, bloc: 0, dansTitre: false, morceaux: [], titre: '', ogTitre: '' }
  const SAUT = 'script,style,noscript,nav,header,footer,aside,form,svg,button,figure,figcaption,label,select,template,iframe,object'
  const BLOCS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dd'
  const rw = new HTMLRewriter()
    .on(SAUT, { element(el) { S.saut++; el.onEndTag(() => { S.saut-- }) } })
    .on('title', { element(el) { S.dansTitre = true; el.onEndTag(() => { S.dansTitre = false }) } })
    .on('meta', {
      element(el) {
        const k = el.getAttribute('property') || el.getAttribute('name')
        if (k === 'og:title' && !S.ogTitre) { const c = el.getAttribute('content'); if (c) S.ogTitre = c }
      }
    })
    .on(BLOCS, {
      element(el) {
        if (S.saut === 0) S.morceaux.push(el.tagName === 'li' ? '\n• ' : '\n\n')
        S.bloc++; el.onEndTag(() => { S.bloc-- })
      }
    })
    .onDocument({
      text(t) {
        if (!t.text) return
        if (S.dansTitre) { S.titre += t.text; return }
        if (S.saut === 0 && S.bloc > 0) S.morceaux.push(t.text)
      }
    })

  // Consommer entièrement le flux transformé (déclenche tous les gestionnaires).
  await rw.transform(r).arrayBuffer()

  const texte = nettoyerTexte(S.morceaux).slice(0, 60000)
  if (texte.length < 120) return { erreur: 'article trop court', dom: d }
  const titre = decode((S.ogTitre || S.titre || '').replace(/\s+/g, ' ').trim()).slice(0, 300)
  return { titre, texte, longueur: texte.length, dom: d }
}

// Assemble les morceaux collectés en texte lisible (paragraphes préservés).
function nettoyerTexte(morceaux) {
  return decode(morceaux.join(''))
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ================= PHASE B : connexion Drive =================

// GET /login → redirige vers le consentement Google (accès offline pour
// obtenir un refresh_token). Un « state » anti-CSRF est stocké 10 min en KV.
async function login(url, env) {
  const state = rnd(24)
  await env.JETONS.put('state:' + state, '1', { expirationTtl: 600 })
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  })
  return Response.redirect(GOOGLE_AUTH + '?' + p.toString(), 302)
}

// GET /callback → échange le code contre les jetons, stocke le refresh_token
// CHIFFRÉ sous une session (sid), et renvoie l'app avec le sid dans le FRAGMENT.
async function callback(url, env) {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (url.searchParams.get('error')) return retourApp(env, null, url.searchParams.get('error'))
  if (!code || !state) return retourApp(env, null, 'params')
  if (!(await env.JETONS.get('state:' + state))) return retourApp(env, null, 'state')
  await env.JETONS.delete('state:' + state)

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.REDIRECT_URI,
    grant_type: 'authorization_code'
  })
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.refresh_token) return retourApp(env, null, 'echange')

  const info = decodeJwt(j.id_token) || {}
  const sid = rnd(32)
  const rtChiffre = await chiffrer(env, j.refresh_token)
  await env.JETONS.put('sid:' + sid, JSON.stringify({
    rt: rtChiffre, sub: info.sub || '', email: info.email || '', cree: Date.now()
  }))
  return retourApp(env, sid, null)
}

// Renvoie vers l'app. Le sid part dans le FRAGMENT (#) : jamais envoyé aux
// serveurs ni journalisé.
function retourApp(env, sid, erreur) {
  const base = env.APP_RETOUR
  if (sid) return Response.redirect(base + '#connexion=' + encodeURIComponent(sid), 302)
  return Response.redirect(base + '?erreur=' + encodeURIComponent(erreur || 'ko'), 302)
}

// POST /token (Authorization: Bearer <sid>) → access_token frais depuis le
// refresh_token stocké. Si le refresh_token est révoqué → 401 + session effacée.
async function token(request, env) {
  const sid = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!sid) return cors(json({ erreur: 'sid manquant' }, 401))
  const rec = await env.JETONS.get('sid:' + sid, 'json')
  if (!rec || !rec.rt) return cors(json({ erreur: 'session inconnue' }, 401))
  let rt
  try { rt = await dechiffrer(env, rec.rt) } catch { return cors(json({ erreur: 'dechiffrement' }, 500)) }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: rt,
    grant_type: 'refresh_token'
  })
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) {
    if (r.status === 400 || r.status === 401) await env.JETONS.delete('sid:' + sid)
    return cors(json({ erreur: 'refresh', detail: j.error || r.status }, 401))
  }
  return cors(json({ access_token: j.access_token, expires_in: j.expires_in || 3600 }))
}

// POST /logout (Authorization: Bearer <sid>) → efface la session côté serveur.
async function logout(request, env) {
  const sid = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (sid) await env.JETONS.delete('sid:' + sid)
  return cors(json({ ok: true }))
}

// --- chiffrement (AES-GCM, clé = TOKEN_KEY base64 de 32 octets) ---
async function cle(env) {
  return crypto.subtle.importKey('raw', fromB64(env.TOKEN_KEY), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
async function chiffrer(env, texte) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cle(env), new TextEncoder().encode(texte))
  return b64(iv) + '.' + b64(new Uint8Array(ct))
}
async function dechiffrer(env, blob) {
  const parts = blob.split('.')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parts[0]) }, await cle(env), fromB64(parts[1]))
  return new TextDecoder().decode(pt)
}
function decodeJwt(t) {
  try {
    const p = (t || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(decodeURIComponent(escape(atob(p))))
  } catch { return null }
}

// --- utilitaires ---
function rnd(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a) }
function b64(a) { let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s) }
function fromB64(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a }
function b64url(a) { return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

// Pas de cookies (on utilise Authorization: Bearer) → CORS `*` sans risque de
// vol de session cross-site : le sid vit dans l'IndexedDB de l'app, inaccessible
// à un autre site.
function cors(resp) {
  const h = new Headers(resp.headers)
  h.set('Access-Control-Allow-Origin', '*')
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  h.set('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  h.set('Access-Control-Max-Age', '86400')
  return new Response(resp.body, { status: resp.status, headers: h })
}
