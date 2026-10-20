// 人聲增強：RNNoise 降噪 + 人聲 EQ / 壓縮 + 音量標準化，全部在本機處理，輸出新的音訊檔
import { Rnnoise } from '@shiguredo/rnnoise-wasm';

const SR = 48000; // RNNoise 需要 48kHz
let rnnoise = null;

async function denoise(ch, strength, onProgress) {
  rnnoise ||= await Rnnoise.load();
  const n = rnnoise.frameSize; // 480 樣本 = 10ms
  const st = rnnoise.createDenoiseState();
  const out = new Float32Array(ch.length);
  const frame = new Float32Array(n);
  try {
    for (let i = 0; i < ch.length; i += n) {
      for (let j = 0; j < n; j++) frame[j] = (ch[i + j] || 0) * 32768;
      st.processFrame(frame);
      for (let j = 0; j < n && i + j < ch.length; j++) out[i + j] = frame[j] / 32768;
      if ((i / n) % 2000 === 0) {
        onProgress?.(i / ch.length);
        await new Promise((r) => setTimeout(r)); // 讓畫面有機會更新
      }
    }
  } finally {
    st.destroy();
  }
  // RNNoise 輸出比輸入晚兩個音框（實測 960 樣本 = 20ms），往前對齊；再依強度與原音混合
  const lag = n * 2;
  const res = new Float32Array(ch.length);
  for (let i = 0; i < ch.length; i++) res[i] = strength * (out[i + lag] ?? 0) + (1 - strength) * ch[i];
  return res;
}

async function voiceChain(buf) {
  const ctx = new OfflineAudioContext(buf.numberOfChannels, buf.length, SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80; // 去掉低頻轟聲與風切
  const mud = ctx.createBiquadFilter();
  mud.type = 'peaking';
  mud.frequency.value = 300;
  mud.Q.value = 1;
  mud.gain.value = -2.5; // 減少悶聲
  const pres = ctx.createBiquadFilter();
  pres.type = 'peaking';
  pres.frequency.value = 3200;
  pres.Q.value = 0.9;
  pres.gain.value = 3.5; // 提升清晰度
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.ratio.value = 3;
  comp.knee.value = 8;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  src.connect(hp).connect(mud).connect(pres).connect(comp).connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

// 以有聲段落的 RMS 對齊到約 -18 dBFS，並限制峰值
function normalize(chs) {
  let sum = 0;
  let cnt = 0;
  let peak = 1e-6;
  const win = 4800;
  for (const ch of chs) {
    for (let i = 0; i < ch.length; i += win) {
      let s = 0;
      for (let j = i; j < Math.min(ch.length, i + win); j++) {
        s += ch[j] * ch[j];
        peak = Math.max(peak, Math.abs(ch[j]));
      }
      const rms = Math.sqrt(s / win);
      if (rms > 0.01) {
        sum += rms * rms;
        cnt++;
      }
    }
  }
  if (!cnt) return;
  const rms = Math.sqrt(sum / cnt);
  const gain = Math.min(0.126 / rms, 0.97 / peak, 8);
  for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
}

/** 處理整個媒體檔的聲音，回傳新的 .m4a 檔 */
export async function enhanceVoice(m, { denoise: dn = true, strength = 1, eq = true, norm = true } = {}, onProgress) {
  const dec = new OfflineAudioContext(2, 1, SR);
  let buf = await dec.decodeAudioData(await m.blob.arrayBuffer());
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
  if (dn) {
    for (let c = 0; c < chs.length; c++) chs[c] = await denoise(chs[c], strength, (p) => onProgress?.((c + p) / chs.length * 0.8));
  }
  buf = new AudioBuffer({ length: chs[0].length, numberOfChannels: chs.length, sampleRate: SR });
  chs.forEach((d, i) => buf.copyToChannel(d, i));
  let shift = 0;
  if (eq) {
    buf = await voiceChain(buf);
    shift = Math.round(0.006 * SR); // DynamicsCompressor 內建 6ms 預讀延遲，往前對齊
  }
  const outChs = Array.from({ length: buf.numberOfChannels }, (_, i) => {
    const d = buf.getChannelData(i);
    return shift ? Float32Array.from({ length: d.length }, (_, j) => d[j + shift] ?? 0) : d;
  });
  if (norm) normalize(outChs);
  onProgress?.(0.9);

  const { Output, Mp4OutputFormat, BufferTarget, AudioBufferSource, getFirstEncodableAudioCodec, QUALITY_HIGH } = await import('mediabunny');
  const final = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: SR });
  outChs.forEach((d, i) => final.copyToChannel(d, i));
  const codec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: final.numberOfChannels, sampleRate: SR });
  if (!codec) throw new Error('瀏覽器無法編碼音訊');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const asrc = new AudioBufferSource({ codec, quality: QUALITY_HIGH });
  output.addAudioTrack(asrc);
  await output.start();
  await asrc.add(final);
  await output.finalize();
  onProgress?.(1);
  const base = m.name.replace(/\.[^.]+$/, '');
  return new File([output.target.buffer], `${base}（人聲增強）.m4a`, { type: 'audio/mp4' });
}
