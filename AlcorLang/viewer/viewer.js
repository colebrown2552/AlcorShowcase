/**
 * AlcorLang viewer: shows real AlcorLang programs beside their execution, from window.ALCOR_RUN.
 *
 * The data comes from `python demo/run_demo.py --json` (see sample-run.js): the source text, the
 * metered cost, the interpreter's own step trace and the lint result for each program. All text
 * is inserted with textContent, never innerHTML, so program text can never become markup.
 */

'use strict';

const run = window.ALCOR_RUN;
const state = { program: 0, step: 0 };

const KEYWORDS = new Set([
  'ALCOR',
  'PROGRAM',
  'END',
  'WITH',
  'CALL',
  'INTO',
  'EMIT',
  'BRANCH',
  'ELSE',
  'LABEL',
  'RETURN',
  'LET',
  'JUMP',
  'INPUT',
  'PRINT',
  'FOR',
  'FROM',
  'TO',
  'IF',
  'THEN',
  'WRITE',
  'LOOP',
]);
const OPERATORS = new Set(['EQ', 'LE', 'GE', 'LT', 'GT', 'NE', 'ADD', 'SUB', 'MUL', 'CAT', 'STR']);
const TOKEN = /("(?:[^"\\]|\\.)*")|(\$[A-Za-z_]\w*)|(-?\b\d+\b)|([A-Za-z_]\w*)|(\s+|.)/g;

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
 * Format an integer with thousands separators.
 * @param {number} value - The number.
 * @returns {string} For example 9,999,938.
 */
function grouped(value) {
  return value.toLocaleString('en-US');
}

/**
 * Highlight one line of AlcorLang source.
 * @param {string} text - The line.
 * @returns {HTMLElement} A block element holding one span per token.
 */
function highlightLine(text) {
  const line = el('span', 'line');
  let before = '';
  for (const match of text.matchAll(TOKEN)) {
    const [piece, str, variable, number, word] = match;
    let kind = '';
    if (str) kind = 't-str';
    else if (variable) kind = 't-var';
    else if (number) kind = 't-num';
    else if (word && KEYWORDS.has(word)) kind = 't-kw';
    else if (word && OPERATORS.has(word)) kind = 't-op';
    // A word right after LABEL, JUMP or ELSE names a jump target.
    else if (word && ['LABEL', 'JUMP', 'ELSE'].includes(before)) kind = 't-lbl';
    line.append(kind ? el('span', kind, piece) : document.createTextNode(piece));
    if (piece.trim()) before = piece;
  }
  return line;
}

/**
 * Draw the conformance result in the header bar.
 * @returns {void}
 */
function renderHeader() {
  const checks = run.sections.flatMap((section) => section.checks);
  const held = checks.filter((check) => check.ok).length;
  const box = document.getElementById('conformance');
  const referee = run.conformance.referee.split(': ').pop();
  box.append(el('div', 'ok', `✓ conformance ${referee} passed`));
  const { passed, total } = run.conformance.selftest;
  box.append(el('small', '', `selftest ${passed}/${total} · demo checks ${held}/${checks.length}`));
}

/**
 * Draw one tab per program.
 * @returns {void}
 */
function renderTabs() {
  const box = document.getElementById('tabs');
  box.replaceChildren();
  run.programs.forEach((program, index) => {
    const button = el('button', '', program.file);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(index === state.program));
    button.addEventListener('click', () => selectProgram(index));
    box.append(button);
  });
}

/**
 * Draw the program source with line numbers and highlighting.
 * @returns {void}
 */
function renderSource() {
  const program = run.programs[state.program];
  document.getElementById('source-title').textContent = `${program.file} · ${program.caption}`;
  const box = document.getElementById('source');
  box.replaceChildren();
  program.source.replace(/\n$/, '').split('\n').forEach((text, index) => {
    const line = highlightLine(text);
    line.prepend(el('span', 'num', String(index + 1)));
    box.append(line);
  });
  box.scrollTop = 0;
}

/**
 * Draw the three metrics: steps, fuel headroom and how the run ended.
 * @returns {void}
 */
