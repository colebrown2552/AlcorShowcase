/**
 * AlcorComputer viewer: draws the observed screen, each proposed action with the authority's
 * verdict, the mediator's staging cases and the receipt, from window.ALCOR_RUN (sample-run.js,
 * the real output of demo/run_demo.py).
 *
 * Nothing here is invented. The screen shows only what the observation reports: the window's
 * title and bounds, and the points the demo clicked. The demo's fake app exposes no other
 * elements, so none are drawn. Text is always set with textContent, never innerHTML.
 */

'use strict';

const RUN = window.ALCOR_RUN;
const SCALE = 0.44;
const WORLD = { width: 960, height: 740 };
const MARGIN = 20;
const VERDICT_TEXT = {
  allowed: 'ALLOWED',
  refused: 'REFUSED',
  stale: 'STALE',
  replay: 'REPLAY BLOCKED',
};

/**
 * Create an element with an optional class and text.
 * @param {string} tag - Element name.
 * @param {string} [cls] - Class names.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Append children to a parent and return the parent.
 * @param {HTMLElement} parent - Where to append.
 * @param {...HTMLElement} children - What to append.
 * @returns {HTMLElement} The parent.
 */
function add(parent, ...children) {
  children.forEach((child) => parent.appendChild(child));
  return parent;
}

/**
 * Classify a reason code into one of four verdicts.
 * @param {boolean} ok - Whether the action went through.
 * @param {string} reason - The reason code in the receipt.
 * @returns {string} "allowed", "refused", "stale" or "replay".
 */
function verdictOf(ok, reason) {
  if (ok) return 'allowed';
  if (reason.includes('stale')) return 'stale';
  if (reason === 'replay' || reason === 'fresh_observation_required') return 'replay';
  return 'refused';
}

/**
 * Describe a session step in a few words.
 * @param {object} step - One entry of session.steps.
 * @returns {string} For example "click (640, 420)" or "type 45 chars".
 */
function describe(step) {
  const action = step.action;
  if (!action) return step.verb;
  if (action.kind === 'click') return `click (${action.x}, ${action.y})`;
  if (action.kind === 'type')
    return `type ${action.text_length} char${action.text_length > 1 ? 's' : ''}`;
  return `${action.kind} ${action.key}`;
}

/**
 * Make a verdict chip.
 * @param {string} verdict - Verdict key.
 * @returns {HTMLElement} The chip.
 */
function chip(verdict) {
  return el('span', `chip ${verdict}`, VERDICT_TEXT[verdict]);
}

/**
 * Draw the observed window and a pin for every distinct point the demo clicked.
 * @param {number} selected - Index of the selected step.
 */
