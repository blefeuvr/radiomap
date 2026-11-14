// Calcul de couverture d'une station : lancer de rayons sur le relief IGN,
// propagation répartie sur plusieurs Web Workers, puis rastérisation sur
// une grille régulière centrée sur la station.
//
// Le résultat stocke l'affaiblissement de propagation brut (dB). La marge
// dépend ensuite du bilan de liaison, recalculé à l'affichage : changer une
// puissance, un gain ou la marge ne relance pas le calcul.
import { loadMosaic, sample } from './dem.js';
import { KR } from './propagation.js';

const NW = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
let workers = null;
let jobId = 0;

function getWorkers() {
  if (!workers) {
    workers = Array.from({ length: NW }, () =>
      new Worker(new URL('./coverage-worker.js', import.meta.url), { type: 'module' }));
  }
  return workers;
}

function runJob(worker, msg, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      if (e.data.out) { cleanup(); resolve(e.data.out); } else onProgress?.(e.data.progress);
    };
    const onErr = (e) => { cleanup(); reject(new Error(e.message || 'Erreur du calcul')); };
    const cleanup = () => { worker.removeEventListener('message', onMsg); worker.removeEventListener('error', onErr); };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({ ...msg, id }, [msg.prof.buffer]);
  });
}

// Résolution adaptée au rayon : relief plus fin pour les petites zones.
function resolutionFor(radiusM) {
  if (radiusM <= 12000) return { z: 12, step: 25 };
  if (radiusM <= 40000) return { z: 11, step: 40 };
  return { z: 10, step: 75 };
}

export async function computeCoverage(st, { rxH, fMHz }, onProgress) {
  const R = st.radiusKm * 1000;
  const { z, step } = resolutionFor(R);
  const lat0 = st.lat, lon0 = st.lon;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 110540;
  const dLatR = R / my, dLonR = R / mx;

  const T = [performance.now()];
  // 1. Relief
  const mosaic = await loadMosaic(
    { south: lat0 - dLatR - 0.002, north: lat0 + dLatR + 0.002, west: lon0 - dLonR - 0.002, east: lon0 + dLonR + 0.002 },
    z, (d, n) => onProgress?.(`relief IGN ${d}/${n} tuiles`, 0.25 * d / n));
  // Champ proche : relief fin (~5 m). C'est là que se joue le masquage par un
  // bord de falaise ou une crête proche de l'antenne.
  const NEAR = Math.min(2000, R);
  const dLatN = NEAR / my + 0.001, dLonN = NEAR / mx + 0.001;
  const fine = await loadMosaic(
    { south: lat0 - dLatN, north: lat0 + dLatN, west: lon0 - dLonN, east: lon0 + dLonN },
    13, (d, n) => onProgress?.(`relief fin ${d}/${n} tuiles`, 0.25 + 0.05 * d / n));

  T.push(performance.now());
  // 2. Profils le long des rayons. Dans le champ proche, chaque échantillon
  // retient le point le plus haut de son segment, pour ne manquer aucune crête.
  const nS = Math.ceil(R / step) + 1;
  const nRays = Math.max(360, Math.min(4096, Math.ceil((2 * Math.PI * R) / (1.5 * step))));
  const prof = new Float32Array(nRays * nS);
  const SUB = 6;
  for (let r = 0; r < nRays; r++) {
    const az = (2 * Math.PI * r) / nRays;
    const ca = Math.cos(az) / my, sa = Math.sin(az) / mx;
    const o = r * nS;
    prof[o] = sample(fine, lat0, lon0);
    for (let i = 1; i < nS; i++) {
      const d = i * step;
      let h;
      if (d <= NEAR) {
        h = -Infinity;
        for (let k = 0; k < SUB; k++) {
          const dd = d + ((k + 0.5) / SUB - 0.5) * step;
          h = Math.max(h, sample(fine, lat0 + dd * ca, lon0 + dd * sa));
        }
      } else {
        h = sample(mosaic, lat0 + d * ca, lon0 + d * sa);
      }
      prof[o + i] = h - (d * d) / (2 * KR);
    }
  }

  T.push(performance.now());
  // 3. Propagation, répartie entre les workers
  const ws = getWorkers();
  const per = Math.ceil(nRays / ws.length);
  const prog = new Array(ws.length).fill(0);
  const report = () => onProgress?.('propagation', 0.3 + 0.65 * prog.reduce((a, b) => a + b, 0) / ws.length);
  const parts = await Promise.all(ws.map((w, k) => {
    const r0 = k * per, r1 = Math.min(nRays, r0 + per);
    if (r1 <= r0) return Promise.resolve(new Float32Array(0));
    const chunk = prof.slice(r0 * nS, r1 * nS);
    return runJob(w, { prof: chunk, nRays: r1 - r0, nS, step, ha: st.height, hb: rxH, fMHz },
      (p) => { prog[k] = p; report(); });
  }));
  const loss = new Float32Array(nRays * nS);
  let off = 0;
  for (const p of parts) { loss.set(p, off); off += p.length; }

  T.push(performance.now());
  // 4. Rastérisation polaire -> grille (interpolation bilinéaire)
  onProgress?.('assemblage', 0.97);
  const half = Math.ceil(R / step), n = 2 * half + 1;
  const grid = new Float32Array(n * n).fill(NaN);
  const TWO_PI = 2 * Math.PI;
  for (let row = 0; row < n; row++) {
    const y = (half - row) * step;
    for (let col = 0; col < n; col++) {
      const x = (col - half) * step;
      const d = Math.hypot(x, y);
      if (d > R) continue;
      let az = Math.atan2(x, y); if (az < 0) az += TWO_PI;
      const fr = (az / TWO_PI) * nRays, r0 = Math.floor(fr) % nRays, r1 = (r0 + 1) % nRays, tr = fr - Math.floor(fr);
      const fi = d / step, i0 = Math.min(Math.floor(fi), nS - 1), i1 = Math.min(i0 + 1, nS - 1), ti = fi - Math.floor(fi);
      const a = loss[r0 * nS + i0] * (1 - ti) + loss[r0 * nS + i1] * ti;
      const b = loss[r1 * nS + i0] * (1 - ti) + loss[r1 * nS + i1] * ti;
      grid[row * n + col] = a * (1 - tr) + b * tr;
    }
  }
  T.push(performance.now());
  console.debug(`[couverture] ${nRays} rayons × ${nS} pts, ${ws.length} workers ; relief ${ms(T[1] - T[0])}, profils ${ms(T[2] - T[1])}, propagation ${ms(T[3] - T[2])}, grille ${ms(T[4] - T[3])}`);
  const dLat = step / my, dLon = step / mx;
  return {
    grid, n, half, dLat, dLon, lat0, lon0, step, radiusM: R,
    south: lat0 - half * dLat, north: lat0 + half * dLat,
    west: lon0 - half * dLon, east: lon0 + half * dLon,
  };
}

// Affaiblissement calculé en un point (NaN hors zone).
const ms = (t) => `${(t / 1000).toFixed(1)} s`;

export function lookupLoss(res, lat, lon) {
  const row = Math.round(res.half - (lat - res.lat0) / res.dLat);
  const col = Math.round(res.half + (lon - res.lon0) / res.dLon);
  if (row < 0 || col < 0 || row >= res.n || col >= res.n) return NaN;
  return res.grid[row * res.n + col];
}
