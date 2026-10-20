// 離線快速匯出：WebCodecs + Mediabunny，逐格解碼、合成、編碼，不必即時播放
import {
  Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  Input, BlobSource, ALL_FORMATS, CanvasSink, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { store, projectDuration, getTrack } from './state.js';
import { Renderer, loadMatte } from './renderer.js';
import { timeStretch } from './timestretch.js';
import { srcAt, srcLength, hasCurve } from './timemap.js';

const QUALITY = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryHigh: QUALITY_VERY_HIGH };

const CODECS = {
  mp4: { video: ['avc', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus'] },
  webm: { video: ['vp9', 'vp8', 'av1'], audio: ['opus', 'vorbis'] },
};

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

/**
 * @param {{container:'mp4'|'webm', quality:'medium'|'high'|'veryHigh', onProgress:(p:number, label?:string)=>void, signal:AbortSignal}} o
 * @returns {Promise<{blob:Blob, ext:string, seconds:number}|null>}
 */
export async function fastExport({ container, quality: qualityKey, onProgress, signal }) {
  const quality = QUALITY[qualityKey] || QUALITY_HIGH;
  const { width: W, height: H, fps } = store.project;
  const dur = projectDuration();
  const t0 = performance.now();
  const videoCodec = await getFirstEncodableVideoCodec(CODECS[container].video, { width: W, height: H, quality, frameRate: fps });
  if (!videoCodec) throw new Error(`這個瀏覽器無法以 ${container.toUpperCase()} 編碼 ${W}×${H} 的影片`);
  const hasAudio = audibleClips().length > 0;
  const audioCodec = hasAudio ? await getFirstEncodableAudioCodec(CODECS[container].audio, { numberOfChannels: 2, sampleRate: 48000, quality }) : null;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const r = new Renderer(canvas);
  r.frames = new Map();
  if (store.project.clips.some((c) => c.aiMatte?.on)) {
    onProgress(0, '載入 AI 去背模型…');
    await loadMatte();
  }

  const output = new Output({
    format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const vsrc = new CanvasSource(canvas, { codec: videoCodec, quality });
  output.addVideoTrack(vsrc, { frameRate: fps });
  let asrc = null;
  if (audioCodec) {
    asrc = new AudioBufferSource({ codec: audioCodec, quality });
    output.addAudioTrack(asrc);
  }
  await output.start();

  if (asrc) {
    onProgress(0, '混音中…');
    await asrc.add(await mixAudio(dur, () => onProgress(0, '變速不變調處理中…')));
  }

  const cursors = new Map();
  const videoClips = store.project.clips.filter((c) => c.type === 'video');
  const n = Math.max(1, Math.round(dur * fps));
  try {
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) {
        await output.cancel();
        return null;
      }
      const t = i / fps;
      r.frames.clear();
      for (const c of videoClips) {
        const active = t >= c.start && t < c.start + c.duration && !getTrack(c.trackId)?.hidden;
        if (!active) {
          if (cursors.has(c.id) && t >= c.start + c.duration) {
            cursors.get(c.id)?.close();
            cursors.delete(c.id);
          }
          continue;
        }
        if (!cursors.has(c.id)) cursors.set(c.id, await openCursor(c));
        const f = await cursors.get(c.id)?.at(srcAt(c, t - c.start));
        if (f) r.frames.set(c.id, f);
      }
      r.draw(t);
      await vsrc.add(t, 1 / fps);
      if (i % 3 === 0) onProgress(i / n, `編碼中… ${i}/${n} 格`);
    }
  } finally {
    for (const cur of cursors.values()) cur?.close();
  }
  onProgress(1, '封裝檔案…');
  await output.finalize();
  const seconds = (performance.now() - t0) / 1000;
  return { blob: new Blob([output.target.buffer], { type: output.format.mimeType }), ext: output.format.fileExtension.replace('.', ''), seconds };
}
