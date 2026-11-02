/*
 * AlcorFinance page behavior: tabs, inputs, results, link state, CSV, print.
 *
 * Holding names, typed numbers and anything read from the link reach the page
 * only through textContent and input values, never through HTML parsing. The
 * renderers take a document argument so tests can run them without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./alcor-finance-core.js'));
  else root.AlcorFinanceUI = factory(root.AlcorFinanceCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const TITLES = Object.freeze({
    opportunity: 'Opportunity cost',
    loan: 'Loan payment and schedule',
    breakeven: 'Break-even',
  });
  const FILES = Object.freeze({
    opportunity: 'alcorfinance-opportunity-cost.csv',
    loan: 'alcorfinance-loan-schedule.csv',
    breakeven: 'alcorfinance-break-even.csv',
  });
  const NEW_ROW = Object.freeze({ label: '', amount: '10000', rate: '5', years: '10' });

  function el(doc, tag, props, children) {
    const node = doc.createElement(tag);
    Object.keys(props || {}).forEach((key) => {
      const value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'className') node.className = value;
      else if (key === 'value') node.value = String(value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    (children || []).forEach((child) => {
      if (child) node.appendChild(child);
    });
    return node;
  }

  const money = core.formatMoney;
  const rate = (value) => Number(value.toFixed(4)) + '%';
  const years = (value) => Number(value.toFixed(4)) + (value === 1 ? ' year' : ' years');
  const tone = (value) => (value > 0.005 ? 'good' : value < -0.005 ? 'bad' : '');

  // View models are plain strings, so they can be checked without a DOM.
  function opportunityView(result) {
    const totals = result.totals;
    const difference = totals.difference;
    let label = 'Your holdings match the baseline';
    if (difference > 0.005) label = 'The baseline comes out ahead by';
    if (difference < -0.005) label = 'Your holdings come out ahead by';
    return {
      hero: { label, value: money(Math.abs(difference)), tone: tone(-difference) },
      stats: [
        ['Put in', money(totals.invested)],
        ['Holdings grow to', money(totals.assetValue)],
        ['Baseline grows to', money(totals.baselineValue)],
        ['Average rate', core.formatPercent(totals.weightedRate)],
      ],
      note: '',
      table: {
        caption: 'By holding, against a ' + rate(result.baseline) + ' baseline',
        cards: true,
        columns: [
          ['Holding', false],
          ['Grows to', true],
          ['At baseline', true],
          ['Difference', true],
          ['Gap', true],
        ],
        rows: result.rows.map((row) => ({
          cells: [
            {
              text: row.label,
              sub: money(row.amount) + ' at ' + rate(row.rate) + ' for ' + years(row.years),
            },
            { text: money(row.assetValue) },
            { text: money(row.baselineValue) },
            { text: money(row.opportunityCost), tone: tone(-row.opportunityCost) },
            { text: core.formatPercent(row.gapPercent), tone: tone(-row.opportunityCost) },
          ],
        })),
        foot: [
          'Total',
          money(totals.assetValue),
          money(totals.baselineValue),
          money(difference),
          '',
        ],
      },
    };
  }

  function loanView(result, monthly) {
    const rows = monthly
      ? result.schedule.map((row) => ({
          cells: [
            { text: String(row.month) },
            { text: money(row.payment) },
            { text: money(row.interest) },
            { text: money(row.principal) },
            { text: money(row.balance) },
          ],
        }))
      : result.yearly.map((row) => ({
          cells: [
            { text: String(row.year) },
            { text: money(row.payment) },
            { text: money(row.interest) },
            { text: money(row.principal) },
            { text: money(row.balance) },
          ],
        }));
    return {
      hero: { label: 'Monthly payment', value: money(result.payment), tone: '' },
      stats: [
        ['Total interest', money(result.totalInterest)],
        ['Total paid', money(result.totalPaid)],
        ['Payments', core.formatCount(result.months)],
      ],
      note: 'Schedule amounts distribute rounding across payments, so individual payments may vary by a few cents. Actual lender schedules and rounding may differ.',
      table: {
        caption: monthly ? 'Every payment' : 'By year',
        cards: false,
        schedule: true,
        columns: [
          [monthly ? 'Payment' : 'Year', false],
          ['Paid', true],
          ['Interest', true],
          ['Principal', true],
          ['Balance', true],
        ],
        rows,
        foot: [
          'Total',
          money(result.totalPaid),
          money(result.totalInterest),
          money(result.amount),
          '',
        ],
      },
    };
  }

  function breakEvenView(result) {
    const exact = Math.abs(result.exactUnits - result.units) > 1e-6;
    return {
      hero: { label: 'Units to break even', value: core.formatCount(result.units), tone: '' },
      stats: [
        ['Break-even sales', money(result.revenue)],
        ['Margin per unit', money(result.margin)],
        ['Margin', core.formatPercent(result.marginRatio)],
      ],
      note: exact
        ? 'Exactly ' +
          result.exactUnits.toFixed(2) +
          ' units, or ' +
          money(result.exactRevenue) +
          " in sales. You can't sell part of a unit, so the count rounds up."
        : '',
      table: {
        caption: 'Profit at different sales volumes',
        cards: true,
        columns: [
          ['Units sold', false],
          ['Revenue', true],
          ['Total costs', true],
          ['Profit', true],
        ],
        rows: result.table.map((row) => ({
          mark: row.isBreakEven,
          cells: [
            { text: core.formatCount(row.units), sub: row.isBreakEven ? 'Break-even' : '' },
            { text: money(row.revenue) },
            { text: money(row.variableCosts + row.fixedCosts) },
            { text: money(row.profit), tone: tone(row.profit) },
          ],
        })),
        foot: null,
      },
    };
  }

  function renderSummary(doc, view) {
    const hero = el(doc, 'p', { className: 'af-hero-stat' }, [
      el(doc, 'span', { className: 'af-hero-label', text: view.hero.label }),
      el(doc, 'strong', {
        className: 'af-hero-value' + (view.hero.tone ? ' is-' + view.hero.tone : ''),
        text: view.hero.value,
      }),
    ]);
    const stats = el(
      doc,
      'dl',
      { className: 'af-stats' },
      view.stats.map((pair) =>
        el(doc, 'div', null, [el(doc, 'dt', { text: pair[0] }), el(doc, 'dd', { text: pair[1] })]),
      ),
    );
    return [
      hero,
      stats,
      view.note ? el(doc, 'p', { className: 'af-note', text: view.note }) : null,
    ].filter(Boolean);
  }

  function renderTable(doc, table) {
    const head = el(doc, 'thead', null, [
      el(
        doc,
        'tr',
        null,
        table.columns.map((column) =>
          el(doc, 'th', { scope: 'col', className: column[1] ? 'is-num' : null, text: column[0] }),
        ),
      ),
    ]);
    const body = el(
      doc,
      'tbody',
      null,
      table.rows.map((row) =>
        el(
          doc,
          'tr',
          { className: row.mark ? 'is-mark' : null },
          row.cells.map((cell, index) => {
            const column = table.columns[index];
            const classes = [column[1] ? 'is-num' : '', cell.tone ? 'is-' + cell.tone : '']
              .filter(Boolean)
              .join(' ');
            const children = [doc.createTextNode(cell.text)];
            if (cell.sub)
              children.push(el(doc, 'span', { className: 'af-cell-sub', text: cell.sub }));
            return el(
              doc,
              index === 0 ? 'th' : 'td',
              {
                scope: index === 0 ? 'row' : null,
                className: classes || null,
                'data-label': column[0],
              },
              children,
            );
          }),
        ),
      ),
    );
    const foot = table.foot
      ? el(doc, 'tfoot', null, [
          el(
            doc,
            'tr',
            null,
            table.foot.map((text, index) =>
              el(doc, index === 0 ? 'th' : 'td', {
                scope: index === 0 ? 'row' : null,
                className: table.columns[index][1] ? 'is-num' : null,
                'data-label': text ? table.columns[index][0] : null,
                text,
              }),
            ),
          ),
        ])
      : null;
    const element = el(
      doc,
      'table',
      {
        className:
          'af-table' +
          (table.cards ? ' af-table-cards' : '') +
          (table.schedule ? ' af-table-schedule' : ''),
      },
      [el(doc, 'caption', { text: table.caption }), head, body, foot],
    );
    return el(
      doc,
      'div',
      {
        className: 'af-table-scroll' + (table.cards ? ' is-cards' : ''),
        role: 'region',
        tabindex: '0',
        'aria-label': table.caption,
      },
      [element],
    );
  }

  function field(doc, id, labelText, value, affix, attrs) {
    const input = el(
      doc,
      'input',
      Object.assign(
        {
          id,
          type: 'text',
          inputmode: affix === '' ? 'text' : 'decimal',
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-describedby': id + '-error',
          value,
        },
        attrs,
      ),
    );
    const parts = [];
    if (affix === '$')
      parts.push(el(doc, 'span', { className: 'af-affix', 'aria-hidden': 'true', text: '$' }));
    parts.push(input);
    if (affix && affix !== '$')
      parts.push(
        el(doc, 'span', { className: 'af-affix af-affix-end', 'aria-hidden': 'true', text: affix }),
      );
    return el(doc, 'div', { className: 'af-field' }, [
      el(doc, 'label', { for: id, text: labelText }),
      el(doc, 'span', { className: 'af-input' }, parts),
      el(doc, 'p', { className: 'af-error', id: id + '-error', hidden: true }),
    ]);
  }

  function renderHolding(doc, row, index, total) {
    const base = 'af-holding-' + index;
    const number = index + 1;
    const attrs = (key) => ({ 'data-af-row': String(index), 'data-af-key': key });
    return el(
      doc,
      'div',
      { className: 'af-holding', role: 'group', 'aria-labelledby': base + '-title' },
      [
        el(doc, 'div', { className: 'af-holding-head' }, [
          el(doc, 'span', {
            className: 'af-holding-title',
            id: base + '-title',
            text: 'Holding ' + number,
          }),
          total > 1
            ? el(doc, 'button', {
                type: 'button',
                className: 'af-remove',
                'data-af-action': 'remove-row',
                'data-af-row': String(index),
                'aria-label': 'Remove holding ' + number,
                text: 'Remove',
              })
            : null,
        ]),
        field(
          doc,
          base + '-label',
          'Name',
          row.label,
          '',
          Object.assign(
            { maxlength: String(core.MAX_LABEL), placeholder: 'Holding ' + number },
            attrs('label'),
          ),
        ),
        el(doc, 'div', { className: 'af-holding-numbers' }, [
          field(doc, base + '-amount', 'Amount', row.amount, '$', attrs('amount')),
          field(doc, base + '-rate', 'Rate per year', row.rate, '%', attrs('rate')),
          field(doc, base + '-years', 'Years', row.years, 'yrs', attrs('years')),
        ]),
      ],
    );
  }

  function compute(state, tab) {
    if (tab === 'loan') return core.amortize(state.loan);
    if (tab === 'breakeven') return core.breakEven(state.breakeven);
    return core.opportunityCost(state.opportunity);
  }

  function mount(root, win) {
    const doc = root.ownerDocument;
    const all = (selector) => Array.prototype.slice.call(root.querySelectorAll(selector));
    const tabs = all('[data-af-tab]');
    const panels = {};
    const boxes = {};
    all('[data-af-panel]').forEach((panel) => {
      panels[panel.getAttribute('data-af-panel')] = panel;
    });
    all('[data-af-results]').forEach((box) => {
      boxes[box.getAttribute('data-af-results')] = {
        summary: box.querySelector('[data-af-summary]'),
        invalid: box.querySelector('[data-af-invalid]'),
        table: box.querySelector('[data-af-table]'),
      };
    });
    const holdings = root.querySelector('[data-af-holdings]');
    const status = root.querySelector('[data-af-status]');
    const live = root.querySelector('[data-af-live]');
    const monthlyToggle = root.querySelector('[data-af-monthly]');
    const printHead = root.querySelector('[data-af-print-head]');
    let state = core.decodeState(win.location.hash);
    let hashTimer = 0;
    let liveTimer = 0;

    function say(message) {
      status.textContent = message;
    }

    function setError(input, message) {
      const error = doc.getElementById(input.getAttribute('aria-describedby'));
      if (error) {
        error.textContent = message;
        error.hidden = !message;
      }
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      input.parentNode.classList.toggle('is-invalid', Boolean(message));
    }

    function showErrors(tab, result) {
      const errors = result.ok ? {} : result.errors;
      all('[data-af-field^="' + tab + '."]').forEach((input) => {
        setError(input, errors[input.getAttribute('data-af-field').split('.')[1]] || '');
      });
      if (tab !== 'opportunity') return;
      all('[data-af-row][data-af-key]').forEach((input) => {
        const rowErrors = errors.rows
          ? errors.rows[Number(input.getAttribute('data-af-row'))]
          : null;
        setError(input, (rowErrors && rowErrors[input.getAttribute('data-af-key')]) || '');
      });
    }

    function render(tab) {
      const result = compute(state, tab);
      const box = boxes[tab];
      showErrors(tab, result);
      box.invalid.hidden = result.ok;
      if (!result.ok) {
        box.summary.replaceChildren();
        box.table.replaceChildren();
        return null;
      }
      const view =
        tab === 'loan'
          ? loanView(result, Boolean(monthlyToggle && monthlyToggle.checked))
          : tab === 'breakeven'
            ? breakEvenView(result)
            : opportunityView(result);
      box.summary.replaceChildren.apply(box.summary, renderSummary(doc, view));
      box.table.replaceChildren(renderTable(doc, view.table));
      return view;
    }

    function announce(tab, view) {
      if (!live) return;
      if (liveTimer) win.clearTimeout(liveTimer);
      liveTimer = win.setTimeout(() => {
        live.textContent = view
          ? view.hero.label + ' ' + view.hero.value
          : 'Fix the fields marked in red to see results.';
      }, 700);
    }

    function writeHash() {
      if (hashTimer) win.clearTimeout(hashTimer);
      hashTimer = 0;
      const next = '#' + core.encodeState(state);
      if (win.location.hash !== next) win.history.replaceState(null, '', next);
    }

    function scheduleHash() {
      if (hashTimer) win.clearTimeout(hashTimer);
      hashTimer = win.setTimeout(writeHash, 300);
    }

    function update(tab) {
      announce(tab, render(tab));
      scheduleHash();
    }

    function buildHoldings() {
      const rows = state.opportunity.rows;
      holdings.replaceChildren.apply(
        holdings,
        rows.map((row, index) => renderHolding(doc, row, index, rows.length)),
      );
      const add = root.querySelector('[data-af-action="add-row"]');
      if (add) add.disabled = rows.length >= core.MAX_ROWS;
    }

    function selectTab(tab, focus) {
      state.tab = core.TABS.includes(tab) ? tab : 'opportunity';
      tabs.forEach((button) => {
        const selected = button.getAttribute('data-af-tab') === state.tab;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected && focus) button.focus();
      });
      Object.keys(panels).forEach((key) => {
        panels[key].hidden = key !== state.tab;
      });
    }

    function syncAll() {
      all('[data-af-field]').forEach((input) => {
        const path = input.getAttribute('data-af-field').split('.');
        input.value = state[path[0]][path[1]];
      });
      buildHoldings();
      selectTab(state.tab, false);
      core.TABS.forEach(render);
    }

    function fillPrintHead() {
      const link = win.location.href.split('#')[0] + '#' + core.encodeState(state);
      const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      printHead.replaceChildren(
        el(doc, 'strong', { text: 'AlcorFinance: ' + TITLES[state.tab] }),
        el(doc, 'span', { text: 'Printed ' + date + '. Open this scenario again at:' }),
        el(doc, 'span', { className: 'af-print-link', text: link }),
      );
    }

    function downloadCsv() {
      const rows = core.csvRows(state.tab, compute(state, state.tab));
      if (!rows) {
        say('Fix the fields marked in red, then download.');
        return;
      }
      const url = win.URL.createObjectURL(
        new win.Blob(['\ufeff' + core.toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
      );
      const link = el(doc, 'a', { href: url, download: FILES[state.tab], hidden: true });
      doc.body.appendChild(link);
      link.click();
      link.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
      say('Downloaded ' + FILES[state.tab] + ' (' + core.formatCount(rows.length - 1) + ' rows).');
    }

    function copyLink() {
      writeHash();
      const link = win.location.href.split('#')[0] + '#' + core.encodeState(state);
      const failed = () => say("Couldn't copy. The address bar has the same link.");
      if (!win.navigator.clipboard || !win.isSecureContext) {
        failed();
        return;
      }
      win.navigator.clipboard
        .writeText(link)
        .then(() => say('Link copied. Anyone who opens it sees these numbers.'), failed);
    }

    root.addEventListener('input', (event) => {
      const input = event.target;
      const path = input.getAttribute('data-af-field');
      if (path) {
        const parts = path.split('.');
        state[parts[0]][parts[1]] = input.value;
        update(parts[0]);
        return;
      }
      const row = input.getAttribute('data-af-row');
      const key = input.getAttribute('data-af-key');
      if (row !== null && key && state.opportunity.rows[Number(row)]) {
        state.opportunity.rows[Number(row)][key] = input.value;
        update('opportunity');
      }
    });

    root.addEventListener('change', (event) => {
      if (event.target === monthlyToggle) render('loan');
    });

    root.addEventListener('submit', (event) => event.preventDefault());

    root.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-af-tab]');
      if (tab) {
        selectTab(tab.getAttribute('data-af-tab'), false);
        say('');
        scheduleHash();
        return;
      }
      const button = event.target.closest('[data-af-action]');
      if (!button) return;
      const action = button.getAttribute('data-af-action');
      const rows = state.opportunity.rows;
      if (action === 'copy') copyLink();
      if (action === 'csv') downloadCsv();
      if (action === 'print') {
        fillPrintHead();
        win.print();
      }
      if (action === 'add-row' && rows.length < core.MAX_ROWS) {
        rows.push(Object.assign({}, NEW_ROW));
        buildHoldings();
        doc.getElementById('af-holding-' + (rows.length - 1) + '-label').focus();
        update('opportunity');
      }
      if (action === 'remove-row' && rows.length > 1) {
        const index = Number(button.getAttribute('data-af-row'));
        rows.splice(index, 1);
        buildHoldings();
        doc.getElementById('af-holding-' + Math.min(index, rows.length - 1) + '-label').focus();
        update('opportunity');
      }
      if (action === 'example') {
        state.opportunity = core.defaultState().opportunity;
        syncAll();
        update('opportunity');
      }
    });

    root.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      let next = -1;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(tabs[next].getAttribute('data-af-tab'), true);
      scheduleHash();
    });

    win.addEventListener('hashchange', () => {
      if (!core.isStateHash(win.location.hash)) return;
      const next = core.decodeState(win.location.hash);
      if (core.encodeState(next) === core.encodeState(state)) return;
      state = next;
      syncAll();
    });

    win.addEventListener('beforeprint', fillPrintHead);

    syncAll();
    return { state: () => state };
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const start = () => {
      const root = document.querySelector('[data-alcor-finance]');
      if (!root) return;
      mount(root, window);
      // The skip link focuses the tool without replacing the scenario in the address bar.
      const skip = document.querySelector('.af-skip');
      if (skip)
        skip.addEventListener('click', (event) => {
          event.preventDefault();
          root.focus();
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return Object.freeze({
    el,
    opportunityView,
    loanView,
    breakEvenView,
    renderSummary,
    renderTable,
    renderHolding,
    mount,
  });
});
