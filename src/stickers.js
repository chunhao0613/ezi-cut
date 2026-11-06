// 向量貼圖：每張貼圖由幾層 SVG 路徑 / 文字組成，預覽用 SVG，畫面與匯出用 Canvas Path2D 同步繪製（不需要等圖片載入）
// 顏色可以用 'c1' / 'c2' 代表使用者可改的主色、輔色

// ---------- 路徑小工具 ----------
const f = (n) => +n.toFixed(2);
const circle = (cx, cy, r) => `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
const ellipse = (cx, cy, rx, ry) => `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;
const rrect = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
function star(cx, cy, n, r1, r2, rot = -90) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = ((rot + (i * 180) / n) * Math.PI) / 180;
    d += `${i ? 'L' : 'M'}${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`;
  }
  return d + 'Z';
}
const sparkle = (cx, cy, r) => {
  const k = r * 0.16;
  return `M${cx} ${cy - r}C${cx + k} ${cy - k} ${cx + k} ${cy - k} ${cx + r} ${cy}C${cx + k} ${cy + k} ${cx + k} ${cy + k} ${cx} ${cy + r}C${cx - k} ${cy + k} ${cx - k} ${cy + k} ${cx - r} ${cy}C${cx - k} ${cy - k} ${cx - k} ${cy - k} ${cx} ${cy - r}Z`;
};
function rays(cx, cy, n, r0, r1, spread) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const p = (ang, r) => `${f(cx + r * Math.cos(ang))} ${f(cy + r * Math.sin(ang))}`;
    d += `M${p(a - spread, r0)}L${p(a, r1)}L${p(a + spread, r0)}Z`;
  }
  return d;
}
function confetti() {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cols = ['#f43f5e', '#facc15', '#22d3ee', '#a78bfa', '#4ade80', '#fb923c'];
  const out = [];
  for (let i = 0; i < 26; i++) {
    const x = 8 + rnd() * 184;
    const y = 8 + rnd() * 104;
    const fill = cols[i % cols.length];
    if (i % 3 === 0) out.push({ d: circle(x, y, 3 + rnd() * 3), fill });
    else {
      const w = 5 + rnd() * 6;
      const h = 12 + rnd() * 8;
      const a = rnd() * Math.PI;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const pt = (lx, ly) => `${f(x + lx * c - ly * sn)} ${f(y + lx * sn + ly * c)}`;
      out.push({ d: `M${pt(-w / 2, -h / 2)}L${pt(w / 2, -h / 2)}L${pt(w / 2, h / 2)}L${pt(-w / 2, h / 2)}Z`, fill });
    }
  }
  return out;
}
const T = (text, x, y, size, fill = '#fff', extra = {}) => ({ text, x, y, size, fill, weight: 900, ...extra });
const DARK = '#1f2937';

// 表情臉共用底
const face = (...layers) => [{ d: circle(50, 50, 44), fill: 'c1', stroke: DARK, sw: 5 }, ...layers];

// ---------- 貼圖定義 ----------
// vb：[寬, 高]；layers：{ d, fill?, stroke?, sw? } 或文字 { text, x, y, size, fill, weight }；label：可修改文字的預設值
export const STICKER_CATS = [
  { id: 'callout', name: '標註' },
  { id: 'social', name: '社群' },
  { id: 'decor', name: '裝飾' },
  { id: 'badge', name: '標籤' },
  { id: 'face', name: '表情' },
];

