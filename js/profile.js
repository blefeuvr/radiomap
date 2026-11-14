// Dessin d'un profil de liaison : relief (avec courbure terrestre),
// ligne de visée, 1re zone de Fresnel, obstacles.
import { KR } from './propagation.js';

export function drawProfile(canvas, prof, ha, hb, fMHz, labels) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { s, z } = prof, n = s.length - 1, d = s[n];
  const lam = 299.792458 / fMHz;
  // Relief « bombé » par la courbure, ligne de visée droite.
  const zb = Array.from(z, (v, i) => v + (s[i] * (d - s[i])) / (2 * KR));
  const za = zb[0] + ha, zz = zb[n] + hb;
  const los = (i) => za + ((zz - za) * s[i]) / d;
  const fres = (i) => Math.sqrt((lam * s[i] * (d - s[i])) / d);

  let lo = Math.min(...zb), hi = Math.max(...zb, za, zz);
  for (let i = 0; i <= n; i++) hi = Math.max(hi, los(i) + fres(i));
  const pad = (hi - lo) * 0.08 + 5; lo -= pad; hi += pad;

  const m = { l: 52, r: 14, t: 14, b: 26 };
  const W = cssW - m.l - m.r, H = cssH - m.t - m.b;
  const X = (sv) => m.l + (sv / d) * W;
  const Y = (h) => m.t + (1 - (h - lo) / (hi - lo)) * H;

  // Grille et axes
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#555'; ctx.strokeStyle = '#e3e3e3'; ctx.lineWidth = 1;
  const yStep = niceStep((hi - lo) / 5);
  for (let h = Math.ceil(lo / yStep) * yStep; h <= hi; h += yStep) {
    ctx.beginPath(); ctx.moveTo(m.l, Y(h)); ctx.lineTo(m.l + W, Y(h)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(`${Math.round(h)} m`, m.l - 4, Y(h) + 4);
  }
  const xStep = niceStep(d / 1000 / 8) * 1000;
  ctx.textAlign = 'center';
  for (let x = 0; x <= d + 1; x += xStep) {
    ctx.beginPath(); ctx.moveTo(X(x), m.t); ctx.lineTo(X(x), m.t + H); ctx.stroke();
    ctx.fillText(`${(x / 1000).toFixed(xStep < 1000 ? 1 : 0)} km`, X(x), m.t + H + 16);
  }

  // Zone de Fresnel (100 % et 60 %)
  ctx.fillStyle = 'rgba(31,119,180,0.10)';
  ctx.beginPath();
  for (let i = 0; i <= n; i++) ctx.lineTo(X(s[i]), Y(los(i) + fres(i)));
  for (let i = n; i >= 0; i--) ctx.lineTo(X(s[i]), Y(los(i) - fres(i)));
  ctx.fill();
  ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(31,119,180,0.6)';
  ctx.beginPath();
  for (let i = 0; i <= n; i++) ctx.lineTo(X(s[i]), Y(los(i) - 0.6 * fres(i)));
  ctx.stroke(); ctx.setLineDash([]);

  // Relief
  ctx.fillStyle = '#c9b48a'; ctx.strokeStyle = '#7a6a48'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(X(0), Y(lo));
  for (let i = 0; i <= n; i++) ctx.lineTo(X(s[i]), Y(zb[i]));
  ctx.lineTo(X(d), Y(lo)); ctx.closePath(); ctx.fill();
  ctx.beginPath(); for (let i = 0; i <= n; i++) ctx.lineTo(X(s[i]), Y(zb[i])); ctx.stroke();

  // Obstacles : relief au-dessus de la ligne de visée
  ctx.fillStyle = '#d7191c';
  for (let i = 1; i < n; i++) if (zb[i] > los(i)) ctx.fillRect(X(s[i]) - 1, Y(zb[i]) - 1, 2, 3);

  // Ligne de visée
  ctx.strokeStyle = '#1f77b4'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(0), Y(za)); ctx.lineTo(X(d), Y(zz)); ctx.stroke();

  // Antennes
  for (const [i, h, lab, align] of [[0, ha, labels.a, 'left'], [n, hb, labels.b, 'right']]) {
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(s[i]), Y(zb[i])); ctx.lineTo(X(s[i]), Y(zb[i] + h)); ctx.stroke();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(X(s[i]), Y(zb[i] + h), 3.5, 0, 7); ctx.fill();
    ctx.textAlign = align; ctx.font = 'bold 12px system-ui, sans-serif';
    const tx = align === 'left' ? X(s[i]) + 6 : X(s[i]) - 6;
    ctx.fillText(`${lab} (${Math.round(z[i])} m)`, tx, Math.max(m.t + 12, Y(zb[i] + h) - 6));
  }
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
