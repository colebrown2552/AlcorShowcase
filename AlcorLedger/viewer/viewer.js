/**
 * AlcorLedger viewer: draws the hash chain, the privacy gate, the verify result and the tamper
 * cases from window.ALCOR_RUN (sample-run.js, the real output of demo/run_demo.py).
 *
 * Nothing here is invented: every hash, statement, error and exit code is read from that object.
 * The one thing computed in the browser is the link check (does each block's previous hash equal
 * the hash of the block before it), and it is labelled as such. Text is always set with
 * textContent, never innerHTML, so run data cannot inject markup.
 */

'use strict';

const RUN = window.ALCOR_RUN;
const SHORT = 12;

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
 * Shorten a hex digest for display.
 * @param {string} digest - Full SHA-256 hex digest.
 * @returns {string} The first 12 characters.
 */
function short(digest) {
  return digest.slice(0, SHORT);
}

/**
 * Describe what the privacy gate replaced in an entry, from the markers it left behind.
 * @param {object} entry - A stored ledger entry.
 * @returns {string[]} Short labels such as "EMAIL" or "API_KEY"; empty if nothing was redacted.
 */
function redactions(entry) {
  const text = entry.statement + JSON.stringify(entry.metadata || {});
  const found = [];
  for (const match of text.matchAll(/<REDACTED:([A-Z-]+)(?::([A-Z_]+))?>/g)) {
    found.push(match[2] || match[1]);
  }
  return found;
}

/**
 * Parse verify errors such as "line 2: entry_hash mismatch" into a map from line to reason.
 * @param {string[]} errors - Error strings from `continuity verify`.
 * @returns {Object<number, string>} Reason by 1-based line number.
 */
function errorsByLine(errors) {
  const byLine = {};
  for (const error of errors) {
    const match = /^line (\d+): (.*)$/.exec(error);
    if (match) byLine[Number(match[1])] = match[2];
  }
  return byLine;
}

/**
 * Build the chain as it looked in one scenario of the demo.
 * @param {string} key - "clean", "edit", "forge" or "truncate".
 * @returns {{entries: object[], verify: object, ghost: object|null, headline: string}} The blocks
 *   to draw, the demo's verify report for them, a deleted block if any, and a one-line summary.
 */
function scenario(key) {
  const entries = RUN.chain.map((entry) => ({ ...entry }));
  if (key === 'edit') {
    entries[1].statement = entries[1].statement.replace(RUN.tamper.before, RUN.tamper.after);
    entries[1].edited = true;
    return { entries, verify: RUN.tamper.verify, ghost: null, headline: 'Line 2 edited on disk' };
  }
  if (key === 'forge') {
    entries[1].statement = entries[1].statement.replace(RUN.tamper.before, RUN.tamper.after);
    entries[1].entry_hash = RUN.forgery.forged_hash;
    entries[1].edited = true;
    return {
      entries,
      verify: RUN.forgery.verify,
      ghost: null,
      headline: 'Line 2 edited and its own hash recomputed',
    };
  }
  if (key === 'truncate') {
    const ghost = entries.pop();
    return {
      entries,
      verify: RUN.truncation.verify,
      ghost,
      headline: 'Newest entry deleted from the end',
    };
  }
  return { entries, verify: RUN.verify_clean, ghost: null, headline: 'Untouched ledger' };
}

/**
 * Check in the browser that each block's previous hash equals the hash of the block before it.
 * This is the cheap half of verification; recomputing each hash is the CLI's job.
 * @param {object[]} entries - Blocks in order.
 * @returns {boolean[]} For each block after the first, whether its link to the one before holds.
 */
function checkLinks(entries) {
  return entries.slice(1).map((entry, i) => entry.previous_hash === entries[i].entry_hash);
}

/**
 * Draw one block of the chain.
 * @param {object} entry - The entry to draw.
 * @param {number} index - 1-based position (the ledger line number).
 * @param {object} state - Per-block verdicts: {reason: string|undefined, linkBroken: boolean}.
 * @returns {HTMLElement} The block element.
 */
