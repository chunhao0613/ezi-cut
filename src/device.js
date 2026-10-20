// 偵測使用者裝置的運算能力，用來推薦 AI 模型
let cached = null;

const TIER_NAMES = ['手機 / 平板', '入門電腦', '中階電腦', '高效能電腦'];

export async function detectDevice() {
  if (cached) return cached;
  const ua = navigator.userAgent;
  const mobile = navigator.userAgentData?.mobile
    ?? (/Android|iPhone|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)); // iPadOS 會偽裝成 Mac
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory; // GB，只有 Chromium 提供，最多回報 8
  const conn = navigator.connection;
  const slowNet = !!(conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType || ''));

  let webgpu = false;
  let f16 = false;
  let vendor = '';
  let gpuName = '';
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter && !(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter)) {
      webgpu = true;
      f16 = adapter.features.has('shader-f16');
      const info = adapter.info || {};
      vendor = (info.vendor || '').toLowerCase();
      gpuName = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
    }
  } catch {
    webgpu = false;
  }

  let freeMB = null;
  try {
    const est = await navigator.storage?.estimate();
    if (est?.quota) freeMB = Math.round((est.quota - (est.usage || 0)) / 1e6);
  } catch {
    freeMB = null;
  }

  // 強度分數：0 手機、1 入門、2 中階、3 高效能
  let tier;
  if (mobile) tier = webgpu && /apple/.test(vendor) && (memory ?? 8) >= 8 ? 1 : 0;
  else if (webgpu) {
    const discrete = /nvidia|amd|ati|apple/.test(vendor) || /arc|radeon|geforce|rtx/i.test(gpuName);
    // 2016 年以前的舊世代獨顯（Kepler / Maxwell / 早期 GCN 等）效能有限，降為中階
    const oldGen = /kepler|maxwell|fermi|tesla|terascale|gcn-?[1-3]\b/i.test(gpuName);
    tier = discrete && !oldGen ? 3 : 2;
    if (memory && memory < 8) tier = Math.min(tier, 2);
  } else tier = cores >= 8 && (memory ?? 8) >= 8 ? 1 : 0;

  const gpuLabel = webgpu ? `${vendorName(vendor)}顯示卡加速（WebGPU）` : '無顯示卡加速，使用 CPU';
  const parts = [mobile ? '行動裝置' : '電腦', gpuLabel, `${cores} 執行緒`];
  if (memory) parts.push(`記憶體 ${memory >= 8 ? '8GB 以上' : memory + 'GB'}`);

  cached = { mobile, webgpu, f16, vendor, gpuName, cores, memory, slowNet, freeMB, tier, tierName: TIER_NAMES[tier], summary: parts.join(' · ') };
  return cached;
}

function vendorName(v) {
  if (/nvidia/.test(v)) return 'NVIDIA ';
  if (/amd|ati/.test(v)) return 'AMD ';
  if (/intel/.test(v)) return 'Intel ';
  if (/apple/.test(v)) return 'Apple ';
  if (/qualcomm/.test(v)) return 'Qualcomm ';
  if (/arm/.test(v)) return 'ARM ';
  return '';
}
