// 專案檔 / 範本檔的封裝格式：
//   8 位元組標頭（例如 "EZICUT2\n"）＋ 4 位元組（小端序）說明長度 ＋ JSON 說明 ＋ 各個媒體檔原始內容依序接在後面
// 媒體檔不轉成文字，幾 GB 的影片也能存；Blob 是分段組合的，不會一次把檔案全部讀進記憶體

const enc = new TextEncoder();

/** files：{ id: { blob, name, type } }；manifest 會加上 files 的位置資訊 */
export function packBundle(magic, manifest, files) {
  const parts = [];
  const index = {};
  let offset = 0;
  for (const [id, f] of Object.entries(files)) {
    index[id] = { name: f.name, type: f.type, mime: f.blob.type || '', offset, size: f.blob.size };
    parts.push(f.blob);
    offset += f.blob.size;
  }
  const head = enc.encode(JSON.stringify({ ...manifest, files: index }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return new Blob([enc.encode(magic), len, head, ...parts], { type: 'application/octet-stream' });
}

/** 回傳 { manifest, files: { id: { blob, name, type } } }；不是這個格式就回傳 null（讓呼叫端改用舊的 JSON 格式） */
export async function unpackBundle(file, magic) {
  const sig = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
  if (sig !== magic) return null;
  const len = new DataView(await file.slice(8, 12).arrayBuffer()).getUint32(0, true);
  const manifest = JSON.parse(await file.slice(12, 12 + len).text());
  const base = 12 + len;
  const files = {};
  for (const [id, f] of Object.entries(manifest.files || {})) {
    if (base + f.offset + f.size > file.size) throw new Error('檔案不完整，可能沒有下載完');
    files[id] = { name: f.name, type: f.type, blob: file.slice(base + f.offset, base + f.offset + f.size, f.mime) };
  }
  return { manifest, files };
}

/** 舊格式（JSON + base64）裡的檔案 */
export async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}
