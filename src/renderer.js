// 畫面合成：把時間 t 的所有片段畫到 canvas 上，並同步影音元素
import { drawSticker } from './stickers.js';
import { store, getProp, getTrack } from './state.js';
import { clipMods, filterString } from './effects.js';
import { srcAt, speedAt } from './timemap.js';
import { GradePass, gradeActive, filtersActive, BUILTIN_LUTS } from './grade.js';

// AI 去背模組只在第一次用到時才載入（含模型下載）
let matteMod = null;
let matteLoading = null;
let matteFailedAt = 0;
export let matteError = null;
/** 載入 AI 去背模型；失敗時回傳 null，matteError 記錄原因，畫面迴圈 15 秒內不再自動重試（避免每格都重新下載） */
export function loadMatte({ force = false } = {}) {
  if (!matteMod && !matteLoading && !force && performance.now() - matteFailedAt < 15000) return Promise.resolve(null);
  return (matteLoading ||= import('./matte.js').then(async (m) => {
    await m.ensure();
    matteMod = m;
    matteError = null;
    return m;
  }).catch((e) => {
    console.warn('AI 去背載入失敗', e);
    matteError = e;
    matteFailedAt = performance.now();
    matteLoading = null;
    return null;
  }));
}

// LUT：使用者匯入的放在 store.luts，內建的第一次用到時產生
const builtinCache = new Map();
export function lutFor(id) {
  if (!id) return null;
  if (BUILTIN_LUTS[id]) {
    if (!builtinCache.has(id)) builtinCache.set(id, BUILTIN_LUTS[id].make());
    return builtinCache.get(id);
  }
  return store.luts?.get(id) || null;
}

const placeholders = new Map();
function placeholder(label) {
  if (placeholders.has(label)) return placeholders.get(label);
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 900;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 1600, 900);
  gr.addColorStop(0, '#334155');
  gr.addColorStop(1, '#1e293b');
  g.fillStyle = gr;
  g.fillRect(0, 0, 1600, 900);
  g.strokeStyle = 'rgba(255,255,255,.35)';
  g.setLineDash([30, 20]);
  g.lineWidth = 8;
  g.strokeRect(40, 40, 1520, 820);
  g.fillStyle = '#e2e8f0';
  g.font = 'bold 120px "Noto Sans TC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(`＋ ${label}`, 800, 450);
  placeholders.set(label, c);
  return c;
}

function maskPath(M, k, w, h) {
  const BIG = 1e5;
  M.beginPath();
  switch (k.type) {
    case 'rect':
      if (M.roundRect) M.roundRect(-w / 2, -h / 2, w, h, (k.radius || 0) * Math.min(w, h) / 2);
      else M.rect(-w / 2, -h / 2, w, h);
      break;
    case 'ellipse':
      M.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'linear':
      M.rect(-BIG, 0, BIG * 2, BIG); // 保留線的下方
      break;
    case 'band':
      M.rect(-BIG, -h / 2, BIG * 2, h); // 鏡面：保留一條水平帶
      break;
    case 'heart':
      M.moveTo(0, h * 0.35);
      M.bezierCurveTo(-w * 0.55, -h * 0.05, -w * 0.35, -h * 0.55, 0, -h * 0.2);
      M.bezierCurveTo(w * 0.35, -h * 0.55, w * 0.55, -h * 0.05, 0, h * 0.35);
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.2 : 0.5;
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        M[i ? 'lineTo' : 'moveTo'](Math.cos(a) * w * r, Math.sin(a) * h * r);
      }
      M.closePath();
      break;
  }
}

const VISUAL = new Set(['video', 'image', 'text', 'shape']);
const RAD = Math.PI / 180;

