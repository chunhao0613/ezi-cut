// AI 去背（人像分割）：MediaPipe Selfie Segmenter，在本機以 GPU 執行，不需要綠幕
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let segmenter = null;
let loading = null;

async function create(delegate) {
  return ImageSegmenter.createFromOptions(
    { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
    { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false },
  );
}

export function ensure() {
  return (loading ||= (async () => {
    try {
      segmenter = await create('GPU');
    } catch (e) {
      console.warn('AI 去背改用 CPU', e);
      segmenter = await create('CPU');
    }
  })().catch((e) => {
    loading = null; // 下載失敗時允許下次重試
    throw e;
  }));
}
export const ready = () => !!segmenter;

/** 回傳人像信心值遮罩（0–1）；失敗時回傳 null */
export function segment(image) {
  if (!segmenter) return null;
  let res;
  try {
    res = segmenter.segment(image);
    const m = res.confidenceMasks?.[0];
    if (!m) return null;
    return { data: m.getAsFloat32Array().slice(), width: m.width, height: m.height };
  } catch (e) {
    console.warn('分割失敗', e);
    return null;
  } finally {
    res?.close?.();
  }
}
