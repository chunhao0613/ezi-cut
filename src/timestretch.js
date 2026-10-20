// WSOLA 時間伸縮：改變速度但保持音高（變速不變調）
// 原理：以固定步距輸出加窗音框，每一框從輸入的「預期位置」附近，
// 找出與上一框自然延續最吻合的位置（互相關最大），再重疊相加。

const FRAME = 2048; // 音框長度（48kHz 約 43ms）
const HOP = FRAME / 2; // 輸出步距
const SEEK = 512; // 搜尋範圍 ±樣本數

let hann = null;
function windowFn() {
  if (!hann) {
    hann = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  }
  return hann;
}

// 互相關：a 從 pa 開始、b 從 pb 開始，長度 len，每 step 取一點
function corr(x, pa, pb, len, step) {
  let s = 0;
  for (let i = 0; i < len; i += step) s += x[pa + i] * x[pb + i];
  return s;
}

/**
 * @param {Float32Array[]} channels 各聲道的輸入樣本（長度相同）
 * @param {number} speed 速度倍率，2 = 兩倍快（長度減半）
 * @returns {Float32Array[]} 伸縮後的各聲道
 */
export function timeStretch(channels, speed) {
  const inLen = channels[0].length;
  const outLen = Math.max(1, Math.round(inLen / speed));
  if (Math.abs(speed - 1) < 1e-3 || inLen < FRAME * 2) {
    // 太短或不需要伸縮：直接重新取樣長度
    return channels.map((ch) => {
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) out[i] = ch[Math.min(inLen - 1, Math.floor(i * speed))] || 0;
      return out;
    });
  }
  // 用單聲道混音來找對齊位置，所有聲道套用相同位置以保持立體聲同步
  let mono = channels[0];
  if (channels.length > 1) {
    mono = new Float32Array(inLen);
    for (const ch of channels) for (let i = 0; i < inLen; i++) mono[i] += ch[i];
  }
  const win = windowFn();
  const outs = channels.map(() => new Float32Array(outLen + FRAME));
  const norm = new Float32Array(outLen + FRAME);
  const maxPos = inLen - FRAME;
  const overlap = FRAME - HOP;
  let prev = 0;
  for (let k = 0; k * HOP < outLen; k++) {
    let pos = Math.round(k * HOP * speed);
    if (k > 0) {
      const target = Math.min(maxPos - overlap, prev + HOP); // 上一框自然延續的位置
      const lo = Math.max(0, pos - SEEK);
      const hi = Math.min(maxPos, pos + SEEK);
      let best = Math.min(Math.max(pos, 0), maxPos);
      let bestC = -Infinity;
      // 先粗搜（每 8 點），再在最佳點附近細搜
      for (let p = lo; p <= hi; p += 8) {
        const c = corr(mono, p, target, overlap, 4);
        if (c > bestC) { bestC = c; best = p; }
      }
      const flo = Math.max(lo, best - 8);
      const fhi = Math.min(hi, best + 8);
      for (let p = flo; p <= fhi; p++) {
        const c = corr(mono, p, target, overlap, 2);
        if (c > bestC) { bestC = c; best = p; }
      }
      pos = best;
    }
    pos = Math.min(Math.max(pos, 0), maxPos);
    const o = k * HOP;
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = outs[c];
      for (let i = 0; i < FRAME; i++) dst[o + i] += src[pos + i] * win[i];
    }
    for (let i = 0; i < FRAME; i++) norm[o + i] += win[i];
    prev = pos;
  }
  return outs.map((dst) => {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = norm[i] > 1e-3 ? dst[i] / norm[i] : 0;
    return out;
  });
}