function renderScreen(selected) {
  const screen = document.getElementById('screen');
  screen.textContent = '';
  screen.style.width = `${WORLD.width * SCALE}px`;
  screen.style.height = `${WORLD.height * SCALE}px`;
  const target = RUN.session.observation.target;
  const bounds = target.window_bounds;
  const at = (x, y) => [(MARGIN + x) * SCALE, (MARGIN + y) * SCALE];
  const [left, top] = at(bounds.x, bounds.y);
  const frame = el('div', 'window');
  Object.assign(frame.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${bounds.width * SCALE}px`,
    height: `${bounds.height * SCALE}px`,
  });
  add(
    frame,
    el('div', 'titlebar', `${target.window_title} · ${target.process}`),
    el('div', 'dim', `${bounds.width} × ${bounds.height}`),
  );
  screen.appendChild(frame);

  const projection = RUN.mediator.projection;
  const [tx, ty] = at(projection.x, projection.y);
  const ring = el('div', 'target');
  Object.assign(ring.style, {
    left: `${tx - 22}px`,
    top: `${ty - 22}px`,
    width: '44px',
    height: '44px',
  });
  const ringLabel = el('div', 'target-label', projection.target_ref);
  Object.assign(ringLabel.style, { left: `${tx - 100}px`, top: `${ty + 26}px` });
  add(screen, ring, ringLabel);

  const groups = new Map();
  RUN.session.steps.forEach((step, index) => {
    if (!step.action || step.action.kind !== 'click') return;
    const key = `${step.action.x},${step.action.y}`;
    if (!groups.has(key)) groups.set(key, { x: step.action.x, y: step.action.y, steps: [] });
    groups.get(key).steps.push(index);
  });
  groups.forEach((group) => {
    const [px, py] = at(group.x, group.y);
    const inGroup = group.steps.includes(selected);
    const step = RUN.session.steps[inGroup ? selected : group.steps[0]];
    const pin = el(
      'div',
      inGroup ? `pin ${verdictOf(step.ok, step.reason)}` : 'pin',
      `${group.steps.length}`,
    );
    Object.assign(pin.style, { left: `${px}px`, top: `${py}px` });
    const label = el('div', 'pin-label', `(${group.x}, ${group.y})`);
    Object.assign(label.style, { left: `${px - 28}px`, top: `${py - 38}px` });
    add(screen, pin, label);
  });
  document.getElementById('screen-meta').textContent = `fresh, one-use observation`;
  const legend = document.getElementById('legend');
  legend.textContent = '';
  [
    `The lane read: "${RUN.mediator.observation.text}".`,
    'Pin: clicks aimed at that point. Its colour is the selected action’s verdict.',
    'Dashed ring: the target the observation resolved.',
    'Hatched area: outside the window.',
  ].forEach((line) => legend.appendChild(el('li', '', line)));
}

/** Draw the mediator's staging cases, each with the reason code the authority gave. */
function renderMediator() {
  const host = document.getElementById('mediator');
  const rows = el('div', 'rows');
  const cases = [
    ...RUN.mediator.cases,
    {
      label: RUN.mediator.authority_refusal.label,
      ok: false,
      reason: RUN.mediator.authority_refusal.reason,
    },
  ];
  cases.forEach((item, index) => {
    const verdict = verdictOf(item.ok, item.reason);
    const row = el('div', 'row');
    add(row, el('span', 'n', `${index + 1}`), el('span', 'what', item.label));
    const code = el('span', `chip ${verdict}`, item.reason);
    code.style.minWidth = '210px';
    row.appendChild(code);
    rows.appendChild(row);
  });
  host.appendChild(rows);
}

/**
 * Draw the list of session actions; clicking a row selects it.
 * @param {number} selected - Index of the selected step.
 */
function renderActions(selected) {
  const host = document.getElementById('actions');
  host.textContent = '';
  const rows = el('div', 'rows');
  RUN.session.steps.forEach((step, index) => {
    const row = el('div', index === selected ? 'row pick on' : 'row pick');
    const code = el('span', 'code', step.reason);
    code.style.width = '230px';
    add(
      row,
      el('span', 'n', `${index + 1}`),
      el('span', 'what', describe(step)),
      chip(verdictOf(step.ok, step.reason)),
      code,
    );
    row.addEventListener('click', () => select(index));
    rows.appendChild(row);
  });
  host.appendChild(rows);
  const grant = RUN.session.grant;
  document.getElementById('grant').textContent =
    `grant: ${grant.allowed_actions.join('/')}, ${grant.max_events} events, ` +
    `${grant.max_observation_age_ms / 1000} s max view age`;
}

/**
 * Draw the observation, action and verdict cards for one step.
 * @param {object} step - The selected step.
 */
function renderFlow(step) {
  const flow = document.getElementById('flow');
  flow.textContent = '';
  const verdict = verdictOf(step.ok, step.reason);
  const target = RUN.session.observation.target;
  const observe = el('div', 'step');
  add(
    observe,
    el('h3', '', 'Observe'),
    el('div', 'big', target.window_title),
    el(
      'div',
      'small',
      `${target.bundle_id}, ${target.window_bounds.width}x${target.window_bounds.height}`,
    ),
  );
  const propose = el('div', 'step');
  add(
    propose,
    el('h3', '', 'Propose'),
    el('div', 'big', describe(step)),
    el('div', 'small', step.intent),
  );
  const verdictCard = el('div', `step ${verdict}`);
  add(
    verdictCard,
    el('h3', '', 'Authority verdict'),
    add(el('div', 'big'), chip(verdict)),
    // A zero-width space after each underscore lets a long code wrap between words.
    el('div', 'small', step.reason.replaceAll('_', '_\u200b')),
  );
  add(flow, observe, el('div', 'arrow', '→'), propose, el('div', 'arrow', '→'), verdictCard);
}

/**
 * Show the receipt for one step: the durable record if the demo wrote one, else the refusal the
 * controller returned (refusals before an effect leave nothing on disk).
 * @param {object} step - The selected step.
 */
function renderReceipt(step) {
  const wanted = JSON.stringify(step.action);
  const stored = RUN.session.receipts_on_disk.find(
    (row) =>
      row.phase !== 'pending' &&
      row.reason_code === step.reason &&
      JSON.stringify(row.action) === wanted &&
      row.events_used === step.events_used,
  );
  const fields = stored
    ? {
        phase: stored.phase,
        ok: stored.ok,
        reason_code: stored.reason_code,
        action: stored.action,
        events_used: stored.events_used,
        host_input_fired: stored.host_input_fired,
        typed_text_redacted: stored.typed_text_redacted,
        utc: stored.utc,
      }
    : {
        phase: step.phase,
        ok: step.ok,
        reason_code: step.reason,
        action: step.action,
        events_used: step.events_used,
        host_input_fired: step.input_fired,
      };
  const pre = document.getElementById('receipt');
  pre.textContent = '';
  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined) return;
    pre.appendChild(el('span', 'k', `${key}: `));
    pre.appendChild(document.createTextNode(`${JSON.stringify(value)}\n`));
  });
  const pending = RUN.session.receipts_on_disk.filter((row) => row.phase === 'pending').length;
  document.getElementById('receipt-meta').textContent = stored
    ? `on disk: ${pending} pending + terminal pairs; typed text is a hash, never text`
    : 'returned, not written: nothing reached the host';
}

/**
 * Select one step and redraw everything that depends on it.
 * @param {number} index - Index into session.steps.
 */
function select(index) {
  const step = RUN.session.steps[index];
  renderScreen(index);
  renderActions(index);
  renderFlow(step);
  renderReceipt(step);
}

/** Draw the header badges, the static panels and the default selection. */
function init() {
  const badges = document.getElementById('badges');
  const passed = RUN.checks.filter((check) => check.ok).length;
  add(
    badges,
    el('span', 'badge ok', `${passed}/${RUN.checks.length} checks passed`),
    el('span', 'badge', 'no OS input API touched'),
  );
  renderMediator();
  const wanted = Number(window.location.hash.slice(1));
  select(wanted >= 1 && wanted <= RUN.session.steps.length ? wanted - 1 : 1);
}

init();