function block(entry, index, state) {
  const labels = redactions(entry);
  const cls = state.reason ? 'block bad' : labels.length ? 'block redacted' : 'block';
  const node = el('div', cls);
  add(
    node,
    add(el('div', 'block-top'), el('span', '', `#${index}`), el('span', 'kind', entry.kind)),
  );
  add(node, el('div', 'block-id', entry.id));
  node.appendChild(el('div', 'statement', entry.statement));
  if (entry.edited) node.appendChild(el('span', 'chip', 'edited on disk'));
  labels.forEach((label) => node.appendChild(el('span', 'chip', `redacted: ${label}`)));
  if (state.reason) node.appendChild(el('span', 'chip refuse', state.reason));
  const hashes = el('div', 'hashes');
  const isGenesis = entry.previous_hash === RUN.zero_hash;
  add(
    hashes,
    el(
      'div',
      state.linkBroken ? 'bad' : '',
      `prev ${isGenesis ? 'genesis' : short(entry.previous_hash)}`,
    ),
    add(el('div'), document.createTextNode('hash '), el('b', '', short(entry.entry_hash))),
  );
  node.appendChild(hashes);
  return node;
}

/**
 * Draw the chain panel for one scenario and the verify panel beside it.
 * @param {string} key - Scenario key.
 */
function render(key) {
  const view = scenario(key);
  const byLine = errorsByLine(view.verify.errors);
  const links = checkLinks(view.entries);
  document.querySelector('#chain-panel h2').textContent = `Hash chain: ${view.headline}`;
  const chain = document.getElementById('chain');
  chain.textContent = '';
  view.entries.forEach((entry, i) => {
    if (i > 0) {
      const broken = !links[i - 1] || byLine[i + 1] === 'previous_hash mismatch';
      chain.appendChild(el('div', broken ? 'link bad' : 'link', broken ? '✖' : '→'));
    }
    chain.appendChild(
      block(entry, i + 1, {
        reason: byLine[i + 1],
        linkBroken: !!byLine[i + 1] && byLine[i + 1].startsWith('previous_hash'),
      }),
    );
  });
  if (view.ghost) {
    chain.appendChild(el('div', 'link bad', '✖'));
    const ghost = el('div', 'block ghost');
    add(ghost, el('div', 'block-id', view.ghost.id), el('div', 'statement', 'deleted'));
    add(ghost, el('span', 'chip refuse', 'verify cannot see this'));
    add(ghost, el('div', 'hashes', `hash ${short(view.ghost.entry_hash)}`));
    chain.appendChild(ghost);
  }
  document.querySelectorAll('#scenarios button').forEach((button) => {
    button.classList.toggle('on', button.dataset.key === key);
  });
  renderVerify(view, links);
}

/**
 * Fill the verify panel: the CLI's report from the demo plus the browser's link check.
 * @param {object} view - The scenario being shown.
 * @param {boolean[]} links - Result of checkLinks for it.
 */
function renderVerify(view, links) {
  const panel = document.getElementById('verify-panel');
  panel.textContent = '';
  const ok = view.verify.ok;
  add(panel, el('h3', '', 'Verify chain'));
  add(panel, el('p', ok ? 'verdict ok' : 'verdict bad', ok ? 'VERIFIED' : 'CHAIN BROKEN'));
  add(
    panel,
    el('div', 'kv', `continuity verify → exit ${view.verify.exit}, ${view.verify.entries} entries`),
  );
  view.verify.errors.forEach((error) => panel.appendChild(el('div', 'kv bad', error)));
  const intact = links.filter(Boolean).length;
  panel.appendChild(el('div', 'kv', `browser link check: ${intact}/${links.length} links intact`));
  const exits = RUN.cli.map((row) => row.exit).join(', ');
  panel.appendChild(
    el('p', 'note', `Other CLI verbs run: ${RUN.cli.length} (exit codes ${exits})`),
  );
}

