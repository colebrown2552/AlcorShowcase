/**
 * alcor-photo-raster.js: AlcorPhoto versioned pixel storage.
 *
 * Copy-on-write 256 px tiles for painted layers and masks: an edit copies only
 * the tiles it touched, so undo history grows with the change, not the image.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlcorPhotoRaster = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Versioned pixel storage for painted layers and masks.
  //
  // A version is an immutable picture: an optional base drawable (an imported
  // image) plus a sparse map of 256 px tiles that override it. Editing a
  // version copies only the tiles a stroke touched, so undo history costs
  // memory in proportion to what changed, not to the image size. Every version
  // id is a source id the project can reference, and undo simply points the
  // layer back at an older id.

  const TILE = 256;
  const TILE_BYTES = TILE * TILE * 4;
  const ID_PATTERN = /^px-[a-z0-9-]{6,90}$/;

  function randomId() {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `px-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
  }

  function defaultBudget(deviceMemory) {
    const gb = Number(deviceMemory);
    if (gb >= 8) return 1536 * 1024 * 1024;
    if (gb >= 4) return 768 * 1024 * 1024;
    if (gb > 0) return 320 * 1024 * 1024;
    return 768 * 1024 * 1024;
  }

  function createRasterStore(options = {}) {
    const createCanvas = options.createCanvas;
    if (typeof createCanvas !== 'function') throw new Error('A canvas factory is required.');
    const budgetBytes = Math.max(
      TILE_BYTES * 16,
      Number(options.budgetBytes) || defaultBudget(globalThis.navigator?.deviceMemory),
    );
    const maxComposed = Math.max(1, Number(options.maxComposed) || 4);
    const versions = new Map();
    const composed = new Map(); // id -> canvas, insertion order = LRU
    const encoded = new Map(); // id -> Blob
    const pins = new Map(); // id -> count; pinned versions survive retain() (e.g. while saving)
    let tileBytes = 0;

    const context2d = (canvas) => {
      const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
      if (!context) throw new Error('Canvas 2D is unavailable for pixel editing.');
      return context;
    };

    function tileCount(version) {
      return { columns: Math.ceil(version.width / TILE), rows: Math.ceil(version.height / TILE) };
    }

    function validateSize(width, height) {
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 16384 ||
        height > 16384 ||
        width * height > 64 * 1024 * 1024
      ) {
        throw new Error('Pixel layers are limited to 16,384 pixels per side and 64 megapixels.');
      }
    }

    function create({ width, height, baseId = null, id = null } = {}) {
      validateSize(width, height);
      const versionId = id && ID_PATTERN.test(id) && !versions.has(id) ? id : randomId();
      versions.set(versionId, {
        id: versionId,
        width,
        height,
        baseId: baseId || null,
        tiles: new Map(),
      });
      return versionId;
    }

    function info(id) {
      const version = versions.get(id);
      return version
        ? {
            id,
            width: version.width,
            height: version.height,
            baseId: version.baseId,
            tiles: version.tiles.size,
          }
        : null;
    }

    function touchComposed(id, canvas) {
      composed.delete(id);
      composed.set(id, canvas);
      while (composed.size > maxComposed) composed.delete(composed.keys().next().value);
    }

    // Full-size picture for a version, rebuilt from base + tiles when evicted.
    function canvasFor(id, resolveBase) {
      const version = versions.get(id);
      if (!version) return null;
      const cached = composed.get(id);
      if (cached) {
        touchComposed(id, cached);
        return cached;
      }
      const canvas = createCanvas(version.width, version.height);
      const context = context2d(canvas);
      if (version.baseId) {
        const base = typeof resolveBase === 'function' ? resolveBase(version.baseId) : null;
        if (!base) return null;
        context.drawImage(base, 0, 0, version.width, version.height);
      }
      const { columns } = tileCount(version);
      for (const [index, tile] of version.tiles) {
        const x = (index % columns) * TILE,
          y = Math.floor(index / columns) * TILE;
        context.clearRect(x, y, TILE, TILE);
        context.drawImage(tile, x, y);
      }
      touchComposed(id, canvas);
      return canvas;
    }

    // Record a new version whose pixels are `canvas`, sharing untouched tiles with `parentId`.
    function commit(parentId, canvas, dirty) {
      const parent = versions.get(parentId);
      if (!parent)
        throw new Error('The pixel layer this edit started from is no longer available.');
      if (canvas.width !== parent.width || canvas.height !== parent.height)
        throw new Error('Edited pixels do not match the layer size.');
      const { columns, rows } = tileCount(parent);
      const x0 = Math.max(0, Math.floor((dirty?.x ?? 0) / TILE));
      const y0 = Math.max(0, Math.floor((dirty?.y ?? 0) / TILE));
      const x1 = Math.min(
        columns - 1,
        Math.floor(((dirty?.x ?? 0) + (dirty?.width ?? parent.width) - 1) / TILE),
      );
      const y1 = Math.min(
        rows - 1,
        Math.floor(((dirty?.y ?? 0) + (dirty?.height ?? parent.height) - 1) / TILE),
      );
      const tiles = new Map(parent.tiles);
      let added = 0;
      for (let ty = y0; ty <= y1; ty += 1) {
        for (let tx = x0; tx <= x1; tx += 1) {
          const tile = createCanvas(TILE, TILE);
          const context = context2d(tile);
          context.drawImage(canvas, tx * TILE, ty * TILE, TILE, TILE, 0, 0, TILE, TILE);
          tiles.set(ty * columns + tx, tile);
          added += 1;
        }
      }
      const id = randomId();
      versions.set(id, {
        id,
        width: parent.width,
        height: parent.height,
        baseId: parent.baseId,
        tiles,
      });
      tileBytes += added * TILE_BYTES;
      touchComposed(id, canvas);
      return id;
    }

    // Record a completely new picture (paste, filter output, rasterize).
    function fromCanvas(canvas) {
      const id = create({ width: canvas.width, height: canvas.height });
      const version = versions.get(id);
      const { columns, rows } = tileCount(version);
      for (let ty = 0; ty < rows; ty += 1) {
        for (let tx = 0; tx < columns; tx += 1) {
          const tile = createCanvas(TILE, TILE);
          context2d(tile).drawImage(canvas, tx * TILE, ty * TILE, TILE, TILE, 0, 0, TILE, TILE);
          version.tiles.set(ty * columns + tx, tile);
          tileBytes += TILE_BYTES;
        }
      }
      touchComposed(id, canvas);
      return id;
    }

    function uniqueTiles(ids) {
      const set = new Set();
      for (const id of ids) {
        const version = versions.get(id);
        if (version) for (const tile of version.tiles.values()) set.add(tile);
      }
      return set;
    }

    // Drop every version not in `live`; recompute memory from what remains.
    function retain(live) {
      const keep = live instanceof Set ? live : new Set(live || []);
      let freed = 0;
      for (const id of [...versions.keys()]) {
        if (keep.has(id) || pins.has(id)) continue;
        versions.delete(id);
        composed.delete(id);
        encoded.delete(id);
        freed += 1;
      }
      tileBytes = uniqueTiles(versions.keys()).size * TILE_BYTES;
      return freed;
    }

    function stats() {
      let composedBytes = 0;
      for (const canvas of composed.values()) composedBytes += canvas.width * canvas.height * 4;
      return Object.freeze({
        versions: versions.size,
        tileBytes,
        composedBytes,
        budgetBytes,
        overBudget: tileBytes > budgetBytes,
      });
    }

    // Bytes that dropping `ids` (and only them) would free.
    function bytesHeldBy(ids, live) {
      const others = uniqueTiles([...live].filter((id) => !ids.includes(id)));
      let bytes = 0;
      for (const tile of uniqueTiles(ids)) if (!others.has(tile)) bytes += TILE_BYTES;
      return bytes;
    }

    async function encode(id, resolveBase, encodeCanvas) {
      if (encoded.has(id)) return encoded.get(id);
      const canvas = canvasFor(id, resolveBase);
      if (!canvas)
        throw new Error(
          versions.has(id)
            ? 'A painted layer’s original image is missing, so it could not be saved.'
            : 'A painted layer version was released before it could be saved.',
        );
      const blob = await encodeCanvas(canvas);
      if (versions.has(id)) encoded.set(id, blob);
      return blob;
    }

    return Object.freeze({
      TILE,
      TILE_BYTES,
      isRasterId: (id) => ID_PATTERN.test(String(id || '')),
      has: (id) => versions.has(id),
      create,
      info,
      canvas: canvasFor,
      commit,
      fromCanvas,
      retain,
      stats,
      bytesHeldBy,
      encode,
      pin(ids) {
        for (const id of ids) pins.set(id, (pins.get(id) || 0) + 1);
      },
      unpin(ids) {
        for (const id of ids) {
          const count = (pins.get(id) || 0) - 1;
          if (count > 0) pins.set(id, count);
          else pins.delete(id);
        }
      },
      clear() {
        versions.clear();
        composed.clear();
        encoded.clear();
        tileBytes = 0;
      },
    });
  }

  // Selection masks compress as byte runs: [value, runLength] pairs.
  function encodeRuns(mask) {
    const runs = [];
    let i = 0;
    while (i < mask.length) {
      const value = mask[i];
      let j = i + 1;
      while (j < mask.length && mask[j] === value && j - i < 0xffffffff) j += 1;
      runs.push(value, j - i);
      i = j;
    }
    return Uint32Array.from(runs);
  }

  function decodeRuns(runs, length) {
    const mask = new Uint8ClampedArray(length);
    let offset = 0;
    for (let k = 0; k + 1 < runs.length; k += 2) {
      const value = runs[k],
        count = runs[k + 1];
      if (offset + count > length) throw new Error('Selection data is corrupt.');
      if (value) mask.fill(value, offset, offset + count);
      offset += count;
    }
    if (offset !== length) throw new Error('Selection data is corrupt.');
    return mask;
  }

  return Object.freeze({
    TILE,
    TILE_BYTES,
    defaultBudget,
    createRasterStore,
    encodeRuns,
    decodeRuns,
    randomId,
  });
});
