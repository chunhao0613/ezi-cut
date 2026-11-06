// 字幕翻譯：優先使用 Chrome 內建的裝置端翻譯（Translator API），否則用 Opus-MT 在本機翻譯
import { idleWorker } from './idle.js';
export const LANGS = [
  ['zh-Hant', '繁體中文'], ['zh-Hans', '簡體中文'], ['en', '英文'], ['ja', '日文'], ['ko', '韓文'],
  ['es', '西班牙文'], ['fr', '法文'], ['de', '德文'], ['vi', '越南文'], ['id', '印尼文'], ['th', '泰文'],
];
export const langName = (code) => LANGS.find(([c]) => c === code)?.[1] || code;
const base = (code) => (code.startsWith('zh') ? 'zh' : code);

// Opus-MT 有的語言組合；沒有的就經過英文轉一次
const OPUS = new Set(['en-zh', 'zh-en', 'ja-en', 'en-jap', 'ko-en', 'en-es', 'es-en', 'en-fr', 'fr-en', 'en-de', 'de-en', 'en-vi', 'vi-en', 'th-en', 'en-id', 'id-en']);
const opusModel = (a, b) => {
  const key = `${a}-${b === 'ja' ? 'jap' : b}`;
  return OPUS.has(key) ? `Xenova/opus-mt-${key}` : null;
};
export function opusRoute(src, tgt) {
  const a = base(src);
  const b = base(tgt);
  if (a === b) return [];
  const direct = opusModel(a, b);
  if (direct) return [direct];
  const m1 = a === 'en' ? null : opusModel(a, 'en');
  const m2 = b === 'en' ? null : opusModel('en', b);
  if ((a === 'en' || m1) && (b === 'en' || m2)) return [m1, m2].filter(Boolean);
  return null;
}

// 翻譯 Worker：翻完閒置 2 分鐘就關掉，釋放 Opus-MT 模型占用的記憶體
const trWorker = idleWorker(() => new Worker(new URL('./translate.worker.js', import.meta.url), { type: 'module' }));
let jobId = 0;
function runOpus(model, texts, onStatus) {
  const worker = trWorker.begin();
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const finish = () => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    };
    const onMsg = (e) => {
      const d = e.data;
      if (d.id !== id) return;
      if (d.type === 'download') onStatus?.({ text: '下載翻譯模型中…（第一次需要，之後會快取）', progress: d.loaded / d.total });
      else if (d.type === 'progress') onStatus?.({ text: `翻譯中… ${d.done}/${d.total}`, progress: d.done / d.total });
      else {
        finish();
        trWorker.end();
        if (d.type === 'done') resolve(d.texts);
        else reject(new Error(d.message));
      }
    };
    const onErr = (e) => {
      finish();
      trWorker.kill(); // 下次重新建立
      trWorker.end();
      reject(new Error(e?.message || '背景執行緒載入失敗，請重新整理頁面'));
    };
    worker.addEventListener('error', onErr);
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, model, texts });
  });
}

// Chrome 138+ 內建的裝置端翻譯：免下載我們的模型、品質較好
// 某些瀏覽器（或內嵌瀏覽器）有這個 API 卻永遠不回應，所以每一步都設逾時，逾時就改用 Opus-MT
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
let chromeBroken = false;
async function chromeTranslator(src, tgt, onStatus) {
  const T = globalThis.Translator;
  if (!T || chromeBroken) return null;
  try {
    const opts = { sourceLanguage: src, targetLanguage: tgt };
    const avail = await withTimeout(T.availability(opts), 4000);
    if (avail === 'unavailable') return null;
    return await withTimeout(T.create({
      ...opts,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onStatus?.({ text: '瀏覽器正在下載翻譯語言包…', progress: e.loaded }));
      },
    }), avail === 'available' ? 10000 : 120000);
  } catch (e) {
    if (e.message === 'timeout') chromeBroken = true;
    return null;
  }
}

let converters = {};
async function convertZh(texts, to) {
  if (!converters[to]) {
    const OpenCC = await import('opencc-js');
    converters[to] = to === 'zh-Hant' ? OpenCC.Converter({ from: 'cn', to: 'twp' }) : OpenCC.Converter({ from: 'tw', to: 'cn' });
  }
  return texts.map((t) => converters[to](t));
}

/** 翻譯一組文字，回傳 { texts, engine } */
export async function translateTexts(texts, src, tgt, onStatus) {
  if (!texts.length) return { texts: [], engine: '' };
  // 中文之間只是繁簡轉換
  if (base(src) === 'zh' && base(tgt) === 'zh') return { texts: await convertZh(texts, tgt), engine: 'OpenCC 繁簡轉換' };
  onStatus?.({ text: '準備翻譯…' });
  const ct = await chromeTranslator(src, tgt, onStatus);
  if (ct) {
    try {
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        out.push(await withTimeout(ct.translate(texts[i]), 20000));
        onStatus?.({ text: `翻譯中… ${i + 1}/${texts.length}`, progress: (i + 1) / texts.length });
      }
      return { texts: tgt === 'zh-Hant' ? await convertZh(out, 'zh-Hant') : out, engine: 'Chrome 內建翻譯（裝置端）' };
    } catch {
      chromeBroken = true; // 改用 Opus-MT
    } finally {
      ct.destroy?.();
    }
  }
  const route = opusRoute(src, tgt);
  if (!route) throw new Error(`目前無法在本機翻譯 ${langName(src)} → ${langName(tgt)}，請改用 Chrome 或換一種語言`);
  let cur = base(src) === 'zh' ? await convertZh(texts, 'zh-Hans') : texts; // Opus-MT 吃簡體
  for (const model of route) cur = await runOpus(model, cur, onStatus);
  if (tgt === 'zh-Hant') cur = await convertZh(cur, 'zh-Hant');
  return { texts: cur, engine: `Opus-MT（${route.map((m) => m.replace('Xenova/opus-mt-', '')).join(' → ')}）` };
}
