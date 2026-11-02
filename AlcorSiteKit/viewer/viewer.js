/**
 * AlcorSiteKit viewer: draws the release pipeline, the one-time-code gate, the audit log and the
 * output of any selected command, from window.ALCOR_RUN (sample-run.js, the real output of
 * demo/run_demo.py).
 *
 * Nothing here is invented. Each cell is one real `sitekit` command; its label is read from that
 * command's exit code and output, and clicking it shows the output itself. Text is always set
 * with textContent, never innerHTML.
 */

'use strict';

const RUN = window.ALCOR_RUN;
const STAGES = [
  { key: 'land', name: 'Land', note: 'served-files gate' },
  { key: 'contract', name: 'Contract', note: 'structure + links' },
  { key: 'coldread', name: 'Cold read', note: 'advisory' },
  { key: 'review', name: 'Review', note: 'advisory' },
  { key: 'promote', name: 'Promote', note: 'one-time code' },
];

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
 * Name the pipeline stage a command belongs to, or null if it is not a pipeline command.
 * @param {object} command - One recorded command.
 * @returns {string|null} A key of STAGES, with rollback counted as a promotion-stage action.
 */
function stageOf(command) {
  const verb = command.command.split(' ')[1];
  if (verb === 'rollback') return 'promote';
  return STAGES.some((stage) => stage.key === verb) ? verb : null;
}

/**
 * Turn a command's exit code and output into a short label and a tone.
 * @param {object} command - One recorded command.
 * @returns {{label: string, tone: string}} Tone is "ok", "refuse" or "warn".
 */
function outcome(command) {
  const text = command.output.join('\n');
  const verb = command.command.split(' ')[1];
  const find = (pattern) => pattern.exec(text);
  if (verb === 'land') {
    const pushed = find(/PUSHED release=(\w+) files=(\d+)/);
    if (pushed) return { label: `landed, ${pushed[2]} files`, tone: 'ok' };
    return { label: 'nothing to land', tone: 'warn' };
  }
  if (verb === 'contract') {
    const verdict = find(/contract (GREEN|RED)\S*\s+(\d+) pass, (\d+) fail/);
    if (verdict) {
      return {
        label: `${verdict[1]}: ${verdict[2]} pass, ${verdict[3]} fail`,
        tone: verdict[1] === 'GREEN' ? 'ok' : 'refuse',
      };
    }
  }
  if (verb === 'coldread') {
    const flagged = find(/(\d+) page\(s\) flagged/);
    return { label: `${flagged ? flagged[1] : '?'} pages flagged`, tone: 'warn' };
  }
  if (verb === 'review') {
    const findings = find(/review: (\d+) finding/);
    return { label: `${findings ? findings[1] : '?'} findings`, tone: 'warn' };
  }
  if (verb === 'rollback') {
    return command.exit === 0
      ? { label: 'rolled back, no code', tone: 'ok' }
      : { label: 'refused: log broken', tone: 'refuse' };
  }
  if (verb === 'promote') {
    const promoted = find(/PROMOTED (\w+)/);
    if (promoted) return { label: `PROMOTED ${promoted[1]}`, tone: 'ok' };
    const refused = find(/refused \[([\w-]+)\]/);
    if (refused) return { label: `refused: ${refused[1]}`, tone: 'refuse' };
    if (/the controller refused/.test(text))
      return { label: 'refused: code spent', tone: 'refuse' };
    return {
      label: command.command.includes('--go') ? 'refused' : 'dry run: not ready',
      tone: 'warn',
    };
  }
  return {
    label: command.exit === 0 ? 'ok' : `exit ${command.exit}`,
    tone: command.exit ? 'refuse' : 'ok',
  };
}

/**
 * Collect every recorded command in order, each tagged with the step it ran in.
 * @returns {object[]} Commands with a `step` property.
 */
function allCommands() {
  return RUN.steps.flatMap((step) => step.commands.map((command) => ({ ...command, step })));
}

/**
 * Group pipeline commands by release: a successful `land` starts a new release.
 * @param {object[]} commands - All commands, in order.
 * @returns {{id: string, cells: Object<string, object[]>}[]} One entry per release.
 */
function releases(commands) {
  const groups = [];
  commands.forEach((command) => {
    if (command.step.title.toLowerCase().includes('audit')) return;
    const pushed = /PUSHED release=(\w+)/.exec(command.output.join('\n'));
    if (pushed) groups.push({ id: pushed[1], cells: {} });
    const stage = stageOf(command);
    if (!stage || groups.length === 0) return;
    const cells = groups[groups.length - 1].cells;
    (cells[stage] = cells[stage] || []).push(command);
  });
  return groups;
}

/**
 * Show one command and its real output in the detail panel.
 * @param {object} command - The command to show.
 */
function select(command) {
  document.querySelectorAll('.result').forEach((button) => {
    button.classList.toggle('on', button.commandRef === command);
  });
  const panel = document.getElementById('detail');
  panel.textContent = '';
  add(panel, el('h3', '', `Real output: ${command.step.title}`));
  const terminal = el('pre', 'terminal');
  terminal.appendChild(el('span', 'cmd', `$ ${command.command}   (exit ${command.exit})\n`));
  command.output.forEach((line) => {
    let tone = '';
    if (/FAIL|refused|error|BROKEN|RED\b/.test(line)) tone = 'refuse';
    else if (/^(TODO|HOLD)/.test(line)) tone = 'warn';
    else if (/^ok\b|GREEN|PASS|PROMOTED|ROLLED BACK|pointer moved/.test(line)) tone = 'ok';
    terminal.appendChild(el('span', tone, `${line}\n`));
  });
  panel.appendChild(terminal);
  panel.appendChild(el('p', 'note', `Proved here: ${command.step.claims.join('; ') || 'n/a'}.`));
}

