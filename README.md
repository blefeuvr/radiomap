# RadioMap APC 38

Carte web interactive de la couverture radio VHF de l'APC 38 : relais fixe du Saint-Eynard,
remorque relais SLR1000, base PC, véhicules, portatifs ou antenne spécifique.
On place les stations sur la carte et la couverture se calcule sur le relief IGN.

C'est un site **100 % statique** : pas de serveur, pas de clé d'API. Le calcul se fait dans
le navigateur, sur PC comme sur téléphone.

## Utilisation

- **Ajouter une station** : choisir le type sous la liste, cliquer sur « Placer sur la carte », puis cliquer à l'emplacement voulu.
  On peut aussi cliquer sur la carte, puis sur « Ajouter ici » dans la bulle.
- **Déplacer une station** : glisser son marqueur. La couverture se recalcule.
- **Modifier une station** : bouton ✎. On y règle la hauteur d'antenne, la puissance, le gain, les pertes câble, la sensibilité et le rayon de calcul.
  Changer le matériel remet les valeurs par défaut de ce matériel.
- **Activer/désactiver** une station : case à cocher, pour comparer des variantes.
- **Vue par** : terminal pour lequel la couverture est dessinée (portatif à la main ou véhicule).
- **Affichage** :
  - *Qualité de liaison* : vert foncé pour plus de 10 dB au-delà de la marge, vert clair pour une marge respectée, orange pour une liaison instable ;
  - *Meilleure station* : couleur de la station la mieux reçue en chaque point.
- **Clic sur la carte** : marge de chaque station en ce point, altitude, et bouton « Profil » qui trace la coupe du terrain avec la ligne de visée et la zone de Fresnel.
- **Liaisons entre stations** : marge de chaque paire (base ↔ relais, véhicule ↔ remorque…). Les paires relais ↔ relais sont exclues.
  Cliquer sur une ligne affiche le profil.
- **Scénario** : enregistré automatiquement dans le navigateur.
  « Copier le lien » produit une URL qui contient tout le scénario, à envoyer par message.
  « Exporter » et « Importer » passent par un fichier JSON.

## Lancer en local

Les modules JavaScript et les Web Workers ne fonctionnent pas en ouvrant `index.html` directement (`file://`).
Il faut un petit serveur :

```bash
cd radiomap
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Mettre en ligne

Le site est publié automatiquement sur GitHub Pages : **https://blefeuvr.github.io/radiomap/**

Chaque push sur `main` déclenche le workflow `.github/workflows/pages.yml`.
Il vérifie que les modules JavaScript se chargent, puis publie `index.html`, `css/` et `js/`.
On peut aussi le relancer à la main depuis l'onglet Actions (« Run workflow »).

Le dépôt doit avoir Settings → Pages → Source réglé sur **GitHub Actions**.

Comme il n'y a rien à compiler, n'importe quel autre hébergement statique convient aussi : il suffit de copier ces fichiers.

## Méthode

| Étape | Détail |
|---|---|
| Relief | IGN RGE ALTI via la Géoplateforme (WMTS `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES`, tuiles float32). Pas de ~38 m jusqu'à 40 km de rayon (~19 m jusqu'à 12 km), et ~5 m dans les 2 km autour de l'antenne. |
| Géométrie | Rayons lancés depuis la station tous les ~60 m en bout de rayon, avec un point tous les 25 à 40 m. Courbure terrestre avec k = 4/3. |
| Propagation | Espace libre, plus diffraction par la méthode de Deygout (arête principale et 2 secondaires, UIT-R P.526). C'est le modèle de l'étude « crapahute », porté en JavaScript : les résultats concordent à quelques dB. |
| Bilan | PLmax = P_tx + G_tx − L_tx + G_rx − L_rx − S_rx − marge, calculé dans les deux sens. Le sens le plus défavorable est retenu (en général portatif → station). |
| Classes | Marge restante ≥ 10 dB : très bonne. ≥ 0 : bonne. Entre −marge et 0 : instable (au-dessus de la sensibilité, mais sans la marge de sécurité). |

Le calcul de propagation d'un relais à 30 km prend environ 1 s.
Le premier chargement du relief d'une zone prend de 5 à 40 s selon la Géoplateforme.
Ensuite, le navigateur garde le relief en cache 21 jours.

### Limites

- **Ni la forêt ni le bâti ne sont modélisés.** Le paramètre « Pertes supplémentaires » permet d'en tenir compte globalement (5 à 15 dB en forêt dense).
- Une antenne posée sur une crête alignée avec la direction de calcul peut faire apparaître des stries en éventail. Ces zones sont réellement incertaines.
- Résultat **indicatif** : faites toujours un essai radio lors de la reconnaissance.

## Paramètres par défaut

Ils sont repris de l'étude « crapahute » (fiches techniques Motorola du drive Pôle Technique), et réglés dans `js/config.js`.

| Matériel | Puissance | Gain | Câble | Hauteur | Rayon |
|---|---|---|---|---|---|
| Relais fixe DR3000 (Saint-Eynard) | 25 W | 3 dBi | 3 dB | 10 m | 30 km |
| Remorque relais SLR1000 | 10 W | 2 dBi | 2 dB | 6 m | 15 km |
| Base DM2600 sur mât | 25 W | 2 dBi | 2 dB | 6 m | 15 km |
| Véhicule DM2600 | 25 W | 0 dBi | 2 dB | 1,8 m | 10 km |
| Portatif DP2400 | 5 W | −4,5 dBi (effet du corps inclus) | 0 | 1,5 m | 6 km |

Sensibilité : −119 dBm (0,25 µV à 5 % de BER). Fréquence : 167 MHz. Marge de sécurité : 15 dB.
Avec ces valeurs, on retrouve les seuils de crapahute : portatif ↔ relais ou base ≈ 136 dB, ↔ véhicule ≈ 134 dB, ↔ portatif 132 dB.

**Valeurs à confirmer** : position exacte et hauteur du mât au fort du Saint-Eynard, gains d'antenne réels,
pertes câble et duplexeur, fréquences des canaux.

## Fichiers

```
index.html             page et panneau latéral
css/style.css          mise en forme (responsive)
js/config.js           catalogue matériel, paramètres par défaut, bilan de liaison
js/app.js              interface : carte, stations, liaisons, scénarios
js/dem.js              relief IGN : tuiles, mosaïque, profils
js/propagation.js      espace libre, Deygout, courbure terrestre
js/coverage.js         lancer de rayons et rastérisation
js/coverage-worker.js  calcul de propagation en parallèle (Web Workers)
js/render.js           image de couverture combinée (Web Mercator)
js/profile.js          dessin du profil de liaison
```

## Sources

Fonds de carte © IGN Géoplateforme (Plan IGN, photos aériennes, ombrage), © OpenStreetMap, © OpenTopoMap.
Relief : IGN RGE ALTI. Bibliothèque cartographique : Leaflet.
