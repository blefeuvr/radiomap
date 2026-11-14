// Relief IGN RGE ALTI via la Géoplateforme (WMTS, tuiles float32 « BIL »).
// Gratuit, sans clé, CORS ouvert. Grille géographique WGS84G :
// au niveau z, une tuile de 256 px couvre 180/2^z degrés.
//   z = 12 → ~19 m (lat) × ~14 m (lon) par pixel à 45° N
//   z = 11 → ~38 m × ~27 m

const LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MAX_Z = 14;
const TILE = 256;

const cache = new Map(); // "z/col/row" -> Promise<Float32Array>

function tileUrl(z, col, row) {
  return 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${LAYER}&STYLE=normal&FORMAT=image/x-bil;bits=32` +
    `&TILEMATRIXSET=WGS84G&TILEMATRIX=${z}&TILECOL=${col}&TILEROW=${row}`;
}

async function fetchTile(z, col, row) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(tileUrl(z, col, row));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (buf.byteLength !== TILE * TILE * 4) throw new Error(`taille ${buf.byteLength}`);
      const a = new Float32Array(buf);
      // Hors couverture (mer, étranger) : valeur « nodata » très négative.
      for (let i = 0; i < a.length; i++) if (!(a[i] > -500)) a[i] = 0;
      return a;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
    }
  }
  throw new Error(`Relief IGN indisponible (tuile ${z}/${col}/${row}) : ${lastErr.message}`);
}

function getTile(z, col, row) {
  const key = `${z}/${col}/${row}`;
  let p = cache.get(key);
  if (!p) {
    p = fetchTile(z, col, row);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

const tileDeg = (z) => 180 / 2 ** z;

// Exécute des tâches asynchrones avec un parallélisme limité.
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

// Assemble une mosaïque couvrant bbox {south, north, west, east}.
export async function loadMosaic(bbox, z, onProgress) {
  z = Math.min(z, MAX_Z);
  const s = tileDeg(z);
  const c0 = Math.floor((bbox.west + 180) / s), c1 = Math.floor((bbox.east + 180) / s);
  const r0 = Math.floor((90 - bbox.north) / s), r1 = Math.floor((90 - bbox.south) / s);
  const nc = c1 - c0 + 1, nr = r1 - r0 + 1;
  const w = nc * TILE, h = nr * TILE;
  const data = new Float32Array(w * h);
  const jobs = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) jobs.push([c, r]);
  let done = 0;
  await pool(jobs, 10, async ([c, r]) => {
    const t = await getTile(z, c, r);
    const ox = (c - c0) * TILE, oy = (r - r0) * TILE;
    for (let y = 0; y < TILE; y++) data.set(t.subarray(y * TILE, (y + 1) * TILE), (oy + y) * w + ox);
    onProgress?.(++done, jobs.length);
  });
  return { z, p: s / TILE, lonL: c0 * s - 180, latT: 90 - r0 * s, w, h, data };
}

// Échantillonnage bilinéaire (valeurs aux centres des pixels).
export function sample(m, lat, lon) {
  let fx = (lon - m.lonL) / m.p - 0.5, fy = (m.latT - lat) / m.p - 0.5;
  fx = Math.min(Math.max(fx, 0), m.w - 1.001);
  fy = Math.min(Math.max(fy, 0), m.h - 1.001);
  const x = fx | 0, y = fy | 0, tx = fx - x, ty = fy - y;
  const d = m.data, i = y * m.w + x;
  return (d[i] * (1 - tx) + d[i + 1] * tx) * (1 - ty) + (d[i + m.w] * (1 - tx) + d[i + m.w + 1] * tx) * ty;
}

function bboxAround(points, padDeg = 0.002) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  return {
    south: Math.min(...lats) - padDeg, north: Math.max(...lats) + padDeg,
    west: Math.min(...lons) - padDeg, east: Math.max(...lons) + padDeg,
  };
}

// Profil de terrain entre a et b : { s: distances (m), z: altitudes (m), lat, lon }.
export async function lineProfile(a, b, stepM = 15, z = 13) {
  const mx = 111320 * Math.cos((a.lat * Math.PI) / 180), my = 110540;
  const d = Math.hypot((b.lon - a.lon) * mx, (b.lat - a.lat) * my);
  const n = Math.max(20, Math.min(3000, Math.ceil(d / stepM)));
  // Niveau de détail adapté à la longueur pour limiter le nombre de tuiles.
  if (d > 40000) z = Math.min(z, 11); else if (d > 15000) z = Math.min(z, 12);
  const m = await loadMosaic(bboxAround([a, b]), z);
  const s = new Float64Array(n + 1), zz = new Float64Array(n + 1);
  const lat = new Float64Array(n + 1), lon = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    lat[i] = a.lat + (b.lat - a.lat) * t;
    lon[i] = a.lon + (b.lon - a.lon) * t;
    s[i] = d * t;
    zz[i] = sample(m, lat[i], lon[i]);
  }
  return { s, z: zz, lat, lon, d };
}

export async function elevationAt(lat, lon) {
  const m = await loadMosaic(bboxAround([{ lat, lon }], 0.0005), 12);
  return sample(m, lat, lon);
}
