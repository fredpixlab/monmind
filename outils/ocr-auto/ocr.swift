// MonCoffre — OCR + classification de scène via Apple Vision (100% local).
// Usage : ocr <dossierImages> <sortie.json>
// Sortie : JSON [ { id, texte, labels[] } ]  (id = nom de fichier sans extension = sourceId mymind)
import Foundation
import Vision
import ImageIO

let IMG_EXT: Set<String> = ["jpg", "jpeg", "png", "webp", "gif", "avif", "tiff", "heic", "heif", "bmp"]

func loadCG(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
  return img
}

func analyse(_ path: String) -> [String: Any]? {
  guard let cg = loadCG(path) else { return nil }
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  let textReq = VNRecognizeTextRequest()
  textReq.recognitionLevel = .accurate
  textReq.recognitionLanguages = ["fr-FR", "en-US"]
  textReq.usesLanguageCorrection = true
  let classReq = VNClassifyImageRequest()
  try? handler.perform([textReq, classReq])
  let texte = (textReq.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  let labels = (classReq.results ?? []).filter { $0.confidence > 0.4 }.prefix(10).map { $0.identifier }
  let base = (path as NSString).lastPathComponent
  let id = (base as NSString).deletingPathExtension
  return ["id": id, "texte": texte, "labels": Array(labels)]
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: ocr <dossier> <sortie.json>\n".data(using: .utf8)!); exit(1)
}
let dir = args[0], outPath = args[1]
let fm = FileManager.default
let files = ((try? fm.contentsOfDirectory(atPath: dir)) ?? [])
  .filter { IMG_EXT.contains(($0 as NSString).pathExtension.lowercased()) }
  .sorted()
var out: [[String: Any]] = []
var n = 0
for f in files {
  n += 1
  if let r = analyse(dir + "/" + f) { out.append(r) }
  if n % 50 == 0 { FileHandle.standardError.write("\(n)/\(files.count)\n".data(using: .utf8)!) }
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [.withoutEscapingSlashes])
try! data.write(to: URL(fileURLWithPath: outPath))
FileHandle.standardError.write("FINI \(out.count)/\(files.count)\n".data(using: .utf8)!)
