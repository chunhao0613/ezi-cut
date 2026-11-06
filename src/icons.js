// 介面圖示：統一線條風格的 SVG（24×24，跟著文字顏色）
const P = {
  media: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor"/>',
  caption: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.6 10.1a2 2 0 1 0 0 3.8M16.4 10.1a2 2 0 1 0 0 3.8"/>',
  text: '<path d="M5 7.5V5h14v2.5M12 5v14M9 19h6"/>',
  template: '<rect x="3" y="3" width="8" height="8" rx="1.8"/><rect x="13" y="3" width="8" height="5" rx="1.8"/><rect x="13" y="10" width="8" height="11" rx="1.8"/><rect x="3" y="13" width="8" height="8" rx="1.8"/>',
  sticker: '<path d="M20.5 13V8a5 5 0 0 0-5-5h-7a5 5 0 0 0-5 5v7.5a5 5 0 0 0 5 5H13z"/><path d="M13 20.5V18a5 5 0 0 1 5-5h2.5"/><path d="M8.5 13a3.5 3.5 0 0 0 4.5.6"/><path d="M9 8.5v.5M14 8.5v.5"/>',
  shape: '<circle cx="8" cy="8" r="5"/><path d="M14.5 11.5 21 21h-13z"/>',
  filter: '<circle cx="9" cy="9" r="5.5"/><circle cx="15" cy="9" r="5.5"/><circle cx="12" cy="15" r="5.5"/>',
  transition: '<rect x="2.5" y="6" width="9" height="12" rx="1.8"/><path d="M15 6h4.5A2 2 0 0 1 21.5 8v8a2 2 0 0 1-2 2H15" stroke-dasharray="2.2 2.6"/><path d="M8 12h9m-3-3 3 3-3 3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  newfile: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  export: '<path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  toStart: '<path d="M6 5v14"/><path d="M19 5.8v12.4L10 12z" fill="currentColor"/>',
  toEnd: '<path d="M18 5v14"/><path d="M5 5.8v12.4L14 12z" fill="currentColor"/>',
  stepBack: '<path d="M11.5 6.5v11L4 12zM20 6.5v11L12.5 12z" fill="currentColor"/>',
  stepFwd: '<path d="M4 6.5v11l7.5-5.5zM12.5 6.5v11L20 12z" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  split: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  magnet: '<path d="M5 4h4v7a3 3 0 0 0 6 0V4h4v7a7 7 0 0 1-14 0z"/><path d="M5 8h4M15 8h4"/>',
  fit: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m16 9 6 6M22 9l-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  timeline: '<rect x="3" y="5" width="11" height="5" rx="1.5"/><rect x="8" y="14" width="13" height="5" rx="1.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  sparkles: '<path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  reverse: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  freeze: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 9v6M14 9v6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M10 10h1M14 10h1M18 10h0M7 14h10"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
};

const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

export function icon(name, cls = '') {
  const s = document.createElement('span');
  s.className = `icon${cls ? ' ' + cls : ''}`;
  s.innerHTML = svg(name);
  return s;
}

// 把 HTML 裡的 <i data-icon="名稱"></i> 換成圖示
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = svg(el.dataset.icon);
    el.classList.add('icon');
  }
}

export function setIcon(el, name) {
  const target = el.querySelector('.icon') || el;
  target.innerHTML = svg(name);
}
