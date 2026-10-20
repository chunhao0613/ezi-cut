// 範本（剪同款）：內建範本 + 把自己的專案存成範本；套用時只要換上自己的素材與文字
import { store, emit, checkpoint, makeClip, uid, normalizeProject, newProject, select } from './state.js';
import { TEXT_PRESETS, FILTER_PRESETS } from './effects.js';
import { importFiles } from './media.js';
import * as db from './db.js';

// ---------- 內建範本 ----------
const T = (name) => TEXT_PRESETS.find((p) => p.name === name);
const filt = (name) => ({ ...FILTER_PRESETS.find((p) => p.name === name).filters });
function proj(w, h, build) {
  const p = newProject();
  p.width = w;
  p.height = h;
  const [txt, overlay, main] = p.tracks;
  const clips = [];
  let slotN = 0;
  const api = {
    slot: (start, duration, extra = {}) => {
      const c = makeClip('image', { trackId: main.id, start, duration, fit: 'cover', ...extra });
      c.slot = { label: `素材 ${++slotN}` };
      clips.push(c);
      return c;
    },
    text: (preset, content, start, duration, extra = {}) => {
      const pr = T(preset);
      const c = makeClip('text', { trackId: txt.id, start, duration, text: { ...pr.text, content }, transIn: pr.transIn || {}, transOut: pr.transOut || {}, transform: pr.transform || {}, ...extra });
      c.editable = true;
      clips.push(c);
      return c;
    },
    sticker: (emoji, start, duration, transform) => {
      clips.push(makeClip('text', { trackId: overlay.id, start, duration, text: { content: emoji, size: 200 }, transform, transIn: { type: 'bounce', dur: 0.4 } }));
    },
    shape: (shape, start, duration, extra = {}) => clips.push(makeClip('shape', { trackId: overlay.id, start, duration, shape, ...extra })),
  };
  build(api);
  p.clips = clips;
  return p;
}