/** Draw the "refused" and "redacted" panels from the privacy-gate part of the run. */
function renderGate() {
  const refused = document.getElementById('refused-panel');
  const finding = RUN.refusal.findings[0];
  add(refused, el('h3', '', 'Privacy gate: refused'));
  add(refused, el('p', 'verdict bad', `${RUN.refusal.entry_id} NOT WRITTEN`));
  add(
    refused,
    el('div', 'kv', RUN.refusal.message),
    el('div', 'kv', `label=${finding.label} at ${finding.location}`),
    el('div', 'kv', `length=${finding.length} fingerprint=${finding.fingerprint}`),
  );
  add(refused, el('p', 'note', 'The finding describes the value; it never contains it.'));

  const redacted = document.getElementById('redacted-panel');
  add(redacted, el('h3', '', 'Redacted on request, never on disk'));
  RUN.chain
    .filter((entry) => redactions(entry).length)
    .forEach((entry) => {
      const text = entry.id === 'obs-3' ? JSON.stringify(entry.metadata) : entry.statement;
      add(
        redacted,
        add(el('div', 'kv'), el('b', '', `${entry.id} `), document.createTextNode(text)),
      );
    });
  add(
    redacted,
    el('p', 'note', 'Harmless metadata (region) is kept; only the sensitive part is replaced.'),
  );
}

/** Draw the four tamper cards, each with a button that shows its case on the chain. */
function renderCards() {
  const cards = document.getElementById('cards');
  const recon = RUN.reconstruction.receipt;
  const specs = [
    {
      key: 'edit',
      title: 'Edit one line',
      result: [`${RUN.tamper.verify.errors[0]}`, 'bad'],
      lines: [
        `"${RUN.tamper.before}" → "${RUN.tamper.after}"`,
        `verify exit ${RUN.tamper.verify.exit}`,
        RUN.append_after_tamper.replace('refusing to append to invalid ledger', 'append refused'),
      ],
    },
    {
      key: 'forge',
      title: 'Forge its hash too',
      result: [RUN.forgery.verify.errors[0], 'bad'],
      lines: [
        `forged hash ${short(RUN.forgery.forged_hash)}`,
        'line 2 is self-consistent,',
        'line 3 still points at the old hash',
      ],
    },
    {
      key: 'truncate',
      title: 'Delete the newest',
      result: [`verify exit ${RUN.truncation.verify.exit} (blind spot)`, 'warn'],
      lines: [
        `pinned head ${short(RUN.truncation.pinned_head)}`,
        `current head ${short(RUN.truncation.head_after)}`,
        'a head kept elsewhere catches it',
      ],
    },
    {
      key: null,
      title: 'Rebuild from the chain',
      result: [`${recon.pass_count} passes agree`, 'ok'],
      lines: [
        `state digest ${short(recon.state_digest)}`,
        `refused: ${RUN.reconstruction_cache_failure}`,
        `refused: ${RUN.reconstruction_chain_failure}`,
      ],
    },
  ];
  specs.forEach((spec) => {
    const card = el('div', 'card');
    add(card, el('h3', '', spec.title), el('div', `result ${spec.result[1]}`, spec.result[0]));
    spec.lines.forEach((line) => card.appendChild(el('div', 'kv', line)));
    if (spec.key) {
      const button = el('button', '', 'show on chain');
      button.addEventListener('click', () => render(spec.key));
      card.appendChild(button);
    }
    cards.appendChild(card);
  });
}

/** Draw the header badges and the scenario switch, then the default view. */
function init() {
  const badges = document.getElementById('badges');
  badges.appendChild(el('span', 'badge ok', `${RUN.claims.length} claims proven`));
  badges.appendChild(el('span', 'badge', `${RUN.chain.length} entries`));
  const switcher = document.getElementById('scenarios');
  [
    ['clean', 'Untouched'],
    ['edit', 'Edit line 2'],
    ['forge', 'Forge line 2'],
    ['truncate', 'Delete newest'],
  ].forEach(([key, label]) => {
    const button = el('button', '', label);
    button.dataset.key = key;
    button.addEventListener('click', () => render(key));
    switcher.appendChild(button);
  });
  renderGate();
  renderCards();
  const wanted = window.location.hash.slice(1);
  render(['edit', 'forge', 'truncate'].includes(wanted) ? wanted : 'clean');
}

init();
