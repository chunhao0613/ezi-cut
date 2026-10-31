// 離線快速匯出：WebCodecs + Mediabunny，逐格解碼、合成、編碼，不必即時播放
import {
  Output, Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, MkvOutputFormat, MpegTsOutputFormat,
  Mp3OutputFormat, WavOutputFormat, FlacOutputFormat, OggOutputFormat, AdtsOutputFormat,
  BufferTarget, CanvasSource, AudioBufferSource, Input, BlobSource, ALL_FORMATS, CanvasSink,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, canEncodeVideo, canEncodeAudio,
  QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { store, projectDuration, getTrack } from './state.js';
import { Renderer, loadMatte } from './renderer.js';
import { timeStretch } from './timestretch.js';
import { srcAt, srcLength, hasCurve } from './timemap.js';

const QUALITY = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryHigh: QUALITY_VERY_HIGH };

// 依序取用某片段的解碼影格（時間只會往前走）
class FrameCursor {
  constructor(input, sink, start, end) {
    this.input = input;
    this.gen = sink.canvases(start, end);
    this.cur = null;
    this.next = null;
    this.started = false;
    this.done = false;
  }
  async pull() {
    const r = await this.gen.next();
    if (r.done) {
      this.done = true;
      this.next = null;
    } else this.next = r.value;
  }
  async at(ts) {
    if (!this.started) {
      this.started = true;
      await this.pull();
    }
    while (this.next && this.next.timestamp <= ts + 1e-6) {
      this.cur = this.next;
      await this.pull();
    }
    const f = this.cur || this.next;
    return f && { canvas: f.canvas, width: f.canvas.width, height: f.canvas.height };
  }
  close() {
    this.gen.return?.();
    this.input.dispose?.();
  }
}

// Mediabunny 無法解碼時，退回用 <video> 逐格定位
class ElementCursor {
  constructor(url) {
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.preload = 'auto';
    this.el.src = url;
  }
  async at(ts) {
    const el = this.el;
    if (el.readyState < 1) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
    if (Math.abs(el.currentTime - ts) > 1e-3) {
      const done = new Promise((r) => el.addEventListener('seeked', r, { once: true }));
      el.currentTime = ts;
      await done;
    }
    return el.videoWidth ? { canvas: el, width: el.videoWidth, height: el.videoHeight } : null;
  }
  close() {
    this.el.removeAttribute('src');
    this.el.load();
  }
}

async function openCursor(c) {
  const m = store.media.get(c.mediaId);
  if (!m) return null;
  const end = c.in + srcLength(c) + 0.5;
  try {
    const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('cannot decode');
    return new FrameCursor(input, new CanvasSink(track, { poolSize: 4 }), c.in, end);
  } catch (e) {
    console.warn('改用 <video> 解碼', m.name, e);
    return new ElementCursor(m.url);
  }
}

function audibleClips() {
  return store.project.clips.filter((c) => {
    if (c.type !== 'audio' && c.type !== 'video') return false;
    const m = store.media.get(c.mediaId);
    return m?.blob && m.hasAudio !== false && !c.mute && c.volume > 0 && !getTrack(c.trackId)?.muted;
  });
}

// 用 OfflineAudioContext 把所有音訊混成一軌
export async function mixAudio(dur, onStretch) {
  const SR = 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(dur * SR)), SR);
  const cache = new Map();
  for (const c of audibleClips()) {
    const m = store.media.get(c.mediaId);
    if (!cache.has(m.id)) {
      try {
        cache.set(m.id, await ctx.decodeAudioData(await m.blob.arrayBuffer()));
      } catch {
        cache.set(m.id, null);
      }
    }
    const buf = cache.get(m.id);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    let offset = c.in;
    if (hasCurve(c)) {
      // 曲線變速：逐樣本依時間對應重新取樣（音高會跟著速度變化，類似錄音帶）
      const n = Math.max(1, Math.round(c.duration * SR));
      const sb = ctx.createBuffer(buf.numberOfChannels, n, SR);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const inp = buf.getChannelData(ch);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const p = srcAt(c, i / SR) * SR;
          const i0 = Math.floor(p);
          const f = p - i0;
          out[i] = (inp[i0] || 0) * (1 - f) + (inp[i0 + 1] || 0) * f;
        }
        sb.copyToChannel(out, ch);
      }
      src.buffer = sb;
      offset = 0;
    } else if (c.speed !== 1 && c.keepPitch) {
      // 變速不變調：先把用到的那段做時間伸縮，再以原速播放
      onStretch?.();
      await new Promise((r) => setTimeout(r)); // 讓進度文字有機會更新
      const from = Math.floor(c.in * SR);
      const to = Math.min(buf.length, Math.ceil((c.in + c.duration * c.speed) * SR) + 2048);
      const parts = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).subarray(from, to));
      const stretched = timeStretch(parts, c.speed);
      const sb = ctx.createBuffer(stretched.length, stretched[0].length, SR);
      stretched.forEach((d, i) => sb.copyToChannel(d, i));
      src.buffer = sb;
      offset = 0;
    } else {
      src.buffer = buf;
      src.playbackRate.value = c.speed;
    }
    const g = ctx.createGain();
    const end = c.start + c.duration;
    g.gain.setValueAtTime(c.fadeIn > 0 ? 0 : c.volume, c.start);
    if (c.fadeIn > 0) g.gain.linearRampToValueAtTime(c.volume, c.start + c.fadeIn);
    if (c.fadeOut > 0) {
      g.gain.setValueAtTime(c.volume, Math.max(c.start, end - c.fadeOut));
      g.gain.linearRampToValueAtTime(0, end);
    }
    src.connect(g).connect(ctx.destination);
    src.start(c.start, offset, src.buffer === buf ? c.duration * c.speed : c.duration);
  }
  return ctx.startRendering();
}

