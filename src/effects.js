// 轉場、濾鏡預設、文字預設、字型等定義
export const easeOut = (p) => 1 - Math.pow(1 - p, 3);
export const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

export const TRANSITIONS = [
  ['none', '無'],
  ['fade', '淡入淡出'],
  ['slideL', '左側滑入'],
  ['slideR', '右側滑入'],
  ['slideU', '下方升起'],
  ['slideD', '上方落下'],
  ['zoomIn', '放大進場'],
  ['zoomOut', '縮小進場'],
  ['spin', '旋轉'],
  ['bounce', '彈跳'],
  ['blur', '模糊'],
  ['wipeL', '向右擦除'],
  ['wipeR', '向左擦除'],
  ['wipeU', '向上擦除'],
  ['wipeD', '向下擦除'],
  ['iris', '圓形展開'],
  ['flash', '閃白'],
  ['shake', '震動'],
  ['glitch', '故障風'],
];

export function baseMods() {
  return { dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1, blur: 0, wipe: null, flash: 0, glitch: 0 };
}

// p：0 = 完全隱藏，1 = 完全顯示
export function transMods(type, p) {
  p = Math.min(1, Math.max(0, p));
  const e = easeOut(p);
  const m = baseMods();
  switch (type) {
    case 'fade': m.alpha = p; break;
    case 'slideL': m.dx = -(1 - e); break;
    case 'slideR': m.dx = 1 - e; break;
    case 'slideU': m.dy = 1 - e; break;
    case 'slideD': m.dy = -(1 - e); break;
    case 'zoomIn': m.scale = 0.3 + 0.7 * e; m.alpha = Math.min(1, p * 2); break;
    case 'zoomOut': m.scale = 1 + (1 - e) * 0.8; m.alpha = Math.min(1, p * 2); break;
    case 'spin': m.rot = (1 - e) * -270; m.scale = Math.max(0.01, e); break;
    case 'bounce': m.scale = Math.max(0.01, easeOutBack(p)); m.alpha = Math.min(1, p * 4); break;
    case 'blur': m.blur = (1 - p) * 30; m.alpha = Math.min(1, p * 2); break;
    case 'wipeL': m.wipe = { kind: 'left', p: e }; break;
    case 'wipeR': m.wipe = { kind: 'right', p: e }; break;
    case 'wipeU': m.wipe = { kind: 'up', p: e }; break;
    case 'wipeD': m.wipe = { kind: 'down', p: e }; break;
    case 'iris': m.wipe = { kind: 'circle', p: e }; break;
    case 'flash': m.flash = (1 - p) * 0.9; m.alpha = Math.min(1, p * 3); break;
    case 'shake': m.dx = Math.sin(p * 50) * (1 - p) * 0.04; m.dy = Math.cos(p * 37) * (1 - p) * 0.03; m.alpha = Math.min(1, p * 3); break;
    case 'glitch': m.glitch = 1 - p; m.alpha = Math.min(1, p * 3); break;
  }
  return m;
}

function mergeMods(a, b) {
  return {
    dx: a.dx + b.dx,
    dy: a.dy + b.dy,
    scale: a.scale * b.scale,
    rot: a.rot + b.rot,
    alpha: a.alpha * b.alpha,
    blur: a.blur + b.blur,
    wipe: b.wipe || a.wipe,
    flash: Math.max(a.flash, b.flash),
    glitch: Math.max(a.glitch, b.glitch),
  };
}

export function clipMods(c, local) {
  let m = baseMods();
  if (c.transIn.type !== 'none' && local < c.transIn.dur) m = mergeMods(m, transMods(c.transIn.type, local / c.transIn.dur));
  const rem = c.duration - local;
  if (c.transOut.type !== 'none' && rem < c.transOut.dur) m = mergeMods(m, transMods(c.transOut.type, rem / c.transOut.dur));
  return m;
}

