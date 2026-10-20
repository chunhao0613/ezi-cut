// 運動追蹤：在影片裡追住一個物體，把位置寫成另一個片段（文字、貼圖、圖片）的關鍵影格
// 方法：縮小成灰階後做樣板比對（正規化互相關），逐格在上一格位置附近搜尋
import { store, emit, checkpoint, getProp } from './state.js';
import { srcAt, srcLength, localAt } from './timemap.js';

const WORK_W = 320; // 追蹤時的工作解析度
const SAMPLE_FPS = 15; // 每秒寫入幾個關鍵影格

function gray(canvas, w, h, ctx) {
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return g;
}

function patch(img, w, cx, cy, s) {
  const p = new Float32Array(s * s);
  const x0 = Math.round(cx - s / 2);
  const y0 = Math.round(cy - s / 2);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) p[y * s + x] = img[(y0 + y) * w + (x0 + x)] || 0;
  return p;
}

function normalize(p) {
  let m = 0;
  for (const v of p) m += v;
  m /= p.length;
  let s = 0;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) {
    out[i] = p[i] - m;
    s += out[i] * out[i];
  }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

// 正規化互相關：1 = 完全相同
function ncc(img, w, h, tpl, s, cx, cy) {
  const x0 = Math.round(cx - s / 2);
  const y0 = Math.round(cy - s / 2);
  if (x0 < 0 || y0 < 0 || x0 + s > w || y0 + s > h) return -1;
  let m = 0;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) m += img[(y0 + y) * w + x0 + x];
  m /= s * s;
  let dot = 0;
  let ss = 0;
  for (let y = 0; y < s; y++) {
    const row = (y0 + y) * w + x0;
    for (let x = 0; x < s; x++) {
      const v = img[row + x] - m;
      dot += v * tpl[y * s + x];
      ss += v * v;
    }
  }
  return dot / (Math.sqrt(ss) || 1);
}

function search(img, w, h, tpl, s, px, py, R) {
  let best = { x: px, y: py, score: -2 };
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
    const sc = ncc(img, w, h, tpl, s, px + dx, py + dy);
    if (sc > best.score) best = { x: px + dx, y: py + dy, score: sc };
  }
  const c = best;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const sc = ncc(img, w, h, tpl, s, c.x + dx, c.y + dy);
    if (sc > best.score) best = { x: c.x + dx, y: c.y + dy, score: sc };
  }
  return best;
}

/**
 * 從播放頭開始追蹤，把 target 的 x / y 寫成關鍵影格
 * @param box 影片片段在畫面上的範圍（renderer.boxes），用來換算座標
 */
export async function trackObject(video, target, box, { size = 96, onProgress } = {}) {
  const m = store.media.get(video.mediaId);
  if (!m?.blob) throw new Error('找不到影片檔');
  const t0 = store.time;
  const tEnd = Math.min(video.start + video.duration, target.start + target.duration);
  if (t0 < video.start || t0 >= tEnd) throw new Error('播放頭要同時在影片與追蹤目標的時間範圍內');
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  const dw = vt.displayWidth;
  const dh = vt.displayHeight;
  const k = WORK_W / dw;
  const w = WORK_W;
  const h = Math.round(dh * k);
  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const wctx = work.getContext('2d', { willReadFrequently: true });

  // 畫面座標 ↔ 影片工作座標（考慮裁切；假設影片沒有旋轉）
  const cr = video.crop || { l: 0, t: 0, r: 0, b: 0 };
  const cw = 1 - cr.l - cr.r;
  const ch = 1 - cr.t - cr.b;
  const { width: W, height: H } = store.project;
  const toWork = (px, py) => [((cr.l + ((px - (box.cx - box.w / 2)) / box.w) * cw) * dw) * k, ((cr.t + ((py - (box.cy - box.h / 2)) / box.h) * ch) * dh) * k];
  const toProj = (wx, wy) => [box.cx - box.w / 2 + ((wx / k / dw - cr.l) / cw) * box.w, box.cy - box.h / 2 + ((wy / k / dh - cr.t) / ch) * box.h];

  const lt0 = t0 - target.start;
  const x0 = getProp(target, 'x', lt0);
  const y0 = getProp(target, 'y', lt0);
  const [sx, sy] = toWork(W / 2 + x0, H / 2 + y0);
  // 樣板大小：以畫面像素換算到工作解析度
  const s = Math.max(12, Math.min(64, Math.round(((size / box.w) * cw * dw * k) / 2) * 2));
  const R = Math.round(s * 0.75);

  const srcStart = srcAt(video, t0 - video.start);
  const srcEnd = Math.min(m.duration, video.in + srcLength(video), srcAt(video, tEnd - video.start));
  const points = [{ t: lt0, x: x0, y: y0 }];
  let tpl = null;
  let pos = { x: sx, y: sy };
  let nextSample = t0;
  let lost = 0;
  try {
    for await (const f of new CanvasSink(vt, { width: w, height: h, fit: 'fill' }).canvases(srcStart, srcEnd)) {
      const tl = video.start + localAt(video, f.timestamp - video.in); // 影格在時間軸上的時間
      if (tl < nextSample - 1e-3) continue;
      const img = gray(f.canvas, w, h, wctx);
      if (!tpl) {
        tpl = normalize(patch(img, w, pos.x, pos.y, s));
      } else {
        const r = search(img, w, h, tpl, s, pos.x, pos.y, R);
        if (r.score > 0.4) {
          pos = r;
          lost = 0;
          // 外觀慢慢變化時更新樣板，但保留大部分原樣以免漂移
          if (r.score > 0.7) {
            const fresh = normalize(patch(img, w, pos.x, pos.y, s));
            for (let i = 0; i < tpl.length; i++) tpl[i] = tpl[i] * 0.85 + fresh[i] * 0.15;
            tpl = normalize(tpl);
          }
        } else if (++lost > SAMPLE_FPS) break; // 跟丟超過一秒就停止
        const [px, py] = toProj(pos.x, pos.y);
        points.push({ t: tl - target.start, x: x0 + (px - (W / 2 + x0)), y: y0 + (py - (H / 2 + y0)) });
      }
      nextSample = tl + 1 / SAMPLE_FPS;
      onProgress?.(Math.min(1, (tl - t0) / Math.max(0.01, tEnd - t0)));
    }
  } finally {
    input.dispose?.();
  }
  if (points.length < 2) throw new Error('追蹤失敗：找不到可追蹤的特徵，試試把追蹤框放在對比明顯的物體上');
  checkpoint();
  target.keyframes ||= {};
  for (const prop of ['x', 'y']) {
    const keep = (target.keyframes[prop] || []).filter((kf) => kf.t < lt0 - 1e-3);
    target.keyframes[prop] = [...keep, ...points.map((p) => ({ t: p.t, v: Math.round(p[prop] * 10) / 10 }))];
  }
  emit('layout');
  emit('props');
  return { frames: points.length, lostEarly: lost > SAMPLE_FPS };
}