export const STICKER_DEFS = [
  // ---- 標註 ----
  { id: 'circle-mark', cat: 'callout', name: '手繪圈', vb: [200, 120], c1: '#ef4444', loop: 'draw', layers: [
    { d: 'M44 30C84 6 172 10 188 52C202 92 122 114 70 106C18 98 2 62 22 38C36 22 62 14 102 14', stroke: 'c1', sw: 7 }] },
  { id: 'underline', cat: 'callout', name: '塗鴉底線', vb: [200, 44], c1: '#facc15', loop: 'draw', layers: [
    { d: 'M8 24C52 12 104 10 192 16M34 34C84 26 132 26 172 30', stroke: 'c1', sw: 7 }] },
  { id: 'arrow-curve', cat: 'callout', name: '彎箭頭', vb: [120, 120], c1: '#ffffff', loop: 'draw', layers: [
    { d: 'M16 104C20 58 50 30 96 26', stroke: 'c1', sw: 8 },
    { d: 'M76 10L98 26L78 44', stroke: 'c1', sw: 8 }] },
  { id: 'arrow-bold', cat: 'callout', name: '粗箭頭', vb: [130, 84], c1: '#facc15', c2: DARK, loop: 'nudge', layers: [
    { d: 'M8 30H74V10L122 42L74 74V54H8Z', fill: 'c1', stroke: 'c2', sw: 6 }] },
  { id: 'focus', cat: 'callout', name: '對焦框', vb: [160, 110], c1: '#ffffff', loop: 'pulse', layers: [
    { d: 'M8 36V8H36M124 8H152V36M152 74V102H124M36 102H8V74', stroke: 'c1', sw: 6 },
    { d: 'M72 55H88M80 47V63', stroke: 'c1', sw: 3 }] },
  { id: 'bubble', cat: 'callout', name: '對話框', vb: [200, 140], c1: '#ffffff', c2: DARK, label: '你好！', loop: 'float', layers: [
    { d: 'M30 10H170Q190 10 190 30V84Q190 104 170 104H90L54 132L60 104H30Q10 104 10 84V30Q10 10 30 10Z', fill: 'c1', stroke: 'c2', sw: 6 },
    T('{label}', 100, 58, 34, 'c2')] },
  { id: 'thought', cat: 'callout', name: '思考泡泡', vb: [200, 150], c1: '#ffffff', c2: DARK, label: '嗯…', loop: 'float', layers: [
    { d: [circle(60, 58, 34), circle(100, 44, 38), circle(142, 58, 34), circle(80, 86, 30), circle(124, 88, 30), circle(42, 126, 9), circle(22, 142, 5)].join(''), fill: 'c1', stroke: 'c2', sw: 10 },
    T('{label}', 100, 66, 32, 'c2')] },
  { id: 'burst', cat: 'callout', name: '爆炸對白', vb: [160, 140], c1: '#facc15', c2: '#ef4444', label: 'WOW!', loop: 'wiggle', layers: [
    { d: star(80, 70, 14, 68, 48, -80), fill: 'c2', stroke: DARK, sw: 5 },
    { d: star(80, 70, 14, 52, 36, -70), fill: 'c1' },
    T('{label}', 80, 72, 30, DARK)] },

  // ---- 社群 ----
  { id: 'subscribe', cat: 'social', name: '訂閱按鈕', vb: [260, 86], c1: '#ff0033', label: '訂閱', loop: 'pulse', layers: [
    { d: rrect(6, 8, 248, 70, 35), fill: 'c1', stroke: '#ffffff', sw: 5 },
    { d: 'M42 26L70 43L42 60Z', fill: '#ffffff' },
    T('{label}', 152, 44, 36)] },
  { id: 'like', cat: 'social', name: '按讚', vb: [100, 100], c1: '#2563eb', loop: 'pulse', layers: [
    { d: circle(50, 50, 44), fill: 'c1', stroke: '#ffffff', sw: 6 },
    { d: 'M28 48H38V76H28ZM42 48L54 24C58 18 67 21 65 29L62 42H74C80 42 84 48 82 54L77 70C75 75 71 78 65 78H42Z', fill: '#ffffff' }] },
  { id: 'heart', cat: 'social', name: '愛心', vb: [100, 92], c1: '#ff3b5c', loop: 'pulse', layers: [
    { d: 'M50 86C20 64 6 46 10 30C14 14 34 8 50 26C66 8 86 14 90 30C94 46 80 64 50 86Z', fill: 'c1', stroke: '#ffffff', sw: 6 },
    { d: 'M24 30C26 23 31 20 37 20', stroke: 'rgba(255,255,255,.75)', sw: 5 }] },
  { id: 'bell', cat: 'social', name: '小鈴鐺', vb: [120, 100], c1: '#facc15', c2: DARK, loop: 'swing', layers: [
    { d: 'M60 12C44 12 36 26 36 42V58L28 70H92L84 58V42C84 26 76 12 60 12ZM52 76C52 86 68 86 68 76Z', fill: 'c1', stroke: 'c2', sw: 5 },
    { d: 'M16 30C14 40 16 50 22 58M104 30C106 40 104 50 98 58', stroke: 'c1', sw: 5 }] },
  { id: 'comment', cat: 'social', name: '留言', vb: [100, 96], c1: '#22c55e', loop: 'float', layers: [
    { d: 'M18 12H82Q92 12 92 22V62Q92 72 82 72H44L24 90V72H18Q8 72 8 62V22Q8 12 18 12Z', fill: 'c1', stroke: '#ffffff', sw: 5 },
    { d: circle(30, 42, 6) + circle(50, 42, 6) + circle(70, 42, 6), fill: '#ffffff' }] },
  { id: 'share', cat: 'social', name: '分享', vb: [100, 100], c1: '#a855f7', loop: 'nudge', layers: [
    { d: circle(50, 50, 44), fill: 'c1', stroke: '#ffffff', sw: 6 },
    { d: 'M54 26L80 48L54 70V58C38 58 28 62 20 74C22 54 32 40 54 38Z', fill: '#ffffff' }] },
  { id: 'live', cat: 'social', name: '直播中', vb: [180, 70], c1: '#ef4444', label: 'LIVE', loop: 'blink', layers: [
    { d: rrect(4, 6, 172, 58, 12), fill: 'c1', stroke: '#ffffff', sw: 4 },
    { d: circle(34, 35, 10), fill: '#ffffff', blink: true },
    T('{label}', 104, 36, 32)] },
  { id: 'rec', cat: 'social', name: '錄影中', vb: [170, 70], c1: '#ef4444', label: 'REC', loop: 'blink', layers: [
    { d: circle(30, 35, 16), fill: 'c1', blink: true },
    T('{label}', 104, 36, 38, '#ffffff', { stroke: DARK, sw: 4 })] },

  // ---- 裝飾 ----
  { id: 'sparkle', cat: 'decor', name: '閃光', vb: [100, 100], c1: '#fde047', loop: 'twinkle', layers: [
    { d: sparkle(50, 50, 46), fill: 'c1' }] },
  { id: 'sparkles', cat: 'decor', name: '三顆閃光', vb: [120, 110], c1: '#fde047', c2: '#ffffff', loop: 'twinkle', layers: [
    { d: sparkle(46, 62, 40), fill: 'c1' },
    { d: sparkle(96, 22, 18), fill: 'c2' },
    { d: sparkle(98, 88, 12), fill: 'c1' }] },
  { id: 'star', cat: 'decor', name: '星星', vb: [100, 100], c1: '#facc15', c2: '#ffffff', loop: 'spin-slow', layers: [
    { d: star(50, 53, 5, 46, 20), fill: 'c1', stroke: 'c2', sw: 5 }] },
  { id: 'rays', cat: 'decor', name: '放射光芒', vb: [200, 200], c1: '#fde68a', loop: 'spin-slow', layers: [
    { d: rays(100, 100, 18, 30, 98, 0.09), fill: 'c1', alpha: 0.85 }] },
  { id: 'crown', cat: 'decor', name: '皇冠', vb: [100, 90], c1: '#facc15', c2: '#ef4444', loop: 'swing', layers: [
    { d: 'M14 70L8 24L32 44L50 12L68 44L92 24L86 70Z', fill: 'c1', stroke: DARK, sw: 5 },
    { d: rrect(12, 70, 76, 12, 4), fill: 'c1', stroke: DARK, sw: 5 },
    { d: circle(50, 54, 6) + circle(30, 60, 4.5) + circle(70, 60, 4.5), fill: 'c2' }] },
  { id: 'fire', cat: 'decor', name: '火焰', vb: [100, 100], c1: '#f97316', c2: '#fde047', loop: 'flicker', layers: [
    { d: 'M50 6C58 26 80 36 80 62C80 82 66 94 50 94C34 94 20 82 20 62C20 46 30 38 34 26C38 38 44 42 46 44C44 30 46 18 50 6Z', fill: 'c1', stroke: DARK, sw: 4 },
    { d: 'M50 44C56 56 66 62 66 74C66 86 58 92 50 92C42 92 34 86 34 76C34 66 42 62 44 54C46 60 48 62 50 62C49 56 49 50 50 44Z', fill: 'c2' }] },
  { id: 'bolt', cat: 'decor', name: '閃電', vb: [100, 100], c1: '#facc15', loop: 'flicker', layers: [
    { d: 'M58 4L18 56H46L38 96L82 40H54Z', fill: 'c1', stroke: DARK, sw: 5 }] },
  { id: 'note', cat: 'decor', name: '音符', vb: [100, 100], c1: '#22d3ee', loop: 'float', layers: [
    { d: 'M38 74V22L84 12V62', stroke: 'c1', sw: 8 },
    { d: 'M38 22L84 12V26L38 36Z', fill: 'c1' },
    { d: ellipse(28, 76, 14, 10) + ellipse(74, 64, 14, 10), fill: 'c1' }] },
  { id: 'confetti', cat: 'decor', name: '彩帶紙花', vb: [200, 120], loop: 'float', layers: confetti() },
  { id: 'cloud', cat: 'decor', name: '雲朵', vb: [160, 100], c1: '#ffffff', c2: '#94a3b8', loop: 'float', layers: [
    { d: [circle(48, 60, 28), circle(84, 44, 34), circle(118, 60, 26), rrect(26, 56, 110, 32, 16)].join(''), fill: 'c1', stroke: 'c2', sw: 8 }] },
  { id: 'hearts', cat: 'decor', name: '愛心飄飄', vb: [120, 110], c1: '#fb7185', c2: '#f43f5e', loop: 'float', layers: [
    { d: 'M40 96C18 80 8 66 11 54C14 42 29 38 40 51C51 38 66 42 69 54C72 66 62 80 40 96Z', fill: 'c2' },
    { d: 'M88 52C74 42 68 33 70 25C72 17 82 14 88 23C95 14 104 17 106 25C108 33 102 42 88 52Z', fill: 'c1' },
    { d: 'M84 98C76 92 72 87 73 82C74 77 80 75 84 80C88 75 94 77 95 82C96 87 92 92 84 98Z', fill: 'c1' }] },

  // ---- 標籤 ----
  { id: 'tag-new', cat: 'badge', name: 'NEW', vb: [160, 70], c1: '#22c55e', label: 'NEW', loop: 'pulse', layers: [
    { d: rrect(4, 6, 152, 58, 14), fill: 'c1', stroke: '#ffffff', sw: 4 },
    T('{label}', 80, 36, 34)] },
  { id: 'tag-sale', cat: 'badge', name: '特價爆炸標', vb: [140, 140], c1: '#ef4444', label: 'SALE', loop: 'spin-slow', layers: [
    { d: star(70, 70, 16, 66, 54), fill: 'c1', stroke: '#ffffff', sw: 5 },
    T('{label}', 70, 72, 30, '#ffffff', { spin: false })] },
  { id: 'tag-hot', cat: 'badge', name: '熱門', vb: [170, 72], c1: '#f97316', c2: '#fde047', label: '熱門', loop: 'flicker', layers: [
    { d: rrect(4, 8, 162, 56, 28), fill: 'c1', stroke: '#ffffff', sw: 4 },
    { d: 'M38 14C42 24 54 28 54 42C54 52 47 58 38 58C29 58 22 52 22 42C22 34 27 30 29 24C31 30 34 32 35 33C34 26 35 20 38 14Z', fill: 'c2' },
    T('{label}', 108, 37, 30)] },
  { id: 'ribbon', cat: 'badge', name: '緞帶標題', vb: [260, 80], c1: '#e11d48', c2: '#9f1239', label: '精彩回顧', loop: 'none', layers: [
    { d: 'M4 24H44V72H4L18 48Z', fill: 'c2' },
    { d: 'M256 24H216V72H256L242 48Z', fill: 'c2' },
    { d: 'M30 10H230V62H30Z', fill: 'c1', stroke: '#ffffff', sw: 3 },
    T('{label}', 130, 37, 30)] },
  { id: 'stamp', cat: 'badge', name: '圓形印章', vb: [120, 120], c1: '#dc2626', label: '精選', loop: 'none', layers: [
    { d: circle(60, 60, 52), stroke: 'c1', sw: 6 },
    { d: circle(60, 60, 42), stroke: 'c1', sw: 2.5 },
    { d: star(60, 22, 5, 7, 3) + star(60, 98, 5, 7, 3), fill: 'c1' },
    T('{label}', 60, 62, 30, 'c1')] },
  { id: 'price', cat: 'badge', name: '價格吊牌', vb: [180, 90], c1: '#facc15', c2: DARK, label: '$199', loop: 'swing', layers: [
    { d: 'M40 8H170Q176 8 176 14V76Q176 82 170 82H40L6 45Z', fill: 'c1', stroke: 'c2', sw: 5 },
    { d: circle(32, 45, 7), fill: 'c2' },
    T('{label}', 108, 46, 34, 'c2')] },

  // ---- 表情 ----
  { id: 'face-smile', cat: 'face', name: '微笑', vb: [100, 100], c1: '#fcd34d', loop: 'swing', layers: face(
    { d: ellipse(35, 42, 5, 8) + ellipse(65, 42, 5, 8), fill: DARK },
    { d: 'M30 60C38 74 62 74 70 60', stroke: DARK, sw: 6 }) },
  { id: 'face-laugh', cat: 'face', name: '大笑', vb: [100, 100], c1: '#fcd34d', loop: 'wiggle', layers: face(
    { d: 'M26 42C30 34 40 34 44 42M56 42C60 34 70 34 74 42', stroke: DARK, sw: 6 },
    { d: 'M26 56H74C74 72 64 82 50 82C36 82 26 72 26 56Z', fill: DARK },
    { d: 'M38 74C42 68 58 68 62 74C58 80 42 80 38 74Z', fill: '#f43f5e' }) },
  { id: 'face-love', cat: 'face', name: '愛心眼', vb: [100, 100], c1: '#fcd34d', loop: 'pulse', layers: face(
    { d: 'M35 52C25 45 21 39 22 34C23 29 30 27 35 33C40 27 47 29 48 34C49 39 45 45 35 52ZM65 52C55 45 51 39 52 34C53 29 60 27 65 33C70 27 77 29 78 34C79 39 75 45 65 52Z', fill: '#ef4444' },
    { d: 'M32 64C40 76 60 76 68 64', stroke: DARK, sw: 6 }) },
  { id: 'face-wow', cat: 'face', name: '驚訝', vb: [100, 100], c1: '#fcd34d', loop: 'wiggle', layers: face(
    { d: circle(34, 40, 8) + circle(66, 40, 8), fill: '#ffffff', stroke: DARK, sw: 4 },
    { d: circle(34, 40, 3.5) + circle(66, 40, 3.5), fill: DARK },
    { d: ellipse(50, 68, 10, 13), fill: DARK }) },
  { id: 'face-cry', cat: 'face', name: '哭哭', vb: [100, 100], c1: '#fcd34d', loop: 'float', layers: face(
    { d: 'M26 40C30 46 40 46 44 40M56 40C60 46 70 46 74 40', stroke: DARK, sw: 6 },
    { d: 'M30 50C26 60 24 66 30 70C36 66 34 60 30 50ZM70 50C66 60 64 66 70 70C76 66 74 60 70 50Z', fill: '#38bdf8' },
    { d: 'M34 76C42 66 58 66 66 76', stroke: DARK, sw: 6 }) },
  { id: 'face-cool', cat: 'face', name: '酷', vb: [100, 100], c1: '#fcd34d', loop: 'swing', layers: face(
    { d: 'M14 36H86V42C86 52 78 58 70 58C60 58 54 50 52 44H48C46 50 40 58 30 58C22 58 14 52 14 42Z', fill: DARK },
    { d: 'M22 42L30 40', stroke: 'rgba(255,255,255,.6)', sw: 3 },
    { d: 'M36 70C44 76 58 76 66 68', stroke: DARK, sw: 6 }) },
  { id: 'face-angry', cat: 'face', name: '生氣', vb: [100, 100], c1: '#fb923c', loop: 'wiggle', layers: face(
    { d: 'M24 30L42 38M76 30L58 38', stroke: DARK, sw: 6 },
    { d: ellipse(35, 46, 5, 6) + ellipse(65, 46, 5, 6), fill: DARK },
    { d: 'M32 74C40 64 60 64 68 74', stroke: DARK, sw: 6 }) },
];

