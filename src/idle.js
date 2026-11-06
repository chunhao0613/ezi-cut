// 閒置一段時間就關掉的背景執行緒：AI 模型（Whisper、翻譯）常駐會占用好幾百 MB 記憶體，
// 用完一陣子沒再用就結束 Worker，把記憶體還給瀏覽器（模型檔仍在快取，下次只需重新載入、不必重新下載）
export function idleWorker(make, idleMs = 120000) {
  let w = null;
  let timer = 0;
  let busy = 0;
  return {
    /** 開始一個工作：取得（必要時建立）Worker，並暫停閒置計時 */
    begin() {
      clearTimeout(timer);
      busy++;
      return (w ||= make());
    },
    /** 工作結束：沒有其他工作時開始閒置計時 */
    end() {
      busy = Math.max(0, busy - 1);
      if (busy) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        w?.terminate();
        w = null;
      }, idleMs);
    },
    /** Worker 壞掉時直接丟掉，下次重新建立 */
    kill() {
      clearTimeout(timer);
      w?.terminate();
      w = null;
    },
  };
}

/** 一般物件版本：閒置後呼叫 release() */
export function idleRelease(release, idleMs = 120000) {
  let timer = 0;
  return {
    /** 開始使用：暫停計時，使用中不會被釋放 */
    hold() {
      clearTimeout(timer);
    },
    /** 用完：重新開始閒置計時 */
    touch() {
      clearTimeout(timer);
      timer = setTimeout(release, idleMs);
    },
  };
}
