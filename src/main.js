import './style.css';
import {
  store, on, emit, checkpoint, undo, redo, select, selected, getClip, projectDuration, makeClip, placeClip,
  splitClip, duplicateClip, deleteClip, defaultTrack, addTrack, newProject, normalizeProject, resetHistory, uid, clamp,
  FILTER_DEFAULT, getProp as getP, setProp as setP,
} from './state.js';
import { Renderer } from './renderer.js';
import { initTimeline } from './timeline.js';
import { initLibrary } from './library.js';
import { initInspector } from './inspector.js';
import { importFiles, restoreMedia, clearMedia } from './media.js';
import { toggleReverse, freezeFrame, enhanceClipVoice, textClipToSpeech, captionsToSpeech } from './tools.js';
import { trackObject } from './track.js';
import { loadMatte } from './renderer.js';
import { TEXT_PRESETS, STICKERS, SHAPE_PRESETS, FILTER_PRESETS } from './effects.js';
import { $, h, toast, fmtTime, debounce, openModal } from './ui.js';

// 匯出用的函式庫（Mediabunny）只在按下匯出時才載入，讓首次開啟網站更快
const canFastExport = () => typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';

const SAVE_KEY = 'novacut.project';
const canvas = $('canvas');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const stage = $('stage');
const renderer = new Renderer(canvas);
let exporting = null;
let clipboard = null;

// ---------- 播放控制 ----------
function seek(t) {
  if (exporting) return;
  store.time = Math.max(0, t);
  emit('time');
}
function play() {
  const dur = projectDuration();
  if (dur <= 0) return toast('時間軸是空的，先加入一些媒體吧');
  if (store.time >= dur - 0.02) store.time = 0;
  renderer.ensureAudio();
  renderer.audioCtx?.resume();
  store.playing = true;
  emit('play');
}
function pause() {
  store.playing = false;
  renderer.pauseAll();
  emit('play');
}
const togglePlay = () => (store.playing ? pause() : play());
on('play', () => ($('btnPlay').textContent = store.playing ? '❚❚' : '▶'));