/**
 * Draw the release-by-stage grid.
 * @param {{id: string, cells: Object<string, object[]>}[]} groups - Releases in order.
 */
function renderPipeline(groups) {
  const pipe = document.getElementById('pipe');
  pipe.appendChild(el('div'));
  STAGES.forEach((stage) => {
    add(pipe, add(el('div', 'stage', `${stage.name} ›`), el('small', '', stage.note)));
  });
  groups.forEach((group, index) => {
    const promotions = (group.cells.promote || []).filter((c) =>
      /PROMOTED/.test(c.output.join('')),
    );
    const label = add(el('div', 'release', `Release ${index + 1}`), el('code', '', group.id));
    label.appendChild(
      el(
        'span',
        promotions.length ? 'verdict ok' : 'verdict refuse',
        promotions.length ? `promoted ×${promotions.length}` : 'never promoted',
      ),
    );
    const first = add(el('div', 'cell'), label);
    first.style.borderTop = '1px solid var(--border)';
    pipe.appendChild(first);
    STAGES.forEach((stage) => {
      const cell = el('div', 'cell');
      const commands = group.cells[stage.key] || [];
      if (!commands.length) cell.appendChild(el('span', 'empty', '—'));
      commands.forEach((command) => {
        const result = outcome(command);
        const button = el('button', `result ${result.tone}`, result.label);
        button.title = command.command;
        button.commandRef = command;
        button.addEventListener('click', () => select(command));
        cell.appendChild(button);
      });
      pipe.appendChild(cell);
    });
  });
}

/**
 * Draw the one-time-code gate: how many codes were minted, spent and refused, and every attempt.
 * @param {object[]} commands - All commands, in order.
 * @param {{id: string, cells: Object<string, object[]>}[]} groups - Releases in order.
 */
function renderGate(commands, groups) {
  const panel = document.getElementById('gate');
  const approve = commands.find((c) => c.command.startsWith('sitekit approve'));
  const minted = Number(/--count (\d+)/.exec(approve.command)[1]);
  const attempts = [];
  groups.forEach((group) =>
    (group.cells.promote || [])
      .filter((c) => c.command.includes('promote --go'))
      .forEach((command) => attempts.push({ release: groups.indexOf(group) + 1, command })),
  );
  const spent = attempts.filter((a) => /PROMOTED/.test(a.command.output.join(''))).length;
  add(panel, el('h3', '', 'One-time-code gate'));
  const stats = el('div', 'stats');
  [
    [minted, 'minted', ''],
    [spent, 'spent', 'ok'],
    [minted - spent, 'unspent', ''],
    [attempts.length - spent, 'refused', 'refuse'],
  ].forEach(([value, name, tone]) => {
    add(stats, add(el('div', `stat ${tone}`), el('b', '', String(value)), el('span', '', name)));
  });
  panel.appendChild(stats);
  const list = el('div', 'attempts');
  attempts.forEach((attempt, index) => {
    const result = outcome(attempt.command);
    const line = el('div', 'line');
    add(
      line,
      el('span', 'n', String(index + 1)),
      el('span', 'dot ' + result.tone),
      el('span', 'what', `R${attempt.release} ${result.label.replace(/^refused: /, '')}`),
    );
    list.appendChild(line);
  });
  panel.appendChild(list);
  const stored = RUN.claims.find((claim) => claim.startsWith('only hashes are stored'));
  if (stored) panel.appendChild(el('p', 'note', `Proved: ${stored}.`));
}

/**
 * Draw the audit log: the pointer-log checks from the tamper step, and the controller's decisions.
 * @param {object[]} commands - All commands, in order.
 */
function renderAudit(commands) {
  const panel = document.getElementById('audit');
  add(panel, el('h3', '', 'Pointer log under tamper'));
  commands
    .filter((c) => c.step.title.toLowerCase().includes('audit'))
    .forEach((command) => {
      const line = command.output.find((text) => /^(pointer|error)/.test(text));
      if (!line) return;
      const broken = /BROKEN|error/.test(line);
      const row = el('div', 'line');
      add(
        row,
        el('span', `dot ${broken ? 'refuse' : 'ok'}`),
        el('span', 'what', line.replace(/\s+/g, ' ')),
      );
      row.title = command.command;
      panel.appendChild(row);
    });
  add(panel, el('h3', '', 'Controller decisions'));
  panel.lastChild.style.marginTop = '16px';
  RUN.controller_decisions.forEach((text) => {
    const refused = text.includes('needs-approval');
    const row = el('div', 'line');
    add(row, el('span', `dot ${refused ? 'refuse' : 'ok'}`), el('span', 'what', text));
    row.title = text;
    panel.appendChild(row);
  });
}

/** Draw the header badges, every panel, and select the reused-code refusal by default. */
function init() {
  const commands = allCommands();
  const groups = releases(commands);
  add(
    document.getElementById('badges'),
    el('span', 'badge ok', `${RUN.claims.length} claims proved`),
    el('span', 'badge', `${groups.length} releases`),
    el('span', 'badge', 'offline, loopback only'),
  );
  renderPipeline(groups);
  renderGate(commands, groups);
  renderAudit(commands);
  const wanted = commands.find((c) => outcome(c).label === 'refused: code spent');
  select(wanted || commands[0]);
}

init();
