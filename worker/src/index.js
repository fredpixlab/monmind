// ==================================================================
// MonCoffre — backend minimal (Cloudflare Worker).
//
// PHASE A (ce fichier) : service d'APERÇUS de liens.
//   GET /preview?url=<lien>  → { image, titre, desc?, texte?, dom, erreur? }
//   Récupère l'image d'aperçu (og:image / twitter:image) et le titre d'une
//   page ; pour Twitter/X, passe par l'oEmbed officiel (texte + auteur).
//   Sans état, ne stocke RIEN : il ne fait que relayer un aperçu public.
//   Réponses mises en cache 7 jours (Cache API de Cloudflare) → rapide et
//   économe. C'est l'app (le navigateur) qui garde ensuite l'aperçu dans la
//   carte ; le Worker n'est sollicité qu'une fois par lien.
//
// PHASE B (à venir) : /login, /callback, /token pour la connexion Drive
//   permanente (refresh_token chiffré en KV). Séparé, viendra après.
// ==================================================================

const UA = 'Mozilla/5.0 (compatible; MonCoffreBot/1.0; +https://fredpixlab.github.io/monmind/)'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))
    if (url.pathname === '/preview') return preview(url, ctx)
    if (url.pathname === '/' || url.pathname === '/health') {
      return cors(json({ ok: true, service: 'moncoffre-api', phase: 'A (preview)' }))
    }
    return cors(json({ erreur: 'route inconnue' }, 404))
  }
}

// --- /preview -----------------------------------------------------
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
      // 7 jours ; les erreurs sont mises en cache moins longtemps (1 j) pour
      // laisser une chance de re-tenter un site temporairement indisponible.
      'Cache-Control': 'public, max-age=' + (data && data.erreur ? 86400 : 604800)
    }
  })
  ctx.waitUntil(cache.put(key, resp.clone()))
  return cors(resp)
}

function domaine(u) { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

// Décode les entités HTML les plus courantes (les titres et le texte des tweets
// arrivent souvent avec « &mdash; », « &#39; », etc.).
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

async function extraire(cible) {
  const d = domaine(cible)
  if (/(^|\.)(twitter\.com|x\.com)$/.test(d)) return await twitter(cible, d)
  return await ogImage(cible, d)
}

// Aperçu générique : lit les balises meta og:/twitter: en streaming via
// HTMLRewriter (léger, borne la mémoire, pas de DOM complet à charger).
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

  await rw.transform(r).arrayBuffer()   // consomme le flux → exécute les handlers

  const titre = decode((f.titre || f.t || '').replace(/\s+/g, ' ').trim()).slice(0, 200)
  let image = ''
  if (f.image) { try { image = new URL(f.image, cible).toString() } catch { image = '' } }
  return { image, titre, desc: decode((f.desc || '').replace(/\s+/g, ' ').trim()).slice(0, 300), dom: d }
}

// Twitter / X : l'oEmbed officiel renvoie le texte du tweet + l'auteur (pas
// toujours d'image, mais au moins la carte n'est plus vide).
async function twitter(cible, d) {
  const api = 'https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=' + encodeURIComponent(cible)
  const r = await fetch(api, { headers: { 'User-Agent': UA } })
  if (!r.ok) return { erreur: 'oembed ' + r.status, dom: d }
  const j = await r.json().catch(() => null)
  if (!j) return { erreur: 'oembed illisible', dom: d }
  const texte = decode((j.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
  return { image: '', titre: (j.author_name || '').slice(0, 120), texte: texte.slice(0, 400), dom: d }
}

// --- utilitaires --------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

// Aperçus = service public sans identifiants → CORS ouvert (`*`). La Phase B
// (jetons) utilisera un en-tête Authorization (Bearer), compatible avec `*`
// tant qu'on n'utilise pas de cookies — ce qui est justement le but (contourner
// le blocage des cookies tiers de Safari).
function cors(resp) {
  const h = new Headers(resp.headers)
  h.set('Access-Control-Allow-Origin', '*')
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  h.set('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  h.set('Access-Control-Max-Age', '86400')
  return new Response(resp.body, { status: resp.status, headers: h })
}
