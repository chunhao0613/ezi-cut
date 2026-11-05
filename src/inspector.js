// 右側屬性面板
import {
  store, on, emit, checkpoint, selected, clamp, setProp, getProp, toggleKey, hasKeyAt, hasKeys,
  FILTER_DEFAULT, EFFECT_DEFAULT,
} from './state.js';
import { TRANSITIONS, FONTS, TEXT_ANIMS, BLEND_MODES, FILTER_PRESETS } from './effects.js';
import { $, h, fmtTime, toast } from './ui.js';
import { CURVE_PRESETS, hasCurve, avgSpeed, srcLength } from './timemap.js';
import { analyzeBeats, beatSync, findSilences, removeSilences, restoreVoice } from './tools.js';
import { GRADE_DEFAULT, curveTable, BUILTIN_LUTS } from './grade.js';
import { importFiles } from './media.js';
import { VOICES, ttsPrefs } from './tts.js';

let freezeDur = 2;

const ASPECTS = [
  ['16:9 橫式', 1920, 1080], ['9:16 直式', 1080, 1920], ['1:1 方形', 1080, 1080],
  ['4:5 IG', 1080, 1350], ['4:3', 1440, 1080], ['21:9 電影', 2560, 1080], ['4K 16:9', 3840, 2160],
];
const TYPE_NAME = { video: '影片', image: '圖片', audio: '音訊', text: '文字', shape: '素材' };
const TABS_BY_TYPE = {
  video: [['frame', '畫面'], ['color', '調色'], ['fx', '特效'], ['mask', '遮罩'], ['anim', '動畫'], ['audio', '音訊']],
  image: [['frame', '畫面'], ['color', '調色'], ['fx', '特效'], ['mask', '遮罩'], ['anim', '動畫']],
  audio: [['audio', '音訊']],
  text: [['text', '文字'], ['frame', '畫面'], ['anim', '動畫'], ['fx', '特效'], ['mask', '遮罩']],
  shape: [['shape', '形狀'], ['frame', '畫面'], ['color', '調色'], ['anim', '動畫'], ['fx', '特效'], ['mask', '遮罩']],
};