// ---------- 匯出格式 ----------
let extraEncoders = null;
// MP3 與 FLAC 瀏覽器不會原生編碼，用 Mediabunny 的 WASM 編碼器補上
export function registerExtraEncoders() {
  return (extraEncoders ||= Promise.all([import('@mediabunny/mp3-encoder'), import('@mediabunny/flac-encoder')])
    .then(([mp3, flac]) => {
      mp3.registerMp3Encoder();
      flac.registerFlacEncoder();
    })
    .catch((e) => console.warn('MP3 / FLAC 編碼器載入失敗', e)));
}

export const CONTAINERS = {
  mp4: { label: 'MP4', make: () => new Mp4OutputFormat({ fastStart: 'in-memory' }), video: ['avc', 'hevc', 'av1', 'vp9'], audio: ['aac', 'opus', 'mp3', 'flac'] },
  mov: { label: 'MOV（QuickTime）', make: () => new MovOutputFormat({ fastStart: 'in-memory' }), video: ['avc', 'hevc'], audio: ['aac', 'pcm-s16', 'pcm-s24'] },
  webm: { label: 'WebM', make: () => new WebMOutputFormat(), video: ['vp9', 'av1', 'vp8'], audio: ['opus', 'vorbis'] },
  mkv: { label: 'MKV（Matroska）', make: () => new MkvOutputFormat(), video: ['avc', 'hevc', 'av1', 'vp9', 'vp8'], audio: ['aac', 'opus', 'flac', 'mp3', 'pcm-s16'] },
  ts: { label: 'MPEG-TS（.ts）', make: () => new MpegTsOutputFormat(), video: ['avc', 'hevc'], audio: ['aac', 'mp3'] },
};
export const AUDIO_FORMATS = {
  mp3: { label: 'MP3', make: () => new Mp3OutputFormat(), codec: 'mp3', lossy: true },
  m4a: { label: 'M4A（AAC）', make: () => new Mp4OutputFormat({ fastStart: 'in-memory' }), codec: 'aac', ext: 'm4a', lossy: true },
  wav: { label: 'WAV 16-bit（無損）', make: () => new WavOutputFormat(), codec: 'pcm-s16' },
  wav24: { label: 'WAV 24-bit（無損）', make: () => new WavOutputFormat(), codec: 'pcm-s24' },
  flac: { label: 'FLAC（無損壓縮）', make: () => new FlacOutputFormat(), codec: 'flac' },
  ogg: { label: 'OGG（Opus）', make: () => new OggOutputFormat(), codec: 'opus', lossy: true },
  aac: { label: 'AAC（.aac）', make: () => new AdtsOutputFormat(), codec: 'aac', lossy: true },
};
export const VIDEO_CODEC_NAMES = { avc: 'H.264（相容性最好）', hevc: 'H.265 / HEVC（檔案較小）', av1: 'AV1（最新、最小）', vp9: 'VP9', vp8: 'VP8（舊格式）' };
export const AUDIO_CODEC_NAMES = { aac: 'AAC', opus: 'Opus', mp3: 'MP3', flac: 'FLAC（無損）', vorbis: 'Vorbis', 'pcm-s16': 'PCM 16-bit（無損）', 'pcm-s24': 'PCM 24-bit（無損）' };
export const QUALITY_NAMES = [['low', '低（檔案最小）'], ['medium', '標準'], ['high', '高畫質'], ['veryHigh', '極致'], ['custom', '自訂位元率']];