function mkCanvas(w, h, opts) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', opts)];
}
function hexRgb(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeGrain() {
  return [0, 1, 2, 3].map(() => {
    const [c, g] = mkCanvas(256, 256);
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random();
      const on = v > 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = on;
      img.data[i + 3] = Math.abs(v - 0.5) * 2 * 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// 中文字型是依字元範圍分片下載的，要把實際文字一起交給 fonts.load 才會載入需要的分片
const requestedFonts = new Set();
function ensureFont(spec, text = '') {
  const key = `${spec}|${text}`;
  if (requestedFonts.has(key)) return;
  requestedFonts.add(key);
  document.fonts?.load(spec, text || ' ').catch(() => {});
}
export const textFontSpec = (s) => `${s.italic ? 'italic ' : ''}${s.weight} ${s.size}px "${s.font}", "Noto Sans TC", sans-serif`;
/** 匯出前先把所有文字與貼圖用到的字型載完（最多等 8 秒），避免前幾格用到備用字型 */
export async function preloadFonts(clips) {
  if (!document.fonts) return;
  const jobs = [];
  for (const c of clips) {
    if (c.type === 'text' && c.text?.content) jobs.push(document.fonts.load(textFontSpec(c.text), c.text.content));
    if (c.type === 'shape' && c.shape?.kind === 'sticker') jobs.push(document.fonts.load('900 40px "Noto Sans TC"', c.shape.label || 'A'));
  }
  if (!jobs.length) return;
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 8000))]);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    [this.layer, this.L] = mkCanvas(1, 1);
    [this.tmp, this.T] = mkCanvas(1, 1);
    [this.chan, this.C] = mkCanvas(1, 1);
    [this.key, this.K] = mkCanvas(1, 1, { willReadFrequently: true });
    [this.mask, this.M] = mkCanvas(1, 1);
    this.matteCache = new Map();
    this.players = new Map();
    this.boxes = new Map();
    this.grain = makeGrain();
    this.audioCtx = null;
    this.master = null;
    this.recDest = null;
  }

  resize() {
    const { width: W, height: H } = store.project;
    if (this.layer.width !== W || this.layer.height !== H || this.canvas.width !== W || this.canvas.height !== H) {
      for (const c of [this.canvas, this.layer, this.tmp, this.chan]) {
        c.width = W;
        c.height = H;
      }
    }
  }

  ensureAudio() {
    if (this.audioCtx) return this.audioCtx;
    try {
      const ac = new AudioContext();
      this.master = ac.createGain();
      this.master.connect(ac.destination);
      this.recDest = ac.createMediaStreamDestination();
      this.master.connect(this.recDest);
      this.audioCtx = ac;
    } catch (e) {
      console.warn('AudioContext 無法建立', e);
    }
    return this.audioCtx;
  }

  // ---------- 影音元素 ----------
  player(clip) {
    const m = store.media.get(clip.mediaId);
    if (!m) return null;
    const kind = clip.type === 'audio' ? 'audio' : 'video';
    let p = this.players.get(clip.id);
    if (p && (p.url !== m.url || p.kind !== kind)) {
      this.dropPlayer(clip.id);
      p = null;
    }
    if (!p) {
      const el = document.createElement(kind);
      el.preload = 'auto';
      el.playsInline = true;
      el.src = m.url;
      p = { el, url: m.url, kind, gain: null };
      this.players.set(clip.id, p);
    }
    if (p.gain === null && this.audioCtx) {
      try {
        const src = this.audioCtx.createMediaElementSource(p.el);
        p.gain = this.audioCtx.createGain();
        src.connect(p.gain);
        p.gain.connect(this.master);
      } catch (e) {
        p.gain = false;
      }
    }
    return p;
  }
  dropPlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.el.pause();
    if (p.gain) p.gain.disconnect();
    p.el.removeAttribute('src');
    p.el.load();
    this.players.delete(id);
  }

  sync(time, playing) {
    const alive = new Set();
    for (const c of store.project.clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      alive.add(c.id);
      const p = this.player(c);
      if (!p) continue;
      const el = p.el;
      const end = c.start + c.duration;
      const active = time >= c.start && time < end;
      if (!active) {
        if (!el.paused) el.pause();
        // 預先定位即將出場的片段，避免播放時卡頓
        if (playing && c.start > time && c.start - time < 1.5 && !el.seeking && Math.abs(el.currentTime - c.in) > 0.1) el.currentTime = c.in;
        continue;
      }
      const src = srcAt(c, time - c.start);
      const rate = Math.min(16, Math.max(0.0625, speedAt(c, time - c.start)));
      if (el.playbackRate !== rate) el.playbackRate = rate;
      if (el.preservesPitch !== c.keepPitch) el.preservesPitch = c.keepPitch;

      const local = time - c.start;
      let v = c.volume;
      if (c.fadeIn > 0) v *= Math.min(1, local / c.fadeIn);
      if (c.fadeOut > 0) v *= Math.min(1, (c.duration - local) / c.fadeOut);
      if (c.mute || getTrack(c.trackId)?.muted) v = 0;
      if (p.gain) {
        el.volume = 1;
        p.gain.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.015);
      } else el.volume = Math.min(1, Math.max(0, v));

      if (playing) {
        if (el.paused) {
          if (Math.abs(el.currentTime - src) > 0.05) el.currentTime = src;
          // 已播完的元素再呼叫 play() 會跳回開頭，造成尾端重播
          if (!el.ended && !(el.duration && src >= el.duration - 0.05)) el.play().catch(() => {});
        } else if (!el.seeking && Math.abs(el.currentTime - src) > 0.3) el.currentTime = src;
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - src) > 0.25 / (store.project.fps || 30)) el.currentTime = src;
      }
    }
    for (const id of [...this.players.keys()]) if (!alive.has(id)) this.dropPlayer(id);
  }

  pauseAll() {
    for (const p of this.players.values()) p.el.pause();
  }

  // ---------- 繪製 ----------
  draw(t) {
    this.resize();
    const { width: W, height: H, bg, tracks, clips } = store.project;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    this.boxes.clear();
    // 軌道清單最上面 = 最上層，所以從底部開始畫
    for (let i = tracks.length - 1; i >= 0; i--) {
      const tr = tracks[i];
      if (tr.hidden) continue;
      const list = clips
        .filter((c) => c.trackId === tr.id && VISUAL.has(c.type) && t >= c.start && t < c.start + c.duration)
        .sort((a, b) => a.start - b.start);
      for (const c of list) {
        try {
          this.drawClip(c, t);
        } catch (e) {
          console.warn('draw error', e);
        }
      }
    }
  }

  drawClip(c, t) {
    const { width: W, height: H } = store.project;
    const local = t - c.start;
    const x = getProp(c, 'x', local);
    const y = getProp(c, 'y', local);
    const sc = getProp(c, 'scale', local);
    const rot = getProp(c, 'rotation', local);
    const op = getProp(c, 'opacity', local);
    const mods = clipMods(c, local);

    let src = null;
    let sw = 0;
    let sh = 0;
    if (c.type === 'video') {
      // 離線匯出時由解碼器直接提供影格
      const frame = this.frames?.get(c.id);
      if (frame) {
        src = frame.canvas;
        sw = frame.width;
        sh = frame.height;
      } else {
        const el = this.players.get(c.id)?.el;
        if (!el || el.readyState < 1 || !el.videoWidth) return;
        src = el;
        sw = el.videoWidth;
        sh = el.videoHeight;
      }
    } else if (c.type === 'image') {
      const m = store.media.get(c.mediaId);
      if (!m?.el) {
        if (!c.slot) return;
        src = placeholder(c.slot.label); // 範本的空位：顯示「素材 N」
        sw = src.width;
        sh = src.height;
      } else {
        src = m.el;
        sw = m.width;
        sh = m.height;
      }
    }

    const L = this.L;
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
    L.filter = 'none';
    L.shadowBlur = 0;
    L.clearRect(0, 0, W, H);

    if (src && c.bgBlur) {
      const cs = Math.max(W / sw, H / sh) * 1.15;
      L.filter = 'blur(40px) brightness(0.85)';
      L.drawImage(src, (W - sw * cs) / 2, (H - sh * cs) / 2, sw * cs, sh * cs);
      L.filter = 'none';
    }
    if (src && c.aiMatte?.on) src = this.applyMatte(c, src, sw, sh, t);
    if (src && c.chroma?.on) src = this.chromaKey(src, sw, sh, c.chroma);
    // 裁切：只取來源畫面的一部分，並以裁切後的比例排版
    const cr = c.crop || { l: 0, t: 0, r: 0, b: 0 };
    const srcW = src instanceof HTMLVideoElement ? src.videoWidth : src instanceof HTMLImageElement ? src.naturalWidth : src?.width || sw;
    const srcH = src instanceof HTMLVideoElement ? src.videoHeight : src instanceof HTMLImageElement ? src.naturalHeight : src?.height || sh;
    const cropW = Math.max(0.02, 1 - cr.l - cr.r);
    const cropH = Math.max(0.02, 1 - cr.t - cr.b);
    if (src) {
      sw *= cropW;
      sh *= cropH;
    }

    L.save();
    L.translate(W / 2 + x + mods.dx * W, H / 2 + y + mods.dy * H);
    L.rotate((rot + mods.rot) * RAD);
    const s = sc * mods.scale;
    L.scale(s * (c.effects.mirror ? -1 : 1), s * (c.effects.flipV ? -1 : 1));
    let bw = 0;
    let bh = 0;
    if (src) {
      if (c.fit === 'fill') {
        bw = W;
        bh = H;
      } else {
        const f = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
        bw = sw * f;
        bh = sh * f;
      }
      L.drawImage(src, cr.l * srcW, cr.t * srcH, cropW * srcW, cropH * srcH, -bw / 2, -bh / 2, bw, bh);
    } else if (c.type === 'text') {
      ({ w: bw, h: bh } = drawText(L, c, local + (c.animOffset || 0), t));
    } else if (c.type === 'shape') {
      ({ w: bw, h: bh } = drawShape(L, c, W, H, local + (c.animOffset || 0)));
    }
    if (c.mask && c.mask.type !== 'none') this.applyMask(c.mask, bw, bh, W, H);
    L.restore();
    this.boxes.set(c.id, { cx: W / 2 + x, cy: H / 2 + y, w: bw * sc, h: bh * sc, rot });

    this.postFx(c, t, mods, W, H);

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, op * mods.alpha));
    ctx.globalCompositeOperation = c.blend || 'source-over';
    let out = this.layer;
    ctx.filter = filterString(c.filters, mods.blur);
    // 調色走 WebGL（色輪、曲線、LUT，也讓 Safari 的濾鏡生效）；不支援時退回 Canvas 濾鏡
    if ((filtersActive(c.filters) || gradeActive(c.grade)) && this.grader()) {
      out = this.grade.process(this.layer, c.filters, c.grade, lutFor(c.grade?.lut));
      const blur = c.filters.blur + mods.blur;
      ctx.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
    }
    if (mods.wipe) applyWipe(ctx, mods.wipe, W, H);
    ctx.drawImage(out, 0, 0);
    ctx.restore();
    if (mods.flash > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${mods.flash})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  grader() {
    // 顯示卡回收了 WebGL（分頁在背景、內容太多）時重新建立，不然調色過的片段會變空白
    if (this.grade?.gl.isContextLost()) this.grade = null;
    if (this.grade) return this.grade;
    if (this.noGrade) return null;
    try {
      this.grade = new GradePass();
    } catch (e) {
      console.warn('WebGL2 無法使用，調色改用 Canvas 濾鏡', e);
      this.noGrade = true;
    }
    return this.grade;
  }

  /** 釋放 WebGL 調色資源（匯出用的暫時算圖器結束時呼叫） */
  dispose() {
    this.grade?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.grade = null;
    this.matteCache.clear();
  }

  // 遮罩：在片段自己的座標系裡畫出形狀（含羽化），只保留形狀內（或外）的畫面
  applyMask(k, bw, bh, W, H) {
    const { L, M } = this;
    if (this.mask.width !== W || this.mask.height !== H) {
      this.mask.width = W;
      this.mask.height = H;
    }
    M.setTransform(1, 0, 0, 1, 0, 0);
    M.filter = 'none';
    M.clearRect(0, 0, W, H);
    M.setTransform(L.getTransform());
    M.translate(k.x * bw, k.y * bh);
    M.rotate(k.rot * RAD);
    if (k.feather > 0) M.filter = `blur(${k.feather}px)`;
    M.fillStyle = '#fff';
    maskPath(M, k, Math.max(1, k.w * bw), Math.max(1, k.h * bh));
    M.fill();
    M.filter = 'none';
    L.save();
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalCompositeOperation = k.invert ? 'destination-out' : 'destination-in';
    L.drawImage(this.mask, 0, 0);
    L.restore();
  }

  // AI 去背：人像分割的信心值當作透明度；同一格畫面只算一次
  applyMatte(c, src, sw, sh, t) {
    if (!matteMod) {
      loadMatte();
      return src;
    }
    // 圖片永遠是同一格；影片以素材時間判斷是否換格
    const key = c.type === 'image' ? `img:${c.mediaId}` : src instanceof HTMLVideoElement ? src.currentTime.toFixed(3) : t.toFixed(3);
    let e = this.matteCache.get(c.id);
    if (e && e.key === key && e.sig === JSON.stringify(c.aiMatte)) return e.out;
    // 跳轉中的影片 currentTime 已是新時間，但畫面還是舊的：先沿用上一張結果，等新畫面解碼好再算
    if (src instanceof HTMLVideoElement && (src.seeking || src.readyState < 2)) return e?.out?.width ? e.out : src;
    if (!e) {
      e = { out: document.createElement('canvas'), mask: document.createElement('canvas'), small: document.createElement('canvas') };
      this.matteCache.set(c.id, e);
    }
    // 模型輸入只有 256×256，先縮小再送進去，大圖也很快
    const sk = Math.min(1, 512 / Math.max(sw, sh));
    e.small.width = Math.max(1, Math.round(sw * sk));
    e.small.height = Math.max(1, Math.round(sh * sk));
    e.small.getContext('2d').drawImage(src, 0, 0, e.small.width, e.small.height);
    const res = matteMod.segment(e.small);
    if (!res) return src;
    const { out, mask } = e;
    const k = Math.min(1, 1280 / Math.max(sw, sh));
    out.width = Math.round(sw * k);
    out.height = Math.round(sh * k);
    mask.width = res.width;
    mask.height = res.height;
    const mg = mask.getContext('2d');
    const img = mg.createImageData(res.width, res.height);
    const th = 1 - (c.aiMatte.threshold ?? 0.5);
    for (let i = 0; i < res.data.length; i++) {
      const v = Math.min(1, Math.max(0, (res.data[i] - th + 0.15) / 0.3)); // 在門檻附近平滑過渡
      img.data[i * 4 + 3] = v * 255;
    }
    mg.putImageData(img, 0, 0);
    const og = out.getContext('2d');
    og.clearRect(0, 0, out.width, out.height);
    og.drawImage(src, 0, 0, out.width, out.height);
    og.globalCompositeOperation = 'destination-in';
    og.filter = c.aiMatte.feather > 0 ? `blur(${c.aiMatte.feather}px)` : 'none';
    og.drawImage(mask, 0, 0, out.width, out.height);
    og.filter = 'none';
    og.globalCompositeOperation = 'source-over';
    e.key = key;
    e.sig = JSON.stringify(c.aiMatte);
    return out;
  }

  postFx(c, t, mods, W, H) {
    const fx = c.effects;
    const L = this.L;
    const T = this.T;
    if (fx.pixelate > 1) {
      const b = fx.pixelate;
      const w = Math.max(1, Math.round(W / b));
      const h = Math.max(1, Math.round(H / b));
      T.setTransform(1, 0, 0, 1, 0, 0);
      T.globalCompositeOperation = 'source-over';
      T.clearRect(0, 0, W, H);
      T.drawImage(this.layer, 0, 0, w, h);
      L.clearRect(0, 0, W, H);
      L.imageSmoothingEnabled = false;
      L.drawImage(this.tmp, 0, 0, w, h, 0, 0, W, H);
      L.imageSmoothingEnabled = true;
    }
    const rgb = fx.rgb + mods.glitch * 25;
    if (rgb > 0.5) this.rgbSplit(rgb, W, H);
    const g = fx.glitch + mods.glitch * 70;
    if (g > 0) this.glitch(g, t, W, H);
    if (fx.vignette > 0) {
      L.globalCompositeOperation = 'source-atop';
      const r = Math.hypot(W, H) / 2;
      const gr = L.createRadialGradient(W / 2, H / 2, r * 0.35, W / 2, H / 2, r);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, `rgba(0,0,0,${fx.vignette / 100})`);
      L.fillStyle = gr;
      L.fillRect(0, 0, W, H);
      L.globalCompositeOperation = 'source-over';
    }
    if (fx.grain > 0) {
      L.globalCompositeOperation = 'source-atop';
      L.globalAlpha = (fx.grain / 100) * 0.45;
      L.fillStyle = L.createPattern(this.grain[Math.floor(t * 24) % this.grain.length], 'repeat');
      L.fillRect(0, 0, W, H);
      L.globalAlpha = 1;
      L.globalCompositeOperation = 'source-over';
    }
  }

  rgbSplit(off, W, H) {
    const { L, T, C } = this;
    T.globalCompositeOperation = 'source-over';
    T.clearRect(0, 0, W, H);
    T.drawImage(this.layer, 0, 0);
    L.clearRect(0, 0, W, H);
    L.globalCompositeOperation = 'lighter';
    for (const [color, dx] of [['#ff0000', -off], ['#00ff00', 0], ['#0000ff', off]]) {
      C.globalCompositeOperation = 'source-over';
      C.clearRect(0, 0, W, H);
      C.drawImage(this.tmp, 0, 0);
      C.globalCompositeOperation = 'multiply';
      C.fillStyle = color;
      C.fillRect(0, 0, W, H);
      C.globalCompositeOperation = 'destination-in';
      C.drawImage(this.tmp, 0, 0);
      L.drawImage(this.chan, dx, 0);
    }
    L.globalCompositeOperation = 'source-over';
  }

  glitch(amount, t, W, H) {
    const { L, T } = this;
    const rand = rng(Math.floor(t * 12) * 7919 + 13);
    T.globalCompositeOperation = 'source-over';
    T.clearRect(0, 0, W, H);
    T.drawImage(this.layer, 0, 0);
    L.clearRect(0, 0, W, H);
    let y = 0;
    const slices = 6 + Math.floor(amount / 8);
    while (y < H) {
      const h = Math.max(4, ((rand() * 2 * H) / slices) | 0);
      const dx = rand() < 0.45 ? (rand() - 0.5) * amount * 6 : 0;
      L.drawImage(this.tmp, 0, y, W, h, dx, y, W, h);
      y += h;
    }
  }

  chromaKey(src, sw, sh, k) {
    const sc = Math.min(1, 960 / sw);
    const w = Math.max(1, Math.round(sw * sc));
    const h = Math.max(1, Math.round(sh * sc));
    if (this.key.width !== w || this.key.height !== h) {
      this.key.width = w;
      this.key.height = h;
    }
    const K = this.K;
    K.clearRect(0, 0, w, h);
    K.drawImage(src, 0, 0, w, h);
    const img = K.getImageData(0, 0, w, h);
    const d = img.data;
    const [kr, kg, kb] = hexRgb(k.color);
    // 用 YCbCr 色度距離，比 RGB 距離對光線變化更穩定
    const kcb = -0.1687 * kr - 0.3313 * kg + 0.5 * kb;
    const kcr = 0.5 * kr - 0.4187 * kg - 0.0813 * kb;
    const sim = k.similarity * 200;
    const sm = Math.max(1, k.smoothness * 200);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const cb = -0.1687 * r - 0.3313 * g + 0.5 * b - kcb;
      const cr = 0.5 * r - 0.4187 * g - 0.0813 * b - kcr;
      const dist = Math.sqrt(cb * cb + cr * cr);
      if (dist < sim) d[i + 3] = 0;
      else if (dist < sim + sm) {
        const a = (dist - sim) / sm;
        d[i + 3] *= a;
        // 去除綠邊溢色
        const avg = (r + b) / 2;
        if (g > avg) d[i + 1] = avg + (g - avg) * a;
      }
    }
    K.putImageData(img, 0, 0);
    return this.key;
  }
}

