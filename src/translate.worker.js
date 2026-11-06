// 翻譯 Worker：Opus-MT（Helsinki-NLP，CC-BY 4.0）在本機執行
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
const pipes = new Map();

self.onmessage = async (e) => {
  const { id, model, texts } = e.data;
  try {
    if (!pipes.has(model)) {
      // 最多留兩個模型（經英文轉譯需要兩個），再多就釋放最早載入的
      while (pipes.size >= 2) {
        const [oldest, p] = pipes.entries().next().value;
        pipes.delete(oldest);
        await p.dispose?.();
      }
      const files = new Map();
      pipes.set(model, await pipeline('translation', model, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            let l = 0;
            let t = 0;
            for (const [a, b] of files.values()) { l += a; t += b; }
            self.postMessage({ id, type: 'download', loaded: l, total: t });
          }
        },
      }));
    }
    const pipe = pipes.get(model);
    const out = [];
    for (let i = 0; i < texts.length; i++) {
      const [r] = await pipe(texts[i], { max_new_tokens: 256 });
      out.push(r.translation_text);
      self.postMessage({ id, type: 'progress', done: i + 1, total: texts.length });
    }
    self.postMessage({ id, type: 'done', texts: out });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
