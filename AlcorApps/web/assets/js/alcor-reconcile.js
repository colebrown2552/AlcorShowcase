/*!
 * AlcorReconcile browser tool 0.1.0
 * Binds to [data-alcor-reconcile-app]. Files are read with File.arrayBuffer() on this
 * device and never leave it: no network primitive, no storage, no workers, no console output.
 * Every value from a file is rendered with textContent.
 */
(function (global) {
  'use strict';

  const doc = global.document;
  const Core = global.AlcorReconcileCore;
  const root = doc && doc.querySelector('[data-alcor-reconcile-app]');
  if (!root || !Core) return;

  const MAX_BYTES = positiveInt(root.getAttribute('data-max-bytes'), Core.DEFAULT_MAX_BYTES);
  const DISPLAY_LIMIT = positiveInt(root.getAttribute('data-display-limit'), 500);
  const MAX_COLUMNS = 1000;
  const NONE = 'none';
  const STATUS_LABELS = Object.freeze({
    matched: 'Matched',
    amount_mismatch: 'Amount differs',
    missing_right: 'Only in left file',
    missing_left: 'Only in right file',
    duplicate_key: 'Duplicate key',
    invalid_amount: 'Invalid amount',
    missing_key: 'Blank key',
  });
  const COLUMN_LABELS = Object.freeze([
    'Key',
    'Status',
    'Left rows',
    'Right rows',
    'Left amount',
    'Right amount',
    'Difference',
    'Note',
  ]);
  const TILE_ORDER = [
    'matched',
    'amount_mismatch',
    'missing_right',
    'missing_left',
    'duplicate_key',
    'invalid_amount',
    'missing_key',
  ];

  const state = {
    sides: { left: emptySide(), right: emptySide() },
    report: null,
    filter: 'all',
    busy: false,
    // Bumped whenever a side's file changes, so a slower earlier read cannot land after it.
    readSeq: { left: 0, right: 0 },
  };

  function positiveInt(value, fallback) {
    const number = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function emptySide() {
    return { name: '', size: 0, table: null };
  }

  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((name) => {
        const value = attrs[name];
        if (value === false || value === null || value === undefined) return;
        if (name === 'text') node.textContent = String(value);
        else node.setAttribute(name, value === true ? '' : String(value));
      });
    }
    (children || []).forEach((child) => {
      if (child) node.append(child);
    });
    return node;
  }

  function formatBytes(size) {
    if (size < 1024) return `${size} bytes`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function plural(count, word) {
    return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------------------
  // Build the interface.
  // ---------------------------------------------------------------------------
  const ui = { sides: {} };

  function buildSide(side, title, example) {
    const id = `ar-${side}`;
    const input = el('input', {
      type: 'file',
      id: `${id}-file`,
      accept: '.csv,text/csv,text/plain',
      'aria-describedby': `${id}-status`,
    });
    const zone = el('div', { class: 'ar-drop', 'data-side': side }, [
      el('h3', { class: 'ar-drop-title', text: title }),
      el('p', { class: 'ar-drop-example', text: example }),
      el('label', { class: 'ar-button ar-file-button', for: `${id}-file` }, [
        doc.createTextNode('Choose CSV file'),
        input,
      ]),
      el('p', { class: 'ar-drop-hint', text: 'or drop a .csv file here' }),
      el('p', {
        class: 'ar-file-status',
        id: `${id}-status`,
        role: 'status',
        'aria-live': 'polite',
        text: 'No file selected.',
      }),
    ]);
    const key = el('select', { id: `${id}-key`, disabled: true });
    const amount = el('select', { id: `${id}-amount`, disabled: true });
    const hint = el('p', { class: 'ar-hint', id: `${id}-columns-hint`, hidden: true });
    const columns = el('fieldset', { class: 'ar-columns' }, [
      el('legend', { text: side === 'left' ? 'Left file columns' : 'Right file columns' }),
      el('label', { class: 'ar-field', for: key.id }, [
        el('span', { text: 'Match on (key column)' }),
      ]),
      key,
      el('label', { class: 'ar-field', for: amount.id }, [
        el('span', { text: 'Amount column (optional)' }),
      ]),
      amount,
      hint,
    ]);
    ui.sides[side] = {
      input,
      zone,
      key,
      amount,
      hint,
      status: zone.querySelector('.ar-file-status'),
    };
    return { zone, columns };
  }

  const left = buildSide('left', 'Left file', 'For example, invoices or orders.');
  const right = buildSide('right', 'Right file', 'For example, payments or shipments.');

  ui.tolerance = el('input', {
    type: 'text',
    id: 'ar-tolerance',
    value: '0.00',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'ar-tolerance-help',
  });
  ui.caseSensitive = el('input', { type: 'checkbox', id: 'ar-case-sensitive' });
  ui.run = el('button', {
    type: 'button',
    class: 'ar-button ar-button-primary',
    'data-action': 'run',
    text: 'Run reconciliation',
  });
  ui.sample = el('button', {
    type: 'button',
    class: 'ar-button',
    'data-action': 'sample',
    text: 'Load sample data',
  });
  ui.clear = el('button', {
    type: 'button',
    class: 'ar-button',
    'data-action': 'clear',
    text: 'Clear',
  });
  ui.message = el('p', {
    class: 'ar-message',
    id: 'ar-message',
    role: 'status',
    'aria-live': 'polite',
    text: 'Choose two CSV files, or load the synthetic sample.',
  });
  ui.tiles = el('div', { class: 'ar-tiles', role: 'group', 'aria-label': 'Summary by status' });
  ui.totals = el('p', { class: 'ar-totals', id: 'ar-totals' });
  ui.filter = el('select', { id: 'ar-filter' });
  ui.exportCsv = el('button', {
    type: 'button',
    class: 'ar-button ar-button-primary',
    'data-action': 'export-csv',
    text: 'Export report CSV',
  });
  ui.exportShown = el('button', {
    type: 'button',
    class: 'ar-button',
    'data-action': 'export-shown',
    text: 'Export shown rows',
  });
  ui.exportJson = el('button', {
    type: 'button',
    class: 'ar-button',
    'data-action': 'export-json',
    text: 'Export report JSON',
  });
  ui.notice = el('p', {
    class: 'ar-message',
    id: 'ar-notice',
    role: 'status',
    'aria-live': 'polite',
    'data-level': 'error',
    hidden: true,
  });
  ui.tableBody = el('tbody');
  ui.tableNote = el('p', { class: 'ar-table-note', id: 'ar-table-note' });
  ui.results = el('div', { class: 'ar-results', id: 'ar-results', hidden: true }, [
    el('h2', {
      class: 'ar-step-title',
      id: 'ar-results-title',
      tabindex: '-1',
      text: '3. Results',
    }),
    ui.tiles,
    ui.totals,
    el('div', { class: 'ar-results-bar' }, [
      el('label', { class: 'ar-inline-field', for: 'ar-filter' }, [el('span', { text: 'Show' })]),
      ui.filter,
      el('div', { class: 'ar-export' }, [ui.exportCsv, ui.exportShown, ui.exportJson]),
    ]),
    el(
      'div',
      {
        class: 'ar-table-wrap',
        role: 'region',
        'aria-labelledby': 'ar-table-caption',
        tabindex: '0',
      },
      [
        el('table', { class: 'ar-table' }, [
          el('caption', { id: 'ar-table-caption', text: 'One row per key, sorted by key' }),
          el('thead', null, [
            el(
              'tr',
              null,
              COLUMN_LABELS.map((label) => el('th', { scope: 'col', text: label })),
            ),
          ]),
          ui.tableBody,
        ]),
      ],
    ),
    ui.tableNote,
    el('p', {
      class: 'ar-hint',
      text: 'The CSV export prefixes an apostrophe to any text cell that starts with =, +, -, @ (even after invisible control characters), a tab, or a carriage return, so spreadsheets show it as text instead of running it as a formula. Plain negative numbers in the amount and difference columns, such as -30.00, are left as numbers. Export report CSV has every row; Export shown rows has only the rows for the status you are viewing. The JSON export keeps every value exactly as computed.',
    }),
  ]);

  root.replaceChildren(
    el('div', { class: 'ar-step' }, [
      el('h2', { class: 'ar-step-title', text: '1. Choose two CSV files' }),
      el('div', { class: 'ar-drops' }, [left.zone, right.zone]),
      el('div', { class: 'ar-actions' }, [ui.sample, ui.clear]),
    ]),
    el('div', { class: 'ar-step' }, [
      el('h2', { class: 'ar-step-title', text: '2. Choose columns and rules' }),
      el('div', { class: 'ar-column-grid' }, [left.columns, right.columns]),
      el('div', { class: 'ar-rules' }, [
        el('div', { class: 'ar-field' }, [
          el('label', { for: 'ar-tolerance', text: 'Tolerance' }),
          ui.tolerance,
          el('small', {
            id: 'ar-tolerance-help',
            text: 'Largest difference that still counts as matched, inclusive. Use . as the decimal point, for example 0.01.',
          }),
        ]),
        el('label', { class: 'ar-check', for: 'ar-case-sensitive' }, [
          ui.caseSensitive,
          doc.createTextNode(' Case-sensitive keys (INV-1 and inv-1 are different)'),
        ]),
      ]),
      el('div', { class: 'ar-actions' }, [ui.run]),
      ui.message,
      ui.notice,
    ]),
    ui.results,
  );

  // ---------------------------------------------------------------------------
  // Files and column pickers.
  // ---------------------------------------------------------------------------
  function setMessage(text, level) {
    ui.message.textContent = text;
    ui.message.setAttribute('data-level', level || 'neutral');
  }

  function setSideStatus(side, text, level) {
    const status = ui.sides[side].status;
    status.textContent = text;
    status.setAttribute('data-level', level || 'neutral');
  }

  function hasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return Boolean(types && Array.prototype.indexOf.call(types, 'Files') !== -1);
  }

  async function acceptFile(side, file, ignoredCount) {
    if (!file) return;
    const seq = ++state.readSeq[side];
    clearReport();
    state.sides[side] = emptySide();
    renderColumns(side);
    if (file.size > MAX_BYTES) {
      setSideStatus(
        side,
        `${file.name} is ${formatBytes(file.size)}. This browser tool reads files up to ${formatBytes(MAX_BYTES)}; split the export into smaller files.`,
        'error',
      );
      return;
    }
    setSideStatus(side, `Reading ${file.name} on this device…`, 'neutral');
    try {
      const bytes = await file.arrayBuffer();
      if (seq !== state.readSeq[side]) return;
      const kind = binaryKind(bytes);
      if (kind)
        throw new Error(
          `${file.name} is ${kind}, not a CSV text file. In Excel choose File > Save As > "CSV UTF-8 (Comma delimited)", then choose the saved .csv file here.`,
        );
      loadText(
        side,
        file.name,
        bytes.byteLength,
        Core.decodeUtf8(bytes, file.name),
        ignoredCount ? `Only ${file.name} was used; drop one file on each side.` : '',
      );
    } catch (error) {
      if (seq !== state.readSeq[side]) return;
      if (error instanceof Core.ReconcileError && error.code === 'invalid_utf8') {
        setSideStatus(
          side,
          `${file.name} is not saved as UTF-8 (Excel's plain "CSV (Comma delimited)" uses Windows-1252, which breaks accented letters and symbols such as é and €). In Excel choose File > Save As > "CSV UTF-8 (Comma delimited)", then choose the file again.`,
          'error',
        );
        return;
      }
      setSideStatus(side, errorText(error), 'error');
    }
  }

  /** Names a spreadsheet or archive by its first bytes (an .xlsx is a ZIP; an old .xls is an OLE file). */
  function binaryKind(buffer) {
    const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
    if (
      head.length >= 4 &&
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      (head[2] === 3 || head[2] === 5 || head[2] === 7) &&
      (head[3] === 4 || head[3] === 6 || head[3] === 8)
    ) {
      return 'an Excel workbook (or other zip archive)';
    }
    if (
      head.length >= 8 &&
      head[0] === 0xd0 &&
      head[1] === 0xcf &&
      head[2] === 0x11 &&
      head[3] === 0xe0 &&
      head[4] === 0xa1 &&
      head[5] === 0xb1 &&
      head[6] === 0x1a &&
      head[7] === 0xe1
    ) {
      return 'an old Excel workbook (.xls)';
    }
    return '';
  }

  /** True when line 1 has semicolons or tabs but no commas: a semicolon- or tab-separated export. */
  function wrongDelimiter(text) {
    const line = text.replace(/^\ufeff/, '').split(/\r\n|\n|\r/, 1)[0];
    if (line.indexOf(',') !== -1) return '';
    if (line.indexOf(';') !== -1) return 'semicolons';
    if (line.indexOf('\t') !== -1) return 'tabs';
    return '';
  }

  function loadText(side, name, size, text, extraNote) {
    try {
      if (/^[{[]/.test(text.replace(/^\ufeff/, '').trimStart())) {
        throw new Error(
          `${name} looks like JSON, not a CSV file. Export the data as CSV (comma-separated), then choose that file here.`,
        );
      }
      const delimiter = wrongDelimiter(text);
      if (delimiter) {
        throw new Error(
          `${name} looks like it is separated by ${delimiter}, not commas, so the columns cannot be split. Save it as a comma-separated file (in Excel: File > Save As > "CSV UTF-8 (Comma delimited)"), then choose it again.`,
        );
      }
      const table = Core.readTable(text, name);
      if (table.fields.length === 0) {
        throw new Error(
          `${name}: the first line is blank, so no header row was found. Put the column names on line 1.`,
        );
      }
      if (table.fields.length > MAX_COLUMNS) {
        throw new Error(
          `${name} has ${plural(table.fields.length, 'column')}. This browser tool reads files with up to ${MAX_COLUMNS.toLocaleString('en-US')} columns; export only the columns you need.`,
        );
      }
      if (table.rows.length === 0) {
        throw new Error(
          `${name} has column names but no data rows. Choose a file with at least one row below the header.`,
        );
      }
      state.sides[side] = { name, size, table };
      setSideStatus(
        side,
        `${name}: ${formatBytes(size)}, ${plural(table.rows.length, 'data row')}, ${plural(table.fields.length, 'column')}. Read on this device; not uploaded.${extraNote ? ` ${extraNote}` : ''}`,
        'success',
      );
    } catch (error) {
      state.sides[side] = emptySide();
      setSideStatus(side, errorText(error), 'error');
    }
    renderColumns(side);
  }

  /** One entry per distinct header name, with its count and first position (linear time). */
  function uniqueFields(fields) {
    const seen = new Map();
    fields.forEach((field, index) => {
      const entry = seen.get(field);
      if (entry) entry.count += 1;
      else seen.set(field, { name: field, count: 1, first: index });
    });
    return Array.from(seen.values());
  }

  function fieldLabel(name, index) {
    return name === '' ? `(blank header, column ${index + 1})` : name;
  }

  function fillSelect(select, entries, allowNone, pick) {
    // With no suggestion, the key picker stays on a placeholder so Run asks for a choice
    // instead of silently matching on whichever column comes first.
    const options = [
      el('option', {
        value: NONE,
        text: allowNone ? '(no amount column)' : '(choose a key column)',
      }),
    ];
    entries.forEach((entry, index) => {
      const blank = entry.name === '';
      const unusable = entry.count > 1 || (allowNone && blank);
      const label =
        fieldLabel(entry.name, entry.first) +
        (entry.count > 1 ? ` (appears ${entry.count} times; rename one to use it)` : '');
      options.push(
        el('option', {
          value: String(index),
          disabled: unusable,
          'data-name': entry.name,
          text: label,
        }),
      );
    });
    select.replaceChildren(...options);
    const chosen = options.find(
      (option) =>
        !option.disabled && option.value !== NONE && option.getAttribute('data-name') === pick,
    );
    select.value = chosen ? chosen.value : NONE;
  }

  function renderColumns(side, preset) {
    const view = ui.sides[side];
    const table = state.sides[side].table;
    if (!table) {
      view.key.replaceChildren();
      view.amount.replaceChildren();
      view.key.disabled = true;
      view.amount.disabled = true;
      view.hint.hidden = true;
      return;
    }
    const entries = uniqueFields(table.fields);
    const usable = entries.filter((entry) => entry.count === 1).map((entry) => entry.name);
    const keyPick = preset ? preset.key : Core.suggestColumn(usable, 'key');
    const amountPick = preset
      ? preset.amount
      : Core.suggestColumn(
          usable.filter((name) => name !== keyPick && name !== ''),
          'amount',
        );
    fillSelect(view.key, entries, false, keyPick);
    fillSelect(view.amount, entries, true, amountPick);
    view.key.disabled = false;
    view.amount.disabled = false;
    const duplicates = entries.filter((entry) => entry.count > 1);
    view.hint.hidden = duplicates.length === 0;
    view.hint.textContent =
      duplicates.length === 0
        ? ''
        : `Some header names appear more than once (${duplicates.map((entry) => fieldLabel(entry.name, entry.first)).join(', ')}). Those columns cannot be used for matching because it would be unclear which one to compare.`;
  }

  function selectedName(select) {
    const option = select.options[select.selectedIndex];
    if (!option || option.value === NONE) return null;
    return option.getAttribute('data-name');
  }

  // ---------------------------------------------------------------------------
  // Run and render the report.
  // ---------------------------------------------------------------------------
  function errorText(error) {
    if (error instanceof Core.ReconcileError && error.code === 'tolerance') {
      return 'Tolerance must be a non-negative decimal, for example 0.00 or 0.01. Grouping commas and currency symbols are not accepted here.';
    }
    if (error instanceof Core.ReconcileError && error.code === 'amount_pair') {
      return 'Choose an amount column for both files, or for neither.';
    }
    if (error instanceof Core.RunError && error.pythonException) {
      return `No report was produced: ${error.message}.`;
    }
    return error && error.message ? String(error.message) : String(error);
  }

  const DECIMAL_COMMA = /^(?:[0-9]+|[0-9]{1,3}(?:\.[0-9]{3})+),[0-9]{1,2}$/;

  /** Cells in the chosen amount columns that look like 12,50 or 1.234,50 (decimal comma). */
  function decimalCommaCells() {
    const found = [];
    ['left', 'right'].forEach((side) => {
      const table = state.sides[side].table;
      const name = selectedName(ui.sides[side].amount);
      if (!table || name === null) return;
      const index = table.lastIndex.get(name);
      table.rows.forEach((row) => {
        const cell = (row[index] || '').replace(/[\s$\u20ac\u00a3\u00a5()+-]/g, '');
        if (DECIMAL_COMMA.test(cell)) found.push({ side, value: row[index].trim() });
      });
    });
    return found;
  }

  function showDecimalCommaNotice() {
    const found = decimalCommaCells();
    if (found.length === 0) return;
    const first = found[0];
    ui.notice.textContent = `${plural(found.length, 'amount')} look like they use a decimal comma, for example "${first.value}" in the ${first.side} file. This tool reads only "." as the decimal point and treats commas as thousands separators, so "1,5" is read as 15 and "12,50" as 1250. Change those amounts to use "." (for example 1.50), choose the file again, and run again.`;
    ui.notice.hidden = false;
  }

  function clearReport() {
    const hadReport = state.report !== null;
    state.report = null;
    ui.notice.hidden = true;
    ui.notice.textContent = '';
    ui.results.hidden = true;
    ui.tableBody.replaceChildren();
    if (hadReport)
      setMessage(
        'Files or settings changed. Select Run reconciliation to compare again.',
        'neutral',
      );
  }

  function run() {
    if (state.busy) return;
    const leftTable = state.sides.left.table;
    const rightTable = state.sides.right.table;
    if (!leftTable || !rightTable) {
      setMessage('Choose a readable CSV file for both sides first.', 'error');
      return;
    }
    const config = {
      left_key: selectedName(ui.sides.left.key),
      right_key: selectedName(ui.sides.right.key),
      left_amount: selectedName(ui.sides.left.amount),
      right_amount: selectedName(ui.sides.right.amount),
      tolerance: ui.tolerance.value,
      case_sensitive: ui.caseSensitive.checked,
    };
    if (config.left_key === null || config.right_key === null) {
      setMessage('Choose a key column for both files.', 'error');
      return;
    }
    state.busy = true;
    ui.run.disabled = true;
    clearReport();
    setMessage('Comparing on this device…', 'neutral');
    global.setTimeout(() => {
      try {
        state.report = Core.reconcileTables(leftTable, rightTable, config);
        state.filter = 'all';
        renderReport();
        showDecimalCommaNotice();
        const rows = state.report.rows.length;
        setMessage(`Compared ${plural(rows, 'key')}. Nothing was uploaded.`, 'success');
        ui.results.hidden = false;
        doc.getElementById('ar-results-title').focus();
      } catch (error) {
        setMessage(errorText(error), 'error');
      } finally {
        state.busy = false;
        ui.run.disabled = false;
      }
    }, 0);
  }

  function renderReport() {
    const report = state.report;
    const counts = report.summary;
    ui.tiles.replaceChildren(
      ...TILE_ORDER.map((status) => {
        const count = counts[status] || 0;
        return el(
          'button',
          {
            type: 'button',
            class: 'ar-tile',
            'data-status': status,
            'aria-pressed': state.filter === status ? 'true' : 'false',
          },
          [
            el('span', { class: 'ar-tile-count', text: count.toLocaleString('en-US') }),
            el('span', { class: 'ar-tile-label', text: STATUS_LABELS[status] }),
            el('span', { class: 'ar-tile-code', 'aria-hidden': 'true', text: status }),
          ],
        );
      }),
    );
    const leftRows = state.sides.left.table.rows.length;
    const rightRows = state.sides.right.table.rows.length;
    ui.totals.textContent = `Left file: ${plural(leftRows, 'data row')}. Right file: ${plural(rightRows, 'data row')}. Keys compared: ${report.rows.length.toLocaleString('en-US')}. Tolerance: ${report.config.tolerance}. Keys ${report.config.case_sensitive ? 'are' : 'are not'} case-sensitive.`;
    const filterOptions = [
      el('option', {
        value: 'all',
        text: `All statuses (${report.rows.length.toLocaleString('en-US')})`,
      }),
    ];
    TILE_ORDER.forEach((status) => {
      filterOptions.push(
        el('option', {
          value: status,
          text: `${STATUS_LABELS[status]} (${(counts[status] || 0).toLocaleString('en-US')})`,
        }),
      );
    });
    ui.filter.replaceChildren(...filterOptions);
    ui.filter.value = state.filter;
    renderRows();
  }

  function renderRows() {
    const rows = state.report.rows.filter(
      (row) => state.filter === 'all' || row.status === state.filter,
    );
    const shown = rows.slice(0, DISPLAY_LIMIT);
    ui.tableBody.replaceChildren(
      ...shown.map((row) =>
        el('tr', { 'data-status': row.status }, [
          el('td', { class: 'ar-key', 'data-label': COLUMN_LABELS[0], text: row.key }),
          el('td', { 'data-label': COLUMN_LABELS[1] }, [
            el('span', {
              class: 'ar-status',
              'data-status': row.status,
              text: STATUS_LABELS[row.status],
            }),
          ]),
          el('td', { class: 'ar-num', 'data-label': COLUMN_LABELS[2], text: row.left_count }),
          el('td', { class: 'ar-num', 'data-label': COLUMN_LABELS[3], text: row.right_count }),
          el('td', { class: 'ar-num', 'data-label': COLUMN_LABELS[4], text: row.left_amount }),
          el('td', { class: 'ar-num', 'data-label': COLUMN_LABELS[5], text: row.right_amount }),
          el('td', { class: 'ar-num', 'data-label': COLUMN_LABELS[6], text: row.difference }),
          el('td', { class: 'ar-note', 'data-label': COLUMN_LABELS[7], text: row.note }),
        ]),
      ),
    );
    if (rows.length === 0) {
      ui.tableBody.replaceChildren(
        el('tr', null, [el('td', { colspan: '8', text: 'No keys have this status.' })]),
      );
    }
    ui.tableNote.textContent =
      rows.length > DISPLAY_LIMIT
        ? `Showing the first ${DISPLAY_LIMIT.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} rows. The export contains every row.`
        : '';
    Array.prototype.forEach.call(ui.tiles.children, (tile) => {
      tile.setAttribute(
        'aria-pressed',
        tile.getAttribute('data-status') === state.filter ? 'true' : 'false',
      );
    });
  }

  function download(content, type, filename) {
    const url = global.URL.createObjectURL(new global.Blob([content], { type }));
    try {
      const anchor = el('a', { href: url, download: filename, hidden: true });
      doc.body.append(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      global.setTimeout(() => global.URL.revokeObjectURL(url), 30000);
    }
  }

  function exportReport(format, shownOnly) {
    const report = state.report;
    if (!report) return;
    if (format === 'json') {
      download(
        Core.toJson(report),
        'application/json;charset=utf-8',
        'alcor-reconcile-report.json',
      );
      setMessage('Saved the JSON report from this browser. Nothing was uploaded.', 'success');
      return;
    }
    if (shownOnly) {
      const rows = report.rows.filter(
        (row) => state.filter === 'all' || row.status === state.filter,
      );
      const suffix = state.filter === 'all' ? '' : `-${state.filter.replace(/_/g, '-')}`;
      download(
        Core.toCsv(Object.assign({}, report, { rows }), { neutralizeFormulas: true }),
        'text/csv;charset=utf-8',
        `alcor-reconcile-shown${suffix}.csv`,
      );
      setMessage(
        `Saved ${plural(rows.length, 'shown row')} as CSV from this browser. Nothing was uploaded.`,
        'success',
      );
      return;
    }
    download(
      Core.toCsv(report, { neutralizeFormulas: true }),
      'text/csv;charset=utf-8',
      'alcor-reconcile-report.csv',
    );
    setMessage('Saved the CSV report from this browser. Nothing was uploaded.', 'success');
  }

  function loadSample() {
    clearReport();
    state.readSeq.left += 1;
    state.readSeq.right += 1;
    const sample = Core.SAMPLE;
    const encoder = new global.TextEncoder();
    ui.tolerance.value = sample.config.tolerance;
    ui.caseSensitive.checked = sample.config.case_sensitive;
    [
      ['left', sample.leftName, sample.left, sample.config.left_key, sample.config.left_amount],
      [
        'right',
        sample.rightName,
        sample.right,
        sample.config.right_key,
        sample.config.right_amount,
      ],
    ].forEach(([side, name, text, key, amount]) => {
      loadText(side, name, encoder.encode(text).byteLength, text);
      renderColumns(side, { key, amount });
      ui.sides[side].input.value = '';
    });
    setMessage(
      'Loaded synthetic sample invoices and payments. Select Run reconciliation to compare them.',
      'neutral',
    );
  }

  function clearAll() {
    clearReport();
    ['left', 'right'].forEach((side) => {
      state.readSeq[side] += 1;
      state.sides[side] = emptySide();
      ui.sides[side].input.value = '';
      setSideStatus(side, 'No file selected.', 'neutral');
      renderColumns(side);
    });
    ui.tolerance.value = '0.00';
    ui.caseSensitive.checked = false;
    setMessage('Cleared. Choose two CSV files, or load the synthetic sample.', 'neutral');
  }

  // ---------------------------------------------------------------------------
  // Events.
  // ---------------------------------------------------------------------------
  ['left', 'right'].forEach((side) => {
    const view = ui.sides[side];
    view.input.addEventListener('change', () => {
      acceptFile(side, view.input.files && view.input.files[0]);
    });
    ['dragenter', 'dragover'].forEach((name) =>
      view.zone.addEventListener(name, (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        view.zone.setAttribute('data-drag', 'true');
      }),
    );
    view.zone.addEventListener('dragleave', (event) => {
      if (!view.zone.contains(event.relatedTarget)) view.zone.setAttribute('data-drag', 'false');
    });
    view.zone.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      view.zone.setAttribute('data-drag', 'false');
      const dropped = event.dataTransfer.files;
      acceptFile(side, dropped[0], dropped.length - 1);
    });
    [view.key, view.amount].forEach((select) => select.addEventListener('change', clearReport));
  });

  // A file dropped outside both zones would make the browser navigate away and lose the work.
  ['dragover', 'drop'].forEach((name) =>
    doc.addEventListener(name, (event) => {
      if (hasFiles(event)) event.preventDefault();
    }),
  );

  ui.tolerance.addEventListener('input', clearReport);
  ui.caseSensitive.addEventListener('change', clearReport);
  ui.run.addEventListener('click', run);
  ui.sample.addEventListener('click', loadSample);
  ui.clear.addEventListener('click', clearAll);
  ui.exportCsv.addEventListener('click', () => exportReport('csv'));
  ui.exportShown.addEventListener('click', () => exportReport('csv', true));
  ui.exportJson.addEventListener('click', () => exportReport('json'));
  ui.filter.addEventListener('change', () => {
    state.filter = ui.filter.value;
    renderRows();
  });
  ui.tiles.addEventListener('click', (event) => {
    const tile = event.target.closest('.ar-tile');
    if (!tile) return;
    const status = tile.getAttribute('data-status');
    state.filter = state.filter === status ? 'all' : status;
    ui.filter.value = state.filter;
    renderRows();
  });

  root.setAttribute('data-ready', 'true');
})(typeof window !== 'undefined' ? window : globalThis);
