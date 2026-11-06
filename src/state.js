// 專案資料模型、事件、復原/重做與片段操作
import { srcAt, hasCurve, subCurve } from './timemap.js';
import { GRADE_DEFAULT } from './grade.js';

export const uid = () => Math.random().toString(36).slice(2, 10);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function newProject() {
  return {
    version: 1,
    name: '未命名專案',
    width: 1920,
    height: 1080,
    fps: 30,
    bg: '#000000',
    tracks: ['文字 / 貼圖', '疊加畫面', '主畫面', '音訊'].map((name) => ({ id: uid(), name, muted: false, hidden: false })),
    clips: [],
  };
}

export const store = {
  project: newProject(),
  media: new Map(),
  luts: new Map(), // 使用者匯入的 3D LUT：id → { name, size, data }
  templates: new Map(), // 使用者存的範本
  selection: null,
  time: 0,
  playing: false,
  zoom: 80, // 每秒幾像素
  snap: true,
};

// ---------- 事件 ----------
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function emit(evt, data) {
  listeners.get(evt)?.forEach((fn) => fn(data));
  if (evt !== 'time') listeners.get('*')?.forEach((fn) => fn(evt, data));
}

// ---------- 復原 / 重做 ----------
let undoStack = [];
let redoStack = [];
export function checkpoint() {
  undoStack.push(JSON.stringify(store.project));
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}
function restore(json) {
  store.project = JSON.parse(json);
  if (!getClip(store.selection)) store.selection = null;
  emit('project');
}
export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(JSON.stringify(store.project));
  restore(undoStack.pop());
  return true;
}
export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(JSON.stringify(store.project));
  restore(redoStack.pop());
  return true;
}
export function resetHistory() {
  undoStack = [];
  redoStack = [];
}

// ---------- 查詢 ----------
export const getClip = (id) => store.project.clips.find((c) => c.id === id) || null;
export const getTrack = (id) => store.project.tracks.find((t) => t.id === id) || null;
export const trackIndex = (id) => store.project.tracks.findIndex((t) => t.id === id);
export const selected = () => getClip(store.selection);
export function select(id) {
  if (store.selection === id) return;
  store.selection = id;
  emit('select');
}
export function projectDuration() {
  let d = 0;
  for (const c of store.project.clips) d = Math.max(d, c.start + c.duration);
  return d;
}

// ---------- 片段工廠 ----------
export const TEXT_DEFAULT = {
  content: '輸入文字',
  font: 'Noto Sans TC',
  size: 96,
  weight: '700',
  italic: false,
  color: '#ffffff',
  gradient: false,
  color2: '#ff6ec4',
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.25,
  stroke: 0,
  strokeColor: '#000000',
  shadow: 0,
  shadowColor: '#000000',
  bg: false,
  bgColor: '#000000',
  bgOpacity: 0.6,
  anim: 'none',
};
export const SHAPE_DEFAULT = { kind: 'rect', color: '#22d3ee', color2: '#a78bfa', w: 600, h: 400, radius: 0 };
export const FILTER_DEFAULT = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0 };
export const EFFECT_DEFAULT = { vignette: 0, grain: 0, pixelate: 0, glitch: 0, rgb: 0, mirror: false, flipV: false };

