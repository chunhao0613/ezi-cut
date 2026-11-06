// 進階剪輯工具：定格、倒放、自動剪靜音、節拍偵測與一鍵卡點
import { store, emit, checkpoint, makeClip, splitClip, deleteClip, getProp, KF_PROPS, placeClip, defaultTrack, addTrack, getClip } from './state.js';
import { srcAt, srcLength, localAt, avgSpeed, mirrorCurve, hasCurve } from './timemap.js';
import { importFiles } from './media.js';
import { detectBeats } from './beats.js';
import { fmtTime } from './ui.js';

const EPS = 1e-3;

// ---------- 定格 ----------
async function grabFrame(m, t) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    const w = await new CanvasSink(vt).getCanvas(Math.max(0, t));
    if (!w) throw new Error('找不到這個時間點的畫面');
    return w.canvas;
  } finally {
    input.dispose?.();
  }
}

/** 在播放頭插入定格畫面，後面的片段往後推 */
export async function freezeFrame(c, t, dur = 2) {
  const m = store.media.get(c.mediaId);
  if (!m?.blob) throw new Error('找不到影片檔');
  const local = Math.min(Math.max(0, t - c.start), c.duration - 0.01);
  const frame = await grabFrame(m, srcAt(c, local));
  const blob = await new Promise((r) => frame.toBlob(r, 'image/png'));
  const [img] = await importFiles([new File([blob], `${m.name.replace(/\.[^.]+$/, '')} 定格 ${fmtTime(t)}.png`, { type: 'image/png' })]);
  c = getClip(c.id);
  if (!c) throw new Error('處理期間片段已被刪除');
  checkpoint();
  let at = c.start + local;
  if (local > 0.05) splitClip(c, at);
  else at = c.start; // 太靠近開頭就直接插在片段前面
  for (const o of store.project.clips) if (o.trackId === c.trackId && o.start >= at - EPS) o.start += dur;
  const transform = {};
  for (const p of KF_PROPS) transform[p] = getProp(c, p, local);
  const still = makeClip('image', {
    mediaId: img.id, trackId: c.trackId, start: at, duration: dur, transform,
    filters: { ...c.filters }, effects: { ...c.effects }, crop: { ...c.crop }, chroma: { ...c.chroma },
    grade: structuredClone(c.grade), mask: structuredClone(c.mask), aiMatte: { ...c.aiMatte },
    fit: c.fit, bgBlur: c.bgBlur, blend: c.blend,
  });
  store.project.clips.push(still);
  store.selection = still.id;
  emit('project');
  emit('select');
  return still;
}

// ---------- 倒放 ----------
export async function toggleReverse(c, onProgress) {
  if (c.reversed) {
    checkpoint();
    // 倒放素材的時間 r 對應原始素材的 R.in + 長度 - r；片段被分割或修剪過也能還原到正確的範圍
    const R = c.reversed;
    const revLen = R.len ?? store.media.get(c.mediaId)?.duration;
    c.in = isFinite(revLen) ? Math.max(0, R.in + revLen - (c.in + srcLength(c))) : R.in;
    c.mediaId = R.mediaId;
    c.reversed = null;
    if (hasCurve(c)) c.curve = { ...c.curve, pts: mirrorCurve(c.curve.pts) };
    emit('project');
    return;
  }
  const m = store.media.get(c.mediaId);
  if (!m?.blob) throw new Error('找不到影片檔');
  const { makeReversed } = await import('./reverse.js');
  const in0 = c.in;
  const end = Math.min(m.duration, in0 + srcLength(c));
  const file = await makeReversed(m, in0, end, onProgress);
  const [rm] = await importFiles([file]);
  c = getClip(c.id);
  if (!c) throw new Error('處理期間片段已被刪除');
  checkpoint();
  c.reversed = { mediaId: c.mediaId, in: in0, len: end - in0 };
  c.mediaId = rm.id;
  c.in = 0;
  if (hasCurve(c)) c.curve = { ...c.curve, pts: mirrorCurve(c.curve.pts) };
  emit('project');
}

// ---------- 人聲增強 ----------
export async function enhanceClipVoice(c, opts, onProgress) {
  const m = store.media.get(c.mediaId);
  if (!m?.blob) throw new Error('找不到音訊檔');
  if (m.hasAudio === false) throw new Error('這個片段沒有聲音');
  const { enhanceVoice } = await import('./voice.js');
  const [nm] = await importFiles([await enhanceVoice(m, opts, onProgress)]);
  c = getClip(c.id);
  if (!c) throw new Error('處理期間片段已被刪除');
  checkpoint();
  if (c.type === 'video') {
    // 影片：把增強後的聲音放成獨立音軌，原影片靜音
    const a = makeClip('audio', {
      mediaId: nm.id, start: c.start, duration: c.duration, in: c.in, speed: c.speed, curve: structuredClone(c.curve),
      keepPitch: c.keepPitch, volume: c.volume || 1, fadeIn: c.fadeIn, fadeOut: c.fadeOut, enhanced: { mediaId: c.mediaId },
    });
    c.volume = 0;
    placeClip(a, defaultTrack('audio'));
  } else {
    c.enhanced = { mediaId: c.mediaId };
    c.mediaId = nm.id;
  }
  emit('project');
}
export function restoreVoice(c) {
  if (!c.enhanced) return;
  checkpoint();
  c.mediaId = c.enhanced.mediaId;
  c.enhanced = null;
  emit('project');
}