export const STICKER_LOOPS = [
  ['none', '無'], ['float', '上下浮動'], ['swing', '左右搖擺'], ['pulse', '心跳縮放'], ['wiggle', '抖動'],
  ['spin-slow', '慢慢旋轉'], ['twinkle', '閃爍'], ['flicker', '火光跳動'], ['blink', '指示燈閃'], ['nudge', '往前推'], ['draw', '手繪描出'],
];

const BY_ID = new Map(STICKER_DEFS.map((d) => [d.id, d]));
export const stickerDef = (id) => BY_ID.get(id);
export const usesColor2 = (def) => def.layers.some((l) => l.fill === 'c2' || l.stroke === 'c2');
export const usesColor1 = (def) => def.layers.some((l) => l.fill === 'c1' || l.stroke === 'c1');
export const hasLabel = (def) => def.label != null;

// 新貼圖片段的 shape 欄位
export function stickerShape(def, projW = 1920) {
  const w = Math.round((projW * (def.vb[0] >= 160 ? 0.24 : 0.16)) / 2) * 2;
  return { kind: 'sticker', sticker: def.id, color: def.c1 || '#ffffff', color2: def.c2 || '#ffffff', w, h: Math.round((w * def.vb[1]) / def.vb[0]), label: def.label ?? '', loop: def.loop || 'none' };
}