export const BUILTIN_TEMPLATES = [
  {
    id: 'tpl:travel', name: '旅行 Vlog 開場', desc: '3 段畫面＋電影片名，16:9', icon: '✈️', color: '#0ea5e9',
    make: () => proj(1920, 1080, ({ slot, text, shape }) => {
      const f = filt('電影感');
      slot(0, 2.5, { filters: f, transIn: { type: 'zoomOut', dur: 0.8 }, keyframes: { scale: [{ t: 0, v: 1 }, { t: 2.5, v: 1.12 }] } });
      slot(2.5, 2.5, { filters: f, transIn: { type: 'slideL', dur: 0.4 } });
      slot(5, 3, { filters: f, transIn: { type: 'slideL', dur: 0.4 }, transOut: { type: 'fade', dur: 0.8 } });
      text('電影片名', 'MY  JOURNEY', 0.6, 3.2);
      text('字幕', '寫下這趟旅程的一句話', 5.2, 2.6);
      shape({ kind: 'letterbox', color: '#000000', h: 120 }, 0, 8);
    }),
  },
  {
    id: 'tpl:beat6', name: '六連拍卡點', desc: '6 張照片快速切換＋閃白，9:16', icon: '⚡', color: '#f43f5e',
    make: () => proj(1080, 1920, ({ slot, text }) => {
      for (let i = 0; i < 6; i++) slot(i * 0.5, 0.5, { transIn: { type: i % 2 ? 'flash' : 'zoomIn', dur: 0.15 }, effects: { glitch: i === 5 ? 20 : 0 } });
      slot(3, 2, { transIn: { type: 'flash', dur: 0.2 }, keyframes: { scale: [{ t: 0, v: 1.15 }, { t: 2, v: 1 }] } });
      text('綜藝字', 'WEEKEND!', 3.1, 1.9);
    }),
  },
  {
    id: 'tpl:product', name: '產品介紹', desc: '3 段畫面＋三個賣點字卡，16:9', icon: '🛍️', color: '#a855f7',
    make: () => proj(1920, 1080, ({ slot, text, shape }) => {
      ['賣點一：輕巧好攜帶', '賣點二：續航一整天', '賣點三：現在下單享優惠'].forEach((s, i) => {
        slot(i * 3, 3, { transIn: { type: 'wipeL', dur: 0.4 }, filters: filt('鮮豔') });
        shape({ kind: 'rect', color: '#111827', w: 900, h: 130, radius: 40 }, i * 3 + 0.3, 2.6, { transform: { x: -420, y: 380, opacity: 0.85 }, transIn: { type: 'slideL', dur: 0.35 } });
        text('字幕', s, i * 3 + 0.4, 2.5, { transform: { x: -420, y: 380 }, transIn: { type: 'slideL', dur: 0.35 } });
      });
      text('大標題', '新品上市', 0, 1.6, { transform: { y: -300 } });
    }),
  },
  {
    id: 'tpl:birthday', name: '生日祝福', desc: '4 張照片＋祝福字卡與貼圖，9:16', icon: '🎂', color: '#f59e0b',
    make: () => proj(1080, 1920, ({ slot, text, sticker }) => {
      for (let i = 0; i < 4; i++) slot(i * 2, 2, { bgBlur: true, fit: 'contain', transIn: { type: 'bounce', dur: 0.5 }, filters: filt('暖陽') });
      text('綜藝字', '生日快樂！', 0.3, 7.7, { transform: { y: -650 }, text: { ...T('綜藝字').text, content: '生日快樂！', anim: 'pulse' } });
      sticker('🎂', 0.5, 7.5, { x: -330, y: 700 });
      sticker('🎉', 1, 7, { x: 330, y: 680 });
    }),
  },
  {
    id: 'tpl:beforeafter', name: 'Before / After 對比', desc: '前後對比，擦除轉場，16:9', icon: '↔️', color: '#10b981',
    make: () => proj(1920, 1080, ({ slot, text }) => {
      slot(0, 5);
      slot(1.5, 3.5, { transIn: { type: 'wipeR', dur: 1.2 } });
      text('標籤', 'BEFORE', 0, 1.5, { transform: { x: -760, y: -440 } });
      text('標籤', 'AFTER', 1.5, 3.5, { transform: { x: 760, y: -440 }, text: { ...T('標籤').text, content: 'AFTER', bgColor: '#10b981' } });
    }),
  },
  {
    id: 'tpl:countdown', name: '倒數開場', desc: '3、2、1 倒數後進入影片，16:9', icon: '⏱️', color: '#64748b',
    make: () => proj(1920, 1080, ({ slot, text, shape }) => {
      shape({ kind: 'gradient', color: '#0f172a', color2: '#4c1d95' }, 0, 3);
      ['3', '2', '1'].forEach((n, i) => text('大標題', n, i, 1, { transIn: { type: 'zoomOut', dur: 0.3 }, transOut: { type: 'fade', dur: 0.2 }, text: { ...T('大標題').text, content: n, size: 400 } }));
      slot(3, 5, { transIn: { type: 'flash', dur: 0.3 } });
    }),
  },
  {
    id: 'tpl:story', name: '限時動態', desc: '一段影片＋標題與說明條，9:16', icon: '📱', color: '#ec4899',
    make: () => proj(1080, 1920, ({ slot, text, shape }) => {
      slot(0, 6, { fit: 'contain', bgBlur: true });
      text('漸層', '今日分享', 0.2, 5.8, { transform: { y: -720 } });
      shape({ kind: 'rect', color: '#000000', w: 1080, h: 220 }, 0.5, 5.5, { transform: { y: 760, opacity: 0.55 } });
      text('字幕', '在這裡寫一句說明', 0.6, 5.4, { transform: { y: 760 } });
    }),
  },
];

// ---------- 使用者範本 ----------
export async function restoreTemplates(rows) {
  for (const r of rows) if (r.type === 'template') store.templates.set(r.id, r);
}

