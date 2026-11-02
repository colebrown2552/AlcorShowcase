/**
 * AlcorCLI viewer: draws one recorded run of the policy gate from window.ALCOR_RUN.
 *
 * The data comes from `python demo/run_demo.py --json` (see sample-run.js). Everything is built
 * with textContent, never innerHTML, so a reason string can never turn into markup.
 */

'use strict';

const run = window.ALCOR_RUN;
const FILTERS = ['all', 'admitted', 'refused', 'waiting', 'recorded'];
const state = { filter: 'all', selected: null };

/**
 * Create an element with optional class and text.
 * @param {string} tag - Element name.
 * @param {string} [className] - Space separated classes.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Shorten a hash for display; the full value stays in the detail panel.
 * @param {string} hash - A hex digest.
 * @returns {string} The first 10 characters.
 */
function short(hash) {
  return hash ? hash.slice(0, 10) : '';
}

/**
 * Map a receipt outcome to its colour class.
 * @param {string} outcome - admitted, refused, waiting or recorded.
 * @returns {string} A CSS class name.
 */
function tone(outcome) {
  return outcome === 'admitted' ? 'ok' : outcome;
}

/**
 * Draw the chain status in the header bar.
 * @returns {void}
 */
function renderChain() {
  const box = document.getElementById('chain');
  const verified = el('div', run.chain.ok ? 'ok' : 'refused');
  const mark = run.chain.ok ? '✓ chain verified' : '✗ chain broken';
  verified.textContent = `${mark} · ${run.chain.count} receipts`;
  const tamper = el('small', '', `edit one row and it is found: ${run.tamper.reason}`);
  box.append(verified, tamper);
}

/**
 * Draw the four summary counters.
 * @returns {void}
 */
function renderCounters() {
  const checks = run.steps.flatMap((step) => step.checks);
  const passed = checks.filter((check) => check.ok).length;
  const cards = [
    ['admitted', run.counts.admitted, 'ok'],
    ['refused', run.counts.refused, 'refused'],
    ['waiting for owner', run.counts.waiting, 'waiting'],
    ['demo checks held', `${passed}/${checks.length}`, 'accent'],
  ];
  const box = document.getElementById('counters');
  for (const [label, value, className] of cards) {
    const card = el('div', 'counter');
    card.append(el('b', className, String(value)), el('span', '', label));
    box.append(card);
  }
}

/**
 * Receipts that pass the active filter.
 * @returns {object[]} Matching receipt summaries.
 */
function visibleRows() {
  return run.receipts.filter((r) => state.filter === 'all' || r.outcome === state.filter);
}

/**
 * Draw the filter chips.
 * @returns {void}
 */
function renderFilters() {
  const box = document.getElementById('filters');
  box.replaceChildren();
  for (const name of FILTERS) {
    const count = run.receipts.filter((r) => name === 'all' || r.outcome === name).length;
    const button = el('button', '', `${name} ${count}`);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(name === state.filter));
    button.addEventListener('click', () => {
      state.filter = name;
      renderFilters();
      renderRows();
    });
    box.append(button);
  }
}

/**
 * Draw the table body and keep the selected row highlighted.
 * @returns {void}
 */
function renderRows() {
  const body = document.getElementById('rows');
  body.replaceChildren();
  for (const r of visibleRows()) {
    const tr = el('tr', r.seq === state.selected ? 'selected' : '');
    tr.dataset.seq = String(r.seq);
    const verdict = el('td');
    verdict.append(el('span', `badge ${tone(r.outcome)}`, r.outcome));
    tr.append(
      el('td', 'mono', String(r.seq)),
      el('td', '', r.actor),
      el('td', '', r.subject ? `${r.kind} · ${r.subject}` : r.kind),
      el('td', 'reason', r.reason || '·'),
      verdict,
      el('td', 'mono', short(r.id)),
    );
    tr.children[3].title = r.reason;
    tr.addEventListener('click', () => select(r.seq));
    body.append(tr);
  }
}

/**
 * Append a label and value pair to a definition list.
 * @param {HTMLElement} list - The dl element.
 * @param {string} label - Field name.
 * @param {string} value - Field value.
 * @param {boolean} [mono] - Use the monospace face.
 * @returns {void}
 */
function field(list, label, value, mono) {
  list.append(el('dt', '', label), el('dd', mono ? 'mono' : '', value));
}

/**
 * Draw the detail panel for the selected receipt, then the list of demo steps.
 * @returns {void}
 */
function renderDetail() {
  const r = run.receipts.find((row) => row.seq === state.selected);
  const box = document.getElementById('detail');
  box.replaceChildren();
  box.append(el('h2', '', `receipt #${r.seq}`));
  box.append(el('div', `verdict ${tone(r.outcome)}`, r.outcome));
  box.append(el('p', 'reason-text', r.reason || r.kind));
  const list = el('dl');
  field(list, 'asked by', r.actor);
  field(list, 'kind', r.kind, true);
  field(list, 'subject', r.subject || 'none');
  field(list, 'demo step', `${r.step}. ${run.steps[r.step - 1].title}`);
  const cells = r.body.cells;
  if (cells) {
    const text = Object.entries(cells)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ');
    field(list, 'policy input', text, true);
  }
  const policy = r.body.policy_receipt;
  if (policy && policy.program) field(list, 'program', policy.program, true);
  field(list, 'receipt', short(r.id) + '…', true);
  field(list, 'prev', short(r.prev) + '…', true);
  box.append(list);
  box.append(el('h2', '', 'demo steps'));
  const steps = el('ul', 'steps');
  for (const step of run.steps) {
    const passed = step.checks.filter((c) => c.ok).length;
    const total = step.checks.length;
    const item = el('li');
    item.append(
      el('span', 'step-title', `${step.n}. ${step.title}`),
      el('span', passed === step.checks.length ? 'ok' : 'refused', `${passed}/${total}`),
    );
    steps.append(item);
  }
  box.append(steps);
}

/**
 * Select a receipt by sequence number and redraw the parts that depend on it.
 * @param {number} seq - Receipt sequence number.
 * @returns {void}
 */
function select(seq) {
  state.selected = seq;
  renderRows();
  renderDetail();
}

/**
 * Move the selection with the arrow keys within the filtered rows.
 * @param {KeyboardEvent} event - The key event.
 * @returns {void}
 */
function onKey(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = visibleRows();
  const at = rows.findIndex((r) => r.seq === state.selected);
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  const next = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
  if (next) select(next.seq);
  const node = document.querySelector('tr.selected');
  if (node) node.scrollIntoView({ block: 'nearest' });
  event.preventDefault();
}

renderChain();
renderCounters();
renderFilters();
// Open on a refused tool call: the clearest picture of what the gate is for.
const first = run.receipts.find((r) => r.outcome === 'refused' && r.kind === 'tool.decision');
state.selected = (first || run.receipts[0]).seq;
renderRows();
renderDetail();
document.addEventListener('keydown', onKey);
