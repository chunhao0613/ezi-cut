// AI 自動字幕（Whisper）、字幕軌、SRT 匯入匯出
import { store, emit, checkpoint, makeClip, addTrack, getClip } from './state.js';
import { detectDevice } from './device.js';
import { idleWorker } from './idle.js';
import { srcLength, localAt } from './timemap.js';

// 模型與各精度的實際檔案大小（MB，[encoder, decoder]，取自 Hugging Face）
// gpu32：WebGPU 不支援 f16 時；gpu16：WebGPU 支援 shader-f16 時；cpu：WASM 8-bit 量化
export const MODELS = [
  { id: 'onnx-community/whisper-tiny', name: 'Tiny', title: '極速', cost: 0, acc: '準確度較低，中文常有錯字',
    sizes: { gpu32: [32.9, 86.7], gpu16: [16.5, 86.7], cpu: [10.1, 30.7] } },
  { id: 'onnx-community/whisper-base', name: 'Base', title: '平衡', cost: 1, acc: '準確度普通',
    sizes: { gpu32: [82.5, 123.6], gpu16: [41.3, 123.6], cpu: [23.2, 53.7] } },
  { id: 'onnx-community/whisper-small', name: 'Small', title: '精準', cost: 2, acc: '準確度好',
    sizes: { gpu32: [352.8, 233.1], gpu16: [176.6, 233.1], cpu: [92.3, 156.8] } },
  { id: 'onnx-community/whisper-large-v3-turbo', name: 'Large v3 Turbo', title: '最準', cost: 3, acc: '準確度最好，支援粵語',
    sizes: { gpu32: [424.9, 334.1], gpu16: [370.0, 193.5], cpu: [644.8, 439.9] } },
];
const SUFFIX = { fp32: '', fp16: '_fp16', q4: '_q4', q4f16: '_q4f16', q8: '_quantized' };

// 依裝置決定執行方式與精度
export function modelPlan(model, dev, forceCpu = false) {
  if (!dev.webgpu || forceCpu) return { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, size: model.sizes.cpu };
  const big = model.cost === 3; // 大模型的 encoder 用 4-bit，否則要下載 1.3–2.5 GB
  const enc = big ? (dev.f16 ? 'q4f16' : 'q4') : dev.f16 ? 'fp16' : 'fp32';
  const dec = big && dev.f16 ? 'q4f16' : 'q4';
  return { device: 'webgpu', dtype: { encoder_model: enc, decoder_model_merged: dec }, size: dev.f16 ? model.sizes.gpu16 : model.sizes.gpu32 };
}

// 檢查模型檔是否已在瀏覽器快取裡（transformers.js 用 Cache API）
async function isCached(model, plan) {
  try {
    const cache = await caches.open('transformers-cache');
    const urls = (await cache.keys()).map((r) => r.url);
    return Object.entries(plan.dtype).every(([part, dt]) => urls.some((u) => u.includes(`/${model.id}/`) && u.endsWith(`/onnx/${part}${SUFFIX[dt]}.onnx`)));
  } catch {
    return false;
  }
}

const SPEED_TEXT = (diff, mobile) =>
  diff <= -2 ? '非常快' : diff === -1 ? '快' : diff === 0 ? '速度適中' : diff === 1 ? '較慢，裝置可能發熱'
    : mobile ? '很可能跑不動（記憶體不足）' : '很慢，會長時間高負載';