function applyWipe(ctx, w, W, H) {
  ctx.beginPath();
  const p = w.p;
  if (w.kind === 'left') ctx.rect(0, 0, W * p, H);
  else if (w.kind === 'right') ctx.rect(W * (1 - p), 0, W * p, H);
  else if (w.kind === 'up') ctx.rect(0, H * (1 - p), W, H * p);
  else if (w.kind === 'down') ctx.rect(0, 0, W, H * p);
  else ctx.arc(W / 2, H / 2, (p * Math.hypot(W, H)) / 2, 0, Math.PI * 2);
  ctx.clip();
}

function roundRect(L, x, y, w, h, r) {
  L.beginPath();
  if (L.roundRect) L.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else L.rect(x, y, w, h);
}

export function drawText(L, c, local, t) {
  const s = c.text;
  const font = textFontSpec(s);
  ensureFont(font, s.content);
  L.font = font;
  L.textBaseline = 'middle';
  L.textAlign = 'left';
  if ('letterSpacing' in L) L.letterSpacing = `${s.letterSpacing}px`;

  const full = s.content.split('\n');
  const widths = full.map((l) => L.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const lh = s.size * s.lineHeight;
  const totalH = full.length * lh;

  let visible = Infinity;
  if (s.anim === 'typewriter') {
    const total = [...s.content].length;
    const dur = Math.min(c.duration * 0.7, total * 0.07 + 0.2);
    visible = Math.floor(Math.min(1, local / dur) * total);
  }
  let alpha = 1;
  if (s.anim === 'flicker') {
    const r = rng(Math.floor(t * 20))();
    alpha = r < 0.12 ? 0.25 : r < 0.2 ? 0.7 : 1;
  }
  if (s.anim === 'pulse') {
    const k = 1 + Math.max(0, Math.sin(t * Math.PI * 2.4)) * 0.08;
    L.scale(k, k);
  }

  const pad = s.size * 0.32;
  if (s.bg) {
    L.fillStyle = rgba(s.bgColor, s.bgOpacity);
    roundRect(L, -maxW / 2 - pad, -totalH / 2 - pad * 0.5, maxW + pad * 2, totalH + pad, s.size * 0.22);
    L.fill();
  }

  L.globalAlpha = alpha;
  const perChar = s.anim === 'wave' || s.anim === 'rainbow';
  let count = 0;
  full.forEach((line, i) => {
    const y = -totalH / 2 + lh * (i + 0.5);
    const lw = widths[i];
    let x = s.align === 'left' ? -maxW / 2 : s.align === 'right' ? maxW / 2 - lw : -lw / 2;
    const chars = [...line];
    if (!perChar && visible === Infinity) {
      drawRun(L, s, line, x, y, null);
      return;
    }
    chars.forEach((ch, j) => {
      if (count++ >= visible) return;
      const cw = L.measureText(ch).width;
      let dy = 0;
      let color = null;
      if (s.anim === 'wave' || s.anim === 'rainbow') dy = Math.sin(t * 5 + j * 0.55 + i) * s.size * 0.12;
      if (s.anim === 'rainbow') color = `hsl(${(t * 140 + (j + i * 7) * 28) % 360},95%,62%)`;
      drawRun(L, s, ch, x, y + dy, color);
      x += cw;
    });
    count++; // 換行也算一個字
  });
  L.globalAlpha = 1;
  return { w: maxW + (s.bg ? pad * 2 : 0), h: totalH + (s.bg ? pad : 0) };
}

function drawRun(L, s, text, x, y, color) {
  if (s.shadow > 0) {
    L.shadowColor = s.shadowColor;
    L.shadowBlur = s.shadow;
  }
  if (s.stroke > 0) {
    L.lineJoin = 'round';
    L.lineWidth = s.stroke * 2;
    L.strokeStyle = s.strokeColor;
    L.strokeText(text, x, y);
    L.shadowBlur = 0;
  }
  if (color) L.fillStyle = color;
  else if (s.gradient) {
    const g = L.createLinearGradient(0, y - s.size / 2, 0, y + s.size / 2);
    g.addColorStop(0, s.color);
    g.addColorStop(1, s.color2);
    L.fillStyle = g;
  } else L.fillStyle = s.color;
  L.fillText(text, x, y);
  L.shadowBlur = 0;
}

function drawShape(L, c, W, H, local = 0) {
  const s = c.shape;
  if (s.kind === 'sticker') return drawSticker(L, s, local);
  if (s.kind === 'solid' || s.kind === 'gradient') {
    if (s.kind === 'gradient') {
      const g = L.createLinearGradient(-W / 2, -H / 2, W / 2, H / 2);
      g.addColorStop(0, s.color);
      g.addColorStop(1, s.color2);
      L.fillStyle = g;
    } else L.fillStyle = s.color;
    L.fillRect(-W / 2, -H / 2, W, H);
    return { w: W, h: H };
  }
  if (s.kind === 'letterbox') {
    L.fillStyle = s.color;
    L.fillRect(-W / 2, -H / 2, W, s.h);
    L.fillRect(-W / 2, H / 2 - s.h, W, s.h);
    return { w: W, h: H };
  }
  L.fillStyle = s.color;
  if (s.kind === 'circle') {
    L.beginPath();
    L.ellipse(0, 0, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
  } else roundRect(L, -s.w / 2, -s.h / 2, s.w, s.h, s.radius);
  L.fill();
  return { w: s.w, h: s.h };
}
