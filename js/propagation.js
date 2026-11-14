// Modèle de propagation : espace libre + diffraction par le relief
// (méthode de Deygout, arête principale + 2 arêtes secondaires),
// courbure terrestre avec k = 4/3. Repris de l'étude « crapahute ».
// Ni la végétation ni le bâti ne sont pris en compte (cf. pertes supplémentaires).

export const KR = 8.5e6; // rayon terrestre équivalent (k = 4/3), en m

export function fspl(dM, fMHz) {
  return 32.44 + 20 * Math.log10(Math.max(dM, 20) / 1000) + 20 * Math.log10(fMHz);
}

// Perte d'une arête en lame de couteau (UIT-R P.526)
export function knifeEdge(nu) {
  if (nu <= -0.78) return 0;
  const t = nu - 0.1;
  return 6.9 + 20 * Math.log10(Math.sqrt(t * t + 1) + t);
}

// Recherche de l'arête la plus pénalisante entre i0 et i1 (exclus).
// z : altitudes déjà corrigées de la courbure (z - s²/2kR), s : distances.
// h0, h1 : altitudes absolues de la ligne de visée aux extrémités.
function worstEdge(s, z, i0, i1, h0, h1, lam) {
  if (i1 - i0 < 2) return null;
  const s0 = s[i0], D = s[i1] - s0;
  if (D <= 0) return null;
  const slope = (h1 - h0) / D;
  let best = -Infinity, k = -1;
  for (let i = i0 + 1; i < i1; i++) {
    const d1 = s[i] - s0, d2 = D - d1;
    const h = z[i] - (h0 + slope * d1);
    const nu = h * Math.sqrt((2 * D) / (lam * d1 * d2));
    if (nu > best) { best = nu; k = i; }
  }
  return k < 0 ? null : { k, nu: best };
}

// Pertes par diffraction (dB) sur le profil [0..n], antennes ha, hb au-dessus du sol.
export function diffractionLoss(s, z, n, ha, hb, lam) {
  const za = z[0] + ha, zb = z[n] + hb;
  const w = worstEdge(s, z, 0, n, za, zb, lam);
  if (!w || w.nu <= -0.78) return 0;
  let loss = knifeEdge(w.nu);
  const k = w.k;
  const w1 = worstEdge(s, z, 0, k, za, z[k], lam);
  if (w1) loss += knifeEdge(w1.nu);
  const w2 = worstEdge(s, z, k, n, z[k], zb, lam);
  if (w2) loss += knifeEdge(w2.nu);
  return loss;
}

// Applique la courbure terrestre en place : z'(s) = z(s) - s² / 2kR.
// Le résultat est rigoureusement équivalent au « renflement » s(d-s)/2kR
// pour toute liaison partant de s = 0, quelle que soit sa longueur.
export function applyCurvature(s, z) {
  for (let i = 0; i < z.length; i++) z[i] -= (s[i] * s[i]) / (2 * KR);
  return z;
}

// Affaiblissement total sur un profil (distances s, altitudes brutes z).
export function pathLoss(s, zRaw, ha, hb, fMHz) {
  const z = applyCurvature(s, Float64Array.from(zRaw));
  const n = s.length - 1;
  const lam = 299.792458 / fMHz;
  const diff = diffractionLoss(s, z, n, ha, hb, lam);
  const free = fspl(s[n], fMHz);
  return { total: free + diff, free, diff };
}

// Distance (m) et cap entre deux points (approximation plane locale, < 100 km).
export function localXY(lat0, lon0, lat, lon) {
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 110540;
  return [(lon - lon0) * mx, (lat - lat0) * my];
}
export function distanceM(a, b) {
  const [x, y] = localXY(a.lat, a.lon, b.lat, b.lon);
  return Math.hypot(x, y);
}