/** 依裝置強度與語言排序模型：推薦的排第一，其餘依接近程度排列 */
export async function rankModels(dev, lang) {
  const cantonese = lang === 'cantonese';
  // 非英文時 tiny 錯字太多，至少推薦 base；粵語只有 turbo 支援
  const rec = cantonese ? 3 : Math.max(dev.tier, lang && lang !== 'english' ? 1 : 0);
  const list = await Promise.all(MODELS.map(async (m) => {
    const plan = modelPlan(m, dev);
    const sizeMB = Math.round(plan.size[0] + plan.size[1]);
    const cached = await isCached(m, plan);
    const diff = m.cost - dev.tier;
    let badge = m.cost === rec ? '★ 推薦' : m.cost < rec ? '更快' : diff >= 2 ? '不建議' : '更準確';
    const warns = [];
    if (cantonese && m.cost !== 3) { badge = '不支援粵語'; warns.push('請改用 Large v3 Turbo'); }
    if (!cached && dev.freeMB != null && sizeMB > dev.freeMB) warns.push('瀏覽器儲存空間不足');
    if (!cached && dev.slowNet && sizeMB > 150) warns.push('目前為省流量 / 慢速網路');
    return { ...m, plan, sizeMB, cached, badge, speed: SPEED_TEXT(diff, dev.mobile), warns, unsupported: cantonese && m.cost !== 3 };
  }));
  const score = (x) => (x.unsupported ? 100 : 0) + Math.abs(x.cost - rec) * 2 + (x.cost > rec ? 1 : 0);
  return list.sort((a, b) => score(a) - score(b));
}
export const ASR_LANGS = [
  ['', '自動偵測'], ['chinese', '中文'], ['english', '英文'], ['japanese', '日文'], ['korean', '韓文'],
  ['cantonese', '粵語（僅 large-v3-turbo）'], ['spanish', '西班牙文'], ['french', '法文'], ['german', '德文'],
];

const SR = 16000;
let jobId = 0;

// 取出片段實際用到的那段聲音，轉成 16kHz 單聲道
async function decodeClipAudio(clip) {
  const m = store.media.get(clip.mediaId);
  if (!m?.blob) throw new Error('找不到這個片段的媒體檔');
  const ctx = new OfflineAudioContext(1, 1, SR);
  let buf;
  try {
    buf = await ctx.decodeAudioData(await m.blob.arrayBuffer());
  } catch {
    throw new Error('這個片段沒有可辨識的聲音');
  }
  const from = Math.floor(clip.in * SR);
  const to = Math.min(buf.length, Math.ceil((clip.in + srcLength(clip)) * SR));
  const out = new Float32Array(Math.max(0, to - from));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] += d[from + i] / buf.numberOfChannels;
  }
  return out;
}

// Whisper Worker：辨識完閒置 2 分鐘就關掉，釋放模型占用的記憶體（大模型可達 1 GB）
const asrWorker = idleWorker(() => new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module' }));
function runWorker(payload, onStatus) {
  const worker = asrWorker.begin();
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const finish = () => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    };
    const onMsg = (e) => {
      const d = e.data;
      if (d.type === 'download') return onStatus({ text: '下載模型中…', progress: d.loaded / d.total });
      if (d.id !== id) return;
      if (d.type === 'status') onStatus({ text: d.text });
      else {
        finish();
        asrWorker.end();
        if (d.type === 'done') resolve(d.chunks);
        else reject(new Error(d.message));
      }
    };
    const onErr = (e) => {
      finish();
      asrWorker.kill(); // 下次重新建立
      asrWorker.end();
      reject(new Error(e?.message || '背景執行緒載入失敗，請重新整理頁面'));
    };
    worker.addEventListener('error', onErr);
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, ...payload });
  });
}
// 顯示卡加速失敗過的模型，之後直接用 CPU，不必每次先失敗一次再重試
const gpuFailed = new Set();

let converter = null;
async function toTraditional(texts) {
  if (!converter) {
    const OpenCC = await import('opencc-js');
    converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
  }
  return texts.map((t) => converter(t));
}