// ---------- 片段之間的轉場 ----------
// 把 next 和同軌道之後的片段一起移動
function shiftFrom(c, delta) {
  const t0 = c.start;
  for (const o of store.project.clips) if (o.trackId === c.trackId && o.start >= t0 - 1e-6) o.start = Math.max(0, o.start + delta);
}

/** 在相鄰兩段之間加轉場：後一段往前疊上 dur 秒，並以轉場效果出現，聲音交叉淡化 */
export function applyCrossTransition(prev, next, type, dur) {
  checkpoint();
  if (next.xfade) shiftFrom(next, next.xfade.dur);
  const d = Math.max(0.1, Math.min(dur, prev.duration * 0.5, next.duration * 0.5));
  shiftFrom(next, -d);
  next.transIn = { type, dur: d };
  next.xfade = { dur: d, prevId: prev.id, type };
  next.fadeIn = d;
  prev.fadeOut = d;
  emit('project');
}
export function removeCrossTransition(prev, next) {
  if (!next.xfade) return;
  checkpoint();
  shiftFrom(next, next.xfade.dur);
  next.transIn = { type: 'none', dur: 0.5 };
  next.fadeIn = 0;
  if (prev) prev.fadeOut = 0;
  next.xfade = null;
  emit('project');
}

// ---------- 文字轉語音 ----------
function voiceTrack() {
  let t = store.project.tracks.find((x) => x.kind === 'voice');
  if (!t) {
    t = addTrack(store.project.tracks.length, '配音');
    t.kind = 'voice';
  }
  return t;
}

async function speak(text, voiceId, speed, name, onStatus) {
  const { synthesize } = await import('./tts.js');
  const blob = await synthesize(text, voiceId, { speed: voiceId.startsWith('kokoro') ? speed : 1, onStatus });
  const [m] = await importFiles([new File([blob], `${name}.wav`, { type: 'audio/wav' })]);
  return m;
}
// Piper 沒有語速參數，用變速不變調補上
const pitchSpeed = (voiceId, speed) => (voiceId.startsWith('kokoro') ? 1 : speed);

/** 把一個文字片段念出來，放在同一個時間點的配音軌 */
export async function textClipToSpeech(c, voiceId, speed, onStatus) {
  const text = c.text.content.trim();
  const m = await speak(text, voiceId, speed, `配音 ${text.slice(0, 12)}`, onStatus);
  checkpoint();
  const sp = pitchSpeed(voiceId, speed);
  const a = makeClip('audio', { mediaId: m.id, trackId: voiceTrack().id, start: c.start, duration: m.duration / sp, speed: sp, keepPitch: true });
  placeClip(a, a.trackId);
  emit('project');
  return a;
}

/** 幫所有字幕配音；念不完的句子自動加快（最多 1.6 倍）以免蓋到下一句 */
export async function captionsToSpeech(captions, voiceId, speed, onStatus) {
  const made = [];
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    onStatus?.({ text: `配音中… ${i + 1}/${captions.length}`, progress: i / captions.length });
    made.push({ c, m: await speak(c.text.content.trim(), voiceId, speed, `字幕配音 ${i + 1}`) });
  }
  checkpoint();
  const track = voiceTrack();
  store.project.clips = store.project.clips.filter((x) => !(x.trackId === track.id && x.ttsOf));
  let prevEnd = -Infinity;
  made.forEach(({ c, m }, i) => {
    // 上一句還沒念完就往後排，聲音不會重疊
    const start = Math.max(c.start, prevEnd);
    const next = captions[i + 1]?.start ?? Infinity;
    const room = Math.max(0.3, next - start);
    const base = pitchSpeed(voiceId, speed);
    const sp = Math.min(1.6, Math.max(base, m.duration / room));
    const clip = makeClip('audio', {
      mediaId: m.id, trackId: track.id, start, duration: m.duration / sp, speed: sp, keepPitch: true, ttsOf: c.id,
    });
    store.project.clips.push(clip);
    prevEnd = start + clip.duration;
  });
  emit('project');
  return made.length;
}

// ---------- 波紋刪除 ----------
// 兩個片段是否來自同一段素材（分離出的音訊、人聲增強後的音軌都算）
const linkedMedia = (o, c) =>
  !!o.mediaId && (o.mediaId === c.mediaId || o.enhanced?.mediaId === c.mediaId || c.enhanced?.mediaId === o.mediaId || (o.enhanced && o.enhanced.mediaId === c.enhanced?.mediaId));

