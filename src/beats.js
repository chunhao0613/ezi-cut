// 節拍偵測：起音強度曲線 → 自相關估計速度 → 對齊節拍網格 → 找出每小節第一拍
const SR = 11025;
const HOP = 256; // 約 23ms 一格

function frameEnergy(x, n) {
  const e = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * HOP;
    for (let i = 0; i < HOP * 2 && o + i < x.length; i++) s += x[o + i] * x[o + i];
    e[f] = s;
  }
  return e;
}

// 正向能量變化（對數）＝起音強度
function onsetCurve(e) {
  const o = new Float32Array(e.length);
  let prev = Math.log1p(e[0] * 1000);
  for (let i = 1; i < e.length; i++) {
    const v = Math.log1p(e[i] * 1000);
    o[i] = Math.max(0, v - prev);
    prev = v;
  }
  return o;
}

/** @returns {Promise<{bpm:number, beats:number[], downbeats:number[]}>} 時間以素材秒數表示 */
export async function detectBeats(blob) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const ab = await ctx.decodeAudioData(await blob.arrayBuffer());
  const len = ab.length;
  const mono = new Float32Array(len);
  for (let ch = 0; ch < ab.numberOfChannels; ch++) {
    const d = ab.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += d[i] / ab.numberOfChannels;
  }
  // 低頻（大鼓、貝斯）另外算一條，用來找重拍
  const off = new OfflineAudioContext(1, len, SR);
  const src = off.createBufferSource();
  src.buffer = ab;
  const lp = off.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 160;
  src.connect(lp).connect(off.destination);
  src.start();
  const low = (await off.startRendering()).getChannelData(0);

  const n = Math.floor(len / HOP);
  const oFull = onsetCurve(frameEnergy(mono, n));
  const oLow = onsetCurve(frameEnergy(low, n));
  const onset = new Float32Array(n);
  for (let i = 0; i < n; i++) onset[i] = oFull[i] + 1.5 * oLow[i];
  // 減去局部平均，只留下突出的起音
  const win = Math.round((0.4 * SR) / HOP);
  let acc = 0;
  const avg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    acc += onset[i];
    if (i >= win) acc -= onset[i - win];
    avg[i] = acc / Math.min(i + 1, win);
  }
  for (let i = 0; i < n; i++) onset[i] = Math.max(0, onset[i] - avg[Math.min(n - 1, i + (win >> 1))]);

  // 速度：在 60–200 BPM 間找自相關最高者，偏好 120 BPM 附近
  const fps = SR / HOP;
  let best = { score: -1, lag: fps / 2, bpm: 120 };
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = Math.ceil(lag); i < n; i++) {
      const j = i - lag;
      const j0 = Math.floor(j);
      const f = j - j0;
      s += onset[i] * (onset[j0] * (1 - f) + onset[j0 + 1] * f);
    }
    s *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
    if (s > best.score) best = { score: s, lag, bpm };
  }
  const lag = best.lag;

  // 相位：讓網格落在起音最強的位置
  let phase = 0;
  let phaseScore = -1;
  for (let p = 0; p < lag; p += 0.5) {
    let s = 0;
    for (let k = p; k < n; k += lag) s += onset[Math.round(k)] || 0;
    if (s > phaseScore) {
      phaseScore = s;
      phase = p;
    }
  }
  // 追蹤每一拍：從上一拍往後推一個拍長，在 ±15% 內找最強起音，可修正速度估計的微小誤差
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, onset[i]);
  const tol = Math.max(1, Math.round(lag * 0.15));
  const beatsIdx = [];
  let expect = phase;
  let localLag = lag;
  while (expect < n) {
    const c = Math.round(expect);
    let bi = c;
    for (let i = Math.max(0, c - tol); i <= Math.min(n - 1, c + tol); i++) if (onset[i] > onset[bi]) bi = i;
    if (onset[bi] < peak * 0.08) bi = Math.min(n - 1, c); // 這一拍沒有明顯起音，照網格放
    if (beatsIdx.length) localLag = 0.8 * localLag + 0.2 * Math.min(lag * 1.15, Math.max(lag * 0.85, bi - beatsIdx[beatsIdx.length - 1]));
    beatsIdx.push(bi);
    expect = bi + localLag;
  }
  // 依實際拍距重新計算 BPM
  if (beatsIdx.length > 2) {
    const span = (beatsIdx[beatsIdx.length - 1] - beatsIdx[0]) / (beatsIdx.length - 1);
    best.bpm = (60 * fps) / span;
  }
  // 重拍：四拍一組，看哪個起點的低頻起音最強
  let downPhase = 0;
  let downScore = -1;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    for (let i = p; i < beatsIdx.length; i += 4) s += oLow[beatsIdx[i]] || 0;
    if (s > downScore) {
      downScore = s;
      downPhase = p;
    }
  }
  // 能量窗長 2 個 hop，起音落在窗的最後一段，取 +1.5 hop 對齊真正的起音時間
  const beats = beatsIdx.map((i) => ((i + 1.5) * HOP) / SR).filter((t) => t <= ab.duration);
  return {
    bpm: Math.round(best.bpm),
    beats,
    downbeats: beats.filter((_, i) => i % 4 === downPhase),
  };
}