export function initInspector(api) {
  const root = $('inspector');
  const tabFor = {};
  let refreshers = [];
  let editing = false;

  const begin = () => {
    if (!editing) {
      checkpoint();
      editing = true;
    }
  };
  const end = () => (editing = false);
  window.addEventListener('pointerup', end, true);

  const local = (c) => clamp(store.time - c.start, 0, c.duration);
  const refresh = () => refreshers.forEach((f) => f());

  // ---------- 控制元件 ----------
  function slider(label, o) {
    const step = o.step ?? 1;
    const range = h('input', { type: 'range', min: o.min, max: o.max, step });
    const num = h('input', { type: 'number', class: 'num', min: o.min, max: o.max, step });
    const fmt = (v) => +(+v).toFixed(step < 1 ? 2 : 0);
    const sync = () => {
      const v = o.get();
      if (document.activeElement !== range) range.value = v;
      if (document.activeElement !== num) num.value = fmt(v);
    };
    const apply = (v) => {
      begin();
      o.set(v);
      num.value = fmt(v);
      range.value = v;
      (o.after || (() => emit('props')))();
    };
    range.addEventListener('input', () => apply(+range.value));
    range.addEventListener('change', end);
    num.addEventListener('change', () => {
      apply(clamp(+num.value, o.hardMin ?? -1e9, o.hardMax ?? 1e9));
      end();
    });
    let kf = null;
    if (o.kf) {
      const [c, prop] = o.kf;
      kf = h('button', { class: 'kf', title: '在播放頭新增 / 移除關鍵影格', onclick: () => {
        checkpoint();
        toggleKey(c, prop, local(c));
        emit('layout');
        refresh();
      } }, '◆');
      refreshers.push(() => {
        kf.classList.toggle('has', hasKeys(c, prop));
        kf.classList.toggle('on', hasKeyAt(c, prop, local(c)));
      });
    }
    refreshers.push(sync);
    sync();
    return h('div', { class: 'row slider' }, h('label', {}, label), range, num, kf || h('span', { class: 'kf-sp' }));
  }
  function select(label, options, get, set) {
    const s = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = get();
    s.addEventListener('change', () => {
      checkpoint();
      set(s.value);
      emit('props');
    });
    return h('div', { class: 'row' }, h('label', {}, label), s);
  }
  function color(label, get, set) {
    const i = h('input', { type: 'color' });
    i.value = get();
    i.addEventListener('input', () => {
      begin();
      set(i.value);
      emit('props');
    });
    i.addEventListener('change', end);
    return h('div', { class: 'row' }, h('label', {}, label), i);
  }
  function check(label, get, set) {
    const i = h('input', { type: 'checkbox' });
    i.checked = get();
    i.addEventListener('change', () => {
      checkpoint();
      set(i.checked);
      emit('props');
    });
    return h('label', { class: 'row check' }, i, h('span', {}, label));
  }
  const group = (title, ...kids) => h('div', { class: 'group' }, title && h('div', { class: 'group-title' }, title), ...kids);
  const chips = (items) => h('div', { class: 'chips' }, items.map(([l, fn, on]) => h('button', { class: `chip${on ? ' on' : ''}`, onclick: fn }, l)));

  // ---------- 各分頁 ----------
  function frameTab(c) {
    const { width: W, height: H } = store.project;
    const T = (prop, label, min, max, step, scale = 1) => slider(label, {
      min, max, step, kf: [c, prop],
      get: () => getProp(c, prop, local(c)) * scale,
      set: (v) => setProp(c, prop, v / scale, local(c)),
    });
    const media = c.type === 'video' || c.type === 'image';
    return [
      group('位置與大小',
        T('x', 'X 位置', -W, W, 1),
        T('y', 'Y 位置', -H, H, 1),
        T('scale', '縮放 %', 1, 500, 1, 100),
        T('rotation', '旋轉 °', -360, 360, 1),
        T('opacity', '不透明 %', 0, 100, 1, 100),
        h('div', { class: 'hint' }, '◆ = 關鍵影格：移動播放頭、調整數值，就會自動做出動畫。也可以直接在預覽畫面拖曳、滾輪縮放。'),
        chips([
          ['置中', () => { checkpoint(); setProp(c, 'x', 0, local(c)); setProp(c, 'y', 0, local(c)); emit('props'); refresh(); }],
          ['重設', () => { checkpoint(); c.transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }; c.keyframes = {}; emit('layout'); build(); }],
          ['Ken Burns 推近', () => { checkpoint(); c.keyframes = { ...c.keyframes, scale: [{ t: 0, v: 1 }, { t: c.duration, v: 1.25 }] }; emit('layout'); refresh(); }],
          ['拉遠', () => { checkpoint(); c.keyframes = { ...c.keyframes, scale: [{ t: 0, v: 1.25 }, { t: c.duration, v: 1 }] }; emit('layout'); refresh(); }],
        ]),
      ),
      media && group('畫布',
        select('填滿方式', [['contain', '完整顯示'], ['cover', '填滿裁切'], ['fill', '拉伸']], () => c.fit, (v) => (c.fit = v)),
        check('模糊背景（直式影片必備）', () => c.bgBlur, (v) => (c.bgBlur = v)),
      ),
      media && group('裁切',
        ...[['t', '上'], ['b', '下'], ['l', '左'], ['r', '右']].map(([k, l]) => slider(`裁掉${l} %`, {
          min: 0, max: 45, step: 0.5, get: () => (c.crop?.[k] || 0) * 100, set: (v) => (c.crop = { ...c.crop, [k]: v / 100 }),
        })),
        chips([['取消裁切', () => { checkpoint(); c.crop = { l: 0, t: 0, r: 0, b: 0 }; emit('props'); refresh(); }]]),
      ),
      c.type === 'video' && group('影片工具',
        h('div', { class: 'tool-row' },
          h('button', { onclick: () => api.reverse(c) }, c.reversed ? '⇆ 取消倒放' : '⇆ 倒放'),
          h('button', { onclick: () => api.freeze(c, freezeDur) }, '⏸ 在播放頭定格'),
          (() => {
            const s = h('select', { title: '定格長度' }, [1, 2, 3, 5].map((v) => h('option', { value: v }, `${v} 秒`)));
            s.value = String(freezeDur);
            s.onchange = () => (freezeDur = +s.value);
            return s;
          })()),
        h('div', { class: 'hint' }, '倒放會在本機把這段影片倒過來重新編碼一份，完成後預覽與匯出都很流暢。'),
      ),
      trackGroup(c),
      group('其他',
        select('混合模式', BLEND_MODES, () => c.blend, (v) => (c.blend = v)),
        check('水平鏡像', () => c.effects.mirror, (v) => (c.effects.mirror = v)),
        check('垂直翻轉', () => c.effects.flipV, (v) => (c.effects.flipV = v)),
      ),
    ];
  }

  function colorTab(c) {
    const F = (k, label, min, max, step = 1) => slider(label, { min, max, step, get: () => c.filters[k], set: (v) => (c.filters[k] = v) });
    return [
      group('一鍵濾鏡', chips(FILTER_PRESETS.map((p, i) => [p.name, () => { api.applyFilterPreset(i); build(); }]))),
      group('調整',
        F('brightness', '亮度', 0, 200), F('contrast', '對比', 0, 200), F('saturate', '飽和度', 0, 300),
        F('hue', '色相', -180, 180), F('blur', '模糊', 0, 40, 0.5), F('grayscale', '黑白', 0, 100),
        F('sepia', '懷舊', 0, 100), F('invert', '反相', 0, 100),
        chips([['全部重設', () => { checkpoint(); c.filters = { ...FILTER_DEFAULT }; emit('props'); build(); }]]),
      ),
      ...gradeGroups(c),
    ];
  }

  // ---------- 專業調色：白平衡、色輪、曲線、LUT ----------
  function gradeGroups(c) {
    c.grade ||= GRADE_DEFAULT();
    const g = c.grade;
    const G = (k, label, min, max) => slider(label, { min, max, get: () => g[k], set: (v) => (g[k] = v) });
    return [
      group('白平衡', G('temp', '色溫', -100, 100), G('tint', '色調', -100, 100)),
      group('色輪',
        h('div', { class: 'wheels' }, colorWheel('暗部', g.lift), colorWheel('中間調', g.gamma), colorWheel('亮部', g.gain)),
        h('div', { class: 'hint' }, '拖曳圓點改變色偏，下方滑桿調亮度；雙擊圓盤重設。'),
      ),
      group('曲線', curvesEditor(g)),
      group('LUT 風格', ...lutControls(g)),
      chips([['重設專業調色', () => { checkpoint(); c.grade = GRADE_DEFAULT(); emit('props'); build(); }]]),
    ];
  }

  function colorWheel(label, w) {
    const dot = h('div', { class: 'wheel-dot' });
    const pad = h('div', { class: 'wheel', title: '雙擊重設' }, dot);
    const place = () => {
      dot.style.left = `${50 + w.x * 50}%`;
      dot.style.top = `${50 - w.y * 50}%`;
    };
    const setFrom = (e) => {
      const r = pad.getBoundingClientRect();
      let x = ((e.clientX - r.left) / r.width) * 2 - 1;
      let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const d = Math.hypot(x, y);
      if (d > 1) { x /= d; y /= d; }
      w.x = Math.round(x * 1000) / 1000;
      w.y = Math.round(y * 1000) / 1000;
      place();
      emit('props');
    };
    pad.addEventListener('pointerdown', (e) => { begin(); pad.setPointerCapture(e.pointerId); setFrom(e); });
    pad.addEventListener('pointermove', (e) => pad.hasPointerCapture(e.pointerId) && setFrom(e));
    pad.addEventListener('pointerup', end);
    pad.addEventListener('dblclick', () => { checkpoint(); w.x = w.y = w.l = 0; place(); lumIn.value = 0; emit('props'); });
    const lumIn = h('input', { type: 'range', min: -1, max: 1, step: 0.01, class: 'wheel-lum', title: '亮度' });
    lumIn.value = w.l;
    lumIn.addEventListener('input', () => { begin(); w.l = +lumIn.value; emit('props'); });
    lumIn.addEventListener('change', end);
    place();
    return h('div', { class: 'wheel-box' }, h('div', { class: 'wheel-label' }, label), pad, lumIn);
  }

  let curveCh = 'm';
  function curvesEditor(g) {
    const COLORS = { m: '#e5e7eb', r: '#f87171', g: '#4ade80', b: '#60a5fa' };
    const cv = h('canvas', { class: 'curves-cv' });
    const tabs = h('div', { class: 'chips' });
    const draw = () => {
      const S = (cv.width = cv.height = Math.round(cv.clientWidth * devicePixelRatio) || 400);
      const x = cv.getContext('2d');
      x.clearRect(0, 0, S, S);
      x.strokeStyle = '#2a2e38';
      x.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        x.beginPath(); x.moveTo((i * S) / 4, 0); x.lineTo((i * S) / 4, S); x.stroke();
        x.beginPath(); x.moveTo(0, (i * S) / 4); x.lineTo(S, (i * S) / 4); x.stroke();
      }
      x.strokeStyle = '#3a3f4b';
      x.beginPath(); x.moveTo(0, S); x.lineTo(S, 0); x.stroke();
      for (const ch of ['m', 'r', 'g', 'b']) {
        if (ch !== curveCh && (g.curves[ch].length === 2)) continue;
        const tbl = curveTable(g.curves[ch], 128);
        x.strokeStyle = COLORS[ch];
        x.globalAlpha = ch === curveCh ? 1 : 0.35;
        x.lineWidth = (ch === curveCh ? 2 : 1) * devicePixelRatio;
        x.beginPath();
        tbl.forEach((v, i) => (i ? x.lineTo((i / 127) * S, (1 - v) * S) : x.moveTo(0, (1 - v) * S)));
        x.stroke();
      }
      x.globalAlpha = 1;
      x.fillStyle = COLORS[curveCh];
      for (const [px, py] of g.curves[curveCh]) {
        x.beginPath();
        x.arc(px * S, (1 - py) * S, 5 * devicePixelRatio, 0, Math.PI * 2);
        x.fill();
      }
    };
    const renderTabs = () => {
      tabs.innerHTML = '';
      for (const [ch, l] of [['m', '主曲線'], ['r', '紅'], ['g', '綠'], ['b', '藍']]) {
        tabs.append(h('button', { class: `chip${ch === curveCh ? ' on' : ''}`, onclick: () => { curveCh = ch; renderTabs(); draw(); } }, l));
      }
      tabs.append(h('button', { class: 'chip', onclick: () => { checkpoint(); g.curves[curveCh] = [[0, 0], [1, 1]]; draw(); emit('props'); } }, '重設'));
      tabs.append(h('button', { class: 'chip', onclick: () => { checkpoint(); g.curves.m = [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]]; curveCh = 'm'; renderTabs(); draw(); emit('props'); } }, 'S 曲線'));
    };
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
    };
    const hit = (px, py) => g.curves[curveCh].findIndex(([x, y]) => Math.hypot((x - px) * cv.clientWidth, (y - py) * cv.clientHeight) < 10);
    let drag = -1;
    cv.addEventListener('pointerdown', (e) => {
      const [px, py] = pos(e);
      drag = hit(px, py);
      if (drag < 0) {
        // 點在空白處：直接新增一個點並開始拖曳
        checkpoint();
        g.curves[curveCh].push([px, py]);
        g.curves[curveCh].sort((a, b) => a[0] - b[0]);
        drag = g.curves[curveCh].findIndex((p) => p[0] === px);
      } else begin();
      cv.setPointerCapture(e.pointerId);
      draw();
      emit('props');
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const pts = g.curves[curveCh];
      const [px, py] = pos(e);
      const nx = drag === 0 ? 0 : drag === pts.length - 1 ? 1 : Math.min(pts[drag + 1][0] - 0.01, Math.max(pts[drag - 1][0] + 0.01, px));
      pts[drag] = [Math.round(nx * 1000) / 1000, Math.round(py * 1000) / 1000];
      draw();
      emit('props');
    });
    cv.addEventListener('pointerup', () => { drag = -1; end(); });
    cv.addEventListener('dblclick', (e) => {
      const i = hit(...pos(e));
      const pts = g.curves[curveCh];
      if (i > 0 && i < pts.length - 1) {
        checkpoint();
        pts.splice(i, 1);
        draw();
        emit('props');
      }
    });
    renderTabs();
    requestAnimationFrame(draw);
    return h('div', { class: 'curves-box' }, tabs, cv, h('div', { class: 'hint' }, '點一下新增控制點並拖曳，雙擊刪除。'));
  }

  function lutControls(g) {
    const sel = h('select', {},
      h('option', { value: '' }, '無'),
      h('optgroup', { label: '內建' }, Object.entries(BUILTIN_LUTS).map(([id, l]) => h('option', { value: id }, l.name))),
      store.luts.size ? h('optgroup', { label: '已匯入' }, [...store.luts.values()].map((l) => h('option', { value: l.id }, l.name))) : null);
    sel.value = g.lut || '';
    sel.addEventListener('change', () => { checkpoint(); g.lut = sel.value || null; emit('props'); });
    const file = h('input', { type: 'file', accept: '.cube', hidden: true, onchange: async () => {
      const f = file.files[0];
      if (!f) return;
      const [lut] = await importFiles([f]);
      if (!lut) return toast('LUT 檔案讀取失敗，請確認是 3D .cube 格式');
      checkpoint();
      g.lut = lut.id;
      emit('props');
      build();
      toast(`已匯入 LUT「${lut.name}」`);
    } });
    return [
      h('div', { class: 'row' }, h('label', {}, 'LUT'), sel),
      slider('強度 %', { min: 0, max: 100, get: () => (g.lutMix ?? 1) * 100, set: (v) => (g.lutMix = v / 100) }),
      h('div', { class: 'tool-row' }, h('button', { onclick: () => file.click() }, '匯入 .cube LUT'), file),
    ];
  }

  function fxTab(c) {
    const E = (k, label, min, max, step = 1) => slider(label, { min, max, step, get: () => c.effects[k], set: (v) => (c.effects[k] = v) });
    const media = c.type === 'video' || c.type === 'image';
    return [
      group('風格特效',
        E('vignette', '暗角', 0, 100), E('grain', '底片顆粒', 0, 100), E('pixelate', '馬賽克', 0, 60),
        E('glitch', '故障', 0, 100), E('rgb', 'RGB 分離', 0, 40),
        chips([['全部重設', () => { checkpoint(); c.effects = { ...EFFECT_DEFAULT, mirror: c.effects.mirror, flipV: c.effects.flipV }; emit('props'); build(); }]]),
      ),
      media && group('AI 去背（不需綠幕）',
        check('啟用 AI 人像去背', () => c.aiMatte?.on, (v) => {
          c.aiMatte = { ...(c.aiMatte || {}), on: v };
          if (v) api.loadMatte();
        }),
        slider('主體範圍', { min: 0.2, max: 0.8, step: 0.01, get: () => c.aiMatte?.threshold ?? 0.5, set: (v) => (c.aiMatte = { ...c.aiMatte, threshold: v }) }),
        slider('邊緣柔化', { min: 0, max: 20, step: 0.5, get: () => c.aiMatte?.feather ?? 2, set: (v) => (c.aiMatte = { ...c.aiMatte, feather: v }) }),
        h('div', { class: 'hint' }, '在你的電腦上逐格辨識人物並去掉背景（MediaPipe 人像分割，第一次使用會下載約 250 KB 模型）。可搭配下層軌道放新背景。'),
      ),
      media && group('綠幕去背',
        check('啟用色度去背', () => c.chroma.on, (v) => (c.chroma.on = v)),
        color('去除顏色', () => c.chroma.color, (v) => (c.chroma.color = v)),
        chips([['綠幕', () => { checkpoint(); c.chroma.color = '#00ff00'; c.chroma.on = true; build(); }], ['藍幕', () => { checkpoint(); c.chroma.color = '#0047bb'; c.chroma.on = true; build(); }]]),
        slider('相似度', { min: 0, max: 1, step: 0.01, get: () => c.chroma.similarity, set: (v) => (c.chroma.similarity = v) }),
        slider('邊緣柔化', { min: 0, max: 0.5, step: 0.01, get: () => c.chroma.smoothness, set: (v) => (c.chroma.smoothness = v) }),
      ),
    ];
  }

  // ---------- 遮罩 ----------
  const MASK_TYPES = [['none', '無'], ['rect', '矩形'], ['ellipse', '圓形'], ['linear', '線性'], ['band', '鏡面'], ['heart', '愛心'], ['star', '星形']];
  function maskTab(c) {
    c.mask ||= { type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 20, radius: 0, invert: false };
    const k = c.mask;
    const K = (key, label, min, max, step = 1, scale = 1) => slider(label, { min, max, step, get: () => k[key] * scale, set: (v) => (k[key] = v / scale) });
    const on = k.type !== 'none';
    return [
      group('遮罩形狀', chips(MASK_TYPES.map(([id, l]) => [l, () => { checkpoint(); k.type = id; emit('props'); build(); }, k.type === id]))),
      on && group('位置與大小',
        K('x', '水平位置 %', -100, 100, 1, 100),
        K('y', '垂直位置 %', -100, 100, 1, 100),
        k.type !== 'linear' && K('w', '寬度 %', 5, 200, 1, 100),
        k.type !== 'linear' && K('h', k.type === 'band' ? '帶寬 %' : '高度 %', 5, 200, 1, 100),
        K('rot', '旋轉 °', -180, 180),
        k.type === 'rect' && K('radius', '圓角 %', 0, 100, 1, 100),
      ),
      on && group('邊緣',
        K('feather', '羽化 px', 0, 200),
        check('反轉（保留形狀外面）', () => k.invert, (v) => (k.invert = v)),
        h('div', { class: 'hint' }, '遮罩會跟著片段一起移動、縮放與旋轉。'),
      ),
    ];
  }

  // ---------- 運動追蹤 ----------
  const trackOpts = { video: null, size: 100 };
  function trackGroup(c) {
    const vids = store.project.clips.filter((o) => o.type === 'video' && o.id !== c.id && o.start < c.start + c.duration && o.start + o.duration > c.start);
    if (!vids.length) return group('運動追蹤', h('div', { class: 'hint' }, '這個片段的時間範圍內沒有其他影片可以追蹤。'));
    if (!vids.some((v) => v.id === trackOpts.video)) trackOpts.video = vids[0].id;
    const sel = h('select', {}, vids.map((v) => h('option', { value: v.id }, `${fmtTime(v.start).slice(0, 5)} ${store.media.get(v.mediaId)?.name || '影片'}`)));
    sel.value = trackOpts.video;
    sel.onchange = () => (trackOpts.video = sel.value);
    return group('運動追蹤',
      h('div', { class: 'hint' }, '1. 播放頭停在要開始追的畫面　2. 把這個片段移到要追的物體上　3. 按「開始追蹤」，位置會自動寫成關鍵影格。'),
      h('div', { class: 'row' }, h('label', {}, '追蹤影片'), sel),
      slider('追蹤框 px', { min: 30, max: 400, get: () => trackOpts.size, set: (v) => (trackOpts.size = v), after: () => {} }),
      h('div', { class: 'tool-row' },
        h('button', { class: 'primary', onclick: () => api.track(c, trackOpts.video, trackOpts.size) }, '⌖ 開始追蹤'),
        h('button', { onclick: () => {
          checkpoint();
          const lt = clamp(store.time - c.start, 0, c.duration);
          for (const p of ['x', 'y']) {
            if (!c.keyframes?.[p]) continue;
            c.transform[p] = getProp(c, p, lt);
            delete c.keyframes[p];
          }
          emit('layout');
          refresh();
        } }, '清除位置關鍵影格')),
    );
  }

  function animTab(c) {
    const part = (key, title) => group(title,
      select('效果', TRANSITIONS, () => c[key].type, (v) => { c[key].type = v; emit('layout'); }),
      slider('時長 秒', { min: 0.1, max: Math.max(0.2, Math.min(5, c.duration)), step: 0.05, get: () => c[key].dur, set: (v) => (c[key].dur = v), after: () => emit('layout') }),
    );
    return [part('transIn', '入場動畫'), part('transOut', '出場動畫'),
      h('div', { class: 'hint' }, '更多樣式在左側「轉場」分頁，一鍵套用。')];
  }

  function audioTab(c) {
    return [
      group('音量',
        slider('音量 %', { min: 0, max: 300, get: () => c.volume * 100, set: (v) => (c.volume = v / 100), after: () => emit('layout') }),
        check('靜音此片段', () => c.mute, (v) => { c.mute = v; emit('layout'); }),
        slider('淡入 秒', { min: 0, max: Math.min(10, c.duration), step: 0.1, get: () => c.fadeIn, set: (v) => (c.fadeIn = v) }),
        slider('淡出 秒', { min: 0, max: Math.min(10, c.duration), step: 0.1, get: () => c.fadeOut, set: (v) => (c.fadeOut = v) }),
      ),
      voiceGroup(c),
      speedGroup(c),
      beatGroup(c),
      silenceGroup(c),
    ];
  }

  // 人聲增強
  const voiceOpts = { denoise: true, strength: 1, eq: true, norm: true };
  function voiceGroup(c) {
    if (c.enhanced) {
      return group('人聲增強',
        h('div', { class: 'hint' }, '這個片段已套用人聲增強（降噪、EQ、音量標準化）。'),
        h('div', { class: 'tool-row' }, h('button', { onclick: () => { restoreVoice(c); toast('已還原原始聲音'); } }, '還原原始聲音')));
    }
    return group('人聲增強',
      check('AI 降噪（RNNoise）', () => voiceOpts.denoise, (v) => (voiceOpts.denoise = v)),
      slider('降噪強度 %', { min: 0, max: 100, get: () => voiceOpts.strength * 100, set: (v) => (voiceOpts.strength = v / 100), after: () => {} }),
      check('人聲 EQ 與壓縮（更清楚、更飽滿）', () => voiceOpts.eq, (v) => (voiceOpts.eq = v)),
      check('音量標準化', () => voiceOpts.norm, (v) => (voiceOpts.norm = v)),
      h('div', { class: 'tool-row' }, h('button', { class: 'primary', onclick: () => api.enhance(c, { ...voiceOpts }) }, '✨ 增強人聲')),
      h('div', { class: 'hint' }, c.type === 'video' ? '會把處理後的聲音放成獨立音軌，原影片自動靜音。全部在本機處理。' : '處理後可隨時還原。全部在本機處理。'),
    );
  }

  // 節拍偵測與一鍵卡點
  const beatOpts = { every: 1, downbeats: false, track: null };
  function beatGroup(c) {
    const m = store.media.get(c.mediaId);
    const b = m?.beats;
    const status = h('div', { class: 'hint' }, b ? `偵測到約 ${b.bpm} BPM，${b.beats.length} 拍（黃色刻度）。拖曳片段時會自動吸附到節拍。` : '偵測音樂的節拍，時間軸上會標出每一拍，也能一鍵讓畫面跟著節拍切換。');
    const detect = h('button', { onclick: async () => {
      detect.disabled = true;
      detect.textContent = '分析中…';
      try {
        await analyzeBeats(c);
      } catch (e) {
        status.textContent = '失敗：' + e.message;
      }
      build();
    } }, b ? '重新偵測' : '♪ 偵測節拍');
    if (!b) return group('節拍', detect, status);
    const visualTracks = store.project.tracks.filter((t) => store.project.clips.some((o) => o.trackId === t.id && (o.type === 'video' || o.type === 'image')));
    if (!visualTracks.some((t) => t.id === beatOpts.track)) beatOpts.track = visualTracks[0]?.id || null;
    const trackSel = h('select', {}, visualTracks.map((t) => h('option', { value: t.id }, t.name)));
    trackSel.value = beatOpts.track || '';
    trackSel.onchange = () => (beatOpts.track = trackSel.value);
    const density = h('select', {}, [['1', '每一拍'], ['2', '每 2 拍'], ['4', '每 4 拍'], ['down', '只用重拍（每小節）']].map(([v, l]) => h('option', { value: v }, l)));
    density.value = beatOpts.downbeats ? 'down' : String(beatOpts.every);
    density.onchange = () => {
      beatOpts.downbeats = density.value === 'down';
      beatOpts.every = beatOpts.downbeats ? 1 : +density.value;
    };
    return group('節拍',
      status,
      h('div', { class: 'row' }, h('label', {}, '切換頻率'), density),
      h('div', { class: 'row' }, h('label', {}, '畫面軌道'), visualTracks.length ? trackSel : h('span', { class: 'dim' }, '沒有影片或圖片')),
      h('div', { class: 'tool-row' },
        h('button', { class: 'primary', disabled: !visualTracks.length, onclick: () => {
          try {
            const n = beatSync(c, beatOpts.track, beatOpts);
            toast(`已把 ${n} 個片段對齊到節拍`);
          } catch (e) {
            toast(e.message);
          }
        } }, '⚡ 一鍵卡點'),
        detect),
    );
  }

  // 自動剪掉靜音
  const silenceOpts = { db: -40, minDur: 0.5 };
  function silenceGroup(c) {
    const result = h('div', { class: 'hint' }, '找出沒有聲音的段落並剪掉，後面的片段自動往前補（口播、Vlog 適用）。');
    let found = null;
    const apply = h('button', { class: 'primary', disabled: true, onclick: () => {
      const sec = removeSilences(c, found);
      toast(`已剪掉 ${found.length} 段靜音，共 ${sec.toFixed(1)} 秒（可按 Ctrl+Z 復原）`);
    } }, '✂ 剪掉這些靜音');
    const analyze = () => {
      try {
        found = findSilences(c, silenceOpts);
        const total = found.reduce((s, [a, b]) => s + b - a, 0);
        result.textContent = found.length ? `找到 ${found.length} 段靜音，共 ${total.toFixed(1)} 秒。` : '沒有找到符合條件的靜音段落。';
        apply.disabled = !found.length;
      } catch (e) {
        result.textContent = e.message;
      }
    };
    return group('自動剪掉靜音',
      slider('音量門檻 dB', { min: -60, max: -15, step: 1, get: () => silenceOpts.db, set: (v) => (silenceOpts.db = v), after: analyze }),
      slider('最短靜音 秒', { min: 0.2, max: 3, step: 0.1, get: () => silenceOpts.minDur, set: (v) => (silenceOpts.minDur = v), after: analyze }),
      h('div', { class: 'tool-row' }, h('button', { onclick: analyze }, '分析'), apply),
      result,
    );
  }

  // 變速後保持用到的素材長度不變，重新算片段時長
  function retime(c, mutate) {
    const L = srcLength(c);
    mutate();
    c.duration = Math.max(0.1, L / avgSpeed(c));
    const m = store.media.get(c.mediaId);
    if (m && isFinite(m.duration)) c.duration = Math.min(c.duration, (m.duration - c.in) / avgSpeed(c));
  }

  function speedGroup(c) {
    const curved = hasCurve(c);
    return group('變速',
      chips([
        ['固定速度', () => { checkpoint(); retime(c, () => (c.curve = null)); emit('layout'); build(); }, !curved],
        ...CURVE_PRESETS.map((p) => [p.name, () => {
          checkpoint();
          retime(c, () => (c.curve = { id: p.id, pts: p.pts.map((q) => [...q]) }));
          emit('layout');
          build();
        }, c.curve?.id === p.id]),
      ]),
      curved
        ? curveEditor(c)
        : [
          slider('速度 ×', { min: 0.1, max: 8, step: 0.05, hardMin: 0.1, hardMax: 16, get: () => c.speed, set: (v) => retime(c, () => (c.speed = v)), after: () => emit('layout') }),
          chips([0.25, 0.5, 1, 1.5, 2, 4].map((v) => [`${v}×`, () => { checkpoint(); retime(c, () => (c.speed = v)); emit('layout'); build(); }, c.speed === v])),
        ],
      check(curved ? '保持音高（僅預覽；曲線變速匯出時音高會隨速度變化）' : '保持音高（變速不變調）', () => c.keepPitch, (v) => (c.keepPitch = v)),
    );
  }

  // 曲線變速編輯器：拖曳控制點調整速度（縱軸為 0.1×–10× 對數刻度），雙擊新增 / 刪除控制點
  function curveEditor(c) {
    const cv = h('canvas', { class: 'curve-cv', height: 130 });
    const info = h('div', { class: 'hint' });
    const yOf = (v, H) => H - ((Math.log10(v) + 1) / 2) * H;
    const vOf = (y, H) => Math.pow(10, (1 - y / H) * 2 - 1);
    const draw = () => {
      const W = (cv.width = cv.clientWidth * devicePixelRatio || 560);
      const H = (cv.height = 130 * devicePixelRatio);
      const g = cv.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.strokeStyle = '#2a2e38';
      g.fillStyle = '#7d8494';
      g.font = `${10 * devicePixelRatio}px system-ui`;
      for (const v of [0.1, 0.5, 1, 2, 5, 10]) {
        const y = yOf(v, H);
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        g.fillText(`${v}×`, 3, Math.min(H - 2, Math.max(10, y - 2)));
      }
      // 播放頭位置
      const px = ((store.time - c.start) / c.duration) * W;
      if (px >= 0 && px <= W) {
        g.fillStyle = '#f43f5e';
        g.fillRect(px, 0, 1.5, H);
      }
      g.strokeStyle = '#22d3ee';
      g.lineWidth = 2 * devicePixelRatio;
      g.beginPath();
      c.curve.pts.forEach(([x, v], i) => (i ? g.lineTo(x * W, yOf(v, H)) : g.moveTo(x * W, yOf(v, H))));
      g.stroke();
      g.fillStyle = '#fff';
      for (const [x, v] of c.curve.pts) {
        g.beginPath();
        g.arc(x * W, yOf(v, H), 5 * devicePixelRatio, 0, Math.PI * 2);
        g.fill();
      }
      info.textContent = `片段長度 ${c.duration.toFixed(2)} 秒・平均速度 ${avgSpeed(c).toFixed(2)}×　（拖曳控制點調整，雙擊新增 / 刪除）`;
    };
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, ((e.clientY - r.top) / r.height) * cv.height];
    };
    const hit = (x, y) => c.curve.pts.findIndex(([px, v]) => Math.abs(px - x) * cv.clientWidth < 10 && Math.abs(yOf(v, cv.height) - y) < 12 * devicePixelRatio);
    let drag = -1;
    let L0 = 0;
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      drag = hit(x, y);
      if (drag < 0) return;
      checkpoint();
      L0 = srcLength(c);
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const [x, y] = pos(e);
      const pts = c.curve.pts;
      const v = Math.min(10, Math.max(0.1, vOf(Math.min(cv.height, Math.max(0, y)), cv.height)));
      const nx = drag === 0 ? 0 : drag === pts.length - 1 ? 1 : Math.min(pts[drag + 1][0] - 0.02, Math.max(pts[drag - 1][0] + 0.02, x));
      pts[drag] = [nx, Math.round(v * 100) / 100];
      c.curve.id = 'custom';
      c.duration = Math.max(0.1, L0 / avgSpeed(c));
      draw();
      emit('layout');
    });
    cv.addEventListener('pointerup', () => (drag = -1));
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e);
      const i = hit(x, y);
      const pts = c.curve.pts;
      checkpoint();
      retime(c, () => {
        if (i > 0 && i < pts.length - 1) pts.splice(i, 1);
        else if (i < 0) {
          pts.push([x, Math.min(10, Math.max(0.1, vOf(y, cv.height)))]);
          pts.sort((a, b) => a[0] - b[0]);
        }
        c.curve.id = 'custom';
      });
      draw();
      emit('layout');
    });
    refreshers.push(draw);
    requestAnimationFrame(draw);
    return h('div', { class: 'curve-box' }, cv, info);
  }

  function textTab(c) {
    const s = c.text;
    const ta = h('textarea', { rows: 3, spellcheck: false });
    ta.value = s.content;
    ta.addEventListener('input', () => { begin(); s.content = ta.value; emit('props'); });
    ta.addEventListener('change', () => { end(); emit('layout'); });
    const S = (k, label, min, max, step = 1) => slider(label, { min, max, step, get: () => s[k], set: (v) => (s[k] = v) });
    return [
      group('內容', ta),
      group('字型',
        select('字體', FONTS.map((f) => [f, f]), () => s.font, (v) => (s.font = v)),
        S('size', '大小', 8, 400),
        select('粗細', [['400', '一般'], ['700', '粗體'], ['900', '特粗']], () => s.weight, (v) => (s.weight = v)),
        check('斜體', () => s.italic, (v) => (s.italic = v)),
        select('對齊', [['center', '置中'], ['left', '靠左'], ['right', '靠右']], () => s.align, (v) => (s.align = v)),
        S('letterSpacing', '字距', -20, 80), S('lineHeight', '行高', 0.6, 3, 0.05),
      ),
      group('顏色',
        color('文字顏色', () => s.color, (v) => (s.color = v)),
        check('漸層', () => s.gradient, (v) => (s.gradient = v)),
        color('漸層第二色', () => s.color2, (v) => (s.color2 = v)),
      ),
      group('描邊 / 陰影 / 底框',
        S('stroke', '描邊', 0, 30), color('描邊色', () => s.strokeColor, (v) => (s.strokeColor = v)),
        S('shadow', '陰影/發光', 0, 100), color('陰影色', () => s.shadowColor, (v) => (s.shadowColor = v)),
        check('底框', () => s.bg, (v) => (s.bg = v)), color('底框色', () => s.bgColor, (v) => (s.bgColor = v)),
        slider('底框透明', { min: 0, max: 100, get: () => s.bgOpacity * 100, set: (v) => (s.bgOpacity = v / 100) }),
      ),
      group('文字動畫', select('持續效果', TEXT_ANIMS, () => s.anim, (v) => (s.anim = v))),
      group('朗讀（文字轉語音）',
        select('聲音', VOICES.map((v) => [v.id, v.name]), () => ttsPrefs.voice, (v) => (ttsPrefs.voice = v)),
        slider('語速 ×', { min: 0.6, max: 1.6, step: 0.05, get: () => ttsPrefs.speed, set: (v) => (ttsPrefs.speed = v), after: () => {} }),
        h('div', { class: 'tool-row' }, h('button', { class: 'primary', onclick: () => api.speakText(c, ttsPrefs.voice, ttsPrefs.speed) }, '🔊 念出這段文字')),
        h('div', { class: 'hint' }, '在本機合成語音，放在同一時間點的「配音」軌。中文用 Piper，英文用 Kokoro；第一次使用會下載語音模型。'),
      ),
    ];
  }

  function shapeTab(c) {
    const s = c.shape;
    const S = (k, label, min, max) => slider(label, { min, max, get: () => s[k], set: (v) => (s[k] = v) });
    return [group('形狀',
      select('種類', [['rect', '矩形'], ['circle', '圓形 / 橢圓'], ['solid', '純色背景'], ['gradient', '漸層背景'], ['letterbox', '電影黑邊']], () => s.kind, (v) => { s.kind = v; emit('layout'); build(); }),
      color('顏色', () => s.color, (v) => (s.color = v)),
      (s.kind === 'gradient') && color('第二色', () => s.color2, (v) => (s.color2 = v)),
      (s.kind === 'rect' || s.kind === 'circle') && S('w', '寬', 2, 4000),
      (s.kind !== 'solid' && s.kind !== 'gradient') && S('h', s.kind === 'letterbox' ? '黑邊高度' : '高', 2, 4000),
      s.kind === 'rect' && S('radius', '圓角', 0, 500),
    )];
  }

  // ---------- 主體 ----------
  function header(c) {
    const m = store.media.get(c.mediaId);
    const dur = h('input', { type: 'number', class: 'num wide', min: 0.1, step: 0.1, value: +c.duration.toFixed(2) });
    dur.addEventListener('change', () => {
      let v = Math.max(0.1, +dur.value || 0.1);
      if (m && isFinite(m.duration) && c.type !== 'image') v = Math.min(v, (m.duration - c.in) / avgSpeed(c));
      checkpoint();
      c.duration = v;
      emit('layout');
      build();
    });
    return h('div', { class: 'insp-head' },
      h('div', { class: 'insp-title' }, h('span', { class: `dot t-${c.type}` }), TYPE_NAME[c.type], h('span', { class: 'dim ellipsis' }, m ? ` · ${m.name}` : '')),
      h('div', { class: 'insp-meta' },
        h('span', {}, `開始 ${fmtTime(c.start)}`),
        h('label', {}, '時長 ', dur, ' 秒')),
      h('div', { class: 'insp-actions' },
        h('button', { onclick: () => api.split() }, '✂ 分割'),
        h('button', { onclick: () => api.duplicate() }, '⧉ 複製'),
        c.type === 'video' && h('button', { onclick: () => api.detach() }, '🎵 分離音訊'),
        h('button', { class: 'danger', onclick: () => api.remove() }, '🗑 刪除')),
    );
  }

  function projectPanel() {
    const p = store.project;
    const setSize = (w, hgt) => {
      checkpoint();
      p.width = w;
      p.height = hgt;
      emit('project');
    };
    root.append(
      h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, '專案設定'), h('div', { class: 'dim' }, '在時間軸點選片段即可編輯它的屬性')),
      group('畫面比例',
        h('div', { class: 'aspect-grid' }, ASPECTS.map(([l, w, hgt]) => h('button', { class: `aspect${p.width === w && p.height === hgt ? ' on' : ''}`, onclick: () => setSize(w, hgt) },
          h('span', { class: 'box', style: `aspect-ratio:${w}/${hgt}` }), l))),
        h('div', { class: 'dim' }, `目前 ${p.width} × ${p.height}`),
      ),
      group('輸出',
        select('影格率', [[24, '24 fps 電影'], [25, '25 fps'], [30, '30 fps'], [60, '60 fps 流暢']], () => p.fps, (v) => (p.fps = +v)),
        color('背景色', () => p.bg, (v) => (p.bg = v)),
      ),
      group('專案檔',
        h('div', { class: 'tool-row' },
          h('button', { onclick: () => api.exportProject() }, '⬇ 匯出專案檔'),
          h('button', { onclick: () => api.importProject() }, '📂 開啟專案檔')),
        h('div', { class: 'hint' }, '專案檔（.ezicut）包含時間軸與用到的所有素材、LUT，可以備份或換一台電腦繼續剪。'),
      ),
      group('快捷鍵', h('div', { class: 'keys' }, [
        ['空白鍵', '播放 / 暫停'], ['S', '在播放頭分割'], ['Delete', '刪除片段'], ['Ctrl+Z / Ctrl+Shift+Z', '復原 / 重做'],
        ['Ctrl+D', '複製片段'], ['Ctrl+C / Ctrl+V', '複製 / 貼上'], ['← →', '前後一格（Shift = 1 秒）'],
        ['Home / End', '開頭 / 結尾'], ['+ / -', '時間軸縮放'], ['Ctrl+滾輪', '時間軸縮放'], ['Esc', '取消選取'],
      ].map(([k, d]) => h('div', { class: 'key' }, h('kbd', {}, k), h('span', {}, d))))),
    );
  }

  function build() {
    refreshers = [];
    root.innerHTML = '';
    const c = selected();
    if (!c) return projectPanel();
    const tabs = TABS_BY_TYPE[c.type];
    let tab = tabFor[c.type];
    if (!tabs.some(([id]) => id === tab)) tab = tabs[0][0];
    root.append(header(c));
    root.append(h('div', { class: 'insp-tabs' }, tabs.map(([id, l]) => h('button', { class: `insp-tab${id === tab ? ' on' : ''}`, onclick: () => { tabFor[c.type] = id; build(); } }, l))));
    const content = { frame: frameTab, color: colorTab, fx: fxTab, mask: maskTab, anim: animTab, audio: audioTab, text: textTab, shape: shapeTab }[tab](c);
    root.append(h('div', { class: 'insp-body' }, content.flat()));
    if (c.type === 'video' && tab === 'frame') root.querySelector('.insp-body').append(speedGroup(c));
  }

  let lastRefresh = 0;
  on('select', build);
  on('project', build);
  on('props', refresh);
  on('time', () => {
    const now = performance.now();
    if (now - lastRefresh > 100) {
      lastRefresh = now;
      refresh();
    }
  });
  build();
  return { build };
}