const resolve = (v, s) => (v === 'c1' ? s.color : v === 'c2' ? s.color2 : v);
const labelOf = (txt, s, def) => txt.replace('{label}', s?.label ?? def.label ?? '');

// ---------- SVG 預覽（素材庫用） ----------
export function stickerSVG(def) {
  const s = { color: def.c1 || '#fff', color2: def.c2 || '#fff' };
  const [vw, vh] = def.vb;
  const pad = 10;
  const parts = def.layers.map((l) => {
    if (l.text) {
      const fill = resolve(l.fill, s);
      const st = l.stroke ? ` stroke="${resolve(l.stroke, s)}" stroke-width="${l.sw}" paint-order="stroke" stroke-linejoin="round"` : '';
      return `<text x="${l.x}" y="${l.y}" font-size="${fitSize(l, def)}" font-weight="${l.weight}" fill="${fill}"${st} text-anchor="middle" dominant-baseline="central" font-family="Noto Sans TC, system-ui, sans-serif">${esc(labelOf(l.text, null, def))}</text>`;
    }
    const fill = l.fill ? resolve(l.fill, s) : 'none';
    const st = l.stroke ? ` stroke="${resolve(l.stroke, s)}" stroke-width="${l.fill ? l.sw * 2 : l.sw}" stroke-linecap="round" stroke-linejoin="round"` : '';
    const order = l.fill && l.stroke ? ' paint-order="stroke"' : '';
    return `<path d="${l.d}" fill="${fill}"${st}${order}${l.alpha ? ` opacity="${l.alpha}"` : ''}/>`;
  });
  return `<svg viewBox="${-pad} ${-pad} ${vw + pad * 2} ${vh + pad * 2}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// 文字太長時自動縮小，讓它待在貼圖裡
function fitSize(l, def, label) {
  const txt = labelOf(l.text, label != null ? { label } : null, def);
  const maxW = def.vb[0] * (l.x < def.vb[0] * 0.45 || l.x > def.vb[0] * 0.55 ? 0.5 : 0.72);
  let w = 0;
  for (const ch of txt) w += /[\x00-\xff]/.test(ch) ? 0.62 : 1;
  return Math.min(l.size, maxW / Math.max(1, w));
}

// ---------- Canvas 繪製（預覽與匯出共用） ----------
const pathCache = new Map();
const lenCache = new Map();
function path2d(d) {
  let p = pathCache.get(d);
  if (!p) pathCache.set(d, (p = new Path2D(d)));
  return p;
}
// 手繪描出動畫需要路徑長度；用 SVG 量一次就快取
function pathLen(d) {
  let L = lenCache.get(d);
  if (L != null) return L;
  L = 1000;
  try {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    L = el.getTotalLength() || 1000;
  } catch {
    /* 沒有 DOM（不應發生）就用估計值 */
  }
  lenCache.set(d, L);
  return L;
}

export function drawSticker(L, s, local = 0) {
  const def = stickerDef(s.sticker);
  if (!def) return { w: s.w, h: s.h };
  const [vw, vh] = def.vb;
  const k = s.w / vw;
  const ky = s.h / vh;
  const loop = s.loop || 'none';
  const T2 = Math.PI * 2;
  L.save();
  // 循環動態
  let alphaMul = 1;
  let blinkOn = true;
  if (loop === 'float') L.translate(0, Math.sin(local * T2 * 0.6) * s.h * 0.05);
  else if (loop === 'swing') L.rotate(Math.sin(local * T2 * 0.7) * 0.14);
  else if (loop === 'pulse') {
    const b = Math.pow(Math.max(0, Math.sin(local * T2 * 1.1)), 6);
    L.scale(1 + b * 0.12, 1 + b * 0.12);
  } else if (loop === 'wiggle') L.rotate((Math.floor(local * 10) % 2 ? 1 : -1) * 0.07);
  else if (loop === 'spin-slow') L.rotate(local * 0.8);
  else if (loop === 'twinkle') {
    const p = 0.5 + 0.5 * Math.sin(local * T2 * 0.9);
    L.scale(0.82 + p * 0.22, 0.82 + p * 0.22);
    L.rotate(p * 0.15);
    alphaMul = 0.65 + p * 0.35;
  } else if (loop === 'flicker') {
    const n = Math.sin(local * 23) * 0.5 + Math.sin(local * 37) * 0.5;
    L.scale(1 + n * 0.03, 1 - n * 0.04);
  } else if (loop === 'blink') blinkOn = Math.floor(local * 1.6) % 2 === 0;
  else if (loop === 'nudge') L.translate(Math.max(0, Math.sin(local * T2 * 1.2)) * s.w * 0.06, 0);
  const drawP = loop === 'draw' ? Math.min(1, local / 0.8) : 1;

  L.translate(-s.w / 2, -s.h / 2);
  L.scale(k, ky);
  L.lineCap = 'round';
  L.lineJoin = 'round';
  const base = L.globalAlpha;
  for (const l of def.layers) {
    L.globalAlpha = base * alphaMul * (l.alpha ?? 1) * (l.blink && !blinkOn ? 0.15 : 1);
    if (l.text) {
      const txt = labelOf(l.text, s, def);
      if (!txt) continue;
      L.font = `${l.weight} ${fitSize(l, def, s.label)}px "Noto Sans TC", system-ui, sans-serif`;
      L.textAlign = 'center';
      L.textBaseline = 'middle';
      if (drawP < 1) L.globalAlpha *= drawP;
      if (l.stroke) {
        L.lineWidth = l.sw;
        L.strokeStyle = resolve(l.stroke, s);
        L.strokeText(txt, l.x, l.y);
      }
      L.fillStyle = resolve(l.fill, s);
      L.fillText(txt, l.x, l.y);
      continue;
    }
    const p = path2d(l.d);
    if (l.stroke && drawP < 1 && !l.fill) {
      const len = pathLen(l.d);
      L.setLineDash([len * drawP, len]);
    }
    if (l.stroke) {
      L.lineWidth = l.fill ? l.sw * 2 : l.sw; // 有填色時描邊畫兩倍寬再蓋上填色，只留外框
      L.strokeStyle = resolve(l.stroke, s);
      L.stroke(p);
      L.setLineDash([]);
    }
    if (l.fill) {
      if (drawP < 1) L.globalAlpha *= drawP;
      L.fillStyle = resolve(l.fill, s);
      L.fill(p);
    }
  }
  L.restore();
  return { w: s.w, h: s.h };
}