/** 刪掉時間軸 [a, b) 這段：cutTracks 上的片段被切掉，其他軌道上 b 之後的片段往前補 */
export function rippleDelete(a, b, cutTracks) {
  const len = b - a;
  // 沒被剪的軌道上若有片段橫跨剪掉的位置（例如背景音樂），整條軌道維持原位，不然後面的片段會疊上去
  const keep = new Set();
  for (const c of store.project.clips) {
    if (!cutTracks.has(c.trackId) && c.start < a - EPS && c.start + c.duration > a + EPS) keep.add(c.trackId);
  }
  for (const c of [...store.project.clips]) {
    if (!cutTracks.has(c.trackId)) continue;
    if (c.start + c.duration <= a + EPS || c.start >= b - EPS) continue;
    let part = c;
    if (part.start < a - 0.05) part = splitClip(part, a) || part;
    if (part.start + part.duration > b + 0.05) splitClip(part, b);
    if (part.start >= a - 0.06 && part.start + part.duration <= b + 0.06) deleteClip(part);
  }
  for (const c of store.project.clips) {
    if (keep.has(c.trackId)) continue;
    if (c.start >= b - EPS) c.start -= len;
    else if (c.start > a && c.start < b) c.start = a;
  }
}

// ---------- 自動剪靜音 ----------
/** 依音量找出片段裡的靜音段，回傳時間軸上的 [開始, 結束] */
export function findSilences(c, { db = -40, minDur = 0.5, pad = 0.12 } = {}) {
  const m = store.media.get(c.mediaId);
  if (!m?.peaks) throw new Error('這個片段沒有音訊波形資料（檔案太大或沒有聲音）');
  const thr = Math.pow(10, db / 20);
  const s0 = Math.floor(c.in * 100);
  const s1 = Math.floor((c.in + srcLength(c)) * 100);
  const out = [];
  let run = -1;
  for (let i = s0; i <= s1; i++) {
    const quiet = i < s1 && (m.peaks[i] ?? 0) < thr;
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      if ((i - run) / 100 >= minDur) {
        // 頭尾的靜音整段剪，中間的靜音兩側各留一點呼吸
        const a = run / 100 - c.in + (run === s0 ? 0 : pad);
        const b = i / 100 - c.in - (i === s1 ? 0 : pad);
        if (b - a > 0.08) out.push([c.start + localAt(c, a), c.start + localAt(c, b)]);
      }
      run = -1;
    }
  }
  return out;
}

export function removeSilences(c, ranges) {
  if (!ranges.length) return 0;
  checkpoint();
  // 同一支影片拆出去的音訊、字幕軌也要一起剪，才不會對不上
  const cut = new Set([c.trackId]);
  for (const o of store.project.clips) {
    if (o !== c && Math.abs(o.start - c.start) < 0.05 && linkedMedia(o, c)) cut.add(o.trackId);
  }
  for (const t of store.project.tracks) if (t.kind?.startsWith('caption')) cut.add(t.id);
  let removed = 0;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) {
    rippleDelete(a, b, cut);
    removed += b - a;
  }
  emit('project');
  return removed;
}

// ---------- 節拍 ----------
export async function analyzeBeats(c) {
  const m = store.media.get(c.mediaId);
  if (!m?.blob) throw new Error('找不到音訊檔');
  if (!m.beats) m.beats = await detectBeats(m.blob);
  emit('layout');
  return m.beats;
}

// 片段範圍內的節拍（時間軸時間）
export function clipBeats(c, { every = 1, downbeats = false } = {}) {
  const m = store.media.get(c.mediaId);
  if (!m?.beats) return [];
  const list = downbeats ? m.beats.downbeats : m.beats.beats;
  const out = [];
  for (const b of list) {
    const off = b - c.in;
    if (off >= 0 && off <= srcLength(c)) out.push(c.start + localAt(c, off));
  }
  return out.filter((_, i) => i % every === 0);
}

/** 一鍵卡點：把目標軌道上的畫面片段依序對齊到音樂節拍 */
export function beatSync(music, trackId, opts) {
  const cuts = clipBeats(music, opts);
  if (cuts.length < 2) throw new Error('節拍太少，請先偵測節拍或換一段音樂');
  if (cuts[0] > music.start + 0.05) cuts.unshift(music.start);
  const visuals = store.project.clips
    .filter((c) => c.trackId === trackId && (c.type === 'video' || c.type === 'image'))
    .sort((a, b) => a.start - b.start);
  if (!visuals.length) throw new Error('目標軌道上沒有影片或圖片');
  checkpoint();
  let k = 0;
  let tail = cuts[0];
  for (const v of visuals) {
    const m = store.media.get(v.mediaId);
    const maxLen = v.type === 'video' && m && isFinite(m.duration) ? (m.duration - v.in) / avgSpeed(v) : Infinity;
    const start = k < cuts.length ? cuts[k] : tail;
    let j = k + 1;
    let dur;
    if (j < cuts.length && cuts[j] - start <= maxLen + EPS) dur = cuts[j] - start;
    else if (j < cuts.length) {
      dur = maxLen; // 素材不夠長：用完為止，下一段接在下一個節拍
      while (j < cuts.length && cuts[j] < start + dur - EPS) j++;
    } else dur = Math.min(maxLen, 1);
    v.start = start;
    v.duration = Math.max(0.1, dur);
    tail = start + v.duration;
    k = j;
  }
  emit('project');
  return visuals.length;
}

