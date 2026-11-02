/**
 * alcor-photo-recovery.js: AlcorPhoto crash recovery.
 *
 * Keeps an integrity-checked copy of unsaved work in this browser's IndexedDB
 * and offers to restore it after a crash or accidental close. Nothing is uploaded.
 */
(function () {
  'use strict';

  // Crash and close recovery. While a document has unsaved changes, a portable
  // project bundle (the same integrity-checked format as Download project) is
  // written to this browser's IndexedDB on this device. Nothing is uploaded.
  // A clean document (new, or downloaded since the last change) keeps no copy.

  const DB_NAME = 'alcorphoto-recovery';
  const STORE = 'sessions';
  const MAX_RECORDS = 3;
  const DELAY_MS = 2500;
  const PREF_KEY = 'alcorphoto.recovery.enabled';
  (globalThis.AlcorPhotoExtensions = globalThis.AlcorPhotoExtensions || []).push(install);

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('This browser has no IndexedDB, so recovery copies are off.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error('Recovery storage could not open.'));
      request.onblocked = () => reject(new Error('Recovery storage is blocked by another tab.'));
    });
  }

  function tx(db, mode, run) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const result = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result?.result ?? result);
      transaction.onerror = () =>
        reject(transaction.error || new Error('Recovery storage failed.'));
      transaction.onabort = () =>
        reject(
          transaction.error ||
            new Error('Recovery storage was aborted (the browser may be out of space).'),
        );
    });
  }

  function install(editor) {
    const Core = globalThis.AlcorPhotoCore;
    const root = editor.root;
    const sessionId = `session-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;
    let enabled = true;
    try {
      enabled = localStorage.getItem(PREF_KEY) !== 'off';
    } catch {
      enabled = true;
    }
    let dbPromise = null;
    let timer = 0;
    let running = false;
    let again = false;
    let lastSavedContent = null;
    const db = () => (dbPromise = dbPromise || openDb());

    // Each open tab holds a lock named for its session while it lives. A copy whose lock is held belongs
    // to work still open in another tab: it is not offered here, and neither Discard nor pruning touches it.
    const lockName = (id) => `${DB_NAME}-${id}`;
    globalThis.navigator?.locks
      ?.request?.(lockName(sessionId), () => new Promise(() => {}))
      .catch?.(() => {});
    async function liveLocks() {
      try {
        return new Set(((await navigator.locks.query()).held || []).map((lock) => lock.name));
      } catch {
        return new Set();
      }
    }

    const indicator = document.createElement('span');
    indicator.className = 'ap-recovery-state';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ap-recovery-toggle';
    const statusbar = root.querySelector('.aa-statusbar');
    statusbar?.append(indicator, toggle);
    function paint(text) {
      indicator.textContent = enabled ? text : 'Recovery copies off';
      toggle.textContent = enabled ? 'Turn off recovery' : 'Turn on recovery';
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.title =
        'Recovery copies of unsaved work are kept only in this browser on this device.';
    }
    paint('Recovery copy: none needed');
    toggle.addEventListener('click', () => {
      enabled = !enabled;
      try {
        localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off');
      } catch {
        /* optional */
      }
      if (!enabled) removeOwn().catch(() => {});
      paint(enabled ? 'Recovery copy: waiting for changes' : '');
      if (enabled) schedule();
    });

    async function removeOwn() {
      lastSavedContent = null;
      const database = await db();
      await tx(database, 'readwrite', (store) => store.delete(sessionId));
    }

    async function save() {
      if (!enabled) return;
      if (editor.operation) {
        schedule();
        return;
      }
      if (!editor.hasUnsavedChanges()) {
        await removeOwn().catch(() => {});
        paint('Recovery copy: none needed');
        return;
      }
      const project = Core.normalizeProject(editor.store.project);
      const content = JSON.stringify({
        ...project,
        selectedLayerId: null,
        createdAt: null,
        updatedAt: null,
        selection: null,
      });
      if (content === lastSavedContent) return;
      const started = performance.now();
      const prepared = await editor.prepareBundle(project);
      const blob = await Core.createPortableBundle(prepared.project, prepared.files);
      const database = await db();
      const record = {
        id: sessionId,
        savedAt: new Date().toISOString(),
        name: project.name,
        layers: project.layers.length,
        bytes: blob.size,
        blob,
      };
      await tx(database, 'readwrite', (store) => store.put(record));
      lastSavedContent = content;
      await prune(database);
      const time = new Date(record.savedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      paint(
        `Recovery copy ${time} · ${(blob.size / 1048576).toFixed(1)} MB · ${Math.round(performance.now() - started)} ms`,
      );
    }

    async function prune(database) {
      const records = await tx(database, 'readonly', (store) => store.getAll());
      const live = await liveLocks();
      const others = (records || [])
        .filter((record) => record.id !== sessionId && !live.has(lockName(record.id)))
        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      const excess = others.slice(Math.max(0, MAX_RECORDS - 1));
      if (excess.length)
        await tx(database, 'readwrite', (store) => {
          for (const record of excess) store.delete(record.id);
        });
    }

    // Every save goes through one queue so an older, slower save can never
    // overwrite a newer copy (e.g. the page-hidden save racing the timer save).
    async function runSave() {
      clearTimeout(timer);
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await save();
      } catch (error) {
        paint(`Recovery copy unavailable: ${String(error?.message || error).slice(0, 90)}`);
      } finally {
        running = false;
        if (again) {
          again = false;
          runSave();
        }
      }
    }

    function schedule() {
      clearTimeout(timer);
      if (enabled && editor.hasUnsavedChanges() && !running)
        paint('Recovery copy: saving shortly…');
      timer = setTimeout(runSave, DELAY_MS);
    }

    editor.onStore((store) => {
      store.on('change', () => {
        if (store === editor.store) schedule();
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && enabled && editor.hasUnsavedChanges()) runSave();
    });
    window.addEventListener('pagehide', () => {
      if (!editor.hasUnsavedChanges()) removeOwn().catch(() => {});
    });

    // Offer earlier sessions left behind by a crash or an unsaved close.
    async function offer() {
      if (!enabled) return;
      let records;
      try {
        records = await tx(await db(), 'readonly', (store) => store.getAll());
      } catch (error) {
        paint(`Recovery copies unavailable: ${String(error?.message || error).slice(0, 80)}`);
        return;
      }
      const live = await liveLocks();
      const candidates = (records || [])
        .filter(
          (record) =>
            record.id !== sessionId &&
            !live.has(lockName(record.id)) &&
            record.blob instanceof Blob,
        )
        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      if (!candidates.length) return;
      const record = candidates[0];
      const banner = document.createElement('div');
      banner.className = 'ap-recovery-banner';
      banner.setAttribute('role', 'alert');
      const when = new Date(record.savedAt);
      const text = document.createElement('span');
      text.textContent = `Unsaved work from ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} was kept in this browser: “${record.name}” (${record.layers} layer${record.layers === 1 ? '' : 's'}, ${(record.bytes / 1048576).toFixed(1)} MB).`;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'aa-button-primary';
      restore.textContent = 'Restore';
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.textContent = 'Discard';
      banner.append(text, restore, discard);
      root.querySelector('.ap-app')?.prepend(banner);
      restore.addEventListener('click', async () => {
        banner.remove();
        const file = new File([record.blob], `${record.name || 'Recovered'}.alcorphoto`, {
          type: 'application/x-alcorphoto',
        });
        const before = editor.store;
        await editor.openProjectFile(file);
        // Only a project that actually opened replaces the recovery copy. A cancelled or
        // failed open (corrupt copy, declined confirmation) keeps it and offers it again.
        if (editor.store === before) {
          const reason = document.querySelector('#ap-status')?.textContent || '';
          offer().then(() =>
            editor.status(
              `Restore did not complete; the recovery copy is kept. ${reason}`.slice(0, 180),
              'error',
            ),
          );
          return;
        }
        editor.markUnsaved('Recovered from this browser · download project to keep it');
        await tx(await db(), 'readwrite', (store) => store.delete(record.id)).catch(() => {});
        schedule();
      });
      discard.addEventListener('click', async () => {
        banner.remove();
        await tx(await db(), 'readwrite', (store) => {
          for (const item of candidates) store.delete(item.id);
        }).catch(() => {});
        editor.status('Recovery copies discarded from this browser.');
      });
    }
    // Checking storage for an earlier session waits until the editor is idle.
    (globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 400)))(() => offer(), {
      timeout: 2500,
    });

    async function saveNow() {
      await runSave();
      while (running) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    globalThis.AlcorPhotoRecovery = Object.freeze({
      saveNow,
      get saving() {
        return running;
      },
      sessionId,
      get enabled() {
        return enabled;
      },
    });
  }
})();
