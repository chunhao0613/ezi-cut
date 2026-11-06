// 媒體匯入：讀取中繼資料、產生縮圖與音訊波形
import { store, emit, uid } from './state.js';
import * as db from './db.js';
import { toast } from './ui.js';

const EXT = {
  video: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'ogv'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
  lut: ['cube'],
};
function typeOf(f) {
  if (/\.cube$/i.test(f.name)) return 'lut';
  for (const t of ['video', 'audio', 'image']) if (f.type.startsWith(t + '/')) return t;
  const ext = f.name.split('.').pop().toLowerCase();
  return Object.keys(EXT).find((t) => EXT[t].includes(ext)) || null;
}

function once(el, evt, ms = 20000) {
  return new Promise((res, rej) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      el.removeEventListener(evt, ok);
      el.removeEventListener('error', bad);
      fn(v);
    };
    const ok = () => done(res);
    const bad = () => done(rej, el.error || new Error('media error'));
    const timer = setTimeout(() => done(rej, new Error('timeout')), ms);
    el.addEventListener(evt, ok);
    el.addEventListener('error', bad);
  });
}

function makeThumb(src, w, h) {
  const tw = 160;
  const th = Math.max(1, Math.round((tw * h) / w)) || 90;
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d').drawImage(src, 0, 0, tw, th);
  return c;
}

export async function importFiles(files) {
  const jobs = [];
  for (const f of files) {
    const type = typeOf(f);
    if (!type) continue;
    const id = uid();
    db.put(id, { blob: f, name: f.name, type }).catch((e) => {
      console.warn('無法存入 IndexedDB', e);
      toast(`「${f.name}」沒有存進瀏覽器（${e?.name === 'QuotaExceededError' ? '儲存空間不足' : '儲存失敗'}），重新整理後會不見`);
    });
    jobs.push(type === 'lut' ? loadLut(id, f, f.name) : loadMedia(id, f, f.name, type));
  }
  return Promise.all(jobs);
}

// 3D LUT（.cube）：解析後放在 store.luts，不顯示在媒體庫
async function loadLut(id, blob, name) {
  try {
    const { parseCube } = await import('./grade.js');
    const lut = { id, name: name.replace(/\.cube$/i, ''), ...parseCube(await blob.text()) };
    store.luts.set(id, lut);
    emit('luts');
    return lut;
  } catch (e) {
    console.warn('LUT 讀取失敗', name, e);
    return null;
  }
}

export async function restoreMedia() {
  try {
    const rows = await db.all();
    const { restoreTemplates } = await import('./templates.js');
    await restoreTemplates(rows);
    await Promise.all(rows.filter((r) => r.type !== 'template').map((r) => (r.type === 'lut' ? loadLut(r.id, r.blob, r.name) : loadMedia(r.id, r.blob, r.name, r.type))));
  } catch (e) {
    console.warn('還原媒體失敗', e);
  }
}

export function removeMedia(id) {
  const m = store.media.get(id);
  if (!m) return;
  URL.revokeObjectURL(m.url);
  store.media.delete(id);
  db.del(id).catch(() => {});
  emit('media');
}

// 新專案：只清掉媒體庫，保留使用者存的範本與匯入的 LUT（它們放在同一個 IndexedDB 裡）
export async function clearMedia() {
  const ids = [...store.media.keys()];
  for (const m of store.media.values()) URL.revokeObjectURL(m.url);
  store.media.clear();
  await Promise.all(ids.map((id) => db.del(id).catch(() => {})));
  emit('media');
}

export async function loadMedia(id, blob, name, type) {
  const m = {
    id, name, type, size: blob.size, blob,
    url: URL.createObjectURL(blob),
    duration: 5, width: 0, height: 0,
    thumbs: [], thumbUrl: '', peaks: null, el: null,
    ready: false, error: false,
  };
  store.media.set(id, m);
  emit('media');
  try {
    if (type === 'image') {
      const img = new Image();
      // 用 load 事件而非 decode()：分頁在背景時 decode() 可能一直不回應
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('圖片無法載入'));
        img.src = m.url;
      });
      m.el = img;
      m.width = img.naturalWidth || 512;
      m.height = img.naturalHeight || 512;
      m.duration = Infinity;
      m.thumbs = [makeThumb(img, m.width, m.height)];
      m.thumbUrl = m.thumbs[0].toDataURL('image/jpeg', 0.8);
    } else if (type === 'video') {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'metadata'; // 縮圖排隊期間先不要下載整個影片
      v.playsInline = true;
      v.src = m.url;
      await once(v, 'loadedmetadata');
      if (!isFinite(v.duration)) {
        // MediaRecorder 錄出的 webm 沒有時長，需要跳到尾端才會知道
        await new Promise((r) => {
          v.addEventListener('durationchange', () => isFinite(v.duration) && r(), { once: false });
          v.currentTime = 1e7;
          setTimeout(r, 4000);
        });
      }
      m.duration = isFinite(v.duration) ? v.duration : 10;
      m.width = v.videoWidth;
      m.height = v.videoHeight;
      m.ready = true;
      emit('media');
      thumbQueue(() => genThumbs(m, v));
    } else {
      const a = new Audio();
      a.preload = 'metadata';
      a.src = m.url;
      await once(a, 'loadedmetadata');
      m.duration = isFinite(a.duration) ? a.duration : 10;
    }
    if (type !== 'image') computePeaks(m, blob);
  } catch (e) {
    console.warn('媒體載入失敗', name, e);
    m.error = true;
  }
  m.ready = true;
  emit('media');
  return m;
}

