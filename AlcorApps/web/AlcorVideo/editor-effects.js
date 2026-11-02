/* alcor-video-effects-render */
(function (root, factory) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const core = isNode ? require('./alcor-video-effects-core.js') : root.AlcorVideoEffects;
  const api = factory(core);
  if (isNode) module.exports = api;
  if (root) root.AlcorVideoEffectsRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  // Pixel effects for clips. The CPU functions are the reference (and the path
  // used without WebGL2); the WebGL2 renderer runs the same math, pass by pass, at
  // the layer's drawn size for preview and export alike. Distances in effect
  // parameters are sequence pixels; `scale` converts them to render pixels.

  const MAX_TAPS = 24;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }
  function hexRgb(hex) {
    const value = parseInt(String(hex || '#000000').slice(1), 16) || 0;
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }

  // Gaussian taps at integer pixel offsets k*stride, k = -n..n, normalized.
  function blurKernel(sigma) {
    const s = Math.max(0, Number(sigma) || 0);
    if (s < 0.25) return { stride: 1, weights: [1] };
    const radius = Math.ceil(s * 3);
    const stride = Math.max(1, Math.ceil(radius / MAX_TAPS));
    const n = Math.max(1, Math.floor(radius / stride));
    const weights = [];
    let total = 0;
    for (let k = 0; k <= n; k += 1) {
      const w = Math.exp(-((k * stride) ** 2) / (2 * s * s));
      weights.push(w);
      total += k === 0 ? w : 2 * w;
    }
    return { stride, weights: weights.map((w) => w / total) };
  }

  // Blur sigma in render pixels for a "Blurriness" amount in sequence pixels.
  function blurSigma(amount, scale) {
    return Math.max(0, Number(amount) || 0) * 0.5 * Math.max(0, Number(scale) || 1);
  }

  function ycc(r, g, b) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [y, (b - y) / 1.8556, (r - y) / 1.5748];
  }

  // Ultra Key style matte: distance from the key color in chroma (plus a little
  // luma), a linear soft edge, and spill removal along the key's chroma direction.
  function keyPixel(rgb, params) {
    const key = hexRgb(params.color);
    const [ky, kcb, kcr] = ycc(key[0], key[1], key[2]);
    let [y, cb, cr] = ycc(rgb[0], rgb[1], rgb[2]);
    const distance = Math.hypot(cb - kcb, cr - kcr) + 0.2 * Math.abs(y - ky);
    const tolerance = (params.tolerance / 100) * 0.5;
    const softness = (params.softness / 100) * 0.5 + 1e-3;
    const alpha = clamp((distance - tolerance) / softness, 0, 1);
    const length = Math.hypot(kcb, kcr);
    let out = rgb;
    if (params.spill > 0 && length > 1e-4) {
      const dx = kcb / length;
      const dy = kcr / length;
      const along = cb * dx + cr * dy;
      if (along > 0) {
        const remove = (along * params.spill) / 100;
        cb -= dx * remove;
        cr -= dy * remove;
        const r = y + 1.5748 * cr;
        const b = y + 1.8556 * cb;
        const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
        out = [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
      }
    }
    return { rgb: out, alpha };
  }

  function vignetteFactor(u, v, params) {
    const dx = Math.abs(u - 0.5) * 2;
    const dy = Math.abs(v - 0.5) * 2;
    const p = 2 + (1 - params.roundness / 100) * 6;
    const d = Math.pow(Math.pow(dx, p) + Math.pow(dy, p), 1 / p);
    const inner = (params.midpoint / 100) * 1.2;
    const width = params.feather / 100 + 0.01;
    const t = clamp((d - inner) / width, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function flipSource(x, y, w, h, mode) {
    let sx = x;
    let sy = y;
    if (mode === 'horizontal' || mode === 'both') sx = w - 1 - x;
    if (mode === 'vertical' || mode === 'both') sy = h - 1 - y;
    if (mode === 'mirror-left' && x >= w / 2) sx = w - 1 - x;
    if (mode === 'mirror-right' && x < w / 2) sx = w - 1 - x;
    if (mode === 'mirror-top' && y >= h / 2) sy = h - 1 - y;
    if (mode === 'mirror-bottom' && y < h / 2) sy = h - 1 - y;
    return [sx, sy];
  }

  function cropAlpha(x, y, w, h, params, scale) {
    const feather = Math.max(0, params.feather * scale);
    const cx = x + 0.5;
    const cy = y + 0.5;
    const edges = [
      cx - (params.left / 100) * w,
      w - (params.right / 100) * w - cx,
      cy - (params.top / 100) * h,
      h - (params.bottom / 100) * h - cy,
    ];
    let alpha = 1;
    for (const distance of edges)
      alpha *= feather > 0 ? clamp(distance / feather, 0, 1) : distance >= 0 ? 1 : 0;
    return alpha;
  }

  // Apply the pixel effects of a resolved effect list to RGBA bytes (rows top first).
  function applyPixelEffects(image, effects, scale = 1) {
    const { width: w, height: h } = image;
    let data = new Uint8ClampedArray(image.data);
    for (const effect of effects || []) {
      if (!core.PIXEL_EFFECTS.includes(effect.type) || !core.isEffective(effect)) continue;
      const p = effect.params;
      if (effect.type === 'gaussian-blur') {
        const kernel = blurKernel(blurSigma(p.amount, scale));
        if (kernel.weights.length < 2) continue;
        // Blur premultiplied colour so keyed-out (transparent) pixels do not bleed their
        // hidden colour into the edge: the first pass premultiplies its samples and stores
        // premultiplied bytes, the second unpremultiplies (as the shader does).
        for (const horizontal of [true, false]) {
          const out = new Uint8ClampedArray(data.length);
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const acc = [0, 0, 0, 0];
              for (let k = -(kernel.weights.length - 1); k < kernel.weights.length; k += 1) {
                const weight = kernel.weights[Math.abs(k)];
                const sx = horizontal ? clamp(x + k * kernel.stride, 0, w - 1) : x;
                const sy = horizontal ? y : clamp(y + k * kernel.stride, 0, h - 1);
                const at = (sy * w + sx) * 4;
                const premultiply = horizontal ? data[at + 3] / 255 : 1;
                for (let c = 0; c < 3; c += 1) acc[c] += data[at + c] * premultiply * weight;
                acc[3] += data[at + 3] * weight;
              }
              const at = (y * w + x) * 4;
              const unpremultiply = horizontal ? 1 : acc[3] > 0 ? 255 / acc[3] : 0;
              for (let c = 0; c < 3; c += 1) out[at + c] = Math.round(acc[c] * unpremultiply);
              out[at + 3] = Math.round(acc[3]);
            }
          }
          data = out;
        }
        continue;
      }
      if (effect.type === 'sharpen') {
        const k = (p.amount / 100) * 1.5;
        const out = new Uint8ClampedArray(data.length);
        const at = (x, y) => (clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) * 4;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = at(x, y);
            for (let c = 0; c < 3; c += 1) {
              const lap =
                4 * data[i + c] -
                data[at(x - 1, y) + c] -
                data[at(x + 1, y) + c] -
                data[at(x, y - 1) + c] -
                data[at(x, y + 1) + c];
              out[i + c] = Math.round(clamp((data[i + c] + k * lap) / 255, 0, 1) * 255);
            }
            out[i + 3] = data[i + 3];
          }
        }
        data = out;
        continue;
      }
      if (effect.type === 'flip') {
        const out = new Uint8ClampedArray(data.length);
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const [sx, sy] = flipSource(x, y, w, h, p.mode);
            const from = (sy * w + sx) * 4;
            const to = (y * w + x) * 4;
            for (let c = 0; c < 4; c += 1) out[to + c] = data[from + c];
          }
        }
        data = out;
        continue;
      }
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          let rgb = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
          let alpha = data[i + 3] / 255;
          if (effect.type === 'crop') alpha *= cropAlpha(x, y, w, h, p, scale);
          else if (effect.type === 'ultra-key') {
            const keyed = keyPixel(rgb, p);
            rgb = keyed.rgb;
            alpha *= keyed.alpha;
          } else if (effect.type === 'black-white') {
            const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            rgb = rgb.map((c) => c + ((l - c) * p.amount) / 100);
          } else if (effect.type === 'invert')
            rgb = rgb.map((c) => c + ((1 - 2 * c) * p.amount) / 100);
          else if (effect.type === 'vignette') {
            const t = (vignetteFactor((x + 0.5) / w, (y + 0.5) / h, p) * p.amount) / 100;
            rgb = t < 0 ? rgb.map((c) => c * (1 + t)) : rgb.map((c) => c + (1 - c) * t);
          }
          data[i] = Math.round(clamp(rgb[0], 0, 1) * 255);
          data[i + 1] = Math.round(clamp(rgb[1], 0, 1) * 255);
          data[i + 2] = Math.round(clamp(rgb[2], 0, 1) * 255);
          data[i + 3] = Math.round(clamp(alpha, 0, 1) * 255);
        }
      }
    }
    return { width: w, height: h, data };
  }

  // W3C separable blend functions (channel values 0..1): the reference for the
  // canvas globalCompositeOperation each Premiere blend mode maps to.
  function blendChannel(mode, cb, cs) {
    switch (mode) {
      case 'multiply':
        return cb * cs;
      case 'screen':
        return cb + cs - cb * cs;
      case 'overlay':
        return blendChannel('hard-light', cs, cb);
      case 'darken':
        return Math.min(cb, cs);
      case 'lighten':
        return Math.max(cb, cs);
      case 'difference':
        return Math.abs(cb - cs);
      case 'exclusion':
        return cb + cs - 2 * cb * cs;
      case 'add':
        return Math.min(1, cb + cs);
      case 'hard-light':
        return cs <= 0.5 ? cb * 2 * cs : blendChannel('screen', cb, 2 * cs - 1);
      case 'color-dodge':
        return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
      case 'color-burn':
        return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
      case 'soft-light': {
        if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
        const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
        return cb + (2 * cs - 1) * (d - cb);
      }
      default:
        return cs;
    }
  }

  // ---------------------------------------------------------- WebGL2 renderer

  const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D source; uniform ivec2 size; uniform int mode; uniform float scale;
