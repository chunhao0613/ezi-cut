// 匯出對話框：影片 / 只要聲音 / GIF / 圖片序列 / 單張畫面，含平台預設與各種格式選項
import { h, openModal, fmtTime, toast } from './ui.js';
import { store, selected, projectDuration } from './state.js';
import { CONTAINERS, AUDIO_FORMATS, VIDEO_CODEC_NAMES, AUDIO_CODEC_NAMES, QUALITY_NAMES, probeCodecs, exportMedia } from './exporter.js';

const KINDS = [['video', '🎬 影片'], ['audio', '🎵 只要聲音'], ['gif', '🖼 GIF 動圖'], ['images', '🗂 圖片序列'], ['still', '📷 單張畫面']];
const RES = [[2160, '4K'], [1440, '2K'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']];
const FPS = [23.976, 24, 25, 29.97, 30, 50, 60];
const PRESETS = [
  { name: 'YouTube 1080p', o: { kind: 'video', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', res: 1080, quality: 'high' } },
  { name: 'YouTube 4K', o: { kind: 'video', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', res: 2160, quality: 'veryHigh' } },
  { name: 'TikTok / Reels / Shorts', o: { kind: 'video', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', res: 1080, fps: 30, quality: 'high' }, note: '這些平台以 9:16 直式為主，建議專案比例設成 9:16。' },
  { name: 'Instagram 貼文', o: { kind: 'video', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', res: 1080, fps: 30, quality: 'high' } },
  { name: 'LINE / Discord 小檔', o: { kind: 'video', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', res: 720, fps: 30, quality: 'medium' } },
  { name: '剪輯交換 MOV', o: { kind: 'video', container: 'mov', videoCodec: 'avc', audioCodec: 'pcm-s16', res: 'orig', quality: 'custom', mbps: 50 }, note: '高位元率 H.264 + 無損聲音，適合再匯入 Premiere / Final Cut / DaVinci。' },
  { name: '網頁 WebM', o: { kind: 'video', container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', res: 1080, quality: 'high' } },
  { name: 'Podcast MP3', o: { kind: 'audio', audioFormat: 'mp3', abr: 192 } },
  { name: '無損 WAV', o: { kind: 'audio', audioFormat: 'wav' } },
  { name: '貼圖 GIF', o: { kind: 'gif', gifWidth: 480, gifFps: 15 } },
];

const DEFAULTS = {
  kind: 'video', container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', res: 'orig', customW: 1280, fps: 0, quality: 'high', mbps: 16,
  abr: 192, audioFormat: 'mp3', includeAudio: true, range: 'all', r0: 0, r1: 0, gifWidth: 480, gifFps: 15, imgFps: 0, imageFormat: 'png',
};
const KEY = 'novacut.exportPrefs';
function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function savePrefs(st) {
  try {
    const { r0, r1, ...keep } = st;
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* 無痕模式等情況無法儲存，不影響匯出 */
  }
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const fmtMB = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`);

export async function openExportDialog({ pause, download, setExporting }) {
  const dur = projectDuration();
  if (dur <= 0) return toast('時間軸是空的，沒有東西可以匯出');
  pause();
  const P = store.project;
  const st = loadPrefs();
  if (!st.fps) st.fps = P.fps;
  st.r0 = 0;
  st.r1 = +dur.toFixed(2);
  let probe = null;
  let presetNote = '';
  let running = false;
  const ctrl = new AbortController();

  const dims = (res = st.res) => {
    if (res === 'orig') return [P.width, P.height];
    if (res === 'custom') return [even(st.customW), even((st.customW * P.height) / P.width)];
    const k = res / Math.min(P.width, P.height);
    return [even(P.width * k), even(P.height * k)];
  };
  const range = () => {
    if (st.range === 'sel') {
      const c = selected();
      if (c) return [c.start, Math.min(dur, c.start + c.duration)];
    }
    if (st.range === 'from') return [Math.min(store.time, dur - 0.1), dur];
    if (st.range === 'custom') return [Math.max(0, Math.min(st.r0, dur - 0.1)), Math.min(dur, Math.max(st.r1, st.r0 + 0.1))];
    return [0, dur];
  };
  const videoCodecs = () => CONTAINERS[st.container].video.filter((c) => probe?.v[c]);
  const audioCodecs = () => CONTAINERS[st.container].audio.filter((c) => probe?.a[c]);
  const audioFormats = () => Object.entries(AUDIO_FORMATS).filter(([, d]) => probe?.a[d.codec]);
  // 選項不在這個容器支援的清單裡就換成第一個可用的
  const fix = () => {
    const vc = videoCodecs();
    if (vc.length && !vc.includes(st.videoCodec)) st.videoCodec = vc[0];
    const ac = audioCodecs();
    if (ac.length && !ac.includes(st.audioCodec)) st.audioCodec = ac[0];
    const af = audioFormats().map(([k]) => k);
    if (af.length && !af.includes(st.audioFormat)) st.audioFormat = af[0];
  };

  function estimate() {
    const [t0, t1] = range();
    const d = t1 - t0;
    const audioBits = (codec) => ({ 'pcm-s16': 1536e3, 'pcm-s24': 2304e3, flac: 900e3 }[codec] || st.abr * 1000) * d;
    if (st.kind === 'video') {
      const [w, hh] = dims();
      const bpp = { low: 0.05, medium: 0.08, high: 0.12, veryHigh: 0.2 }[st.quality] || 0.12;
      const f = { avc: 1, hevc: 0.6, av1: 0.5, vp9: 0.65, vp8: 1.1 }[st.videoCodec] || 1;
      const vbits = st.quality === 'custom' ? st.mbps * 1e6 * d : bpp * f * w * hh * st.fps * d;
      return (vbits + (st.includeAudio ? audioBits(st.audioCodec) : 0)) / 8;
    }
    if (st.kind === 'audio') return audioBits(AUDIO_FORMATS[st.audioFormat].codec) / 8;
    if (st.kind === 'gif') {
      const w = st.gifWidth === 'orig' ? P.width : Math.min(st.gifWidth, P.width);
      return w * ((w * P.height) / P.width) * st.gifFps * d * 0.12;
    }
    if (st.kind === 'images') {
      const [w, hh] = dims();
      return w * hh * (st.imageFormat === 'png' ? 1.2 : 0.25) * (st.imgFps || P.fps) * d;
    }
    const [w, hh] = dims();
    return w * hh * (st.imageFormat === 'png' ? 1.2 : 0.25);
  }

  const body = h('div', { class: 'xp-body' });
  const bar = h('div', { class: 'bar' });
  const status = h('div', { class: 'dim small' });
  const goBtn = h('button', { class: 'primary' }, '開始匯出');
  const cancelBtn = h('button', {}, '取消');

  const sel = (label, options, key, after) => {
    const s = h('select', { disabled: running }, options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = String(st[key]);
    s.onchange = () => {
      const raw = s.value;
      st[key] = raw !== '' && !isNaN(+raw) && typeof options[0][0] === 'number' ? +raw : raw;
      presetNote = '';
      after?.();
      render();
    };
    return h('div', { class: 'row' }, h('label', {}, label), s);
  };
  const num = (label, key, { min, max, step = 1, unit = '' } = {}) => {
    const i = h('input', { type: 'number', class: 'num', min, max, step, value: st[key], disabled: running });
    i.onchange = () => {
      st[key] = Math.min(max ?? 1e9, Math.max(min ?? -1e9, +i.value || 0));
      render();
    };
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'tool-row' }, i, unit && h('span', { class: 'dim' }, unit)));
  };

  function rangeRows() {
    const c = selected();
    const rows = [sel('範圍', [['all', `整個專案（${fmtTime(dur)}）`], ['sel', c ? `選取的片段（${fmtTime(c.duration)}）` : '選取的片段（目前沒有選取）'], ['from', `從播放頭到結尾（${fmtTime(store.time)} 起）`], ['custom', '自訂起訖時間']], 'range')];
    if (st.range === 'custom') rows.push(num('開始（秒）', 'r0', { min: 0, max: dur, step: 0.1 }), num('結束（秒）', 'r1', { min: 0, max: dur, step: 0.1 }));
    return rows;
  }
  const resOptions = () => [['orig', `原始（${P.width}×${P.height}）`], ...RES.map(([v, l]) => [v, `${l}（${dims(v).join('×')}）`]), ['custom', '自訂寬度']];

  // 條件不成立的選項列（false / 空字串）不要放進畫面
  const add = (...xs) => body.append(...xs.flat().filter(Boolean));
  function render() {
    fix();
    body.innerHTML = '';
    add(
      h('div', { class: 'chips' }, PRESETS.map((p) => h('button', { class: 'chip', disabled: running, onclick: () => {
        Object.assign(st, { res: 'orig', fps: P.fps, quality: 'high', includeAudio: true }, p.o);
        presetNote = p.note || '';
        render();
      } }, p.name))),
      presetNote && h('div', { class: 'hint' }, presetNote),
      h('div', { class: 'xp-kinds' }, KINDS.map(([k, l]) => h('button', { class: `insp-tab${st.kind === k ? ' on' : ''}`, disabled: running, onclick: () => { st.kind = k; render(); } }, l))),
    );
    if (!probe) {
      add(h('div', { class: 'dim' }, '正在檢查這台電腦支援的編碼格式…'));
      return;
    }
    if (st.kind === 'video') {
      const vc = videoCodecs();
      add(
        sel('容器格式', Object.entries(CONTAINERS).map(([k, c]) => [k, c.label]), 'container'),
        vc.length ? sel('影片編碼', vc.map((c) => [c, VIDEO_CODEC_NAMES[c]]), 'videoCodec') : h('div', { class: 'hint' }, '這個瀏覽器無法用此容器支援的任何影片編碼，請換一種容器。'),
        sel('解析度', resOptions(), 'res', () => (st.res = st.res === 'orig' || st.res === 'custom' ? st.res : +st.res)),
        st.res === 'custom' && num('寬度', 'customW', { min: 16, max: 7680, step: 2, unit: `px（高 ${dims()[1]} px）` }),
        sel('影格率', [...new Set([P.fps, ...FPS])].sort((a, b) => a - b).map((f) => [f, `${f} fps${f === P.fps ? '（專案）' : ''}`]), 'fps'),
        sel('畫質', QUALITY_NAMES, 'quality'),
        st.quality === 'custom' && num('位元率', 'mbps', { min: 0.5, max: 200, step: 0.5, unit: 'Mbps' }),
        h('label', { class: 'row check' }, (() => {
          const cb = h('input', { type: 'checkbox', checked: st.includeAudio, disabled: running });
          cb.onchange = () => { st.includeAudio = cb.checked; render(); };
          return cb;
        })(), h('span', {}, '包含聲音')),
        st.includeAudio && audioCodecs().length && sel('音訊編碼', audioCodecs().map((c) => [c, AUDIO_CODEC_NAMES[c]]), 'audioCodec'),
        st.includeAudio && ['aac', 'opus', 'mp3', 'vorbis'].includes(st.audioCodec) && sel('音訊位元率', [96, 128, 192, 256, 320].map((v) => [v, `${v} kbps`]), 'abr'),
      );
    } else if (st.kind === 'audio') {
      const af = audioFormats();
      add(
        sel('格式', af.map(([k, d]) => [k, d.label]), 'audioFormat'),
        AUDIO_FORMATS[st.audioFormat]?.lossy && sel('位元率', [96, 128, 192, 256, 320].map((v) => [v, `${v} kbps`]), 'abr'),
      );
    } else if (st.kind === 'gif') {
      add(
        sel('寬度', [[320, '320 px'], [480, '480 px'], [640, '640 px'], [800, '800 px'], ['orig', `原始（${P.width} px）`]], 'gifWidth', () => (st.gifWidth = st.gifWidth === 'orig' ? 'orig' : +st.gifWidth)),
        sel('影格率', [[8, '8 fps'], [10, '10 fps'], [15, '15 fps'], [20, '20 fps'], [25, '25 fps']], 'gifFps'),
        h('div', { class: 'hint' }, 'GIF 沒有聲音、最多 256 色，適合 15 秒以內的短片段；長片段檔案會很大。'),
      );
    } else if (st.kind === 'images') {
      add(
        sel('圖片格式', [['png', 'PNG（無損）'], ['jpg', 'JPG'], ['webp', 'WebP']], 'imageFormat'),
        sel('解析度', resOptions(), 'res', () => (st.res = st.res === 'orig' || st.res === 'custom' ? st.res : +st.res)),
        st.res === 'custom' && num('寬度', 'customW', { min: 16, max: 7680, step: 2, unit: 'px' }),
        sel('每秒張數', [[1, '每秒 1 張'], [2, '每秒 2 張'], [5, '每秒 5 張'], [10, '每秒 10 張'], [0, `每一格（${P.fps} 張 / 秒）`]], 'imgFps'),
        h('div', { class: 'hint' }, '所有圖片打包成一個 ZIP 檔。'),
      );
    } else {
      add(
        sel('圖片格式', [['png', 'PNG（無損）'], ['jpg', 'JPG'], ['webp', 'WebP']], 'imageFormat'),
        sel('解析度', resOptions(), 'res', () => (st.res = st.res === 'orig' || st.res === 'custom' ? st.res : +st.res)),
        st.res === 'custom' && num('寬度', 'customW', { min: 16, max: 7680, step: 2, unit: 'px' }),
        h('div', { class: 'hint' }, `匯出播放頭所在的畫面（${fmtTime(store.time)}）。`),
      );
    }
    if (st.kind !== 'still') add(...rangeRows());
    const [t0, t1] = range();
    status.textContent = running ? status.textContent : `${st.kind === 'still' ? '' : `長度 ${fmtTime(t1 - t0)}・`}預估約 ${fmtMB(estimate())}`;
  }

  const close = openModal(h('div', { class: 'export xp' },
    h('h2', {}, '匯出 ', h('span', { class: 'tag' }, '⚡ 快速模式')),
    body,
    status,
    h('div', { class: 'progress' }, bar),
    h('div', { class: 'hint' }, '使用硬體編碼逐格輸出，不用等影片播完，切到其他分頁也會繼續。'),
    h('div', { class: 'modal-actions' }, cancelBtn, goBtn)));
  render();
  probeCodecs(P.width, P.height).then((p) => {
    probe = p;
    render();
  });

  cancelBtn.onclick = () => (running ? ctrl.abort() : close());
  goBtn.onclick = async () => {
    if (!probe) return;
    fix();
    if (st.kind === 'video' && !videoCodecs().length) return toast('請換一種容器格式');
    savePrefs(st);
    running = true;
    goBtn.disabled = true;
    render();
    const [w, hh] = st.kind === 'gif'
      ? (() => {
        const gw = st.gifWidth === 'orig' ? P.width : Math.min(st.gifWidth, P.width);
        return [even(gw), even((gw * P.height) / P.width)];
      })()
      : dims();
    const r = st.kind === 'still' ? [Math.min(store.time, dur - 0.001), dur] : range();
    const o = {
      kind: st.kind, container: st.container, videoCodec: st.videoCodec, audioCodec: st.includeAudio ? st.audioCodec : null,
      includeAudio: st.includeAudio, width: w, height: hh, range: r,
      fps: st.kind === 'gif' ? st.gifFps : st.kind === 'images' ? st.imgFps || P.fps : st.fps,
      quality: st.quality === 'custom' ? undefined : st.quality, bitrate: st.quality === 'custom' ? st.mbps * 1e6 : undefined,
      audioBitrate: st.abr * 1000, audioFormat: st.audioFormat, imageFormat: st.imageFormat,
    };
    setExporting(true);
    try {
      const res = await exportMedia(o, (p, label) => {
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        status.textContent = `${label || '匯出中…'}  ${(p * 100).toFixed(0)}%`;
      }, ctrl.signal);
      if (res) {
        download(res.blob, res.ext);
        const len = r[1] - r[0];
        toast(`匯出完成：${fmtMB(res.blob.size)}，花 ${res.seconds.toFixed(1)} 秒${st.kind === 'still' ? '' : `（${(len / res.seconds).toFixed(1)}× 即時速度）`}`);
      } else toast('已取消匯出');
    } catch (e) {
      console.error(e);
      toast('匯出失敗：' + e.message);
    }
    setExporting(false);
    close();
  };
}
