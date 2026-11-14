// Catalogue du matériel radio APC 38 et paramètres par défaut.
//
// Bilan de liaison : affaiblissement maximal admissible entre A et B
//   PLmax = P_tx + G_tx - L_tx + G_rx - L_rx - S_rx - marge
// calculé dans les deux sens ; on retient le sens le plus défavorable.
//
// Les valeurs reprennent les hypothèses de l'étude « crapahute » (fiches
// techniques Motorola, drive Pôle Technique). Avec la marge de 15 dB elles
// redonnent ses seuils : portatif ↔ DR3000 136,5 dB, ↔ SLR1000 136,5 dB,
// ↔ base DM2600 136,5 dB, ↔ véhicule DM2600 134,5 dB, ↔ portatif 132 dB.
// Le gain d'antenne du portatif (-4,5 dBi) inclut l'effet du corps.
// Tout est modifiable dans l'appli, station par station.

export const EQUIPMENT = {
  DR3000: {
    label: 'Relais fixe DR3000', short: 'Relais fixe', letter: 'R', role: 'relais',
    txW: 25, gainDbi: 3, cableDb: 3, sensDbm: -119, height: 10, radiusKm: 30,
  },
  SLR1000: {
    label: 'Relais remorque SLR1000', short: 'Remorque relais', letter: 'R', role: 'relais',
    txW: 10, gainDbi: 2, cableDb: 2, sensDbm: -119, height: 6, radiusKm: 15,
  },
  BASE: {
    label: 'Base DM2600 sur mât', short: 'Base / PC', letter: 'B', role: 'direct',
    txW: 25, gainDbi: 2, cableDb: 2, sensDbm: -119, height: 6, radiusKm: 15,
  },
  VEHICULE: {
    label: 'Véhicule DM2600', short: 'Véhicule', letter: 'V', role: 'direct',
    txW: 25, gainDbi: 0, cableDb: 2, sensDbm: -119, height: 1.8, radiusKm: 10,
  },
  PORTATIF: {
    label: 'Portatif DP2400', short: 'Portatif', letter: 'P', role: 'direct',
    txW: 5, gainDbi: -4.5, cableDb: 0, sensDbm: -119, height: 1.5, radiusKm: 6,
  },
  CUSTOM: {
    label: 'Antenne spécifique', short: 'Antenne', letter: 'A', role: 'direct',
    txW: 25, gainDbi: 3, cableDb: 2, sensDbm: -119, height: 10, radiusKm: 15,
  },
};

// Terminal « en face » pour lequel on dessine la couverture.
export const TERMINALS = {
  PORTATIF: { ...EQUIPMENT.PORTATIF, label: 'Portatif tenu à la main (1,5 m)' },
  VEHICULE: { ...EQUIPMENT.VEHICULE, label: 'Véhicule DM2600 (1,8 m)' },
};

export const DEFAULT_PARAMS = {
  fMHz: 167,          // VHF, bande des canaux APC
  marginDb: 15,       // marge de sécurité (évanouissements, masques locaux)
  extraLossDb: 0,     // pertes supplémentaires (forêt, bâtiments…)
  terminal: 'PORTATIF',
  mode: 'qualite',    // qualite | station
  opacity: 0.6,
  showDead: false,    // afficher les zones sans liaison
  showLinks: true,
  auto: true,
};

export const STATION_COLORS = [
  '#1f77b4', '#d62728', '#9467bd', '#ff7f0e', '#17becf',
  '#e377c2', '#8c564b', '#bcbd22', '#2ca02c', '#7f7f7f',
];

export const DEFAULT_STATIONS = [
  {
    name: 'Relais Saint-Eynard', type: 'DR3000',
    lat: 45.23664, lon: 5.76087, // sommet du fort, 1347 m
  },
];

export const dbmFromW = (w) => 10 * Math.log10(w * 1000);

// Affaiblissement max admissible entre deux équipements (dB), marge déduite.
export function allowedLoss(a, b, marginDb) {
  const ab = dbmFromW(a.txW) + a.gainDbi - a.cableDb + b.gainDbi - b.cableDb - b.sensDbm;
  const ba = dbmFromW(b.txW) + b.gainDbi - b.cableDb + a.gainDbi - a.cableDb - a.sensDbm;
  return Math.min(ab, ba) - marginDb;
}

// Seuils d'affichage, en dB de marge restante (marge de sécurité déjà déduite).
export const QUALITY = [
  { min: 10, color: [26, 150, 65], label: 'Très bonne (> 10 dB au-delà de la marge)' },
  { min: 0, color: [140, 210, 90], label: 'Bonne (marge de sécurité respectée)' },
  { min: null, color: [253, 174, 97], label: 'Instable (sous la marge de sécurité)' },
];
export const DEAD_COLOR = [215, 25, 28];
