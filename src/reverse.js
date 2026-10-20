// 倒放：把片段用到的那段素材倒過來重新編碼成新影片（預覽與匯出都流暢）
import {
  Input, BlobSource, ALL_FORMATS, CanvasSink, Output, Mp4OutputFormat, BufferTarget, CanvasSource,
  AudioBufferSource, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, QUALITY_HIGH,
} from 'mediabunny';

const CHUNK = 0.5; // 每次解碼 0.5 秒再倒序寫出，控制記憶體用量

async function reversedAudio(blob, from, to) {
  try {
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const full = await ctx.decodeAudioData(await blob.arrayBuffer());
    const s0 = Math.floor(from * full.sampleRate);
    const s1 = Math.min(full.length, Math.ceil(to * full.sampleRate));
    const len = Math.max(1, s1 - s0);
    const out = new AudioBuffer({ length: len, numberOfChannels: full.numberOfChannels, sampleRate: full.sampleRate });
    for (let ch = 0; ch < full.numberOfChannels; ch++) {
      const src = full.getChannelData(ch);
      const dst = new Float32Array(len);
      for (let i = 0; i < len; i++) dst[i] = src[s1 - 1 - i] || 0;
      out.copyToChannel(dst, ch);
    }
    return out;
  } catch {
    return null; // 沒有聲音軌
  }
}

/** 回傳倒放後的新影片檔 */
export async function makeReversed(m, from, to, onProgress) {
  const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) throw new Error('瀏覽器無法解碼這段影片');
  const scale = Math.min(1, 1920 / Math.max(vt.displayWidth, vt.displayHeight));
  const W = Math.max(2, Math.round((vt.displayWidth * scale) / 2) * 2);
  const H = Math.max(2, Math.round((vt.displayHeight * scale) / 2) * 2);
  const sink = new CanvasSink(vt, { width: W, height: H, fit: 'fill' });
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  const vcodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: W, height: H });
  if (!vcodec) throw new Error('瀏覽器無法編碼影片');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: vcodec, quality: QUALITY_HIGH });
  output.addVideoTrack(vsrc);
  const audio = await reversedAudio(m.blob, from, to);
  let asrc = null;
  if (audio) {
    const acodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate });
    if (acodec) {
      asrc = new AudioBufferSource({ codec: acodec, quality: QUALITY_HIGH });
      output.addAudioTrack(asrc);
    }
  }
  await output.start();
  if (asrc) await asrc.add(audio);

  let t = 0;
  let nextTs = to; // 時間上「下一張」影格的開始時間，用來算每張影格該停留多久
  const total = to - from;
  for (let ce = to; ce > from + 1e-3; ce -= CHUNK) {
    const cs = Math.max(from, ce - CHUNK);
    const frames = [];
    for await (const f of sink.canvases(cs, ce)) {
      // 時間戳在 cs 之前的影格屬於前一段，避免重複（第一段除外）
      if (f.timestamp >= cs - 1e-4 || cs <= from + 1e-4) frames.push(f);
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const ts = Math.max(from, frames[i].timestamp);
      const d = nextTs - ts;
      nextTs = ts;
      if (d < 1e-4) continue;
      g.drawImage(frames[i].canvas, 0, 0, W, H);
      await vsrc.add(t, d);
      t += d;
    }
    onProgress?.(Math.min(1, (to - cs) / total));
  }
  await output.finalize();
  input.dispose?.();
  const base = m.name.replace(/\.[^.]+$/, '');
  return new File([output.target.buffer], `${base}（倒放）.mp4`, { type: 'video/mp4' });
}
