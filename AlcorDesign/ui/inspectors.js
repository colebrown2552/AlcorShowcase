/**
 * Source inspectors and project-wide tree navigation. Captured source and editable repository drafts are kept separate. Uses window.AlcorDesignUI from app.js.
 */
'use strict';

(() => {
  const UI = window.AlcorDesignUI;
  if (!UI) return;
  const $ = (id) => document.getElementById(id);
  const state = () => UI.state;
  let githubRepository = null;
  UI.tool('design_status')
    .then((status) => {
      githubRepository = status?.github_repository || null;
    })
    .catch(() => {});
  const SOURCE_PAGE_LINES = 300;
  const scoped = (extra) => ({
    ...(state().project ? { project_id: state().project.id } : {}),
    ...(state().page ? { page_id: state().page.id } : {}),
    ...extra,
  });
  const contextKey = () =>
    `${state().project?.id || ''}/${state().page?.id || ''}/${state().page?.revision || 0}`;
  const viewers = {
    stylesheet: { content: '', path: '', matches: [], match: 0, editable: false, editing: false },
    files: { content: '', path: '', matches: [], match: 0, editable: false, editing: false },
  };
  const model = {
    styleTicket: 0,
    fileTicket: 0,
    styleReadTicket: 0,
    fileReadTicket: 0,
    sources: null,
    styles: [],
    activeStyle: '',
    files: [],
    fileLimit: 100,
    activeFile: '',
    filesContext: '',
    loadedStyleContext: '',
    loadedFileContext: '',
    tree: {
      ticket: 0,
      projectId: '',
      query: '',
      entries: [],
      total: 0,
      next: null,
      expanded: new Set(),
      layers: new Map(),
      loading: false,
      syncBusy: false,
      syncError: '',
      sitemapSync: null,
      pageCount: 0,
    },
  };
  const sourceSync = { projectId: '', data: null, busy: false, error: '', notice: '', ticket: 0 };
  const localDraftPrefix = 'alcordesign-source-draft:';
  const fallbackDrafts = new Map();
  const makeWindowId = () =>
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let sourceWindowId;
  try {
    sourceWindowId = sessionStorage.getItem('alcordesign-source-window') || makeWindowId();
    sessionStorage.setItem('alcordesign-source-window', sourceWindowId);
  } catch {
    sourceWindowId = makeWindowId();
  }
  const instanceId = makeWindowId();
  const operationPrefix = 'alcordesign-source-operation:';
  const operationKey = (projectId, type, path = '') =>
    `${operationPrefix}${encodeURIComponent(projectId)}:${sourceWindowId}:${type}:${encodeURIComponent(path)}`;
  function sourceOperation(projectId, type, path = '') {
    try {
      const op = JSON.parse(localStorage.getItem(operationKey(projectId, type, path)) || 'null');
      return op?.project_id === projectId &&
        op?.type === type &&
        (op.path || '') === path &&
        /^[A-Za-z0-9_.:/-]{8,128}$/.test(op.request_id || '')
        ? op
        : null;
    } catch {
      return null;
    }
  }
  function persistSourceOperation(op) {
    try {
      localStorage.setItem(operationKey(op.project_id, op.type, op.path || ''), JSON.stringify(op));
      return true;
    } catch {
      return false;
    }
  }
  function clearSourceOperation(projectId, type, path = '') {
    try {
      localStorage.removeItem(operationKey(projectId, type, path));
    } catch {}
  }
  function projectOperations(projectId) {
    const prefix = operationPrefix + encodeURIComponent(projectId) + ':',
      entries = [],
      seen = new Set();
    try {
      const keys = Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .sort(
          (a, b) =>
            Number(b.includes(`:${sourceWindowId}:`)) - Number(a.includes(`:${sourceWindowId}:`)),
        );
      for (const key of keys) {
        let op;
        try {
          op = JSON.parse(localStorage.getItem(key));
        } catch {
          continue;
        }
        if (
          op?.project_id !== projectId ||
          !['save', 'sync'].includes(op.type) ||
          !/^[A-Za-z0-9_.:/-]{8,128}$/.test(op.request_id || '') ||
          seen.has(op.request_id)
        )
          continue;
        seen.add(op.request_id);
        entries.push({ key, op });
      }
    } catch {}
    return entries;
  }
  function matchingOperation(projectId, type, path = '') {
    return (
      sourceOperation(projectId, type, path) ||
      projectOperations(projectId).find((e) => e.op.type === type && (e.op.path || '') === path)
        ?.op ||
      null
    );
  }
  function updateOperationState(op) {
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(operationPrefix + encodeURIComponent(op.project_id) + ':')) continue;
        let existing;
        try {
          existing = JSON.parse(localStorage.getItem(key));
        } catch {
          continue;
        }
        if (existing?.request_id === op.request_id && existing?.type === op.type)
          localStorage.setItem(key, JSON.stringify({ ...existing, state: op.state }));
      }
    } catch {}
  }
  function clearOperationReceipts(op) {
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(operationPrefix + encodeURIComponent(op.project_id) + ':')) continue;
        let existing;
        try {
          existing = JSON.parse(localStorage.getItem(key));
        } catch {
          continue;
        }
        if (existing?.request_id === op.request_id && existing?.type === op.type)
          localStorage.removeItem(key);
      }
    } catch {}
  }
  const localDraftKey = (projectId, path) =>
    localDraftPrefix +
    encodeURIComponent(projectId) +
    ':' +
    sourceWindowId +
    ':' +
    encodeURIComponent(path);
  const isEditablePath = (path) => /\.(css|php)$/i.test(path || '');
  function localDraft(projectId, path) {
    const key = localDraftKey(projectId, path);
    if (fallbackDrafts.has(key)) return fallbackDrafts.get(key);
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }
  function setLocalDraft(draft) {
    const key = localDraftKey(draft.project_id, draft.path);
    fallbackDrafts.set(key, draft);
    try {
      localStorage.setItem(key, JSON.stringify(draft));
      return true;
    } catch {
      return false;
    }
  }
  function removeLocalDraft(projectId, path) {
    const key = localDraftKey(projectId, path);
    fallbackDrafts.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {}
  }
  function hasLocalDrafts(projectId) {
    const prefix = localDraftPrefix + encodeURIComponent(projectId) + ':' + sourceWindowId + ':';
    if ([...fallbackDrafts.keys()].some((key) => key.startsWith(prefix))) return true;
    try {
      return Object.keys(localStorage).some((key) => key.startsWith(prefix));
    } catch {
      return true;
    }
  }
  function recoverableDrafts(projectId) {
    const prefix = localDraftPrefix + encodeURIComponent(projectId) + ':',
      own = prefix + sourceWindowId + ':',
      entries = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix) || key.startsWith(own)) continue;
        const slot = key.slice(prefix.length).split(':')[0];
        let draft;
        try {
          draft = JSON.parse(localStorage.getItem(key));
        } catch {
          continue;
        }
        if (
          draft?.project_id === projectId &&
          isEditablePath(draft.path) &&
          typeof draft.content === 'string' &&
          typeof draft.version === 'string'
        )
          entries.push({ key, slot, draft });
      }
    } catch {}
    return entries.sort(
      (a, b) => a.draft.path.localeCompare(b.draft.path) || a.slot.localeCompare(b.slot),
    );
  }
  function renderRecovery(kind, projectId, entries) {
    const details = $(`${kind}Recovery`),
      list = $(`${kind}RecoveryList`);
    details.hidden = !entries.length;
    list.replaceChildren();
    for (const entry of entries) {
      const button = document.createElement('button'),
        label = document.createElement('span'),
        action = document.createElement('small');
      button.type = 'button';
      button.dataset.slot = entry.slot;
      button.dataset.path = entry.draft.path;
      button.title = `${entry.draft.path} · saved in another window or session`;
      label.textContent = `${basename(entry.draft.path)} · ${entry.slot.slice(0, 8)}`;
      action.textContent = 'Recover copy';
      button.append(label, action);
      button.onclick = () => {
        const existing = localDraft(projectId, entry.draft.path);
        if (
          existing &&
          (existing.content !== entry.draft.content || existing.version !== entry.draft.version)
        ) {
          viewers[kind].error =
            'This window already has an unsaved edit for that file. Save or copy it before recovering another version.';
          updateSourceControls();
          return;
        }
        const stored = setLocalDraft(entry.draft);
        sourceSync.notice = stored
          ? `Recovered a copy of ${basename(entry.draft.path)}. Open the file and choose Edit.`
          : 'Recovered in this window; save before closing because browser storage is full.';
        for (const type of ['save', 'sync']) {
          const path = type === 'save' ? entry.draft.path : '',
            key = `${operationPrefix}${encodeURIComponent(projectId)}:${entry.slot}:${type}:${encodeURIComponent(path)}`;
          try {
            const old = JSON.parse(localStorage.getItem(key) || 'null');
            if (
              old &&
              !sourceOperation(projectId, type, path) &&
              old.project_id === projectId &&
              old.type === type &&
              (old.path || '') === path &&
              /^[A-Za-z0-9_.:/-]{8,128}$/.test(old.request_id || '')
            )
              persistSourceOperation(old);
          } catch {}
        }
        for (const name of ['stylesheet', 'files']) {
          const viewer = viewers[name];
          if (
            viewer.editing &&
            viewer.projectId === projectId &&
            viewer.path === entry.draft.path &&
            !viewer.dirty
          ) {
            viewer.conflict =
              viewer.version !== entry.draft.version || viewer.baseSha !== entry.draft.base_sha;
            const editor = $(`${name}Editor`);
            editor.value = entry.draft.content;
            viewer.dirty = editor.value !== viewer.original;
            viewer.storageError = !stored;
            renderCode(name);
          }
        }
        updateSourceControls();
      };
      list.append(button);
    }
  }
  function renderSourceOperations(kind, entries) {
    const details = $(`${kind}Operations`),
      list = $(`${kind}OperationsList`);
    details.hidden = !entries.length;
    list.replaceChildren();
    for (const { op } of entries) {
      const row = document.createElement('div'),
        check = document.createElement('button'),
        label = document.createElement('span'),
        action = document.createElement('small');
      row.className = 'source-operation-row';
      check.type = 'button';
      check.title = `${op.type === 'save' ? op.path : 'GitHub sync'} · ${op.request_id}`;
      label.textContent = op.type === 'save' ? `Save · ${basename(op.path)}` : 'GitHub sync';
      action.textContent = 'Check';
      check.append(label, action);
      check.onclick = async () => {
        if (sourceSync.busy) return;
        sourceSync.busy = true;
        updateSourceControls();
        await checkSourceOperation(op);
        sourceSync.busy = false;
        updateSourceControls();
      };
      row.append(check);
      if (op.state === 'not_found') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry original';
        retry.onclick = () => {
          if (sourceSync.busy) return;
          if (op.type === 'sync') submitSync(op);
          else submitSave(op, kind);
        };
        row.append(retry);
      }
      list.append(row);
    }
  }
  function hasUnsaved(projectId) {
    return (
      hasLocalDrafts(projectId) ||
      Object.values(viewers).some((v) => v.projectId === projectId && v.editing && v.dirty)
    );
  }
  // Duplicating a browser tab can clone sessionStorage. A live sibling claims
  // the copied slot, so create a fresh slot and preserve both copies of drafts.
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('alcordesign-source-windows');
    channel.onmessage = (event) => {
      const message = event.data;
      if (!message || message.instance === instanceId) return;
      if (message.type === 'claim' && message.slot === sourceWindowId)
        channel.postMessage({
          type: 'occupied',
          slot: sourceWindowId,
          instance: instanceId,
          target: message.instance,
        });
      if (
        message.type === 'occupied' &&
        message.target === instanceId &&
        message.slot === sourceWindowId
      ) {
        const old = sourceWindowId;
        sourceWindowId = makeWindowId();
        try {
          sessionStorage.setItem('alcordesign-source-window', sourceWindowId);
        } catch {}
        const remap = (key) => {
          const prefix = key.startsWith(localDraftPrefix)
            ? localDraftPrefix
            : key.startsWith(operationPrefix)
              ? operationPrefix
              : null;
          if (!prefix) return null;
          const parts = key.slice(prefix.length).split(':');
          return parts.length >= 3 && parts[1] === old
            ? `${prefix}${parts[0]}:${sourceWindowId}:${parts.slice(2).join(':')}`
            : null;
        };
        try {
          for (const key of Object.keys(localStorage)) {
            const next = remap(key);
            if (next && !localStorage.getItem(next))
              localStorage.setItem(next, localStorage.getItem(key));
          }
        } catch {}
        for (const [key, value] of [...fallbackDrafts]) {
          const next = remap(key);
          if (next) {
            fallbackDrafts.set(next, value);
            fallbackDrafts.delete(key);
          }
        }
        updateSourceControls();
      }
    };
    channel.postMessage({ type: 'claim', slot: sourceWindowId, instance: instanceId });
  }
  function recordLineEndings(viewer, raw) {
    viewer.lineEndings = raw.match(/\r\n|\r|\n/g) || [];
    viewer.newline = viewer.lineEndings[0] || '\n';
    viewer.mixedEndings = new Set(viewer.lineEndings).size > 1;
  }
  function sourceWithOriginalLineEndings(viewer, content) {
    const lines = content.split('\n');
    let result = lines[0];
    for (let i = 1; i < lines.length; i++)
      result += (viewer.lineEndings?.[i - 1] || viewer.newline || '\n') + lines[i];
    return result;
  }
  function updateSourceControls() {
    const projectId = state().project?.id || '',
      sync = sourceSync.projectId === projectId ? sourceSync.data : null,
      operations = projectOperations(projectId),
      syncOp = matchingOperation(projectId, 'sync'),
      pending = sync?.pending_sync || (syncOp ? { state: syncOp.state || 'uncertain' } : null),
      recoverable = recoverableDrafts(projectId);
    for (const kind of ['stylesheet', 'files']) {
      const viewer = viewers[kind],
        editing = viewer.editing && viewer.projectId === projectId,
        saveOp = matchingOperation(projectId, 'save', viewer.path);
      const editor = $(`${kind}Editor`),
        code = $(`${kind}Code`),
        edit = $(`${kind}Edit`),
        save = $(`${kind}Save`),
        saveCheck = $(`${kind}CheckSave`),
        saveRetry = $(`${kind}RetrySave`),
        discard = $(`${kind}Discard`),
        check = $(`${kind}Check`),
        syncRetry = $(`${kind}RetrySync`),
        push = $(`${kind}Sync`),
        status = $(`${kind}EditStatus`);
      code.hidden = editing;
      editor.hidden = !editing;
      $(`${kind}CodePages`).hidden = editing || !(viewer.lineCount > SOURCE_PAGE_LINES);
      edit.hidden = editing;
      edit.disabled =
        !viewer.editable || viewer.projectId !== projectId || viewer.busy || sourceSync.busy;
      save.hidden = !editing;
      save.disabled =
        !editing ||
        !viewer.dirty ||
        viewer.conflict ||
        viewer.storageError ||
        viewer.busy ||
        sourceSync.busy ||
        !!saveOp;
      saveCheck.hidden = !saveOp;
      saveCheck.disabled = viewer.busy || sourceSync.busy;
      saveRetry.hidden = saveOp?.state !== 'not_found';
      saveRetry.disabled = viewer.busy || sourceSync.busy;
      discard.hidden = !editing;
      discard.disabled = !editing || !viewer.dirty || viewer.busy || sourceSync.busy || !!saveOp;
      editor.readOnly = viewer.busy || sourceSync.busy || !!saveOp;
      check.hidden = !pending;
      check.disabled = sourceSync.busy;
      syncRetry.hidden = syncOp?.state !== 'not_found';
      syncRetry.disabled = sourceSync.busy;
      push.disabled =
        !sync ||
        !sync.dirty_count ||
        !sync.draft_set_version ||
        !!pending ||
        operations.some((e) => e.op.type === 'save') ||
        sourceSync.busy ||
        hasUnsaved(projectId);
      status.replaceChildren();
      status.classList.toggle(
        'error',
        !!(
          viewer.error ||
          sourceSync.error ||
          viewer.conflict ||
          viewer.storageError ||
          viewer.upstreamWarning
        ),
      );
      let message = 'Select a repository CSS or PHP file to edit.';
      if (viewer.error) message = viewer.error;
      else if (saveOp)
        message =
          saveOp.state === 'not_found'
            ? 'The original save has no receipt. You can check again or retry the same request.'
            : 'Save outcome needs checking. Your unsaved edit is preserved.';
      else if (viewer.conflict)
        message =
          'This file changed since your unsaved edit was opened. Copy your draft, then discard it and open the latest version.';
      else if (viewer.storageError)
        message = 'Browser draft storage is full. Save this edit before closing the window.';
      else if (viewer.upstreamWarning) message = viewer.upstreamWarning;
      else if (sourceSync.error)
        message =
          sourceSync.error +
          (editing ? ` ${viewer.dirty ? 'Unsaved edit.' : 'Editing local source.'}` : '');
      else if (pending)
        message = `Sync outcome needs checking (${pending.state || 'pending'}). Your saved drafts are retained.`;
      else if (editing) {
        const sha = (viewer.baseSha || '').slice(0, 12),
          branch = viewer.branch || sync?.base_branch || 'repository branch';
        message = `Editing ${branch}${sha ? ' · ' + sha : ''} · ${viewer.dirty ? 'Unsaved edit' : viewer.savedDirty ? 'Saved draft' : 'No unsaved changes'}. The canvas remains at its captured revision.`;
      } else if (viewer.editable)
        message = `Captured source · ${sync?.dirty_count || 0} saved draft${sync?.dirty_count === 1 ? '' : 's'} ready to sync.`;
      if (
        !viewer.error &&
        !viewer.conflict &&
        !viewer.storageError &&
        !viewer.upstreamWarning &&
        !sourceSync.error &&
        !saveOp &&
        !pending &&
        sourceSync.notice
      )
        message = sourceSync.notice;
      if (hasUnsaved(projectId) && !editing && !saveOp && !pending && !sourceSync.error)
        message =
          'Unsaved edits are kept locally. Open the file and save its draft before syncing.';
      if (recoverable.length)
        message += ' Another window or earlier session has an unsaved source edit.';
      if (
        editing &&
        viewer.mixedEndings &&
        editor.value.split('\n').length - 1 !== viewer.lineEndings.length
      )
        message += ' Mixed line endings: adding or removing lines may move their separators.';
      if (editing && viewer.integrationNote) message += ` ${viewer.integrationNote}`;
      status.append(document.createTextNode(message));
      const link = sourceSync.notice && sync?.compare_url;
      if (link) {
        try {
          const url = new URL(link);
          if (
            url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            githubRepository &&
            url.pathname.startsWith(`/${githubRepository}/`)
          ) {
            status.append(document.createTextNode(' '));
            const a = document.createElement('a');
            a.href = url.href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = 'Review on GitHub';
            status.append(a);
          }
        } catch {}
      }
      renderRecovery(kind, projectId, recoverable);
      renderSourceOperations(kind, operations);
    }
  }
  async function refreshSourceSync({ force = false } = {}) {
    const projectId = state().project?.id;
    if (!projectId) return;
    if (!force && sourceSync.projectId === projectId && sourceSync.data) return;
    if (sourceSync.projectId !== projectId) {
      sourceSync.projectId = projectId;
      sourceSync.data = null;
      sourceSync.error = '';
      sourceSync.notice = '';
    }
    const ticket = ++sourceSync.ticket;
    try {
      const result = await UI.tool('design_source_sync_status', { project_id: projectId });
      if (ticket !== sourceSync.ticket || state().project?.id !== projectId)
        return { fresh: false };
      sourceSync.data = result;
      sourceSync.error = '';
      if (result.last_sync?.state === 'not_pushed' && !sourceOperation(projectId, 'sync'))
        sourceSync.notice =
          'The previous sync did not reach GitHub. Your drafts are ready to sync.';
      return { fresh: true, result };
    } catch (error) {
      if (ticket === sourceSync.ticket && state().project?.id === projectId)
        sourceSync.error = `Cannot check GitHub sync status: ${error.message}`;
      return { fresh: false };
    } finally {
      updateSourceControls();
    }
  }
  async function refreshOpenEditors(projectId) {
    await Promise.all(
      ['stylesheet', 'files'].map(async (kind) => {
        const viewer = viewers[kind];
        if (!viewer.editing || viewer.projectId !== projectId) return;
        const path = viewer.path,
          version = viewer.version,
          editor = $(`${kind}Editor`),
          before = editor.value,
          args = { project_id: projectId, path };
        if (viewer.pageId) args.page_id = viewer.pageId;
        try {
          const result = await UI.tool('design_source_draft', args);
          if (
            !viewer.editing ||
            viewer.projectId !== projectId ||
            viewer.path !== path ||
            viewer.version !== version
          )
            return;
          if (editor.value !== before || viewer.dirty) {
            viewer.conflict = true;
            viewer.error =
              'Source was synced while this editor had unsaved changes. Copy the edit and reopen the file.';
            return;
          }
          const raw = String(result.content ?? '');
          recordLineEndings(viewer, raw);
          viewer.original = raw.replace(/\r\n?/g, '\n');
          viewer.baseBlob = result.base_blob;
          viewer.baseMode = result.mode;
          viewer.version = result.version;
          viewer.baseSha = result.base_sha || viewer.baseSha;
          viewer.branch =
            result.provenance?.editing_ref || result.branch || result.base_branch || viewer.branch;
          viewer.integrationNote = result.provenance?.integration_note || '';
          viewer.savedDirty = !!result.dirty;
          viewer.dirty = false;
          viewer.conflict = false;
          viewer.error = '';
          editor.value = viewer.original;
          renderCode(kind);
        } catch (error) {
          if (viewer.editing && viewer.projectId === projectId && viewer.path === path) {
            if (viewer.dirty) {
              viewer.conflict = true;
              viewer.error =
                'Source was synced, but the editor version could not be refreshed. Copy the unsaved edit before reopening.';
            } else {
              viewer.editing = false;
              viewer.error =
                'Source was synced. Reopen this file to load the latest editing version.';
            }
          }
        }
      }),
    );
  }
  async function beginSourceEdit(kind) {
    const viewer = viewers[kind],
      projectId = state().project?.id,
      path = viewer.path,
      pageId = state().page?.id;
    if (
      !projectId ||
      !viewer.editable ||
      viewer.projectId !== projectId ||
      viewer.busy ||
      sourceSync.busy
    )
      return;
    viewer.busy = true;
    viewer.error = '';
    sourceSync.notice = '';
    updateSourceControls();
    try {
      const args = { project_id: projectId, path };
      if (pageId) args.page_id = pageId;
      const result = await UI.tool('design_source_draft', args);
      if (viewer.path !== path || viewer.projectId !== projectId) return;
      const saved = localDraft(projectId, path),
        baseSha = result.base_sha || result.provenance?.sha || '';
      const raw = String(result.content ?? '');
      recordLineEndings(viewer, raw);
      viewer.baseBlob = result.base_blob;
      viewer.baseMode = result.mode;
      viewer.version = result.version;
      viewer.baseSha = baseSha;
      viewer.branch = result.provenance?.editing_ref || result.branch || result.base_branch || '';
      viewer.integrationNote = result.provenance?.integration_note || '';
      viewer.savedDirty = !!result.dirty;
      viewer.pageId = pageId;
      viewer.original = raw.replace(/\r\n?/g, '\n');
      viewer.conflict = !!saved && (saved.version !== result.version || saved.base_sha !== baseSha);
      const content = saved ? String(saved.content ?? '') : viewer.original;
      viewer.dirty = content !== viewer.original;
      viewer.editing = true;
      viewer.storageError = false;
      const editor = $(`${kind}Editor`);
      editor.value = content;
      editor.wrap = $(`${kind === 'files' ? 'wrapFile' : 'wrapStylesheet'}`).checked
        ? 'soft'
        : 'off';
      renderCode(kind);
      if (!viewer.dirty && saved && !matchingOperation(projectId, 'save', path))
        removeLocalDraft(projectId, path);
      refreshSourceSync({ force: true });
    } catch (error) {
      if (viewer.path === path && viewer.projectId === projectId)
        viewer.error = `Cannot open editable source: ${error.message}`;
    } finally {
      viewer.busy = false;
      updateSourceControls();
    }
  }
  function editSourceInput(kind) {
    const viewer = viewers[kind];
    if (!viewer.editing) return;
    const value = $(`${kind}Editor`).value;
    viewer.dirty = value !== viewer.original;
    viewer.error = '';
    sourceSync.notice = '';
    if (viewer.dirty)
      viewer.storageError = !setLocalDraft({
        project_id: viewer.projectId,
        page_id: viewer.pageId,
        path: viewer.path,
        content: value,
        version: viewer.version,
        base_sha: viewer.baseSha,
      });
    else {
      removeLocalDraft(viewer.projectId, viewer.path);
      viewer.storageError = false;
    }
    for (const other of ['stylesheet', 'files']) {
      if (
        other !== kind &&
        viewers[other].editing &&
        viewers[other].projectId === viewer.projectId &&
        viewers[other].path === viewer.path
      ) {
        viewers[other].dirty = viewer.dirty;
        viewers[other].storageError = viewer.storageError;
        $(`${other}Editor`).value = value;
      }
    }
    renderCode(kind);
    updateSourceControls();
  }
  async function applySaveReceipt(op, result) {
    if (
      result?.saved !== true ||
      !result.version ||
      result.request_id !== op.request_id ||
      result.path !== op.path
    )
      return false;
    const normalized = op.content.replace(/\r\n?/g, '\n'),
      saved = localDraft(op.project_id, op.path);
    if (saved?.version === op.expected_version && saved.content === normalized)
      removeLocalDraft(op.project_id, op.path);
    clearOperationReceipts(op);
    for (const name of ['stylesheet', 'files']) {
      const v = viewers[name];
      if (v.projectId === op.project_id && v.path === op.path && v.editing) {
        recordLineEndings(v, op.content);
        v.version = result.version;
        v.baseSha = result.base_sha || v.baseSha;
        v.original = normalized;
        v.savedDirty = !!result.dirty;
        v.dirty = $(`${name}Editor`).value !== normalized;
        v.storageError = false;
        v.conflict = v.dirty;
        v.error = v.dirty
          ? 'The saved source changed while this window had newer edits. Copy your edit and reopen the file.'
          : '';
      }
    }
    if (state().project?.id === op.project_id) {
      sourceSync.notice = 'Draft saved locally. Sync to GitHub when ready.';
      await refreshSourceSync({ force: true });
    }
    return true;
  }
  async function applySyncReceipt(op, result) {
    if (result?.uncertain || result?.pushed === null) return false;
    if (
      (result?.pushed !== true && result?.pushed !== false) ||
      result.request_id !== op.request_id
    )
      return false;
    clearOperationReceipts(op);
    if (state().project?.id !== op.project_id) return true;
    if (result.pushed) {
      sourceSync.error = '';
      sourceSync.notice = `Synced to ${result.branch}. Integrate the branch to update preview.`;
      sourceSync.data = { ...sourceSync.data, ...result, pending_sync: null };
      await refreshOpenEditors(op.project_id);
      await refreshSourceSync({ force: true });
    } else {
      sourceSync.data = { ...sourceSync.data, ...result, pending_sync: null };
      await refreshSourceSync({ force: true });
      sourceSync.error = `Sync did not complete${result.message ? `: ${result.message}` : ''}. Your saved drafts are retained.`;
    }
    return true;
  }
  async function checkSourceOperation(op) {
    try {
      const receipt = await UI.tool('design_source_operation_status', {
        project_id: op.project_id,
        request_id: op.request_id,
      });
      if (
        receipt.request_id !== op.request_id ||
        (receipt.operation_type && receipt.operation_type !== op.type)
      )
        throw new Error('Receipt does not match the original request');
      if (receipt.state === 'completed') {
        const done =
          op.type === 'save'
            ? await applySaveReceipt(op, receipt.result)
            : await applySyncReceipt(op, receipt.result);
        if (done) return;
      }
      op.state = receipt.state === 'not_found' ? 'not_found' : 'pending';
      updateOperationState(op);
      if (op.type === 'sync' && state().project?.id === op.project_id)
        sourceSync.error =
          op.state === 'not_found'
            ? 'The original sync has no receipt. Check again or retry the same request.'
            : 'Sync outcome is still pending. Check again before retrying.';
    } catch (error) {
      op.state = 'uncertain';
      updateOperationState(op);
      if (op.type === 'sync' && state().project?.id === op.project_id)
        sourceSync.error = `Sync outcome is unknown: ${error.message}. Check again before retrying.`;
    } finally {
      updateSourceControls();
    }
  }
  async function submitSave(op, kind) {
    const viewer = viewers[kind];
    viewer.busy = true;
    viewer.error = '';
    updateSourceControls();
    try {
      const args = {
        project_id: op.project_id,
        path: op.path,
        content: op.content,
        expected_version: op.expected_version,
        request_id: op.request_id,
      };
      if (op.page_id) args.page_id = op.page_id;
      const result = await UI.tool('design_save_source', args);
      if (!(await applySaveReceipt(op, result))) {
        op.state = 'pending';
        updateOperationState(op);
        await checkSourceOperation(op);
      }
    } catch (error) {
      if (
        error?.status === 400 &&
        error.message === 'Source changed since it was opened; your edit was not saved'
      ) {
        clearOperationReceipts(op);
        if (viewer.projectId === op.project_id && viewer.path === op.path) {
          viewer.conflict = true;
          viewer.error =
            'Source changed since it was opened. Your unsaved edit is preserved; copy it before discarding and reopening the latest version.';
        } else
          sourceSync.error =
            'A previous save conflicted. Open its file to recover the unsaved edit.';
      } else {
        op.state = 'uncertain';
        updateOperationState(op);
        await checkSourceOperation(op);
      }
    } finally {
      viewer.busy = false;
      updateSourceControls();
    }
  }
  async function saveSourceEdit(kind) {
    const viewer = viewers[kind];
    if (
      !viewer.editing ||
      !viewer.dirty ||
      viewer.conflict ||
      viewer.storageError ||
      viewer.busy ||
      sourceSync.busy ||
      matchingOperation(viewer.projectId, 'save', viewer.path)
    )
      return;
    const requestId = globalThis.crypto?.randomUUID?.();
    if (!requestId) {
      viewer.error = 'Cannot generate a unique save ID in this browser.';
      updateSourceControls();
      return;
    }
    const op = {
      project_id: viewer.projectId,
      type: 'save',
      path: viewer.path,
      page_id: viewer.pageId,
      expected_version: viewer.version,
      content: sourceWithOriginalLineEndings(viewer, $(`${kind}Editor`).value),
      request_id: requestId,
      state: 'pending',
    };
    if (!persistSourceOperation(op)) {
      viewer.error =
        'Cannot store the save request. Free browser storage or copy your edit before closing.';
      updateSourceControls();
      return;
    }
    await submitSave(op, kind);
  }
  function discardSourceEdit(kind) {
    const viewer = viewers[kind];
    if (!viewer.editing || !viewer.dirty || viewer.busy) return;
    if (!window.confirm('Discard this unsaved edit? Saved drafts are kept.')) return;
    removeLocalDraft(viewer.projectId, viewer.path);
    for (const name of ['stylesheet', 'files']) {
      const v = viewers[name];
      if (v.projectId === viewer.projectId && v.path === viewer.path && v.editing) {
        v.dirty = false;
        v.conflict = false;
        v.error = '';
        v.storageError = false;
        v.editing = false;
        $(`${name}Editor`).value = '';
      }
    }
    updateSourceControls();
  }
  async function submitSync(op) {
    sourceSync.busy = true;
    sourceSync.error = '';
    sourceSync.notice = '';
    updateSourceControls();
    try {
      const result = await UI.tool('design_sync_sources', {
        project_id: op.project_id,
        request_id: op.request_id,
        draft_set_version: op.draft_set_version,
      });
      if (!(await applySyncReceipt(op, result))) {
        op.state = 'pending';
        updateOperationState(op);
        await checkSourceOperation(op);
      }
    } catch {
      op.state = 'uncertain';
      updateOperationState(op);
      await checkSourceOperation(op);
    } finally {
      sourceSync.busy = false;
      updateSourceControls();
    }
  }
  async function syncSources() {
    const projectId = state().project?.id,
      sync = sourceSync.data;
    if (
      !projectId ||
      sourceSync.projectId !== projectId ||
      !sync?.dirty_count ||
      !sync.draft_set_version ||
      sync.pending_sync ||
      projectOperations(projectId).length ||
      sourceSync.busy ||
      hasUnsaved(projectId)
    )
      return;
    const requestId = globalThis.crypto?.randomUUID?.();
    if (!requestId) {
      sourceSync.error = 'Cannot generate a unique sync ID in this browser.';
      updateSourceControls();
      return;
    }
    const op = {
      project_id: projectId,
      type: 'sync',
      request_id: requestId,
      draft_set_version: sync.draft_set_version,
      state: 'pending',
    };
    if (!persistSourceOperation(op)) {
      sourceSync.error = 'Cannot store the sync request ID. Free browser storage before syncing.';
      updateSourceControls();
      return;
    }
    await submitSync(op);
  }

  function empty(root, message) {
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'source-empty';
    p.textContent = message;
    root.append(p);
  }
  function sourceRef(result) {
    return (
      result.provenance?.sha ||
      result.provenance?.source_sha ||
      result.provenance?.resolved_sha ||
      result.sha ||
      ''
    );
  }
  function sourceBasis(result) {
    return result.provenance?.basis || result.provenance?.source_basis || result.basis || '';
  }
  function showProvenance(root, result, suffix = '') {
    root.replaceChildren();
    const sha = sourceRef(result),
      basis = String(sourceBasis(result)).replaceAll('_', ' ');
    if (sha) {
      const badge = document.createElement('span');
      badge.className = 'ref-badge';
      badge.textContent = sha.slice(0, 12);
      badge.title = sha;
      root.append(badge);
    }
    root.append(
      document.createTextNode(
        [basis, suffix].filter(Boolean).join(' · ') ||
          (sha ? 'Pinned source' : 'Source provenance unavailable'),
      ),
    );
    root.title = sha;
  }
  function textSpan(text, className) {
    const el = document.createElement('span');
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function glyph(name) {
    const el = document.createElement('span');
    el.innerHTML = UI.icon(name);
    return el;
  }
  function basename(value) {
    return (
      String(value || '')
        .split('/')
        .pop() || value
    );
  }
  function shortPath(value) {
    try {
      return new URL(value).pathname;
    } catch {
      return value || '/';
    }
  }
  function readableError(root, error) {
    empty(root, error.message || String(error));
  }

  function setCode(kind, content, filePath, editable = false) {
    const viewer = viewers[kind];
    viewer.content = String(content || '');
    viewer.path = filePath || '';
    viewer.match = 0;
    viewer.codePage = 0;
    viewer.editable = editable && isEditablePath(filePath) && !!state().project;
    viewer.projectId = state().project?.id || '';
    viewer.editing = false;
    viewer.dirty = false;
    viewer.error = '';
    viewer.conflict = false;
    viewer.storageError = false;
    viewer.integrationNote = '';
    viewer.upstreamWarning = '';
    viewer.liveSource = false;
    viewer.baseBlob = null;
    viewer.baseMode = null;
    $(`${kind}FileName`).textContent = basename(filePath) || 'Source';
    $(`${kind}FileName`).title = filePath || '';
    renderCode(kind);
    $(`${kind}Code`).scrollTop = 0;
    updateSourceControls();
  }
  function renderCode(kind) {
    const viewer = viewers[kind],
      root = $(`${kind}Code`),
      query = $(`${kind}Find`).value.toLowerCase();
    root.replaceChildren();
    viewer.matches = [];
    if (viewer.editing) {
      $(`${kind}CodePages`).hidden = true;
      const value = $(`${kind}Editor`).value.toLowerCase();
      if (query) {
        let at = value.indexOf(query);
        while (at >= 0) {
          viewer.matches.push({ start: at, end: at + query.length });
          at = value.indexOf(query, at + query.length);
        }
      }
      viewer.match = Math.min(viewer.match, Math.max(0, viewer.matches.length - 1));
      updateMatch(kind, false);
      return;
    }
    if (!viewer.content) {
      viewer.lineCount = 0;
      $(`${kind}CodePages`).hidden = true;
      empty(root, 'This source file is empty.');
      $(`${kind}Matches`).textContent = '';
      return;
    }
    const fragment = document.createDocumentFragment(),
      lines = viewer.content.split('\n');
    viewer.lineCount = lines.length;
    if (query)
      for (let i = 0; i < lines.length; i++)
        if (lines[i].toLowerCase().includes(query)) viewer.matches.push(i + 1);
    const lastPage = Math.max(0, Math.ceil(lines.length / SOURCE_PAGE_LINES) - 1);
    viewer.codePage = Math.min(viewer.codePage || 0, lastPage);
    const first = viewer.codePage * SOURCE_PAGE_LINES,
      end = Math.min(lines.length, first + SOURCE_PAGE_LINES);
    $(`${kind}CodePages`).hidden = lines.length <= SOURCE_PAGE_LINES;
    $(`${kind}CodePageLabel`).textContent = `Lines ${first + 1}–${end} of ${lines.length}`;
    $(`${kind}CodePrevPage`).disabled = viewer.codePage === 0;
    $(`${kind}CodeNextPage`).disabled = viewer.codePage === lastPage;
    for (let index = first; index < end; index++) {
      const row = document.createElement('div');
      row.className = 'source-code-line';
      row.dataset.line = String(index + 1);
      const number = document.createElement('span');
      number.textContent = String(index + 1);
      const code = document.createElement('code');
      const line = lines[index];
      if (query) {
        let start = 0,
          at = line.toLowerCase().indexOf(query);
        while (at >= 0) {
          code.append(document.createTextNode(line.slice(start, at)));
          const mark = document.createElement('mark');
          mark.textContent = line.slice(at, at + query.length);
          code.append(mark);
          start = at + query.length;
          at = line.toLowerCase().indexOf(query, start);
        }
        code.append(document.createTextNode(line.slice(start)));
      } else code.textContent = line || ' ';
      row.append(number, code);
      fragment.append(row);
    }
    root.append(fragment);
    viewer.match = Math.min(viewer.match, Math.max(0, viewer.matches.length - 1));
    updateMatch(kind, false);
  }
  function updateMatch(kind, scroll = true) {
    const viewer = viewers[kind],
      root = $(`${kind}Code`);
    root.querySelector('.active-match')?.classList.remove('active-match');
    $(`${kind}Matches`).textContent = $(`${kind}Find`).value
      ? `${viewer.matches.length ? viewer.match + 1 : 0}/${viewer.matches.length}`
      : '';
    $(`${kind}Prev`).disabled = $(`${kind}Next`).disabled = !viewer.matches.length;
    if (viewer.editing) {
      const match = viewer.matches[viewer.match];
      if (scroll && match) {
        const editor = $(`${kind}Editor`);
        editor.focus();
        editor.setSelectionRange(match.start, match.end);
      }
      return;
    }
    const line = viewer.matches[viewer.match];
    if (scroll && line) {
      const page = Math.floor((line - 1) / SOURCE_PAGE_LINES);
      if (page !== viewer.codePage) {
        viewer.codePage = page;
        renderCode(kind);
      }
    }
    const row = root.querySelector(`[data-line="${line}"]`);
    if (row) {
      row.classList.add('active-match');
      if (scroll) root.scrollTop = Math.max(0, row.offsetTop - root.offsetTop - 75);
    }
  }
  function nextMatch(kind, amount) {
    const v = viewers[kind];
    if (v.matches.length) {
      v.match = (v.match + amount + v.matches.length) % v.matches.length;
      updateMatch(kind);
    }
  }
  async function copyCode(kind) {
    const value = viewers[kind].editing ? $(`${kind}Editor`).value : viewers[kind].content;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      UI.toast('Source copied.');
    } catch {
      UI.toast('Clipboard access is unavailable. Select and copy the source text.', true);
    }
  }

  async function loadStylesheets(force = false) {
    if (!state().project || !state().page || state().overview) {
      model.loadedStyleContext = '';
      $('stylesheetPageName').textContent = 'Select a page';
      $('stylesheetSelect').replaceChildren(new Option('Select a rendered page', ''));
      empty($('stylesheetCode'), 'Select a page to see its linked stylesheets.');
      return;
    }
    const key = contextKey();
    if (!force && model.loadedStyleContext === key) return;
    const ticket = ++model.styleTicket;
    model.loadedStyleContext = '';
    $('stylesheetPageName').textContent = state().page.title || state().page.url;
    $('stylesheetNotice').hidden = true;
    empty($('stylesheetCode'), 'Reading page stylesheet links…');
    try {
      const result = await UI.tool('design_page_sources', scoped({}));
      if (ticket !== model.styleTicket || key !== contextKey()) return;
      model.sources = result;
      model.styles = [
        ...(result.stylesheets || []).map((item, index) => ({
          ...item,
          key: `linked-${index}`,
          type: 'linked',
        })),
        ...(result.inline_styles || []).map((item, index) => ({
          ...item,
          key: `inline-${index}`,
          type: 'inline',
          label: `Inline stylesheet ${Number(item.index ?? index) + 1}`,
        })),
      ];
      model.loadedStyleContext = key;
      model.activeStyle = '';
      showProvenance($('stylesheetMeta'), result);
      renderStylesheetChooser();
      if (!model.styles.length)
        empty(
          $('stylesheetCode'),
          'No stylesheet links or inline styles were found in this page snapshot.',
        );
    } catch (error) {
      if (ticket === model.styleTicket) readableError($('stylesheetCode'), error);
    }
  }
  function renderStylesheetChooser() {
    const query = $('stylesheetSearch').value.toLowerCase().trim(),
      select = $('stylesheetSelect');
    select.replaceChildren();
    const items = model.styles.filter((item) =>
      `${item.repo_path || ''} ${item.url || ''} ${item.label || ''}`.toLowerCase().includes(query),
    );
    if (!items.length) {
      select.append(new Option('No matching stylesheets', ''));
      empty($('stylesheetCode'), 'No stylesheet names match this filter.');
      return;
    }
    for (const item of items) {
      const label = item.label || basename(item.repo_path || shortPath(item.url)) || 'Stylesheet';
      select.append(
        new Option(
          `${label}${item.type === 'linked' && !item.repo_path ? ' · external' : ''}`,
          item.key,
        ),
      );
    }
    const available = items.filter((item) => item.repo_path && item.available !== false);
    const theme =
      available.find((item) => /\/themes\/[^/]+\/style\.css$/i.test(item.repo_path)) ||
      available.find((item) => /\/themes\//i.test(item.repo_path));
    select.value = items.some((item) => item.key === model.activeStyle)
      ? model.activeStyle
      : (theme || available[0] || items.find((item) => item.type === 'inline') || items[0]).key;
    if (select.value !== model.activeStyle) readStylesheet(select.value).catch(UI.showError);
  }
  async function readStylesheet(key) {
    const item = model.styles.find((item) => item.key === key);
    if (!item) return;
    model.activeStyle = key;
    const context = contextKey(),
      ticket = ++model.styleReadTicket;
    $('stylesheetNotice').hidden = true;
    empty($('stylesheetCode'), 'Loading stylesheet source…');
    if (item.type === 'inline') {
      const content = item.content ?? item.css ?? item.preview ?? '';
      setCode('stylesheet', content, item.label);
      showProvenance($('stylesheetMeta'), model.sources || {}, 'Captured inline CSS');
      if (item.truncated || (item.content === undefined && item.css === undefined)) {
        $('stylesheetNotice').textContent =
          'This inline stylesheet is a bounded excerpt from the page snapshot.';
        $('stylesheetNotice').hidden = false;
      }
      return;
    }
    if (!item.repo_path) {
      setCode('stylesheet', '', item.url);
      empty(
        $('stylesheetCode'),
        'This linked stylesheet is not present in the configured repository.',
      );
      const notice = $('stylesheetNotice');
      notice.replaceChildren(document.createTextNode('Linked resource: '));
      try {
        const url = new URL(item.url);
        if (['https:', 'http:'].includes(url.protocol)) {
          const link = document.createElement('a');
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = url.href;
          notice.append(link);
        } else notice.append(document.createTextNode(item.url));
      } catch {
        notice.append(document.createTextNode(item.url || 'Unknown URL'));
      }
      notice.hidden = false;
      return;
    }
    if (item.available === false) {
      setCode('stylesheet', '', item.repo_path);
      empty(
        $('stylesheetCode'),
        item.unavailable_reason || 'This stylesheet is not available at the captured commit.',
      );
      return;
    }
    try {
      const result = await UI.tool('design_read_source', scoped({ path: item.repo_path }));
      if (ticket !== model.styleReadTicket || context !== contextKey()) return;
      setCode('stylesheet', result.content, item.repo_path, true);
      showProvenance($('stylesheetMeta'), result, 'Linked to this page');
    } catch (error) {
      if (ticket === model.styleReadTicket) readableError($('stylesheetCode'), error);
    }
  }
  async function loadFiles(force = false, observed = null) {
    const key = contextKey(),
      projectId = state().project?.id;
    if (!projectId) return;
    if (!force && model.loadedFileContext === key) return;
    const ticket = ++model.fileTicket;
    if (model.filesContext !== key) {
      model.filesContext = key;
      model.activeFile = '';
      model.fileReadTicket++;
      setCode('files', '', 'Select a source file');
      empty($('filesCode'), 'Select a file to inspect repository source.');
    }
    empty($('repoFileTree'), 'Reading repository files…');
    const [current, captured] = await Promise.allSettled([
      observed
        ? Promise.resolve(observed)
        : UI.tool('design_source_files', { project_id: projectId }),
      UI.tool('design_repo_files', scoped({ query: '' })),
    ]);
    if (ticket !== model.fileTicket || key !== contextKey()) return;
    if (current.status === 'rejected') await refreshSourceSync({ force: true });
    if (ticket !== model.fileTicket || key !== contextKey()) return;
    const branch = current.status === 'fulfilled' ? current.value : null,
      old = captured.status === 'fulfilled' ? captured.value : null;
    if (!branch && !old && !sourceSync.data?.files?.length) {
      readableError(
        $('repoFileTree'),
        current.reason || captured.reason || new Error('Repository source is unavailable.'),
      );
      return;
    }
    const byPath = new Map();
    for (const f of old?.files || [])
      byPath.set(f.path, {
        ...f,
        source_kind: 'capture',
        editable: current.status === 'rejected' && isEditablePath(f.path),
      });
    for (const f of (sourceSync.projectId === projectId ? sourceSync.data?.files : []) || [])
      if (isEditablePath(f.path))
        byPath.set(f.path, { ...f, source_kind: 'branch', editable: true, dirty: true });
    for (const f of branch?.files || []) {
      const existing = byPath.get(f.path),
        saved = !!existing?.dirty || !!f.dirty;
      byPath.set(f.path, {
        ...f,
        source_kind: 'branch',
        dirty: saved,
        editable: f.editable !== false || saved,
      });
    }
    model.files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    model.fileLimit = 100;
    model.loadedFileContext = key;
    $('filesRepo').textContent = 'Repository';
    if (branch)
      showProvenance(
        $('filesProvenance'),
        { sha: branch.sha, provenance: { sha: branch.sha, basis: 'editing branch' } },
        branch.branch || branch.base_branch || 'Repository',
      );
    else {
      showProvenance($('filesProvenance'), old || {}, 'Offline: saved drafts and captured source');
      sourceSync.error =
        'Current GitHub files are unavailable. Saved drafts and captured source remain available.';
    }
    renderFiles();
    updateSourceControls();
  }
  async function applySourceUpdates(snapshot, stillCurrent) {
    const projectId = snapshot.project_id,
      key = contextKey();
    if (!stillCurrent()) return;
    const rows = new Map((snapshot.files || []).map((row) => [row.path, row]));
    await Promise.all(
      ['stylesheet', 'files'].map(async (kind) => {
        const v = viewers[kind];
        if (
          v.projectId !== projectId ||
          (!v.editing && !v.liveSource) ||
          !v.baseBlob ||
          v.busy ||
          sourceSync.busy ||
          matchingOperation(projectId, 'save', v.path)
        )
          return;
        const row = rows.get(v.path);
        if (!row && snapshot.truncated) return; // Omitted is not deleted.
        if (
          row &&
          !row.deleted &&
          !row.conflict &&
          row.blob === v.baseBlob &&
          row.mode === v.baseMode
        ) {
          v.upstreamWarning = '';
          return;
        }
        const warning =
          !row || row.deleted
            ? 'This file was deleted upstream. Your local text is preserved.'
            : row.conflict
              ? 'Preview and review branches conflict for this file. Your local text is preserved.'
              : 'This file changed upstream. Your local text is preserved; review the newer source before syncing.';
        if (
          v.dirty ||
          v.savedDirty ||
          localDraft(projectId, v.path) ||
          !row ||
          row.deleted ||
          row.conflict
        ) {
          v.upstreamWarning = warning;
          if (v.dirty) v.conflict = true;
          return;
        }
        const path = v.path,
          version = v.version,
          editing = v.editing,
          editor = $(`${kind}Editor`),
          before = editor.value;
        const args = { project_id: projectId, path };
        if (v.pageId) args.page_id = v.pageId;
        try {
          const result = await UI.tool('design_source_draft', args);
          if (
            !stillCurrent() ||
            key !== contextKey() ||
            v.path !== path ||
            v.projectId !== projectId ||
            v.version !== version ||
            v.editing !== editing
          )
            return;
          // Recheck after the read: typing, saving and navigation can race it.
          if (v.busy || sourceSync.busy || matchingOperation(projectId, 'save', path)) return;
          if (
            v.dirty ||
            v.savedDirty ||
            localDraft(projectId, path) ||
            (editing && editor.value !== before)
          ) {
            v.upstreamWarning = warning;
            if (v.dirty) v.conflict = true;
            return;
          }
          const raw = String(result.content ?? '');
          v.baseBlob = result.base_blob;
          v.baseMode = result.mode;
          v.version = result.version;
          v.baseSha = result.base_sha;
          v.branch = result.provenance?.editing_ref || result.branch;
          v.savedDirty = !!result.dirty;
          v.upstreamWarning = '';
          v.error = '';
          if (editing) {
            recordLineEndings(v, raw);
            v.original = raw.replace(/\r\n?/g, '\n');
            editor.value = v.original;
          } else v.content = raw;
          renderCode(kind);
          showProvenance(
            $(`${kind === 'files' ? 'filesProvenance' : 'stylesheetMeta'}`),
            { sha: result.base_sha, provenance: { sha: result.base_sha, basis: 'editing branch' } },
            result.dirty ? 'Saved draft' : 'Updated from GitHub',
          );
        } catch {
          if (stillCurrent() && v.path === path && v.projectId === projectId)
            v.upstreamWarning =
              'Upstream changed; the latest source could not be opened. Your local text is preserved.';
        }
      }),
    );
    if (!stillCurrent() || key !== contextKey()) return;
    if (model.filesContext === key) await loadFiles(true, snapshot);
    else model.loadedFileContext = '';
    updateSourceControls();
  }
  // One visible-tab poller. The server coalesces fetches across sessions.
  const sourceWatch = {
    projectId: '',
    timer: null,
    controller: null,
    running: false,
    stopped: false,
    failures: 0,
  };
  const watchEnabled = $('sourceUpdatesEnabled'),
    watchStatus = $('sourceUpdatesStatus');
  try {
    watchEnabled.checked = localStorage.getItem('alcordesign-source-updates') !== 'off';
  } catch {}
  function watchMessage(message, error = false) {
    watchStatus.textContent = message;
    watchStatus.classList.toggle('error', error);
  }
  function scheduleSourceWatch(delay = 30000) {
    clearTimeout(sourceWatch.timer);
    if (!sourceWatch.stopped && !document.hidden && watchEnabled.checked)
      sourceWatch.timer = setTimeout(() => pollSourceUpdates(), delay);
  }
  async function pollSourceUpdates(manual = false) {
    clearTimeout(sourceWatch.timer);
    if (
      sourceWatch.running ||
      sourceWatch.stopped ||
      document.hidden ||
      (!manual && !watchEnabled.checked)
    )
      return;
    const project = state().project,
      projectId = project?.id;
    if (!projectId || state().projectTarget !== projectId) {
      watchMessage('Choose a connected document');
      scheduleSourceWatch();
      return;
    }
    if (!manual && project.source?.kind === 'html') {
      watchMessage('HTML capture · check source manually');
      scheduleSourceWatch();
      return;
    }
    const controller = new AbortController();
    sourceWatch.controller = controller;
    sourceWatch.running = true;
    const stillCurrent = () =>
      !sourceWatch.stopped &&
      !document.hidden &&
      !controller.signal.aborted &&
      state().project?.id === projectId &&
      state().projectTarget === projectId;
    const timeout = setTimeout(() => controller.abort(), 20000);
    let delay = 30000;
    $('sourceUpdatesCheck').disabled = true;
    watchMessage('Checking GitHub…');
    try {
      const response = await fetch('/api/tools', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'design_source_updates',
          arguments: { project_id: projectId },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!stillCurrent()) return;
      delay = Math.max(2000, Math.min(30000, result.retry_after_ms || 30000));
      if (result.state === 'busy') {
        watchMessage('Source operation in progress · checking again shortly');
        return;
      }
      if (result.state !== 'ready' || !result.snapshot) throw new Error('Source check unavailable');
      await applySourceUpdates(result.snapshot, stillCurrent);
      if (!stillCurrent()) return;
      const heads = result.snapshot.heads,
        attention = result.snapshot.files.filter(
          (f) => f.conflict || f.upstream_changed || f.deleted,
        ).length;
      watchMessage(
        `Checked ${new Date(result.observed_at * 1000).toLocaleTimeString()} · preview ${heads.base.slice(0, 8)}${heads.review ? ' · review ' + heads.review.slice(0, 8) : ''}${attention ? ' · ' + attention + ' file(s) need review' : ''}`,
        !!attention,
      );
      watchStatus.title = `Preview: ${heads.base}\nReview: ${heads.review || 'No review branch'}${result.snapshot.truncated ? '\nFile list is limited; saved drafts are included.' : ''}`;
      sourceWatch.failures = 0;
    } catch {
      if (
        !sourceWatch.stopped &&
        !document.hidden &&
        state().project?.id === projectId &&
        !controller.signal.aborted
      ) {
        watchMessage('GitHub unavailable · retrying; local work is preserved', true);
        sourceWatch.failures = Math.min(2, sourceWatch.failures + 1);
      } else if (!sourceWatch.stopped && !document.hidden && state().project?.id === projectId)
        watchMessage('Check interrupted · retrying; local work is preserved', true);
      delay = Math.min(120000, 30000 * 2 ** sourceWatch.failures);
    } finally {
      clearTimeout(timeout);
      sourceWatch.running = false;
      sourceWatch.controller = null;
      $('sourceUpdatesCheck').disabled = false;
      scheduleSourceWatch(delay);
    }
  }
  watchEnabled.onchange = () => {
    try {
      localStorage.setItem('alcordesign-source-updates', watchEnabled.checked ? 'on' : 'off');
    } catch {}
    clearTimeout(sourceWatch.timer);
    sourceWatch.controller?.abort();
    if (watchEnabled.checked) scheduleSourceWatch(0);
    else watchMessage('Automatic source checks paused');
  };
  $('sourceUpdatesCheck').onclick = () => pollSourceUpdates(true);
  document.addEventListener('alcordesign:pagechange', () => {
    const id = state().project?.id || '';
    if (sourceWatch.projectId === id) return;
    sourceWatch.projectId = id;
    sourceWatch.controller?.abort();
    watchMessage('Waiting to check this document');
    scheduleSourceWatch(100);
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(sourceWatch.timer);
    if (document.hidden) {
      sourceWatch.controller?.abort();
      watchMessage('Paused while hidden');
    } else scheduleSourceWatch(100);
  });
  window.addEventListener('pagehide', () => {
    sourceWatch.stopped = true;
    clearTimeout(sourceWatch.timer);
    sourceWatch.controller?.abort();
  });
  window.addEventListener('pageshow', () => {
    sourceWatch.stopped = false;
    scheduleSourceWatch(100);
  });
  scheduleSourceWatch(1000);
  function renderFiles() {
    const root = $('repoFileTree');
    root.replaceChildren();
    let directory = null;
    const query = $('filesSearch').value.toLowerCase().trim(),
      filtered = model.files.filter((file) => file.path.toLowerCase().includes(query));
    for (const file of filtered.slice(0, model.fileLimit)) {
      const parent = file.path.includes('/')
        ? file.path.slice(0, file.path.lastIndexOf('/'))
        : 'Repository root';
      if (directory !== parent) {
        directory = parent;
        const folder = document.createElement('div');
        folder.className = 'repo-folder-label';
        folder.append(glyph('folder'), textSpan(parent));
        root.append(folder);
      }
      const button = document.createElement('button');
      button.className = `repo-file-row${model.activeFile === file.path ? ' active' : ''}`;
      button.title = `${file.path} · ${file.source_kind === 'branch' ? 'repository branch' : 'captured source'}${file.dirty ? ' · saved draft' : ''}${file.conflict ? ` · ${file.conflict_reason || 'Review branch conflict'}` : ''}`;
      button.dataset.path = file.path;
      button.setAttribute('role', 'treeitem');
      button.append(glyph('code'), textSpan(basename(file.path)));
      const kind = document.createElement('small');
      kind.textContent = file.deleted
        ? 'DELETED'
        : file.conflict
          ? 'CONFLICT'
          : file.upstream_changed
            ? 'UPDATED'
            : String(file.kind || file.path.split('.').pop()).toUpperCase() +
              (file.dirty ? ' •' : '');
      button.append(kind);
      button.onclick = () => readFile(file.path).catch(UI.showError);
      root.append(button);
    }
    if (!filtered.length) empty(root, 'No matching repository source files.');
    if (filtered.length > model.fileLimit) {
      const more = document.createElement('button');
      more.className = 'tree-more';
      more.textContent = `Show more · ${filtered.length - model.fileLimit} remaining`;
      more.onclick = () => {
        model.fileLimit += 100;
        renderFiles();
      };
      root.append(more);
    }
  }
  async function readFile(filePath) {
    model.activeFile = filePath;
    renderFiles();
    const key = contextKey(),
      ticket = ++model.fileReadTicket,
      file = model.files.find((item) => item.path === filePath);
    empty($('filesCode'), 'Loading source…');
    try {
      if (file?.conflict && !file.editable) {
        setCode('files', '', filePath, false);
        empty(
          $('filesCode'),
          file.conflict_reason ||
            'Preview and review branches changed this file differently. Resolve the branch conflict before editing.',
        );
        return;
      }
      const result = await UI.tool(
        file?.source_kind === 'branch' ? 'design_source_draft' : 'design_read_source',
        scoped({ path: filePath }),
      );
      if (ticket !== model.fileReadTicket || key !== contextKey()) return;
      setCode('files', result.content, result.path || filePath, !!file?.editable);
      if (file?.source_kind === 'branch') {
        const viewer = viewers.files;
        viewer.liveSource = true;
        viewer.baseBlob = result.base_blob;
        viewer.baseMode = result.mode;
        viewer.version = result.version;
        viewer.savedDirty = !!result.dirty;
      }
      if (file?.source_kind === 'branch')
        showProvenance(
          $('filesProvenance'),
          { sha: result.base_sha, provenance: { sha: result.base_sha, basis: 'editing branch' } },
          result.dirty ? 'Saved draft' : result.branch || result.base_branch || 'Repository',
        );
      else showProvenance($('filesProvenance'), result, 'Captured source');
    } catch (error) {
      if (ticket === model.fileReadTicket) readableError($('filesCode'), error);
    }
  }

  function pageId(entry) {
    return String(entry.page_id || entry.id || '');
  }
  function treeQuery() {
    return $('navSearch').value.trim();
  }
  async function loadTree({ append = false } = {}) {
    const tree = model.tree,
      project = state().project;
    if (!project) {
      empty($('designTree'), 'Choose a design document to browse its page and layer tree.');
      return;
    }
    const query = treeQuery();
    if (project.id !== tree.projectId || query !== tree.query) {
      tree.expanded.clear();
      tree.layers.clear();
      append = false;
    }
    tree.projectId = project.id;
    tree.query = query;
    tree.loading = true;
    const ticket = ++tree.ticket;
    if (!append) {
      tree.entries = [];
      tree.total = 0;
      tree.next = null;
    }
    renderTree();
    try {
      const result = await UI.tool('design_index', {
        project_id: project.id,
        query,
        offset: append ? tree.next || 0 : 0,
        limit: 50,
      });
      if (ticket !== tree.ticket || state().project?.id !== project.id || treeQuery() !== query)
        return;
      tree.entries = append ? [...tree.entries, ...result.entries] : result.entries || [];
      tree.total = result.total ?? tree.entries.length;
      tree.next = result.next_offset ?? null;
      tree.sitemapSync = result.sitemap_sync || null;
      tree.pageCount = result.page_count ?? project.pages?.length ?? tree.total;
      tree.loading = false;
      renderTree();
    } catch (error) {
      if (ticket === tree.ticket) {
        tree.loading = false;
        empty($('designTree'), error.message);
      }
    }
  }
  async function refreshSitemap() {
    const project = state().project,
      tree = model.tree;
    if (
      !project ||
      state().busy ||
      tree.syncBusy ||
      project.source?.kind === 'html' ||
      !project.source?.url
    )
      return;
    tree.syncBusy = true;
    tree.syncError = '';
    renderTree();
    try {
      const result = await UI.tool('design_sync_sitemap', { project_id: project.id });
      if (state().project?.id !== project.id) return;
      await loadTree();
      if (result.complete === false || result.warnings?.length)
        tree.syncError = 'Sitemap refresh is incomplete. Existing captures are preserved.';
      else UI.toast('Sitemap refreshed. Existing captures are preserved.');
    } catch (error) {
      if (state().project?.id === project.id) tree.syncError = error.message || String(error);
    } finally {
      tree.syncBusy = false;
      renderTree();
    }
  }
  function renderSitemapHeader(root) {
    const tree = model.tree,
      project = state().project,
      header = document.createElement('div');
    header.className = 'tree-sitemap-header';
    const status = document.createElement('span');
    status.className = 'tree-sitemap-status';
    const count = tree.sitemapSync?.count;
    status.textContent = `${Number.isFinite(count) ? `${count} sitemap URLs` : 'Sitemap not checked'} · ${tree.pageCount || project.pages?.length || 0} captures`;
    status.title = tree.sitemapSync?.checked_at
      ? `Last checked ${new Date(tree.sitemapSync.checked_at * 1000).toLocaleString()}`
      : 'Sitemap membership is separate from saved captures.';
    header.append(status);
    const button = document.createElement('button');
    button.id = 'refreshSitemap';
    button.className = 'tree-sitemap-refresh';
    button.disabled =
      tree.syncBusy || state().busy || project.source?.kind === 'html' || !project.source?.url;
    button.title = 'Refresh sitemap membership while preserving all saved captures and comments.';
    button.onclick = refreshSitemap;
    if (tree.syncBusy) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      button.append(spinner);
    }
    button.append(document.createTextNode(tree.syncBusy ? 'Refreshing…' : 'Refresh sitemap'));
    header.append(button);
    root.append(header);
    if (tree.syncError) {
      const error = document.createElement('div');
      error.className = 'tree-sitemap-error';
      error.setAttribute('role', 'alert');
      error.textContent = tree.syncError;
      root.append(error);
    }
  }
  async function loadTreeLayers(id, { append = false } = {}) {
    const tree = model.tree,
      key = `${id}/${tree.query}`,
      old = tree.layers.get(key) || { nodes: [], next: null, total: 0 },
      ticket = (old.ticket || 0) + 1;
    tree.layers.set(key, { ...old, loading: true, ticket });
    renderTree();
    try {
      const result = await UI.tool('design_page_tree', {
        project_id: tree.projectId,
        page_id: id,
        query: tree.query,
        depth: 12,
        offset: append ? old.next || 0 : 0,
        limit: 100,
      });
      const current = tree.layers.get(key);
      if (!current || current.ticket !== ticket || state().project?.id !== tree.projectId) return;
      tree.layers.set(key, {
        nodes: append ? [...old.nodes, ...(result.nodes || [])] : result.nodes || [],
        next: result.next_offset ?? null,
        total: result.total ?? 0,
        loading: false,
        ticket,
      });
      renderTree();
    } catch (error) {
      const current = tree.layers.get(key);
      if (current?.ticket === ticket) {
        tree.layers.set(key, { ...old, error: error.message, loading: false, ticket });
        renderTree();
      }
    }
  }
  function toggleTreePage(id) {
    const tree = model.tree;
    if (tree.expanded.has(id)) {
      tree.expanded.delete(id);
      renderTree();
      return;
    }
    tree.expanded.add(id);
    if (!tree.layers.has(`${id}/${tree.query}`)) loadTreeLayers(id);
    else renderTree();
  }
  async function openTreeNode(id, node) {
    if (state().busy) return;
    if (state().page?.id !== id || state().overview) await UI.selectPage(id, { fit: true });
    if (state().page?.id !== id) return;
    const full = (state().page.nodes || []).find(
      (n) => String(n.id) === String(node.id) || n.selector === node.selector,
    );
    if (full) {
      UI.selectNode(full);
      UI.revealNode(full);
      UI.setPanel('design');
      renderTree();
    } else UI.toast('This layer is no longer in the current capture. Refresh the tree.', true);
  }
  function renderTree() {
    const root = $('designTree'),
      tree = model.tree;
    root.replaceChildren();
    if (!state().project) return;
    const heading = document.createElement('div');
    heading.className = 'tree-section-heading';
    heading.append(glyph('folder'), textSpan(state().project.name || 'Design document'));
    root.append(heading);
    renderSitemapHeader(root);
    const count = document.createElement('div');
    count.className = 'tree-result-count';
    count.textContent = tree.query
      ? `${tree.total} matching pages · “${tree.query}”`
      : `${tree.total} pages · expand to inspect layers`;
    root.append(count);
    for (const entry of tree.entries) {
      const id = pageId(entry),
        group = document.createElement('div');
      group.className = 'tree-page-group';
      const expanded = tree.expanded.has(id);
      const row = document.createElement('button');
      row.className = `tree-page-row${state().page?.id === id && !state().overview ? ' active' : ''}`;
      row.dataset.pageId = id;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-expanded', String(expanded));
      row.style.paddingLeft = `${5 + Math.min(Number(entry.depth) || 0, 5) * 9}px`;
      const toggle = textSpan('▶', `tree-expand${expanded ? ' expanded' : ''}`);
      toggle.onclick = (event) => {
        event.stopPropagation();
        toggleTreePage(id);
      };
      const copy = document.createElement('span');
      copy.className = 'tree-page-copy';
      const title = document.createElement('strong');
      title.textContent = entry.title || entry.name || shortPath(entry.url);
      const route = document.createElement('small');
      route.textContent = shortPath(entry.url);
      copy.append(title, route);
      row.append(toggle, glyph('file'), copy);
      const membership = entry.discovery?.sitemap_status || 'unknown';
      const badge = textSpan(
        membership === 'listed' ? '●' : membership === 'not_listed' ? '○' : '?',
        `tree-sitemap-badge ${membership}`,
      );
      badge.title =
        membership === 'listed'
          ? 'Listed in the latest sitemap'
          : membership === 'not_listed'
            ? 'Not listed in the latest sitemap; saved capture is preserved'
            : 'Sitemap membership has not been confirmed';
      badge.setAttribute('aria-label', badge.title);
      row.append(badge);
      if (entry.matched_node_count) {
        const matches = textSpan(String(entry.matched_node_count), 'tree-page-match');
        matches.title = 'Matching layers';
        row.append(matches);
      }
      row.onclick = async () => {
        try {
          await UI.selectPage(id, { fit: true });
          if (!tree.expanded.has(id)) toggleTreePage(id);
        } catch (error) {
          UI.showError(error);
        }
      };
      group.append(row);
      if (expanded) {
        const child = document.createElement('div');
        child.className = 'tree-node-list';
        const layers = tree.layers.get(`${id}/${tree.query}`);
        if (layers?.error) empty(child, layers.error);
        for (const node of layers?.nodes || []) {
          const button = document.createElement('button');
          button.className = `tree-node-row${String(state().selected?.id) === String(node.id) && state().page?.id === id ? ' active' : ''}${node.matched ? ' matched' : ''}`;
          button.style.paddingLeft = `${4 + Math.min(Number(node.depth) || 0, 7) * 8}px`;
          button.dataset.nodeId = node.id;
          button.setAttribute('role', 'treeitem');
          button.title = node.selector || '';
          const copy = document.createElement('span');
          copy.className = 'tree-node-copy';
          const name = document.createElement('strong');
          name.textContent = node.name || node.text || node.tag || 'Layer';
          const detail = document.createElement('small');
          detail.textContent = (
            node.text ||
            node.text_snippet ||
            node.snippet ||
            node.selector ||
            ''
          ).replace(/\s+/g, ' ');
          copy.append(name, detail);
          button.append(
            glyph(
              ['p', 'span', 'h1', 'h2', 'h3', 'a', 'button'].includes(node.tag) ? 'text' : 'frame',
            ),
            copy,
          );
          button.onclick = () => openTreeNode(id, node).catch(UI.showError);
          child.append(button);
        }
        if (layers?.loading || !layers) {
          const loading = document.createElement('div');
          loading.className = 'tree-loading';
          loading.innerHTML = '<span class="spinner"></span>';
          loading.append(document.createTextNode('Reading layers…'));
          child.append(loading);
        } else if (layers.next !== null && layers.next !== undefined) {
          const more = document.createElement('button');
          more.className = 'tree-more';
          more.textContent = 'More layers';
          more.onclick = () => loadTreeLayers(id, { append: true });
          child.append(more);
        } else if (!layers.nodes?.length && !layers.error)
          empty(child, 'No matching layers in this page.');
        group.append(child);
      }
      root.append(group);
    }
    if (tree.loading) {
      const loading = document.createElement('div');
      loading.className = 'tree-loading';
      loading.innerHTML = '<span class="spinner"></span>';
      loading.append(document.createTextNode('Searching the design…'));
      root.append(loading);
    } else if (tree.next !== null) {
      const more = document.createElement('button');
      more.className = 'tree-more';
      more.textContent = 'More pages';
      more.onclick = () => loadTree({ append: true });
      root.append(more);
    } else if (!tree.entries.length) empty(root, 'No pages or layers match this search.');
  }

  // Refresh captures from the private preview only on an explicit user action.
  // Each operation keeps its original request ID until a terminal receipt.
  const livePrefix = 'alcordesign-live-operation:';
  const liveKey = (projectId) => `${livePrefix}${encodeURIComponent(projectId)}:${sourceWindowId}`;
  const liveState = {
    busy: false,
    message: '',
    error: false,
    backup: null,
    timer: null,
    results: [],
    resultsProject: '',
  };
  function liveOperations(projectId) {
    const out = [],
      seen = new Set(),
      prefix = livePrefix + encodeURIComponent(projectId) + ':';
    try {
      for (const key of Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .sort((a, b) => Number(b === liveKey(projectId)) - Number(a === liveKey(projectId)))) {
        let op;
        try {
          op = JSON.parse(localStorage.getItem(key));
        } catch {
          continue;
        }
        if (
          op?.project_id !== projectId ||
          !['page', 'all', 'restore'].includes(op.action) ||
          !/^[A-Za-z0-9_.:/-]{8,128}$/.test(op.request_id || '') ||
          op.args?.project_id !== projectId ||
          op.args?.request_id !== op.request_id ||
          seen.has(op.request_id)
        )
          continue;
        seen.add(op.request_id);
        out.push({ key, op });
      }
    } catch {}
    return out;
  }
  function storeLiveOperation(op) {
    try {
      localStorage.setItem(liveKey(op.project_id), JSON.stringify(op));
      return true;
    } catch {
      return false;
    }
  }
  function updateLiveOperation(op) {
    try {
      for (const { key, op: existing } of liveOperations(op.project_id))
        if (existing.request_id === op.request_id)
          localStorage.setItem(
            key,
            JSON.stringify({ ...existing, state: op.state, job_id: op.job_id }),
          );
    } catch {}
  }
  function clearLiveOperation(op) {
    try {
      const prefix = livePrefix + encodeURIComponent(op.project_id) + ':';
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        let existing;
        try {
          existing = JSON.parse(localStorage.getItem(key));
        } catch {
          continue;
        }
        if (existing?.request_id === op.request_id) localStorage.removeItem(key);
      }
    } catch {}
  }
  function renderLiveControls() {
    const project = state().project,
      page = state().page,
      ops = project ? liveOperations(project.id) : [],
      enabled = !!project && project.source?.kind !== 'html' && !!project.source?.url;
    $('liveRefreshPage').disabled =
      !enabled || !page || state().overview || state().busy || liveState.busy || !!ops.length;
    $('liveRefreshSafeAll').disabled = $('liveRefreshBackupAll').disabled =
      !enabled || state().busy || liveState.busy || !!ops.length;
    $('liveRefreshSnapshots').disabled = !enabled || !page || state().overview || liveState.busy;
    const backup = liveState.backup;
    $('liveRefreshBackupPage').hidden =
      !backup || backup.page_id !== page?.id || backup.revision !== page?.revision;
    $('liveRefreshBackupPage').disabled = state().busy || liveState.busy || !!ops.length;
    const own = project && ops.find((e) => e.key === liveKey(project.id))?.op;
    $('liveRefreshCheck').hidden = !own;
    $('liveRefreshCheck').disabled = liveState.busy;
    $('liveRefreshRetry').hidden = own?.state !== 'not_found';
    $('liveRefreshRetry').disabled = liveState.busy;
    const status = $('liveRefreshStatus');
    status.textContent = liveState.message;
    status.classList.toggle('error', liveState.error);
    const results = $('liveRefreshResults'),
      resultsList = $('liveRefreshResultsList'),
      issues = liveState.resultsProject === project?.id ? liveState.results : [];
    results.hidden = !issues.length;
    resultsList.replaceChildren();
    $('liveRefreshResultsTitle').textContent =
      `${issues.length} ${issues.length === 1 ? 'page needs' : 'pages need'} attention`;
    for (const item of issues.slice(0, 100)) {
      const button = document.createElement('button'),
        label = document.createElement('span'),
        detail = document.createElement('small');
      button.type = 'button';
      label.textContent = shortPath(item.url || item.page_id);
      detail.textContent =
        item.result?.message || item.result?.code || item.state || 'Not refreshed';
      button.title = item.url || item.page_id;
      button.append(label, detail);
      button.onclick = async () => {
        if (UI.hasPendingCanvasInput()) {
          liveMessage(
            'Finish your current design edit or comment before opening another page.',
            true,
          );
          return;
        }
        try {
          await UI.selectPage(item.page_id, { fit: true });
          if (
            state().page?.id === item.page_id &&
            item.result?.code === 'local_or_legacy_conflict' &&
            item.result?.backup_allowed === true
          )
            liveState.backup = { page_id: item.page_id, revision: state().page.revision };
          liveMessage(detail.textContent, item.state !== 'completed');
        } catch (error) {
          liveMessage(error.message, true);
        }
      };
      resultsList.append(button);
    }
    const previous = $('liveRefreshPrevious');
    previous.replaceChildren();
    for (const { key, op } of ops) {
      if (key === liveKey(project.id)) continue;
      const row = document.createElement('div'),
        button = document.createElement('button');
      button.type = 'button';
      button.textContent = `Check earlier ${op.action === 'all' ? 'site' : op.action === 'restore' ? 'restore' : 'page'} refresh`;
      button.onclick = () => checkLiveOperation(op);
      row.append(button);
      if (op.state === 'not_found') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry original';
        retry.onclick = () => submitLiveOperation(op);
        row.append(retry);
      }
      previous.append(row);
    }
  }
  function liveMessage(message, error = false) {
    liveState.message = message;
    liveState.error = error;
    renderLiveControls();
  }
  async function finishLiveReceipt(op, receipt) {
    if (receipt.request_id !== op.request_id || receipt.project_id !== op.project_id) return false;
    if (receipt.state === 'pending') {
      op.state = 'pending';
      op.job_id = receipt.job_id || op.job_id;
      updateLiveOperation(op);
      if (op.job_id && op.action === 'all') UI.trackJob(op.job_id, op.project_id);
      if (state().project?.id === op.project_id)
        liveMessage(
          op.job_id && op.action === 'all'
            ? 'Refreshing pages in the background. Progress appears above the canvas.'
            : 'Refresh is still running. Use Check refresh to see its result.',
        );
      if (liveState.timer) clearTimeout(liveState.timer);
      liveState.timer = setTimeout(() => checkLiveOperation(op), 2500);
      return false;
    }
    if (receipt.state === 'not_found') {
      op.state = 'not_found';
      updateLiveOperation(op);
      liveMessage(
        'The original refresh has no receipt. Check again or retry the same request.',
        true,
      );
      return false;
    }
    if (!['completed', 'partial', 'failed', 'conflict'].includes(receipt.state)) return false;
    clearLiveOperation(op);
    if (liveState.timer) {
      clearTimeout(liveState.timer);
      liveState.timer = null;
    }
    const result = receipt.result || {};
    if (state().project?.id !== op.project_id) return true;
    if (receipt.state === 'conflict' || receipt.state === 'failed') {
      if (
        result.code === 'local_or_legacy_conflict' &&
        result.backup_allowed === true &&
        state().page?.id === op.args.page_id
      )
        liveState.backup = { page_id: op.args.page_id, revision: op.args.expected_revision };
      liveMessage(
        result.message ||
          'The preview refresh could not be completed. Existing designs are preserved.',
        true,
      );
      return true;
    }
    liveState.backup = null;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    let message =
      op.action === 'all'
        ? result.message ||
          'The preview refresh completed. Check the job results for skipped or conflicting pages.'
        : op.action === 'restore'
          ? 'Page backup restored. Saved comments remain.'
          : 'Page refreshed from preview. Saved comments remain; pins may have shifted.';
    if (op.action === 'all') {
      liveState.results = Array.isArray(result.results)
        ? result.results.filter((item) => item.state !== 'completed')
        : [];
      liveState.resultsProject = op.project_id;
      if (Number.isFinite(result.total) && Number.isFinite(result.completed)) {
        const remaining = Math.max(0, result.total - result.completed);
        message += ` Checked ${result.completed}/${result.total} · ${result.conflicts || 0} conflicts · ${result.failed_pages || 0} failures${remaining ? ` · ${remaining} untouched` : ''}.`;
      }
    }
    if (warnings.length) message += ` ${warnings.join(' ')}`;
    if (state().project?.id === op.project_id && op.action !== 'all') {
      if (UI.hasPendingCanvasInput())
        message +=
          ' Finish your current edit or comment, then refresh the project to see the updated page.';
      else
        try {
          await UI.refreshProject();
        } catch {
          message += ' Reload the project to view the updated page.';
        }
    }
    liveMessage(message, receipt.state === 'partial');
    return true;
  }
  async function checkLiveOperation(op) {
    if (liveState.busy) return;
    liveState.busy = true;
    renderLiveControls();
    try {
      const receipt = await UI.tool('design_refresh_operation_status', {
        project_id: op.project_id,
        request_id: op.request_id,
      });
      await finishLiveReceipt(op, receipt);
    } catch (error) {
      op.state = 'uncertain';
      updateLiveOperation(op);
      liveMessage(
        `Refresh outcome is unknown: ${error.message}. Check refresh before retrying.`,
        true,
      );
    } finally {
      liveState.busy = false;
      renderLiveControls();
    }
  }
  async function submitLiveOperation(op) {
    if (liveState.busy) return;
    liveState.busy = true;
    liveState.backup = null;
    renderLiveControls();
    try {
      const name =
        op.action === 'page'
          ? 'design_refresh_live_page'
          : op.action === 'all'
            ? 'design_refresh_live_all'
            : 'design_restore_page_snapshot';
      const receipt = await UI.tool(name, op.args);
      await finishLiveReceipt(op, receipt);
    } catch (error) {
      op.state = 'uncertain';
      updateLiveOperation(op);
      liveMessage(
        `Refresh outcome is unknown: ${error.message}. Check refresh before retrying.`,
        true,
      );
    } finally {
      liveState.busy = false;
      renderLiveControls();
    }
  }
  async function startLiveOperation(action, { keepSnapshot = false, snapshotId = null } = {}) {
    const project = state().project,
      page = state().page;
    if (
      !project ||
      project.source?.kind === 'html' ||
      !project.source?.url ||
      liveState.busy ||
      state().busy ||
      liveOperations(project.id).length
    )
      return;
    if (action !== 'all' && (!page || state().overview)) return;
    if (
      action === 'page' &&
      keepSnapshot &&
      (!liveState.backup ||
        liveState.backup.page_id !== page.id ||
        liveState.backup.revision !== page.revision)
    ) {
      liveMessage(
        'The selected page changed. Check it again before refreshing with a backup.',
        true,
      );
      return;
    }
    if (UI.hasPendingCanvasInput()) {
      liveMessage('Finish your current design edit or comment before refreshing.', true);
      return;
    }
    const requestId = globalThis.crypto?.randomUUID?.();
    if (!requestId) {
      liveMessage('Cannot generate a unique refresh ID in this browser.', true);
      return;
    }
    const args = { project_id: project.id, request_id: requestId };
    if (action !== 'all') {
      args.page_id = page.id;
      args.expected_revision = page.revision;
    }
    if (keepSnapshot) args.keep_snapshot = true;
    if (snapshotId) args.snapshot_id = snapshotId;
    const op = { project_id: project.id, action, request_id: requestId, state: 'pending', args };
    if (!storeLiveOperation(op)) {
      liveMessage(
        'Cannot store the refresh request ID. Free browser storage before refreshing.',
        true,
      );
      return;
    }
    liveMessage('Starting preview refresh…');
    await submitLiveOperation(op);
  }
  async function listLiveSnapshots() {
    const project = state().project,
      page = state().page;
    if (!project || !page || liveState.busy) return;
    const list = $('liveSnapshotList');
    list.hidden = false;
    list.replaceChildren();
    const note = document.createElement('span');
    note.textContent = 'Loading page backups…';
    list.append(note);
    try {
      const result = await UI.tool('design_list_page_snapshots', {
        project_id: project.id,
        page_id: page.id,
      });
      if (state().project?.id !== project.id || state().page?.id !== page.id) return;
      list.replaceChildren();
      for (const item of result.snapshots || []) {
        const row = document.createElement('div'),
          label = document.createElement('span'),
          restore = document.createElement('button');
        row.className = 'live-snapshot-row';
        label.textContent = `Revision ${item.revision} · ${item.reason || 'backup'}`;
        label.title = `${item.snapshot_id} · ${item.comment_count || 0} comments at backup`;
        restore.type = 'button';
        restore.textContent = 'Restore';
        restore.onclick = () => startLiveOperation('restore', { snapshotId: item.snapshot_id });
        row.append(label, restore);
        list.append(row);
      }
      if (!list.children.length) {
        const empty = document.createElement('span');
        empty.textContent = 'No backups for this page yet.';
        list.append(empty);
      }
    } catch (error) {
      list.replaceChildren();
      const p = document.createElement('span');
      p.textContent = error.message;
      list.append(p);
    }
  }
  $('liveRefreshPage').onclick = () => startLiveOperation('page');
  $('liveRefreshSafeAll').onclick = () => startLiveOperation('all');
  $('liveRefreshBackupAll').onclick = () => startLiveOperation('all', { keepSnapshot: true });
  $('liveRefreshBackupPage').onclick = () => startLiveOperation('page', { keepSnapshot: true });
  $('liveRefreshSnapshots').onclick = listLiveSnapshots;
  $('liveRefreshCheck').onclick = () => {
    const project = state().project,
      op = project && liveOperations(project.id).find((e) => e.key === liveKey(project.id))?.op;
    if (op) checkLiveOperation(op);
  };
  $('liveRefreshRetry').onclick = () => {
    const project = state().project,
      op = project && liveOperations(project.id).find((e) => e.key === liveKey(project.id))?.op;
    if (op?.state === 'not_found') submitLiveOperation(op);
  };
  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith(livePrefix)) renderLiveControls();
  });
  document.addEventListener('alcordesign:pagechange', () => {
    if (liveState.backup?.page_id !== state().page?.id) liveState.backup = null;
    $('liveSnapshotList').hidden = true;
    renderLiveControls();
  });
  function activate(panel) {
    if (panel === 'stylesheet') loadStylesheets();
    if (panel === 'files') loadFiles();
    refreshSourceSync();
  }
  let treeDebounce;
  window.AlcorDesignInspectors = {
    activate,
    loadTree,
    hasPendingInput: () => sourceSync.busy || Object.values(viewers).some((v) => v.editing),
    searchTree() {
      clearTimeout(treeDebounce);
      treeDebounce = setTimeout(() => loadTree(), 220);
    },
  };
  $('refreshStylesheets').onclick = () => loadStylesheets(true);
  $('stylesheetSearch').oninput = renderStylesheetChooser;
  $('stylesheetSelect').onchange = () =>
    readStylesheet($('stylesheetSelect').value).catch(UI.showError);
  $('refreshFiles').onclick = () => loadFiles(true);
  $('filesSearch').oninput = () => {
    model.fileLimit = 100;
    renderFiles();
  };
  for (const kind of ['stylesheet', 'files']) {
    $(`${kind}CodePrevPage`).onclick = () => {
      viewers[kind].codePage--;
      renderCode(kind);
      $(`${kind}Code`).scrollTop = 0;
    };
    $(`${kind}CodeNextPage`).onclick = () => {
      viewers[kind].codePage++;
      renderCode(kind);
      $(`${kind}Code`).scrollTop = 0;
    };
    $(`${kind}Find`).oninput = () => {
      viewers[kind].match = 0;
      renderCode(kind);
      updateMatch(kind);
    };
    $(`${kind}Prev`).onclick = () => nextMatch(kind, -1);
    $(`${kind}Next`).onclick = () => nextMatch(kind, 1);
    $(`${kind}Find`).onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nextMatch(kind, event.shiftKey ? -1 : 1);
      }
    };
  }
  $('copyStylesheet').onclick = () => copyCode('stylesheet');
  $('copyFile').onclick = () => copyCode('files');
  $('wrapStylesheet').onchange = () => {
    $('stylesheetCode').classList.toggle('wrap', $('wrapStylesheet').checked);
    $('stylesheetEditor').wrap = $('wrapStylesheet').checked ? 'soft' : 'off';
  };
  $('wrapFile').onchange = () => {
    $('filesCode').classList.toggle('wrap', $('wrapFile').checked);
    $('filesEditor').wrap = $('wrapFile').checked ? 'soft' : 'off';
  };
  for (const kind of ['stylesheet', 'files']) {
    $(`${kind}Edit`).onclick = () => beginSourceEdit(kind);
    $(`${kind}Save`).onclick = () => saveSourceEdit(kind);
    $(`${kind}Discard`).onclick = () => discardSourceEdit(kind);
    $(`${kind}Sync`).onclick = syncSources;
    $(`${kind}CheckSave`).onclick = async () => {
      const v = viewers[kind],
        op = matchingOperation(v.projectId, 'save', v.path);
      if (op && !v.busy) {
        v.busy = true;
        updateSourceControls();
        await checkSourceOperation(op);
        v.busy = false;
        updateSourceControls();
      }
    };
    $(`${kind}RetrySave`).onclick = () => {
      const v = viewers[kind],
        op = matchingOperation(v.projectId, 'save', v.path);
      if (op?.state === 'not_found' && !v.busy) submitSave(op, kind);
    };
    $(`${kind}Check`).onclick = async () => {
      const op = matchingOperation(state().project?.id || '', 'sync');
      if (sourceSync.busy) return;
      sourceSync.busy = true;
      updateSourceControls();
      if (op) await checkSourceOperation(op);
      else await refreshSourceSync({ force: true });
      sourceSync.busy = false;
      updateSourceControls();
    };
    $(`${kind}RetrySync`).onclick = () => {
      const op = matchingOperation(state().project?.id || '', 'sync');
      if (op?.state === 'not_found' && !sourceSync.busy) submitSync(op);
    };
    const editor = $(`${kind}Editor`);
    editor.oninput = () => editSourceInput(kind);
    editor.onkeydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveSourceEdit(kind);
      } else if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const start = editor.selectionStart,
          end = editor.selectionEnd;
        editor.setRangeText('  ', start, end, 'end');
        editSourceInput(kind);
      }
    };
  }
  window.addEventListener('beforeunload', (event) => {
    if (fallbackDrafts.size || Object.values(viewers).some((v) => v.editing && v.dirty)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith(localDraftPrefix) || event.key?.startsWith(operationPrefix))
      updateSourceControls();
  });
  document.addEventListener('alcordesign:pagechange', () => {
    const current = state();
    if (current.panel === 'stylesheet' || current.panel === 'files') activate(current.panel);
    if (current.tab === 'tree') {
      if (model.tree.projectId !== current.project?.id) loadTree();
      else renderTree();
    }
  });
})();