/** 把片段的語音轉成字幕段落（時間已換算成時間軸上的秒數） */
export async function transcribe(clip, { model: modelId, language, traditional }, onStatus) {
  onStatus({ text: '讀取音訊中…' });
  const audio = await decodeClipAudio(clip);
  const total = audio.length / SR;
  if (total < 0.3) throw new Error('片段太短，無法辨識');
  const dev = await detectDevice();
  const model = MODELS.find((m) => m.id === modelId) || MODELS[1];
  const plan = modelPlan(model, dev, gpuFailed.has(model.id));
  let chunks;
  try {
    chunks = await runWorker({ model: model.id, device: plan.device, dtype: plan.dtype, audio, language }, onStatus);
  } catch (e) {
    if (plan.device !== 'webgpu') throw e;
    console.warn('WebGPU 失敗，改用 WASM', e);
    gpuFailed.add(model.id);
    onStatus({ text: '顯示卡加速失敗，改用 CPU 重試…' });
    const cpu = modelPlan(model, dev, true);
    chunks = await runWorker({ model: model.id, device: cpu.device, dtype: cpu.dtype, audio, language }, onStatus);
  }
  let segs = chunks
    .map((c) => ({ start: c.start ?? 0, end: c.end ?? total, text: c.text.trim() }))
    .filter((s) => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text));
  // 只轉中文；自動偵測時看到平假名 / 片假名就判定為日文，不轉
  const isJapanese = !language && segs.some((x) => /[\u3040-\u30ff]/.test(x.text));
  if (traditional && (language === 'chinese' || language === 'cantonese' || (!language && !isJapanese))) {
    const conv = await toTraditional(segs.map((s) => s.text));
    segs = segs.map((s, i) => ({ ...s, text: conv[i] }));
  }
  segs = segs.flatMap((s) => splitSegment(s));
  // 辨識期間片段可能被刪除、移動，或已換成別的專案：以目前時間軸上的片段為準
  const live = getClip(clip.id);
  if (!live) throw new Error('辨識期間來源片段已被刪除或專案已更換，字幕沒有加入');
  clip = live;
  // 來源時間 → 時間軸時間
  return segs.map((s) => ({
    start: clip.start + localAt(clip, Math.min(s.start, total)),
    end: clip.start + localAt(clip, Math.min(Math.max(s.end, s.start + 0.3), total)),
    text: s.text,
  }));
}

// 太長的句子切成適合螢幕閱讀的短句，時間依字數比例分配
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const textLen = (t) => [...t].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0); // 中日韓字算兩個寬度
export function splitSegment(s, maxLen = 40) {
  const text = s.text.replace(/\s+/g, ' ').trim();
  if (textLen(text) <= maxLen) return [{ ...s, text }];
  // 先依標點切，再依空白（西文）或字數（中文）打包
  const parts = text.split(/(?<=[，。！？、；：])|(?<=[,.!?;:]\s)/).filter(Boolean);
  const units = parts.flatMap((p) => (textLen(p) <= maxLen ? [p] : CJK.test(p) ? p.match(new RegExp(`.{1,${maxLen / 2}}`, 'gu')) : p.split(/(?<=\s)/)));
  const lines = [];
  let cur = '';
  for (const u of units) {
    if (cur && textLen(cur + u) > maxLen) {
      lines.push(cur.trim());
      cur = '';
    }
    cur += u;
  }
  if (cur.trim()) lines.push(cur.trim());
  const total = lines.reduce((n, l) => n + textLen(l), 0);
  let t = s.start;
  return lines.map((l) => {
    const d = ((s.end - s.start) * textLen(l)) / total;
    const seg = { start: t, end: t + d, text: l.replace(/[，、,;；]$/, '') };
    t += d;
    return seg;
  });
}

// ---------- 字幕軌 ----------
export function captionStyle() {
  const { width: W, height: H } = store.project;
  const size = Math.round(Math.min(W, H) * 0.055);
  return {
    text: { size, weight: '700', color: '#ffffff', stroke: Math.round(size / 14), strokeColor: '#000000', bg: false, bgOpacity: 0.5 },
    transform: { y: Math.round(H / 2 - H * 0.13) },
  };
}
export function captionTrack(create) {
  let t = store.project.tracks.find((t) => t.kind === 'caption');
  if (!t && create) {
    t = addTrack(0, '字幕');
    t.kind = 'caption';
  }
  return t || null;
}
export const captionClips = () => {
  const t = captionTrack(false);
  return t ? store.project.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start) : [];
};

/** 加入字幕段落，replace = 先清掉這段時間內既有的字幕 */
export function addCaptions(segs, { replace = true } = {}) {
  if (!segs.length) return 0;
  checkpoint();
  const track = captionTrack(true);
  const from = segs[0].start;
  const to = segs[segs.length - 1].end;
  // 沿用目前字幕軌上第一個字幕的樣式（使用者可能改過）；要在刪除舊字幕之前取
  const tpl = captionClips()[0];
  if (replace) store.project.clips = store.project.clips.filter((c) => !(c.trackId === track.id && c.start < to && c.start + c.duration > from));
  const style = captionStyle();
  let prevEnd = 0;
  for (const s of segs) {
    const start = Math.max(s.start, prevEnd);
    const end = Math.max(start + 0.2, s.end);
    const c = makeClip('text', {
      caption: true,
      start, duration: end - start, trackId: track.id,
      text: { ...(tpl ? tpl.text : style.text), content: s.text, anim: 'none' },
      transform: tpl ? { ...tpl.transform } : style.transform,
    });
    store.project.clips.push(c);
    prevEnd = end;
  }
  emit('project');
  return segs.length;
}