/** 查這台電腦的瀏覽器能編碼哪些格式 */
export async function probeCodecs(width, height) {
  await registerExtraEncoders();
  const v = {};
  const a = {};
  for (const c of ['avc', 'hevc', 'av1', 'vp9', 'vp8']) v[c] = await canEncodeVideo(c, { width, height }).catch(() => false);
  for (const c of ['aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm-s16', 'pcm-s24']) a[c] = await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false);
  return { v, a };
}

// ---------- 逐格算圖（影片、GIF、圖片序列共用） ----------
class FrameRenderer {
  constructor(width, height) {
    const { width: W, height: H } = store.project;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.r = new Renderer(this.canvas);
    this.r.frames = new Map();
    this.out = this.canvas;
    if (width !== W || height !== H) {
      this.out = document.createElement('canvas');
      this.out.width = width;
      this.out.height = height;
      this.og = this.out.getContext('2d');
      this.og.imageSmoothingQuality = 'high';
    }
    this.cursors = new Map();
    this.videoClips = store.project.clips.filter((c) => c.type === 'video');
  }
  async init(onProgress) {
    if (store.project.clips.some((c) => c.aiMatte?.on)) {
      onProgress?.(0, '載入 AI 去背模型…');
      await loadMatte();
    }
  }
  /** 畫出時間 t 的畫面，回傳輸出尺寸的畫布 */
  async frame(t) {
    this.r.frames.clear();
    for (const c of this.videoClips) {
      const active = t >= c.start && t < c.start + c.duration && !getTrack(c.trackId)?.hidden;
      if (!active) {
        if (this.cursors.has(c.id) && t >= c.start + c.duration) {
          this.cursors.get(c.id)?.close();
          this.cursors.delete(c.id);
        }
        continue;
      }
      if (!this.cursors.has(c.id)) this.cursors.set(c.id, await openCursor(c));
      const f = await this.cursors.get(c.id)?.at(srcAt(c, t - c.start));
      if (f) this.r.frames.set(c.id, f);
    }
    this.r.draw(t);
    if (this.out !== this.canvas) this.og.drawImage(this.canvas, 0, 0, this.out.width, this.out.height);
    return this.out;
  }
  close() {
    for (const cur of this.cursors.values()) cur?.close();
  }
}

function sliceAudio(buf, t0, t1) {
  const s0 = Math.max(0, Math.floor(t0 * buf.sampleRate));
  const s1 = Math.min(buf.length, Math.ceil(t1 * buf.sampleRate));
  const out = new AudioBuffer({ length: Math.max(1, s1 - s0), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(s0, s1), ch);
  return out;
}
async function mixRange(t0, t1, onProgress) {
  onProgress?.(0, '混音中…');
  return sliceAudio(await mixAudio(Math.max(t1, 0.1), () => onProgress?.(0, '變速不變調處理中…')), t0, t1);
}
const encOpts = (o) => (o.bitrate ? { bitrate: o.bitrate } : { quality: QUALITY[o.quality] || QUALITY_HIGH });
const pause = () => new Promise((r) => setTimeout(r));

// ---------- 影片 ----------
async function exportVideo(o, onProgress, signal) {
  const [t0, t1] = o.range;
  const fmt = CONTAINERS[o.container].make();
  const output = new Output({ format: fmt, target: new BufferTarget() });
  const fr = new FrameRenderer(o.width, o.height);
  await fr.init(onProgress);
  const vsrc = new CanvasSource(fr.out, { codec: o.videoCodec, ...encOpts(o), keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: o.fps });
  let asrc = null;
  if (o.includeAudio && o.audioCodec && audibleClips().length) {
    asrc = new AudioBufferSource({ codec: o.audioCodec, ...(o.audioBitrate ? { bitrate: o.audioBitrate } : { quality: QUALITY_HIGH }) });
    output.addAudioTrack(asrc);
  }
  await output.start();
  if (asrc) await asrc.add(await mixRange(t0, t1, onProgress));
  const n = Math.max(1, Math.round((t1 - t0) * o.fps));
  try {
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) {
        await output.cancel();
        return null;
      }
      await fr.frame(t0 + i / o.fps);
      await vsrc.add(i / o.fps, 1 / o.fps);
      if (i % 3 === 0) onProgress(i / n, `編碼中… ${i}/${n} 格`);
    }
  } finally {
    fr.close();
  }
  onProgress(1, '封裝檔案…');
  await output.finalize();
  return { blob: new Blob([output.target.buffer], { type: fmt.mimeType }), ext: fmt.fileExtension.replace('.', '') };
}

