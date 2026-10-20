// WebGL2 調色：基本濾鏡、白平衡、色輪（暗部 / 中間調 / 亮部）、曲線、3D LUT
// 也取代 Canvas 的 ctx.filter，讓 Safari / iPhone 上的調色同樣有效

export const WHEEL = () => ({ x: 0, y: 0, l: 0 });
export const GRADE_DEFAULT = () => ({
  lift: WHEEL(), gamma: WHEEL(), gain: WHEEL(),
  temp: 0, tint: 0,
  curves: { m: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
  lut: null, lutMix: 1,
});

const isIdentity = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);
const wheelOff = (w) => w && (w.x || w.y || w.l);
export function gradeActive(g) {
  if (!g) return false;
  return !!(wheelOff(g.lift) || wheelOff(g.gamma) || wheelOff(g.gain) || g.temp || g.tint || g.lut
    || !isIdentity(g.curves?.m) || !isIdentity(g.curves?.r) || !isIdentity(g.curves?.g) || !isIdentity(g.curves?.b));
}
export function filtersActive(f) {
  return f.brightness !== 100 || f.contrast !== 100 || f.saturate !== 100 || f.hue || f.grayscale || f.sepia || f.invert;
}

// 色輪位置 → RGB 偏移（三個分量相加為 0，只改色相不改亮度），再加上亮度
export function wheelRgb(w, strength) {
  if (!w) return [0, 0, 0];
  const r = Math.min(1, Math.hypot(w.x, w.y));
  const a = Math.atan2(w.y, w.x); // y 向上為正：右=紅、左上=綠、左下=藍，與畫面上的色輪一致
  return [Math.cos(a), Math.cos(a - (2 * Math.PI) / 3), Math.cos(a + (2 * Math.PI) / 3)].map((v) => v * r * strength + w.l * strength);
}

// 單調三次內插（Fritsch–Carlson），曲線不會過衝
export function curveTable(pts, n = 256) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(n);
  if (p.length < 2) {
    for (let i = 0; i < n; i++) out[i] = i / (n - 1);
    return out;
  }
  const k = p.length;
  const d = [];
  const m = new Array(k).fill(0);
  for (let i = 0; i < k - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= p[0][0]) { out[j] = p[0][1]; continue; }
    if (x >= p[k - 1][0]) { out[j] = p[k - 1][1]; continue; }
    while (seg < k - 2 && x > p[seg + 1][0]) seg++;
    const h = p[seg + 1][0] - p[seg][0];
    const t = (x - p[seg][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[j] = (2 * t3 - 3 * t2 + 1) * p[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * p[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
  }
  for (let j = 0; j < n; j++) out[j] = Math.min(1, Math.max(0, out[j]));
  return out;
}

// ---------- LUT ----------
export function parseCube(text) {
  let size = 0;
  const vals = [];
  let dmin = [0, 0, 0];
  let dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = +parts[1];
    else if (parts[0] === 'DOMAIN_MIN') dmin = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'DOMAIN_MAX') dmax = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'LUT_1D_SIZE') throw new Error('只支援 3D LUT（.cube）');
    else if (/^[-\d.]/.test(parts[0]) && parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('LUT 檔案格式不正確');
  const data = new Uint8Array(size * size * size * 3);
  for (let i = 0; i < data.length; i++) {
    const c = i % 3;
    data[i] = Math.round(Math.min(1, Math.max(0, (vals[i] - dmin[c]) / (dmax[c] - dmin[c]))) * 255);
  }
  return { size, data };
}

// 內建風格 LUT（用函式產生，免下載）
function makeLut(fn, size = 17) {
  const data = new Uint8Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = fn(r / (size - 1), g / (size - 1), b / (size - 1));
    for (let c = 0; c < 3; c++) data[i++] = Math.round(Math.min(1, Math.max(0, o[c])) * 255);
  }
  return { size, data };
}
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (a, b, t) => a + (b - a) * t;
export const BUILTIN_LUTS = {
  'builtin:tealorange': { name: '青橙電影', make: () => makeLut((r, g, b) => {
    const l = lum(r, g, b);
    const warm = [l * 1.12 + 0.03, l * 0.95 + 0.02, l * 0.78];
    const cool = [l * 0.75, l * 0.98 + 0.03, l * 1.08 + 0.06];
    const t = Math.min(1, Math.max(0, (l - 0.25) / 0.5));
    return [mix(mix(r, cool[0], 0.45), mix(r, warm[0], 0.45), t), mix(mix(g, cool[1], 0.45), mix(g, warm[1], 0.45), t), mix(mix(b, cool[2], 0.45), mix(b, warm[2], 0.45), t)];
  }) },
  'builtin:bleach': { name: '漂白略過', make: () => makeLut((r, g, b) => {
    const l = lum(r, g, b);
    const s = (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));
    return [mix(r, s(l), 0.6), mix(g, s(l), 0.6), mix(b, s(l), 0.6)];
  }) },
  'builtin:fade': { name: '底片褪色', make: () => makeLut((r, g, b) => [0.08 + r * 0.86, 0.07 + g * 0.84, 0.1 + b * 0.8]) },
  'builtin:cross': { name: '交叉沖印', make: () => makeLut((r, g, b) => [Math.pow(r, 0.8), Math.pow(g, 0.9) * 1.05, 0.15 + b * 0.7]) },
  'builtin:noir': { name: '黑色電影', make: () => makeLut((r, g, b) => {
    const l = lum(r, g, b);
    const c = Math.min(1, Math.max(0, (l - 0.5) * 1.5 + 0.5));
    return [c, c, c * 0.96];
  }) },
  'builtin:golden': { name: '黃金時刻', make: () => makeLut((r, g, b) => [Math.min(1, r * 1.1 + 0.04), g * 1.0 + 0.02, b * 0.82]) },
};