/** 把目前專案存成範本：slotIds 是可替換的畫面片段 */
export async function saveTemplate(name, slotIds) {
  const p = structuredClone(store.project);
  const slots = new Set(slotIds);
  const files = {};
  p.clips.forEach((c) => {
    c.slot = slots.has(c.id) ? { label: `素材 ${[...slots].indexOf(c.id) + 1}` } : undefined;
    if (c.type === 'text' && !c.caption) c.editable = true;
    if (c.slot) c.mediaId = null;
    else if (c.mediaId && !files[c.mediaId]) {
      const m = store.media.get(c.mediaId);
      if (m?.blob) files[c.mediaId] = { blob: m.blob, name: m.name, type: m.type };
    }
  });
  const thumb = document.getElementById('canvas').toDataURL('image/jpeg', 0.6);
  const id = uid();
  const rec = { id, type: 'template', name, project: p, files, thumb, created: Date.now() };
  await db.put(id, rec);
  store.templates.set(id, rec);
  emit('templates');
  return rec;
}
export async function deleteTemplate(id) {
  store.templates.delete(id);
  await db.del(id).catch(() => {});
  emit('templates');
}

export function getTemplate(id) {
  const b = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (b) return { id, name: b.name, project: b.make(), files: {}, builtin: true };
  return store.templates.get(id);
}
export const slotsOf = (tpl) => tpl.project.clips.filter((c) => c.slot).sort((a, b) => a.start - b.start);
export const textsOf = (tpl) => tpl.project.clips.filter((c) => c.type === 'text' && c.editable && !/\p{Extended_Pictographic}/u.test(c.text.content));

/** 套用範本：fills[i] = 媒體（依 slotsOf 順序），texts[clipId] = 新文字；會取代目前專案（可復原） */
export async function applyTemplate(tpl, fills, texts) {
  const p = normalizeProject(structuredClone(tpl.project));
  // 範本內附的素材（音樂、貼圖）匯入媒體庫
  const idMap = {};
  for (const [oldId, f] of Object.entries(tpl.files || {})) {
    // 媒體庫裡已經有同名同大小的檔案就直接沿用，避免重複匯入
    const same = [...store.media.values()].find((m) => m.name === f.name && m.size === f.blob.size);
    if (same) {
      idMap[oldId] = same.id;
      continue;
    }
    const [m] = await importFiles([new File([f.blob], f.name, { type: f.blob.type })]);
    if (m) idMap[oldId] = m.id;
  }
  const slotOrder = slotsOf({ project: p });
  for (const c of p.clips) {
    const orig = c.id;
    c.id = uid();
    if (c.mediaId && idMap[c.mediaId]) c.mediaId = idMap[c.mediaId];
    if (c.type === 'text' && texts[orig] != null) c.text.content = texts[orig];
  }
  slotOrder.forEach((c, i) => {
    const m = fills[i];
    if (!m) return;
    c.mediaId = m.id;
    c.type = m.type === 'video' ? 'video' : 'image';
    c.in = 0;
    if (m.type === 'video' && isFinite(m.duration)) c.duration = Math.min(c.duration, m.duration / (c.speed || 1));
  });
  checkpoint();
  store.project = p;
  store.selection = null;
  emit('project');
  select(null);
}

// ---------- 範本檔案匯出 / 匯入（可分享給別人） ----------
const toB64 = (blob) => new Promise((r) => {
  const fr = new FileReader();
  fr.onload = () => r(fr.result);
  fr.readAsDataURL(blob);
});
export async function exportTemplateFile(tpl) {
  const files = {};
  for (const [id, f] of Object.entries(tpl.files || {})) files[id] = { name: f.name, type: f.type, data: await toB64(f.blob) };
  const json = JSON.stringify({ novacutTemplate: 1, name: tpl.name, project: tpl.project, thumb: tpl.thumb, files });
  return new Blob([json], { type: 'application/json' });
}
export async function importTemplateFile(file) {
  const d = JSON.parse(await file.text());
  if (!d.novacutTemplate) throw new Error('這不是 NovaCut 範本檔');
  const files = {};
  for (const [id, f] of Object.entries(d.files || {})) files[id] = { name: f.name, type: f.type, blob: await (await fetch(f.data)).blob() };
  const id = uid();
  const rec = { id, type: 'template', name: d.name, project: d.project, files, thumb: d.thumb, created: Date.now() };
  await db.put(id, rec);
  store.templates.set(id, rec);
  emit('templates');
  return rec;
}