// ---------- 編輯動作 ----------
function adaptProject(w, hgt) {
  const k = Math.min(1, 1920 / Math.max(w, hgt));
  store.project.width = Math.round((w * k) / 2) * 2;
  store.project.height = Math.round((hgt * k) / 2) * 2;
}
function addMediaClip(m, at = store.time, trackId) {
  if (m.error) return toast('這個檔案無法解碼，瀏覽器可能不支援它的格式');
  checkpoint();
  if (!store.project.clips.length && (m.type === 'video' || m.type === 'image') && m.width) adaptProject(m.width, m.height);
  const c = makeClip(m.type, { mediaId: m.id, start: at, duration: m.type === 'image' ? 4 : m.duration || 5 });
  placeClip(c, trackId ?? defaultTrack(m.type));
  store.selection = c.id;
  emit('project');
  emit('select');
  return c;
}
function presetClip(kind, i) {
  if (kind === 'text') {
    const p = TEXT_PRESETS[i];
    return makeClip('text', { duration: 3, text: p.text, transform: p.transform || {}, transIn: p.transIn || {}, transOut: p.transOut || {} });
  }
  if (kind === 'sticker') return makeClip('text', { duration: 3, text: { content: STICKERS[i], size: 220 }, transIn: { type: 'bounce', dur: 0.4 } });
  const p = SHAPE_PRESETS[i];
  return makeClip('shape', { duration: 4, shape: p.shape, transform: p.transform || {} });
}
function addPreset(kind, i, at = store.time, trackId) {
  checkpoint();
  const c = presetClip(kind, i);
  c.start = at;
  placeClip(c, trackId ?? defaultTrack(kind === 'shape' && SHAPE_PRESETS[i].shape.kind.match(/solid|gradient/) ? 'video' : 'text'));
  store.selection = c.id;
  emit('project');
  emit('select');
}
function needSel() {
  const c = selected();
  if (!c) toast('請先在時間軸選取一個片段');
  return c;
}
function applyFilterPreset(i) {
  const c = needSel();
  if (!c) return;
  if (c.type === 'audio') return toast('音訊片段不能套用濾鏡');
  checkpoint();
  const p = FILTER_PRESETS[i];
  c.filters = { ...FILTER_DEFAULT, ...p.filters };
  c.effects = { ...c.effects, vignette: 0, grain: 0, rgb: 0, ...(p.effects || {}) };
  emit('props');
  emit('select');
  toast(`已套用「${p.name}」`);
}
function applyTransition(id, where) {
  const c = needSel();
  if (!c) return;
  if (c.type === 'audio') return toast('音訊片段請用「淡入淡出」音量設定');
  checkpoint();
  const dur = Math.min(0.6, c.duration / 2);
  if (where !== 'out') c.transIn = { type: id, dur };
  if (where !== 'in') c.transOut = { type: id, dur };
  emit('layout');
  emit('select');
}
function split() {
  const t = store.time;
  const sel = selected();
  const targets = sel && t > sel.start && t < sel.start + sel.duration
    ? [sel]
    : store.project.clips.filter((c) => t > c.start + 0.05 && t < c.start + c.duration - 0.05);
  if (!targets.length) return toast('播放頭下沒有可分割的片段');
  checkpoint();
  let last = null;
  for (const c of targets) last = splitClip(c, t) || last;
  if (last) store.selection = last.id;
  emit('project');
  emit('select');
}
function duplicate() {
  const c = needSel();
  if (!c) return;
  checkpoint();
  const d = duplicateClip(c);
  store.selection = d.id;
  emit('project');
  emit('select');
}
function remove() {
  const c = selected();
  if (!c) return;
  checkpoint();
  deleteClip(c);
  emit('project');
  emit('select');
}
function detach() {
  const c = needSel();
  if (!c) return;
  if (c.type !== 'video') return toast('只有影片片段可以分離音訊');
  const m = store.media.get(c.mediaId);
  if (m && m.hasAudio === false) return toast('這段影片沒有聲音');
  checkpoint();
  const a = makeClip('audio', { mediaId: c.mediaId, start: c.start, duration: c.duration, in: c.in, speed: c.speed, curve: structuredClone(c.curve), keepPitch: c.keepPitch, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  c.volume = 0;
  placeClip(a, defaultTrack('audio'));
  emit('project');
  toast('已分離音訊，原影片已設為無聲');
}
function copy() {
  const c = selected();
  if (c) {
    clipboard = structuredClone(c);
    toast('已複製片段');
  }
}
function paste() {
  if (!clipboard) return;
  checkpoint();
  const c = structuredClone(clipboard);
  c.id = uid();
  c.start = store.time;
  placeClip(c, clipboard.trackId);
  store.selection = c.id;
  emit('project');
  emit('select');
}
function doUndo() {
  if (!undo()) toast('沒有可以復原的動作');
  emit('select');
}
function doRedo() {
  if (!redo()) toast('沒有可以重做的動作');
  emit('select');
}

// ---------- 初始化各區塊 ----------
const timeline = initTimeline({ seek, onDrop: handleDrop });
initLibrary({
  addMediaClip, addPreset, applyFilterPreset, applyTransition, seek, select,
  speakCaptions: (list, voice, speed) => busyTask('字幕配音', async (progress) => {
    const n = await captionsToSpeech(list, voice, speed, ({ progress: p }) => p != null && progress(p));
    toast(`已幫 ${n} 句字幕配音，放在「配音」軌`);
  }),
});
initInspector({
  split, duplicate, remove, detach, applyFilterPreset, reverse: doReverse, freeze: doFreeze,
  loadMatte: () => {
    toast('正在載入 AI 去背模型…');
    loadMatte().then((m) => m && toast('AI 去背已就緒'));
  },
  track: (target, videoId, size) => {
    const video = getClip(videoId);
    const box = video && renderer.boxes.get(video.id);
    if (!box) return toast('播放頭位置看不到這段影片，請把播放頭移到影片上');
    busyTask('運動追蹤', async (progress) => {
      const r = await trackObject(video, target, box, { size, onProgress: progress });
      toast(r.lostEarly ? `追蹤 ${r.frames} 個位置後跟丟了，可以從那裡再追一次` : `追蹤完成，寫入 ${r.frames} 個位置關鍵影格`);
    });
  },
  exportProject: () => busyTask('匯出專案檔', async (progress) => {
    const { exportProjectFile } = await import('./projectfile.js');
    const blob = await exportProjectFile(progress);
    download(blob, 'novacut');
    toast(`已匯出專案檔（${(blob.size / 1e6).toFixed(1)} MB）`);
  }),
  importProject: () => {
    const input = h('input', { type: 'file', accept: '.novacut,.json,application/json' });
    input.onchange = () => input.files[0] && busyTask('開啟專案檔', async (progress) => {
      const { importProjectFile } = await import('./projectfile.js');
      const r = await importProjectFile(input.files[0], progress);
      toast(`已開啟專案：${r.clips} 個片段、${r.media} 個素材`);
    });
    input.click();
  },
  speakText: (c, voice, speed) => busyTask('文字轉語音', async (progress) => {
    await textClipToSpeech(c, voice, speed, ({ progress: p }) => p != null && progress(p));
    toast('已產生配音，放在「配音」軌');
  }),
  enhance: (c, opts) => busyTask('人聲增強', async (progress) => {
    await enhanceClipVoice(c, opts, progress);
    toast('人聲增強完成');
  }),
});

// 長時間的處理：顯示進度，期間鎖住操作
async function busyTask(title, fn) {
  pause();
  const bar = h('div', { class: 'bar' });
  const label = h('div', { class: 'dim' }, '處理中…');
  const close = openModal(h('div', { class: 'export' }, h('h2', {}, title), label, h('div', { class: 'progress' }, bar)));
  try {
    return await fn((p) => {
      bar.style.width = `${(p * 100).toFixed(1)}%`;
      label.textContent = `處理中… ${(p * 100).toFixed(0)}%`;
    });
  } catch (e) {
    console.error(e);
    toast(`${title}失敗：${e.message}`);
  } finally {
    close();
  }
}
function doReverse(c) {
  if (c.reversed) {
    toggleReverse(c);
    toast('已取消倒放');
    return;
  }
  busyTask('倒放', async (progress) => {
    await toggleReverse(c, progress);
    toast('倒放完成');
  });
}
function doFreeze(c, dur) {
  if (store.time < c.start || store.time >= c.start + c.duration) return toast('請先把播放頭移到這個片段上');
  busyTask('定格', async () => {
    await freezeFrame(c, store.time, dur);
    toast(`已插入 ${dur} 秒定格畫面`);
  });
}

async function handleDrop(dt, t, trackId) {
  const mediaId = dt.getData('text/x-media');
  const preset = dt.getData('text/x-preset');
  if (mediaId) {
    const m = store.media.get(mediaId);
    if (m) addMediaClip(m, t, trackId);
  } else if (preset) {
    const [kind, i] = preset.split(':');
    addPreset(kind, +i, t, trackId);
  } else if (dt.files?.length) {
    const list = (await importFiles(dt.files)).filter((m) => m?.type);
    let at = t;
    for (const m of list) {
      const c = addMediaClip(m, at, trackId);
      if (c) at = c.start + c.duration;
    }
  }
}

$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) {
    await importFiles(files);
    toast(`已匯入 ${files.length} 個檔案`);
  }
});