// ---------- WebGL ----------
const VS = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D uTex; uniform sampler2D uCurve; uniform sampler3D uLut;
uniform float uLutSize, uLutMix, uHasLut;
uniform vec3 uLift, uGamma, uGain, uWB;
uniform float uBright, uContrast, uSat, uHue, uGray, uSepia, uInvert;
in vec2 vUv; out vec4 o;
mat3 satM(float s){ vec3 w = vec3(0.2126, 0.7152, 0.0722);
  return mat3(w.r*(1.-s)+s, w.r*(1.-s), w.r*(1.-s), w.g*(1.-s), w.g*(1.-s)+s, w.g*(1.-s), w.b*(1.-s), w.b*(1.-s), w.b*(1.-s)+s); }
mat3 hueM(float a){ float c = cos(a), s = sin(a);
  return mat3(0.213+c*0.787-s*0.213, 0.213-c*0.213+s*0.143, 0.213-c*0.213-s*0.787,
              0.715-c*0.715-s*0.715, 0.715+c*0.285+s*0.140, 0.715-c*0.715+s*0.715,
              0.072-c*0.072+s*0.928, 0.072-c*0.072-s*0.283, 0.072+c*0.928+s*0.072); }
void main(){
  vec4 px = texture(uTex, vUv);
  if (px.a <= 0.0) { o = vec4(0.0); return; }
  vec3 c = px.rgb;
  c *= uBright;
  c = (c - 0.5) * uContrast + 0.5;
  c = satM(uSat) * c;
  c = hueM(uHue) * c;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, vec3(l), uGray);
  vec3 sep = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  c = mix(c, sep, uSepia);
  c = mix(c, 1.0 - c, uInvert);
  c *= uWB;
  c = c * (1.0 + uGain);
  c = c + uLift * (1.0 - c);
  c = pow(max(c, vec3(0.0)), 1.0 / max(vec3(0.05), 1.0 + uGamma));
  c = clamp(c, 0.0, 1.0);
  c = vec3(texture(uCurve, vec2(c.r, 0.5)).r, texture(uCurve, vec2(c.g, 0.5)).g, texture(uCurve, vec2(c.b, 0.5)).b);
  if (uHasLut > 0.5) {
    vec3 lc = texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
    c = mix(c, lc, uLutMix);
  }
  o = vec4(clamp(c, 0.0, 1.0), px.a);
}`;

export class GradePass {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const n of ['uTex', 'uCurve', 'uLut', 'uLutSize', 'uLutMix', 'uHasLut', 'uLift', 'uGamma', 'uGain', 'uWB', 'uBright', 'uContrast', 'uSat', 'uHue', 'uGray', 'uSepia', 'uInvert']) this.u[n] = gl.getUniformLocation(prog, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit, target) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, t);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(target, w, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.texImg = tex(0, gl.TEXTURE_2D);
    this.texCurve = tex(1, gl.TEXTURE_2D);
    this.texLut = tex(2, gl.TEXTURE_3D);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uCurve, 1);
    gl.uniform1i(this.u.uLut, 2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.curveKey = '';
    this.lutKey = '';
    // 預設 1x1x1 空 LUT，避免取樣到未定義的 3D 貼圖
    gl.activeTexture(gl.TEXTURE2);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 1, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
  }

  setCurves(curves) {
    const key = JSON.stringify(curves);
    if (key === this.curveKey) return;
    this.curveKey = key;
    const m = curveTable(curves.m);
    const ch = [curveTable(curves.r), curveTable(curves.g), curveTable(curves.b)];
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const mi = Math.round(m[i] * 255);
      for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(ch[c][mi] * 255);
      data[i * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  setLut(id, lut) {
    if (id === this.lutKey) return;
    this.lutKey = id;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, lut.data);
  }

  /** 對整張圖層套用調色，回傳 WebGL 畫布 */
  process(source, f, g, lut) {
    const gl = this.gl;
    const W = source.width;
    const H = source.height;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const gr = g || GRADE_DEFAULT();
    this.setCurves(gr.curves || GRADE_DEFAULT().curves);
    const u = this.u;
    gl.uniform1f(u.uBright, f.brightness / 100);
    gl.uniform1f(u.uContrast, f.contrast / 100);
    gl.uniform1f(u.uSat, f.saturate / 100);
    gl.uniform1f(u.uHue, (f.hue * Math.PI) / 180);
    gl.uniform1f(u.uGray, f.grayscale / 100);
    gl.uniform1f(u.uSepia, f.sepia / 100);
    gl.uniform1f(u.uInvert, f.invert / 100);
    gl.uniform3fv(u.uLift, wheelRgb(gr.lift, 0.25));
    gl.uniform3fv(u.uGamma, wheelRgb(gr.gamma, 0.5));
    gl.uniform3fv(u.uGain, wheelRgb(gr.gain, 0.5));
    const t = (gr.temp || 0) / 100;
    const ti = (gr.tint || 0) / 100;
    gl.uniform3fv(u.uWB, [1 + t * 0.25, 1 - ti * 0.2, 1 - t * 0.25]);
    if (gr.lut && lut) {
      this.setLut(gr.lut, lut);
      gl.uniform1f(u.uHasLut, 1);
      gl.uniform1f(u.uLutSize, lut.size);
      gl.uniform1f(u.uLutMix, gr.lutMix ?? 1);
    } else gl.uniform1f(u.uHasLut, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
