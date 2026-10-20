// 片段時間對應：時間軸上的「片段內時間」↔「素材時間」
// 支援固定速度（clip.speed）與曲線變速（clip.curve.pts，x 為片段位置 0–1、y 為速度倍率）

export const CURVE_PRESETS = [
  { id: 'montage', name: '蒙太奇', pts: [[0, 1.5], [0.2, 3], [0.45, 0.6], [0.55, 0.6], [0.8, 3], [1, 1.5]] },
  { id: 'hero', name: '英雄時刻', pts: [[0, 2.5], [0.38, 2.5], [0.5, 0.3], [0.62, 2.5], [1, 2.5]] },
  { id: 'bullet', name: '子彈時間', pts: [[0, 1], [0.3, 1], [0.4, 0.2], [0.6, 0.2], [0.7, 1], [1, 1]] },
  { id: 'jump', name: '跳接', pts: [[0, 1], [0.4, 1], [0.45, 5], [0.55, 5], [0.6, 1], [1, 1]] },
  { id: 'flashIn', name: '閃進', pts: [[0, 5], [0.3, 5], [0.5, 1], [1, 1]] },
  { id: 'flashOut', name: '閃出', pts: [[0, 1], [0.5, 1], [0.7, 5], [1, 5]] },
  { id: 'rampUp', name: '漸快', pts: [[0, 0.5], [1, 3]] },
  { id: 'rampDown', name: '漸慢', pts: [[0, 3], [1, 0.5]] },
];

// 曲線上 x 處的速度（線性內插）
export function curveSpeedAt(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

// ∫0^x s(u) du（分段線性 → 梯形面積）
export function curveIntegral(pts, x) {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x <= x0) break;
    const xe = Math.min(x, x1);
    const ye = x1 === x0 ? y1 : y0 + ((y1 - y0) * (xe - x0)) / (x1 - x0);
    sum += ((y0 + ye) / 2) * (xe - x0);
    if (x <= x1) break;
  }
  return sum;
}

export const hasCurve = (c) => !!c.curve?.pts?.length;
// 平均速度：曲線的平均值，或固定速度
export const avgSpeed = (c) => (hasCurve(c) ? curveIntegral(c.curve.pts, 1) : c.speed);
// 片段實際用到的素材長度
export const srcLength = (c) => c.duration * avgSpeed(c);
// 片段內時間 → 距離 in 點的素材時間
export function srcOffset(c, local) {
  if (!hasCurve(c)) return local * c.speed;
  const D = c.duration || 1e-6;
  return D * curveIntegral(c.curve.pts, Math.min(1, Math.max(0, local / D)));
}
export const srcAt = (c, local) => c.in + srcOffset(c, local);
// 片段內時間的瞬時速度
export const speedAt = (c, local) => (hasCurve(c) ? curveSpeedAt(c.curve.pts, Math.min(1, Math.max(0, local / (c.duration || 1)))) : c.speed);
// 反查：距離 in 點的素材時間 → 片段內時間
export function localAt(c, off) {
  if (!hasCurve(c)) return off / c.speed;
  let lo = 0;
  let hi = c.duration;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (srcOffset(c, mid) < off) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// 取出曲線 [a, b] 這一段並重新正規化到 0–1（分割片段時用）
export function subCurve(pts, a, b) {
  const out = [[0, curveSpeedAt(pts, a)]];
  for (const [x, y] of pts) if (x > a && x < b) out.push([(x - a) / (b - a), y]);
  out.push([1, curveSpeedAt(pts, b)]);
  return out;
}
export const mirrorCurve = (pts) => pts.map(([x, y]) => [1 - x, y]).reverse();