export function applyStyleToAll(src) {
  checkpoint();
  for (const c of captionClips()) {
    if (c === src) continue;
    c.text = { ...src.text, content: c.text.content };
    c.transform = { ...src.transform };
    c.filters = { ...src.filters };
    c.effects = { ...src.effects };
    c.transIn = { ...src.transIn };
    c.transOut = { ...src.transOut };
  }
  emit('project');
}

// ---------- 翻譯 / 雙語字幕 ----------
export function translationTrack(create) {
  let t = store.project.tracks.find((x) => x.kind === 'caption-tr');
  if (!t && create) {
    const ci = store.project.tracks.findIndex((x) => x.kind === 'caption');
    t = addTrack(Math.max(0, ci + 1), '字幕（譯文）');
    t.kind = 'caption-tr';
  }
  return t || null;
}
export const translationClips = () => {
  const t = translationTrack(false);
  return t ? store.project.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start) : [];
};
// 找出和某句原文時間重疊最多的譯文
export function translationFor(c) {
  let best = null;
  let bestOv = 0;
  for (const t of translationClips()) {
    const ov = Math.min(c.start + c.duration, t.start + t.duration) - Math.max(c.start, t.start);
    if (ov > bestOv) {
      bestOv = ov;
      best = t;
    }
  }
  return best;
}

/** mode：'bilingual' 譯文放在原文下方的另一條軌道；'replace' 直接取代原文 */
export async function translateCaptions(src, tgt, mode, onStatus) {
  const list = captionClips();
  if (!list.length) throw new Error('目前沒有字幕可以翻譯');
  const { translateTexts } = await import('./translate.js');
  const { texts, engine } = await translateTexts(list.map((c) => c.text.content.replace(/\n/g, ' ')), src, tgt, onStatus);
  // 翻譯可能花好幾分鐘，期間使用者可能復原、刪字幕或開別的專案：用 id 重新找回字幕再寫入
  const ids = list.map((c) => c.id);
  const live = ids.map((id) => getClip(id));
  if (!live.some(Boolean)) throw new Error('翻譯期間字幕已被刪除或專案已更換，譯文沒有加入');
  checkpoint();
  if (mode === 'replace') {
    live.forEach((c, i) => c && (c.text.content = texts[i]));
  } else {
    const track = translationTrack(true);
    store.project.clips = store.project.clips.filter((c) => c.trackId !== track.id);
    live.forEach((c, i) => {
      if (!c) return;
      const size = Math.round(c.text.size * 0.72);
      store.project.clips.push(makeClip('text', {
        caption: true, captionOf: c.id, trackId: track.id, start: c.start, duration: c.duration,
        text: { ...c.text, content: texts[i], size, color: '#fde68a', stroke: Math.max(1, Math.round(size / 14)) },
        transform: { ...c.transform, y: c.transform.y + Math.round(c.text.size * 1.15) },
      }));
    });
  }
  emit('project');
  return { count: live.filter(Boolean).length, engine };
}

// ---------- SRT ----------
const pad = (n, l = 2) => String(n).padStart(l, '0');
function srtTime(t) {
  const ms = Math.round(t * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
/** which：'orig' 原文、'tr' 譯文、'both' 雙語（同一句兩行） */
export function toSRT(which = 'orig') {
  const list = which === 'tr' ? translationClips() : captionClips();
  return list
    .map((c, i) => {
      let body = c.text.content;
      if (which === 'both') body += `\n${translationFor(c)?.text.content || ''}`;
      return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + c.duration)}\n${body.trim()}\n`;
    })
    .join('\n');
}
export function parseSRT(text) {
  const toSec = (s) => {
    const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
    return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000 : NaN;
  };
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = toSec(a);
    const end = toSec(b);
    const body = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!isNaN(start) && !isNaN(end) && body) out.push({ start, end, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}
