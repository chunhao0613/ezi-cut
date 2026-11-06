// 文字轉語音：英文用 Kokoro（高品質），中文與其他語言用 Piper，全部在本機合成
import { idleRelease } from './idle.js';
export const VOICES = [
  { id: 'piper:zh_CN-huayan-medium', name: '中文女聲・華研', lang: 'zh', note: 'Piper，約 60 MB' },
  { id: 'kokoro:af_heart', name: '英文女聲・Heart', lang: 'en', note: 'Kokoro，約 90 MB（各英文聲音共用）' },
  { id: 'kokoro:af_bella', name: '英文女聲・Bella', lang: 'en', note: 'Kokoro' },
  { id: 'kokoro:am_michael', name: '英文男聲・Michael', lang: 'en', note: 'Kokoro' },
  { id: 'kokoro:bf_emma', name: '英式女聲・Emma', lang: 'en', note: 'Kokoro' },
  { id: 'kokoro:bm_george', name: '英式男聲・George', lang: 'en', note: 'Kokoro' },
  { id: 'piper:es_MX-claude-high', name: '西班牙文男聲', lang: 'es', note: 'Piper' },
  { id: 'piper:fr_FR-siwis-medium', name: '法文女聲', lang: 'fr', note: 'Piper' },
  { id: 'piper:de_DE-thorsten-medium', name: '德文男聲', lang: 'de', note: 'Piper' },
  { id: 'piper:vi_VN-vais1000-medium', name: '越南文女聲', lang: 'vi', note: 'Piper' },
];

// 使用者上次選的聲音與語速（字幕配音與文字朗讀共用）
export const ttsPrefs = { voice: 'piper:zh_CN-huayan-medium', speed: 1 };

// 32-bit float PCM → 16-bit WAV
export function wavBlob(pcm, sr) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

let kokoro = null;
// Kokoro 在主執行緒，閒置 2 分鐘後釋放模型（約 90 MB 加上推論記憶體）
const kokoroIdle = idleRelease(() => {
  kokoro?.model?.dispose?.();
  kokoro = null;
});
async function kokoroSay(text, voice, speed, onStatus) {
  kokoroIdle.hold();
  try {
    return await kokoroRun(text, voice, speed, onStatus);
  } finally {
    kokoroIdle.touch();
  }
}
async function kokoroRun(text, voice, speed, onStatus) {
  if (!kokoro) {
    const { KokoroTTS } = await import('kokoro-js');
    kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => p.status === 'progress' && p.total && onStatus?.({ text: '下載語音模型中…（第一次需要）', progress: p.loaded / p.total }),
    });
  }
  onStatus?.({ text: '合成語音中…' });
  // Kokoro 一次最多約 500 個音素，長文逐句合成再接起來
  const parts = text.match(/[^.!?。！？\n]+[.!?。！？]*/g) || [text];
  const chunks = [];
  let sr = 24000;
  for (const p of parts) {
    if (!p.trim()) continue;
    const a = await kokoro.generate(p.trim(), { voice, speed });
    sr = a.sampling_rate;
    chunks.push(a.audio, new Float32Array(Math.round(sr * 0.12))); // 句間停頓
  }
  const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return wavBlob(out, sr);
}

let piperVoice = '';
let toSimplified = null;
async function piperSay(text, voiceId, onStatus) {
  const { TtsSession } = await import('@mintplex-labs/piper-tts-web');
  if (voiceId !== piperVoice) TtsSession._instance = null; // 換聲音要重新載入模型
  piperVoice = voiceId;
  if (voiceId.startsWith('zh_')) {
    // 中文聲音的發音字典以簡體為主，先轉成簡體
    if (!toSimplified) {
      const OpenCC = await import('opencc-js');
      toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
    }
    text = toSimplified(text);
  }
  let s;
  try {
    s = await TtsSession.create({
      voiceId,
      // 套件預設的 onnxruntime 路徑（1.18）和實際打包的版本不合，指定成相同版本（1.30.0）
      wasmPaths: { ...TtsSession.WASM_LOCATIONS, onnxWasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/' },
      progress: (p) => p.total && onStatus?.({ text: '下載語音模型中…（第一次需要）', progress: p.loaded / p.total }),
    });
  } catch (e) {
    // 套件會先記住這個（失敗的）實例；清掉才能在下次重新下載
    TtsSession._instance = null;
    piperVoice = '';
    throw e;
  }
  onStatus?.({ text: '合成語音中…' });
  return s.predict(text);
}

/** 合成一段文字，回傳 WAV Blob */
export async function synthesize(text, voiceId, { speed = 1, onStatus } = {}) {
  const [engine, voice] = voiceId.split(':');
  if (!text.trim()) throw new Error('沒有文字可以朗讀');
  return engine === 'kokoro' ? kokoroSay(text, voice, speed, onStatus) : piperSay(text, voice, onStatus);
}
