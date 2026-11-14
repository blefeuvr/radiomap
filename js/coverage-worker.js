// Calcule l'affaiblissement de propagation le long d'un paquet de rayons.
// Chaque rayon part de la station (indice 0) ; les altitudes reçues sont
// déjà corrigées de la courbure terrestre.
import { diffractionLoss, fspl } from './propagation.js';

self.onmessage = (e) => {
  const { id, prof, nRays, nS, step, ha, hb, fMHz } = e.data;
  const lam = 299.792458 / fMHz;
  const s = new Float64Array(nS);
  for (let i = 0; i < nS; i++) s[i] = i * step;
  const free = new Float64Array(nS);
  for (let i = 0; i < nS; i++) free[i] = fspl(s[i], fMHz);
  const out = new Float32Array(nRays * nS);
  for (let r = 0; r < nRays; r++) {
    const z = prof.subarray(r * nS, (r + 1) * nS);
    const o = r * nS;
    out[o] = free[0];
    for (let n = 1; n < nS; n++) out[o + n] = free[n] + diffractionLoss(s, z, n, ha, hb, lam);
    if ((r & 15) === 15) self.postMessage({ id, progress: (r + 1) / nRays });
  }
  self.postMessage({ id, out }, [out.buffer]);
};