export function makeClip(type, extra = {}) {
  const base = {
    id: uid(),
    type,
    trackId: null,
    mediaId: null,
    start: 0,
    duration: 5,
    in: 0,
    speed: 1,
    curve: null, // 曲線變速 { id, pts }
    reversed: null, // 倒放時保存原始素材 { mediaId, in }
    crop: { l: 0, t: 0, r: 0, b: 0 }, // 各邊裁掉的比例
    grade: GRADE_DEFAULT(), // 色輪、白平衡、曲線、LUT
    mask: { type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 20, radius: 0, invert: false },
    aiMatte: { on: false, threshold: 0.5, feather: 2 },
    enhanced: null, // 人聲增強後保存原始音訊 { mediaId }
    keepPitch: true,
    volume: 1,
    mute: false,
    fadeIn: 0,
    fadeOut: 0,
    fit: 'contain',
    bgBlur: false,
    blend: 'source-over',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    filters: { ...FILTER_DEFAULT },
    effects: { ...EFFECT_DEFAULT },
    chroma: { on: false, color: '#00ff00', similarity: 0.25, smoothness: 0.1 },
    transIn: { type: 'none', dur: 0.5 },
    transOut: { type: 'none', dur: 0.5 },
    keyframes: {},
  };
  if (type === 'text') base.text = { ...TEXT_DEFAULT };
  if (type === 'shape') base.shape = { ...SHAPE_DEFAULT };
  return deepMerge(base, extra);
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
export function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) out[k] = isObj(a[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : b[k];
  return out;
}
// 舊存檔補齊欄位
export function normalizeProject(p) {
  const base = newProject();
  const proj = { ...base, ...p };
  if (!proj.tracks?.length) proj.tracks = base.tracks;
  proj.clips = (proj.clips || []).map((c) => makeClip(c.type, c));
  return proj;
}

// ---------- 軌道擺放 ----------
// 同軌道重疊檢查；兩片段之間有「片段轉場」時，允許重疊轉場的長度
export function overlaps(trackId, start, end, exceptId) {
  const self = exceptId ? store.project.clips.find((c) => c.id === exceptId) : null;
  return store.project.clips.some((c) => {
    if (c.trackId !== trackId || c.id === exceptId) return false;
    const ov = Math.min(end, c.start + c.duration) - Math.max(start, c.start);
    if (ov <= 1e-6) return false;
    const allowed = c.start < start ? self?.xfade?.dur || 0 : c.xfade?.dur || 0;
    return ov > allowed + 1e-3;
  });
}
export function addTrack(index = 0, name) {
  const t = { id: uid(), name: name || `軌道 ${store.project.tracks.length + 1}`, muted: false, hidden: false };
  store.project.tracks.splice(index, 0, t);
  return t;
}
// 放到偏好的軌道；若重疊就找最近的空軌道，沒有就在上方新增
export function placeClip(clip, preferredTrackId) {
  const tracks = store.project.tracks;
  let pi = tracks.findIndex((t) => t.id === preferredTrackId);
  if (pi < 0) pi = 0;
  const end = clip.start + clip.duration;
  const order = tracks
    .map((t, i) => ({ t, d: Math.abs(i - pi) + (i > pi ? 0.5 : 0) }))
    .sort((a, b) => a.d - b.d)
    .map((o) => o.t);
  const free = order.find((t) => !overlaps(t.id, clip.start, end, clip.id));
  clip.trackId = free ? free.id : addTrack(pi).id;
  if (!store.project.clips.includes(clip)) store.project.clips.push(clip);
  return clip;
}
export function defaultTrack(type) {
  const t = store.project.tracks;
  if (type === 'audio') return t[t.length - 1].id;
  if (type === 'text' || type === 'shape') return t[0].id;
  return t[Math.max(0, t.length - 2)].id;
}

// ---------- 關鍵影格 ----------
export const KF_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
const KF_EPS = 1 / 60;
export function getProp(clip, prop, local) {
  const kf = clip.keyframes?.[prop];
  if (!kf || !kf.length) return clip.transform[prop];
  if (local <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    if (local < b.t) {
      let u = (local - a.t) / (b.t - a.t);
      u = u * u * (3 - 2 * u); // 平滑緩動
      return a.v + (b.v - a.v) * u;
    }
  }
  return last.v;
}
export function setProp(clip, prop, v, local) {
  const kf = clip.keyframes?.[prop];
  if (kf && kf.length) {
    const k = kf.find((k) => Math.abs(k.t - local) < KF_EPS);
    if (k) k.v = v;
    else {
      kf.push({ t: local, v });
      kf.sort((a, b) => a.t - b.t);
    }
  } else clip.transform[prop] = v;
}
export const hasKeys = (clip, prop) => !!clip.keyframes?.[prop]?.length;
export const hasKeyAt = (clip, prop, local) => !!clip.keyframes?.[prop]?.some((k) => Math.abs(k.t - local) < KF_EPS);
export function toggleKey(clip, prop, local) {
  clip.keyframes ||= {};
  const kf = (clip.keyframes[prop] ||= []);
  const i = kf.findIndex((k) => Math.abs(k.t - local) < KF_EPS);
  if (i >= 0) {
    const [k] = kf.splice(i, 1);
    if (!kf.length) {
      delete clip.keyframes[prop];
      clip.transform[prop] = k.v;
    }
  } else {
    kf.push({ t: local, v: getProp(clip, prop, local) });
    kf.sort((a, b) => a.t - b.t);
  }
}

// ---------- 編輯操作 ----------
export function splitClip(clip, t) {
  const local = t - clip.start;
  if (local < 0.05 || local > clip.duration - 0.05) return null;
  const b = structuredClone(clip);
  b.id = uid();
  b.start = t;
  b.duration = clip.duration - local;
  b.in = srcAt(clip, local);
  if (hasCurve(clip)) {
    const a = local / clip.duration;
    b.curve.pts = subCurve(clip.curve.pts, a, 1);
    clip.curve = { ...clip.curve, pts: subCurve(clip.curve.pts, 0, a) };
  }
  b.transIn = { ...b.transIn, type: 'none' };
  b.fadeIn = 0;
  b.xfade = null; // 片段轉場屬於左半段的開頭，不跟著複製到右半段
  // 後面接著的片段若以這段為轉場對象，改成接右半段
  for (const o of store.project.clips) if (o.xfade?.prevId === clip.id) o.xfade = { ...o.xfade, prevId: b.id };
  for (const prop of Object.keys(clip.keyframes || {})) {
    const kf = clip.keyframes[prop];
    const v = getProp(clip, prop, local);
    clip.keyframes[prop] = [...kf.filter((k) => k.t < local), { t: local, v }];
    b.keyframes[prop] = [{ t: 0, v }, ...kf.filter((k) => k.t > local).map((k) => ({ t: k.t - local, v: k.v }))];
  }
  clip.duration = local;
  clip.transOut = { ...clip.transOut, type: 'none' };
  clip.fadeOut = 0;
  store.project.clips.push(b);
  return b;
}
export function duplicateClip(clip) {
  const c = structuredClone(clip);
  c.id = uid();
  c.xfade = null;
  c.start = clip.start + clip.duration;
  placeClip(c, clip.trackId);
  return c;
}
export function deleteClip(clip) {
  store.project.clips = store.project.clips.filter((c) => c !== clip);
  if (store.selection === clip.id) store.selection = null;
}
