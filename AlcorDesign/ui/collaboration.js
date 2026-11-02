/**
 * Presence for several editors of one project. Polls and posts to the local collaboration endpoint and reconciles remote changes through window.AlcorDesignUI.
 */
'use strict';

(() => {
  const UI = window.AlcorDesignUI;
  const $ = (id) => document.getElementById(id);
  const session = crypto.randomUUID().replaceAll('-', ''); // Unique even in duplicated tabs.
  const name = $('collaborationName'),
    status = $('collaborationStatus');
  let timer,
    controller,
    running = false,
    stopped = false,
    failures = 0,
    cursor = null;
  let remote = [],
    remotePage = null;
  try {
    name.value = localStorage.getItem('alcordesign-display-name') || 'Designer';
  } catch {}
  name.onchange = () => {
    name.value = name.value.trim().slice(0, 40) || 'Designer';
    try {
      localStorage.setItem('alcordesign-display-name', name.value);
    } catch {}
  };
  function describe(message, error = false) {
    status.textContent = message;
    status.classList.toggle('attention', error);
  }
  function pending() {
    clearTimeout(timer);
    if (!stopped && !document.hidden)
      timer = setTimeout(tick, Math.min(30000, 2000 * 2 ** failures));
  }
  function color(id) {
    return ['#75e4c0', '#f8bf79', '#bda7ff', '#7bc8ff'][parseInt(id.slice(0, 2), 16) % 4];
  }
  function paint() {
    const overlay = $('collaborationOverlay'),
      s = UI.state;
    overlay.replaceChildren();
    if (s.overview || s.page?.id !== remotePage) return;
    for (const peer of remote) {
      if (peer.session_id === session || peer.page_id !== s.page?.id) continue;
      const node = s.page.nodes?.find((n) => n.selector === peer.selector);
      if (node) {
        const box = document.createElement('div');
        box.className = 'collaboration-selection';
        Object.assign(box.style, {
          left: `${node.x}px`,
          top: `${node.y}px`,
          width: `${node.width}px`,
          height: `${node.height}px`,
          borderColor: color(peer.session_id),
        });
        overlay.append(box);
      }
      if (peer.cursor) {
        const pointer = document.createElement('div');
        pointer.className = 'collaboration-cursor';
        pointer.textContent = `↖ ${peer.name}`;
        Object.assign(pointer.style, {
          left: `${peer.cursor.x}px`,
          top: `${peer.cursor.y}px`,
          color: color(peer.session_id),
        });
        overlay.append(pointer);
      }
    }
  }
  $('artboard').addEventListener('pointermove', (event) => {
    const rect = $('artboard').getBoundingClientRect(),
      zoom = UI.state.zoom;
    cursor = {
      x: Math.max(0, (event.clientX - rect.left) / zoom),
      y: Math.max(0, (event.clientY - rect.top) / zoom),
    };
  });
  $('artboard').addEventListener('pointerleave', () => {
    cursor = null;
  });
  document.addEventListener('alcordesign:pagechange', () => {
    cursor = null;
    paint();
  });
  async function tick() {
    clearTimeout(timer);
    if (running || stopped || document.hidden) return;
    const s = UI.state,
      project = s.project?.id,
      page = s.overview ? null : s.page?.id;
    if (!project || s.projectTarget !== project) {
      describe('Choose a document to collaborate');
      pending();
      return;
    }
    running = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000);
    try {
      const response = await fetch(`/api/collaboration/${encodeURIComponent(project)}`, {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session,
          name: name.value.trim().slice(0, 40) || 'Designer',
          page_id: page || null,
          selector: page ? s.selected?.selector || null : null,
          cursor: page ? cursor : null,
        }),
      });
      if (!response.ok) throw new Error(`Collaboration unavailable (HTTP ${response.status})`);
      const snapshot = await response.json();
      if (
        stopped ||
        document.hidden ||
        UI.state.project?.id !== project ||
        UI.state.projectTarget !== project
      )
        return;
      remote = snapshot.sessions;
      remotePage = page;
      const others = remote.filter((p) => p.session_id !== session);
      $('collaborationPeers').textContent = others.length
        ? others.map((p) => p.name).join(', ')
        : 'Only you here';
      $('collaborationPeers').title =
        'Display names identify sessions in this workspace, not verified accounts.';
      paint();
      const outcome = await UI.reconcileCollaboration(project, snapshot.revision, {
        signal: controller.signal,
        stillCurrent: () => !stopped && !document.hidden,
      });
      if (UI.state.project?.id !== project || stopped || document.hidden) return;
      describe(
        outcome === 'pending'
          ? 'Changes waiting · finish or reset your edit to update'
          : 'Live · saved edits shared',
        outcome === 'pending',
      );
      failures = 0;
    } catch (error) {
      if (!stopped && !document.hidden) {
        failures = Math.min(failures + 1, 4);
        remote = [];
        paint();
        $('collaborationPeers').textContent = '';
        describe('Disconnected · reconnecting; your input is preserved', true);
      }
    } finally {
      clearTimeout(timeout);
      controller = null;
      running = false;
      pending();
    }
  }
  function leave() {
    const project = UI.state.project?.id;
    if (project)
      fetch(`/api/collaboration/${encodeURIComponent(project)}`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session,
          name: name.value.trim().slice(0, 40) || 'Designer',
          leave: true,
        }),
      }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) {
      controller?.abort();
      leave();
      remote = [];
      paint();
      describe('Paused while hidden');
    } else {
      failures = 0;
      tick();
    }
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    leave();
  });
  window.addEventListener('pageshow', () => {
    stopped = false;
    tick();
  });
  tick();
})();
