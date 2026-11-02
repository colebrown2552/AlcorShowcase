/**
 * Read-only style and layout handoff for the selected node. Values come only from the captured node styles; nothing is resolved or invented. Uses window.AlcorDesignUI.
 */
'use strict';

(() => {
  const UI = window.AlcorDesignUI;
  if (!UI) return;
  const aside = document.querySelector('.properties-sidebar');
  if (!aside) return;

  const panel = document.createElement('section');
  panel.className = 'design-insights';
  panel.setAttribute('aria-label', 'Design insights');
  panel.innerHTML =
    '<div class="di-head"><div><span class="di-eyebrow">CAPTURED DESIGN</span><h2>Style inventory</h2></div><span class="di-count" aria-label="style value count">—</span></div><p class="di-note">Computed styles captured from this page; original token names and source rules are not retained.</p><div class="di-token-list" aria-live="polite"></div><div class="di-selection"></div>';
  aside.append(panel);
  const tokenList = panel.querySelector('.di-token-list');
  const selection = panel.querySelector('.di-selection');
  const count = panel.querySelector('.di-count');
  let inventoryPage = null,
    inventoryRevision = null,
    inventoryItems = null;
  let selectionPage = null,
    selectionRevision = null,
    selectionNode = null;
  const STYLE_KEYS = new Set([
    'color',
    'background',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'margin',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'border',
    'border-color',
    'border-width',
    'border-radius',
    'box-shadow',
    'opacity',
    'display',
    'gap',
    'row-gap',
    'column-gap',
    'align-items',
    'justify-content',
    'flex-direction',
    'flex-wrap',
    'flex-grow',
    'flex-shrink',
    'flex-basis',
    'order',
    'align-content',
    'align-self',
    'justify-items',
    'justify-self',
    'grid-column',
    'grid-row',
    'grid-template-columns',
    'grid-template-rows',
    'grid-auto-flow',
    'place-items',
    'text-align',
    'width',
    'height',
    'min-width',
    'min-height',
    'max-width',
    'max-height',
    'position',
    'overflow',
    'text-decoration',
    'visibility',
  ]);
  const COLOR_KEY = /(^color$|background|border.*color)/;
  const TYPE_KEY = /^(font-family|font-size|font-weight|line-height|letter-spacing)$/;
  const SPACE_KEY = /^(gap|row-gap|column-gap|padding(?:-.+)?|margin(?:-.+)?|border-radius)$/;

  function cssKey(key) {
    return String(key)
      .replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      .toLowerCase();
  }
  function stylesOf(node) {
    const raw = node?.styles;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw)
      .map(([key, value]) => [cssKey(key), value])
      .filter(
        ([key, value]) =>
          STYLE_KEYS.has(key) && typeof value === 'string' && value.trim() && value.length < 2000,
      );
  }
  function text(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = value;
    return el;
  }
  function groupLabel(value) {
    if (COLOR_KEY.test(value)) return 'Color';
    if (TYPE_KEY.test(value)) return 'Type';
    if (SPACE_KEY.test(value)) return 'Spacing';
    return 'Layout';
  }
  function current() {
    const s = UI.state;
    panel.hidden = !s.page || s.overview || s.panel !== 'design';
    if (panel.hidden) return;
    const inventoryChanged =
      inventoryPage !== s.page || inventoryRevision !== s.page.revision || !inventoryItems;
    if (inventoryChanged) {
      const nodes = Array.isArray(s.page.nodes) ? s.page.nodes : [];
      const inventory = new Map();
      for (const node of nodes)
        for (const [key, value] of stylesOf(node)) {
          const id = key + '\u0000' + value;
          if (!inventory.has(id)) inventory.set(id, { key, value, uses: 0 });
          inventory.get(id).uses++;
        }
      inventoryItems = [...inventory.values()].sort(
        (a, b) =>
          groupLabel(a.key).localeCompare(groupLabel(b.key)) ||
          a.key.localeCompare(b.key) ||
          a.value.localeCompare(b.value),
      );
      inventoryPage = s.page;
      inventoryRevision = s.page.revision;
      renderInventory(inventoryItems);
    }
    if (
      selectionPage === s.page &&
      selectionRevision === s.page.revision &&
      selectionNode === s.selected
    )
      return;
    selectionPage = s.page;
    selectionRevision = s.page.revision;
    selectionNode = s.selected;
    renderSelection(s.selected);
  }
  function renderInventory(items) {
    tokenList.replaceChildren();
    count.textContent = String(items.length);
    if (!items.length)
      tokenList.append(text('p', 'di-empty', 'No captured style declarations on this page.'));
    for (const item of items.slice(0, 48)) {
      const row = document.createElement('div');
      row.className = 'di-token';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'di-token-copy';
      copy.title = 'Copy captured CSS value';
      copy.setAttribute('aria-label', `Copy ${item.key}: ${item.value}`);
      if (COLOR_KEY.test(item.key)) {
        const swatch = document.createElement('span');
        swatch.className = 'di-swatch';
        swatch.style.backgroundColor = item.value;
        swatch.setAttribute('aria-hidden', 'true');
        copy.append(swatch);
      }
      const main = document.createElement('span');
      main.className = 'di-token-copy-text';
      main.append(text('strong', '', item.key), text('code', '', item.value));
      copy.append(main);
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(item.value);
          copy.dataset.copied = 'true';
          window.setTimeout(() => delete copy.dataset.copied, 900);
        } catch {
          copy.title = item.value;
        }
      };
      row.append(copy, text('small', 'di-uses', `${item.uses}×`));
      tokenList.append(row);
    }
    if (items.length > 48)
      tokenList.append(text('p', 'di-empty', `${items.length - 48} more distinct values omitted.`));
  }
  function renderSelection(node) {
    selection.replaceChildren();
    if (!node) {
      selection.append(
        text('p', 'di-empty', 'Select a layer to inspect its layout and copy a CSS handoff.'),
      );
      return;
    }
    const captured = stylesOf(node);
    const layout = captured.filter(([key]) =>
      /^(display|gap|row-gap|column-gap|align-items|justify-content|flex-direction|flex-wrap|flex-grow|flex-shrink|flex-basis|order|align-content|align-self|justify-items|justify-self|grid-column|grid-row|grid-template-columns|grid-template-rows|grid-auto-flow|place-items)$/.test(
        key,
      ),
    );
    const box = document.createElement('div');
    box.className = 'di-selected';
    const head = document.createElement('div');
    head.className = 'di-selected-head';
    head.append(
      text(
        'strong',
        '',
        node.name || node.text?.trim()?.slice(0, 36) || node.tag || 'Selected layer',
      ),
    );
    if (node.selector) head.append(text('code', 'di-selector', node.selector));
    box.append(head);
    const mode = layout.find(([key]) => key === 'display')?.[1];
    const layoutLabel =
      mode === 'flex' ? 'Flex layout' : mode === 'grid' ? 'Grid layout' : 'Layout properties';
    box.append(text('h3', 'di-subhead', layoutLabel));
    if (layout.length) {
      const list = document.createElement('dl');
      list.className = 'di-layout-list';
      for (const [key, value] of layout) {
        list.append(text('dt', '', key), text('dd', '', value));
      }
      box.append(list);
    } else
      box.append(text('p', 'di-empty', 'No captured flex or grid declarations for this layer.'));
    const code = captured.map(([key, value]) => `  ${key}: ${value};`).join('\n');
    const handoff = document.createElement('details');
    handoff.className = 'di-handoff';
    handoff.append(text('summary', '', 'CSS handoff'));
    const pre = document.createElement('pre');
    pre.textContent =
      node.selector && code
        ? `${node.selector} {\n${code}\n}`
        : code || '/* No captured declarations */';
    handoff.append(pre);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'di-copy-code';
    button.textContent = 'Copy CSS';
    button.disabled = !code;
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        button.textContent = 'Copied';
        window.setTimeout(() => (button.textContent = 'Copy CSS'), 900);
      } catch {
        button.title = 'Clipboard access is unavailable';
      }
    };
    box.append(handoff, button);
    selection.append(box);
  }
  document.addEventListener('alcordesign:pagechange', () => {
    inventoryPage = null;
    inventoryRevision = null;
    inventoryItems = null;
    selectionPage = null;
    selectionRevision = null;
    selectionNode = null;
    current();
  });
  document.addEventListener('alcordesign:selectionchange', current);
  document.getElementById('designPanelTab')?.addEventListener('click', current);
  current();
})();
