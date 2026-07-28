# Prompt — Portrait de goûts (Phase 7)

Mode d'emploi : ouvrir une session **neuve**, sur le modèle le plus capable
disponible, joindre **`corpus-condense.md`** et rien d'autre, coller le texte
ci-dessous. Une seule passe : le corpus tient dans un contexte.

Le corpus se régénère par :
`rclone copy gdrive:MonMind/cartes ~/MonCoffre-insights/md --include "*.md"`
puis `node outils/insights/tags.mjs && node outils/insights/collecter.mjs`.

---

## LE MATÉRIAU

Le fichier joint est un coffre personnel : environ 2250 cartes gardées entre
juillet 2020 et aujourd'hui par une seule personne. Ce ne sont pas des
publications, ni un profil, ni une bibliographie : ce sont des choses qu'elle a
jugé bon de **garder pour elle**, sans destinataire.

Une ligne par carte, de la plus ancienne à la plus récente :

`- [AAAA-MM-JJ] (type · domaine) Titre — #tag #tag · extrait`

- `type` : image, lien, note, video
- `domaine` : le site d'origine, quand il y en a un
- `extrait` : le meilleur texte disponible pour cette carte (note écrite à la
  main, texte de la page, ou texte lu DANS l'image par OCR), coupé à ~220
  caractères

L'ordre chronologique est significatif : sers-t'en.

## PONDÉRATION — TOUTES LES LIGNES NE PÈSENT PAS PAREIL

Ne compte pas. Pèse. Par ordre décroissant de signal :

1. **Notes et citations** — des mots que la personne a écrits, ou choisis de
   recopier. Le signal le plus fort de ce qu'elle pense. Ils sont minoritaires
   en nombre et majoritaires en valeur.
2. **Titres de liens et de vidéos** — une décision consciente d'aller lire ou
   regarder cette chose-là. Signal fort d'intérêt.
3. **Tags** — mélangés : certains posés à la main (souvent en français),
   d'autres hérités de l'outil précédent. Signal moyen, à croiser.
4. **Texte OCR des images** — ce qui était écrit dans l'image. Utile, bruité.
5. **Le volume par type ne veut rien dire.** Une image se garde en un geste,
   une note se rédige. Si les images dominent, cela mesure un coût de geste,
   pas une hiérarchie de goût. Ne conclus jamais d'un simple décompte.

## TROIS RÉGIMES DE SAUVEGARDE — À DISTINGUER

Garder n'est pas approuver. Range ce que tu observes dans l'un des trois, et
dis-le quand tu n'es pas sûr :

- **Adhésion** — gardé parce que c'est beau, juste, drôle, désirable. C'est là
  que vivent les goûts.
- **Métier** — gardé parce que ça sert au travail : outils, techniques,
  références utiles, choses à réutiliser.
- **Veille** — gardé parce qu'il faut savoir. Un article sur une guerre, une
  crise, une dérive, n'exprime aucune préférence pour son sujet.

Attribuer à la personne les opinions des contenus qu'elle archive est l'erreur
la plus grave que tu puisses commettre ici.

## INTERDITS

- **Pas de généralités.** « Vous aimez le design », « une sensibilité
  visuelle », « un esprit curieux » : sans valeur, et vrai de tout le monde.
  Chaque affirmation doit être **ancrée dans au moins deux cartes précises**,
  citées par titre et date. Si tu ne peux pas l'ancrer, ne l'écris pas.
- **Pas de flatterie.** Ni compliment, ni horoscope, ni « vous êtes quelqu'un
  qui… ». Ton neutre, précis, descriptif. Tu décris un corpus, pas une
  personne à séduire.
- **Pas d'invention.** Aucun titre, aucune référence, aucune date qui ne soit
  dans le fichier. En cas de doute sur une lecture, écris-le.
- **Pas de psychologie.** Tu n'as pas accès à une vie intérieure, seulement à
  6 ans de choix de conservation. Reste à ce niveau.
- **Ne comble pas les silences.** Le corpus exclut les cartes marquées privées
  et certains tags d'organisation. Une absence n'est pas une preuve.

## CE QUE JE CHERCHE

Trois choses que des statistiques ne donneront jamais :

1. **Les récurrences esthétiques et de fond** — pas les catégories (« design »,
   « photo »), mais ce qui revient DANS ces catégories : des formes, des
   partis pris, des noms propres, des époques, des registres d'humour, des
   manières de cadrer. Le grain, pas l'étagère.
2. **Les fils rouges invisibles** — des cartes gardées à des mois ou des années
   d'écart, sans aucun tag commun, qui parlent pourtant de la même chose. C'est
   l'apport principal : ce que la personne n'a jamais nommé elle-même.
3. **L'évolution** — le corpus est daté sur 6 ans. Quels intérêts sont nés,
   lesquels se sont éteints, lesquels n'ont jamais bougé. Situe les bascules
   par période, pas au mois près.

## STRUCTURE DE SORTIE

Réponds en **Markdown pur**, en **français**, sans préambule ni conclusion de
politesse. Le fichier produit s'appellera `portrait.md`. Vise **dense** :
environ 3000 à 5000 mots, pas plus — un portrait long et mou vaut moins qu'un
portrait court et exact.

### 1. En bref
Quinze lignes maximum. Ce qu'il faut retenir si on ne lit que ça. Aucune
formule creuse : si une phrase pourrait décrire quelqu'un d'autre, coupe-la.

### 2. Esthétiques récurrentes
Ce qui revient dans la forme des choses gardées. Nomme des références
précises trouvées dans le corpus. Pour chaque trait : deux ou trois cartes
citées `(titre, AAAA-MM)`.

### 3. Thèmes de fond
Les sujets qui traversent le corpus. Pour chacun, précise le régime
(adhésion / métier / veille) et sur quelles années il court.

### 4. Fils rouges invisibles
La section la plus précieuse. Cinq à dix connexions entre cartes éloignées
dans le temps et sans tag commun. Pour chacune : les cartes reliées, ce qui
les relie, et à quel point tu en es sûr (**solide** / **plausible** /
**fragile**).

### 5. Évolution 2020 → aujourd'hui
Les phases. Ce qui apparaît, ce qui s'éteint, ce qui ne bouge pas. Appuie-toi
sur les dates réelles.

### 6. Angles morts et silences
Ce qu'on s'attendrait à trouver et qui manque, ou qui est étonnamment rare.
Dis explicitement que ce peut être un artefact du corpus.

### 7. Hypothèses à vérifier
Ce que tu crois avoir vu sans pouvoir le prouver, formulé en questions
courtes auxquelles la personne peut répondre par oui/non. C'est la matière de
la prochaine passe.

### 8. Mode d'emploi — pour une future session
**Cette section n'est pas écrite pour un lecteur humain mais pour un autre
modèle**, qui la lira au début d'une session de travail (WordPress, design,
écriture) afin de répondre selon ces goûts plutôt que dans le vide.
Écris-la en conséquence : factuelle, opérationnelle, sans style.

- **Préférences applicables** — une liste de partis pris utilisables tels
  quels dans un choix de maquette, de typographie, de ton, de structure.
  Formulées de façon actionnable : « préfère X à Y parce que Z ».
- **Repoussoirs** — ce qui, au vu du corpus, tomberait à côté.
- **Zones sans matière** — les sujets sur lesquels le coffre ne dit rien, où
  il ne faut donc rien extrapoler.
- **Trois à cinq cartes emblématiques** à citer en exemple, avec pourquoi.

---

## RAPPEL FINAL

Un portrait générique est un échec complet, même s'il est bien écrit. Un
portrait qui se trompe mais qui est précis se corrige. Prends le risque d'être
spécifique.