// 整個視窗都可以拖檔進來
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('dropMask').classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('dropMask').classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropMask').classList.add('hidden');
  if (e.dataTransfer.files?.length) {
    const n = e.dataTransfer.files.length;
    await importFiles(e.dataTransfer.files);
    toast(`已匯入 ${n} 個檔案`);
  }
});
$('timeline').addEventListener('drop', () => {
  dragDepth = 0;
  $('dropMask').classList.add('hidden');
});

// ---------- 預覽區：尺寸、選取、直接拖曳 ----------
function fitStage() {
  const r = stage.getBoundingClientRect();
  const { width: W, height: H } = store.project;
  const k = Math.min((r.width - 24) / W, (r.height - 24) / H);
  const cw = Math.max(1, Math.floor(W * k));
  const ch = Math.max(1, Math.floor(H * k));
  const dpr = devicePixelRatio || 1;
  for (const c of [canvas, overlay]) {
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    c.style.left = (r.width - cw) / 2 + 'px';
    c.style.top = (r.height - ch) / 2 + 'px';
  }
  overlay.width = Math.round(cw * dpr);
  overlay.height = Math.round(ch * dpr);
}
new ResizeObserver(fitStage).observe(stage);
on('project', fitStage);

const VISUAL = new Set(['video', 'image', 'text', 'shape']);
const toProject = (e) => {
  const r = overlay.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * store.project.width, ((e.clientY - r.top) / r.height) * store.project.height];
};
const inBox = (b, px, py) => {
  const a = (-b.rot * Math.PI) / 180;
  const dx = px - b.cx;
  const dy = py - b.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
};
function hitTest(px, py) {
  const t = store.time;
  for (const tr of store.project.tracks) {
    if (tr.hidden) continue;
    const list = store.project.clips
      .filter((c) => c.trackId === tr.id && VISUAL.has(c.type) && t >= c.start && t < c.start + c.duration)
      .sort((a, b) => b.start - a.start);
    for (const c of list) {
      const b = renderer.boxes.get(c.id);
      if (b && inBox(b, px, py)) return c;
    }
  }
  return null;
}
function handlePoints(b) {
  const a = (b.rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const pt = (lx, ly) => [b.cx + lx * cos - ly * sin, b.cy + lx * sin + ly * cos];
  const k = store.project.width / overlay.clientWidth; // 1 個螢幕像素 = 幾個專案像素
  return {
    corners: [pt(-b.w / 2, -b.h / 2), pt(b.w / 2, -b.h / 2), pt(b.w / 2, b.h / 2), pt(-b.w / 2, b.h / 2)],
    rotate: pt(0, -b.h / 2 - 28 * k),
    k,
  };
}

let pdrag = null;
let guides = { x: false, y: false };
// 觸控：兩指縮放與旋轉選取的片段
const touchPts = new Map();
function pinchState() {
  const [a, b] = [...touchPts.values()];
  return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, a: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
overlay.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touchPts.set(e.pointerId, toProject(e));
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch {
      /* 指標已結束時無法擷取，不影響手勢 */
    }
    const c = selected();
    if (touchPts.size === 2 && c && renderer.boxes.get(c.id)) {
      if (!pdrag?.moved) checkpoint();
      const local = clamp(store.time - c.start, 0, c.duration);
      const ps = pinchState();
      pdrag = { mode: 'pinch', c, local, moved: true, os: getP(c, 'scale', local), or: getP(c, 'rotation', local), d0: ps.d, a0: ps.a };
      return;
    }
    if (touchPts.size > 1) return;
  }

  if (exporting) return;
  const [px, py] = toProject(e);
  let c = selected();
  const b = c && renderer.boxes.get(c.id);
  let mode = null;
  if (b) {
    const hp = handlePoints(b);
    const near = ([x, y]) => Math.hypot(x - px, y - py) < 12 * hp.k;
    if (near(hp.rotate)) mode = 'rotate';
    else if (hp.corners.some(near)) mode = 'scale';
  }
  if (!mode) {
    const hit = hitTest(px, py);
    if (!hit) {
      select(null);
      return;
    }
    c = hit;
    select(c.id);
    mode = 'move';
  }
  const local = clamp(store.time - c.start, 0, c.duration);
  const bb = renderer.boxes.get(c.id);
  pdrag = {
    mode, c, local, px, py, moved: false,
    ox: getP(c, 'x', local), oy: getP(c, 'y', local), os: getP(c, 'scale', local), or: getP(c, 'rotation', local),
    cx: bb.cx, cy: bb.cy, d0: Math.hypot(px - bb.cx, py - bb.cy) || 1, a0: Math.atan2(py - bb.cy, px - bb.cx),
  };
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touchPts.has(e.pointerId)) touchPts.set(e.pointerId, toProject(e));
  if (pdrag?.mode === 'pinch') {
    if (touchPts.size < 2) return;
    const ps = pinchState();
    setP(pdrag.c, 'scale', clamp(pdrag.os * (ps.d / pdrag.d0), 0.01, 20), pdrag.local);
    setP(pdrag.c, 'rotation', Math.round((pdrag.or + ((ps.a - pdrag.a0) * 180) / Math.PI) * 10) / 10, pdrag.local);
    emit('props');
    return;
  }
  const [px, py] = toProject(e);
  if (!pdrag) {
    // 游標樣式
    const c = selected();
    const b = c && renderer.boxes.get(c.id);
    let cur = 'default';
    if (b) {
      const hp = handlePoints(b);
      const near = ([x, y]) => Math.hypot(x - px, y - py) < 12 * hp.k;
      if (near(hp.rotate)) cur = 'grab';
      else if (hp.corners.some(near)) cur = 'nwse-resize';
      else if (inBox(b, px, py)) cur = 'move';
    }
    overlay.style.cursor = cur;
    return;
  }
  const d = pdrag;
  if (!d.moved) {
    if (Math.hypot(px - d.px, py - d.py) < 2) return;
    d.moved = true;
    checkpoint();
  }
  const k = store.project.width / overlay.clientWidth;
  if (d.mode === 'move') {
    let nx = d.ox + (px - d.px);
    let ny = d.oy + (py - d.py);
    guides = { x: Math.abs(nx) < 8 * k, y: Math.abs(ny) < 8 * k };
    if (guides.x && !e.altKey) nx = 0;
    if (guides.y && !e.altKey) ny = 0;
    setP(d.c, 'x', Math.round(nx), d.local);
    setP(d.c, 'y', Math.round(ny), d.local);
  } else if (d.mode === 'scale') {
    const s = d.os * (Math.hypot(px - d.cx, py - d.cy) / d.d0);
    setP(d.c, 'scale', clamp(s, 0.01, 20), d.local);
  } else {
    let r = d.or + ((Math.atan2(py - d.cy, px - d.cx) - d.a0) * 180) / Math.PI;
    if (e.shiftKey) r = Math.round(r / 15) * 15;
    else for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(r - snap) < 3) r = snap;
    setP(d.c, 'rotation', Math.round(r * 10) / 10, d.local);
  }
  emit('props');
});
const endP = (e) => {
  if (e?.pointerType === 'touch') touchPts.delete(e.pointerId);
  if (pdrag?.mode === 'pinch' && touchPts.size >= 2) return;
  if (pdrag?.moved) emit('layout');
  pdrag = null;
  guides = { x: false, y: false };
};
overlay.addEventListener('pointerup', endP);
overlay.addEventListener('pointercancel', endP);
let wheelCp = 0;
overlay.addEventListener('wheel', (e) => {
  const c = selected();
  if (!c || !renderer.boxes.get(c.id)) return;
  e.preventDefault();
  const now = performance.now();
  if (now - wheelCp > 600) checkpoint();
  wheelCp = now;
  const local = clamp(store.time - c.start, 0, c.duration);
  setP(c, 'scale', clamp(getP(c, 'scale', local) * Math.pow(1.0015, -e.deltaY), 0.01, 20), local);
  emit('props');
}, { passive: false });

