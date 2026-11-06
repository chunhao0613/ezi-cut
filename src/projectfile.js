// 專案檔：把專案連同用到的媒體與 LUT 打包成一個 .ezicut 檔，可備份或換電腦繼續剪
import { store, emit, checkpoint, normalizeProject } from './state.js';
import { importFiles } from './media.js';
import { packBundle, unpackBundle, dataUrlToBlob } from './bundle.js';

const MAGIC = 'EZICUT2\n';

// 專案裡所有引用到的媒體 id（含倒放、人聲增強前的原始檔）
function usedMedia(p) {
  const ids = new Set();
  for (const c of p.clips) {
    if (c.mediaId) ids.add(c.mediaId);
    if (c.reversed?.mediaId) ids.add(c.reversed.mediaId);
    if (c.enhanced?.mediaId) ids.add(c.enhanced.mediaId);
  }
  return ids;
}

function lutToCube(lut) {
  const lines = [`TITLE "${lut.name}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${(lut.data[i] / 255).toFixed(5)} ${(lut.data[i + 1] / 255).toFixed(5)} ${(lut.data[i + 2] / 255).toFixed(5)}`);
  return lines.join('\n');
}

export async function exportProjectFile(onProgress) {
  const p = store.project;
  const files = {};
  const ids = [...usedMedia(p)];
  for (const id of ids) {
    const m = store.media.get(id);
    if (m?.blob) files[id] = { blob: m.blob, name: m.name, type: m.type };
  }
  onProgress?.(0.5);
  const luts = {};
  for (const c of p.clips) {
    const id = c.grade?.lut;
    if (id && store.luts.has(id) && !luts[id]) luts[id] = { name: store.luts.get(id).name, cube: lutToCube(store.luts.get(id)) };
  }
  const blob = packBundle(MAGIC, { ezicutProject: 2, savedAt: new Date().toISOString(), project: p, luts }, files);
  onProgress?.(1);
  return blob;
}

export async function importProjectFile(file, onProgress) {
  const bundle = await unpackBundle(file, MAGIC);
  let d;
  if (bundle) d = { ...bundle.manifest, files: bundle.files };
  else {
    // 舊版（JSON + base64）專案檔
    try {
      d = JSON.parse(await file.text());
    } catch {
      throw new Error('這不是 EziCut 專案檔');
    }
  }
  if (!d.ezicutProject) throw new Error('這不是 EziCut 專案檔');
  const map = {};
  const entries = Object.entries(d.files || {});
  for (let i = 0; i < entries.length; i++) {
    const [oldId, f] = entries[i];
    const blob = f.blob || (await dataUrlToBlob(f.data));
    // 媒體庫已有同名同大小的檔案就沿用
    const same = [...store.media.values()].find((m) => m.name === f.name && m.size === blob.size);
    if (same) map[oldId] = same.id;
    else {
      const [m] = await importFiles([new File([blob], f.name, { type: blob.type })]);
      if (m) map[oldId] = m.id;
    }
    onProgress?.((i + 1) / Math.max(1, entries.length));
  }
  const lutMap = {};
  for (const [oldId, l] of Object.entries(d.luts || {})) {
    const [lut] = await importFiles([new File([l.cube], `${l.name}.cube`, { type: 'text/plain' })]);
    if (lut) lutMap[oldId] = lut.id;
  }
  const p = normalizeProject(d.project);
  for (const c of p.clips) {
    if (c.mediaId && map[c.mediaId]) c.mediaId = map[c.mediaId];
    if (c.reversed?.mediaId && map[c.reversed.mediaId]) c.reversed.mediaId = map[c.reversed.mediaId];
    if (c.enhanced?.mediaId && map[c.enhanced.mediaId]) c.enhanced.mediaId = map[c.enhanced.mediaId];
    if (c.grade?.lut && lutMap[c.grade.lut]) c.grade.lut = lutMap[c.grade.lut];
  }
  checkpoint();
  store.project = p;
  store.selection = null;
  store.time = 0;
  emit('project');
  emit('select');
  return { media: entries.length, clips: p.clips.length };
}

