// 多軌時間軸：繪製、拖曳移動、修剪、磁吸、縮放、跨軌
import {
  store, on, emit, checkpoint, select, getClip, trackIndex, projectDuration, placeClip, overlaps, clamp,
} from './state.js';
import { $, h, fmtTime } from './ui.js';
import { srcAt, srcOffset, srcLength, localAt, avgSpeed, hasCurve, CURVE_PRESETS } from './timemap.js';
import { TRANSITIONS } from './effects.js';
import { applyCrossTransition, removeCrossTransition } from './tools.js';

const VISUAL_T = new Set(['video', 'image', 'shape', 'text']);

export const TRACK_H = 60;

export function initTimeline({ onDrop, seek }) {
  const scroll = $('tlScroll');
  const inner = $('tlInner');
  const rowsEl = $('tlRows');
  const clipsEl = $('tlClips');
  const heads = $('tlHeads');
  const ruler = $('tlRuler');
  const playhead = $('tlPlayhead');
  const snapLine = $('tlSnap');
  const rctx = ruler.getContext('2d');

  const timeAt = (clientX) => Math.max(0, (clientX - inner.getBoundingClientRect().left) / store.zoom);
  const rowAt = (clientY) =>
    clamp(Math.floor((clientY - inner.getBoundingClientRect().top) / TRACK_H), 0, store.project.tracks.length - 1);

  function render() {
    const { tracks, clips } = store.project;
    inner.style.width = Math.max(scroll.clientWidth, (projectDuration() + 30) * store.zoom) + 'px';
    inner.style.height = Math.max(tracks.length * TRACK_H, scroll.clientHeight - 2) + 'px';
    rowsEl.innerHTML = '';
    heads.innerHTML = '';
    tracks.forEach((t, i) => {
      rowsEl.append(h('div', { class: `tl-row${t.hidden ? ' is-hidden' : ''}${t.muted ? ' is-muted' : ''}`, style: `top:${i * TRACK_H}px;height:${TRACK_H}px` }));
      heads.append(trackHead(t, i));
    });
    heads.append(h('div', { style: `height:${Math.max(0, scroll.clientHeight)}px` }));
    clipsEl.innerHTML = '';
    for (const c of clips) clipsEl.append(clipNode(c));
    renderJunctions();
    drawRuler();
    updatePlayhead();
  }

  // 同軌道相鄰（或已加轉場而重疊）的兩段之間放一個轉場按鈕
  function renderJunctions() {
    const { tracks, clips } = store.project;
    tracks.forEach((t, row) => {
      const list = clips.filter((c) => c.trackId === t.id && VISUAL_T.has(c.type)).sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const next = list[i];
        const gap = next.start - (prev.start + prev.duration);
        const linked = next.xfade?.prevId === prev.id;
        if (!linked && Math.abs(gap) > 0.05) continue;
        const x = (linked ? next.start + next.xfade.dur / 2 : next.start) * store.zoom;
        const j = h('div', { class: `junction${linked ? ' on' : ''}`, title: linked ? `轉場：${trName(next.xfade.type)}（點一下修改）` : '加入轉場', style: `left:${x}px;top:${row * TRACK_H + TRACK_H / 2 - 10}px` }, '⧓');
        j.addEventListener('pointerdown', (e) => e.stopPropagation());
        j.addEventListener('click', (e) => {
          e.stopPropagation();
          openJunctionMenu(e.clientX, e.clientY, prev, next);
        });
        clipsEl.append(j);
      }
    });
  }
  const trName = (id) => TRANSITIONS.find(([k]) => k === id)?.[1] || id;
  let jmenu = null;
  function closeJMenu() {
    jmenu?.remove();
    jmenu = null;
  }
  function openJunctionMenu(x, y, prev, next) {
    closeJMenu();
    let dur = next.xfade?.dur || 0.5;
    const durSel = h('select', {}, [0.3, 0.5, 0.8, 1, 1.5].map((v) => h('option', { value: v }, `${v} 秒`)));
    durSel.value = String([0.3, 0.5, 0.8, 1, 1.5].reduce((a, b) => (Math.abs(b - dur) < Math.abs(a - dur) ? b : a)));
    durSel.onchange = () => (dur = +durSel.value);
    jmenu = h('div', { class: 'jmenu' },
      h('div', { class: 'section-title' }, '片段轉場'),
      h('div', { class: 'jgrid' }, TRANSITIONS.slice(1).map(([id, l]) => h('button', { class: next.xfade?.type === id ? 'on' : '', onclick: () => {
        applyCrossTransition(prev, next, id, dur);
        closeJMenu();
      } }, l))),
      h('div', { class: 'tool-row' }, h('span', { class: 'dim' }, '長度'), durSel,
        next.xfade && h('button', { onclick: () => { removeCrossTransition(prev, next); closeJMenu(); } }, '移除')),
    );
    document.body.append(jmenu);
    const r = jmenu.getBoundingClientRect();
    jmenu.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2))}px`;
    jmenu.style.top = `${Math.max(8, y - r.height - 12)}px`;
    setTimeout(() => document.addEventListener('pointerdown', function off(ev) {
      if (!jmenu?.contains(ev.target)) {
        closeJMenu();
        document.removeEventListener('pointerdown', off, true);
      }
    }, true));
  }

  function trackHead(t, i) {
    const btn = (icon, title, fn, on) => h('button', { class: `ic${on ? ' on' : ''}`, title, onclick: fn }, icon);
    const name = h('span', { class: 'nm', title: '雙擊改名', ondblclick: () => {
      const n = prompt('軌道名稱', t.name);
      if (n) { checkpoint(); t.name = n; emit('project'); }
    } }, t.name);
    return h('div', { class: 'tl-head', style: `height:${TRACK_H}px` },
      name,
      h('div', { class: 'tl-head-btns' },
        btn(t.hidden ? '🙈' : '👁', '顯示 / 隱藏畫面', () => { checkpoint(); t.hidden = !t.hidden; emit('project'); }, t.hidden),
        btn(t.muted ? '🔇' : '🔊', '靜音', () => { checkpoint(); t.muted = !t.muted; emit('project'); }, t.muted),
        btn('✕', '刪除軌道', () => {
          const { tracks, clips } = store.project;
          if (tracks.length <= 1) return;
          const n = clips.filter((c) => c.trackId === t.id).length;
          if (n && !confirm(`這條軌道上有 ${n} 個片段，一起刪除？`)) return;
          checkpoint();
          store.project.clips = clips.filter((c) => c.trackId !== t.id);
          tracks.splice(i, 1);
          if (!getClip(store.selection)) store.selection = null;
          emit('project');
        }),
      ),
    );
  }

  function place(el, c) {
    el.style.left = c.start * store.zoom + 'px';
    el.style.width = Math.max(4, c.duration * store.zoom) + 'px';
    el.style.top = trackIndex(c.trackId) * TRACK_H + 3 + 'px';
    el.style.height = TRACK_H - 6 + 'px';
  }

  function clipLabel(c, m) {
    let s;
    if (c.type === 'text') s = c.text.content.split('\n')[0] || '文字';
    else if (c.type === 'shape') s = { rect: '形狀', circle: '圓形', solid: '純色', gradient: '漸層', letterbox: '黑邊' }[c.shape.kind] || '形狀';
    else s = m ? m.name : c.slot ? `＋ ${c.slot.label}` : '⚠ 找不到媒體';
    if (hasCurve(c)) s += `  ⤳${CURVE_PRESETS.find((p) => p.id === c.curve.id)?.name || '曲線變速'}`;
    else if (c.speed !== 1) s += `  ×${+c.speed.toFixed(2)}`;
    if (c.reversed) s = '⇆ ' + s;
    return s;
  }

  function clipNode(c) {
    const m = store.media.get(c.mediaId);
    const el = h('div', { class: `clip t-${c.type}${c.id === store.selection ? ' sel' : ''}`, 'data-id': c.id });
    place(el, c);
    const cv = h('canvas', { class: 'clip-cv' });
    el.append(cv, h('div', { class: 'clip-label' }, clipLabel(c, m)), h('div', { class: 'h h-l' }), h('div', { class: 'h h-r' }));
    if (c.transIn.type !== 'none') el.append(h('div', { class: 'tr-badge in', style: `width:${c.transIn.dur * store.zoom}px` }));
    if (c.transOut.type !== 'none') el.append(h('div', { class: 'tr-badge out', style: `width:${c.transOut.dur * store.zoom}px` }));
    const kfTimes = new Set();
    for (const kf of Object.values(c.keyframes || {})) for (const k of kf) kfTimes.add(k.t.toFixed(3));
    for (const t of kfTimes) el.append(h('div', { class: 'kf-dot', style: `left:${t * store.zoom - 4}px` }));
    drawClipCanvas(cv, c, m);
    return el;
  }

  function drawClipCanvas(cv, c, m) {
    const z = store.zoom;
    const w = Math.min(12000, Math.max(1, Math.round(c.duration * z)));
    const hgt = TRACK_H - 6;
    cv.width = w;
    cv.height = hgt;
    cv.style.width = w + 'px';
    const g = cv.getContext('2d');
    if (m && (c.type === 'video' || c.type === 'image') && m.thumbs.length) {
      const tileW = Math.max(20, Math.round(hgt * ((m.width / m.height) || 16 / 9)));
      for (let x = 0; x < w; x += tileW) {
        let idx = 0;
        if (c.type === 'video') idx = clamp(Math.floor((srcAt(c, x / z) / m.duration) * m.thumbs.length), 0, m.thumbs.length - 1);
        g.drawImage(m.thumbs[idx], x, 0, tileW, hgt);
      }
      g.fillStyle = 'rgba(0,0,0,.25)';
      g.fillRect(0, 0, w, hgt);
    }
    if (m?.peaks && (c.type === 'audio' || c.type === 'video')) {
      const isAudio = c.type === 'audio';
      const amp = isAudio ? hgt * 0.45 : hgt * 0.32;
      const vol = Math.min(1.5, c.mute ? 0 : c.volume);
      g.fillStyle = isAudio ? 'rgba(190,255,210,.85)' : 'rgba(255,255,255,.6)';
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor(srcAt(c, x / z) * 100);
        const i1 = Math.max(i0 + 1, Math.min(i0 + 40, Math.floor(srcAt(c, (x + 1) / z) * 100)));
        let v = 0;
        for (let i = i0; i < i1; i++) v = Math.max(v, m.peaks[i] || 0);
        const bh = Math.max(0.5, v * amp * vol);
        if (isAudio) g.fillRect(x, hgt / 2 - bh, 1, bh * 2);
        else g.fillRect(x, hgt - bh, 1, bh);
      }
    }
    // 節拍標記：每拍一條短線，每小節第一拍較長
    if (m?.beats && (c.type === 'audio' || c.type === 'video')) {
      const down = new Set(m.beats.downbeats);
      for (const b of m.beats.beats) {
        const off = b - c.in;
        if (off < 0 || off > srcLength(c)) continue;
        const x = Math.round(localAt(c, off) * z);
        const isDown = down.has(b);
        g.fillStyle = isDown ? '#fde047' : 'rgba(253,224,71,.7)';
        g.fillRect(x, 0, isDown ? 2 : 1, isDown ? 12 : 7);
      }
    }
  }

  // 片段上所有節拍在時間軸上的時間（給磁吸用）
  function beatTimes(c) {
    const m = store.media.get(c.mediaId);
    if (!m?.beats) return [];
    const out = [];
    for (const b of m.beats.beats) {
      const off = b - c.in;
      if (off >= 0 && off <= srcLength(c)) out.push(c.start + localAt(c, off));
    }
    return out;
  }

  // ---------- 尺規 ----------
  function drawRuler() {
    const dpr = devicePixelRatio || 1;
    const w = ruler.clientWidth;
    const hgt = ruler.clientHeight;
    if (ruler.width !== Math.round(w * dpr) || ruler.height !== Math.round(hgt * dpr)) {
      ruler.width = Math.round(w * dpr);
      ruler.height = Math.round(hgt * dpr);
    }
    const g = rctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const z = store.zoom;
    const sl = scroll.scrollLeft;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * z >= 70) || 600;
    const minor = major / 5;
    g.fillStyle = '#7d8494';
    g.strokeStyle = '#3a3f4b';
    g.font = '10px system-ui';
    g.textBaseline = 'top';
    const t0 = Math.floor(sl / z / minor) * minor;
    const t1 = (sl + w) / z;
    g.beginPath();
    for (let i = 0; t0 + i * minor <= t1; i++) {
      const t = t0 + i * minor;
      const x = Math.round(t * z - sl) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.moveTo(x, hgt);
      g.lineTo(x, isMajor ? hgt - 12 : hgt - 5);
      if (isMajor) g.fillText(major < 1 ? fmtTime(t) : fmtTime(t).slice(0, 5), x + 3, 3);
    }
    g.stroke();
    const px = store.time * z - sl;
    g.fillStyle = '#f43f5e';
    g.beginPath();
    g.moveTo(px - 6, hgt - 10);
    g.lineTo(px + 6, hgt - 10);
    g.lineTo(px, hgt);
    g.fill();
  }

  function updatePlayhead() {
    const px = store.time * store.zoom;
    playhead.style.transform = `translateX(${px}px)`;
    if (store.playing) {
      const vw = scroll.clientWidth;
      if (px > scroll.scrollLeft + vw - 40 || px < scroll.scrollLeft) scroll.scrollLeft = px - 80;
    }
    drawRuler();
  }

  // ---------- 磁吸 ----------
  function snapPoints(exceptId) {
    const pts = [0, store.time];
    for (const c of store.project.clips) {
      if (c.id === exceptId) continue;
      pts.push(c.start, c.start + c.duration, ...beatTimes(c));
    }
    return pts;
  }
  function snapTo(t, pts) {
    if (!store.snap) return null;
    const thr = 8 / store.zoom;
    let best = null;
    for (const p of pts) if (Math.abs(p - t) < thr && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
    return best;
  }
  function showSnap(t) {
    if (t === null) snapLine.style.display = 'none';
    else {
      snapLine.style.display = 'block';
      snapLine.style.transform = `translateX(${t * store.zoom}px)`;
    }
  }

  // ---------- 互動 ----------
  let drag = null;
  function startScrub(e, el) {
    select(null);
    seek(timeAt(e.clientX));
    drag = { mode: 'scrub' };
    el.setPointerCapture(e.pointerId);
  }
  ruler.addEventListener('pointerdown', (e) => {
    seek(timeAt(e.clientX));
    drag = { mode: 'scrub' };
    ruler.setPointerCapture(e.pointerId);
  });
  ruler.addEventListener('pointermove', (e) => drag?.mode === 'scrub' && seek(timeAt(e.clientX)));
  ruler.addEventListener('pointerup', () => (drag = null));

  scroll.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const node = e.target.closest('.clip');
    if (e.target.closest('.junction')) return;
    // 觸控：空白處交給瀏覽器捲動，輕點才移動播放頭
    if (!node && e.pointerType === 'touch') {
      drag = { mode: 'tap', x0: e.clientX, y0: e.clientY, t0: performance.now() };
      return;
    }
    if (!node) return startScrub(e, scroll);
    const c = getClip(node.dataset.id);
    if (!c) return;
    select(c.id);
    const mode = e.target.classList.contains('h-l') ? 'trimL' : e.target.classList.contains('h-r') ? 'trimR' : 'move';
    const m = store.media.get(c.mediaId);
    const finite = m && (c.type === 'video' || c.type === 'audio');
    // 修剪時不能超過同軌道相鄰片段
    const same = store.project.clips.filter((o) => o.trackId === c.trackId && o.id !== c.id);
    const prevEnd = Math.max(0, ...same.filter((o) => o.start + o.duration <= c.start + 1e-6).map((o) => o.start + o.duration));
    const nextStart = Math.min(Infinity, ...same.filter((o) => o.start >= c.start + c.duration - 1e-6).map((o) => o.start));
    drag = {
      mode, c, el: node, x0: e.clientX, y0: e.clientY, moved: false,
      orig: { start: c.start, duration: c.duration, in: c.in, kf: structuredClone(c.keyframes || {}) },
      maxSrc: finite ? m.duration : Infinity, finite, prevEnd, nextStart, pts: snapPoints(c.id),
    };
    scroll.setPointerCapture(e.pointerId);
  });

  scroll.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'scrub') return seek(timeAt(e.clientX));
    if (drag.mode === 'tap') return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x0) < 3 && Math.abs(e.clientY - drag.y0) < 3) return;
      drag.moved = true;
      checkpoint();
    }
    const { c, orig: o } = drag;
    const dx = (e.clientX - drag.x0) / store.zoom;
    let snapped = null;
    if (drag.mode === 'move') {
      let s = Math.max(0, o.start + dx);
      const a = snapTo(s, drag.pts);
      const b = snapTo(s + c.duration, drag.pts);
      if (a !== null && (b === null || Math.abs(a - s) <= Math.abs(b - s - c.duration))) { s = a; snapped = a; }
      else if (b !== null) { s = b - c.duration; snapped = b; }
      c.start = Math.max(0, s);
      c.trackId = store.project.tracks[rowAt(e.clientY)].id;
    } else if (drag.mode === 'trimL') {
      let s = o.start + dx;
      const sn = snapTo(s, drag.pts);
      if (sn !== null) { s = sn; snapped = sn; }
      const minS = Math.max(drag.prevEnd, drag.finite ? o.start - o.in / avgSpeed(c) : 0);
      s = clamp(s, minS, o.start + o.duration - 0.1);
      const d = s - o.start;
      c.start = s;
      c.duration = o.duration - d;
      if (drag.finite) c.in = o.in + srcOffset({ ...c, duration: o.duration }, d);
      c.keyframes = {};
      for (const [p, kf] of Object.entries(o.kf)) c.keyframes[p] = kf.map((k) => ({ t: k.t - d, v: k.v }));
    } else {
      let end = o.start + o.duration + dx;
      const sn = snapTo(end, drag.pts);
      if (sn !== null) { end = sn; snapped = sn; }
      const maxEnd = Math.min(drag.nextStart, o.start + (drag.maxSrc - o.in) / avgSpeed(c));
      c.duration = clamp(end, o.start + 0.1, maxEnd) - o.start;
    }
    showSnap(snapped);
    place(drag.el, c);
    if (drag.mode !== 'move') drawClipCanvas(drag.el.querySelector('canvas'), c, store.media.get(c.mediaId));
    emit('props');
  });

  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'tap') {
      if (e?.type === 'pointerup' && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 10 && performance.now() - d.t0 < 400) {
        select(null);
        seek(timeAt(e.clientX));
      }
      return;
    }
    showSnap(null);
    if (d.mode !== 'scrub' && d.moved) {
      const c = d.c;
      if (d.mode === 'move' && overlaps(c.trackId, c.start, c.start + c.duration, c.id)) placeClip(c, c.trackId);
      emit('project');
    }
  };
  scroll.addEventListener('pointerup', endDrag);
  scroll.addEventListener('pointercancel', endDrag);

  scroll.addEventListener('scroll', () => {
    heads.scrollTop = scroll.scrollTop;
    drawRuler();
  });
  heads.addEventListener('wheel', (e) => { scroll.scrollTop += e.deltaY; }, { passive: true });

  scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(store.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && store.project.tracks.length * TRACK_H <= scroll.clientHeight) {
      // 沒有垂直捲動空間時，滾輪改為水平捲動
      scroll.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // 從素材庫拖入 / 從檔案總管拖入
  scroll.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  scroll.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDrop(e.dataTransfer, timeAt(e.clientX), store.project.tracks[rowAt(e.clientY)].id);
  });

  // 觸控兩指縮放時間軸
  let pinch = null;
  scroll.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const [a, b] = e.touches;
    pinch = { d0: Math.abs(a.clientX - b.clientX) || 1, z0: store.zoom, cx: (a.clientX + b.clientX) / 2 };
    drag = null;
  }, { passive: true });
  scroll.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    setZoom(pinch.z0 * ((Math.abs(a.clientX - b.clientX) || 1) / pinch.d0), pinch.cx);
  }, { passive: false });
  scroll.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
  });

  function setZoom(z, anchorClientX) {
    const rect = scroll.getBoundingClientRect();
    const ax = anchorClientX ?? rect.left + scroll.clientWidth / 2;
    const t = (ax - rect.left + scroll.scrollLeft) / store.zoom;
    store.zoom = clamp(z, 4, 400);
    $('zoomRange').value = store.zoom;
    render();
    scroll.scrollLeft = t * store.zoom - (ax - rect.left);
  }
  function zoomFit() {
    const d = projectDuration() || 10;
    store.zoom = clamp((scroll.clientWidth - 60) / d, 4, 400);
    $('zoomRange').value = store.zoom;
    render();
    scroll.scrollLeft = 0;
  }
  $('zoomRange').addEventListener('input', (e) => setZoom(+e.target.value));

  function refreshSelection() {
    for (const el of clipsEl.children) el.classList.toggle('sel', el.dataset.id === store.selection);
  }

  on('project', render);
  on('layout', render);
  on('media', render);
  on('select', refreshSelection);
  new ResizeObserver(() => render()).observe(scroll);

  return { render, updatePlayhead, setZoom, zoomFit };
}