uniform vec4 p0; uniform vec4 p1; uniform vec2 dir; uniform float stride; uniform int taps; uniform float weights[MAX_TAPS_PLUS_ONE];
vec4 at(ivec2 q) { return texelFetch(source, clamp(q, ivec2(0), size - 1), 0); }
vec3 ycc(vec3 c) { float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748); }
float ramp01(float v) { return clamp(v, 0.0, 1.0); }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int x = q.x; int yTop = size.y - 1 - q.y;
  if (mode == 0) { color = texture(source, gl_FragCoord.xy / vec2(size)); return; }
  if (mode == 1) {
    vec4 c0 = at(q);
    vec4 acc = vec4(c0.rgb * mix(1.0, c0.a, p0.x), c0.a) * weights[0];
    for (int k = 1; k <= MAX_TAPS_VALUE; k++) {
      if (k > taps) break;
      ivec2 off = ivec2(dir * float(k) * stride);
      vec4 a = at(q + off); vec4 b = at(q - off);
      acc += (vec4(a.rgb * mix(1.0, a.a, p0.x), a.a) + vec4(b.rgb * mix(1.0, b.a, p0.x), b.a)) * weights[k];
    }
    if (p0.y > 0.5) acc.rgb = acc.a > 0.0 ? clamp(acc.rgb / acc.a, 0.0, 1.0) : vec3(0.0);
    color = acc; return;
  }
  vec4 c = at(q);
  if (mode == 2) {
    vec3 lap = 4.0 * c.rgb - at(q + ivec2(1, 0)).rgb - at(q - ivec2(1, 0)).rgb - at(q + ivec2(0, 1)).rgb - at(q - ivec2(0, 1)).rgb;
    color = vec4(clamp(c.rgb + p0.x * lap, 0.0, 1.0), c.a); return;
  }
  if (mode == 3) {
    float f = p1.x;
    vec2 cc = vec2(float(x) + 0.5, float(yTop) + 0.5);
    vec4 d = vec4(cc.x - p0.x * float(size.x), float(size.x) - p0.y * float(size.x) - cc.x, cc.y - p0.z * float(size.y), float(size.y) - p0.w * float(size.y) - cc.y);
    vec4 a = f > 0.0 ? clamp(d / f, 0.0, 1.0) : step(0.0, d);
    color = vec4(c.rgb, c.a * a.x * a.y * a.z * a.w); return;
  }
  if (mode == 4) {
    vec3 k = ycc(p0.rgb); vec3 s = ycc(c.rgb);
    float dist = length(s.yz - k.yz) + 0.2 * abs(s.x - k.x);
    float alpha = ramp01((dist - p1.x) / p1.y);
    float len = length(k.yz);
    vec3 rgb = c.rgb;
    if (p1.z > 0.0 && len > 1e-4) {
      vec2 dirk = k.yz / len;
      float along = dot(s.yz, dirk);
      if (along > 0.0) {
        vec2 cbcr = s.yz - dirk * along * p1.z;
        float r = s.x + 1.5748 * cbcr.y; float b = s.x + 1.8556 * cbcr.x;
        float g = (s.x - 0.2126 * r - 0.0722 * b) / 0.7152;
        rgb = clamp(vec3(r, g, b), 0.0, 1.0);
      }
    }
    color = vec4(rgb, c.a * alpha); return;
  }
  if (mode == 5) { float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); color = vec4(c.rgb + (vec3(l) - c.rgb) * p0.x, c.a); return; }
  if (mode == 6) { color = vec4(c.rgb + (1.0 - 2.0 * c.rgb) * p0.x, c.a); return; }
  if (mode == 7) {
    int sx = x; int sy = yTop; int m = int(p0.x);
    if (m == 0 || m == 2) sx = size.x - 1 - x;
    if (m == 1 || m == 2) sy = size.y - 1 - yTop;
    if (m == 3 && float(x) >= float(size.x) / 2.0) sx = size.x - 1 - x;
    if (m == 4 && float(x) < float(size.x) / 2.0) sx = size.x - 1 - x;
    if (m == 5 && float(yTop) >= float(size.y) / 2.0) sy = size.y - 1 - yTop;
    if (m == 6 && float(yTop) < float(size.y) / 2.0) sy = size.y - 1 - yTop;
    color = at(ivec2(sx, size.y - 1 - sy)); return;
  }
  if (mode == 8) {
    float u = (float(x) + 0.5) / float(size.x); float v = (float(yTop) + 0.5) / float(size.y);
    vec2 dd = abs(vec2(u, v) - 0.5) * 2.0;
    float pw = 2.0 + (1.0 - p0.w) * 6.0;
    float d = pow(pow(dd.x, pw) + pow(dd.y, pw), 1.0 / pw);
    float t = clamp((d - p0.y * 1.2) / (p0.z + 0.01), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t) * p0.x;
    color = vec4(t < 0.0 ? c.rgb * (1.0 + t) : c.rgb + (1.0 - c.rgb) * t, c.a); return;
  }
  color = c;
}`
    .replace('MAX_TAPS_PLUS_ONE', String(MAX_TAPS + 1))
    .replace('MAX_TAPS_VALUE', String(MAX_TAPS)); // constants spliced after, so the shader stays one #version literal

  const FLIP_MODES = [
    'horizontal',
    'vertical',
    'both',
    'mirror-left',
    'mirror-right',
    'mirror-top',
    'mirror-bottom',
  ];

  // Turn resolved effects into shader passes.
  function planPasses(effects, scale) {
    const passes = [];
    for (const effect of effects || []) {
      if (!core.PIXEL_EFFECTS.includes(effect.type) || !core.isEffective(effect)) continue;
      const p = effect.params;
      switch (effect.type) {
        case 'gaussian-blur': {
          const kernel = blurKernel(blurSigma(p.amount, scale));
          if (kernel.weights.length < 2) break;
          // Premultiply in the first pass, unpremultiply after the second (no colour fringe).
          passes.push(
            { mode: 1, dir: [1, 0], kernel, p0: [1, 0, 0, 0] },
            { mode: 1, dir: [0, 1], kernel, p0: [0, 1, 0, 0] },
          );
          break;
        }
        case 'sharpen':
          passes.push({ mode: 2, p0: [(p.amount / 100) * 1.5, 0, 0, 0] });
          break;
        case 'crop':
          passes.push({
            mode: 3,
            p0: [p.left / 100, p.right / 100, p.top / 100, p.bottom / 100],
            p1: [p.feather * scale, 0, 0, 0],
          });
          break;
        case 'ultra-key':
          passes.push({
            mode: 4,
            p0: [...hexRgb(p.color), 0],
            p1: [(p.tolerance / 100) * 0.5, (p.softness / 100) * 0.5 + 1e-3, p.spill / 100, 0],
          });
          break;
        case 'black-white':
          passes.push({ mode: 5, p0: [p.amount / 100, 0, 0, 0] });
          break;
        case 'invert':
          passes.push({ mode: 6, p0: [p.amount / 100, 0, 0, 0] });
          break;
        case 'flip':
          passes.push({ mode: 7, p0: [FLIP_MODES.indexOf(p.mode), 0, 0, 0] });
          break;
        case 'vignette':
          passes.push({
            mode: 8,
            p0: [p.amount / 100, p.midpoint / 100, p.feather / 100, p.roundness / 100],
          });
          break;
        default:
          break;
      }
    }
    return passes;
  }

  function createRenderer(documentRef = typeof document !== 'undefined' ? document : null) {
    if (!documentRef) return null;
    const canvas = documentRef.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        antialias: false,
        alpha: true,
      });
    } catch (_) {
      gl = null;
    }
    if (!gl) return null;
    let program;
    try {
      const compile = (type, text) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, text);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || 'shader');
        return shader;
      };
      program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    } catch (_) {
      return null;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const name of [
      'source',
      'size',
      'mode',
      'scale',
      'p0',
      'p1',
      'dir',
      'stride',
      'taps',
      'weights',
    ])
      u[name] = gl.getUniformLocation(program, name);
    gl.uniform1i(u.source, 0);
    const makeTexture = (filter) => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [key, value] of [
        [gl.TEXTURE_MIN_FILTER, filter],
        [gl.TEXTURE_MAG_FILTER, filter],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      ])
        gl.texParameteri(gl.TEXTURE_2D, key, value);
      return texture;
    };
    const sourceTexture = makeTexture(gl.LINEAR);
    const targets = [0, 1].map(() => ({
      texture: makeTexture(gl.NEAREST),
      framebuffer: gl.createFramebuffer(),
      width: 0,
      height: 0,
    }));
    let lost = false;
    canvas.addEventListener?.('webglcontextlost', (event) => {
      event.preventDefault?.();
      lost = true;
    });

    function ensureTarget(target, w, h) {
      if (target.width === w && target.height === h) return;
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        target.texture,
        0,
      );
      target.width = w;
      target.height = h;
    }

    return {
      canvas,
      get lost() {
        return lost || gl.isContextLost();
      },
      // Render `source` through the pixel effects at w x h; null when nothing applies.
      render(source, width, height, effects, scale = 1) {
        if (lost || gl.isContextLost()) return null;
        const passes = planPasses(effects, scale);
        if (!passes.length) return null;
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.uniform2i(u.size, w, h);
        gl.uniform1f(u.scale, scale);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        } catch (_) {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          return null;
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        // Pass 0 resamples the source to the render size; effect passes read exact texels.
        const all = [{ mode: 0 }, ...passes];
        let input = sourceTexture;
        all.forEach((pass, index) => {
          const last = index === all.length - 1;
          const target = last ? null : targets[index % 2];
          if (target) ensureTarget(target, w, h);
          gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, input);
          gl.uniform1i(u.mode, pass.mode);
          gl.uniform4fv(u.p0, pass.p0 || [0, 0, 0, 0]);
          gl.uniform4fv(u.p1, pass.p1 || [0, 0, 0, 0]);
          if (pass.kernel) {
            const weights = new Float32Array(MAX_TAPS + 1);
            weights.set(pass.kernel.weights);
            gl.uniform1fv(u.weights, weights);
            gl.uniform1i(u.taps, pass.kernel.weights.length - 1);
            gl.uniform1f(u.stride, pass.kernel.stride);
            gl.uniform2f(u.dir, pass.dir[0], pass.dir[1]);
          }
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          if (target) input = target.texture;
        });
        return canvas;
      },
    };
  }

  // Bounded software path when WebGL2 is missing: at most 480 px wide.
  let scratchCanvas = null;
  function renderSoftware(documentRef, source, width, height, effects, scale) {
    const factor = Math.min(1, 480 / Math.max(1, width));
    const w = Math.max(1, Math.round(width * factor));
    const h = Math.max(1, Math.round(height * factor));
    scratchCanvas = scratchCanvas || documentRef.createElement('canvas');
    scratchCanvas.width = w;
    scratchCanvas.height = h;
    const context = scratchCanvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, w, h);
    context.drawImage(source, 0, 0, w, h);
    const out = applyPixelEffects(context.getImageData(0, 0, w, h), effects, scale * factor);
    context.putImageData(new ImageData(out.data, w, h), 0, 0);
    return scratchCanvas;
  }

  return Object.freeze({
    MAX_TAPS,
    renderSoftware,
    applyPixelEffects,
    blendChannel,
    blurKernel,
    blurSigma,
    createRenderer,
    cropAlpha,
    flipSource,
    keyPixel,
    planPasses,
    vignetteFactor,
  });
});

/* alcor-video-audio-fx */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoAudioFx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Clip audio effects as a Web Audio node chain. The same builder runs in the live
  // preview graph and in the OfflineAudioContext export mix, so what you hear is
  // what you export. Also: a 5.1-to-stereo downmix that keeps center, LFE and
  // surrounds, and a WSOLA time stretch so export can keep pitch at other speeds.

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }
  const dbToGain = (db) => Math.pow(10, db / 20);
  const gainToDb = (gain) => 20 * Math.log10(Math.max(1e-12, gain));

  // ------------------------------------------------------- biquad reference
  // Audio EQ Cookbook (R. Bristow-Johnson) coefficients, as BiquadFilterNode uses them.
  function biquadCoefficients(type, frequency, gainDb, q, sampleRate) {
    const w0 = (2 * Math.PI * frequency) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    let b0;
    let b1;
    let b2;
    let a0;
    let a1;
    let a2;
    if (type === 'peaking') {
      const alpha = sin / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    } else if (type === 'lowshelf' || type === 'highshelf') {
      // Shelf slope S = 1.
      const alpha = (sin / 2) * Math.sqrt(2);
      const k = 2 * Math.sqrt(A) * alpha;
      if (type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cos + k);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - k);
        a0 = A + 1 + (A - 1) * cos + k;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - k;
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + k);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - k);
        a0 = A + 1 - (A - 1) * cos + k;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - k;
      }
    } else {
      const alpha = sin / (2 * q);
      if (type === 'highpass') {
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
      } else {
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
      }
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  // Magnitude response (dB) of a biquad at a frequency.
  function biquadResponseDb(c, frequency, sampleRate) {
    const w = (2 * Math.PI * frequency) / sampleRate;
    const re = (z) => [Math.cos(-z * w), Math.sin(-z * w)];
    const [c1, s1] = re(1);
    const [c2, s2] = re(2);
    const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
    const ni = c.b1 * s1 + c.b2 * s2;
    const dr = 1 + c.a1 * c1 + c.a2 * c2;
    const di = c.a1 * s1 + c.a2 * s2;
    return gainToDb(Math.hypot(nr, ni) / Math.hypot(dr, di));
  }

  // Static compressor curve (dB in -> dB out) with a soft knee, before makeup gain.
  function compressorCurveDb(inputDb, params) {
    const t = params.threshold;
    const r = Math.max(1, params.ratio);
    const k = Math.max(0, params.knee);
    if (2 * (inputDb - t) < -k) return inputDb;
    if (k > 0 && 2 * Math.abs(inputDb - t) <= k)
      return inputDb + ((1 / r - 1) * Math.pow(inputDb - t + k / 2, 2)) / (2 * k);
    return t + (inputDb - t) / r;
  }

  // The automatic makeup gain a spec-conforming DynamicsCompressorNode applies (dB).
  function compressorAutoMakeupDb(params) {
    return -0.6 * compressorCurveDb(0, params);
  }

  // Gate gain for a detected level (dB): closed below threshold - 6 dB, open above threshold.
  const GATE_RANGE_DB = 6;
  function gateGain(levelDb, threshold) {
    return clamp((levelDb - (threshold - GATE_RANGE_DB)) / GATE_RANGE_DB, 0, 1);
  }
  // The detector lowpasses |x|; a sine's rectified mean is 2/pi of its peak.
  const RECTIFIED_MEAN = 2 / Math.PI;

  function gateCurve(threshold, points = 32768) {
    const curve = new Float32Array(points);
    for (let index = 0; index < points; index += 1) {
      const x = (index / (points - 1)) * 2 - 1;
      const level = Math.abs(x) / RECTIFIED_MEAN;
      curve[index] = x <= 0 ? 0 : gateGain(gainToDb(level), threshold);
    }
    return curve;
  }

  function absCurve(points = 32768) {
    const curve = new Float32Array(points);
    for (let index = 0; index < points; index += 1)
      curve[index] = Math.abs((index / (points - 1)) * 2 - 1);
    return curve;
  }

  // Build the node chain for a normalized audioFx object. Returns { input, output, nodes }.
  function buildChain(context, fx) {
    const input = context.createGain();
    let last = input;
    const nodes = [];
    const chain = (node) => {
      last.connect(node);
      last = node;
      nodes.push(node);
      return node;
    };
    const filter = (type, frequency, gain = 0, q = 0.7071) => {
      const node = context.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      node.gain.value = gain;
      node.Q.value = q;
      return chain(node);
    };
    const value = fx || {};
    if (value.highpass) filter('highpass', value.highpass.freq);
    if (value.lowpass) filter('lowpass', value.lowpass.freq);
    if (value.eq) {
      if (value.eq.lowGain) filter('lowshelf', value.eq.lowFreq, value.eq.lowGain);
      if (value.eq.midGain) filter('peaking', value.eq.midFreq, value.eq.midGain, value.eq.midQ);
      if (value.eq.highGain) filter('highshelf', value.eq.highFreq, value.eq.highGain);
    }
    if (value.gate) {
      // Noise gate from native nodes: |x| -> smoothing lowpass -> gain curve -> VCA gain.
      const vca = context.createGain();
      vca.gain.value = 0;
      const rectifier = context.createWaveShaper();
      rectifier.channelCount = 1;
      rectifier.channelCountMode = 'explicit';
      rectifier.channelInterpretation = 'speakers';
      rectifier.curve = absCurve();
      const smoothing = context.createBiquadFilter();
      smoothing.type = 'lowpass';
      smoothing.Q.value = 0.5;
      smoothing.frequency.value = clamp(
        1000 / (2 * Math.PI * Math.max(value.gate.attack * 4, Math.min(value.gate.release, 60))),
        1,
        200,
      );
      const shaper = context.createWaveShaper();
      shaper.curve = gateCurve(value.gate.threshold);
      last.connect(rectifier);
      rectifier.connect(smoothing);
      smoothing.connect(shaper);
      shaper.connect(vca.gain);
      last.connect(vca);
      last = vca;
      nodes.push(rectifier, smoothing, shaper, vca);
    }
    if (value.compressor) {
      const node = context.createDynamicsCompressor();
      node.threshold.value = value.compressor.threshold;
      node.ratio.value = value.compressor.ratio;
      node.knee.value = value.compressor.knee;
      node.attack.value = value.compressor.attack / 1000;
      node.release.value = value.compressor.release / 1000;
      chain(node);
      // The Web Audio compressor adds its own makeup gain (full-range gain ^ -0.6, per the
      // spec); undo it so the level follows the curve, then apply the user's makeup.
      const makeup = context.createGain();
      makeup.gain.value = dbToGain(
        compressorAutoMakeupDb(value.compressor) * -1 + value.compressor.makeup,
      );
      chain(makeup);
    }
    return { input, output: last, nodes };
  }

  // ------------------------------------------------------- 5.1 downmix
  // Web Audio channel order for six channels: L, R, C, LFE, SL, SR. Every channel
  // reaches the stereo pair (the browser's own speaker downmix drops the LFE).
  const DOWNMIX = Object.freeze({
    front: 1,
    center: 0.7071,
    surround: 0.7071,
    lfe: 0.5,
    normalize: 0.7071,
  });

  // Rows for left and right. Layouts follow Web Audio / SMPTE order: 3 = L R C, 4 = quad
  // L R SL SR, 5 = L R C SL SR, 6 = 5.1, 7 = 5.1 + back center, 8 = 7.1 (+ back L/R).
  // Any other count spreads its channels alternately so none is dropped.
  function downmixMatrix(channels) {
    const count = Math.floor(Number(channels)) || 0;
    if (count < 1 || count === 2) return null;
    if (count === 1) return [[1], [1]];
    const n = DOWNMIX.normalize;
    const c = DOWNMIX.center * n;
    const s = DOWNMIX.surround * n;
    const rows = [new Array(count).fill(0), new Array(count).fill(0)];
    const both = (channel, k) => {
      rows[0][channel] = k;
      rows[1][channel] = k;
    };
    const layouts = { 3: 'LRC', 4: 'LRlr', 5: 'LRClr', 6: 'LRCElr', 7: 'LRCElrB', 8: 'LRCElrlr' };
    const layout = layouts[count];
    if (!layout) {
      for (let channel = 0; channel < count; channel += 1)
        rows[channel % 2][channel] = (n * 2) / count;
      return rows;
    }
    [...layout].forEach((role, channel) => {
      if (role === 'L') rows[0][channel] = DOWNMIX.front * n;
      else if (role === 'R') rows[1][channel] = DOWNMIX.front * n;
      else if (role === 'C') both(channel, c);
      else if (role === 'E') both(channel, DOWNMIX.lfe * n);
      else if (role === 'B') both(channel, s * DOWNMIX.center);
      else if (role === 'l') rows[0][channel] = count === 4 ? n : s;
      else rows[1][channel] = count === 4 ? n : s;
    });
    return rows;
  }

  // Downmix planar channel data to [left, right]. Stereo passes through.
  function downmixToStereo(channelData) {
    const count = channelData.length;
    if (count === 2) return channelData;
    const matrix = downmixMatrix(count);
    const length = channelData[0] ? channelData[0].length : 0;
    if (!matrix) return [channelData[0], channelData[1] || channelData[0]];
    const out = [new Float32Array(length), new Float32Array(length)];
    for (let side = 0; side < 2; side += 1) {
      const row = matrix[side];
      for (let channel = 0; channel < Math.min(count, row.length); channel += 1) {
        const k = row[channel];
        if (!k) continue;
        const input = channelData[channel];
        const output = out[side];
        for (let index = 0; index < length; index += 1) output[index] += input[index] * k;
      }
    }
    return out;
  }

  // Live-graph version of the same matrix (for six-channel sources).
  function buildDownmix(context, channels) {
    const matrix = downmixMatrix(channels);
    if (!matrix || channels < 3) return null;
    const splitter = context.createChannelSplitter(channels);
    const merger = context.createChannelMerger(2);
    matrix.forEach((row, side) =>
      row.forEach((k, channel) => {
        if (!k) return;
        const gain = context.createGain();
        gain.gain.value = k;
        splitter.connect(gain, channel);
        gain.connect(merger, 0, side);
      }),
    );
    return { input: splitter, output: merger };
  }

  // ------------------------------------------------------- WSOLA time stretch
  // Waveform-similarity overlap-add: output frames at a fixed hop; each analysis
  // frame is taken near the ideal position where it best continues the previous
  // one, so the pitch stays and the duration scales by 1/rate.
  function timeStretch(channels, rate, options = {}) {
    const speed = clamp(rate, 0.1, 16);
    const frame = options.frame || 1024;
    const hop = frame / 2;
    const tolerance = options.tolerance || 256;
    const input = channels.map((data) => data);
    const length = input[0] ? input[0].length : 0;
    const outLength = Math.max(0, Math.floor(length / speed));
    const output = input.map(() => new Float32Array(outLength + frame));
    const window = new Float32Array(frame);
    for (let index = 0; index < frame; index += 1)
      window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frame);
    // One downmix up front: the similarity search reads it ~frame/2 times per hop.
    const mono = new Float64Array(length);
    for (const data of input) for (let at = 0; at < length; at += 1) mono[at] += data[at];
    const taps = Math.ceil(hop / 4);
    const reference = new Float64Array(taps);
    let previous = 0;
    for (let out = 0, k = 0; out < outLength; out += hop, k += 1) {
      const ideal = Math.round(k * hop * speed);
      let best = ideal;
      if (k > 0) {
        const natural = previous + hop;
        // The natural continuation is the same for every candidate: read it once.
        for (let tap = 0; tap < taps; tap += 1) {
          const at = natural + tap * 4;
          reference[tap] = at < length ? mono[at] : 0;
        }
        let bestScore = -Infinity;
        for (let delta = -tolerance; delta <= tolerance; delta += 2) {
          const candidate = ideal + delta;
          if (candidate < 0 || candidate + frame > length) continue;
          let score = 0;
          for (let tap = 0; tap < taps; tap += 1)
            score += reference[tap] * mono[candidate + tap * 4];
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
      best = Math.max(0, Math.min(Math.max(0, length - frame), best));
      for (let channel = 0; channel < input.length; channel += 1) {
        const source = input[channel];
        const target = output[channel];
        for (let index = 0; index < frame; index += 1) {
          const from = best + index;
          if (from >= length) break;
          target[out + index] += source[from] * window[index];
        }
      }
      previous = best;
    }
    return output.map((data) => data.subarray(0, outLength));
  }

  return Object.freeze({
    DOWNMIX,
    GATE_RANGE_DB,
    absCurve,
    biquadCoefficients,
    biquadResponseDb,
    buildChain,
    buildDownmix,
    compressorAutoMakeupDb,
    compressorCurveDb,
    dbToGain,
    downmixMatrix,
    downmixToStereo,
    gainToDb,
    gateCurve,
    gateGain,
    timeStretch,
  });
});

/* alcor-video-effects-ui */
(() => {
  'use strict';

  // Effect Controls for the clip effect stack, blend mode and anchor point, clip audio
  // effects and "maintain pitch", speed ramps (time remapping), and eyedroppers. Edits go
  // to the editor as 'alcorvideo:effects-command' events; the editor owns state and undo.
  const root = document.querySelector('[data-alcor-video-editor]');
  const core = window.AlcorVideoEffects;
  if (!root || !core || window.AlcorVideoEffectsUI) return;

  const request = {};
  root.dispatchEvent(new CustomEvent('alcorvideo:panel-bridge', { detail: request }));
  const bridge = request.bridge;
  if (!bridge) return;

  const form = root.querySelector('#av-clip-inspector');
  const titleForm = root.querySelector('#av-title-inspector');
  const anchor = form
    ? Array.from(form.children).find((node) => node.classList?.contains('av-inspector-actions'))
    : null;
  let current = { kind: '', effects: [] };
  let structure = '';

  const send = (detail) =>
    root.dispatchEvent(new CustomEvent('alcorvideo:effects-command', { detail }));

  // ------------------------------------------------------- commands
  // Every edit runs through bridge.edit (one undo step; `live` previews without one).
  function command(detail) {
    const clip = bridge.clip();
    if (!clip) return;
    const action = String(detail.action || '');
    const visual = clip.kind === 'video' || clip.kind === 'image';
    const local = bridge.localTime(clip);
    const find = () => (clip.effects || []).find((effect) => effect.id === detail.effectId) || null;
    const definition = (type) => core.EFFECT_TYPES[type] || { label: 'Effect', params: {} };
    const status = bridge.setStatus;
    if (action === 'add' && visual) {
      if ((clip.effects || []).length >= core.LIMITS.maxEffects) {
        status(`A clip holds at most ${core.LIMITS.maxEffects} effects`);
        return;
      }
      const effect = core.createEffect(String(detail.type), bridge.uid, detail.params || {});
      if (!effect) return;
      bridge.edit(`${definition(effect.type).label} added`, false, () => {
        clip.effects = [...(clip.effects || []), effect];
      });
      status(`${definition(effect.type).label} added to ${clip.name}`);
    } else if (action === 'remove' && find()) {
      const effect = find();
      bridge.edit(`${definition(effect.type).label} removed`, false, () => {
        clip.effects = clip.effects.filter((item) => item !== effect);
        if (!clip.effects.length) delete clip.effects;
      });
    } else if (action === 'move' && find()) {
      const effects = clip.effects;
      const index = effects.indexOf(find());
      const target = index + (Number(detail.direction) < 0 ? -1 : 1);
      if (target < 0 || target >= effects.length) return;
      bridge.edit('Effect order', false, () => {
        const [item] = effects.splice(index, 1);
        effects.splice(target, 0, item);
      });
    } else if (action === 'toggle' && find()) {
      const effect = find();
      bridge.edit(effect.enabled === false ? 'Effect on' : 'Effect off', false, () => {
        if (effect.enabled === false) delete effect.enabled;
        else effect.enabled = false;
      });
    } else if (action === 'param' && find()) {
      const effect = find();
      const name = String(detail.name || '');
      const spec = definition(effect.type).params[name];
      if (!spec) return;
      bridge.edit(`${definition(effect.type).label} ${name}`, Boolean(detail.live), () => {
        const keyed =
          Array.isArray(effect.keyframes) && effect.keyframes.length && spec[3] === true;
        if (keyed)
          effect.keyframes = core.upsertEffectKeyframe(effect, local, clip.duration, {
            [name]: Number(detail.value),
          });
        else
          effect.params = core.normalizeEffect(
            { ...effect, params: { ...effect.params, [name]: detail.value } },
            clip.duration,
          ).params;
      });
    } else if (action === 'keyframe' && find()) {
      const effect = find();
      const op = String(detail.op || 'add');
      if (!core.keyframeableParams(effect.type).length) {
        status('This effect has no animatable values');
        return;
      }
      bridge.edit(
        op === 'add'
          ? 'Effect keyframe'
          : op === 'clear'
            ? 'Effect keyframes cleared'
            : 'Effect keyframe removed',
        false,
        () => {
          if (op === 'add')
            effect.keyframes = core.upsertEffectKeyframe(effect, local, clip.duration);
          else if (op === 'clear') {
            effect.params = core.normalizeEffect(
              { ...effect, params: core.resolveEffectParams(effect, local), keyframes: [] },
              clip.duration,
            ).params;
            delete effect.keyframes;
          } else {
            const next = core.removeEffectKeyframe(effect, local, Math.max(0.02, 1 / bridge.fps()));
            if (next.length === (effect.keyframes || []).length) return false;
            if (next.length) effect.keyframes = next;
            else delete effect.keyframes;
          }
          return true;
        },
      );
      status(
        op === 'add'
          ? `Keyframe at ${bridge.formatClock(bridge.currentTime(), true)}`
          : op === 'clear'
            ? 'Effect keyframes cleared'
            : 'Effect keyframe removed',
      );
    } else if (action === 'blend' && visual) {
      bridge.edit('Blend mode', false, () => {
        const mode = core.normalizeBlendMode(detail.value);
        if (mode === 'normal') delete clip.blendMode;
        else clip.blendMode = mode;
      });
    } else if (action === 'anchor' && visual) {
      bridge.edit('Anchor point', Boolean(detail.live), () => {
        const point = core.normalizeAnchor({
          anchorX: detail.x ?? clip.anchorX,
          anchorY: detail.y ?? clip.anchorY,
        });
        if (point.anchorX === 50 && point.anchorY === 50) {
          delete clip.anchorX;
          delete clip.anchorY;
        } else Object.assign(clip, point);
      });
    } else if (action === 'audio') {
      const targets = bridge.linkedAudio(clip);
      if (!targets.length) {
        status('Select an audio clip (or a video clip with linked sound)');
        return;
      }
      const name = String(detail.section || '');
      bridge.edit(
        name === 'pitch' ? 'Maintain pitch' : `Audio ${name}`,
        Boolean(detail.live),
        () => {
          for (const target of targets) {
            if (name === 'pitch') {
              if (detail.value) target.preservePitch = true;
              else delete target.preservePitch;
              continue;
            }
            const next = { ...(target.audioFx || {}) };
            if (detail.enabled === false) delete next[name];
            else
              next[name] = {
                ...(next[name] || core.defaultAudioFx(name) || {}),
                ...(detail.params || {}),
              };
            const fx = core.normalizeAudioFx(next);
            if (fx) target.audioFx = fx;
            else delete target.audioFx;
          }
        },
      );
    } else if (action === 'remap') {
      if (clip.kind !== 'video' && clip.kind !== 'audio') return;
      const frame = 1 / bridge.fps();
      let points = null;
      if (detail.op === 'ramp') {
        const from = Math.min(clip.duration, Math.max(0, Number(detail.from) || 0));
        const to = Math.min(
          clip.duration,
          Math.max(0, detail.to == null ? clip.duration : Number(detail.to)),
        );
        if (to - from < frame) {
          status('A speed ramp needs two keyframes at least a frame apart');
          return;
        }
        points = [
          { time: from, speed: Number(detail.startSpeed) / 100 },
          { time: to, speed: Number(detail.endSpeed) / 100 },
        ];
      } else if (detail.op === 'add') {
        const existing = clip.timeRemap
          ? clip.timeRemap.slice()
          : [{ time: 0, speed: clip.speed || 1 }];
        points = existing
          .filter((point) => Math.abs(point.time - local) > 0.0005)
          .concat([{ time: local, speed: Number(detail.speed) / 100 }]);
        if (points.length < 2)
          points.push({
            time: local < clip.duration / 2 ? clip.duration : 0,
            speed: clip.speed || 1,
          });
      }
      const project = bridge.project();
      let ids = bridge
        .linkedIds(clip.id)
        .filter((id) => points || project.clips.some((item) => item.id === id && item.timeRemap));
      if (!ids.length) ids = [clip.id];
      // Linked picture and sound ramp together or not at all: try every clip on a copy
      // first, then apply to all of them as one history step.
      const trial = JSON.parse(JSON.stringify(project));
      let result =
        ids.map((id) => bridge.setTimeRemap(id, points, trial)).find((outcome) => !outcome.ok) ||
        null;
      if (!result) {
        bridge.edit(points ? 'Speed ramp' : 'Speed ramp removed', false, () => {
          for (const id of ids) {
            const outcome = bridge.setTimeRemap(id, points);
            if (id === clip.id || !result) result = outcome;
          }
          return true;
        });
      }
      status(
        result && result.ok
          ? points && clip.timeRemap
            ? `Speed ramp ${clip.timeRemap.map((point) => `${Math.round(point.speed * 100)}%`).join(' → ')}`
            : 'Speed ramp removed'
          : result?.reason || 'Speed unchanged',
      );
    }
    refresh();
  }
  root.addEventListener('alcorvideo:effects-command', (event) => {
    if (event.detail) command(event.detail);
  });

  // Panel state for the selected clip at the playhead.
  function readState() {
    const clip = bridge.clip();
    const local = clip ? bridge.localTime(clip) : 0;
    const audio = bridge.linkedAudio(clip)[0] || null;
    const timed = clip && (clip.kind === 'video' || clip.kind === 'audio');
    return {
      kind: clip ? clip.kind : '',
      clipId: clip ? clip.id : '',
      localTime: local,
      duration: clip ? clip.duration : 0,
      effects:
        clip && Array.isArray(clip.effects)
          ? clip.effects.map((effect) => ({
              ...effect,
              value: core.resolveEffectParams(effect, local),
            }))
          : [],
      blendMode: clip && clip.blendMode ? clip.blendMode : 'normal',
      anchorX: clip && clip.anchorX != null ? clip.anchorX : 50,
      anchorY: clip && clip.anchorY != null ? clip.anchorY : 50,
      audioFx: audio && audio.audioFx ? audio.audioFx : null,
      audioClip: audio ? audio.id : '',
      preservePitch: Boolean(audio && audio.preservePitch),
      timeRemap: timed && clip.timeRemap ? clip.timeRemap : null,
      speed: timed ? bridge.speedAt(clip, bridge.currentTime()) : 1,
      canRemap: Boolean(timed && clip.hold == null),
    };
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, data, label) {
    const node = el('button', '', text);
    node.type = 'button';
    Object.assign(node.dataset, data);
    if (label) node.setAttribute('aria-label', label);
    return node;
  }
  function numberInput(min, max, step, value, data, label) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    Object.assign(input.dataset, data);
    if (label) input.setAttribute('aria-label', label);
    return input;
  }

  // --------------------------------------------------------- eyedropper
  // EyeDropper API where the browser has it; otherwise (and always, as a fallback)
  // the next click on the Program monitor samples the picture under the pointer.
  let picking = null;
  function pickColor(options = {}) {
    if (picking) picking.cancel();
    const canvas = root.querySelector('#av-preview');
    return new Promise((resolve) => {
      let done = false;
      const abort = typeof AbortController === 'function' ? new AbortController() : null;
      const finish = (value) => {
        if (done) return;
        done = true;
        picking = null;
        abort?.abort();
        canvas?.removeEventListener('pointerdown', onCanvas, true);
        window.removeEventListener('keydown', onKey, true);
        root.classList.remove('av-is-picking');
        root.dispatchEvent(new CustomEvent('alcorvideo:eyedropper', { detail: { phase: 'end' } }));
        resolve(value);
      };
      const onCanvas = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
        const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);
        try {
          const pixel = canvas
            .getContext('2d')
            .getImageData(
              Math.max(0, Math.min(canvas.width - 1, x)),
              Math.max(0, Math.min(canvas.height - 1, y)),
              1,
              1,
            ).data;
          finish(
            `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`,
          );
        } catch (_) {
          finish(null);
        }
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      };
      picking = { cancel: () => finish(null) };
      root.dispatchEvent(
        new CustomEvent('alcorvideo:eyedropper', {
          detail: {
            phase: 'start',
            clipId: options.clipId || '',
            effectId: options.effectId || '',
          },
        }),
      );
      root.classList.add('av-is-picking');
      canvas?.addEventListener('pointerdown', onCanvas, true);
      window.addEventListener('keydown', onKey, true);
      window.AlcorVideoEditor?.status?.(
        'Eyedropper: click the Program monitor to pick a color (Esc cancels)',
      );
      if (typeof window.EyeDropper === 'function') {
        try {
          new window.EyeDropper().open(abort ? { signal: abort.signal } : undefined).then(
            (result) =>
              finish(result && result.sRGBHex ? String(result.sRGBHex).toLowerCase() : null),
            () => {},
          );
        } catch (_) {
          /* monitor click still works */
        }
      }
    });
  }

  // ------------------------------------------------------- effect stack
  const section = el('fieldset', 'av-effects-section av-field-wide');
  section.dataset.avEffectsSection = '';
  section.dataset.afPanel = 'effects';
  section.dataset.afLabel = 'Effects';
  section.hidden = true;
  section.append(el('legend', '', 'Video effects'));
  const blendRow = el('div', 'av-effects-row');
  const blendLabel = el('label', 'av-color-field', 'Blend mode');
  const blend = document.createElement('select');
  blend.dataset.avBlendMode = '';
  for (const mode of Object.keys(core.BLEND_MODES)) {
    const option = el(
      'option',
      '',
      mode.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    );
    option.value = mode;
    blend.append(option);
  }
  blendLabel.append(blend);
  const anchorX = numberInput(-100, 200, 0.5, 50, { avAnchor: 'x' }, 'Anchor point X percent');
  const anchorY = numberInput(-100, 200, 0.5, 50, { avAnchor: 'y' }, 'Anchor point Y percent');
  const anchorXLabel = el('label', 'av-color-field', 'Anchor X %');
  anchorXLabel.append(anchorX);
  const anchorYLabel = el('label', 'av-color-field', 'Anchor Y %');
  anchorYLabel.append(anchorY);
  blendRow.append(blendLabel, anchorXLabel, anchorYLabel);
  const addRow = el('div', 'av-inline-actions av-effects-add');
  const addSelect = document.createElement('select');
  addSelect.dataset.avAddEffectType = '';
  addSelect.setAttribute('aria-label', 'Effect to add');
  for (const [type, definition] of Object.entries(core.EFFECT_TYPES)) {
    const option = el('option', '', definition.label);
    option.value = type;
    addSelect.append(option);
  }
  addRow.append(addSelect, button('Add effect', { avAddEffect: '' }));
  const list = el('div', 'av-effect-stack');
  list.dataset.avEffectStack = '';
  section.append(blendRow, addRow, list);

  // ------------------------------------------------------- audio effects
  const audioSection = el('fieldset', 'av-audio-fx-section av-field-wide');
  audioSection.dataset.avAudioFxSection = '';
  audioSection.hidden = true;
  audioSection.append(el('legend', '', 'Audio effects'));
  const AUDIO_LABELS = {
    highpass: 'High-pass',
    lowpass: 'Low-pass',
    eq: 'Parametric EQ',
    gate: 'Noise gate',
    compressor: 'Compressor',
  };
  const PARAM_LABELS = {
    freq: 'Frequency Hz',
    lowGain: 'Low shelf dB',
    lowFreq: 'Low Hz',
    midGain: 'Mid dB',
    midFreq: 'Mid Hz',
    midQ: 'Mid Q',
    highGain: 'High shelf dB',
    highFreq: 'High Hz',
    threshold: 'Threshold dB',
    attack: 'Attack ms',
    release: 'Release ms',
    ratio: 'Ratio',
    knee: 'Knee dB',
    makeup: 'Makeup dB',
  };
  const pitch = el('label', 'av-checkbox');
  const pitchInput = document.createElement('input');
  pitchInput.type = 'checkbox';
  pitchInput.dataset.avPreservePitch = '';
  pitch.append(pitchInput, ' Maintain pitch when speed changes');
  audioSection.append(pitch);
  for (const name of core.AUDIO_FX_ORDER) {
    const box = el('div', 'av-audio-fx');
    box.dataset.avAudioFx = name;
    const toggle = el('label', 'av-checkbox');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.avAudioFxToggle = name;
    toggle.append(check, ` ${AUDIO_LABELS[name]}`);
    const grid = el('div', 'av-effect-params');
    for (const [param, [min, max, value]] of Object.entries(core.AUDIO_FX[name])) {
      const label = el('label', 'av-color-field', PARAM_LABELS[param] || param);
      label.append(
        numberInput(
          min,
          max,
          max - min > 100 ? 1 : 0.1,
          value,
          { avAudioFxParam: `${name}.${param}` },
          `${AUDIO_LABELS[name]} ${PARAM_LABELS[param] || param}`,
        ),
      );
      grid.append(label);
    }
    box.append(toggle, grid);
    audioSection.append(box);
  }

  // ------------------------------------------------------- speed ramp
  const rampSection = el('div', 'av-ramp av-field-wide');
  rampSection.dataset.avRampSection = '';
  rampSection.hidden = true;
  rampSection.append(el('strong', '', 'Time remapping · speed ramp'));
  const rampStart = numberInput(
    10,
    1600,
    5,
    100,
    { avRamp: 'startSpeed' },
    'Ramp start speed percent',
  );
  const rampEnd = numberInput(10, 1600, 5, 200, { avRamp: 'endSpeed' }, 'Ramp end speed percent');
  const rampFrom = numberInput(0, 7200, 0.01, 0, { avRamp: 'from' }, 'Ramp starts at clip seconds');
  const rampTo = numberInput(0, 7200, 0.01, 1, { avRamp: 'to' }, 'Ramp ends at clip seconds');
  const rampGrid = el('div', 'av-effect-params');
  for (const [text, input] of [
    ['From speed %', rampStart],
    ['To speed %', rampEnd],
    ['Ramp from s', rampFrom],
    ['Ramp to s', rampTo],
  ]) {
    const label = el('label', 'av-color-field', text);
    label.append(input);
    rampGrid.append(label);
  }
  const keySpeed = numberInput(10, 1600, 5, 100, { avRamp: 'keySpeed' }, 'Speed keyframe percent');
  const keyLabel = el('label', 'av-color-field', 'Keyframe speed %');
  keyLabel.append(keySpeed);
  const rampStatus = el('span', 'av-ramp-status');
  rampStatus.setAttribute('role', 'status');
  const rampActions = el('div', 'av-inline-actions');
  rampActions.append(
    button('Apply ramp', { avRampApply: '' }),
    button('Speed keyframe at playhead', { avRampKey: '' }),
    button('Remove ramp', { avRampClear: '' }),
  );
  rampSection.append(rampGrid, keyLabel, rampActions, rampStatus);

  if (form && anchor && !form.querySelector('[data-av-effects-section]')) {
    anchor.before(section, audioSection);
    const speed = form.querySelector('[data-av-speed-section]');
    if (speed) speed.append(rampSection);
    else anchor.before(rampSection);
  }

  // Title color eyedropper.
  const titleColor = titleForm?.elements?.namedItem?.('color');
  if (titleColor && !titleForm.querySelector('[data-av-title-eyedropper]')) {
    const pick = button(
      'Pick',
      { avTitleEyedropper: '' },
      'Pick the title color from the Program monitor',
    );
    pick.className = 'av-eyedropper-button';
    titleColor.closest('label')?.append(pick);
  }

  // Effects library in the Effects tab.
  const pane = root.querySelector('#av-pane-effects');
  if (pane && !pane.querySelector('[data-av-effect-library]')) {
    const heading = el('h3', '', 'Video effects');
    const help = el(
      'p',
      'av-panel-help',
      'Select a video or image clip, then add an effect. Effects stack in order and render the same in preview and export.',
    );
    const library = el('div', 'av-effect-list');
    library.dataset.avEffectLibrary = '';
    for (const [type, definition] of Object.entries(core.EFFECT_TYPES))
      library.append(button(definition.label, { avLibraryEffect: type }));
    pane.prepend(heading, help, library);
  }

  // ------------------------------------------------------- rendering
  function paramControl(effect, name, spec, value) {
    const label = el(
      'label',
      'av-color-field',
      name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    );
    const data = { avEffectParam: name, avEffectId: effect.id };
    if (spec[0] === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = value;
      Object.assign(input.dataset, data);
      label.append(
        input,
        button(
          'Pick',
          { avEffectEyedropper: effect.id, avEffectParamName: name },
          'Pick the key color from the Program monitor',
        ),
      );
      label.querySelector('button').className = 'av-eyedropper-button';
    } else if (spec[0] === 'choice') {
      const select = document.createElement('select');
      Object.assign(select.dataset, data);
      for (const choice of spec[2]) {
        const option = el('option', '', choice.replace(/-/g, ' '));
        option.value = choice;
        select.append(option);
      }
      select.value = value;
      label.append(select);
    } else {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(spec[0]);
      range.max = String(spec[1]);
      range.step = spec[1] - spec[0] > 20 ? '1' : '0.1';
      range.value = String(value);
      Object.assign(range.dataset, data);
      range.setAttribute('aria-label', `${core.EFFECT_TYPES[effect.type].label} ${name}`);
      const number = numberInput(
        spec[0],
        spec[1],
        range.step,
        value,
        data,
        `${core.EFFECT_TYPES[effect.type].label} ${name} value`,
      );
      label.append(range, number);
    }
    return label;
  }

  function renderStack() {
    // Keyframe counts stay out of the signature: dragging an animated value adds a keyframe
    // on the first input, and rebuilding then would drop the slider mid-drag (no change event).
    const signature = JSON.stringify([
      current.clipId,
      current.effects.map((effect) => [effect.id, effect.type, effect.enabled !== false]),
    ]);
    if (signature !== structure) {
      structure = signature;
      list.replaceChildren();
      current.effects.forEach((effect, index) => {
        const definition = core.EFFECT_TYPES[effect.type];
        const card = el('div', 'av-effect-card');
        card.dataset.avEffectCard = effect.id;
        card.dataset.type = effect.type;
        if (effect.enabled === false) card.classList.add('is-off');
        const head = el('div', 'av-effect-head');
        const toggle = el('label', 'av-checkbox');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = effect.enabled !== false;
        check.dataset.avEffectToggle = effect.id;
        toggle.append(check, ` ${definition.label}`);
        const tools = el('div', 'av-effect-tools');
        tools.append(
          button('Up', { avEffectMove: effect.id, direction: '-1' }, `Move ${definition.label} up`),
          button(
            'Down',
            { avEffectMove: effect.id, direction: '1' },
            `Move ${definition.label} down`,
          ),
          button('Remove', { avEffectRemove: effect.id }, `Remove ${definition.label}`),
        );
        tools.children[0].disabled = index === 0;
        tools.children[1].disabled = index === current.effects.length - 1;
        head.append(toggle, tools);
        const params = el('div', 'av-effect-params');
        for (const [name, spec] of Object.entries(definition.params))
          params.append(paramControl(effect, name, spec, effect.value[name]));
        card.append(head, params);
        if (core.keyframeableParams(effect.type).length) {
          const keys = el('div', 'av-inline-actions av-effect-keys');
          keys.append(
            button('Keyframe at playhead', { avEffectKey: effect.id, op: 'add' }),
            button('Remove keyframe', { avEffectKey: effect.id, op: 'remove' }),
            button('Clear keyframes', { avEffectKey: effect.id, op: 'clear' }),
          );
          keys.append(el('span', 'av-effect-keycount', ''));
          card.append(keys);
        }
        list.append(card);
      });
    }
    // Values change with the playhead (keyframes) without rebuilding the controls.
    for (const effect of current.effects) {
      const count = (effect.keyframes || []).length;
      const keycount = list.querySelector(
        `[data-av-effect-card="${effect.id}"] .av-effect-keycount`,
      );
      if (keycount)
        keycount.textContent = count ? `${count} keyframe${count === 1 ? '' : 's'}` : 'Static';
      for (const [name, value] of Object.entries(effect.value)) {
        for (const input of list.querySelectorAll(
          `[data-av-effect-id="${effect.id}"][data-av-effect-param="${name}"]`,
        )) {
          if (document.activeElement !== input && input.value !== String(value))
            input.value = String(value);
        }
      }
    }
  }

  function renderAudio() {
    const fx = current.audioFx || {};
    for (const name of core.AUDIO_FX_ORDER) {
      const toggle = audioSection.querySelector(`[data-av-audio-fx-toggle="${name}"]`);
      toggle.checked = Boolean(fx[name]);
      audioSection
        .querySelector(`[data-av-audio-fx="${name}"]`)
        .classList.toggle('is-off', !fx[name]);
      for (const [param, [, , fallback]] of Object.entries(core.AUDIO_FX[name])) {
        const input = audioSection.querySelector(`[data-av-audio-fx-param="${name}.${param}"]`);
        const value = fx[name] ? fx[name][param] : fallback;
        if (document.activeElement !== input) input.value = String(value);
      }
    }
    pitchInput.checked = Boolean(current.preservePitch);
  }

  function renderRamp() {
    const remap = current.timeRemap;
    if (
      document.activeElement !== rampTo &&
      (!remap || Number(rampTo.value) > current.duration || Number(rampTo.value) <= 0)
    )
      rampTo.value = String(Math.round(current.duration * 100) / 100);
    rampStatus.textContent = remap
      ? `${remap.length} speed keyframes: ${remap.map((point) => `${Math.round(point.speed * 100)}% at ${point.time.toFixed(2)}s`).join(' · ')} · now ${Math.round(current.speed * 100)}%`
      : 'Constant speed. A ramp changes speed smoothly between two keyframes.';
  }

  function refresh() {
    current = readState();
    const visual = current.kind === 'video' || current.kind === 'image';
    section.hidden = !visual;
    audioSection.hidden = !current.audioClip;
    rampSection.hidden = !current.canRemap;
    if (visual) {
      if (document.activeElement !== blend) blend.value = current.blendMode || 'normal';
      if (document.activeElement !== anchorX) anchorX.value = String(current.anchorX);
      if (document.activeElement !== anchorY) anchorY.value = String(current.anchorY);
      renderStack();
    }
    if (current.audioClip) renderAudio();
    if (current.canRemap) renderRamp();
    root.dataset.effectsCount = String(current.effects.length);
  }

  // ------------------------------------------------------- input wiring
  function readAudioSection(name) {
    const params = {};
    for (const param of Object.keys(core.AUDIO_FX[name]))
      params[param] = Number(
        audioSection.querySelector(`[data-av-audio-fx-param="${name}.${param}"]`).value,
      );
    return params;
  }

  function onValue(event, live) {
    const target = event.target;
    const data = target.dataset || {};
    if (data.avEffectParam) {
      const value =
        target.type === 'color' || target.tagName === 'SELECT'
          ? target.value
          : Number(target.value);
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      // Keep the paired range/number in step while dragging.
      for (const twin of list.querySelectorAll(
        `[data-av-effect-id="${data.avEffectId}"][data-av-effect-param="${data.avEffectParam}"]`,
      ))
        if (twin !== target) twin.value = String(target.value);
      send({
        action: 'param',
        effectId: data.avEffectId,
        name: data.avEffectParam,
        value,
        live:
          live && (target.type === 'range' || target.type === 'color' || target.type === 'number'),
      });
    } else if (target === blend && !live) send({ action: 'blend', value: blend.value });
    else if (data.avAnchor)
      send({ action: 'anchor', x: Number(anchorX.value), y: Number(anchorY.value), live });
    else if (data.avAudioFxParam && !live) {
      const name = data.avAudioFxParam.split('.')[0];
      if (audioSection.querySelector(`[data-av-audio-fx-toggle="${name}"]`).checked)
        send({ action: 'audio', section: name, params: readAudioSection(name) });
    } else if (data.avAudioFxToggle && !live) {
      const name = data.avAudioFxToggle;
      send({
        action: 'audio',
        section: name,
        enabled: target.checked,
        params: readAudioSection(name),
      });
    } else if (target === pitchInput && !live)
      send({ action: 'audio', section: 'pitch', value: pitchInput.checked });
    else if (data.avEffectToggle && !live)
      send({ action: 'toggle', effectId: data.avEffectToggle });
  }

  for (const node of [section, audioSection]) {
    node.addEventListener('input', (event) => {
      event.stopPropagation();
      onValue(event, true);
    });
    node.addEventListener('change', (event) => {
      event.stopPropagation();
      onValue(event, false);
    });
  }
  rampSection.addEventListener('input', (event) => event.stopPropagation());
  rampSection.addEventListener('change', (event) => event.stopPropagation());

  root.addEventListener(
    'click',
    async (event) => {
      const target = event.target.closest?.('button');
      if (!target) return;
      const data = target.dataset;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if ('avAddEffect' in data) {
        handled();
        send({ action: 'add', type: addSelect.value });
      } else if (data.avLibraryEffect) {
        handled();
        send({ action: 'add', type: data.avLibraryEffect });
      } else if (data.avEffectRemove) {
        handled();
        send({ action: 'remove', effectId: data.avEffectRemove });
      } else if (data.avEffectMove) {
        handled();
        send({ action: 'move', effectId: data.avEffectMove, direction: Number(data.direction) });
      } else if (data.avEffectKey) {
        handled();
        send({ action: 'keyframe', effectId: data.avEffectKey, op: data.op });
      } else if ('avRampApply' in data) {
        handled();
        send({
          action: 'remap',
          op: 'ramp',
          startSpeed: Number(rampStart.value),
          endSpeed: Number(rampEnd.value),
          from: Number(rampFrom.value),
          to: Number(rampTo.value),
        });
      } else if ('avRampKey' in data) {
        handled();
        send({ action: 'remap', op: 'add', speed: Number(keySpeed.value) });
      } else if ('avRampClear' in data) {
        handled();
        send({ action: 'remap', op: 'clear' });
      } else if (data.avEffectEyedropper) {
        handled();
        const effectId = data.avEffectEyedropper;
        const name = data.avEffectParamName;
        const color = await pickColor({ clipId: current.clipId, effectId });
        if (color) send({ action: 'param', effectId, name, value: color });
      } else if ('avTitleEyedropper' in data) {
        handled();
        const color = await pickColor({});
        if (color && titleColor) {
          titleColor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
          titleColor.value = color;
          titleColor.dispatchEvent(new Event('input', { bubbles: true }));
          titleColor.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    },
    true,
  );

  window.AlcorVideoEffectsUI = Object.freeze({
    pickColor,
    refresh,
    command,
    cancelPick: () => picking?.cancel(),
  });
  refresh();
})();
