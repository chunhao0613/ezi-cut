import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑：放在 GitHub Pages 的 https://帳號.github.io/專案名/ 底下也能正常載入
  base: './',
  // 預先打包大型相依套件，避免開發時第一次用到才重新載入頁面
  optimizeDeps: { include: ['mediabunny', 'opencc-js', '@huggingface/transformers', '@mediapipe/tasks-vision', '@shiguredo/rnnoise-wasm', 'gifenc', 'fflate', '@mediabunny/mp3-encoder', '@mediabunny/flac-encoder'] },
  worker: { format: 'es' },
});