function drawOverlay() {
  const o = octx;
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.clearRect(0, 0, overlay.width, overlay.height);
  if (exporting) return;
  const W = store.project.width;
  const k = overlay.width / W; // 專案像素 → 畫布像素
  const dpr = devicePixelRatio || 1;
  o.setTransform(k, 0, 0, k, 0, 0);
  o.strokeStyle = '#f472b6';
  o.lineWidth = 1 / k * dpr;
  if (guides.x) { o.beginPath(); o.moveTo(W / 2, 0); o.lineTo(W / 2, store.project.height); o.stroke(); }
  if (guides.y) { o.beginPath(); o.moveTo(0, store.project.height / 2); o.lineTo(W, store.project.height / 2); o.stroke(); }
  const c = selected();
  const b = c && renderer.boxes.get(c.id);
  if (!b) return;
  const px = dpr / k; // 一個 CSS 像素對應多少專案像素
  o.save();
  o.translate(b.cx, b.cy);
  o.rotate((b.rot * Math.PI) / 180);
  o.strokeStyle = '#22d3ee';
  o.lineWidth = 1.5 * px;
  o.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  o.beginPath();
  o.moveTo(0, -b.h / 2);
  o.lineTo(0, -b.h / 2 - 28 * px);
  o.stroke();
  o.fillStyle = '#fff';
  const hs = 9 * px;
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    o.fillRect((x * b.w) / 2 - hs / 2, (y * b.h) / 2 - hs / 2, hs, hs);
    o.strokeRect((x * b.w) / 2 - hs / 2, (y * b.h) / 2 - hs / 2, hs, hs);
  }
  o.beginPath();
  o.arc(0, -b.h / 2 - 28 * px, 6 * px, 0, Math.PI * 2);
  o.fill();
  o.stroke();
  o.restore();
}