// ---------- 只匯出聲音 ----------
async function exportAudio(o, onProgress, signal) {
  const def = AUDIO_FORMATS[o.audioFormat];
  const fmt = def.make();
  const output = new Output({ format: fmt, target: new BufferTarget() });
  const asrc = new AudioBufferSource({ codec: def.codec, ...(def.lossy && o.audioBitrate ? { bitrate: o.audioBitrate } : { quality: QUALITY_HIGH }) });
  output.addAudioTrack(asrc);
  await output.start();
  const buf = await mixRange(o.range[0], o.range[1], onProgress);
  if (signal?.aborted) {
    await output.cancel();
    return null;
  }
  onProgress(0.5, '編碼中…');
  await asrc.add(buf);
  onProgress(1, '封裝檔案…');
  await output.finalize();
  return { blob: new Blob([output.target.buffer], { type: fmt.mimeType }), ext: def.ext || fmt.fileExtension.replace('.', '') };
}

// ---------- GIF 動圖 ----------
async function exportGif(o, onProgress, signal) {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const [t0, t1] = o.range;
  const fr = new FrameRenderer(o.width, o.height);
  await fr.init(onProgress);
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.canvas.width = o.width;
  ctx.canvas.height = o.height;
  const gif = GIFEncoder();
  const n = Math.max(1, Math.round((t1 - t0) * o.fps));
  const delay = Math.round(1000 / o.fps);
  try {
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) return null;
      ctx.drawImage(await fr.frame(t0 + i / o.fps), 0, 0);
      const { data } = ctx.getImageData(0, 0, o.width, o.height);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), o.width, o.height, { palette, delay });
      if (i % 2 === 0) {
        onProgress(i / n, `製作 GIF… ${i}/${n} 格`);
        await pause();
      }
    }
  } finally {
    fr.close();
  }
  gif.finish();
  return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), ext: 'gif' };
}

// ---------- 圖片序列（ZIP） ----------
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
async function exportImages(o, onProgress, signal) {
  const { zipSync } = await import('fflate');
  const [t0, t1] = o.range;
  const fr = new FrameRenderer(o.width, o.height);
  await fr.init(onProgress);
  const files = {};
  const n = Math.max(1, Math.round((t1 - t0) * o.fps));
  try {
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) return null;
      const cv = await fr.frame(t0 + i / o.fps);
      const blob = await new Promise((r) => cv.toBlob(r, IMG_TYPES[o.imageFormat], 0.92));
      files[`frame_${String(i + 1).padStart(5, '0')}.${o.imageFormat}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      if (i % 2 === 0) onProgress(i / n, `輸出圖片… ${i}/${n}`);
    }
  } finally {
    fr.close();
  }
  onProgress(1, '壓縮成 ZIP…');
  await pause();
  return { blob: new Blob([zipSync(files)], { type: 'application/zip' }), ext: 'zip' };
}

// ---------- 單張畫面 ----------
async function exportStill(o) {
  const fr = new FrameRenderer(o.width, o.height);
  await fr.init();
  try {
    const cv = await fr.frame(o.range[0]);
    const blob = await new Promise((r) => cv.toBlob(r, IMG_TYPES[o.imageFormat], 0.95));
    return { blob, ext: o.imageFormat };
  } finally {
    fr.close();
  }
}

/**
 * 匯出：kind = 'video' | 'audio' | 'gif' | 'images' | 'still'
 * @returns {Promise<{blob:Blob, ext:string, seconds:number}|null>}
 */
export async function exportMedia(o, onProgress = () => {}, signal) {
  await registerExtraEncoders();
  const start = performance.now();
  const fn = { video: exportVideo, audio: exportAudio, gif: exportGif, images: exportImages, still: exportStill }[o.kind];
  const res = await fn(o, onProgress, signal);
  return res && { ...res, seconds: (performance.now() - start) / 1000 };
}

/** 舊介面：整段專案匯出成影片 */
export async function fastExport({ container = 'mp4', quality = 'high', onProgress, signal }) {
  const { width, height, fps } = store.project;
  const codecs = { mp4: ['avc', 'hevc', 'vp9', 'av1'], webm: ['vp9', 'vp8', 'av1'] }[container] || CONTAINERS[container].video;
  const videoCodec = await getFirstEncodableVideoCodec(codecs, { width, height });
  if (!videoCodec) throw new Error(`這個瀏覽器無法以 ${container.toUpperCase()} 編碼 ${width}×${height} 的影片`);
  const audioCodec = await getFirstEncodableAudioCodec(CONTAINERS[container].audio, { numberOfChannels: 2, sampleRate: 48000 });
  return exportMedia({ kind: 'video', container, videoCodec, audioCodec, width, height, fps, quality, range: [0, projectDuration()], includeAudio: true }, onProgress, signal);
}
