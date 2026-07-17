// ==================================================================
// MonMind — orchestrateur de l'import mymind.
//
// Reçoit un dossier (FileSystemDirectoryHandle, via showDirectoryPicker
// dans Chrome), lit cards.csv, rattache chaque fichier média par son id,
// génère une vignette, pousse le fichier complet + la vignette + le .md
// vers Drive (médias « à la demande »), et enregistre localement une
// carte légère (vignette seule).
//
// Idempotent : relancer l'import saute les cartes déjà traitées.
// ==================================================================
import { mapperCSV } from './import-mymind.js'
import { vignetteImage, vignetteVideo, vignetteDefaut, estVideoExt } from './vignette.js'
import { getCarte, mettreCarteImportee } from './db.js'
import { pousserCarteImportee, synchroniser, marquerImport } from './drive.js'

const CONCURRENCE = 3

export async function lancerImport(dirHandle, onProgress) {
  // 1. Indexer les fichiers du dossier + repérer le CSV.
  const fichiers = new Map()   // id (nom sans extension) -> { handle, ext }
  let csvHandle = null
  for await (const [nom, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue
    if (nom.toLowerCase().endsWith('.csv')) { csvHandle = handle; continue }
    const pt = nom.lastIndexOf('.')
    const base = pt === -1 ? nom : nom.slice(0, pt)
    const ext = pt === -1 ? '' : nom.slice(pt + 1)
    fichiers.set(base, { handle, ext })
  }
  if (!csvHandle) throw new Error("cards.csv introuvable dans le dossier choisi")

  const texteCsv = await (await csvHandle.getFile()).text()
  const { cartes } = mapperCSV(texteCsv)
  const total = cartes.length

  const stats = { faits: 0, medias: 0, textes: 0, sautes: 0, manquants: 0, erreurs: 0, total }
  let authPerdu = false
  onProgress?.({ phase: 'demarrage', ...stats })

  marquerImport(true)   // met la sync périodique en pause pendant l'import
  try {
    // 2. Traiter les cartes (petit pool de concurrence).
    let curseur = 0
    async function worker() {
      while (curseur < cartes.length && !authPerdu) {
        const carte = cartes[curseur++]
        const estMedia = carte.type === 'image' || carte.type === 'video'
        try {
          const existe = await getCarte(carte.id)
          if (existe && ((estMedia && existe.driveMediaId) || (!estMedia && existe.driveMdId))) {
            stats.sautes++; stats.faits++; onProgress?.({ phase: 'encours', ...stats }); continue
          }

          if (estMedia) {
            const f = fichiers.get(carte.sourceId)
            if (!f) { stats.manquants++; stats.faits++; onProgress?.({ phase: 'encours', ...stats }); continue }
            const file = await f.handle.getFile()
            const ext = (f.ext || '').toLowerCase()
            const estVid = estVideoExt(ext)
            let vign
            try { vign = estVid ? await vignetteVideo(file) : await vignetteImage(file) }
            catch { vign = await vignetteDefaut(estVid) }
            const cImport = { ...carte, mediaExt: ext, distant: true, vignetteNom: `${carte.id}.thumb.jpg` }
            // Upload d'abord ; on n'enregistre la carte en local qu'en cas de succès
            // (sinon on la retentera au prochain passage).
            const res = await pousserCarteImportee(cImport, file, vign)
            await mettreCarteImportee({ ...cImport, distant: 1, vignette: vign, image: null, ...res })
            stats.medias++
          } else {
            // Note / lien : enregistré en local, poussé par la sync ensuite.
            await mettreCarteImportee(carte)
            stats.textes++
          }
          stats.faits++
          onProgress?.({ phase: 'encours', ...stats })
        } catch (e) {
          console.error('[import]', carte.id, e)
          // Jeton Google perdu → inutile de continuer : on s'arrête proprement.
          if (e && (e.name === 'BesoinReconnexion' || /reconnexion|401|invalid_token/i.test(e.message || ''))) {
            authPerdu = true
          } else {
            stats.erreurs++; stats.faits++
            onProgress?.({ phase: 'encours', ...stats })
          }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCE }, worker))
  } finally {
    marquerImport(false)
  }

  if (authPerdu) {
    onProgress?.({ phase: 'auth', ...stats })
    return { ...stats, authPerdu: true }
  }

  // 3. Pousser les cartes texte vers Drive via la sync normale.
  onProgress?.({ phase: 'sync', ...stats })
  try { await synchroniser() } catch (e) { console.error('[import sync]', e) }

  onProgress?.({ phase: 'fini', ...stats })
  return stats
}