// ---------- 主迴圈 ----------
let lastTs = performance.now();
function loop(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  const dur = projectDuration();
  if (store.playing) {
    store.time += dt;
    if (store.time >= dur) {
      store.time = Math.max(0, dur - 0.001);
      pause();
      exporting?.finish?.();
    }
    emit('time');
  }
  renderer.sync(store.time, store.playing);
  renderer.draw(store.time);
  drawOverlay();
  timeline.updatePlayhead();
  $('timeCur').textContent = fmtTime(store.time);
  $('timeDur').textContent = fmtTime(dur);
  $('stageEmpty').style.display = store.project.clips.length ? 'none' : '';
  if (exporting?.progress) exporting.progress(store.time / dur);
  requestAnimationFrame(loop);
}

// ---------- 匯出 ----------
function supportedFormats() {
  const list = [
    ['mp4', 'MP4（H.264，相容性最好）', ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']],
    ['webm', 'WebM（VP9）', ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']],
  ];
  return list
    .map(([ext, label, mimes]) => ({ ext, label, mime: mimes.find((m) => window.MediaRecorder?.isTypeSupported(m)) }))
    .filter((f) => f.mime);
}
function download(blob, ext) {
  const a = h('a', { href: URL.createObjectURL(blob), download: `${store.project.name || 'video'}.${ext}` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function openExport() {
  const dur = projectDuration();
  if (dur <= 0) return toast('時間軸是空的，沒有東西可以匯出');
  if (canFastExport()) return openFastExport(dur);
  openRecordExport(dur);
}

// WebCodecs 離線匯出：多種格式、解析度、影格率、畫質（對話框與編碼程式只在打開時才載入）
async function openFastExport() {
  const { openExportDialog } = await import('./exportdialog.js');
  openExportDialog({ pause, download, setExporting: (on) => (exporting = on ? { offline: true } : null) });
}

// 備援：瀏覽器不支援 WebCodecs 時，用 MediaRecorder 即時錄製
function openRecordExport(dur) {
  const formats = supportedFormats();
  if (!formats.length) return toast('這個瀏覽器不支援錄製影片，請改用最新版 Chrome / Edge');
  pause();
  const fmtSel = h('select', {}, formats.map((f, i) => h('option', { value: i }, f.label)));
  const q = h('select', {}, [['8000000', '標準（8 Mbps）'], ['16000000', '高畫質（16 Mbps）'], ['40000000', '極致（40 Mbps）']].map(([v, l]) => h('option', { value: v }, l)));
  q.value = '16000000';
  const bar = h('div', { class: 'bar' });
  const status = h('div', { class: 'dim' }, `長度 ${fmtTime(dur)}，解析度 ${store.project.width}×${store.project.height}，${store.project.fps} fps`);
  const goBtn = h('button', { class: 'primary' }, '開始匯出');
  const cancelBtn = h('button', {}, '取消');
  const close = openModal(h('div', { class: 'export' },
    h('h2', {}, '匯出影片'),
    h('div', { class: 'row' }, h('label', {}, '格式'), fmtSel),
    h('div', { class: 'row' }, h('label', {}, '畫質'), q),
    status,
    h('div', { class: 'progress' }, bar),
    h('div', { class: 'hint' }, '匯出採即時錄製：請保持此分頁在前景，匯出時間約等於影片長度。'),
    h('div', { class: 'modal-actions' }, cancelBtn, goBtn)));
  cancelBtn.onclick = () => {
    if (exporting) exporting.cancel();
    else close();
  };
  goBtn.onclick = async () => {
    goBtn.disabled = true;
    fmtSel.disabled = q.disabled = true;
    status.textContent = '準備中…';
    const f = formats[+fmtSel.value];
    try {
      const blob = await recordExport(f.mime, +q.value, (p) => {
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        status.textContent = `匯出中… ${(p * 100).toFixed(0)}%`;
      });
      if (blob) {
        download(blob, f.ext);
        toast(`匯出完成（${(blob.size / 1e6).toFixed(1)} MB）`);
      }
    } catch (e) {
      console.error(e);
      toast('匯出失敗：' + e.message);
    }
    close();
  };
}
async function recordExport(mime, bitrate, onProgress) {
  const ac = renderer.ensureAudio();
  await ac?.resume();
  const fps = store.project.fps;
  store.time = 0;
  emit('time');
  renderer.sync(0, false);
  await new Promise((r) => setTimeout(r, 700));
  const stream = canvas.captureStream(fps);
  renderer.recDest?.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  let cancelled = false;
  exporting = {
    progress: onProgress,
    finish: () => rec.state !== 'inactive' && rec.stop(),
    cancel: () => {
      cancelled = true;
      pause();
      if (rec.state !== 'inactive') rec.stop();
    },
  };
  rec.start(500);
  play();
  await stopped;
  exporting = null;
  stream.getVideoTracks().forEach((t) => t.stop());
  if (cancelled) return null;
  return new Blob(chunks, { type: mime.split(';')[0] });
}

// ---------- 頂部按鈕 ----------
$('btnPlay').onclick = togglePlay;
$('btnStart').onclick = () => seek(0);
$('btnEnd').onclick = () => seek(projectDuration());
$('btnBack').onclick = () => seek(store.time - 1 / store.project.fps);
$('btnFwd').onclick = () => seek(store.time + 1 / store.project.fps);
$('btnFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());
$('btnUndo').onclick = doUndo;
$('btnRedo').onclick = doRedo;
$('btnExport').onclick = openExport;
$('btnShot').onclick = () => canvas.toBlob((b) => {
  const a = h('a', { href: URL.createObjectURL(b), download: `${store.project.name}-${fmtTime(store.time).replace(/[:.]/g, '-')}.png` });
  a.click();
});
$('btnNew').onclick = async () => {
  if (!confirm('清空目前專案和素材庫，開始新專案？（無法復原）')) return;
  pause();
  store.project = newProject();
  store.selection = null;
  store.time = 0;
  resetHistory();
  await clearMedia();
  emit('project');
  emit('select');
};
const projName = $('projName');
projName.addEventListener('change', () => {
  store.project.name = projName.value.trim() || '未命名專案';
  emit('props');
});
on('project', () => (projName.value = store.project.name));

document.querySelector('.tl-toolbar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  ({
    split, delete: remove, duplicate, detach,
    addTrack: () => { checkpoint(); addTrack(0); emit('project'); },
    zoomIn: () => timeline.setZoom(store.zoom * 1.3),
    zoomOut: () => timeline.setZoom(store.zoom / 1.3),
    zoomFit: () => timeline.zoomFit(),
  })[act]?.();
});
$('snapToggle').addEventListener('change', (e) => (store.snap = e.target.checked));

// 拖曳調整時間軸高度
$('tlResize').addEventListener('pointerdown', (e) => {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const hgt = clamp(window.innerHeight - ev.clientY, 160, window.innerHeight - 260);
    document.getElementById('app').style.setProperty('--tl-h', hgt + 'px');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
});

document.addEventListener('click', (e) => e.target.closest('button')?.blur());

// 手機版底部分頁：素材 / 編輯 / 時間軸
const appEl = document.getElementById('app');
appEl.dataset.mtab = 'timeline';
$('mobileNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mtab]');
  if (!b) return;
  appEl.dataset.mtab = b.dataset.mtab;
  for (const x of $('mobileNav').children) x.classList.toggle('on', x === b);
});
on('select', () => $('mobileNav').querySelector('[data-mtab=inspector]').classList.toggle('has', !!store.selection));
window.addEventListener('pointerdown', () => renderer.ensureAudio(), { once: true, capture: true });

// ---------- 鍵盤 ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=color])')) return;
  if (exporting) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const isRange = !!e.target.matches?.('input[type=range]');
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && k === 'y') { e.preventDefault(); doRedo(); }
  else if (mod && k === 'd') { e.preventDefault(); duplicate(); }
  else if (mod && k === 'c') copy();
  else if (mod && k === 'v') paste();
  else if (mod && k === 'b') { e.preventDefault(); split(); }
  else if (mod) return;
  else if (k === 's') split();
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); remove(); }
  else if (isRange) return;
  else if (k === 'arrowleft') { e.preventDefault(); seek(store.time - (e.shiftKey ? 1 : 1 / store.project.fps)); }
  else if (k === 'arrowright') { e.preventDefault(); seek(store.time + (e.shiftKey ? 1 : 1 / store.project.fps)); }
  else if (k === 'home') seek(0);
  else if (k === 'end') seek(projectDuration());
  else if (k === '=' || k === '+') timeline.setZoom(store.zoom * 1.3);
  else if (k === '-') timeline.setZoom(store.zoom / 1.3);
  else if (k === 'escape') select(null);
});

// ---------- 自動儲存 ----------
const save = debounce(() => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(store.project));
  } catch (e) {
    console.warn('自動儲存失敗', e);
  }
}, 500);
on('*', (evt) => evt !== 'select' && evt !== 'play' && evt !== 'media' && save());

if (import.meta.env.DEV) window.__nova = { store, emit, renderer };

async function boot() {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) store.project = normalizeProject(JSON.parse(saved));
  } catch (e) {
    console.warn('讀取存檔失敗', e);
  }
  emit('project');
  emit('select');
  requestAnimationFrame(loop);
  await restoreMedia();
}
boot();