export function filterString(f, extraBlur = 0) {
  const parts = [];
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
  if (f.saturate !== 100) parts.push(`saturate(${f.saturate}%)`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale}%)`);
  if (f.sepia) parts.push(`sepia(${f.sepia}%)`);
  if (f.invert) parts.push(`invert(${f.invert}%)`);
  const blur = f.blur + extraBlur;
  if (blur > 0.05) parts.push(`blur(${blur}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

export const FILTER_PRESETS = [
  { name: '原始', filters: {}, effects: { vignette: 0, grain: 0, rgb: 0 } },
  { name: '電影感', filters: { contrast: 118, saturate: 82, brightness: 95, sepia: 12 }, effects: { vignette: 45 } },
  { name: '復古底片', filters: { sepia: 45, contrast: 110, saturate: 80, brightness: 103 }, effects: { grain: 35, vignette: 30 } },
  { name: '黑白', filters: { grayscale: 100, contrast: 125 } },
  { name: '鮮豔', filters: { saturate: 165, contrast: 110 } },
  { name: '暖陽', filters: { sepia: 30, saturate: 135, brightness: 106 } },
  { name: '冷調', filters: { hue: 12, saturate: 90, brightness: 102, contrast: 105 } },
  { name: '夢幻', filters: { brightness: 112, contrast: 88, saturate: 125, blur: 0.6 } },
  { name: '賽博龐克', filters: { hue: -35, saturate: 180, contrast: 120 }, effects: { rgb: 4, vignette: 25 } },
  { name: '褪色', filters: { contrast: 78, brightness: 112, saturate: 65 } },
  { name: '夜視', filters: { grayscale: 100, sepia: 100, hue: 60, saturate: 350, brightness: 110 }, effects: { grain: 45, vignette: 60 } },
  { name: '負片', filters: { invert: 100 } },
  { name: '日系清新', filters: { brightness: 110, contrast: 92, saturate: 110, hue: -5 } },
  { name: '港風', filters: { sepia: 20, saturate: 140, contrast: 115, hue: -10 }, effects: { grain: 20 } },
];

export const FONTS = [
  'Noto Sans TC', 'Noto Serif TC', 'LXGW WenKai TC', 'Bebas Neue', 'Montserrat',
  'Pacifico', 'Permanent Marker', 'Orbitron', 'Press Start 2P', 'system-ui', 'serif', 'monospace',
];

export const TEXT_ANIMS = [
  ['none', '無'],
  ['typewriter', '打字機'],
  ['wave', '波浪'],
  ['rainbow', '彩虹'],
  ['flicker', '霓虹閃爍'],
  ['pulse', '心跳'],
];

export const TEXT_PRESETS = [
  { name: '大標題', text: { content: '大標題', size: 140, weight: '900', stroke: 4, strokeColor: '#000000', shadow: 20 }, transIn: { type: 'zoomIn', dur: 0.5 } },
  { name: '字幕', text: { content: '這是一行字幕', size: 56, weight: '700', bg: true, bgOpacity: 0.55 }, transform: { y: 400 } },
  { name: '霓虹', text: { content: 'NEON', font: 'Orbitron', size: 130, color: '#a5f3fc', shadow: 45, shadowColor: '#22d3ee', anim: 'flicker' } },
  { name: '漸層', text: { content: '漸層文字', size: 130, weight: '900', gradient: true, color: '#ff6ec4', color2: '#7873f5' }, transIn: { type: 'slideU', dur: 0.6 } },
  { name: '打字機', text: { content: '一個字一個字出現…', font: 'LXGW WenKai TC', size: 80, anim: 'typewriter' } },
  { name: '彩虹波浪', text: { content: 'Hello World!', font: 'Pacifico', size: 120, anim: 'rainbow' } },
  { name: '綜藝字', text: { content: '太扯了吧！', size: 130, weight: '900', color: '#ffe600', stroke: 10, strokeColor: '#111111', shadow: 0 }, transIn: { type: 'bounce', dur: 0.5 }, transform: { rotation: -6 } },
  { name: '電影片名', text: { content: 'THE  STORY', font: 'Bebas Neue', size: 170, letterSpacing: 24, color: '#f5f5f5' }, transIn: { type: 'fade', dur: 1.2 }, transOut: { type: 'fade', dur: 1 } },
  { name: '手寫', text: { content: 'Have a nice day', font: 'Permanent Marker', size: 110, color: '#fef3c7', anim: 'wave' } },
  { name: '像素遊戲', text: { content: 'GAME OVER', font: 'Press Start 2P', size: 80, color: '#f87171', stroke: 3, anim: 'pulse' } },
  { name: '書法', text: { content: '山 水 之 間', font: 'Noto Serif TC', size: 150, color: '#fafafa', shadow: 30 }, transIn: { type: 'blur', dur: 1 } },
  { name: '標籤', text: { content: '#重點', size: 64, weight: '900', bg: true, bgColor: '#ef4444', bgOpacity: 1 }, transIn: { type: 'slideL', dur: 0.4 } },
];

export const STICKERS = '😀😂🤣😍🥰😎🤩🥳😭😱🤯😡👍👏🙏💪🔥✨💯❤️💔💥💫⭐🌈☀️🌙⚡🎉🎊🎁🎵🎬📸🍕🍔🍟🍩☕🍺🐶🐱🦊🐼🦄🌸🌹🍀🚀✈️🏆⚽🎮💡💰📌✅❌⚠️❓❗👀👉👈👆👇'.match(/\p{Extended_Pictographic}️?/gu);

export const SHAPE_PRESETS = [
  { name: '矩形', shape: { kind: 'rect', color: '#22d3ee', w: 600, h: 360 } },
  { name: '圓角矩形', shape: { kind: 'rect', color: '#a78bfa', w: 600, h: 360, radius: 60 } },
  { name: '圓形', shape: { kind: 'circle', color: '#f472b6', w: 400, h: 400 } },
  { name: '字幕條', shape: { kind: 'rect', color: '#000000', w: 1920, h: 160 }, transform: { y: 400, opacity: 0.6 } },
  { name: '黑幕', shape: { kind: 'solid', color: '#000000' } },
  { name: '白幕', shape: { kind: 'solid', color: '#ffffff' } },
  { name: '日落漸層', shape: { kind: 'gradient', color: '#f97316', color2: '#db2777' } },
  { name: '海洋漸層', shape: { kind: 'gradient', color: '#06b6d4', color2: '#3b82f6' } },
  { name: '極光漸層', shape: { kind: 'gradient', color: '#22c55e', color2: '#8b5cf6' } },
  { name: '夜空漸層', shape: { kind: 'gradient', color: '#0f172a', color2: '#4c1d95' } },
  { name: '電影黑邊', shape: { kind: 'letterbox', color: '#000000', h: 140 } },
];

export const BLEND_MODES = [
  ['source-over', '正常'], ['multiply', '色彩增值'], ['screen', '濾色'], ['overlay', '覆蓋'],
  ['darken', '變暗'], ['lighten', '變亮'], ['color-dodge', '加亮顏色'], ['color-burn', '加深顏色'],
  ['hard-light', '實光'], ['soft-light', '柔光'], ['difference', '差異化'], ['exclusion', '排除'],
  ['hue', '色相'], ['saturation', '飽和度'], ['color', '顏色'], ['luminosity', '明度'], ['lighter', '相加'],
];
