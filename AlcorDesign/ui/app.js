/**
 * Editor shell for AlcorDesign: project state, tool calls to the local server, canvas, layers, comments, import dialog and export. Loaded first; it publishes window.AlcorDesignUI for the other scripts.
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const svgPaths = {
    cursor: '<path d="m5 3 12 8-6 1-3 6-3-15Z"/>',
    hand: '<path d="M8 11V6a2 2 0 0 1 4 0v4-6a2 2 0 0 1 4 0v6-3a2 2 0 0 1 4 0v7c0 5-3 7-7 7-3 0-4-1-6-4l-3-4a2 2 0 0 1 3-2l1 1"/>',
    undo: '<path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -3)"/>',
    redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" transform="translate(0 -3)"/>',
    code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6M14 3l-4 18"/>',
    import: '<path d="M12 3v12m-4-4 4 4 4-4M4 14v6h16v-6"/>',
    export: '<path d="M12 16V3m-4 4 4-4 4 4M4 14v6h16v-6"/>',
    chevron: '<path d="m7 9 5 5 5-5"/>',
    refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    text: '<path d="M3 6V3h18v3M12 3v18m-4 0h8"/>',
    frame: '<path d="M3 7h18M3 17h18M7 3v18M17 3v18"/>',
    image:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
    file: '<path d="M14 2H5v20h14V7Zm0 0v6h5M8 13h8m-8 4h8"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    warning: '<path d="m12 3 10 18H2ZM12 9v5m0 3v1"/>',
    rectangle: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    comment: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3V11a9 9 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
    folder: '<path d="M3 5h7l2 3h9v13H3Z"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPaths[name] || svgPaths.frame}</svg>`;
  }
  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });
  }
  const S = {
    projects: [],
    project: null,
    projectTarget: null,
    page: null,
    selected: null,
    hover: null,
    tab: 'pages',
    overview: false,
    zoom: 0.5,
    tool: 'select',
    space: false,
    busy: false,
    projectTicket: 0,
    loadTicket: 0,
    viewTicket: 0,
    collapsed: new Set(),
    baseline: {},
    jobTimers: new Map(),
    finishedJobs: new Set(),
    importTab: 'site',
    drag: null,
    pointer: null,
    sourceTicket: 0,
    sourceReadTicket: 0,
    panel: 'design',
    comments: [],
    selectedComment: null,
    draftComment: null,
    commentBusy: false,
  };
  const terminalJobs = new Set([
    'done',
    'complete',
    'completed',
    'success',
    'failed',
    'error',
    'cancelled',
    'interrupted',
    'partial',
  ]);
  function toast(message, error = false, duration = error ? 14000 : 4800) {
    const el = document.createElement('div');
    el.className = `toast${error ? ' error' : ''}`;
    const copy = document.createElement('span');
    copy.textContent = String(message);
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.onclick = () => el.remove();
    el.append(copy, close);
    $('toastArea').append(el);
    while ($('toastArea').children.length > 3) $('toastArea').firstElementChild.remove();
    window.setTimeout(() => el.remove(), duration);
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`The application returned HTTP ${response.status} without a JSON response.`);
    }
    if (!response.ok || data.error || data.isError) {
      const error =
        typeof data.error === 'string'
          ? data.error
          : data.error?.message ||
            data.message ||
            data.content?.[0]?.text ||
            `Request failed (HTTP ${response.status}).`;
      const failure = new Error(error);
      failure.status = response.status;
      throw failure;
    }
    return data;
  }
  const tool = (name, args = {}) =>
    api('/api/tools', { method: 'POST', body: JSON.stringify({ name, arguments: args }) });
  const enc = encodeURIComponent;
  function pathLabel(url) {
    try {
      const u = new URL(url);
      return u.pathname || '/';
    } catch {
      return url || 'HTML document';
    }
  }
  function shortTitle(page) {
    const title = String(page.title || pathLabel(page.url));
    return title.replace(/\s*\|\s*[^|]*$/, '').trim() || 'Untitled page';
  }
  function displayUrl(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return 'HTML document';
    }
  }
  function pageIsReady(p) {
    return !!p.screenshot && !['failed', 'error'].includes(p.status);
  }
  function screenshotUrl(page) {
    const raw = page?.screenshot || '';
    if (!raw.startsWith('/files/')) return '';
    return `${raw}${raw.includes('?') ? '&' : '?'}revision=${enc(page.revision || 0)}`;
  }
  function bodyHeight(page) {
    return (
      page.document_height ||
      page.viewport?.height ||
      page.height ||
      Math.max(
        page.viewport?.height || 900,
        ...(page.nodes || []).map((n) => (Number(n.y) || 0) + (Number(n.height) || 0)),
      )
    );
  }
  function setBusy(value, message = 'Rendering changes…') {
    S.busy = value;
    document.body.classList.toggle('busy', value);
    $('loadingOverlay').hidden = !value;
    $('loadingMessage').textContent = message;
    $('applyButton').disabled = value;
    $('viewportSelect').disabled = value || !S.page;
    $('projectSelect').disabled = $('refreshButton').disabled = $('importButton').disabled = value;
    $('saveStatus').classList.toggle('dirty', value);
    $('saveStatus').innerHTML = `<i></i>${value ? 'Saving…' : 'Saved locally'}`;
    updateToolbar();
  }
  function updateToolbar() {
    $('undoButton').disabled = S.busy || !S.page || S.page.can_undo === false;
    $('redoButton').disabled = S.busy || !S.page || S.page.can_redo === false;
    $('exportButton').disabled = !S.project;
    $('overviewButton').disabled = !S.project;
    $('viewportSelect').disabled = S.busy || !S.page || S.overview;
    $('insertText').disabled = $('insertRectangle').disabled = S.busy || !S.page || S.overview;
    $('commentTool').disabled = !S.page || S.overview;
    $('overviewButton').classList.toggle('active', S.overview);
  }
  async function refreshProjects(preferred, { stillCurrent = () => true } = {}) {
    const data = await api('/api/projects');
    if (!stillCurrent()) return null;
    S.projects = data.projects || [];
    const select = $('projectSelect');
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Choose a document';
    select.append(empty);
    S.projects.forEach((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name || 'Untitled design';
      select.append(option);
    });
    const id =
      preferred ||
      S.project?.id ||
      new URLSearchParams(location.search).get('project') ||
      localStorage.getItem('alcordesign-project') ||
      [...S.projects].sort((a, b) => (b.created || 0) - (a.created || 0))[0]?.id;
    if (id && S.projects.some((p) => p.id === id)) {
      select.value = id;
      return id;
    }
    return null;
  }
  async function loadProject(id, { preserve = false } = {}) {
    if (!id) return;
    if (S.projectTarget !== id) {
      S.projectTarget = id;
      ++S.projectTicket;
    }
    const ticket = ++S.loadTicket;
    const project = await api(`/api/project/${enc(id)}`);
    if (ticket !== S.loadTicket) return;
    const oldPage = preserve && S.project?.id === id ? S.page?.id : null;
    if (S.project?.id !== id) $('jobBar').hidden = true;
    S.project = project;
    $('projectSelect').value = id;
    localStorage.setItem('alcordesign-project', id);
    const source = project.source || {};
    $('sourceLabel').textContent =
      source.repo || source.repository || displayUrl(source.url || project.url || '');
    $('pageCount').textContent = (project.pages || []).length;
    renderPages();
    updateToolbar();
    if (oldPage) {
      if (S.overview) renderOverview();
      else {
        const selector = S.selected?.selector;
        await selectPage(oldPage);
        if (selector) {
          const node = S.page?.nodes?.find((n) => n.selector === selector);
          if (node) selectNode(node);
        }
      }
    } else {
      S.page = null;
      S.selected = null;
      S.comments = [];
      S.selectedComment = null;
      S.draftComment = null;
      renderSelection();
      const first = (project.pages || []).find(pageIsReady);
      if (first) await selectPage(first.id, { fit: true });
      else showOverview();
    }
    if (project.job_id && !S.jobTimers.has(project.job_id) && !S.finishedJobs.has(project.job_id))
      trackJob(project.job_id, id);
  }
  function collaborationInputPending() {
    return (
      S.busy ||
      S.commentBusy ||
      !!S.pointer ||
      hasPendingCanvasInput() ||
      !!window.AlcorDesignInspectors?.hasPendingInput()
    );
  }
  async function reconcileCollaboration(
    projectId,
    revision,
    { signal, stillCurrent = () => true } = {},
  ) {
    if (S.project?.id !== projectId || S.projectTarget !== projectId) return 'changed';
    if (S.project.revision === revision) return 'current';
    if (collaborationInputPending()) return 'pending';
    const before = {
      page: S.page,
      comments: S.comments,
      load: S.loadTicket,
      view: S.viewTicket,
      project: S.project,
      selected: S.selected,
    };
    const current = () =>
      stillCurrent() &&
      !signal?.aborted &&
      S.project === before.project &&
      S.projectTarget === projectId &&
      S.page === before.page &&
      S.comments === before.comments &&
      S.selected === before.selected &&
      S.loadTicket === before.load &&
      S.viewTicket === before.view &&
      !collaborationInputPending();
    const project = await api(`/api/project/${enc(projectId)}`, { signal });
    if (!current()) return 'pending';
    const page =
      before.page && !S.overview
        ? await api(`/api/page/${enc(projectId)}/${enc(before.page.id)}`, { signal })
        : null;
    if (!current()) return 'pending';
    S.project = project;
    if (page) {
      const changed = page.revision !== S.page.revision;
      S.page = page;
      S.comments = page.comments || [];
      if (changed) {
        S.selected = page.nodes?.find((n) => n.selector === before.selected?.selector) || null;
        S.hover = null;
        showPage(false);
        renderLayers();
        renderSelection();
        if (S.selected) fillProperties();
        document.dispatchEvent(new CustomEvent('alcordesign:pagechange'));
      } else renderComments();
    } else if (S.overview) renderOverview();
    $('pageCount').textContent = project.pages?.length || 0;
    renderPages();
    updateToolbar();
    return 'updated';
  }
  function renderPages() {
    const search = $('navSearch').value.toLowerCase().trim();
    const list = $('pageList');
    list.replaceChildren();
    const pages = (S.project?.pages || []).filter((p) =>
      `${p.title} ${p.url}`.toLowerCase().includes(search),
    );
    if (!pages.length) {
      const p = document.createElement('p');
      p.className = 'nav-empty';
      p.textContent = S.project
        ? 'No matching pages.'
        : 'Import a website or HTML to add your first page.';
      list.append(p);
      return;
    }
    pages.forEach((page) => {
      const button = document.createElement('button');
      button.className = `page-item${S.page?.id === page.id && !S.overview ? ' active' : ''}`;
      button.dataset.pageId = page.id;
      button.title = page.url || page.title || 'HTML document';
      if (S.page?.id === page.id && !S.overview) button.setAttribute('aria-current', 'page');
      const glyph = document.createElement('span');
      glyph.innerHTML = icon('file');
      const copy = document.createElement('span');
      copy.className = 'page-item-copy';
      const title = document.createElement('span');
      title.className = 'page-item-title';
      title.textContent = shortTitle(page);
      const path = document.createElement('span');
      path.className = 'page-item-path';
      path.textContent = pathLabel(page.url);
      copy.append(title, path);
      const dot = document.createElement('i');
      dot.className = `page-dot ${page.status || 'discovered'}`;
      dot.title = page.status || 'Waiting to render';
      button.append(glyph, copy, dot);
      button.onclick = () => selectPage(page.id, { fit: true }).catch(showError);
      list.append(button);
    });
  }
  async function selectPage(id, { fit = false } = {}) {
    if (S.busy) return;
    const projectId = S.project?.id;
    if (!projectId) return;
    const ticket = ++S.loadTicket;
    const viewTicket = S.viewTicket;
    $('pageStatus').textContent = 'Loading page…';
    const page = await api(`/api/page/${enc(projectId)}/${enc(id)}`);
    if (ticket !== S.loadTicket || viewTicket !== S.viewTicket || S.project?.id !== projectId)
      return;
    S.page = page;
    S.overview = false;
    S.selected = null;
    S.hover = null;
    S.collapsed.clear();
    S.comments = page.comments || [];
    S.selectedComment = null;
    S.draftComment = null;
    showPage(fit);
    renderPages();
    renderLayers();
    renderSelection();
    updateToolbar();
    document.dispatchEvent(new CustomEvent('alcordesign:pagechange'));
  }
  function showPage(fit = false) {
    const page = S.page;
    if (!page) return;
    $('welcome').hidden = true;
    $('overview').hidden = true;
    $('overview').replaceChildren();
    $('canvasContent').hidden = false;
    $('pageTitle').textContent = shortTitle(page);
    $('pageImage').alt = `Rendered design: ${shortTitle(page)}`;
    $('artboardSize').textContent =
      `${page.viewport?.width || 1440} × ${Math.round(bodyHeight(page))}`;
    $('viewportSelect').value = String(page.viewport?.width || 1440);
    if (!$('viewportSelect').value) {
      const option = new Option(`Custom · ${page.viewport?.width}`, String(page.viewport?.width));
      $('viewportSelect').append(option);
      $('viewportSelect').value = String(page.viewport?.width);
    }
    const image = screenshotUrl(page);
    $('pageImage').src = image || '';
    $('artboardShell').hidden = !image;
    $('layerCount').textContent = (page.nodes || []).length;
    $('pageStatus').textContent =
      page.status === 'error'
        ? page.error || page.warnings?.[0] || 'Render failed'
        : image
          ? `${(page.nodes || []).length} layers · ${page.viewport?.width || 1440}px · revision ${page.revision || 0}`
          : 'Waiting for this page to render';
    $('pageStatus').title = (page.warnings || []).join('\n');
    $('canvasHint').innerHTML = `${icon('cursor')} Click to select · Drag to move · Space to pan`;
    if (fit) {
      fitWidth();
      $('canvas').scrollTop = 0;
      $('canvas').scrollLeft = 0;
    } else applyZoom();
    renderComments();
    if (!image) {
      const p = document.createElement('div');
      p.className = 'nav-empty';
      p.textContent =
        page.error ||
        (page.status === 'error' ? page.warnings?.[0] : '') ||
        'This page is waiting for a render. Its artboard will appear when the import finishes.';
      $('artboardLabel').after(p);
      p.dataset.placeholder = 'true';
    }
    $('canvasContent')
      .querySelectorAll('[data-placeholder]')
      .forEach((el, index) => {
        if (image || index > 0) el.remove();
      });
  }
  function showOverview() {
    ++S.viewTicket;
    S.overview = true;
    S.selected = null;
    S.hover = null;
    $('canvasContent').hidden = true;
    $('pageImage').removeAttribute('src');
    $('overview').hidden = !S.project;
    $('welcome').hidden = !!S.project;
    renderOverview();
    renderSelection();
    renderPages();
    renderComments();
    updateToolbar();
    $('canvas').scrollTop = 0;
    $('pageStatus').textContent = S.project
      ? `${(S.project.pages || []).length} pages in this document`
      : 'Ready';
    $('canvasHint').innerHTML = `${icon('grid')} Select an artboard to open it`;
  }
  function renderOverview() {
    const overview = $('overview');
    overview.replaceChildren();
    if (!S.project) return;
    const heading = document.createElement('div');
    heading.className = 'overview-heading';
    const copy = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = S.project.name || 'Your design';
    const detail = document.createElement('p');
    const ready = (S.project.pages || []).filter(pageIsReady).length;
    detail.textContent = `${ready} rendered · ${(S.project.pages || []).length} pages discovered`;
    copy.append(title, detail);
    heading.append(copy);
    overview.append(heading);
    (S.project.pages || []).forEach((page) => {
      const card = document.createElement('button');
      card.className = 'overview-card';
      card.dataset.pageId = page.id;
      card.title = page.url || page.title || '';
      const preview = document.createElement('div');
      preview.className = pageIsReady(page) ? 'overview-preview' : 'overview-placeholder';
      if (pageIsReady(page)) {
        const img = document.createElement('img');
        img.src = screenshotUrl(page);
        img.alt = '';
        img.loading = 'lazy';
        preview.append(img);
      } else {
        const span = document.createElement('span');
        span.innerHTML = icon(page.status === 'error' ? 'warning' : 'file');
        const text = document.createElement('span');
        text.textContent = page.status === 'error' ? 'Render failed' : 'Waiting to render';
        preview.append(span, text);
      }
      const meta = document.createElement('div');
      meta.className = 'overview-card-meta';
      const title = document.createElement('strong');
      title.textContent = shortTitle(page);
      const url = document.createElement('small');
      url.textContent = pathLabel(page.url);
      meta.append(title, url);
      card.append(preview, meta);
      card.onclick = () => selectPage(page.id, { fit: true }).catch(showError);
      overview.append(card);
    });
  }
  function setTab(tab) {
    S.tab = tab;
    $('pagesTab').classList.toggle('active', tab === 'pages');
    $('layersTab').classList.toggle('active', tab === 'layers');
    $('pagesTab').setAttribute('aria-selected', String(tab === 'pages'));
    $('layersTab').setAttribute('aria-selected', String(tab === 'layers'));
    $('treeTab').classList.toggle('active', tab === 'tree');
    $('treeTab').setAttribute('aria-selected', String(tab === 'tree'));
    $('pageList').hidden = tab !== 'pages';
    $('layerList').hidden = tab !== 'layers';
    $('designTree').hidden = tab !== 'tree';
    $('navSearch').value = '';
    $('navSearch').placeholder =
      tab === 'pages'
        ? 'Find a page…'
        : tab === 'layers'
          ? 'Find a layer…'
          : 'Search pages and layers…';
    if (tab === 'tree') window.AlcorDesignInspectors?.loadTree();
    else tab === 'pages' ? renderPages() : renderLayers();
  }
  function nodeIcon(node) {
    return ['img', 'svg', 'canvas', 'video', 'picture'].includes(node.tag)
      ? 'image'
      : node.text &&
          [
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'p',
            'span',
            'a',
            'button',
            'label',
            'li',
            'strong',
            'small',
          ].includes(node.tag)
        ? 'text'
        : 'frame';
  }
  function nodeName(node) {
    return String(node.name || node.text?.trim().slice(0, 40) || node.tag || 'Layer').replace(
      /\s+/g,
      ' ',
    );
  }
  function renderLayers() {
    const list = $('layerList');
    list.replaceChildren();
    const nodes = S.page?.nodes || [];
    const search = $('navSearch').value.toLowerCase().trim();
    if (!nodes.length) {
      const p = document.createElement('p');
      p.className = 'nav-empty';
      p.textContent = 'Open a rendered page to inspect its layers.';
      list.append(p);
      return;
    }
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const children = new Map();
    nodes.forEach((n) => {
      const p = String(n.parent_id ?? '');
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(n);
    });
    function depth(n) {
      let d = 0,
        parent = n.parent_id;
      const seen = new Set();
      while (parent && byId.has(String(parent)) && d < 30 && !seen.has(String(parent))) {
        seen.add(String(parent));
        d++;
        parent = byId.get(String(parent)).parent_id;
      }
      return d;
    }
    function hiddenByParent(n) {
      let parent = n.parent_id;
      const seen = new Set();
      while (parent && byId.has(String(parent)) && !seen.has(String(parent))) {
        seen.add(String(parent));
        if (S.collapsed.has(String(parent))) return true;
        parent = byId.get(String(parent)).parent_id;
      }
      return false;
    }
    const fragment = document.createDocumentFragment();
    nodes
      .filter((n) =>
        search
          ? `${nodeName(n)} ${n.tag} ${n.selector} ${n.text || ''}`.toLowerCase().includes(search)
          : !hiddenByParent(n),
      )
      .forEach((node) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `layer-row${String(S.selected?.id) === String(node.id) ? ' active' : ''}`;
        row.dataset.nodeId = node.id;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-selected', String(String(S.selected?.id) === String(node.id)));
        row.style.paddingLeft = `${6 + Math.min(search ? 0 : depth(node), 8) * 10}px`;
        row.title = node.selector;
        const toggle = document.createElement('span');
        const hasChildren = children.has(String(node.id));
        toggle.className = `layer-toggle${hasChildren ? (S.collapsed.has(String(node.id)) ? '' : ' expanded') : ' blank'}`;
        toggle.textContent = '▶';
        if (hasChildren) {
          row.setAttribute('aria-expanded', String(!S.collapsed.has(String(node.id))));
          toggle.onclick = (e) => {
            e.stopPropagation();
            const id = String(node.id);
            S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id);
            renderLayers();
          };
        }
        const glyph = document.createElement('span');
        glyph.innerHTML = icon(nodeIcon(node));
        const name = document.createElement('span');
        name.className = 'layer-name';
        name.textContent = nodeName(node);
        row.append(toggle, glyph, name);
        row.onclick = () => {
          if (!S.busy) {
            selectNode(node);
            revealNode(node);
          }
        };
        fragment.append(row);
      });
    list.append(fragment);
  }
  function selectNode(node) {
    S.selected = node;
    renderSelection();
    renderLayers();
    fillProperties();
  }
  function renderSelection() {
    document.dispatchEvent(new CustomEvent('alcordesign:selectionchange'));
    const active = S.selected && !S.overview;
    $('emptyProperties').hidden = !!active || S.panel !== 'design';
    $('propertyForm').hidden = !active || S.panel !== 'design';
    $('selectionBox').hidden = !active;
    $('hoverBox').hidden = !S.hover || S.overview || String(S.hover.id) === String(S.selected?.id);
    if (active) positionOutline($('selectionBox'), S.selected);
    if (S.hover) positionOutline($('hoverBox'), S.hover);
    if (active) {
      $('selectionCaption').textContent =
        `${Math.round(S.selected.width)} × ${Math.round(S.selected.height)}`;
      $('selectionCaption').style.transform = `scale(${1 / S.zoom})`;
    }
  }
  function positionOutline(element, node, dx = 0, dy = 0) {
    Object.assign(element.style, {
      left: `${node.x + dx}px`,
      top: `${node.y + dy}px`,
      width: `${node.width}px`,
      height: `${node.height}px`,
      outlineWidth: `${(element.id === 'selectionBox' ? 1.5 : 1) / S.zoom}px`,
    });
  }
  function revealNode(node) {
    const canvas = $('canvas');
    const bounds = $('artboardShell').getBoundingClientRect(),
      area = canvas.getBoundingClientRect();
    const top = bounds.top - area.top + canvas.scrollTop + node.y * S.zoom;
    const left = bounds.left - area.left + canvas.scrollLeft + node.x * S.zoom;
    if (top < canvas.scrollTop + 50 || top > canvas.scrollTop + canvas.clientHeight - 70)
      canvas.scrollTo({ top: Math.max(0, top - 100), behavior: 'smooth' });
    if (left < canvas.scrollLeft || left > canvas.scrollLeft + canvas.clientWidth - 30)
      canvas.scrollLeft = Math.max(0, left - 100);
  }
  const fieldStyleMap = {
    propWidth: 'width',
    propHeight: 'height',
    propPadding: 'padding',
    propRadius: 'border-radius',
    propFontFamily: 'font-family',
    propFontSize: 'font-size',
    propFontWeight: 'font-weight',
    propLineHeight: 'line-height',
    propLetterSpacing: 'letter-spacing',
    propColor: 'color',
    propBackground: 'background-color',
    propOpacity: 'opacity',
    propDisplay: 'display',
    propDirection: 'flex-direction',
    propWrap: 'flex-wrap',
    propGap: 'gap',
    propRowGap: 'row-gap',
    propColumnGap: 'column-gap',
    propAlign: 'align-items',
    propJustify: 'justify-content',
    propAlignContent: 'align-content',
    propColumns: 'grid-template-columns',
    propRows: 'grid-template-rows',
    propGridFlow: 'grid-auto-flow',
    propJustifyItems: 'justify-items',
    propGrow: 'flex-grow',
    propShrink: 'flex-shrink',
    propBasis: 'flex-basis',
    propAlignSelf: 'align-self',
    propJustifySelf: 'justify-self',
    propOrder: 'order',
    propGridColumn: 'grid-column',
    propGridRow: 'grid-row',
  };
  function fillProperties() {
    const n = S.selected;
    if (!n) return;
    const styles = n.styles || {};
    $('selectedIcon').innerHTML = icon(nodeIcon(n));
    $('selectedName').textContent = nodeName(n);
    $('selectedSelector').textContent = n.selector || '';
    $('selectedTag').textContent = `<${n.tag}>`;
    $('selectedDimensions').textContent = `${Math.round(n.width)} × ${Math.round(n.height)}`;
    $('propX').value = Math.round(n.x);
    $('propY').value = Math.round(n.y);
    $('propWidth').value = Math.round(n.width);
    $('propHeight').value = Math.round(n.height);
    for (const [id, key] of Object.entries(fieldStyleMap))
      if (id !== 'propWidth' && id !== 'propHeight') {
        const field = $(id),
          value = styles[key] ?? (id === 'propOpacity' ? '1' : '');
        if (field.tagName === 'SELECT') {
          field.querySelectorAll('[data-captured-value]').forEach((option) => option.remove());
          if (value && !Array.from(field.options).some((option) => option.value === value)) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            option.dataset.capturedValue = 'true';
            field.append(option);
          }
        }
        field.value = value;
      }
    updateLayoutFields();
    $('propText').value = n.text || '';
    $('propCustom').value = '';
    $('textNote').hidden = !(S.page.nodes || []).some(
      (child) => String(child.parent_id) === String(n.id),
    );
    $('textSwatch').style.background = styles.color || 'transparent';
    $('backgroundSwatch').style.background = styles['background-color'] || 'transparent';
    S.baseline = Object.fromEntries(
      ['propX', 'propY', 'propText', ...Object.keys(fieldStyleMap)].map((id) => [id, $(id).value]),
    );
    $('propertyNote').textContent = 'Saved to this design document.';
  }
  function updateLayoutFields() {
    const mode = $('propDisplay').value;
    $('flexLayoutFields').hidden = !mode.includes('flex');
    $('gridLayoutFields').hidden = !mode.includes('grid');
  }
  function cssUnits(key, value) {
    return [
      'width',
      'height',
      'padding',
      'border-radius',
      'font-size',
      'letter-spacing',
      'gap',
      'row-gap',
      'column-gap',
      'flex-basis',
    ].includes(key) && /^-?\d+(\.\d+)?$/.test(value)
      ? `${value}px`
      : value;
  }
  function translation(node, dx, dy) {
    const original = (node.styles?.translate || '').split(/\s+/);
    const x = parseFloat(original[0]) || 0,
      y = parseFloat(original[1]) || 0;
    return `${Math.round((x + dx) * 100) / 100}px ${Math.round((y + dy) * 100) / 100}px`;
  }
  function hasPendingCanvasInput() {
    if (
      S.draftComment ||
      S.commentBusy ||
      $('newCommentBody').value.length ||
      $('commentReplyBody')?.value.length
    )
      return true;
    if (!S.selected) return false;
    return (
      !!$('propCustom').value.trim() ||
      Object.entries(S.baseline).some(([id, value]) => $(id)?.value !== value)
    );
  }
  async function applyProperties(event) {
    event.preventDefault();
    if (!S.selected || S.busy) return;
    const styles = {};
    for (const [id, key] of Object.entries(fieldStyleMap)) {
      const value = $(id).value.trim();
      if (value !== S.baseline[id]) styles[key] = cssUnits(key, value);
    }
    const dx = Number($('propX').value) - Number(S.baseline.propX),
      dy = Number($('propY').value) - Number(S.baseline.propY);
    if (dx || dy) styles.translate = translation(S.selected, dx, dy);
    const custom = $('propCustom').value.trim();
    if (custom) {
      for (const line of custom.split(/[;\n]/).filter((s) => s.trim())) {
        const index = line.indexOf(':');
        if (index < 1) throw new Error('Use property: value for each custom CSS declaration.');
        const name = line.slice(0, index).trim(),
          value = line.slice(index + 1).trim();
        if (!/^(--[a-zA-Z0-9_-]+|[a-z-]+)$/.test(name))
          throw new Error(`Invalid CSS property: ${name}`);
        styles[name] = value;
      }
    }
    const args = { styles };
    if ($('propText').value !== S.baseline.propText) args.text = $('propText').value;
    if (!Object.keys(styles).length && !Object.hasOwn(args, 'text'))
      return toast('No changes to apply.');
    await changeNode(args);
  }
  async function changeNode(change) {
    if (!S.selected || S.busy) return;
    const selector = S.selected.selector;
    setBusy(true);
    try {
      const result = await tool('design_update_node', {
        project_id: S.project.id,
        page_id: S.page.id,
        selector,
        expected_revision: S.page.revision,
        ...change,
      });
      await acceptUpdatedPage(result, selector);
      toast('Design updated.');
    } finally {
      setBusy(false);
    }
  }
  async function acceptUpdatedPage(result, selector = S.selected?.selector) {
    const page = result.page || result;
    S.page = page.nodes ? page : await api(`/api/page/${enc(S.project.id)}/${enc(S.page.id)}`);
    S.comments = S.page.comments || S.comments;
    const index = (S.project.pages || []).findIndex((p) => p.id === S.page.id);
    if (index >= 0) S.project.pages[index] = { ...S.project.pages[index], ...S.page };
    S.selected = (S.page.nodes || []).find((n) => n.selector === selector) || null;
    S.hover = null;
    showPage(false);
    renderPages();
    renderLayers();
    renderSelection();
    if (S.selected) fillProperties();
    updateToolbar();
    document.dispatchEvent(new CustomEvent('alcordesign:pagechange'));
  }
  async function history(direction) {
    if (!S.page || S.busy) return;
    setBusy(true, direction === 'undo' ? 'Restoring previous design…' : 'Restoring next design…');
    try {
      const result = await tool(`design_${direction}`, {
        project_id: S.project.id,
        page_id: S.page.id,
        expected_revision: S.page.revision,
      });
      await acceptUpdatedPage(result);
    } finally {
      setBusy(false);
    }
  }
  async function insertNode(kind) {
    if (!S.page || S.busy || S.overview) return;
    setBusy(true, `Adding ${kind}…`);
    try {
      const result = await tool('design_insert_node', {
        project_id: S.project.id,
        page_id: S.page.id,
        selector: S.selected?.selector || 'body',
        expected_revision: S.page.revision,
        kind,
        ...(kind === 'text' ? { text: 'Your text here' } : {}),
      });
      await acceptUpdatedPage(result);
      toast(`${kind === 'text' ? 'Text' : 'Rectangle'} added.`);
    } finally {
      setBusy(false);
    }
  }
  async function removeNode() {
    if (!S.selected || S.busy || S.overview) return;
    if (['html', 'body'].includes(S.selected.tag))
      throw new Error('Select an element inside the page to remove.');
    setBusy(true, 'Removing element…');
    try {
      const result = await tool('design_remove_node', {
        project_id: S.project.id,
        page_id: S.page.id,
        selector: S.selected.selector,
        expected_revision: S.page.revision,
      });
      await acceptUpdatedPage(result);
      toast('Element removed. Undo is available.');
    } finally {
      setBusy(false);
    }
  }
  function applyZoom() {
    if (!S.page) {
      $('zoomValue').textContent = `${Math.round(S.zoom * 100)}%`;
      return;
    }
    const width = S.page.viewport?.width || 1440,
      height = bodyHeight(S.page);
    $('artboard').style.width = `${width}px`;
    $('artboard').style.minHeight = `${height}px`;
    $('artboard').style.transform = `scale(${S.zoom})`;
    $('artboardShell').style.width = `${width * S.zoom}px`;
    $('artboardShell').style.height = `${height * S.zoom}px`;
    $('artboardLabel').style.width = `${width * S.zoom}px`;
    $('zoomValue').textContent = `${Math.round(S.zoom * 100)}%`;
    renderSelection();
    renderCommentPins();
  }
  function zoomTo(value, anchor) {
    const previous = S.zoom;
    const canvas = $('canvas');
    const rect = canvas.getBoundingClientRect();
    const x = anchor ? anchor.x - rect.left : canvas.clientWidth / 2,
      y = anchor ? anchor.y - rect.top : canvas.clientHeight / 2;
    S.zoom = Math.max(0.08, Math.min(3, value));
    applyZoom();
    canvas.scrollLeft = ((canvas.scrollLeft + x) * S.zoom) / previous - x;
    canvas.scrollTop = ((canvas.scrollTop + y) * S.zoom) / previous - y;
  }
  function fitWidth() {
    if (!S.page) return;
    const padding = innerWidth <= 1200 ? 60 : 100;
    S.zoom = Math.min(
      1,
      Math.max(0.08, ($('canvas').clientWidth - padding - 1) / (S.page.viewport?.width || 1440)),
    );
    applyZoom();
  }
  function pagePoint(event) {
    const rect = $('artboard').getBoundingClientRect();
    return { x: (event.clientX - rect.left) / S.zoom, y: (event.clientY - rect.top) / S.zoom };
  }
  function inside(node, p) {
    return (
      p.x >= node.x && p.x <= node.x + node.width && p.y >= node.y && p.y <= node.y + node.height
    );
  }
  function hitNode(p, preferSelected = false) {
    if (preferSelected && S.selected && inside(S.selected, p)) return S.selected;
    return (
      (S.page?.nodes || [])
        .filter((n) => n.width > 0 && n.height > 0 && inside(n, p))
        .sort((a, b) => a.width * a.height - b.width * b.height)[0] || null
    );
  }
  function pointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target.closest('.comment-pin')) return;
    const canvas = $('canvas');
    if (S.tool === 'hand' || S.space || event.button === 1) {
      event.preventDefault();
      S.pointer = {
        type: 'pan',
        x: event.clientX,
        y: event.clientY,
        left: canvas.scrollLeft,
        top: canvas.scrollTop,
        pointerId: event.pointerId,
      };
      canvas.classList.add('panning');
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (S.busy || S.overview || !S.page || !$('artboard').contains(event.target)) return;
    if (S.tool === 'comment') {
      event.preventDefault();
      if (!S.commentBusy) {
        const p = pagePoint(event);
        S.draftComment = {
          x: Math.max(0, Math.min(S.page.viewport?.width || 1440, Math.round(p.x))),
          y: Math.max(0, Math.min(bodyHeight(S.page), Math.round(p.y))),
        };
        S.selectedComment = null;
        setPanel('comments');
        renderComments();
        $('newCommentBody').focus();
      }
      return;
    }
    event.preventDefault();
    const point = pagePoint(event);
    let node = hitNode(point, true);
    if (event.altKey && S.selected?.parent_id)
      node =
        (S.page.nodes || []).find((n) => String(n.id) === String(S.selected.parent_id)) || node;
    if (!node) {
      selectNode(null);
      return;
    }
    selectNode(node);
    S.pointer = {
      type: 'node',
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      node,
      dx: 0,
      dy: 0,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  }
  function pointerMove(event) {
    const drag = S.pointer;
    const canvas = $('canvas');
    if (drag?.type === 'pan') {
      canvas.scrollLeft = drag.left - (event.clientX - drag.x);
      canvas.scrollTop = drag.top - (event.clientY - drag.y);
      return;
    }
    if (drag?.type === 'node') {
      drag.dx = (event.clientX - drag.x) / S.zoom;
      drag.dy = (event.clientY - drag.y) / S.zoom;
      if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 5)
        drag.moved = true;
      if (drag.moved) {
        positionOutline($('selectionBox'), drag.node, drag.dx, drag.dy);
        $('propX').value = Math.round(drag.node.x + drag.dx);
        $('propY').value = Math.round(drag.node.y + drag.dy);
      }
      return;
    }
    if (
      S.busy ||
      S.overview ||
      !S.page ||
      S.tool === 'hand' ||
      S.tool === 'comment' ||
      S.space ||
      !$('artboard').contains(event.target)
    )
      return;
    const hovered = hitNode(pagePoint(event));
    if (String(hovered?.id) !== String(S.hover?.id)) {
      S.hover = hovered;
      renderSelection();
    }
  }
  async function pointerUp(event) {
    const drag = S.pointer;
    S.pointer = null;
    $('canvas').classList.remove('panning');
    if ($('canvas').hasPointerCapture(event.pointerId))
      $('canvas').releasePointerCapture(event.pointerId);
    if (drag?.type === 'node' && drag.moved) {
      try {
        await changeNode({ styles: { translate: translation(drag.node, drag.dx, drag.dy) } });
      } catch (error) {
        renderSelection();
        fillProperties();
        showError(error);
      }
    }
  }
  function setTool(toolName) {
    S.tool = toolName;
    $('selectTool').classList.toggle('active', toolName === 'select');
    $('handTool').classList.toggle('active', toolName === 'hand');
    $('commentTool').classList.toggle('active', toolName === 'comment');
    $('selectTool').setAttribute('aria-pressed', String(toolName === 'select'));
    $('handTool').setAttribute('aria-pressed', String(toolName === 'hand'));
    $('commentTool').setAttribute('aria-pressed', String(toolName === 'comment'));
    $('canvas').classList.toggle('pan-mode', toolName === 'hand' || S.space);
    $('canvas').classList.toggle('comment-mode', toolName === 'comment' && !S.space);
    if (toolName === 'comment') {
      S.hover = null;
      setPanel('comments');
      $('canvasHint').innerHTML = `${icon('comment')} Click the canvas to leave a comment · C`;
      renderSelection();
    }
  }
  async function renderViewport() {
    if (!S.page || S.busy) return;
    const width = Number($('viewportSelect').value);
    setBusy(true, `Rendering at ${width}px…`);
    try {
      const result = await tool('design_render_page', {
        project_id: S.project.id,
        page_id: S.page.id,
        width,
        height: width < 600 ? 844 : 1000,
        expected_revision: S.page.revision,
      });
      await acceptUpdatedPage(result);
      fitWidth();
    } finally {
      setBusy(false);
    }
  }
  function openImport(tab = 'site') {
    setImportTab(tab);
    $('importError').hidden = true;
    $('importDialog').showModal();
  }
  function setImportTab(tab) {
    S.importTab = tab;
    document
      .querySelectorAll('[data-import-tab]')
      .forEach((button) => button.classList.toggle('active', button.dataset.importTab === tab));
    $('importSiteFields').hidden = tab !== 'site';
    $('importGithubFields').hidden = tab !== 'github';
    $('importHtmlFields').hidden = tab !== 'html';
  }
  async function configureGithubImport() {
    const tab = document.querySelector('[data-import-tab="github"]');
    try {
      const status = await tool('design_status');
      if (status.repo) $('importRepo').value = status.repo;
      if (status.github_repository) return;
    } catch {
      /* Treat an unreachable status tool like an unconfigured source. */
    }
    tab.disabled = true;
    $('importRepo').disabled = true;
    $('importRef').disabled = true;
    $('importGithubNote').textContent =
      'GitHub source is not configured. Set ALCORDESIGN_GITHUB_REPO to owner/repo and restart the server.';
  }
  async function startImport(event) {
    event.preventDefault();
    $('startImport').disabled = true;
    $('importError').hidden = true;
    try {
      const name =
        $('importName').value.trim() || (S.importTab === 'html' ? 'HTML design' : 'Imported site');
      let result;
      if (S.importTab === 'site')
        result = await tool('design_import_site', {
          url: $('importUrl').value.trim(),
          name,
          max_pages: Number($('importMax').value) || 300,
        });
      else if (S.importTab === 'html') {
        if (!$('importHtml').value.trim()) throw new Error('Paste HTML to import.');
        result = await tool('design_import_html', {
          html: $('importHtml').value,
          name,
          base_url: $('importBase').value.trim(),
        });
      } else {
        const args = { repository: $('importRepo').value.trim(), name };
        if ($('importRef').value.trim()) args.ref = $('importRef').value.trim();
        result = await tool('design_import_github', args);
      }
      $('importDialog').close();
      await refreshProjects(result.project_id);
      await loadProject(result.project_id);
      if (result.job_id) trackJob(result.job_id, result.project_id);
      else toast('Design imported.');
    } catch (error) {
      $('importError').textContent = error.message;
      $('importError').hidden = false;
    } finally {
      $('startImport').disabled = false;
    }
  }
  function trackJob(id, projectId) {
    if (S.jobTimers.has(id) || S.finishedJobs.has(id)) return;
    S.jobTimers.set(id, null);
    const poll = async () => {
      const ticket = S.projectTicket;
      const current = () =>
        S.projectTicket === ticket && S.projectTarget === projectId && S.project?.id === projectId;
      try {
        const job = await api(`/api/jobs/${enc(id)}`);
        if (current()) {
          $('jobBar').hidden = false;
          $('jobMessage').textContent = job.message || 'Rendering imported pages…';
          $('jobCount').textContent = job.total
            ? `${job.completed || 0} / ${job.total}`
            : job.status || 'Discovering';
          $('jobProgress').style.width =
            `${job.total ? Math.min(100, (100 * (job.completed || 0)) / job.total) : 5}%`;
          const project = await api(`/api/project/${enc(projectId)}`);
          if (current()) {
            S.project = project;
            $('pageCount').textContent = (project.pages || []).length;
            renderPages();
            if (S.overview) renderOverview();
            if (S.page && !S.overview && !S.busy && !hasPendingCanvasInput()) {
              const pageId = S.page.id;
              const pageTicket = S.loadTicket;
              const viewTicket = S.viewTicket;
              const newer = project.pages?.find((p) => p.id === pageId);
              if (
                newer &&
                pageIsReady(newer) &&
                (!S.page.screenshot || newer.revision !== S.page.revision)
              ) {
                const page = await api(`/api/page/${enc(projectId)}/${enc(pageId)}`);
                if (
                  current() &&
                  S.loadTicket === pageTicket &&
                  S.viewTicket === viewTicket &&
                  !S.overview &&
                  S.page?.id === pageId &&
                  !S.busy &&
                  !hasPendingCanvasInput()
                ) {
                  const fit = !S.page.screenshot;
                  S.page = page;
                  showPage(fit);
                  renderLayers();
                  renderSelection();
                }
              }
            }
          }
        }
        if (terminalJobs.has(String(job.status).toLowerCase())) {
          S.jobTimers.delete(id);
          S.finishedJobs.add(id);
          // A valid terminal status can arrive after leaving and returning to
          // this project. Do not apply its old snapshots, but do finish the bar.
          const terminalTicket = S.projectTicket;
          const terminalCurrent = () =>
            S.projectTicket === terminalTicket &&
            S.projectTarget === projectId &&
            S.project?.id === projectId;
          if (terminalCurrent()) {
            $('jobBar').hidden = true;
            await refreshProjects(projectId, { stillCurrent: terminalCurrent });
            if (terminalCurrent()) updateToolbar();
          }
          if (['failed', 'error', 'interrupted'].includes(String(job.status).toLowerCase()))
            toast(job.error || job.message || 'Import did not complete.', true);
          else
            toast(
              (job.message ||
                `Import finished. ${job.completed || 0} of ${job.total || job.completed || 0} pages processed.`) +
                (hasPendingCanvasInput()
                  ? ' Finish your current edit, then refresh the project to see the updated page.'
                  : ''),
              job.status === 'partial',
            );
          return;
        }
        S.jobTimers.set(id, window.setTimeout(poll, 2000));
      } catch (error) {
        S.jobTimers.delete(id);
        if (current()) {
          $('jobMessage').textContent = 'Connection interrupted. Refresh to check this import.';
          $('jobCount').textContent = 'Unknown';
          showError(error);
        } else toast(`Import status unavailable: ${error.message || String(error)}`, true);
      }
    };
    poll();
  }
  async function exportDocument(format) {
    $('exportMenu').hidden = true;
    if (!S.project) return;
    const result = await tool('design_export', { project_id: S.project.id, format });
    const u = new URL(result.url, location.origin);
    if (u.origin !== location.origin || !u.pathname.startsWith('/files/'))
      throw new Error('Export returned an unexpected download location.');
    const a = document.createElement('a');
    a.href = u.href;
    a.download = result.name || `AlcorDesign.${format}`;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    toast('Export prepared.');
  }
  async function openSource() {
    $('sourceDialog').showModal();
    $('sourceContent').hidden = true;
    $('sourceSearch').value = '';
    await loadSourceFiles();
  }
  async function loadSourceFiles() {
    const ticket = ++S.sourceTicket;
    const result = await tool('design_repo_files', {
      query: $('sourceSearch').value,
      ...(S.project ? { project_id: S.project.id } : {}),
      ...(S.page ? { page_id: S.page.id } : {}),
    });
    if (ticket !== S.sourceTicket) return;
    $('repoMeta').textContent =
      `${result.repo || 'Repository'}${result.sha ? '  ·  ' + result.sha.slice(0, 12) : ''}`;
    const list = $('sourceFiles');
    list.replaceChildren();
    for (const file of result.files || []) {
      const row = document.createElement('button');
      row.className = 'source-file';
      const glyph = document.createElement('span');
      glyph.innerHTML = icon('code');
      const path = document.createElement('span');
      path.textContent = file.path;
      const kind = document.createElement('small');
      kind.textContent = String(file.kind || file.path.split('.').pop()).toUpperCase();
      row.append(glyph, path, kind);
      row.onclick = () => readSource(file.path).catch(showError);
      list.append(row);
    }
    if (!list.children.length) {
      const p = document.createElement('p');
      p.className = 'nav-empty';
      p.textContent = 'No matching source files.';
      list.append(p);
    }
  }
  async function readSource(path) {
    const ticket = ++S.sourceReadTicket;
    $('sourceContent').textContent = 'Loading source…';
    $('sourceContent').hidden = false;
    $('sourceContent').setAttribute('aria-label', path);
    const result = await tool('design_read_source', {
      path,
      ...(S.project ? { project_id: S.project.id } : {}),
      ...(S.page ? { page_id: S.page.id } : {}),
    });
    if (ticket !== S.sourceReadTicket) return;
    $('sourceContent').textContent = result.content || '';
    $('sourceContent').scrollTop = 0;
    $('sourceContent').setAttribute('aria-label', result.path || path);
  }
  function setPanel(panel) {
    S.panel = panel;
    for (const name of ['design', 'stylesheet', 'files', 'comments']) {
      const tab = $(`${name}PanelTab`);
      tab.classList.toggle('active', panel === name);
      tab.setAttribute('aria-selected', String(panel === name));
      if (name !== 'design') $(`${name}Panel`).hidden = panel !== name;
    }
    document.body.classList.toggle(
      'source-panel-open',
      panel === 'stylesheet' || panel === 'files',
    );
    renderSelection();
    if (panel === 'comments') renderComments();
    if (panel === 'stylesheet' || panel === 'files') window.AlcorDesignInspectors?.activate(panel);
  }
  function commentAuthor() {
    const author = $('commentAuthor').value.trim() || 'You';
    localStorage.setItem('alcordesign-comment-author', author);
    return author;
  }
  function commentDate(created) {
    const date = new Date(Number(created || 0) * (Number(created) > 1e12 ? 1 : 1000));
    return Number.isNaN(date.valueOf())
      ? ''
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function commentAvatar(author) {
    const el = document.createElement('span');
    el.className = 'comment-avatar';
    el.textContent = String(author || 'You')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => Array.from(x)[0] || '')
      .join('')
      .toUpperCase();
    return el;
  }
  function renderCommentPins() {
    const root = $('commentPins');
    root.replaceChildren();
    if (!S.page || S.overview) return;
    const visible = S.comments.filter((c) => !c.resolved || $('showResolved').checked);
    const pin = (comment, draft = false) => {
      const anchor = document.createElement('span');
      anchor.className = 'comment-anchor';
      anchor.style.left = `${comment.x}px`;
      anchor.style.top = `${comment.y}px`;
      const button = document.createElement('button');
      button.className = `comment-pin${comment.resolved ? ' resolved' : ''}${String(S.selectedComment) === String(comment.id) ? ' active' : ''}${draft ? ' draft' : ''}`;
      button.type = 'button';
      button.style.transform = `scale(${1 / S.zoom})`;
      button.dataset.commentId = comment.id || 'draft';
      button.setAttribute(
        'aria-label',
        draft
          ? 'New comment position'
          : `Comment by ${comment.author}: ${String(comment.body).slice(0, 100)}`,
      );
      button.title = draft ? 'New comment' : `${comment.author}: ${comment.body}`;
      if (draft) button.innerHTML = icon('plus');
      else if (comment.resolved) button.innerHTML = icon('check');
      else button.textContent = String(S.comments.indexOf(comment) + 1);
      button.onclick = (event) => {
        event.stopPropagation();
        if (!draft) openComment(comment.id);
      };
      anchor.append(button);
      root.append(anchor);
    };
    visible.forEach((c) => pin(c));
    if (S.draftComment) pin(S.draftComment, true);
  }
  function openComment(id) {
    S.selectedComment = id;
    S.draftComment = null;
    $('newCommentBody').value = '';
    setPanel('comments');
    renderComments();
    const c = S.comments.find((c) => String(c.id) === String(id));
    if (c) revealNode({ x: c.x, y: c.y, width: 1, height: 1 });
  }
  function commentEntry(item) {
    const entry = document.createElement('div');
    entry.className = 'comment-entry';
    entry.append(commentAvatar(item.author));
    const body = document.createElement('div');
    body.className = 'comment-entry-body';
    const meta = document.createElement('div');
    meta.className = 'comment-entry-meta';
    const author = document.createElement('strong');
    author.textContent = item.author || 'You';
    const time = document.createElement('time');
    time.textContent = commentDate(item.created);
    if (item.created)
      time.dateTime = new Date(
        Number(item.created) * (Number(item.created) > 1e12 ? 1 : 1000),
      ).toISOString();
    meta.append(author, time);
    const text = document.createElement('p');
    text.textContent = item.body || '';
    body.append(meta, text);
    entry.append(body);
    return entry;
  }
  function renderComments() {
    $('commentsCount').textContent = S.comments.filter((c) => !c.resolved).length;
    $('newCommentForm').hidden = !S.draftComment || S.overview;
    $('commentPlaceHint').hidden = !!S.draftComment || !!S.selectedComment;
    $('commentPlaceHint').querySelector('span:last-child').textContent =
      !S.page || S.overview
        ? 'Open a page to add comments.'
        : S.tool === 'comment'
          ? 'Click the canvas to leave a comment.'
          : 'Press C, then click the canvas to leave a comment.';
    if (S.draftComment)
      $('newCommentPosition').textContent = `X ${S.draftComment.x} · Y ${S.draftComment.y}`;
    const thread = $('commentThread');
    thread.replaceChildren();
    const selected = S.comments.find((c) => String(c.id) === String(S.selectedComment));
    thread.hidden = !selected || S.overview;
    if (selected && !S.overview) {
      const top = document.createElement('div');
      top.className = 'comment-thread-top';
      const label = document.createElement('span');
      label.textContent = 'Comment thread';
      const actions = document.createElement('div');
      actions.className = 'comment-thread-actions';
      const resolve = document.createElement('button');
      resolve.id = 'resolveComment';
      resolve.className = `icon-button resolve-button${selected.resolved ? ' active' : ''}`;
      resolve.innerHTML = icon('check');
      resolve.title = selected.resolved ? 'Reopen thread' : 'Resolve thread';
      resolve.setAttribute('aria-label', resolve.title);
      resolve.onclick = () =>
        commentAction('design_resolve_comment', {
          comment_id: selected.id,
          resolved: !selected.resolved,
        }).catch(showError);
      const remove = document.createElement('button');
      remove.id = 'deleteComment';
      remove.className = 'icon-button';
      remove.innerHTML = icon('trash');
      remove.title = 'Delete thread';
      remove.setAttribute('aria-label', 'Delete thread');
      remove.onclick = () =>
        commentAction('design_delete_comment', { comment_id: selected.id }).catch(showError);
      const close = document.createElement('button');
      close.className = 'icon-button';
      close.innerHTML = icon('close');
      close.title = 'Close thread';
      close.setAttribute('aria-label', 'Close comment thread');
      close.onclick = () => {
        S.selectedComment = null;
        renderComments();
      };
      actions.append(resolve, remove, close);
      top.append(label, actions);
      thread.append(top);
      if (selected.resolved) {
        const note = document.createElement('div');
        note.className = 'comment-thread-resolved';
        note.textContent = 'Resolved · Reopen to continue the discussion.';
        thread.append(note);
      }
      thread.append(commentEntry(selected));
      const replies = document.createElement('div');
      replies.className = 'comment-replies';
      for (const reply of selected.replies || []) replies.append(commentEntry(reply));
      thread.append(replies);
      const form = document.createElement('form');
      form.className = 'comment-reply-form';
      const input = document.createElement('textarea');
      input.id = 'commentReplyBody';
      input.rows = 2;
      input.maxLength = 10000;
      input.required = true;
      input.placeholder = 'Reply to this thread…';
      input.setAttribute('aria-label', 'Reply to comment');
      const footer = document.createElement('div');
      footer.className = 'reply-footer';
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.id = 'postReply';
      submit.className = 'accent-button';
      submit.textContent = 'Reply';
      footer.append(submit);
      form.append(input, footer);
      form.onsubmit = (event) => {
        event.preventDefault();
        const body = input.value.trim();
        if (body)
          commentAction('design_reply_comment', {
            comment_id: selected.id,
            body,
            author: commentAuthor(),
          }).catch(showError);
      };
      thread.append(form);
    }
    const list = $('commentList');
    list.replaceChildren();
    const visible = S.comments.filter((c) => !c.resolved || $('showResolved').checked);
    const heading = document.createElement('div');
    heading.className = 'comment-list-heading';
    heading.textContent = `${visible.length} ${visible.length === 1 ? 'thread' : 'threads'} on this page`;
    list.append(heading);
    for (const comment of visible) {
      const button = document.createElement('button');
      button.className = `comment-list-item${String(S.selectedComment) === String(comment.id) ? ' active' : ''}`;
      button.dataset.commentId = comment.id;
      button.append(commentAvatar(comment.author));
      const copy = document.createElement('span');
      copy.className = 'comment-list-copy';
      const name = document.createElement('strong');
      name.textContent = comment.author || 'You';
      const body = document.createElement('p');
      body.textContent = comment.body;
      const small = document.createElement('small');
      const count = (comment.replies || []).length;
      small.textContent = `${commentDate(comment.created)}${count ? ` · ${count} ${count === 1 ? 'reply' : 'replies'}` : ''}${comment.resolved ? ' · Resolved' : ''}`;
      copy.append(name, body, small);
      button.append(copy);
      button.onclick = () => openComment(comment.id);
      list.append(button);
    }
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'comment-empty';
      empty.textContent = S.comments.length
        ? 'All threads are resolved. Use “Show resolved” to see them.'
        : 'No comments yet. Add a pin to keep feedback beside the design.';
      list.append(empty);
    }
    renderCommentPins();
  }
  async function refreshComments() {
    if (!S.project || !S.page || S.overview) return;
    const id = S.page.id;
    const result = await tool('design_list_comments', { project_id: S.project.id, page_id: id });
    if (S.page?.id !== id) return;
    S.comments = result.comments || [];
    S.page.comments = S.comments;
    renderComments();
  }
  async function commentAction(name, args) {
    if (!S.project || !S.page || S.commentBusy) return;
    const projectId = S.project.id,
      pageId = S.page.id;
    S.commentBusy = true;
    $('commentsPanel').classList.add('comment-pending');
    try {
      const result = await tool(name, { project_id: projectId, page_id: pageId, ...args });
      if (S.project?.id !== projectId || S.page?.id !== pageId) return result;
      S.comments = result.comments || [];
      S.page.comments = S.comments;
      if (result.comment?.id) S.selectedComment = result.comment.id;
      if (name === 'design_delete_comment') S.selectedComment = null;
      S.draftComment = null;
      $('newCommentBody').value = '';
      renderComments();
      return result;
    } finally {
      S.commentBusy = false;
      $('commentsPanel').classList.remove('comment-pending');
    }
  }
  async function postComment() {
    if (!S.draftComment) return;
    const body = $('newCommentBody').value.trim();
    if (!body) return;
    await commentAction('design_add_comment', { ...S.draftComment, body, author: commentAuthor() });
  }
  function showError(error) {
    const message = error.message || String(error);
    toast(message, true);
    $('pageStatus').textContent = 'Action could not be completed';
  }
  function keyboard(event) {
    const editing = event.target.closest('input,textarea,select,[contenteditable="true"]');
    if (editing || document.querySelector('dialog[open]')) return;
    if (event.code === 'Space') {
      if (
        event.target.closest(
          'button,a[href],summary,[role=button],[role=link],[role=checkbox],[role=switch]',
        )
      )
        return;
      event.preventDefault();
      S.space = true;
      $('canvas').classList.add('pan-mode');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      history(event.shiftKey ? 'redo' : 'undo').catch(showError);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      history('redo').catch(showError);
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    if (event.key === 'v' || event.key === 'V') setTool('select');
    if (event.key === 'h' || event.key === 'H') setTool('hand');
    if (event.key === 'c' || event.key === 'C') setTool('comment');
    if (event.key === 'Escape') {
      S.selected = null;
      S.hover = null;
      S.draftComment = null;
      renderSelection();
      renderLayers();
      renderComments();
      $('exportMenu').hidden = true;
    }
    if (event.key === '/') {
      event.preventDefault();
      $('navSearch').focus();
    }
    if (event.key === 'Delete' && S.panel === 'design' && S.tool !== 'comment') {
      event.preventDefault();
      removeNode().catch(showError);
    }
    if (event.key === '+' || event.key === '=') zoomTo(S.zoom * 1.2);
    if (event.key === '-') zoomTo(S.zoom / 1.2);
    if (event.key === '1') fitWidth();
  }
  hydrateIcons();
  document
    .querySelectorAll('.mobile-workspace-controls button[data-mobile-pane]')
    .forEach((button) => {
      button.onclick = () => {
        const pane = button.dataset.mobilePane;
        document.body.dataset.mobilePane = pane;
        document
          .querySelectorAll('.mobile-workspace-controls button[data-mobile-pane]')
          .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      };
    });
  $('projectSelect').onchange = () => loadProject($('projectSelect').value).catch(showError);
  $('refreshButton').onclick = async () => {
    try {
      if (S.project) await loadProject(S.project.id, { preserve: true });
      else {
        const id = await refreshProjects();
        if (id) await loadProject(id);
      }
    } catch (error) {
      showError(error);
    }
  };
  $('pagesTab').onclick = () => setTab('pages');
  $('layersTab').onclick = () => setTab('layers');
  $('treeTab').onclick = () => setTab('tree');
  $('navSearch').oninput = () =>
    S.tab === 'tree'
      ? window.AlcorDesignInspectors?.searchTree()
      : S.tab === 'pages'
        ? renderPages()
        : renderLayers();
  $('selectTool').onclick = () => setTool('select');
  $('handTool').onclick = () => setTool('hand');
  $('undoButton').onclick = () => history('undo').catch(showError);
  $('redoButton').onclick = () => history('redo').catch(showError);
  $('insertText').onclick = () => insertNode('text').catch(showError);
  $('insertRectangle').onclick = () => insertNode('rectangle').catch(showError);
  $('removeNode').onclick = () => removeNode().catch(showError);
  $('commentTool').onclick = () => setTool('comment');
  $('designPanelTab').onclick = () => {
    setPanel('design');
    if (S.tool === 'comment') setTool('select');
  };
  $('commentsPanelTab').onclick = () => {
    setPanel('comments');
    refreshComments().catch(showError);
  };
  $('showResolved').onchange = renderComments;
  $('refreshComments').onclick = () => refreshComments().catch(showError);
  $('cancelComment').onclick = () => {
    S.draftComment = null;
    $('newCommentBody').value = '';
    renderComments();
  };
  $('newCommentForm').onsubmit = (event) => {
    event.preventDefault();
    postComment().catch(showError);
  };
  $('commentAuthor').value = localStorage.getItem('alcordesign-comment-author') || 'You';
  $('stylesheetPanelTab').onclick = () => setPanel('stylesheet');
  $('filesPanelTab').onclick = () => setPanel('files');
  $('overviewButton').onclick = showOverview;
  $('zoomOut').onclick = () => zoomTo(S.zoom / 1.2);
  $('zoomIn').onclick = () => zoomTo(S.zoom * 1.2);
  $('zoomValue').onclick = fitWidth;
  $('viewportSelect').onchange = () => renderViewport().catch(showError);
  $('canvas').addEventListener('pointerdown', pointerDown);
  $('canvas').addEventListener('pointermove', pointerMove);
  $('canvas').addEventListener('pointerup', pointerUp);
  $('canvas').addEventListener('pointercancel', (event) => {
    S.pointer = null;
    $('canvas').classList.remove('panning');
    renderSelection();
    if (S.selected) fillProperties();
  });
  $('canvas').addEventListener('pointerleave', () => {
    if (!S.pointer) {
      S.hover = null;
      renderSelection();
    }
  });
  $('artboard').addEventListener('dblclick', (event) => {
    if (!S.busy && !S.overview && S.tool !== 'comment' && !event.target.closest('.comment-pin')) {
      const node = hitNode(pagePoint(event));
      if (node) selectNode(node);
    }
  });
  $('canvas').addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomTo(S.zoom * Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
      }
    },
    { passive: false },
  );
  document.addEventListener('keydown', keyboard);
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      S.space = false;
      setTool(S.tool);
    }
  });
  window.addEventListener('blur', () => {
    S.space = false;
    S.pointer = null;
    $('canvas').classList.remove('panning');
    setTool(S.tool);
  });
  $('propDisplay').onchange = updateLayoutFields;
  $('resetProperties').onclick = () => {
    if (!S.busy && S.selected) fillProperties();
  };
  $('propertyForm').onsubmit = (event) => applyProperties(event).catch(showError);
  $('propColor').oninput = () => {
    $('textSwatch').style.background = $('propColor').value;
  };
  $('propBackground').oninput = () => {
    $('backgroundSwatch').style.background = $('propBackground').value;
  };
  $('importButton').onclick = () => openImport();
  $('welcomeImport').onclick = () => openImport();
  $('welcomeHtml').onclick = () => openImport('html');
  $('importForm').onsubmit = startImport;
  document.querySelectorAll('[data-import-tab]').forEach((button) => {
    button.onclick = () => setImportTab(button.dataset.importTab);
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.onclick = () => $(button.dataset.close).close();
  });
  $('exportButton').onclick = (event) => {
    event.stopPropagation();
    $('exportMenu').hidden = !$('exportMenu').hidden;
  };
  document.addEventListener('click', (event) => {
    if (!$('exportMenu').contains(event.target) && !$('exportButton').contains(event.target))
      $('exportMenu').hidden = true;
  });
  document.querySelectorAll('[data-format]').forEach((button) => {
    button.onclick = () => exportDocument(button.dataset.format).catch(showError);
  });
  $('sourceButton').onclick = () => openSource().catch(showError);
  let sourceDebounce;
  $('sourceSearch').oninput = () => {
    clearTimeout(sourceDebounce);
    sourceDebounce = setTimeout(() => loadSourceFiles().catch(showError), 220);
  };
  $('pageImage').onload = () => {
    if (S.page && $('pageImage').naturalWidth) {
      const expected = bodyHeight(S.page);
      if (Math.abs($('pageImage').naturalHeight - expected) > 2) {
        S.page.document_height = $('pageImage').naturalHeight;
        applyZoom();
      }
    }
  };
  $('pageImage').onerror = () => {
    if (S.page?.screenshot)
      $('pageStatus').textContent =
        'The rendered image could not be loaded. Refresh the project to retry.';
  };
  updateToolbar();
  renderPages();
  configureGithubImport();
  window.AlcorDesignUI = {
    get state() {
      return S;
    },
    tool,
    icon,
    selectPage,
    selectNode,
    revealNode,
    setPanel,
    showError,
    toast,
    hasPendingCanvasInput,
    reconcileCollaboration,
    refreshProject: () =>
      S.project ? loadProject(S.project.id, { preserve: true }) : Promise.resolve(),
    trackJob,
  };
  (async () => {
    try {
      const id = await refreshProjects();
      if (id) await loadProject(id);
      else showOverview();
    } catch (error) {
      showError(error);
      $('saveStatus').innerHTML = '<i></i> Disconnected';
    }
  })();
})();
