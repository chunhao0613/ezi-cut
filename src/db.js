// IndexedDB：把匯入的媒體檔留在本機，重新整理後還在
// 改名前（NovaCut）的名稱，刻意保留：瀏覽器儲存是依網域區分、不看網址路徑，
// 沿用舊名稱，使用者原本存的素材與專案在改名後才不會消失。
const DB = 'novacut';
const STORE = 'media';
let dbp = null;

function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function run(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    fn(tx.objectStore(STORE));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export const put = (id, value) => run('readwrite', (s) => s.put(value, id));
export const del = (id) => run('readwrite', (s) => s.delete(id));
export const clear = () => run('readwrite', (s) => s.clear());
export async function all() {
  const db = await open();
  return new Promise((res, rej) => {
    const out = [];
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res(out);
      out.push({ id: c.key, ...c.value });
      c.continue();
    };
    req.onerror = () => rej(req.error);
  });
}