async function genThumbs(m, v) {
  const n = Math.min(14, Math.max(1, Math.ceil(m.duration / 3)));
  try {
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.min(m.duration - 0.05, ((i + 0.5) * m.duration) / n);
      await once(v, 'seeked', 8000);
      m.thumbs.push(makeThumb(v, m.width, m.height));
      if (i === 0) {
        m.thumbUrl = m.thumbs[0].toDataURL('image/jpeg', 0.8);
        emit('media');
      }
    }
  } catch (e) {
    console.warn('縮圖產生失敗', e);
  }
  v.removeAttribute('src');
  v.load();
  emit('media');
}

// 同時處理的數量上限：一次丟進很多大檔時，不要同時解碼全部（手機會記憶體不足而閃退）
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((res, rej) => {
    q.push({ fn, res, rej });
    next();
  });
}
const peakQueue = limiter(1);
const thumbQueue = limiter(2);

const PEAK_RATE = 100; // 每秒 100 個波形點
const SMALL_FILE = 120e6; // 小檔直接整檔解碼比較快；大檔改用串流，記憶體用量固定

function computePeaks(m, blob) {
  return peakQueue(async () => {
    if (!store.media.has(m.id)) return; // 排隊期間已被移除
    let peaks = null;
    try {
      peaks = blob.size <= SMALL_FILE ? await peaksWhole(blob) : await peaksStream(blob);
    } catch (e) {
      console.warn('波形計算失敗', m.name, e);
    }
    if (peaks === false) m.hasAudio = false; // 確定沒有音軌
    else if (peaks) {
      m.peaks = peaks;
      m.hasAudio = true;
    } else if (blob.size <= SMALL_FILE) m.hasAudio = false; // 小檔解不開：當作沒有聲音（和以前一樣）
    emit('media');
  });
}

function normalize(peaks) {
  let max = 1e-4;
  for (const v of peaks) if (v > max) max = v;
  for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
  return peaks;
}

export async function peaksWhole(blob) {
  const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
  const n = Math.ceil(ab.duration * PEAK_RATE);
  const peaks = new Float32Array(n);
  const chans = Array.from({ length: ab.numberOfChannels }, (_, i) => ab.getChannelData(i));
  const step = ab.sampleRate / PEAK_RATE;
  const len = chans[0].length;
  for (let i = 0; i < n; i++) {
    let mx = 0;
    const s1 = Math.min(len, Math.floor((i + 1) * step));
    for (let s = Math.floor(i * step); s < s1; s += 3) {
      for (const ch of chans) {
        const v = Math.abs(ch[s]);
        if (v > mx) mx = v;
      }
    }
    peaks[i] = mx;
  }
  return normalize(peaks);
}

// 大檔：用 Mediabunny 一段一段解碼音軌，邊解邊算波形，不把整個檔案讀進記憶體（也沒有檔案大小上限）
export async function peaksStream(blob) {
  const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return false;
    if (!(await track.canDecode())) return null;
    const dur = await input.computeDuration();
    const peaks = new Float32Array(Math.ceil(dur * PEAK_RATE) + 1);
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const rate = buffer.sampleRate;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const d = buffer.getChannelData(ch);
        for (let s = 0; s < d.length; s += 3) {
          const i = Math.floor((timestamp + s / rate) * PEAK_RATE);
          const v = Math.abs(d[s]);
          if (i >= 0 && i < peaks.length && v > peaks[i]) peaks[i] = v;
        }
      }
    }
    return normalize(peaks);
  } finally {
    input.dispose?.();
  }
}
