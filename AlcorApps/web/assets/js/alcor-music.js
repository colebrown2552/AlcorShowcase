/**
 * alcor-music.js: AlcorMusic editor.
 *
 * Piano roll, score preview, playback and MIDI/MusicXML/WAV export. The engine
 * section is pure logic (no DOM, storage or network) so Node tests can load it alone.
 */
(() => {
  'use strict';
  // <engine> Pure synthesis, interchange and pattern logic. No DOM, no storage, no network.
  // Node tests load everything between the engine markers as one block.
  const SCHEMA = 'alcormusic.project',
    PPQ = 480,
    MAX_PROJECT_BEATS = 100000,
    MAX_MIDI_DELTA = 0x0fffffff,
    MAX_RENDER_SECONDS = 600,
    MAX_RENDER_NOTES = 5000,
    MAX_RENDER_SAMPLE_OPS = 50000000,
    MAX_MUSICXML_NOTES = 100000,
    MAX_MUSICXML_PART_MEASURES = 20000,
    MAX_MUSICXML_WORK = 5000000,
    SCORE_BARS = 5;
  const WAV_RATE = 44100,
    WAV_CHANNELS = 2,
    DRUM_CHANNEL = 10,
    MIX_GAIN = 0.5,
    TAU = Math.PI * 2,
    METERS_N = [2, 3, 4, 5, 6, 7, 9, 12],
    METERS_D = [2, 4, 8, 16];
  // Original Web Audio voices. Each maps to a General MIDI program so MIDI export names the same sound.
  const VOICES = Object.freeze([
    Object.freeze({ program: 0, id: 'piano', name: 'Piano' }),
    Object.freeze({ program: 4, id: 'keys', name: 'Electric piano' }),
    Object.freeze({ program: 11, id: 'mallet', name: 'Vibes' }),
    Object.freeze({ program: 16, id: 'organ', name: 'Organ' }),
    Object.freeze({ program: 25, id: 'pluck', name: 'Pluck guitar' }),
    Object.freeze({ program: 33, id: 'bass', name: 'Bass' }),
    Object.freeze({ program: 89, id: 'pad', name: 'Warm pad' }),
    Object.freeze({ program: 81, id: 'lead', name: 'Saw lead' }),
  ]);
  const GM_FAMILY_VOICE = [
    'piano',
    'mallet',
    'organ',
    'pluck',
    'bass',
    'pad',
    'pad',
    'lead',
    'lead',
    'lead',
    'lead',
    'pad',
    'pad',
    'pluck',
    'mallet',
    'mallet',
  ];
  // Step-grid lanes, top to bottom, on General MIDI percussion keys (channel 10).
  const DRUM_LANES = Object.freeze([
    Object.freeze({ pitch: 49, id: 'crash', name: 'Crash' }),
    Object.freeze({ pitch: 46, id: 'ohh', name: 'Open hat' }),
    Object.freeze({ pitch: 42, id: 'chh', name: 'Closed hat' }),
    Object.freeze({ pitch: 39, id: 'clap', name: 'Clap' }),
    Object.freeze({ pitch: 38, id: 'snare', name: 'Snare' }),
    Object.freeze({ pitch: 48, id: 'tomH', name: 'High tom' }),
    Object.freeze({ pitch: 45, id: 'tomL', name: 'Low tom' }),
    Object.freeze({ pitch: 36, id: 'kick', name: 'Kick' }),
  ]);
  const DRUM_PATTERNS = Object.freeze([
    Object.freeze({
      id: 'rock',
      name: 'Rock',
      steps: { 36: 'x.....x.x.......', 38: '....x.......x...', 42: 'x.x.x.x.x.x.x.x.' },
    }),
    Object.freeze({
      id: 'disco',
      name: 'Four on the floor',
      steps: {
        36: 'x...x...x...x...',
        39: '....x.......x...',
        42: 'x.x.x.x.x.x.x.x.',
        46: '..x...x...x...x.',
      },
    }),
    Object.freeze({
      id: 'halftime',
      name: 'Half time',
      steps: { 36: 'x.........x.....', 38: '........x.......', 42: 'x.x.x.x.x.x.x.x.' },
    }),
    Object.freeze({
      id: 'boombap',
      name: 'Boom bap',
      steps: { 36: 'x......x..x.....', 38: '....x.......x...', 42: 'x.x.x.x.x.x.x.xx' },
    }),
  ]);
  const clampN = (v, a, b, d = a) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
  };
  function hz(p) {
    return 440 * Math.pow(2, (p - 69) / 12);
  }
  function noteName(p) {
    const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
    return names[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  }
  function voiceFor(program) {
    const p = Math.round(clampN(program, 0, 127, 0)),
      exact = VOICES.find((v) => v.program === p);
    if (exact) return exact;
    const id = p === 5 ? 'keys' : GM_FAMILY_VOICE[p >> 3] || 'piano';
    return VOICES.find((v) => v.id === id);
  }
  function drumLane(pitch) {
    const p = Math.round(Number(pitch)),
      i = DRUM_LANES.findIndex((l) => l.pitch === p);
    if (i >= 0) return i;
    const near =
      {
        35: 'kick',
        37: 'snare',
        40: 'snare',
        44: 'chh',
        41: 'tomL',
        43: 'tomL',
        47: 'tomH',
        50: 'tomH',
        51: 'crash',
        52: 'crash',
        53: 'crash',
        55: 'crash',
        57: 'crash',
        59: 'crash',
      }[p] || (p < 38 ? 'kick' : p >= 49 ? 'crash' : 'chh');
    return DRUM_LANES.findIndex((l) => l.id === near);
  }
  function barBeats(time) {
    const n = METERS_N.includes(Number(time?.n)) ? Number(time.n) : 4,
      d = METERS_D.includes(Number(time?.d)) ? Number(time.d) : 4;
    return (n * 4) / d;
  }
  // Loop length: the sketch rounded up to whole bars (at least one bar).
  function songBeats(project) {
    const bar = barBeats(project.time);
    let end = 0;
    for (const t of project.tracks || [])
      for (const n of t.notes || []) end = Math.max(end, Number(n.start) + Number(n.duration));
    return Math.max(1, Math.ceil((end - 1e-9) / bar)) * bar;
  }
  function snapBeat(beat, q) {
    return Math.max(0, Math.round(beat / q) * q);
  }
  // Piano-roll edits as pure transforms; the editor previews them during a drag and commits once.
  function moveNotes(notes, ids, dBeat, dPitch) {
    return notes.map((n) =>
      ids.has(n.id)
        ? {
            ...n,
            start: Math.min(MAX_PROJECT_BEATS, Math.max(0, n.start + dBeat)),
            pitch: Math.min(108, Math.max(21, n.pitch + dPitch)),
          }
        : n,
    );
  }
  function resizeNotes(notes, ids, dBeat, min) {
    return notes.map((n) =>
      ids.has(n.id) ? { ...n, duration: Math.min(64, Math.max(min, n.duration + dBeat)) } : n,
    );
  }
  function notesInBox(notes, b0, b1, p0, p1) {
    const lo = Math.min(b0, b1),
      hi = Math.max(b0, b1),
      pl = Math.min(p0, p1),
      ph = Math.max(p0, p1);
    return notes
      .filter((n) => n.start < hi && n.start + n.duration > lo && n.pitch >= pl && n.pitch <= ph)
      .map((n) => n.id);
  }
  function stepHits(notes, pitch, start, step) {
    const lane = drumLane(pitch);
    return notes
      .map((n, i) =>
        drumLane(n.pitch) === lane && n.start >= start - 1e-6 && n.start < start + step - 1e-6
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
  }
  function patternNotes(id, bars, time = { n: 4, d: 4 }) {
    const pat = DRUM_PATTERNS.find((p) => p.id === id) || DRUM_PATTERNS[0],
      steps = Math.round(barBeats(time) * 4),
      out = [];
    for (let b = 0; b < bars; b++)
      for (let s = 0; s < steps; s++)
        for (const [pitch, row] of Object.entries(pat.steps)) {
          if (row[s % row.length] !== 'x') continue;
          const p = Number(pitch),
            accent = s % 4 === 0;
          out.push({
            pitch: p,
            start: (b * steps) / 4 + s / 4,
            duration: 0.25,
            velocity: p === 42 || p === 46 ? (accent ? 92 : 70) : accent ? 112 : 100,
          });
        }
    return out;
  }
  // ---- synthesis: every voice returns {l,r,pan}; l===r for mono voices ----
  function noiseGen(seed) {
    let s = seed >>> 0 || 0x9e3779b9;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 2147483648 - 1;
    };
  }
  function blep(t, dt) {
    if (t < dt) {
      t /= dt;
      return t + t - t * t - 1;
    }
    if (t > 1 - dt) {
      t = (t - 1) / dt;
      return t * t + t + t + 1;
    }
    return 0;
  }
  function panGains(p) {
    const a = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
    return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
  }
  function shape(buf, rate, attack, gate, rel) {
    const a = Math.max(1, Math.round(attack * rate)),
      d = Math.pow(0.001, 1 / Math.max(1, Math.round(rel * rate)));
    let g = 1;
    for (let i = 0; i < buf.length; i++) {
      let e = i < a ? i / a : 1;
      if (i >= gate) {
        e *= g;
        g *= d;
      }
      buf[i] *= e;
    }
  }
  function partial(buf, freq, amp, tau, rate, phase = 0) {
    if (freq >= rate * 0.45 || amp <= 0) return;
    const w = (TAU * freq) / rate,
      r = Math.exp(-1 / (tau * rate)),
      c = 2 * r * Math.cos(w),
      r2 = r * r,
      n = Math.min(buf.length, Math.ceil(tau * rate * Math.log(amp / 1e-5)));
    let y1 = (amp * Math.sin(phase - w)) / r,
      y2 = (amp * Math.sin(phase - 2 * w)) / r2;
    for (let i = 0; i < n; i++) {
      const y = c * y1 - r2 * y2;
      buf[i] += y;
      y2 = y1;
      y1 = y;
    }
  }
  function vPiano(p, v, gate, rate, seed) {
    const f = hz(p),
      dec = Math.max(0.5, 3.6 - Math.log2(f / 65) * 0.5),
      rel = 0.14,
      len = Math.max(1, Math.min(gate + Math.round(rel * rate), Math.round(dec * 1.4 * rate))),
      buf = new Float32Array(len),
      bright = 0.42 + 0.42 * v;
    for (let k = 1; k <= 14; k++) {
      const fk = f * k * Math.sqrt(1 + 0.0004 * k * k);
      if (fk > rate * 0.42) break;
      const a = Math.pow(k, -1.1) * Math.pow(bright, k - 1),
        tau = dec / 4.5 / (1 + 0.3 * (k - 1));
      partial(buf, fk, a, tau, rate);
      if (k <= 2) partial(buf, fk * 1.0008, a * 0.55, tau * 1.2, rate, 0.4);
    }
    const rnd = noiseGen(seed),
      al = 1 - Math.exp((-TAU * (1200 + 2600 * v)) / rate),
      hn = Math.min(len, Math.round(0.012 * rate));
    let lp = 0;
    for (let i = 0; i < hn; i++) {
      lp += al * (rnd() - lp);
      buf[i] += lp * 0.5 * v * Math.exp(-i / (0.0025 * rate));
    }
    shape(buf, rate, 0.002, gate, rel);
    return { l: buf, r: buf, pan: (p - 64) / 90 };
  }
  function vKeys(p, v, gate, rate) {
    const f = hz(p),
      rel = 0.18,
      dec = Math.max(0.8, 4 - Math.log2(f / 65) * 0.55),
      len = Math.max(1, Math.min(gate + Math.round(rel * rate), Math.round(dec * 1.2 * rate))),
      L = new Float32Array(len),
      R = new Float32Array(len),
      dc = f / rate,
      dt = (f * 14) / rate,
      tine = f * 14 < rate * 0.45,
      I0 = 0.5 + 2.2 * v,
      trem = (TAU * 4.6) / rate;
    let pc = 0,
      pt = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate,
        I = I0 * Math.exp(-t / 0.25) + 0.25,
        y =
          (Math.sin(TAU * pc + I * Math.sin(TAU * pc)) +
            (tine ? Math.sin(TAU * pt) * 0.2 * v * Math.exp(-t / 0.03) : 0)) *
          Math.exp((-t * 4) / dec),
        tr = 0.22 * Math.sin(trem * i);
      L[i] = y * (1 - tr);
      R[i] = y * (1 + tr);
      pc += dc;
      pt += dt;
      if (pc >= 1) pc -= 1;
      if (pt >= 1) pt -= 1;
    }
    shape(L, rate, 0.002, gate, rel);
    shape(R, rate, 0.002, gate, rel);
    return { l: L, r: R, pan: 0 };
  }
  function vMallet(p, v, gate, rate) {
    const f = hz(p),
      dec = Math.max(0.6, 3.2 - Math.log2(f / 130) * 0.5),
      rel = 0.35,
      len = Math.max(1, Math.min(gate + Math.round(rel * rate), Math.round(dec * 1.2 * rate))),
      buf = new Float32Array(len),
      tau = dec / 4;
    partial(buf, f, 1, tau, rate);
    partial(buf, f * 4, 0.28 * (0.5 + v), tau * 0.16, rate);
    partial(buf, f * 10.1, 0.07 * (0.4 + v), tau * 0.05, rate);
    shape(buf, rate, 0.001, gate, rel);
    const L = new Float32Array(len),
      R = new Float32Array(len),
      w = (TAU * 5.4) / rate;
    for (let i = 0; i < len; i++) {
      const m = 0.24 * Math.sin(w * i);
      L[i] = buf[i] * (1 - m);
      R[i] = buf[i] * (1 + m * 0.6);
    }
    return { l: L, r: R, pan: 0.1 };
  }
  function vOrgan(p, v, gate, rate, seed) {
    const f = hz(p),
      rel = 0.05,
      len = Math.max(1, gate + Math.round(rel * rate)),
      buf = new Float32Array(len),
      H = [
        [0.5, 0.35],
        [1, 0.8],
        [2, 0.55],
        [3, 0.38],
        [4, 0.3],
        [6, 0.16],
        [8, 0.1],
      ].filter(([h]) => f * h < rate * 0.42),
      ph = H.map(() => 0),
      vib = (TAU * 6.4) / rate,
      rnd = noiseGen(seed),
      click = Math.round(0.003 * rate);
    for (let i = 0; i < len; i++) {
      const t = i / rate,
        m = 1 + 0.0022 * Math.sin(vib * i);
      let y = 0;
      for (let k = 0; k < H.length; k++) {
        y += Math.sin(TAU * ph[k]) * H[k][1];
        ph[k] += (f * H[k][0] * m) / rate;
        if (ph[k] >= 1) ph[k] -= 1;
      }
      y += Math.sin(TAU * ph[Math.min(3, H.length - 1)]) * 0.35 * Math.exp(-t / 0.22);
      if (i < click) y += rnd() * 0.08 * (1 - i / click);
      buf[i] = y * 0.42;
    }
    shape(buf, rate, 0.006, gate, rel);
    const L = new Float32Array(len),
      R = new Float32Array(len),
      w = (TAU * 0.9) / rate;
    for (let i = 0; i < len; i++) {
      const s = 0.18 * Math.sin(w * i);
      L[i] = buf[i] * (1 - s);
      R[i] = buf[i] * (1 + s);
    }
    return { l: L, r: R, pan: 0 };
  }
  function vPluck(p, v, gate, rate, seed) {
    const f = hz(p),
      D = rate / f - 0.5,
      Di = Math.floor(D),
      fr = D - Di,
      rel = 0.09,
      t60 = Math.max(0.7, Math.min(5, 5.5 - Math.log2(f / 82) * 1.2)),
      g = Math.pow(0.001, 1 / (t60 * f)),
      len = Math.max(1, Math.min(gate + Math.round(rel * rate), Math.round(t60 * rate))),
      buf = new Float32Array(len),
      rnd = noiseGen(seed),
      ex = Math.ceil(D) + 1,
      a = 0.2 + 0.6 * v,
      rd = (k) => (k >= 0 ? buf[k] : 0);
    let lp = 0,
      prev = 0;
    for (let i = 0; i < len; i++) {
      let x = 0;
      if (i < ex) {
        lp += a * (rnd() - lp);
        x = lp;
      }
      const d = (1 - fr) * rd(i - Di) + fr * rd(i - Di - 1),
        y = x + g * 0.5 * (d + prev);
      prev = d;
      buf[i] = y;
    }
    let x1 = 0,
      y1 = 0;
    for (let i = 0; i < len; i++) {
      const y = buf[i] - x1 + 0.995 * y1;
      x1 = buf[i];
      y1 = y;
      buf[i] = y;
    }
    shape(buf, rate, 0.0005, gate, rel);
    return { l: buf, r: buf, pan: -0.15 };
  }
  function vBass(p, v, gate, rate) {
    const f = hz(p),
      rel = 0.07,
      len = Math.max(1, gate + Math.round(rel * rate)),
      buf = new Float32Array(len),
      dt = f / rate;
    let ph = 0,
      l1 = 0,
      l2 = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate,
        saw = 2 * ph - 1 - blep(ph, dt),
        x = 0.62 * Math.sin(TAU * ph) + 0.48 * saw,
        fc = Math.min(8000, f * 1.3 + (250 + 2200 * v) * Math.exp(-t / 0.08)),
        a = 1 - Math.exp((-TAU * fc) / rate);
      l1 += a * (x - l1);
      l2 += a * (l1 - l2);
      buf[i] = Math.tanh(1.6 * l2) * (0.65 + 0.35 * Math.exp(-t / 0.35));
      ph += dt;
      if (ph >= 1) ph -= 1;
    }
    shape(buf, rate, 0.003, gate, rel);
    return { l: buf, r: buf, pan: 0 };
  }
  function vPad(p, v, gate, rate, seed) {
    const f = hz(p),
      rel = 0.9,
      len = Math.max(1, gate + Math.round(rel * rate)),
      out = [
        [-9, 0, 6],
        [-4, 3, 10],
      ].map((cents, ch) => {
        const rnd = noiseGen(seed + ch * 977),
          buf = new Float32Array(len),
          ds = cents.map((c) => (f * Math.pow(2, c / 1200)) / rate),
          ph = cents.map(() => (rnd() + 1) / 2);
        let l1 = 0,
          l2 = 0;
        for (let i = 0; i < len; i++) {
          const t = i / rate;
          let x = 0;
          for (let k = 0; k < 3; k++) {
            x += 2 * ph[k] - 1 - blep(ph[k], ds[k]);
            ph[k] += ds[k];
            if (ph[k] >= 1) ph[k] -= 1;
          }
          const fc = Math.min(
              6000,
              (f * 2.5 + 500 + 900 * v) * (1 + 0.18 * Math.sin(TAU * 0.3 * t + ch)),
            ),
            a = 1 - Math.exp((-TAU * fc) / rate);
          l1 += a * (x / 3 - l1);
          l2 += a * (l1 - l2);
          buf[i] = l2 * (0.8 + 0.2 * Math.exp(-t / 0.6));
        }
        shape(buf, rate, 0.32, gate, rel);
        return buf;
      });
    return { l: out[0], r: out[1], pan: 0 };
  }
  function vLead(p, v, gate, rate) {
    const f = hz(p),
      rel = 0.12,
      len = Math.max(1, gate + Math.round(rel * rate)),
      buf = new Float32Array(len);
    let p1 = 0,
      p2 = 0,
      low = 0,
      band = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate,
        vib = t > 0.25 ? Math.min(1, (t - 0.25) / 0.4) * 0.004 * Math.sin(TAU * 5.6 * t) : 0,
        d1 = (f * (1 + vib)) / rate,
        d2 = d1 * 1.004,
        saw = 2 * p1 - 1 - blep(p1, d1),
        sq = (p2 < 0.5 ? 1 : -1) + blep(p2, d2) - blep((p2 + 0.5) % 1, d2),
        x = 0.55 * saw + 0.32 * sq,
        fc = Math.min(rate / 6, f * 2 + 600 + 2600 * v * Math.exp(-t / 0.3)),
        F = 2 * Math.sin((Math.PI * fc) / rate);
      low += F * band;
      band += F * (x - low - 0.7 * band);
      buf[i] = low * 0.9;
      p1 += d1;
      p2 += d2;
      if (p1 >= 1) p1 -= 1;
      if (p2 >= 1) p2 -= 1;
    }
    shape(buf, rate, 0.008, gate, rel);
    return { l: buf, r: buf, pan: 0.05 };
  }
  const VOICE_FN = {
    piano: vPiano,
    keys: vKeys,
    mallet: vMallet,
    organ: vOrgan,
    pluck: vPluck,
    bass: vBass,
    pad: vPad,
    lead: vLead,
  };
  // Loudness trims measured at C4, velocity 96 (tests/alcormusic-voices.test.cjs keeps them within a few dB of each other).
  const VOICE_GAIN = {
    piano: 0.3,
    keys: 0.54,
    mallet: 0.44,
    organ: 0.63,
    pluck: 1.57,
    bass: 1.04,
    pad: 1.26,
    lead: 0.53,
    drums: 0.6,
  };
  const VOICE_TAIL = {
    piano: 0.14,
    keys: 0.18,
    mallet: 0.35,
    organ: 0.05,
    pluck: 0.09,
    bass: 0.07,
    pad: 0.9,
    lead: 0.12,
  };
  const DRUM_LEN = {
    kick: 0.45,
    snare: 0.45,
    clap: 0.35,
    chh: 0.12,
    ohh: 0.6,
    tomH: 0.5,
    tomL: 0.55,
    crash: 1.6,
  };
  function metal(len, rate, seed) {
    const buf = new Float32Array(len),
      fs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((x) => (x * 1.9) / rate),
      ph = fs.map(() => 0),
      rnd = noiseGen(seed);
    let h1 = 0,
      h2 = 0,
      x1 = 0,
      x2 = 0;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let k = 0; k < 6; k++) {
        s += ph[k] < 0.5 ? 1 : -1;
        ph[k] += fs[k];
        if (ph[k] >= 1) ph[k] -= 1;
      }
      const x = (s / 6) * 0.6 + rnd() * 0.5,
        y = 0.86 * (h1 + x - x1);
      x1 = x;
      h1 = y;
      const z = 0.86 * (h2 + y - x2);
      x2 = y;
      h2 = z;
      buf[i] = z;
    }
    return buf;
  }
  function renderDrum(pitch, v, rate, seed) {
    const lane = DRUM_LANES[drumLane(pitch)] || DRUM_LANES[2],
      id = lane.id,
      len = Math.round(DRUM_LEN[id] * rate),
      rnd = noiseGen(seed);
    let buf = new Float32Array(len),
      pan = 0,
      right = null;
    if (id === 'kick') {
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        ph += (46 + 125 * Math.exp(-t / 0.035)) / rate;
        buf[i] = Math.tanh(
          1.7 * (Math.sin(TAU * ph) * Math.exp(-t / 0.28) + rnd() * 0.35 * Math.exp(-t / 0.0015)),
        );
      }
    } else if (id === 'snare') {
      let lp = 0;
      const a = 1 - Math.exp((-TAU * 1400) / rate);
      for (let i = 0; i < len; i++) {
        const t = i / rate,
          n = rnd();
        lp += a * (n - lp);
        buf[i] =
          (0.6 * Math.sin(TAU * 185 * t) + 0.35 * Math.sin(TAU * 330 * t)) *
            Math.exp(-t / 0.06) *
            0.6 +
          (n - lp) * 0.85 * Math.exp(-t / 0.11);
      }
    } else if (id === 'clap') {
      let low = 0,
        band = 0;
      const F = 2 * Math.sin((Math.PI * 1150) / rate);
      pan = -0.08;
      for (let i = 0; i < len; i++) {
        const t = i / rate,
          n = rnd();
        low += F * band;
        band += F * (n - low - 0.55 * band);
        let e = 0;
        for (let k = 0; k < 3; k++) {
          const s = t - k * 0.011;
          if (s >= 0 && s < 0.012) e = Math.max(e, Math.exp(-s / 0.004));
        }
        if (t >= 0.022) e = Math.max(e, 0.75 * Math.exp(-(t - 0.022) / 0.09));
        buf[i] = band * e * 2.5;
      }
    } else if (id === 'chh' || id === 'ohh') {
      buf = metal(len, rate, seed);
      const d = id === 'chh' ? 0.035 : 0.26;
      pan = 0.28;
      for (let i = 0; i < len; i++) buf[i] *= Math.exp(-i / (d * rate)) * 1.3;
    } else if (id === 'tomH' || id === 'tomL') {
      const f0 = id === 'tomH' ? 175 : 108;
      let ph = 0;
      pan = id === 'tomH' ? 0.22 : -0.2;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        ph += (f0 * (1 + 0.6 * Math.exp(-t / 0.04))) / rate;
        buf[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.24) + rnd() * 0.12 * Math.exp(-t / 0.01);
      }
    } else {
      buf = metal(len, rate, seed);
      right = metal(len, rate, seed + 7);
      pan = -0.2;
      for (let i = 0; i < len; i++) {
        const e = Math.exp(-i / (0.45 * rate)) * 1.1,
          a = Math.min(1, i / (0.002 * rate));
        buf[i] *= e * a;
        right[i] *= e * a;
      }
    }
    const a = Math.max(1, Math.round(0.0008 * rate)),
      f = Math.min(len, Math.round(0.02 * rate));
    for (let i = 0; i < a && i < len; i++) {
      buf[i] *= i / a;
      if (right) right[i] *= i / a;
    }
    for (let i = 0; i < f; i++) {
      const k = i / f,
        j = len - 1 - i;
      buf[j] *= k;
      if (right) right[j] *= k;
    }
    return { l: buf, r: right || buf, pan };
  }
  function renderClick(accent, rate) {
    const len = Math.round(0.05 * rate),
      buf = new Float32Array(len),
      f = accent ? 1760 : 1320;
    for (let i = 0; i < len; i++)
      buf[i] =
        Math.sin((TAU * f * i) / rate) * Math.exp(-i / (0.012 * rate)) * (accent ? 0.5 : 0.32);
    return buf;
  }
  // One stereo render of a note (pan and velocity applied). Live playback and WAV export share it.
  function renderEvent(ev, rate) {
    const v = Math.max(1, Math.min(127, Number(ev.velocity) || 96)) / 127,
      seed = ((ev.pitch * 7919) ^ (Math.round(v * 127) * 131) ^ 0x5bd1e995) >>> 0,
      o = ev.drums
        ? renderDrum(ev.pitch, v, rate, seed)
        : (VOICE_FN[ev.voice] || vPiano)(
            ev.pitch,
            v,
            Math.max(1, Math.round(Math.max(0.03, ev.dur) * rate)),
            rate,
            seed,
          ),
      [gl, gr] = panGains(o.pan || 0),
      k = (VOICE_GAIN[ev.drums ? 'drums' : ev.voice] || 0.6) * (0.12 + 0.88 * v * v),
      l = new Float32Array(o.l.length),
      r = new Float32Array(o.r.length);
    for (let i = 0; i < l.length; i++) {
      l[i] = o.l[i] * gl * k;
      r[i] = o.r[i] * gr * k;
    }
    return { l, r };
  }
  function eventSeconds(ev) {
    return ev.drums
      ? DRUM_LEN[(DRUM_LANES[drumLane(ev.pitch)] || DRUM_LANES[2]).id]
      : Math.max(0.03, ev.dur) + (VOICE_TAIL[ev.voice] || 0.2);
  }
  function projectEvents(project) {
    const spb = 60 / clampN(project.tempo, 30, 260, 120),
      out = [];
    for (const t of project.tracks || []) {
      const drums = t.kind === 'drums',
        voice = drums ? 'drums' : voiceFor(t.program).id,
        gain = clampN(t.volume ?? 0.8, 0, 1, 0.8);
      for (const n of t.notes || [])
        out.push({
          drums,
          voice,
          pitch: Number(n.pitch),
          velocity: Number(n.velocity),
          beat: Number(n.start),
          beats: Number(n.duration),
          start: Number(n.start) * spb,
          dur: Number(n.duration) * spb,
          gain,
        });
    }
    return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }
  // 16-bit PCM WAV at 44.1 kHz stereo, mixed block by block so memory stays near the output size.
  function wavBytes(project) {
    const all = projectEvents(project);
    if (all.length > MAX_RENDER_NOTES)
      throw new Error(`WAV rendering is limited to ${MAX_RENDER_NOTES} notes.`);
    const rate = WAV_RATE;
    let end = 0,
      work = 0;
    for (const e of all) {
      const s = eventSeconds(e);
      end = Math.max(end, e.start + e.dur + 1, e.start + s);
      work += Math.ceil(s * rate);
      if (work > MAX_RENDER_SAMPLE_OPS)
        throw new Error('This score has too many notes to render as a WAV. Export MIDI instead.');
    }
    const dur = Math.max(2, end);
    if (!Number.isFinite(dur) || dur > MAX_RENDER_SECONDS)
      throw new Error(`WAV rendering is limited to ${MAX_RENDER_SECONDS / 60} minutes.`);
    const frames = Math.ceil(dur * rate),
      block = WAV_CHANNELS * 2,
      b = new ArrayBuffer(44 + frames * block),
      v = new DataView(b),
      w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, 36 + frames * block, true);
    w(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, WAV_CHANNELS, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * block, true);
    v.setUint16(32, block, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, frames * block, true);
    const B = rate,
      L = new Float32Array(B),
      R = new Float32Array(B);
    let active = [],
      next = 0;
    for (let b0 = 0; b0 < frames; b0 += B) {
      const n = Math.min(B, frames - b0);
      L.fill(0);
      R.fill(0);
      while (next < all.length && Math.floor(all[next].start * rate) < b0 + n) {
        const e = all[next++],
          o = renderEvent(e, rate);
        active.push({ s: Math.floor(e.start * rate), l: o.l, r: o.r, g: e.gain * MIX_GAIN });
      }
      for (const a of active) {
        const from = Math.max(a.s, b0),
          to = Math.min(a.s + a.l.length, b0 + n);
        for (let i = from; i < to; i++) {
          L[i - b0] += a.l[i - a.s] * a.g;
          R[i - b0] += a.r[i - a.s] * a.g;
        }
      }
      active = active.filter((a) => a.s + a.l.length > b0 + n);
      for (let i = 0; i < n; i++) {
        const o = 44 + (b0 + i) * block;
        v.setInt16(o, Math.round(Math.tanh(L[i]) * 32767), true);
        v.setInt16(o + 2, Math.round(Math.tanh(R[i]) * 32767), true);
      }
    }
    return b;
  }
  const be16 = (n) => [(n >> 8) & 255, n & 255],
    be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  function vlq(n) {
    n = Math.round(Number(n));
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_MIDI_DELTA)
      throw new Error('MIDI event delta is outside the Standard MIDI range.');
    const b = [n % 128];
    while ((n = Math.floor(n / 128)) > 0) b.unshift(n % 128 | 128);
    return b;
  }
  // Drum parts use channel 10; melodic parts take channels 1-9 and 11-16 in order.
  function midiChannels(project) {
    let next = 0;
    return (project.tracks || []).map((t) => {
      if (t.kind === 'drums') return DRUM_CHANNEL - 1;
      const c = next++ % 15;
      return c >= DRUM_CHANNEL - 1 ? c + 1 : c;
    });
  }
  function midiBytes(project) {
    const ev = [],
      chans = midiChannels(project);
    (project.tracks || []).forEach((t, i) => {
      const ch = chans[i];
      if (t.kind !== 'drums')
        ev.push({ t: 0, o: 0, b: [0xc0 | ch, Math.round(clampN(t.program, 0, 127, 0))] });
      for (const n of t.notes || [])
        ev.push(
          { t: Math.round(n.start * PPQ), o: 2, b: [0x90 | ch, n.pitch, n.velocity] },
          { t: Math.round((n.start + n.duration) * PPQ), o: 1, b: [0x80 | ch, n.pitch, 0] },
        );
    });
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const data = [];
    let last = 0;
    for (const e of ev) {
      data.push(...vlq(e.t - last), ...e.b);
      last = e.t;
    }
    data.push(0, 0xff, 0x2f, 0);
    const tempo = Math.round(60000000 / project.tempo),
      time = project.time || {},
      tn = METERS_N.includes(Number(time.n)) ? Number(time.n) : 4,
      td = METERS_D.includes(Number(time.d)) ? Number(time.d) : 4,
      trk = [
        0,
        0xff,
        0x51,
        3,
        (tempo >> 16) & 255,
        (tempo >> 8) & 255,
        tempo & 255,
        0,
        0xff,
        0x58,
        4,
        tn,
        Math.log2(td),
        24,
        8,
        ...data,
      ];
    return new Uint8Array([
      77,
      84,
      104,
      100,
      0,
      0,
      0,
      6,
      0,
      0,
      0,
      1,
      ...be16(PPQ),
      77,
      84,
      114,
      107,
      ...be32(trk.length),
      ...trk,
    ]);
  }
  function readVlq(v, o) {
    let n = 0,
      b;
    do {
      b = v.getUint8(o.i++);
      n = (n << 7) | (b & 127);
    } while (b & 128);
    return n;
  }
  // Reads notes per channel, the first program per channel, the first tempo and the first supported meter.
  function parseMidi(v) {
    if (v.byteLength < 14 || v.getUint32(0) !== 0x4d546864)
      throw new Error('Not a Standard MIDI file.');
    const div = v.getUint16(12);
    if (div & 0x8000) throw new Error('SMPTE MIDI timing is not supported.');
    let pos = 14,
      tempo = 0,
      meter = null;
    const channels = new Map(),
      chan = (c) => {
        if (!channels.has(c)) channels.set(c, { channel: c, program: null, notes: [] });
        return channels.get(c);
      };
    while (pos + 8 <= v.byteLength) {
      const type = v.getUint32(pos),
        len = v.getUint32(pos + 4);
      pos += 8;
      if (type !== 0x4d54726b) {
        pos += len;
        continue;
      }
      const end = pos + len,
        o = { i: pos },
        active = new Map();
      let tick = 0,
        status = 0;
      while (o.i < end) {
        tick += readVlq(v, o);
        let b = v.getUint8(o.i++);
        if (b < 0x80) o.i--;
        else status = b;
        if (status === 0xff) {
          const mt = v.getUint8(o.i++),
            l = readVlq(v, o);
          if (o.i + l <= end) {
            if (mt === 0x51 && l === 3 && !tempo) {
              const us = (v.getUint8(o.i) << 16) | (v.getUint8(o.i + 1) << 8) | v.getUint8(o.i + 2);
              if (us > 0) tempo = Math.min(260, Math.max(30, Math.round(60000000 / us)));
            } else if (mt === 0x58 && l >= 2 && !meter) {
              const n = v.getUint8(o.i),
                dd = 2 ** v.getUint8(o.i + 1);
              if (METERS_N.includes(n) && METERS_D.includes(dd)) meter = { n, d: dd };
            }
          }
          o.i += l;
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          o.i += readVlq(v, o);
          continue;
        }
        const kind = status & 0xf0,
          c = status & 15,
          pitch = v.getUint8(o.i++),
          vel = kind === 0xc0 || kind === 0xd0 ? 0 : v.getUint8(o.i++);
        if (kind === 0xc0) {
          const ch = chan(c);
          if (ch.program === null) ch.program = pitch;
        } else if (kind === 0x90 && vel) {
          active.set(`${c}:${pitch}`, { tick, pitch, vel });
        } else if (kind === 0x80 || (kind === 0x90 && !vel)) {
          const k = `${c}:${pitch}`,
            a = active.get(k);
          if (a) {
            chan(c).notes.push({
              pitch,
              start: a.tick / div,
              duration: Math.max(0.125, (tick - a.tick) / div),
              velocity: a.vel,
            });
            active.delete(k);
          }
        }
      }
      pos = end;
    }
    return {
      tempo,
      meter,
      parts: [...channels.values()]
        .filter((c) => c.notes.length)
        .sort((a, b) => a.channel - b.channel),
    };
  }
  // </engine>
  const root = document.querySelector('[data-alcor-music-editor]');
  if (!root || !globalThis.AlcorApp) return;
  const A = globalThis.AlcorApp,
    C = globalThis.AlcorMusicConfig || {},
    $ = (s, c = root) => c.querySelector(s),
    $$ = (s, c = root) => Array.from(c.querySelectorAll(s));
  const els = {
    name: $('#am-project-name'),
    save: $('#am-save-state'),
    status: $('#am-status'),
    stats: $('#am-stats'),
    tracks: $('#am-track-list'),
    tempo: $('#am-tempo'),
    grid: $('#am-grid'),
    program: $('#am-program'),
    score: $('#am-score'),
    roll: $('#am-roll'),
    scroll: $('.am-roll-scroll'),
    spacer: $('.am-roll-size'),
    rollTitle: $('#am-roll-title'),
    workspace: $('#am-workspace'),
    form: $('#am-note-form'),
    projectFile: $('#am-project-file'),
    midiFile: $('#am-midi-file'),
    caps: $('#am-capabilities'),
    fileMenu: $('#am-file-menu'),
    fileToggle: $('[data-action="toggle-file-menu"]'),
    position: $('#am-position'),
    drumTools: $('#am-drum-tools'),
    play: $('[data-action="play"]'),
    loop: $('[data-action="toggle-loop"]'),
    metronome: $('[data-action="toggle-metronome"]'),
  };
  const ctx = els.roll.getContext('2d');
  let selected = null,
    selection = new Set(),
    audio = null,
    master = null,
    playback = null,
    cursorBeat = 0,
    looping = false,
    clicking = false,
    gesture = null,
    patternIndex = 0,
    frame = 0;
  const make = () => ({
    schema: SCHEMA,
    schemaVersion: 1,
    appVersion: String(C.version || '0.2.0'),
    name: 'Untitled score',
    tempo: 120,
    time: { n: 4, d: 4 },
    tracks: [
      {
        id: A.utils.uid('track'),
        name: 'Piano',
        kind: 'notes',
        program: 0,
        channel: 1,
        volume: 0.8,
        notes: [],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  function norm(v) {
    if (!v || v.schema !== SCHEMA || Number(v.schemaVersion) !== 1)
      throw new Error('Not an AlcorMusic project.');
    const p = make();
    p.name = String(v.name || 'Untitled score').slice(0, 80);
    p.tempo = A.utils.clamp(v.tempo || 120, 30, 260);
    p.time = {
      n: [2, 3, 4, 5, 6, 7, 9, 12].includes(Number(v.time?.n)) ? Number(v.time.n) : 4,
      d: [2, 4, 8, 16].includes(Number(v.time?.d)) ? Number(v.time.d) : 4,
    };
    p.createdAt = v.createdAt || p.createdAt;
    p.updatedAt = v.updatedAt || p.updatedAt;
    const seen = new Set();
    p.tracks = (Array.isArray(v.tracks) ? v.tracks : []).slice(0, 32).map((t, i) => {
      const id = String(t.id || A.utils.uid('track'));
      if (seen.has(id)) throw new Error('Duplicate track id.');
      seen.add(id);
      const ns = new Set(),
        kind = t.kind === 'drums' ? 'drums' : 'notes';
      return {
        id,
        name: String(t.name || `Part ${i + 1}`).slice(0, 80),
        kind,
        program: Math.round(A.utils.clamp(t.program || 0, 0, 127)),
        channel: kind === 'drums' ? 10 : A.utils.clamp(t.channel || i + 1, 1, 16),
        volume: A.utils.clamp(t.volume ?? 0.8, 0, 1),
        notes: (Array.isArray(t.notes) ? t.notes : []).slice(0, 100000).map((n) => {
          const nid = String(n.id || A.utils.uid('note'));
          if (ns.has(nid)) throw new Error('Duplicate note id.');
          ns.add(nid);
          const start = Number(n.start ?? 0);
          if (!Number.isFinite(start) || start < 0 || start > MAX_PROJECT_BEATS)
            throw new Error(`Note start must be between 0 and ${MAX_PROJECT_BEATS} beats.`);
          return {
            id: nid,
            pitch: A.utils.clamp(n.pitch || 60, 21, 108),
            start,
            duration: A.utils.clamp(n.duration || 1, 0.125, 64),
            velocity: A.utils.clamp(n.velocity || 96, 1, 127),
          };
        }),
      };
    });
    if (!p.tracks.length) p.tracks = make().tracks;
    p.activeTrackId = p.tracks.some((t) => t.id === v.activeTrackId)
      ? v.activeTrackId
      : p.tracks[0].id;
    return p;
  }
  const store = A.createProjectStore({
    schema: SCHEMA,
    schemaVersion: 1,
    appVersion: String(C.version || '0.2.0'),
    storageKey: 'alcormusic.project.v1',
    extension: '.alcormusic.json',
    createProject: make,
    normalizeProject: norm,
  });
  const track = () =>
      store.project.tracks.find((t) => t.id === store.project.activeTrackId) ||
      store.project.tracks[0],
    notes = () =>
      store.project.tracks
        .filter((t) => t.kind !== 'drums')
        .flatMap((t) =>
          t.notes.map((n) => ({ ...n, trackId: t.id, trackName: t.name, volume: t.volume })),
        );
  const selectedNote = () => {
    const t = track(),
      n = t.notes.find((x) => x.id === selected);
    return n ? { track: t, note: n } : null;
  };
  const selectedIds = () => {
    const ids = new Set(selection);
    if (selected) ids.add(selected);
    const own = new Set(track().notes.map((n) => n.id));
    return new Set([...ids].filter((id) => own.has(id)));
  };
  const PART_COLORS = ['#ff5ec4', '#53d9d4', '#d7b56d', '#b38cff', '#7ee08a', '#ff9a5e'],
    partColor = (t) =>
      PART_COLORS[Math.max(0, store.project.tracks.indexOf(t)) % PART_COLORS.length];
  function setStatus(x) {
    els.status.textContent = x;
  }
  let toastTimer = 0;
  function toast(x) {
    let t = root.querySelector('.am-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'am-toast';
      t.setAttribute('role', 'status');
      root.appendChild(t);
    }
    t.textContent = x;
    t.setAttribute('data-show', '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.removeAttribute('data-show'), 2600);
  }
  function focusTrack(id) {
    Array.from(els.tracks.children)
      .find((b) => b.dataset.trackId === id)
      ?.focus({ preventScroll: true });
  }
  function partLabel(t) {
    const n = t.notes.length;
    return t.kind === 'drums'
      ? `Drum kit · ${n} hit${n === 1 ? '' : 's'}`
      : `${voiceFor(t.program).name} · ${n} note${n === 1 ? '' : 's'}`;
  }
  function renderTracks() {
    const focused = els.tracks.contains(document.activeElement)
      ? document.activeElement.dataset.trackId
      : null;
    els.tracks.innerHTML = '';
    store.project.tracks.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'am-track';
      b.dataset.action = 'select-track';
      b.dataset.trackId = t.id;
      b.dataset.kind = t.kind;
      b.style.setProperty('--part', partColor(t));
      b.setAttribute('aria-pressed', String(t.id === track().id));
      b.setAttribute('aria-label', `Select part ${t.name}`);
      b.innerHTML = `<strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(partLabel(t))}</span>`;
      if (t.id === track().id) b.classList.add('is-active');
      els.tracks.append(b);
    });
    $$('[data-action="add-track"],[data-action="add-drums"]').forEach(
      (b) => (b.disabled = store.project.tracks.length >= 32),
    );
    $$('[data-action="remove-track"]').forEach(
      (b) => (b.disabled = store.project.tracks.length < 2),
    );
    if (focused) focusTrack(focused);
  }
  function selectTrack(id) {
    if (!store.project.tracks.some((t) => t.id === id)) return;
    selected = null;
    selection = new Set();
    const changed = store.replaceTransient(
      { ...store.project, activeTrackId: id },
      'Part selected',
    );
    render();
    if (changed) store.save(true);
    setStatus(`Selected ${track().name}. New notes go to this part.`);
  }
  function nextChannel(p) {
    const used = new Set(p.tracks.filter((t) => t.kind !== 'drums').map((t) => t.channel));
    for (let c = 1; c <= 16; c++) if (c !== 10 && !used.has(c)) return c;
    return 16;
  }
  function addTrack(kind = 'notes') {
    if (store.project.tracks.length >= 32) {
      setStatus('This sketch is limited to 32 parts.');
      return;
    }
    const id = A.utils.uid('track');
    selected = null;
    selection = new Set();
    mutate(kind === 'drums' ? 'Drum part added' : 'Part added', (p) => {
      const melodic = p.tracks.filter((t) => t.kind !== 'drums').length,
        voice = VOICES[[0, 5, 6, 7, 4, 1, 2, 3][melodic % 8]],
        used = new Set(p.tracks.map((t) => t.name));
      let name = kind === 'drums' ? 'Drums' : voice.name;
      for (let i = 2; used.has(name); i++) name = `${kind === 'drums' ? 'Drums' : voice.name} ${i}`;
      p.tracks.push(
        kind === 'drums'
          ? { id, name, kind: 'drums', program: 0, channel: 10, volume: 0.8, notes: [] }
          : {
              id,
              name,
              kind: 'notes',
              program: voice.program,
              channel: nextChannel(p),
              volume: 0.8,
              notes: [],
            },
      );
      p.activeTrackId = id;
    });
    focusTrack(id);
  }
  function removeTrack() {
    if (store.project.tracks.length < 2) return;
    const t = track();
    stopNotes();
    selected = null;
    selection = new Set();
    mutate(`Removed ${t.name}`, (p) => {
      const i = p.tracks.findIndex((x) => x.id === t.id);
      p.tracks.splice(i, 1);
      p.activeTrackId = p.tracks[Math.max(0, i - 1)].id;
    });
  }
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
  // ---- piano roll / step grid: one viewport-sized canvas over a sized spacer, so keys and ruler stay put ----
  const ZOOMS = [
      { row: 12, beat: 48, step: 24, lane: 34 },
      { row: 16, beat: 72, step: 32, lane: 40 },
      { row: 22, beat: 100, step: 42, lane: 46 },
    ],
    KEYW = 58,
    RULER = 24,
    LOW = 21,
    HIGH = 108,
    coarse = globalThis.matchMedia?.('(pointer:coarse)').matches;
  let zoom = coarse ? 2 : 1;
  function isDrums(t = track()) {
    return t.kind === 'drums';
  }
  function gridStep() {
    return isDrums() ? 0.25 : Number(els.grid.value) || 0.25;
  }
  function geom() {
    const z = ZOOMS[zoom],
      d = isDrums(),
      bar = barBeats(store.project.time),
      beats = Math.max(8 * bar, songBeats(store.project) + 2 * bar),
      beat = d ? z.step * 4 : z.beat,
      row = d ? z.lane : z.row,
      rows = d ? DRUM_LANES.length : HIGH - LOW + 1;
    return { d, bar, beats, beat, row, rows, w: KEYW + beats * beat, h: RULER + rows * row };
  }
  let dpr = 1;
  function sizeRoll(g) {
    const s = els.scroll,
      w = s.clientWidth,
      h = s.clientHeight;
    els.spacer.style.width = `${g.w}px`;
    els.spacer.style.height = `${g.h}px`;
    els.spacer.style.marginTop = `${-h}px`;
    dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(w * dpr)),
      bh = Math.max(1, Math.round(h * dpr));
    if (els.roll.width !== bw || els.roll.height !== bh) {
      els.roll.width = bw;
      els.roll.height = bh;
    }
    els.roll.style.width = `${w}px`;
    els.roll.style.height = `${h}px`;
    els.roll.dataset.geometry = JSON.stringify({
      keyWidth: KEYW,
      ruler: RULER,
      row: g.row,
      beat: g.beat,
      high: HIGH,
      drums: g.d,
      lanes: g.d ? DRUM_LANES.map((l) => l.pitch) : undefined,
    });
  }
  function previewNotes(t) {
    let list = t.notes;
    if (gesture?.mode === 'move' && (gesture.dBeat || gesture.dPitch))
      list = moveNotes(list, gesture.ids, gesture.dBeat, gesture.dPitch);
    else if (gesture?.mode === 'resize' && gesture.dDur)
      list = resizeNotes(list, gesture.ids, gesture.dDur, gesture.min);
    return list;
  }
  function rowOf(n, g) {
    return g.d ? drumLane(n.pitch) : HIGH - n.pitch;
  }
  function renderRoll() {
    frame = 0;
    const g = geom();
    sizeRoll(g);
    const s = els.scroll,
      sx = s.scrollLeft,
      sy = s.scrollTop,
      W = s.clientWidth,
      H = s.clientHeight,
      X = (b) => KEYW + b * g.beat - sx,
      Y = (r) => RULER + r * g.row - sy,
      t = track(),
      ids = selectedIds();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d13';
    ctx.fillRect(0, 0, W, H);
    const r0 = Math.max(0, Math.floor(sy / g.row)),
      r1 = Math.min(g.rows - 1, Math.ceil((sy + H) / g.row));
    for (let r = r0; r <= r1; r++) {
      const y = Y(r);
      if (g.d) ctx.fillStyle = r % 2 ? '#10131b' : '#141824';
      else {
        const p = HIGH - r;
        ctx.fillStyle = [1, 3, 6, 8, 10].includes(p % 12) ? '#0d0f16' : '#141722';
      }
      ctx.fillRect(KEYW, y, W - KEYW, g.row);
      ctx.fillStyle =
        !g.d && (HIGH - r) % 12 === 0 ? 'rgba(246,240,228,.16)' : 'rgba(246,240,228,.05)';
      ctx.fillRect(KEYW, y + g.row - 1, W - KEYW, 1);
    }
    const q = gridStep(),
      b0 = Math.max(0, Math.floor(sx / g.beat)),
      b1 = Math.ceil((sx + W) / g.beat);
    if (q * g.beat >= 7)
      for (let b = b0; b < b1; b += q) {
        if (Math.abs(b - Math.round(b)) < 1e-6) continue;
        ctx.fillStyle = 'rgba(246,240,228,.035)';
        ctx.fillRect(Math.round(X(b)), RULER, 1, H);
      }
    for (let b = b0; b <= b1; b++) {
      const bar = Math.abs(b / g.bar - Math.round(b / g.bar)) < 1e-6;
      ctx.fillStyle = bar ? 'rgba(246,240,228,.24)' : 'rgba(246,240,228,.09)';
      ctx.fillRect(Math.round(X(b)), RULER, 1, H);
    }
    if (looping) {
      const L = songBeats(store.project);
      ctx.fillStyle = 'rgba(255,94,196,.05)';
      ctx.fillRect(X(0), RULER, L * g.beat, H);
      ctx.fillStyle = 'rgba(255,94,196,.6)';
      ctx.fillRect(Math.round(X(L)) - 1, RULER, 2, H);
    }
    if (!g.d)
      for (const o of store.project.tracks) {
        if (o === t || o.kind === 'drums') continue;
        ctx.fillStyle = partColor(o) + '40';
        for (const n of o.notes) {
          const x = X(n.start),
            w = n.duration * g.beat;
          if (x + w < KEYW || x > W) continue;
          const y = Y(rowOf(n, g));
          if (y + g.row < RULER || y > H) continue;
          ctx.fillRect(x + 1, y + 2, Math.max(3, w - 2), g.row - 4);
        }
      }
    const color = partColor(t);
    for (const n of previewNotes(t)) {
      const x = X(n.start),
        y = Y(rowOf(n, g)),
        w = g.d ? g.beat / 4 : Math.max(5, n.duration * g.beat);
      if (x + w < KEYW || x > W || y + g.row < RULER || y > H) continue;
      const on = ids.has(n.id);
      ctx.globalAlpha = g.d ? 0.45 + (0.55 * n.velocity) / 127 : 1;
      ctx.fillStyle = on ? '#f6f0e4' : color;
      if (g.d) {
        ctx.fillRect(x + 2, y + 3, w - 4, g.row - 6);
      } else {
        ctx.fillRect(x + 1, y + 1, w - 2, g.row - 2);
        ctx.globalAlpha = 1;
        if (on) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, w - 2, g.row - 2);
        }
        if (w > 18) {
          ctx.fillStyle = on ? 'rgba(11,13,19,.55)' : 'rgba(11,13,19,.4)';
          ctx.fillRect(x + w - 6, y + 3, 2, g.row - 6);
        }
      }
      ctx.globalAlpha = 1;
    }
    if (gesture?.mode === 'box') {
      ctx.strokeStyle = '#f6f0e4';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      const x0 = X(gesture.b0),
        x1 = X(gesture.b1),
        y0 = Y(HIGH - gesture.p0) + (gesture.p0 >= gesture.p1 ? 0 : g.row),
        y1 = Y(HIGH - gesture.p1) + (gesture.p1 > gesture.p0 ? 0 : g.row);
      ctx.strokeRect(
        Math.min(x0, x1) + 0.5,
        Math.min(y0, y1) + 0.5,
        Math.abs(x1 - x0),
        Math.abs(y1 - y0),
      );
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(246,240,228,.06)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    const head = playheadBeat(),
      hx = X(head);
    if (hx >= KEYW && hx <= W) {
      ctx.fillStyle = '#ff5ec4';
      ctx.fillRect(Math.round(hx) - 1, RULER, 2, H);
    }
    ctx.fillStyle = '#090a0f';
    ctx.fillRect(KEYW, 0, W - KEYW, RULER);
    ctx.fillStyle = 'rgba(246,240,228,.14)';
    ctx.fillRect(KEYW, RULER - 1, W - KEYW, 1);
    ctx.font = '600 11px system-ui,sans-serif';
    ctx.textBaseline = 'middle';
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(X(b));
      if (Math.abs(b / g.bar - Math.round(b / g.bar)) < 1e-6) {
        ctx.fillStyle = 'rgba(246,240,228,.5)';
        ctx.fillRect(x, 6, 1, RULER - 7);
        ctx.fillStyle = '#d7b56d';
        ctx.fillText(String(Math.round(b / g.bar) + 1), x + 4, RULER / 2);
      } else {
        ctx.fillStyle = 'rgba(246,240,228,.22)';
        ctx.fillRect(x, RULER - 7, 1, 6);
      }
    }
    if (hx >= KEYW && hx <= W) {
      ctx.fillStyle = '#ff5ec4';
      ctx.beginPath();
      ctx.moveTo(hx - 6, RULER - 9);
      ctx.lineTo(hx + 6, RULER - 9);
      ctx.lineTo(hx, RULER - 1);
      ctx.fill();
    }
    ctx.fillStyle = '#090a0f';
    ctx.fillRect(0, RULER, KEYW, H);
    for (let r = r0; r <= r1; r++) {
      const y = Y(r);
      if (g.d) {
        ctx.fillStyle = r % 2 ? '#151925' : '#1a1f2d';
        ctx.fillRect(0, y, KEYW - 1, g.row - 1);
        ctx.fillStyle = '#f6f0e4';
        ctx.font = '600 11px system-ui,sans-serif';
        ctx.fillText(DRUM_LANES[r].name, 6, y + g.row / 2, KEYW - 10);
        continue;
      }
      const p = HIGH - r,
        black = [1, 3, 6, 8, 10].includes(p % 12);
      ctx.fillStyle = black ? '#1b1e27' : '#e9e2d3';
      ctx.fillRect(0, y, black ? KEYW * 0.62 : KEYW - 1, g.row - 1);
      if (black) {
        ctx.fillStyle = '#e9e2d3';
        ctx.fillRect(KEYW * 0.62, y, KEYW * 0.38 - 1, g.row - 1);
      }
      const named = p % 12 === 0 || g.row >= 16;
      if (named && g.row >= 10) {
        ctx.font = `${p % 12 === 0 ? '700' : '500'} ${Math.min(11, g.row - 3)}px system-ui,sans-serif`;
        ctx.fillStyle = black ? '#f6f0e4' : p % 12 === 0 ? '#0b0d13' : '#5b5548';
        ctx.fillText(noteName(p), black ? 4 : KEYW - 30, y + g.row / 2);
      }
    }
    ctx.fillStyle = 'rgba(246,240,228,.18)';
    ctx.fillRect(KEYW - 1, RULER, 1, H);
    ctx.fillStyle = '#090a0f';
    ctx.fillRect(0, 0, KEYW, RULER);
    ctx.fillStyle = 'rgba(246,240,228,.45)';
    ctx.font = '700 10px system-ui,sans-serif';
    ctx.fillText(g.d ? 'STEPS' : 'KEYS', 6, RULER / 2);
    els.roll.dataset.playhead = head.toFixed(3);
  }
  function scheduleRoll() {
    if (!frame) frame = requestAnimationFrame(renderRoll);
  }
  function renderScore() {
    const svg = els.score;
    while (svg.lastChild && svg.lastChild.tagName !== 'title') svg.removeChild(svg.lastChild);
    const NS = 'http://www.w3.org/2000/svg',
      add = (tag, a = {}, text = '') => {
        const n = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
        if (text) n.textContent = text;
        svg.append(n);
        return n;
      };
    add('rect', { x: 0, y: 0, width: 1200, height: 520, fill: '#fbfaf5' });
    for (const base of [125, 285])
      for (let i = 0; i < 5; i++)
        add('line', {
          x1: 70,
          y1: base + i * 14,
          x2: 1140,
          y2: base + i * 14,
          stroke: '#202020',
          'stroke-width': 1,
        }); // Original SVG curves keep staff clefs visible without a music-glyph font.
    add('path', {
      'data-clef': 'treble',
      'aria-label': 'Treble (G) clef',
      role: 'img',
      d: 'M104 219 C135 216 123 181 118 156 C114 137 101 113 112 95 C117 86 124 94 124 105 C124 127 95 138 88 156 C80 178 103 191 119 181 C136 169 121 149 105 157 C95 162 98 174 108 175',
      fill: 'none',
      stroke: '#161616',
      'stroke-width': 3.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    add('path', {
      'data-clef': 'bass',
      'aria-label': 'Bass (F) clef',
      role: 'img',
      d: 'M90 299 C90 283 114 285 114 301 C114 317 100 330 88 335 C103 325 107 316 107 303 C107 292 99 291 94 294',
      fill: 'none',
      stroke: '#161616',
      'stroke-width': 3.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    add('circle', { cx: 90, cy: 299, r: 3.5, fill: '#161616', 'data-clef-dot': 'bass-anchor' });
    for (const y of [292, 306])
      add('circle', { cx: 128, cy: y, r: 3.5, fill: '#161616', 'data-clef-dot': 'bass' });
    for (let bar = 0; bar <= SCORE_BARS; bar++) {
      const x = 180 + bar * 192;
      add('line', { x1: x, y1: 125, x2: x, y2: 341, stroke: '#666', 'stroke-width': 1 });
    }
    const barBeats = (store.project.time.n * 4) / store.project.time.d,
      steps = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6],
      step = (p) => Math.floor(p / 12) * 7 + steps[p % 12];
    const all = notes()
      .filter((n) => n.start < SCORE_BARS * barBeats)
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    for (const n of all.slice(0, 500)) {
      const bar = Math.floor(n.start / barBeats),
        x = 196 + bar * 192 + ((n.start - bar * barBeats) * 160) / barBeats,
        treble = n.pitch >= 60,
        base = treble ? 153 : 313,
        y = base - (step(n.pitch) - step(treble ? 71 : 50)) * 7,
        ink =
          n.id === selected &&
          (!store.project.activeTrackId || n.trackId === store.project.activeTrackId)
            ? '#547aa8'
            : '#111';
      for (let l = base + 42; l <= y + 1; l += 14)
        add('line', { x1: x - 12, y1: l, x2: x + 12, y2: l, stroke: '#202020', 'stroke-width': 1 });
      for (let l = base - 42; l >= y - 1; l -= 14)
        add('line', { x1: x - 12, y1: l, x2: x + 12, y2: l, stroke: '#202020', 'stroke-width': 1 });
      if ([1, 3, 6, 8, 10].includes(n.pitch % 12))
        add('text', { x: x - 24, y: y + 6, 'font-size': 18, fill: ink }, '♯');
      add('ellipse', {
        cx: x,
        cy: y,
        rx: 7,
        ry: 5,
        fill: n.duration >= 2 ? '#fbfaf5' : ink,
        stroke: ink,
        'stroke-width': 1.5,
        transform: `rotate(-18 ${x} ${y})`,
      });
      if (n.duration < 4) {
        const up = y >= base;
        add('line', {
          x1: up ? x + 6 : x - 6,
          y1: y,
          x2: up ? x + 6 : x - 6,
          y2: up ? y - 34 : y + 34,
          stroke: ink,
          'stroke-width': 1.5,
        });
      }
    }
  }
  function renderForm() {
    const x = selectedNote(),
      f = els.form.elements;
    const dur = x ? String(x.note.duration) : '1';
    if (!Array.from(f.duration.options).some((o) => o.value === dur)) {
      const o = document.createElement('option');
      o.value = dur;
      o.textContent = `${Number(dur)} beats`;
      o.dataset.custom = '';
      f.duration.append(o);
    }
    if (!x) {
      f.pitch.value = 60;
      f.start.value = 0;
      f.duration.value = 1;
      f.velocity.value = 96;
      return;
    }
    f.pitch.value = x.note.pitch;
    f.start.value = x.note.start;
    f.duration.value = dur;
    f.velocity.value = x.note.velocity;
  }
  function renderTools() {
    const t = track(),
      d = isDrums(t);
    if (!els.program.options.length)
      els.program.innerHTML =
        VOICES.map((v) => `<option value="${v.program}">${escapeHtml(v.name)}</option>`).join('') +
        '<option value="drums" disabled>Drum kit</option>';
    if (d) els.program.value = 'drums';
    else {
      const v = voiceFor(t.program);
      els.program.value = String(
        VOICES.some((x) => x.program === t.program) ? t.program : v.program,
      );
    }
    els.program.disabled = d;
    els.grid.disabled = d;
    els.drumTools.hidden = !d;
    els.rollTitle.textContent = d
      ? `${t.name.toUpperCase()} · tap a step to add or remove a hit`
      : `${t.name.toUpperCase()} · ${coarse ? 'tap to add · drag to move · drag the right edge to resize · hold then drag to select' : 'click to add · drag to move · drag the right edge to resize · drag empty space to select'}`;
    const n = selectedIds().size;
    $$('[data-action="delete-selection"]').forEach((b) => (b.disabled = !n));
    els.loop.setAttribute('aria-pressed', String(looping));
    els.metronome.setAttribute('aria-pressed', String(clicking));
    $$('[data-action="zoom-in"]').forEach((b) => (b.disabled = zoom >= ZOOMS.length - 1));
    $$('[data-action="zoom-out"]').forEach((b) => (b.disabled = zoom <= 0));
  }
  function render() {
    if (!selectedNote()) selected = null;
    els.name.value = store.project.name;
    els.tempo.value = store.project.tempo;
    renderTracks();
    renderTools();
    renderRoll();
    renderScore();
    renderForm();
    const all = store.project.tracks.reduce((n, t) => n + t.notes.length, 0);
    els.stats.textContent = `${store.project.tracks.length} part${store.project.tracks.length === 1 ? '' : 's'} · ${all} note${all === 1 ? '' : 's'}`;
    const h = store.state();
    $$('[data-action="undo"]').forEach((b) => (b.disabled = !h.canUndo));
    $$('[data-action="redo"]').forEach((b) => (b.disabled = !h.canRedo));
  }
  store.on('change', (e) => {
    els.save.textContent = e.label || 'Changed';
    if (playback) playback.events = liveEvents();
    render();
  });
  store.on(
    'saved',
    (e) => (els.save.textContent = e.automatic ? 'Autosaved locally' : 'Saved locally'),
  );
  function mutate(label, fn) {
    store.mutate(label, fn);
    setStatus(label);
  }
  function addNote(pitch = 60, start = 0, duration = 1, velocity = 96) {
    const id = A.utils.uid('note'),
      trackId = track().id;
    start = A.utils.clamp(start, 0, MAX_PROJECT_BEATS);
    mutate('Note added', (p) =>
      p.tracks.find((t) => t.id === trackId).notes.push({ id, pitch, start, duration, velocity }),
    );
    selected = id;
    selection = new Set([id]);
    render();
  }
  function del() {
    const x = selectedNote(),
      ids = selectedIds();
    if (x) ids.add(x.note.id);
    if (!ids.size) return;
    const trackId = track().id;
    mutate(ids.size > 1 ? `${ids.size} notes deleted` : 'Note deleted', (p) => {
      const t = p.tracks.find((t) => t.id === trackId);
      t.notes = t.notes.filter((n) => !ids.has(n.id));
    });
    selected = null;
    selection = new Set();
    render();
  }
  function demo() {
    const d = make(),
      uid = () => A.utils.uid('note');
    d.name = 'Alcor theme sketch';
    d.tempo = 100;
    d.tracks[0].notes = [
      [76, 0, 1],
      [74, 1, 0.5],
      [72, 1.5, 0.5],
      [67, 2, 1],
      [72, 3, 1],
      [74, 4, 1.5],
      [71, 5.5, 0.5],
      [67, 6, 1],
      [71, 7, 1],
      [72, 8, 1],
      [76, 9, 1],
      [81, 10, 1.5],
      [79, 11.5, 0.5],
      [77, 12, 1],
      [76, 13, 1],
      [72, 14, 2],
    ].map(([pitch, start, duration]) => ({ id: uid(), pitch, start, duration, velocity: 96 }));
    d.tracks.push(
      {
        id: A.utils.uid('track'),
        name: 'Bass',
        kind: 'notes',
        program: 33,
        channel: 2,
        volume: 0.8,
        notes: [
          [48, 0, 2],
          [55, 2, 2],
          [43, 4, 2],
          [50, 6, 2],
          [45, 8, 2],
          [52, 10, 2],
          [41, 12, 2],
          [48, 14, 2],
        ].map(([pitch, start, duration]) => ({ id: uid(), pitch, start, duration, velocity: 84 })),
      },
      {
        id: A.utils.uid('track'),
        name: 'Drums',
        kind: 'drums',
        program: 0,
        channel: 10,
        volume: 0.7,
        notes: [
          { pitch: 49, start: 0, duration: 0.25, velocity: 96 },
          ...patternNotes('rock', 4),
        ].map((n) => ({ ...n, id: uid() })),
      },
    );
    d.activeTrackId = d.tracks[0].id;
    store.replace(d, 'Demo loaded', true);
    selected = null;
    selection = new Set();
    render();
    focusRoll();
  }
  function focusRoll() {
    const g = geom(),
      s = els.scroll;
    if (g.d) {
      s.scrollTop = 0;
      return;
    }
    let hi = 0,
      lo = 127;
    for (const n of track().notes) {
      hi = Math.max(hi, n.pitch);
      lo = Math.min(lo, n.pitch);
    }
    if (hi < lo) hi = lo = 60;
    const top = (HIGH - Math.min(HIGH, hi)) * g.row,
      bottom = (HIGH - Math.max(LOW, lo)) * g.row + g.row,
      view = s.clientHeight - RULER;
    s.scrollTop = Math.max(0, Math.min(top - g.row, (top + bottom - view) / 2));
    scheduleRoll();
  }
  // ---- audio: every note is rendered by the engine voices into a buffer, then scheduled ----
  function ac() {
    if (!audio) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      audio = new AC();
      master = audio.createGain();
      master.gain.value = 1 / 3;
      const shaper = audio.createWaveShaper(),
        curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++)
        curve[i] = Math.tanh(3 * ((i / (curve.length - 1)) * 2 - 1));
      shaper.curve = curve;
      master.connect(shaper).connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume?.();
    return audio;
  }
  // Rendered notes are cached least-recently-used, capped by total length (about 45 MB of audio).
  const buffers = new Map(),
    sources = new Set(),
    MAX_CACHE_FRAMES = 6000000;
  let cachedFrames = 0;
  function eventBuffer(ev) {
    const c = ac(),
      key = `${ev.drums ? 'd' : ev.voice}|${ev.pitch}|${ev.velocity}|${ev.drums ? 0 : Math.round(ev.dur * 200)}`;
    let b = buffers.get(key);
    if (b) {
      buffers.delete(key);
      buffers.set(key, b);
      return b;
    }
    const o = renderEvent(ev, c.sampleRate);
    b = c.createBuffer(2, o.l.length, c.sampleRate);
    b.getChannelData(0).set(o.l);
    b.getChannelData(1).set(o.r);
    buffers.set(key, b);
    cachedFrames += b.length;
    for (const [k, old] of buffers) {
      if (cachedFrames <= MAX_CACHE_FRAMES || k === key) break;
      buffers.delete(k);
      cachedFrames -= old.length;
    }
    return b;
  }
  function startBuffer(buffer, when, gain) {
    const c = ac(),
      src = c.createBufferSource(),
      g = c.createGain();
    src.buffer = buffer;
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.onended = () => {
      sources.delete(src);
      g.disconnect();
    };
    sources.add(src);
    src.start(Math.max(c.currentTime, when));
    return src;
  }
  function sound(n, when = 0, dur = 0.5, vol = 0.8, t = track()) {
    try {
      const c = ac(),
        drums = t.kind === 'drums';
      startBuffer(
        eventBuffer({
          drums,
          voice: drums ? 'drums' : voiceFor(t.program).id,
          pitch: n.pitch,
          velocity: n.velocity ?? 96,
          dur,
        }),
        c.currentTime + when,
        vol * MIX_GAIN,
      );
    } catch {}
  }
  let clickBuffers = null;
  function stopNotes() {
    for (const s of sources)
      try {
        s.stop();
      } catch {}
    sources.clear();
  }
  function playheadBeat() {
    if (!playback || !audio) return cursorBeat;
    const p = playback,
      u = Math.max(p.b0, (audio.currentTime - p.t0) / p.spb + p.b0);
    return p.loop ? u % p.loop : u;
  }
  function liveEvents() {
    const spb = 60 / store.project.tempo;
    return projectEvents(store.project).map((e) => ({ ...e, dur: e.beats * spb }));
  }
  function tick() {
    const p = playback;
    if (!p) return;
    const c = audio,
      to = (c.currentTime + 0.3 - p.t0) / p.spb + p.b0,
      from = p.cursor;
    if (to <= from) return;
    p.cursor = to;
    const evs = p.events,
      fire = (e, u) => {
        const when = p.t0 + (u - p.b0) * p.spb;
        if (when >= c.currentTime - 0.02) startBuffer(eventBuffer(e), when, e.gain * MIX_GAIN);
      },
      clicks = (a, b, off) => {
        if (!clicking) return;
        for (let k = Math.ceil(a - 1e-9); k < b; k++) {
          const accent = Math.abs(k / p.bar - Math.round(k / p.bar)) < 1e-6,
            when = p.t0 + (k + off - p.b0) * p.spb;
          if (when >= c.currentTime - 0.02) startBuffer(clickBuffers[accent ? 1 : 0], when, 0.8);
        }
      };
    if (p.loop) {
      for (let k = Math.floor(from / p.loop); k * p.loop < to; k++) {
        const base = k * p.loop,
          a = Math.max(from - base, 0),
          b = Math.min(to - base, p.loop);
        if (b <= a) continue;
        for (const e of evs) if (e.beat >= a && e.beat < b) fire(e, base + e.beat);
        clicks(a, b, base);
      }
    } else {
      for (const e of evs) if (e.beat >= from && e.beat < to) fire(e, e.beat);
      clicks(from, Math.min(to, p.end), 0);
      if (from > p.end + 2) stop();
    }
  }
  function animate() {
    if (!playback) return;
    const b = playheadBeat(),
      g = geom(),
      s = els.scroll,
      x = KEYW + b * g.beat - s.scrollLeft;
    if (x > s.clientWidth * 0.85 || x < KEYW)
      s.scrollLeft = Math.max(0, b * g.beat - (s.clientWidth - KEYW) * 0.15);
    const bar = Math.floor(b / g.bar),
      beat = Math.floor(b - bar * g.bar);
    els.position.textContent = `${bar + 1}.${beat + 1}`;
    renderRoll();
    playback.raf = requestAnimationFrame(animate);
  }
  function play(from) {
    const c = ac();
    if (playback) pause();
    if (!clickBuffers)
      clickBuffers = [0, 1].map((a) => {
        const d = renderClick(a, c.sampleRate),
          b = c.createBuffer(2, d.length, c.sampleRate);
        b.getChannelData(0).set(d);
        b.getChannelData(1).set(d);
        return b;
      });
    const spb = 60 / store.project.tempo,
      loop = looping ? songBeats(store.project) : 0;
    let b0 = from ?? cursorBeat;
    const end = songBeats(store.project);
    if (loop ? b0 >= loop : b0 >= end) b0 = 0;
    const events = liveEvents();
    for (const e of events) if (e.beat >= b0 && e.beat < b0 + 1) eventBuffer(e);
    playback = {
      t0: c.currentTime + 0.08,
      b0,
      cursor: b0,
      spb,
      loop,
      end,
      bar: barBeats(store.project.time),
      events,
      timer: setInterval(tick, 25),
      raf: 0,
    };
    tick();
    playback.raf = requestAnimationFrame(animate);
    root.dataset.playing = 'true';
    els.play.textContent = '❚❚ Pause';
    els.play.setAttribute('aria-label', 'Pause');
    setStatus(loop ? 'Playing on a loop' : 'Playing');
  }
  function pause() {
    if (!playback) return;
    cursorBeat = playheadBeat();
    clearInterval(playback.timer);
    cancelAnimationFrame(playback.raf);
    playback = null;
    stopNotes();
    delete root.dataset.playing;
    els.play.textContent = '▶ Play';
    els.play.setAttribute('aria-label', 'Play');
    renderRoll();
    setStatus('Paused');
  }
  function stop() {
    pause();
    cursorBeat = 0;
    els.position.textContent = '1.1';
    els.scroll.scrollLeft = 0;
    renderRoll();
    setStatus('Stopped');
  }
  function restartIfPlaying() {
    if (playback) {
      const b = playheadBeat();
      pause();
      play(b);
    }
  }
  function exportMidi() {
    try {
      A.utils.download(
        new Blob([midiBytes(store.project)], { type: 'audio/midi' }),
        `${A.utils.safeName(store.project.name)}.mid`,
      );
      setStatus('MIDI exported');
    } catch (e) {
      setStatus(e?.message || 'MIDI export failed');
    }
  }
  function musicXmlProject(project) {
    const step = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'],
      alter = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
    const beats = [2, 3, 4, 5, 6, 7, 9, 12].includes(Number(project.time?.n))
        ? Number(project.time.n)
        : 4,
      beatType = [2, 4, 8, 16].includes(Number(project.time?.d)) ? Number(project.time.d) : 4,
      measureTicks = Math.round((PPQ * beats * 4) / beatType);
    const melodic = Array.isArray(project.tracks)
        ? project.tracks.filter((t) => t && t.kind !== 'drums')
        : [],
      sourceTracks = melodic.length ? melodic : [{ name: 'Piano', notes: [] }],
      totalNotes = sourceTracks.reduce(
        (count, t) => count + (Array.isArray(t.notes) ? t.notes.length : 0),
        0,
      );
    if (totalNotes > MAX_MUSICXML_NOTES)
      throw new Error(`MusicXML export is limited to ${MAX_MUSICXML_NOTES} notes.`);
    const tracks = sourceTracks.map((t, i) => ({
      name: String(t.name || `Part ${i + 1}`),
      events: (Array.isArray(t.notes) ? t.notes : [])
        .map((n) => {
          const start = Math.max(0, Math.round(Number(n.start || 0) * PPQ)),
            duration = Math.max(1, Math.round(Number(n.duration || 1) * PPQ));
          return { pitch: Number(n.pitch) || 60, start, duration, end: start + duration };
        })
        .sort((a, b) => a.start - b.start || a.pitch - b.pitch),
    }));
    let endTick = 0;
    for (const t of tracks) for (const e of t.events) endTick = Math.max(endTick, e.end);
    const measureCount = Math.max(1, Math.ceil(endTick / measureTicks));
    if (measureCount * tracks.length > MAX_MUSICXML_PART_MEASURES)
      throw new Error('This score is too long to export as MusicXML. Try a shorter section.');
    const pitchXml = (p) =>
      `<pitch><step>${step[((p % 12) + 12) % 12]}</step>${alter[((p % 12) + 12) % 12] ? '<alter>1</alter>' : ''}<octave>${Math.floor(p / 12) - 1}</octave></pitch>`;
    const partList = tracks
      .map(
        (t, i) =>
          `<score-part id="P${i + 1}"><part-name>${escapeHtml(t.name)}</part-name></score-part>`,
      )
      .join('');
    let musicXmlWork = 0;
    const parts = tracks
      .map((t, partIndex) => {
        const voiceEnds = [];
        for (const e of t.events) {
          let voice = voiceEnds.findIndex((end) => end <= e.start);
          if (voice < 0) {
            voice = voiceEnds.length;
            voiceEnds.push(0);
          }
          voiceEnds[voice] = e.end;
          e.voice = voice + 1;
        }
        const voiceCount = Math.max(1, voiceEnds.length);
        musicXmlWork += t.events.length * measureCount * voiceCount;
        if (musicXmlWork > MAX_MUSICXML_WORK)
          throw new Error(
            'This score has too many notes to export as MusicXML. Try a shorter section.',
          );
        let measures = '';
        for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
          const measureStart = measureIndex * measureTicks,
            measureEnd = measureStart + measureTicks;
          let body = '';
          for (let voice = 1; voice <= voiceCount; voice++) {
            if (voice > 1) body += `<backup><duration>${measureTicks}</duration></backup>`;
            const segments = t.events
              .filter((e) => e.voice === voice && e.start < measureEnd && e.end > measureStart)
              .map((e) => ({
                event: e,
                start: Math.max(e.start, measureStart) - measureStart,
                end: Math.min(e.end, measureEnd) - measureStart,
              }))
              .sort((a, b) => a.start - b.start || a.event.pitch - b.event.pitch);
            if (!segments.length && voiceCount === 1) {
              body += `<note><rest/><duration>${measureTicks}</duration><voice>1</voice></note>`;
              continue;
            }
            let cursor = 0;
            for (const s of segments) {
              if (s.start > cursor)
                body += `<forward><duration>${s.start - cursor}</duration></forward>`;
              const duration = Math.max(1, s.end - s.start),
                tieStop = s.event.start < measureStart,
                tieStart = s.event.end > measureEnd,
                ties = `${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}`,
                notations =
                  tieStop || tieStart
                    ? `<notations>${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}</notations>`
                    : '';
              body += `<note>${pitchXml(s.event.pitch)}<duration>${duration}</duration>${ties}<voice>${voice}</voice>${notations}</note>`;
              cursor = s.end;
            }
            if (cursor < measureTicks)
              body += `<forward><duration>${measureTicks - cursor}</duration></forward>`;
          }
          const attributes =
              measureIndex === 0
                ? `<attributes><divisions>${PPQ}</divisions><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`
                : '',
            qpm = Number(project.tempo) || 120,
            direction =
              measureIndex === 0
                ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${qpm}</per-minute></metronome></direction-type><sound tempo="${qpm}"/></direction>`
                : '';
          measures += `<measure number="${measureIndex + 1}">${attributes}${direction}${body}</measure>`;
        }
        return `<part id="P${partIndex + 1}">${measures}</part>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${escapeHtml(project.name || 'Untitled score')}</work-title></work><part-list>${partList}</part-list>${parts}</score-partwise>`;
  }
  function xml() {
    return musicXmlProject(store.project);
  }
  function exportXml() {
    try {
      A.utils.download(
        new Blob([xml()], { type: 'application/vnd.recordare.musicxml+xml' }),
        `${A.utils.safeName(store.project.name)}.musicxml`,
      );
      setStatus(
        store.project.tracks.some((t) => t.kind === 'drums')
          ? 'MusicXML exported (drum parts are left out)'
          : 'MusicXML exported',
      );
    } catch (e) {
      setStatus(e?.message || 'MusicXML export failed');
    }
  }
  function wavBlob() {
    return new Blob([wavBytes(store.project)], { type: 'audio/wav' });
  }
  function exportWav() {
    setStatus('Rendering WAV…');
    setTimeout(() => {
      try {
        A.utils.download(wavBlob(), `${A.utils.safeName(store.project.name)}.wav`);
        setStatus('WAV rendered locally');
      } catch (e) {
        setStatus(e?.message || 'WAV render failed');
      }
    }, 20);
  }
  async function importMidi(file) {
    if (!file || file.size > 10 * 1024 * 1024) throw new Error('MIDI file is too large.');
    const m = parseMidi(new DataView(await file.arrayBuffer()));
    const total = m.parts.reduce((n, p) => n + p.notes.length, 0);
    if (!total) throw new Error('No note events found.');
    const d = make();
    d.name = file.name.replace(/\.midi?$/i, '');
    if (m.tempo) d.tempo = m.tempo;
    if (m.meter) d.time = m.meter;
    let budget = 100000;
    d.tracks = m.parts.slice(0, 32).map((p, i) => {
      const drums = p.channel === DRUM_CHANNEL - 1,
        voice = voiceFor(p.program ?? 0),
        list = p.notes.slice(0, Math.max(0, budget));
      budget -= list.length;
      return {
        id: i === 0 ? d.tracks[0].id : A.utils.uid('track'),
        name: drums
          ? 'Drums'
          : m.parts.length === 1
            ? voice.name
            : `${voice.name} (ch ${p.channel + 1})`,
        kind: drums ? 'drums' : 'notes',
        program: p.program ?? 0,
        channel: p.channel + 1,
        volume: 0.8,
        notes: list.map((n) => ({ id: A.utils.uid('note'), ...n })),
      };
    });
    d.activeTrackId = (d.tracks.find((t) => t.kind !== 'drums') || d.tracks[0]).id;
    store.replace(d, 'MIDI imported', true);
    selected = null;
    render();
    focusRoll();
    setStatus(
      `${total} MIDI notes imported into ${d.tracks.length} part${d.tracks.length === 1 ? '' : 's'}`,
    );
  }
  // ---- pointer editing: tap/click adds, drag moves, right edge resizes, empty drag (mouse) or hold-then-drag (touch) box-selects ----
  function locate(e) {
    const r = els.roll.getBoundingClientRect(),
      g = geom(),
      s = els.scroll,
      vx = e.clientX - r.left,
      vy = e.clientY - r.top,
      beat = (vx - KEYW + s.scrollLeft) / g.beat,
      row = Math.floor((vy - RULER + s.scrollTop) / g.row);
    return {
      g,
      vx,
      vy,
      beat,
      row,
      pitch: g.d ? (DRUM_LANES[row]?.pitch ?? null) : HIGH - row,
      zone: vy < RULER ? 'ruler' : vx < KEYW ? 'keys' : 'grid',
    };
  }
  function noteAt(loc) {
    const t = track();
    if (loc.g.d) return null;
    const edge = (coarse ? 14 : 7) / loc.g.beat;
    const hit = (n) =>
      n.pitch === loc.pitch && loc.beat >= n.start && loc.beat <= n.start + n.duration;
    let n = [...t.notes].reverse().find(hit);
    if (n)
      return {
        note: n,
        track: t,
        edge: loc.beat >= n.start + n.duration - edge && n.duration * loc.g.beat >= 12,
      };
    for (const o of store.project.tracks) {
      if (o === t || o.kind === 'drums') continue;
      n = o.notes.find(hit);
      if (n) return { note: n, track: o, edge: false };
    }
    return null;
  }
  function tapEmpty(loc) {
    if (loc.g.d) {
      toggleStep(loc);
      return;
    }
    if (loc.pitch < LOW || loc.pitch > HIGH) return;
    if (selectedIds().size > 1) {
      selected = null;
      selection = new Set();
      render();
      return;
    }
    const q = gridStep(),
      start = Math.max(0, Math.floor(loc.beat / q + 1e-9) * q);
    addNote(loc.pitch, start, q * 2, 96);
    sound({ pitch: loc.pitch, velocity: 96 }, 0, (q * 2 * 60) / store.project.tempo);
  }
  function toggleStep(loc) {
    if (loc.pitch == null) return;
    const t = track(),
      step = 0.25,
      start = Math.max(0, Math.floor(loc.beat / step + 1e-9) * step),
      hits = stepHits(t.notes, loc.pitch, start, step),
      trackId = t.id;
    if (hits.length) {
      const ids = new Set(hits.map((i) => t.notes[i].id));
      mutate('Drum hit removed', (p) => {
        const x = p.tracks.find((t) => t.id === trackId);
        x.notes = x.notes.filter((n) => !ids.has(n.id));
      });
    } else {
      const id = A.utils.uid('note'),
        accent = Math.abs(start - Math.round(start)) < 1e-6;
      mutate('Drum hit added', (p) =>
        p.tracks
          .find((t) => t.id === trackId)
          .notes.push({ id, pitch: loc.pitch, start, duration: step, velocity: accent ? 110 : 92 }),
      );
      sound({ pitch: loc.pitch, velocity: 100 }, 0, 0.2);
    }
    return !hits.length;
  }
  els.roll.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const loc = locate(e),
      touch = e.pointerType === 'touch';
    setFileMenu(false);
    if (loc.zone === 'ruler') {
      const b = Math.max(0, snapBeat(loc.beat, loc.g.d ? 0.25 : gridStep()));
      if (playback) play(b);
      else {
        cursorBeat = b;
        renderRoll();
      }
      gesture = { mode: 'seek', id: e.pointerId, touch };
      els.roll.setPointerCapture?.(e.pointerId);
      return;
    }
    if (loc.zone === 'keys') {
      if (loc.pitch != null) sound({ pitch: loc.pitch, velocity: 100 }, 0, 0.6);
      return;
    }
    const hit = noteAt(loc);
    if (hit) {
      if (hit.track.id !== track().id) {
        selectTrack(hit.track.id);
      }
      const id = hit.note.id;
      if (e.shiftKey) {
        selection = selectedIds();
        if (selection.has(id) && !hit.edge) selection.delete(id);
        else selection.add(id);
        selected = selection.has(id) ? id : [...selection][0] || null;
      } else if (!selectedIds().has(id)) {
        selection = new Set([id]);
        selected = id;
      } else selected = id;
      gesture = {
        mode: hit.edge ? 'resize' : 'move',
        id: e.pointerId,
        touch,
        lock: true,
        x: e.clientX,
        y: e.clientY,
        loc,
        ids: selectedIds(),
        dBeat: 0,
        dPitch: 0,
        dDur: 0,
        min: Math.min(gridStep(), 0.25),
        moved: false,
        note: hit.note,
        heard: hit.note.pitch,
      };
      els.roll.setPointerCapture?.(e.pointerId);
      render();
      if (!hit.edge) sound(hit.note, 0, 0.35);
      return;
    }
    if (loc.g.d && !touch) {
      const added = toggleStep(loc);
      gesture = {
        mode: 'paint',
        id: e.pointerId,
        touch,
        lastStep: Math.floor(loc.beat * 4),
        lastRow: loc.row,
        paint: added ? 'on' : 'off',
      };
      els.roll.setPointerCapture?.(e.pointerId);
      return;
    }
    gesture = {
      mode: 'pending',
      id: e.pointerId,
      touch,
      x: e.clientX,
      y: e.clientY,
      loc,
      lock: false,
      b0: loc.beat,
      b1: loc.beat,
      p0: loc.pitch,
      p1: loc.pitch,
    };
    if (touch && !loc.g.d) {
      gesture.timer = setTimeout(() => {
        if (gesture?.mode === 'pending') {
          gesture.mode = 'box';
          gesture.lock = true;
          navigator.vibrate?.(12);
          setStatus('Drag to select notes');
          renderRoll();
        }
      }, 450);
    } else if (!touch) els.roll.setPointerCapture?.(e.pointerId);
  });
  els.roll.addEventListener('pointermove', (e) => {
    const g0 = gesture;
    if (!g0 || g0.id !== e.pointerId) {
      if (!g0 && e.pointerType === 'mouse') {
        const loc = locate(e),
          hit = loc.zone === 'grid' && noteAt(loc);
        els.roll.style.cursor =
          loc.zone !== 'grid'
            ? 'pointer'
            : hit
              ? hit.edge
                ? 'ew-resize'
                : 'grab'
              : loc.g.d
                ? 'pointer'
                : 'crosshair';
      }
      return;
    }
    const loc = locate(e),
      dx = e.clientX - g0.x,
      dy = e.clientY - g0.y;
    if (g0.mode === 'seek') {
      cursorBeat = Math.max(0, snapBeat(loc.beat, gridStep()));
      if (!playback) renderRoll();
      return;
    }
    if (g0.mode === 'paint') {
      const s = Math.floor(loc.beat * 4);
      if (s !== g0.lastStep || loc.row !== g0.lastRow) {
        g0.lastStep = s;
        g0.lastRow = loc.row;
        const t = track(),
          hit = loc.pitch != null && stepHits(t.notes, loc.pitch, s / 4, 0.25).length > 0;
        if (loc.pitch != null && (g0.paint === 'on') !== hit) toggleStep(loc);
      }
      return;
    }
    if (g0.mode === 'pending') {
      if (Math.hypot(dx, dy) > (g0.touch ? 10 : 5)) {
        clearTimeout(g0.timer);
        if (g0.touch) {
          gesture = null;
          return;
        }
        if (g0.loc.g.d) {
          gesture = null;
          return;
        }
        g0.mode = 'box';
      } else return;
    }
    if (g0.mode === 'box') {
      g0.b1 = loc.beat;
      g0.p1 = Math.max(LOW, Math.min(HIGH, loc.pitch));
      const t = track(),
        ids = notesInBox(t.notes, g0.b0, g0.b1, g0.p0, g0.p1);
      selection = new Set(ids);
      selected = ids[0] || null;
      scheduleRoll();
      return;
    }
    const q = gridStep(),
      g = loc.g;
    g0.moved = g0.moved || Math.hypot(dx, dy) > 3;
    if (g0.mode === 'move') {
      g0.dBeat = Math.round(dx / g.beat / q) * q;
      g0.dPitch = -Math.round(dy / g.row);
      const minStart = Math.min(
        ...track()
          .notes.filter((n) => g0.ids.has(n.id))
          .map((n) => n.start),
      );
      if (minStart + g0.dBeat < 0) g0.dBeat = -minStart;
      const p = g0.note.pitch + g0.dPitch;
      if (p !== g0.heard && p >= LOW && p <= HIGH) {
        g0.heard = p;
        sound({ pitch: p, velocity: g0.note.velocity }, 0, 0.25);
      }
    } else {
      const end = g0.note.start + g0.note.duration + dx / g.beat;
      g0.dDur = Math.max(q, Math.round(end / q) * q - g0.note.start) - g0.note.duration;
    }
    scheduleRoll();
  });
  els.roll.addEventListener(
    'touchmove',
    (e) => {
      if (gesture?.lock && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
  els.roll.addEventListener('contextmenu', (e) => e.preventDefault());
  function endGesture(e, cancel) {
    const g0 = gesture;
    if (!g0 || g0.id !== e.pointerId) return;
    clearTimeout(g0.timer);
    gesture = null;
    try {
      els.roll.releasePointerCapture?.(e.pointerId);
    } catch {}
    if (cancel) {
      render();
      return;
    }
    if (g0.mode === 'pending') {
      tapEmpty(g0.loc);
      return;
    }
    if (g0.mode === 'box') {
      setStatus(
        selection.size
          ? `${selection.size} note${selection.size === 1 ? '' : 's'} selected`
          : 'Nothing selected',
      );
      render();
      return;
    }
    if (g0.mode === 'move' || g0.mode === 'resize') {
      const trackId = track().id;
      if (g0.mode === 'move' && (g0.dBeat || g0.dPitch))
        mutate(g0.ids.size > 1 ? `${g0.ids.size} notes moved` : 'Note moved', (p) => {
          const t = p.tracks.find((t) => t.id === trackId);
          t.notes = moveNotes(t.notes, g0.ids, g0.dBeat, g0.dPitch);
        });
      else if (g0.mode === 'resize' && g0.dDur)
        mutate('Note resized', (p) => {
          const t = p.tracks.find((t) => t.id === trackId);
          t.notes = resizeNotes(t.notes, g0.ids, g0.dDur, g0.min);
        });
      else if (!g0.moved && !e.shiftKey && g0.ids.size > 1) {
        selection = new Set([g0.note.id]);
        selected = g0.note.id;
      }
      render();
      return;
    }
    render();
  }
  els.roll.addEventListener('pointerup', (e) => endGesture(e, false));
  els.roll.addEventListener('pointercancel', (e) => endGesture(e, true));
  function fitRoll() {
    if (!globalThis.matchMedia?.('(max-width:760px)').matches) {
      root.style.removeProperty('--am-roll-h');
      return;
    }
    const top = els.scroll.getBoundingClientRect().top + (globalThis.scrollY || 0);
    root.style.setProperty(
      '--am-roll-h',
      `${Math.max(300, Math.round(globalThis.innerHeight - top - 10))}px`,
    );
  }
  const refit = () => {
    fitRoll();
    scheduleRoll();
  };
  fitRoll();
  globalThis.addEventListener('resize', refit);
  globalThis.addEventListener('load', refit);
  requestAnimationFrame(refit);
  document.fonts?.ready?.then(refit);
  els.scroll.addEventListener('scroll', scheduleRoll, { passive: true });
  if (globalThis.ResizeObserver) new ResizeObserver(scheduleRoll).observe(els.scroll);
  else globalThis.addEventListener('resize', scheduleRoll);
  els.form.addEventListener('input', (e) => {
    const x = selectedNote();
    if (!x) return;
    const name = e.target.name,
      val = Number(e.target.value);
    mutate('Note changed', (p) => {
      const n = p.tracks.find((t) => t.id === x.track.id)?.notes.find((n) => n.id === x.note.id);
      if (!n) return;
      if (name === 'pitch') n.pitch = A.utils.clamp(val, 21, 108);
      if (name === 'start') n.start = A.utils.clamp(val, 0, MAX_PROJECT_BEATS);
      if (name === 'duration') n.duration = A.utils.clamp(val, 0.125, 64);
      if (name === 'velocity') n.velocity = A.utils.clamp(val, 1, 127);
    });
  });
  els.name.addEventListener('input', () =>
    mutate('Score renamed', (p) => (p.name = els.name.value.slice(0, 80))),
  );
  els.tempo.addEventListener('change', () => {
    mutate('Tempo changed', (p) => (p.tempo = A.utils.clamp(els.tempo.value, 30, 260)));
    restartIfPlaying();
  });
  els.program.addEventListener('change', () => {
    const t = track(),
      program = Number(els.program.value);
    if (t.kind === 'drums' || !Number.isFinite(program)) return;
    const auto =
        VOICES.some((v) => t.name === v.name || t.name.startsWith(`${v.name} `)) ||
        /^Part \d+$/.test(t.name),
      v = voiceFor(program),
      used = new Set(store.project.tracks.filter((x) => x !== t).map((x) => x.name));
    let name = v.name;
    for (let i = 2; used.has(name); i++) name = `${v.name} ${i}`;
    mutate(`Sound: ${v.name}`, (p) => {
      const x = p.tracks.find((x) => x.id === t.id);
      x.program = program;
      if (auto) x.name = name;
    });
    const ns = track().notes,
      mid = ns.length ? ns[Math.floor(ns.length / 2)].pitch : 60;
    sound({ pitch: mid, velocity: 100 }, 0, 0.6);
  });
  els.grid.addEventListener('change', renderRoll);
  // File labels need their default picker activation before hiding. Fence their
  // deferred close so it cannot dismiss a menu the user has opened again.
  let fileMenuEpoch = 0;
  function setFileMenu(open) {
    if (!els.fileMenu) return;
    fileMenuEpoch++;
    els.fileMenu.toggleAttribute('data-open', open);
    els.fileToggle?.setAttribute('aria-expanded', String(open));
  }
  document.addEventListener('pointerdown', (e) => {
    if (
      els.fileMenu?.hasAttribute('data-open') &&
      !els.fileMenu.contains(e.target) &&
      !els.fileToggle?.contains(e.target)
    )
      setFileMenu(false);
  });
  root.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action],.aa-file-button'),
      a = button?.dataset.action;
    if (button && els.fileMenu?.contains(button)) {
      if (a) setFileMenu(false);
      else {
        const epoch = fileMenuEpoch;
        setTimeout(() => {
          if (epoch === fileMenuEpoch) setFileMenu(false);
        }, 0);
      }
    }
    if (!a) return;
    if (a === 'toggle-file-menu') {
      setFileMenu(!els.fileMenu.hasAttribute('data-open'));
      return;
    }
    if (a === 'select-track') {
      selectTrack(button.dataset.trackId);
      focusTrack(button.dataset.trackId);
      focusRoll();
    } else if (a === 'new-project') {
      stop();
      store.replace(make(), 'New score', true);
      selected = null;
      selection = new Set();
    } else if (a === 'load-demo') {
      stop();
      demo();
    } else if (a === 'save-browser') {
      const ok = store.save(false),
        m = ok ? 'Saved to this browser' : 'Could not save in this browser';
      setStatus(m);
      toast(m);
    } else if (a === 'export-project') store.exportFile(store.project.name);
    else if (a === 'undo') store.undo();
    else if (a === 'redo') store.redo();
    else if (a === 'add-note') addNote(60, 0, 1, 96);
    else if (a === 'delete-note' || a === 'delete-selection') del();
    else if (a === 'duplicate-note') {
      const x = selectedNote();
      if (x)
        addNote(x.note.pitch, x.note.start + x.note.duration, x.note.duration, x.note.velocity);
    } else if (a === 'audition-note') {
      const x = selectedNote();
      if (x) sound(x.note, 0, 0.5);
    } else if (a === 'play') {
      if (playback) pause();
      else play();
    } else if (a === 'stop') stop();
    else if (a === 'toggle-loop') {
      looping = !looping;
      restartIfPlaying();
      setStatus(
        looping
          ? `Loop on: bars 1-${Math.round(songBeats(store.project) / barBeats(store.project.time))}`
          : 'Loop off',
      );
    } else if (a === 'toggle-metronome') {
      clicking = !clicking;
      setStatus(clicking ? 'Metronome on' : 'Metronome off');
    } else if (a === 'zoom-in' || a === 'zoom-out') {
      const s = els.scroll,
        g = geom(),
        mid = (s.scrollLeft + (s.clientWidth - KEYW) / 2) / g.beat,
        row = (s.scrollTop + (s.clientHeight - RULER) / 2) / g.row;
      zoom = Math.max(0, Math.min(ZOOMS.length - 1, zoom + (a === 'zoom-in' ? 1 : -1)));
      const n = geom();
      renderRoll();
      s.scrollLeft = Math.max(0, mid * n.beat - (s.clientWidth - KEYW) / 2);
      s.scrollTop = Math.max(0, row * n.row - (s.clientHeight - RULER) / 2);
    } else if (a === 'drum-preset') {
      const t = track();
      if (t.kind !== 'drums') return;
      const pat = DRUM_PATTERNS[patternIndex++ % DRUM_PATTERNS.length],
        bars = Math.max(2, Math.round(songBeats(store.project) / barBeats(store.project.time))),
        trackId = t.id;
      mutate(`Beat: ${pat.name}`, (p) => {
        p.tracks.find((x) => x.id === trackId).notes = patternNotes(pat.id, bars, p.time).map(
          (n) => ({ ...n, id: A.utils.uid('note') }),
        );
      });
      if (!playback) play(0);
    } else if (a === 'export-midi') exportMidi();
    else if (a === 'export-musicxml') exportXml();
    else if (a === 'export-wav') exportWav();
    else if (a === 'print-score') print();
    else if (a === 'add-track') addTrack();
    else if (a === 'add-drums') addTrack('drums');
    else if (a === 'remove-track') removeTrack();
    render();
  });
  // View switcher: an ARIA tablist (role=tab, aria-selected, one roving tab stop, arrow/Home/End keys) over one panel, the workspace.
  {
    const tabs = $$('.am-tabs [data-view]'),
      list = $('.am-tabs');
    if (list) {
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-label', 'Editor view');
    }
    if (els.workspace) {
      els.workspace.setAttribute('role', 'tabpanel');
    }
    const selectTab = (b, focus) => {
      for (const x of tabs) {
        const on = x === b;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
      }
      if (els.workspace) {
        els.workspace.dataset.view = b.dataset.view;
        els.workspace.setAttribute('aria-labelledby', b.id);
      }
      if (focus) b.focus();
      scheduleRoll();
    };
    tabs.forEach((b, i) => {
      b.type = 'button';
      b.setAttribute('role', 'tab');
      if (!b.id) b.id = 'am-view-tab-' + b.dataset.view;
      b.setAttribute('aria-controls', 'am-workspace');
      const on = b.getAttribute('aria-selected') === 'true';
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && els.workspace) els.workspace.setAttribute('aria-labelledby', b.id);
      b.addEventListener('click', () => selectTab(b));
      b.addEventListener('keydown', (e) => {
        const k = {
          ArrowRight: i + 1,
          ArrowDown: i + 1,
          ArrowLeft: i - 1,
          ArrowUp: i - 1,
          Home: 0,
          End: tabs.length - 1,
        }[e.key];
        if (k === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        selectTab(tabs[(k + tabs.length) % tabs.length], true);
      });
    });
    // The sheet preview scrolls on small screens; keyboard users can focus it to scroll.
    const score = $('.am-score-pane');
    if (score) {
      score.tabIndex = 0;
      score.setAttribute('role', 'region');
      score.setAttribute('aria-label', 'Sheet preview');
    }
  }
  els.projectFile.addEventListener('change', async () => {
    try {
      const f = els.projectFile.files[0];
      if (f) store.openText(await f.text());
      selected = null;
      selection = new Set();
      render();
      focusRoll();
      setStatus('Project opened');
    } catch (e) {
      setStatus(e.message);
    } finally {
      els.projectFile.value = '';
    }
  });
  els.midiFile.addEventListener('change', async () => {
    try {
      await importMidi(els.midiFile.files[0]);
    } catch (e) {
      setStatus(e.message);
    } finally {
      els.midiFile.value = '';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setFileMenu(false);
      if (selection.size || selected) {
        selected = null;
        selection = new Set();
        render();
      }
    }
    if (/INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '')) return;
    if (e.code === 'Space' && e.target?.tagName !== 'BUTTON') {
      e.preventDefault();
      if (playback) pause();
      else play();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      del();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === 'a' &&
      (e.target === els.roll || e.target === document.body)
    ) {
      e.preventDefault();
      selection = new Set(track().notes.map((n) => n.id));
      selected = [...selection][0] || null;
      render();
    }
    const arrows = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[
      e.key
    ];
    if (
      arrows &&
      (e.target === els.roll || e.target === document.body) &&
      selectedIds().size &&
      !isDrums()
    ) {
      e.preventDefault();
      const ids = selectedIds(),
        trackId = track().id,
        db = arrows[0] * gridStep(),
        dp = arrows[1] * (e.shiftKey ? 12 : 1);
      mutate('Notes nudged', (p) => {
        const t = p.tracks.find((t) => t.id === trackId);
        t.notes = moveNotes(t.notes, ids, db, dp);
      });
    }
  });
  const caps = A.detectCapabilities(),
    capLabels = {
      localStorage: 'Autosave',
      webAudio: 'Playback',
      offlineAudio: 'WAV export',
      canvas: 'Piano roll',
      printing: 'Print',
    };
  {
    const missing = Object.entries(capLabels).filter(([k]) => !caps[k]);
    els.caps.innerHTML = missing
      .map(([, l]) => `<li><span>${l}</span><strong>not available</strong></li>`)
      .join('');
    const capPanel = els.caps.closest('#am-capabilities-panel') || els.caps.parentElement;
    capPanel.hidden = missing.length === 0;
  }
  if (!store.load()) demo();
  else {
    render();
    focusRoll();
  }
  fitRoll();
  renderRoll();
  focusRoll();
})();