function renderMetrics() {
  const p = run.programs[state.program];
  const box = document.getElementById('metrics');
  box.replaceChildren();
  const steps = el('div', 'metric');
  steps.append(el('b', 'accent', grouped(p.steps)), el('span', '', 'steps executed'));
  const fuel = el('div', 'metric');
  const used = Math.min(100, (p.steps / p.fuel) * 100);
  const meter = el('div', 'meter');
  const bar = el('i', p.trap ? 'full' : '');
  bar.style.width = `${Math.max(used, 1)}%`;
  meter.append(bar);
  fuel.append(
    el('b', p.trap ? 'refused' : 'ok', `${grouped(p.headroom)} left`),
    el('span', '', `fuel headroom · budget ${grouped(p.fuel)}`),
    meter,
  );
  const outcome = el('div', 'metric');
  outcome.append(
    el('b', p.trap ? 'refused' : 'ok', p.trap ? 'TRAP' : 'halted'),
    el(
      'span',
      '',
      p.trap ? `${p.trap} · stopped by the meter` : `reached END · ${p.profile} profile`,
    ),
  );
  box.append(steps, fuel, outcome);
}

/**
 * Draw the lint result for the selected program.
 * @returns {void}
 */
function renderLint() {
  const { summary, diagnostics } = run.programs[state.program].lint;
  const box = document.getElementById('lint');
  box.replaceChildren();
  const head = summary.total === 0 ? 'ok' : summary.error ? 'refused' : 'waiting';
  const found = `${summary.warning} warning · ${summary.error} error`;
  const text = summary.total === 0 ? '✓ clean' : found;
  box.append(el('p', `diag ${head}`, text));
  for (const d of diagnostics) {
    const item = el('p', 'diag');
    const where = document.createTextNode(` line ${d.line}: ${d.message}`);
    item.append(el('code', 'waiting', d.rule), where);
    box.append(item);
  }
}

/**
 * Draw the program output, dimming the lines the selected step has not printed yet.
 * @returns {void}
 */
function renderTape() {
  const p = run.programs[state.program];
  const tapeLength = p.trace.length ? p.trace[state.step].tape_len : p.output.length;
  const box = document.getElementById('tape');
  box.replaceChildren();
  p.output.slice(0, 7).forEach((text, index) => {
    const shown = text.length > 44 ? `${text.slice(0, 43)}…` : text;
    box.append(el('div', index < tapeLength ? 'now' : 'later', shown));
  });
  if (p.output.length > 7) box.append(el('div', 'later', `… ${p.output.length - 7} more lines`));
}

/**
 * Draw the trace table and the cells after the selected step.
 * @returns {void}
 */
function renderTrace() {
  const p = run.programs[state.program];
  const body = document.getElementById('trace');
  body.replaceChildren();
  p.trace.forEach((step, index) => {
    const tr = el('tr', index === state.step ? 'selected' : '');
    tr.append(
      el('td', 'dim', String(step.n)),
      el('td', '', step.op),
      el('td', 'ins', step.ins.join(' ')),
      el('td', 'dim', step.block),
    );
    tr.addEventListener('click', () => selectStep(index));
    body.append(tr);
  });
  const step = p.trace[state.step];
  const cells = Object.entries(step.cells).map(([name, value]) => `${name}=${value}`);
  document.getElementById('cells').textContent =
    `after step ${step.n} in ${step.block}: ${cells.length ? cells.join('  ') : 'no cells yet'}` +
    (p.steps > p.trace_shown ? `  (first ${p.trace_shown} of ${grouped(p.steps)} shown)` : '');
}

/**
 * Draw the demo sections as chips with their passed-check counts.
 * @returns {void}
 */
function renderSections() {
  const box = document.getElementById('sections');
  for (const section of run.sections) {
    const passed = section.checks.filter((check) => check.ok).length;
    const chip = el('span', 'chip', section.title.replace(/\s*\(.*\)/, '').split(':')[0]);
    const total = section.checks.length;
    chip.append(el('b', passed === total ? '' : 'refused', `${passed}/${total}`));
    box.append(chip);
  }
}

/**
 * Select a step in the current trace and redraw what depends on it.
 * @param {number} index - Index into the trace.
 * @returns {void}
 */
function selectStep(index) {
  state.step = index;
  renderTape();
  renderTrace();
  const node = document.querySelector('tr.selected');
  if (node) node.scrollIntoView({ block: 'nearest' });
}

/**
 * Switch program and open its trace at the last recorded step.
 * @param {number} index - Index into run.programs.
 * @returns {void}
 */
function selectProgram(index) {
  state.program = index;
  state.step = run.programs[index].trace.length - 1;
  renderTabs();
  renderSource();
  renderMetrics();
  renderLint();
  selectStep(state.step);
}

/**
 * Step through the trace with the arrow keys.
 * @param {KeyboardEvent} event - The key event.
 * @returns {void}
 */
function onKey(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const last = run.programs[state.program].trace.length - 1;
  selectStep(Math.max(0, Math.min(last, state.step + (event.key === 'ArrowDown' ? 1 : -1))));
  event.preventDefault();
}

renderHeader();
renderSections();
selectProgram(0);
document.addEventListener('keydown', onKey);
