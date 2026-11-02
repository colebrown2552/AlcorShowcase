/**
 * alcor-photo-background.js: AlcorPhoto background removal.
 *
 * Segments the subject from the background and builds an alpha mask, on this
 * device; nothing is uploaded.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AlcorPhotoBackground = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function validate(data, width, height) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    if (!data || typeof data.length !== 'number' || data.length !== w * h * 4) {
      throw new Error('Background removal needs RGBA pixels matching the image size.');
    }
    if (w * h > 2_000_000)
      throw new Error('Background-removal analysis is limited to 2 megapixels.');
    return { w, h };
  }

  function cornerAverage(data, w, h, x0, y0, radius) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0,
      n = 0;
    const minX = clamp(x0 - radius, 0, w - 1),
      maxX = clamp(x0 + radius, 0, w - 1);
    const minY = clamp(y0 - radius, 0, h - 1),
      maxY = clamp(y0 + radius, 0, h - 1);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const k = (y * w + x) * 4;
        const alpha = data[k + 3] / 255;
        if (alpha <= 0.02) continue;
        r += data[k] * alpha;
        g += data[k + 1] * alpha;
        b += data[k + 2] * alpha;
        a += alpha;
        n += 1;
      }
    }
    return a > 0 && n ? [r / a, g / a, b / a] : [0, 0, 0];
  }

  function distanceSq(data, k, color) {
    const dr = data[k] - color[0],
      dg = data[k + 1] - color[1],
      db = data[k + 2] - color[2];
    return dr * dr + dg * dg + db * db;
  }

  function pixelDistanceSq(data, a, b) {
    const dr = data[a] - data[b],
      dg = data[a + 1] - data[b + 1],
      db = data[a + 2] - data[b + 2];
    return dr * dr + dg * dg + db * db;
  }

  function blurAlpha(alpha, w, h, radius) {
    const r = clamp(Math.round(radius || 0), 0, 8);
    if (!r) return alpha;
    let src = alpha;
    for (let pass = 0; pass < 2; pass += 1) {
      const tmp = new Uint8ClampedArray(src.length);
      const out = new Uint8ClampedArray(src.length);
      for (let y = 0; y < h; y += 1) {
        let sum = 0;
        for (let x = -r; x <= r; x += 1) sum += src[y * w + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x += 1) {
          tmp[y * w + x] = Math.round(sum / (r * 2 + 1));
          sum -= src[y * w + clamp(x - r, 0, w - 1)];
          sum += src[y * w + clamp(x + r + 1, 0, w - 1)];
        }
      }
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        for (let y = -r; y <= r; y += 1) sum += tmp[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y += 1) {
          out[y * w + x] = Math.round(sum / (r * 2 + 1));
          sum -= tmp[clamp(y - r, 0, h - 1) * w + x];
          sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x];
        }
      }
      src = out;
    }
    return src;
  }

  /**
   * Fast local cut-out for simple/photographic backgrounds.
   *
   * The algorithm learns four corner background prototypes, then flood-fills only
   * edge-connected pixels that remain close to those prototypes. It never sends
   * pixels off-device and returns an alpha mask: 255 keeps a pixel, 0 removes it.
   */
  function edgeBackgroundMask(rgba, width, height, options = {}) {
    const { w, h } = validate(rgba, width, height);
    const sensitivity = clamp(Number(options.sensitivity ?? 44), 1, 100);
    const feather = clamp(Number(options.feather ?? 1), 0, 8);
    const radius = clamp(Math.round(Math.min(w, h) * 0.018), 1, 12);
    const prototypes = [
      cornerAverage(rgba, w, h, 0, 0, radius),
      cornerAverage(rgba, w, h, w - 1, 0, radius),
      cornerAverage(rgba, w, h, 0, h - 1, radius),
      cornerAverage(rgba, w, h, w - 1, h - 1, radius),
    ];

    const globalTol = 18 + sensitivity * 1.55;
    const relaxedTol = globalTol * 1.65;
    const localTol = 16 + sensitivity * 1.05;
    const global2 = globalTol * globalTol;
    const relaxed2 = relaxedTol * relaxedTol;
    const local2 = localTol * localTol;

    const n = w * h;
    const bg = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0,
      tail = 0;

    const nearPrototype = (index) => {
      const k = index * 4;
      if (rgba[k + 3] <= 8) return true;
      let best = Infinity;
      for (const color of prototypes) best = Math.min(best, distanceSq(rgba, k, color));
      return best <= global2;
    };

    const seed = (index) => {
      if (bg[index] || !nearPrototype(index)) return;
      bg[index] = 1;
      queue[tail++] = index;
    };

    for (let x = 0; x < w; x += 1) {
      seed(x);
      seed((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y += 1) {
      seed(y * w);
      seed(y * w + w - 1);
    }

    const maybeVisit = (from, index) => {
      if (index < 0 || index >= n || bg[index]) return;
      const k = index * 4;
      if (rgba[k + 3] <= 8) {
        bg[index] = 1;
        queue[tail++] = index;
        return;
      }
      let global = Infinity;
      for (const color of prototypes) global = Math.min(global, distanceSq(rgba, k, color));
      if (global > relaxed2) return;
      const local = pixelDistanceSq(rgba, from * 4, k);
      if (global <= global2 || local <= local2) {
        bg[index] = 1;
        queue[tail++] = index;
      }
    };

    while (head < tail) {
      const index = queue[head++];
      const x = index % w;
      if (x > 0) maybeVisit(index, index - 1);
      if (x + 1 < w) maybeVisit(index, index + 1);
      if (index >= w) maybeVisit(index, index - w);
      if (index + w < n) maybeVisit(index, index + w);
    }

    let alpha = new Uint8ClampedArray(n);
    for (let i = 0, k = 3; i < n; i += 1, k += 4) alpha[i] = bg[i] ? 0 : rgba[k];
    if (feather > 0) alpha = blurAlpha(alpha, w, h, feather);
    return alpha;
  }

  // ---------------------------------------------------------------- subject cut-out
  // A small GrabCut: color models for subject and backdrop, a contrast-aware graph cut,
  // repeated until it settles, then the edge is refined against the full-size picture.

  const ANALYSIS_SIDE = 256;
  const COMPONENTS = 5;
  const GAMMA = 50;
  const HARD = 9 * GAMMA;
  const TERMINAL = -1,
    ORPHAN = -2,
    FAR = 0x7fffffff;

  function shrink(rgba, w, h, side) {
    const scale = Math.min(1, side / Math.max(w, h));
    const W = Math.max(1, Math.round(w * scale)),
      H = Math.max(1, Math.round(h * scale)),
      N = W * H;
    const sum = new Float64Array(N * 4),
      count = new Int32Array(N);
    for (let y = 0, k = 0; y < h; y += 1) {
      const Y = Math.min(H - 1, Math.floor((y * H) / h));
      for (let x = 0; x < w; x += 1, k += 4) {
        const i = Y * W + Math.min(W - 1, Math.floor((x * W) / w)),
          a = rgba[k + 3];
        sum[i * 4] += rgba[k] * a;
        sum[i * 4 + 1] += rgba[k + 1] * a;
        sum[i * 4 + 2] += rgba[k + 2] * a;
        sum[i * 4 + 3] += a;
        count[i] += 1;
      }
    }
    const rgb = new Float32Array(N * 3),
      clear = new Uint8Array(N);
    for (let i = 0; i < N; i += 1) {
      const a = sum[i * 4 + 3];
      if (a > 0) {
        rgb[i * 3] = sum[i * 4] / a;
        rgb[i * 3 + 1] = sum[i * 4 + 1] / a;
        rgb[i * 3 + 2] = sum[i * 4 + 2] / a;
      }
      if (a / Math.max(1, count[i]) < 10) clear[i] = 1;
    }
    return { rgb, clear, W, H };
  }

  // Which parts of the frame edge are backdrop. A subject usually runs off the bottom, so the lower
  // edge only counts when it looks like the upper edge; the upper edge counts unless it looks like the middle.
  function seedBackdrop(rgb, clear, W, H) {
    const N = W * H,
      hard = new Uint8Array(N);
    const band = Math.max(2, Math.round(Math.min(W, H) * 0.03));
    const binOf = (i) =>
      ((rgb[i * 3] >> 5) << 6) | ((rgb[i * 3 + 1] >> 5) << 3) | (rgb[i * 3 + 2] >> 5);
    const SEGMENTS = 32,
      split = H * 0.55,
      cx = (W - 1) / 2,
      cy = (H - 1) / 2;
    const middle = new Float64Array(512),
      edge = new Float64Array(512),
      upper = new Float64Array(512);
    const rows = [];
    let middleN = 0,
      edgeN = 0,
      upperN = 0;
    for (let y = 0, i = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1, i += 1) {
        if (clear[i]) {
          hard[i] = 1;
          continue;
        }
        const onBand = x < band || y < band || x >= W - band || y >= H - band;
        if (onBand) {
          const b = binOf(i);
          edge[b] += 1;
          edgeN += 1;
          if (y < split) {
            upper[b] += 1;
            upperN += 1;
          }
          rows.push(
            i,
            Math.min(
              SEGMENTS - 1,
              Math.floor(((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * SEGMENTS),
            ),
          );
        } else if (((x - cx) / (W * 0.34)) ** 2 + ((y - H * 0.52) / (H * 0.4)) ** 2 <= 1) {
          middle[binOf(i)] += 1;
          middleN += 1;
        }
      }
    }
    if (!edgeN) return hard;
    const score = new Float64Array(SEGMENTS),
      like = new Float64Array(SEGMENTS),
      low = new Uint8Array(SEGMENTS),
      seen = new Int32Array(SEGMENTS);
    const e = 1e-4;
    for (let r = 0; r < rows.length; r += 2) {
      const i = rows[r],
        s = rows[r + 1],
        b = binOf(i),
        y = Math.floor(i / W);
      score[s] += Math.log((middle[b] / Math.max(1, middleN) + e) / (edge[b] / edgeN + e));
      like[s] += Math.min(1, (upper[b] / Math.max(1, upperN)) * 8);
      seen[s] += 1;
      if (y >= split) low[s] += 1;
    }
    const order = [];
    for (let s = 0; s < SEGMENTS; s += 1) {
      if (!seen[s]) continue;
      score[s] /= seen[s];
      like[s] /= seen[s];
      order.push(s);
    }
    const lower = (s) => low[s] > seen[s] / 2;
    let chosen = order.filter((s) =>
      lower(s) ? like[s] >= 0.6 && score[s] < -0.2 : score[s] < 0.25,
    );
    // A subject filling the frame leaves no clear backdrop: take the edge least like the middle.
    if (chosen.length < order.length * 0.2)
      chosen = [...order]
        .sort((a, b) => score[a] - score[b])
        .slice(0, Math.ceil(order.length * 0.4));
    const on = new Uint8Array(SEGMENTS);
    for (const s of chosen) on[s] = 1;
    for (let r = 0; r < rows.length; r += 2) if (on[rows[r + 1]]) hard[rows[r]] = 1;
    return hard;
  }

  // Full-covariance color model from the pixels in `list`: k-means on a sample, then one fit over all of them.
  function colorModel(rgb, list, count) {
    if (count < COMPONENTS * 4) return [];
    const stride = Math.max(1, Math.floor(count / 3000)),
      sample = [];
    for (let n = 0; n < count; n += stride) sample.push(list[n]);
    const centers = [];
    let pick = sample[0];
    for (let c = 0; c < COMPONENTS; c += 1) {
      centers.push([rgb[pick * 3], rgb[pick * 3 + 1], rgb[pick * 3 + 2]]);
      let far = -1;
      for (const i of sample) {
        let near = Infinity;
        for (const m of centers)
          near = Math.min(
            near,
            (rgb[i * 3] - m[0]) ** 2 + (rgb[i * 3 + 1] - m[1]) ** 2 + (rgb[i * 3 + 2] - m[2]) ** 2,
          );
        if (near > far) {
          far = near;
          pick = i;
        }
      }
    }
    const nearest = (i) => {
      let best = 0,
        near = Infinity;
      for (let c = 0; c < COMPONENTS; c += 1) {
        const m = centers[c],
          d =
            (rgb[i * 3] - m[0]) ** 2 + (rgb[i * 3 + 1] - m[1]) ** 2 + (rgb[i * 3 + 2] - m[2]) ** 2;
        if (d < near) {
          near = d;
          best = c;
        }
      }
      return best;
    };
    for (let round = 0; round < 3; round += 1) {
      const add = centers.map(() => [0, 0, 0, 0]);
      for (const i of sample) {
        const a = add[nearest(i)];
        a[0] += rgb[i * 3];
        a[1] += rgb[i * 3 + 1];
        a[2] += rgb[i * 3 + 2];
        a[3] += 1;
      }
      add.forEach((a, c) => {
        if (a[3]) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      });
    }
    const stats = centers.map(() => new Float64Array(10));
    for (let n = 0; n < count; n += 1) {
      const i = list[n],
        s = stats[nearest(i)],
        r = rgb[i * 3],
        g = rgb[i * 3 + 1],
        b = rgb[i * 3 + 2];
      s[0] += 1;
      s[1] += r;
      s[2] += g;
      s[3] += b;
      s[4] += r * r;
      s[5] += r * g;
      s[6] += r * b;
      s[7] += g * g;
      s[8] += g * b;
      s[9] += b * b;
    }
    const model = [];
    for (const s of stats) {
      const n = s[0];
      if (n < 8) continue;
      const mr = s[1] / n,
        mg = s[2] / n,
        mb = s[3] / n;
      const a = s[4] / n - mr * mr + 16,
        b = s[5] / n - mr * mg,
        c = s[6] / n - mr * mb,
        d = s[7] / n - mg * mg + 16,
        e = s[8] / n - mg * mb,
        f = s[9] / n - mb * mb + 16;
      const A = d * f - e * e,
        B = c * e - b * f,
        C = b * e - c * d,
        det = a * A + b * B + c * C;
      if (!(det > 1e-6)) continue;
      model.push({
        mr,
        mg,
        mb,
        ia: A / det,
        ib: B / det,
        ic: C / det,
        id: (a * f - c * c) / det,
        ie: (b * c - a * e) / det,
        if: (a * d - b * b) / det,
        base: -Math.log(n / count) + 0.5 * Math.log(det),
      });
    }
    return model;
  }

  function colorCost(model, r, g, b) {
    let best = Infinity;
    for (const m of model) {
      const x = r - m.mr,
        y = g - m.mg,
        z = b - m.mb;
      const v =
        m.base +
        0.5 *
          (x * (m.ia * x + 2 * (m.ib * y + m.ic * z)) +
            y * (m.id * y + 2 * m.ie * z) +
            m.if * z * z);
      if (v < best) best = v;
    }
    return best;
  }

  // Boykov-Kolmogorov max-flow; arcs come in pairs, so arc ^ 1 is the reverse. term > 0 ties a node to the
  // source, term < 0 to the sink. Returns 1 for each node left on the sink side.
  function cutSides(n, first, dst, next, cap, term) {
    const NIL = n,
      queued = new Int32Array(n + 1).fill(-1),
      parent = new Int32Array(n),
      stamp = new Int32Array(n),
      dist = new Int32Array(n),
      side = new Uint8Array(n);
    let head = NIL,
      tail = NIL,
      now = 0;
    queued[NIL] = NIL;
    for (let v = 0; v < n; v += 1) {
      if (term[v] !== 0) {
        queued[tail] = v;
        tail = v;
        dist[v] = 1;
        parent[v] = TERMINAL;
        side[v] = term[v] < 0 ? 1 : 0;
      }
    }
    head = queued[NIL];
    queued[tail] = NIL;
    queued[NIL] = -1;
    const orphans = [];
    for (;;) {
      let bridge = -1,
        v = 0,
        u = 0,
        arc = 0,
        up = 0,
        tree = 0;
      while (head !== NIL) {
        v = head;
        if (parent[v] !== 0) {
          tree = side[v];
          for (arc = first[v]; arc !== 0; arc = next[arc]) {
            if (cap[arc ^ tree] === 0) continue;
            u = dst[arc];
            if (parent[u] === 0) {
              side[u] = tree;
              parent[u] = arc ^ 1;
              stamp[u] = stamp[v];
              dist[u] = dist[v] + 1;
              if (queued[u] === -1) {
                queued[u] = NIL;
                queued[tail] = u;
                tail = u;
              }
              continue;
            }
            if (side[u] !== tree) {
              bridge = arc ^ tree;
              break;
            }
            if (dist[u] > dist[v] + 1 && stamp[u] <= stamp[v]) {
              parent[u] = arc ^ 1;
              stamp[u] = stamp[v];
              dist[u] = dist[v] + 1;
            }
          }
          if (bridge >= 0) break;
        }
        head = queued[head];
        queued[v] = -1;
      }
      if (bridge < 0) return side;

      let flow = cap[bridge];
      for (let k = 1; k >= 0; k -= 1) {
        for (v = dst[bridge ^ k]; ; v = dst[arc]) {
          arc = parent[v];
          if (arc < 0) break;
          if (cap[arc ^ k] < flow) flow = cap[arc ^ k];
        }
        if (Math.abs(term[v]) < flow) flow = Math.abs(term[v]);
      }
      cap[bridge] -= flow;
      cap[bridge ^ 1] += flow;
      for (let k = 1; k >= 0; k -= 1) {
        for (v = dst[bridge ^ k]; ; v = dst[arc]) {
          arc = parent[v];
          if (arc < 0) break;
          cap[arc ^ (k ^ 1)] += flow;
          cap[arc ^ k] -= flow;
          if (cap[arc ^ k] === 0) {
            orphans.push(v);
            parent[v] = ORPHAN;
          }
        }
        term[v] += flow * (1 - k * 2);
        if (term[v] === 0) {
          orphans.push(v);
          parent[v] = ORPHAN;
        }
      }

      now += 1;
      while (orphans.length) {
        const orphan = orphans.pop();
        let nearest = FAR,
          adopt = 0;
        tree = side[orphan];
        for (arc = first[orphan]; arc !== 0; arc = next[arc]) {
          if (cap[arc ^ (tree ^ 1)] === 0) continue;
          u = dst[arc];
          if (side[u] !== tree || parent[u] === 0) continue;
          let d = 0;
          for (;;) {
            if (stamp[u] === now) {
              d += dist[u];
              break;
            }
            up = parent[u];
            d += 1;
            if (up < 0) {
              if (up === ORPHAN) d = FAR - 1;
              else {
                stamp[u] = now;
                dist[u] = 1;
              }
              break;
            }
            u = dst[up];
          }
          d += 1;
          if (d < FAR) {
            if (d < nearest) {
              nearest = d;
              adopt = arc;
            }
            for (u = dst[arc]; stamp[u] !== now; u = dst[parent[u]]) {
              stamp[u] = now;
              d -= 1;
              dist[u] = d;
            }
          }
        }
        parent[orphan] = adopt;
        if (adopt > 0) {
          stamp[orphan] = now;
          dist[orphan] = nearest;
          continue;
        }
        stamp[orphan] = 0;
        for (arc = first[orphan]; arc !== 0; arc = next[arc]) {
          u = dst[arc];
          up = parent[u];
          if (side[u] !== tree || up === 0) continue;
          if (cap[arc ^ (tree ^ 1)] !== 0 && queued[u] === -1) {
            queued[u] = NIL;
            queued[tail] = u;
            tail = u;
          }
          if (up > 0 && dst[up] === orphan) {
            orphans.push(u);
            parent[u] = ORPHAN;
          }
        }
      }
    }
  }

  function grabCut(rgb, clear, W, H, bias) {
    const N = W * H,
      hard = seedBackdrop(rgb, clear, W, H);
    const offsets = [
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, Math.SQRT1_2],
      [-1, 1, Math.SQRT1_2],
    ];
    const diff = (a, b) =>
      (rgb[a * 3] - rgb[b * 3]) ** 2 +
      (rgb[a * 3 + 1] - rgb[b * 3 + 1]) ** 2 +
      (rgb[a * 3 + 2] - rgb[b * 3 + 2]) ** 2;
    let total = 0,
      pairs = 0;
    for (let y = 0, i = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1, i += 1) {
        for (const [dx, dy] of offsets) {
          const X = x + dx,
            Y = y + dy;
          if (X < 0 || X >= W || Y >= H) continue;
          total += diff(i, Y * W + X);
          pairs += 1;
        }
      }
    }
    const beta = total > 0 ? pairs / (2 * total) : 0;
    const arcs = 2 + pairs * 2,
      dst = new Int32Array(arcs),
      next = new Int32Array(arcs),
      first = new Int32Array(N),
      base = new Float64Array(arcs),
      cap = new Float64Array(arcs);
    let arc = 2;
    for (let y = 0, i = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1, i += 1) {
        for (const [dx, dy, near] of offsets) {
          const X = x + dx,
            Y = y + dy;
          if (X < 0 || X >= W || Y >= H) continue;
          const j = Y * W + X,
            weight = GAMMA * near * Math.exp(-beta * diff(i, j));
          dst[arc] = j;
          next[arc] = first[i];
          first[i] = arc;
          base[arc] = weight;
          arc += 1;
          dst[arc] = i;
          next[arc] = first[j];
          first[j] = arc;
          base[arc] = weight;
          arc += 1;
        }
      }
    }
    // Start with an oval in the middle as subject. The middle leans subject and the corners lean backdrop.
    const lab = new Uint8Array(N),
      lean = new Float32Array(N);
    const cx = (W - 1) / 2,
      cy = (H - 1) * 0.52;
    for (let y = 0, i = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1, i += 1) {
        const d = ((x - cx) / (W * 0.5)) ** 2 + ((y - cy) / (H * 0.5)) ** 2;
        lean[i] = 1.1 * (d - 0.55);
        if (!hard[i] && ((x - cx) / (W * 0.34)) ** 2 + ((y - cy) / (H * 0.4)) ** 2 <= 1) lab[i] = 1;
      }
    }
    const fgList = new Int32Array(N),
      bgList = new Int32Array(N),
      term = new Float64Array(N);
    for (let round = 0; round < 4; round += 1) {
      let fgN = 0,
        bgN = 0;
      for (let i = 0; i < N; i += 1) {
        if (clear[i]) continue;
        if (lab[i]) fgList[fgN++] = i;
        else bgList[bgN++] = i;
      }
      const fg = colorModel(rgb, fgList, fgN),
        bg = colorModel(rgb, bgList, bgN);
      if (!fg.length || !bg.length) break;
      for (let i = 0; i < N; i += 1) {
        if (hard[i]) {
          term[i] = -HARD;
          continue;
        }
        const r = rgb[i * 3],
          g = rgb[i * 3 + 1],
          b = rgb[i * 3 + 2];
        term[i] = clamp(
          colorCost(bg, r, g, b) - colorCost(fg, r, g, b) - lean[i] - bias,
          -HARD,
          HARD,
        );
      }
      cap.set(base);
      const side = cutSides(N, first, dst, next, cap, term);
      let changed = 0;
      for (let i = 0; i < N; i += 1) {
        const v = hard[i] ? 0 : 1 - side[i];
        if (v !== lab[i]) {
          changed += 1;
          lab[i] = v;
        }
      }
      if (changed < N * 0.002) break;
    }
    return lab;
  }

  // Drop specks, fill pinholes. Larger gaps stay: the space inside an arm or a letter is real.
  function tidy(lab, W, H) {
    const N = W * H,
      seen = new Uint8Array(N),
      stack = new Int32Array(N);
    const speck = Math.max(12, N * 0.0003),
      pinhole = Math.max(12, N * 0.0025);
    for (let start = 0; start < N; start += 1) {
      if (seen[start]) continue;
      const value = lab[start];
      let top = 0,
        size = 0,
        touches = false;
      const members = [];
      stack[top++] = start;
      seen[start] = 1;
      while (top) {
        const i = stack[--top],
          x = i % W;
        size += 1;
        members.push(i);
        if (x === 0 || x === W - 1 || i < W || i >= N - W) touches = true;
        if (x > 0 && !seen[i - 1] && lab[i - 1] === value) {
          seen[i - 1] = 1;
          stack[top++] = i - 1;
        }
        if (x < W - 1 && !seen[i + 1] && lab[i + 1] === value) {
          seen[i + 1] = 1;
          stack[top++] = i + 1;
        }
        if (i >= W && !seen[i - W] && lab[i - W] === value) {
          seen[i - W] = 1;
          stack[top++] = i - W;
        }
        if (i < N - W && !seen[i + W] && lab[i + W] === value) {
          seen[i + W] = 1;
          stack[top++] = i + W;
        }
      }
      if (value ? size < speck : !touches && size < pinhole)
        for (const i of members) lab[i] = value ? 0 : 1;
    }
    return lab;
  }

  function boxMean(src, w, h, r) {
    const out = new Float32Array(src.length),
      row = new Float32Array(src.length);
    for (let y = 0; y < h; y += 1) {
      const o = y * w;
      let sum = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x += 1) sum += src[o + x];
      for (let x = 0; x < w; x += 1) {
        const lo = Math.max(0, x - r),
          hi = Math.min(w - 1, x + r);
        row[o + x] = sum / (hi - lo + 1);
        if (x + r + 1 < w) sum += src[o + x + r + 1];
        if (x - r >= 0) sum -= src[o + x - r];
      }
    }
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y += 1) sum += row[y * w + x];
      for (let y = 0; y < h; y += 1) {
        const lo = Math.max(0, y - r),
          hi = Math.min(h - 1, y + r);
        out[y * w + x] = sum / (hi - lo + 1);
        if (y + r + 1 < h) sum += row[(y + r + 1) * w + x];
        if (y - r >= 0) sum -= row[(y - r) * w + x];
      }
    }
    return out;
  }

  // Grow the small mask to full size and let the picture's own edges shape it (a guided filter).
  function refineEdge(lab, W, H, rgba, w, h) {
    const n = w * h,
      guide = new Float32Array(n),
      grown = new Float32Array(n);
    for (let i = 0, k = 0; i < n; i += 1, k += 4)
      guide[i] = (0.299 * rgba[k] + 0.587 * rgba[k + 1] + 0.114 * rgba[k + 2]) / 255;
    for (let y = 0, i = 0; y < h; y += 1) {
      const fy = clamp(((y + 0.5) * H) / h - 0.5, 0, H - 1),
        y0 = Math.floor(fy),
        y1 = Math.min(H - 1, y0 + 1),
        ty = fy - y0;
      for (let x = 0; x < w; x += 1, i += 1) {
        const fx = clamp(((x + 0.5) * W) / w - 0.5, 0, W - 1),
          x0 = Math.floor(fx),
          x1 = Math.min(W - 1, x0 + 1),
          tx = fx - x0;
        grown[i] =
          (lab[y0 * W + x0] * (1 - tx) + lab[y0 * W + x1] * tx) * (1 - ty) +
          (lab[y1 * W + x0] * (1 - tx) + lab[y1 * W + x1] * tx) * ty;
      }
    }
    const r = clamp(Math.round(Math.max(w / W, h / H) * 2.5), 2, 16),
      eps = 0.001;
    const meanI = boxMean(guide, w, h, r),
      meanP = boxMean(grown, w, h, r);
    const product = new Float32Array(n),
      square = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      product[i] = guide[i] * grown[i];
      square[i] = guide[i] * guide[i];
    }
    const meanIP = boxMean(product, w, h, r),
      meanII = boxMean(square, w, h, r);
    const slope = new Float32Array(n),
      shift = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = (meanIP[i] - meanI[i] * meanP[i]) / (meanII[i] - meanI[i] * meanI[i] + eps);
      slope[i] = a;
      shift[i] = meanP[i] - a * meanI[i];
    }
    const meanSlope = boxMean(slope, w, h, r),
      meanShift = boxMean(shift, w, h, r),
      alpha = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i += 1)
      alpha[i] = clamp((meanSlope[i] * guide[i] + meanShift[i] - 0.3) / 0.4, 0, 1) * 255;
    return alpha;
  }

  // A plain studio-white or single-color backdrop right around the frame: tracing it is cleaner than modelling it.
  function plainBackdrop(rgba, w, h) {
    const radius = clamp(Math.round(Math.min(w, h) * 0.018), 1, 12);
    const corners = [
      cornerAverage(rgba, w, h, 0, 0, radius),
      cornerAverage(rgba, w, h, w - 1, 0, radius),
      cornerAverage(rgba, w, h, 0, h - 1, radius),
      cornerAverage(rgba, w, h, w - 1, h - 1, radius),
    ];
    let same = 0,
      all = 0;
    const visit = (i) => {
      const k = i * 4;
      all += 1;
      if (rgba[k + 3] <= 8) {
        same += 1;
        return;
      }
      for (const color of corners)
        if (distanceSq(rgba, k, color) <= 256) {
          same += 1;
          return;
        }
    };
    for (let x = 0; x < w; x += 1) {
      visit(x);
      visit((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y += 1) {
      visit(y * w);
      visit(y * w + w - 1);
    }
    return same / Math.max(1, all) >= 0.97;
  }

  /**
   * Local subject cut-out. Returns { alpha, kept }: an alpha mask (255 keeps a pixel) and the share
   * of the picture's visible pixels it keeps. Higher sensitivity removes more.
   */
  function subjectMask(rgba, width, height, options = {}) {
    const { w, h } = validate(rgba, width, height);
    const sensitivity = clamp(Number(options.sensitivity ?? 44), 1, 100);
    const feather = clamp(Number(options.feather ?? 1), 0, 8);
    let alpha;
    if (plainBackdrop(rgba, w, h))
      alpha = edgeBackgroundMask(rgba, w, h, { sensitivity: sensitivity * 0.4, feather: 0 });
    else {
      const small = shrink(rgba, w, h, ANALYSIS_SIDE);
      const lab = tidy(
        grabCut(small.rgb, small.clear, small.W, small.H, ((sensitivity - 44) / 36) * 1.5),
        small.W,
        small.H,
      );
      alpha = refineEdge(lab, small.W, small.H, rgba, w, h);
    }
    if (feather > 0) alpha = blurAlpha(alpha, w, h, feather);
    let visible = 0,
      kept = 0;
    for (let i = 0, k = 3; i < alpha.length; i += 1, k += 4)
      if (rgba[k] > 8) {
        visible += 1;
        kept += alpha[i];
      }
    return { alpha, kept: visible ? kept / visible / 255 : 0 };
  }

  return Object.freeze({
    version: '1.1.0',
    edgeBackgroundMask,
    subjectMask,
    blurAlpha,
  });
});
