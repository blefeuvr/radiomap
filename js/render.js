// Rendu de la couverture combinée en image (projection Web Mercator, pour
// se superposer exactement aux fonds de carte Leaflet).
import { QUALITY, DEAD_COLOR } from './config.js';

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const imerc = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
const MAX_PX = 2400;

export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function qualityColor(m) {
  if (m >= QUALITY[0].min) return QUALITY[0].color;
  if (m >= QUALITY[1].min) return QUALITY[1].color;
  return QUALITY[2].color;
}

// layers : [{ res, allowed, rgb }] ; opts : { mode, extraLossDb, marginDb, showDead }
// Une liaison est « instable » si la marge restante est entre -marginDb et 0 :
// le signal dépasse la sensibilité mais sans la marge de sécurité.
export function renderComposite(layers, opts) {
  if (!layers.length) return null;
  const south = Math.min(...layers.map((l) => l.res.south));
  const north = Math.max(...layers.map((l) => l.res.north));
  const west = Math.min(...layers.map((l) => l.res.west));
  const east = Math.max(...layers.map((l) => l.res.east));
  const yN = merc(north), yS = merc(south);
  const spanX = ((east - west) * Math.PI) / 180;
  let W = Math.ceil((east - west) / Math.min(...layers.map((l) => l.res.dLon)));
  let H = Math.round((W * (yN - yS)) / spanX);
  const k = Math.min(1, MAX_PX / Math.max(W, H));
  W = Math.max(1, Math.round(W * k)); H = Math.max(1, Math.round(H * k));

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const lowAlpha = 120;
  const stats = { good: 0, unstable: 0, dead: 0 }; // en km²
  const L = layers.length;
  const rows = new Int32Array(L), ok = new Uint8Array(L);
  const lonStep = (east - west) / W;

  for (let y = 0; y < H; y++) {
    const lat = imerc(yN - ((y + 0.5) / H) * (yN - yS));
    const pxArea = (lonStep * 111.32 * Math.cos((lat * Math.PI) / 180)) *
      ((imerc(yN - (y / H) * (yN - yS)) - imerc(yN - ((y + 1) / H) * (yN - yS))) * 110.54);
    for (let j = 0; j < L; j++) {
      const r = layers[j].res;
      rows[j] = Math.round(r.half - (lat - r.lat0) / r.dLat);
      ok[j] = rows[j] >= 0 && rows[j] < r.n ? 1 : 0;
    }
    for (let x = 0; x < W; x++) {
      const lon = west + (x + 0.5) * lonStep;
      let best = -Infinity, bi = -1;
      for (let j = 0; j < L; j++) {
        if (!ok[j]) continue;
        const r = layers[j].res;
        const c = Math.round(r.half + (lon - r.lon0) / r.dLon);
        if (c < 0 || c >= r.n) continue;
        const v = r.grid[rows[j] * r.n + c];
        if (v !== v) continue; // NaN : hors du rayon de calcul
        const m = layers[j].allowed - v - opts.extraLossDb;
        if (m > best) { best = m; bi = j; }
      }
      if (bi < 0) continue;
      const o = (y * W + x) * 4;
      let col, a = 255;
      if (best >= 0) {
        stats.good += pxArea;
        col = opts.mode === 'station' ? layers[bi].rgb : qualityColor(best);
      } else if (best >= -opts.marginDb) {
        stats.unstable += pxArea;
        if (opts.mode === 'station') { col = layers[bi].rgb; a = lowAlpha; } else col = QUALITY[2].color;
      } else {
        stats.dead += pxArea;
        if (!opts.showDead) continue;
        col = DEAD_COLOR; a = 150;
      }
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, bounds: [[south, west], [north, east]], stats };
}
