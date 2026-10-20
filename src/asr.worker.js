// 在 Web Worker 裡跑 Whisper 語音辨識，避免卡住畫面
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

let asr = null;
let loadedKey = '';

async function load(model, device, dtype) {
  const key = `${model}|${device}|${JSON.stringify(dtype)}`;
  if (asr && loadedKey === key) return asr;
  if (asr) await asr.dispose?.();
  asr = null;
  const files = new Map();
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let loaded = 0;
        let total = 0;
        for (const [l, t] of files.values()) {
          loaded += l;
          total += t;
        }
        self.postMessage({ type: 'download', loaded, total });
      }
    },
  });
  loadedKey = key;
  return asr;
}

self.onmessage = async (e) => {
  const { id, model, device, dtype, audio, language } = e.data;
  try {
    self.postMessage({ id, type: 'status', text: '載入模型中…（第一次需要下載，之後會快取）' });
    const pipe = await load(model, device, dtype);
    self.postMessage({ id, type: 'status', text: '辨識中…' });
    const out = await pipe(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      ...(language ? { language } : {}),
    });
    const chunks = out.chunks?.length ? out.chunks : [{ timestamp: [0, null], text: out.text }];
    self.postMessage({ id, type: 'done', chunks: chunks.map((c) => ({ start: c.timestamp[0], end: c.timestamp[1], text: c.text })) });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
