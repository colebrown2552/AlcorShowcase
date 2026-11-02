/*
 * AlcorFinance core: compound growth, opportunity cost, fixed-rate loan
 * amortization, break-even, link state, and CSV.
 *
 * Pure functions only. No DOM, network, storage, or clock access, so the same
 * file runs in the browser and under `node --test`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlcorFinanceCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TABS = Object.freeze(['opportunity', 'loan', 'breakeven']);
  const MAX_ROWS = 20;
  const MAX_LABEL = 60;
  const MAX_FIELD = 24;
  const MAX_HASH = 4096;
  const MAX_AMOUNT = 1e12;
  const MAX_RATE = 100;
  const MAX_GROWTH_YEARS = 100;
  const MAX_LOAN_YEARS = 50;

  const EXAMPLE_ROWS = Object.freeze([
    Object.freeze({ label: 'Real Estate', amount: '250000', rate: '6.5', years: '10' }),
    Object.freeze({ label: 'T-Bills', amount: '50000', rate: '4.8', years: '2' }),
    Object.freeze({ label: 'Stocks', amount: '100000', rate: '10', years: '10' }),
  ]);

  function defaultState() {
    return {
      tab: 'opportunity',
      opportunity: { baseline: '10', rows: EXAMPLE_ROWS.map((row) => Object.assign({}, row)) },
      loan: { amount: '300000', rate: '6', years: '30' },
      breakeven: { fixed: '10000', price: '50', variable: '30' },
    };
  }

  const MAX_RESULT = 1e15;
  const COMMA_HINT = 'Use a period for decimals, for example 6.5';

  function stripAffixes(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^(-?)\$/, '$1')
      .replace(/%$/, '')
      .trim();
  }

  // Commas are only valid as thousands separators: "1,000" and "250,000.50", not "6,5" or "1,5".
  function hasBadComma(value) {
    if (typeof value === 'number') return false;
    const text = stripAffixes(value);
    return text.indexOf(',') !== -1 && !/^-?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(text);
  }

  function numberError(raw) {
    return hasBadComma(raw) ? COMMA_HINT : 'Enter a number.';
  }

  // Accepts what people type: "250,000", "$250,000.50", "6.5%", " 10 ".
  function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (hasBadComma(value)) return NaN;
    const text = stripAffixes(value).replace(/[,\s]/g, '');
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return NaN;
    return Number(text);
  }

  function roundCents(value) {
    const rounded = Math.round(value * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function formatMoney(value) {
    const cents = roundCents(value);
    const text = Math.abs(cents).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return (cents < 0 ? '-$' : '$') + text;
  }

  function formatPercent(value) {
    return roundCents(value).toFixed(2) + '%';
  }

  function formatCount(value) {
    return Math.round(value).toLocaleString('en-US');
  }

  function futureValue(principal, ratePercent, years) {
    if (![principal, ratePercent, years].every(Number.isFinite))
      throw new RangeError('futureValue needs finite numbers');
    return principal * Math.pow(1 + ratePercent / 100, years);
  }

  // Each check returns an error message or '' so the page can show it next to the field.
  function checkAmount(value, maximum, raw) {
    if (!Number.isFinite(value)) return numberError(raw);
    if (value <= 0) return 'Enter an amount above $0.';
    if (value > maximum)
      return 'Use an amount up to ' + formatMoney(maximum).replace('.00', '') + '.';
    return '';
  }

  function checkRate(value, raw) {
    if (!Number.isFinite(value)) return numberError(raw);
    if (value < 0 || value > MAX_RATE) return 'Use a rate from 0 to 100%.';
    return '';
  }

  function checkGrowthYears(value, raw) {
    if (!Number.isFinite(value)) return numberError(raw);
    if (value <= 0 || value > MAX_GROWTH_YEARS) return 'Use more than 0 and up to 100 years.';
    return '';
  }

  function cleanLabel(value, index) {
    const text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, MAX_LABEL);
    return text || 'Holding ' + (index + 1);
  }

  function opportunityCost(input) {
    const source = input || {};
    const baseline = parseNumber(source.baseline);
    const rowsIn = Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS) : [];
    const errors = { baseline: checkRate(baseline, source.baseline), rows: [] };
    let valid = errors.baseline === '' && rowsIn.length > 0;
    const parsed = rowsIn.map((row, index) => {
      const item = row || {};
      const amount = parseNumber(item.amount);
      const rate = parseNumber(item.rate);
      const years = parseNumber(item.years);
      const rowErrors = {
        amount: checkAmount(amount, MAX_AMOUNT, item.amount),
        rate: checkRate(rate, item.rate),
        years: checkGrowthYears(years, item.years),
      };
      if (rowErrors.amount || rowErrors.rate || rowErrors.years) valid = false;
      errors.rows.push(rowErrors);
      return { label: cleanLabel(item.label, index), amount, rate, years };
    });
    if (!valid) return { ok: false, errors };

    // Past about 15 digits a double is mostly noise and prints as exponent text, so refuse instead of showing it.
    const tooLarge = parsed.some(
      (row) =>
        !(futureValue(row.amount, row.rate, row.years) <= MAX_RESULT) ||
        !(futureValue(row.amount, baseline, row.years) <= MAX_RESULT),
    );
    if (tooLarge) {
      parsed.forEach((row, index) => {
        if (
          !(futureValue(row.amount, row.rate, row.years) <= MAX_RESULT) ||
          !(futureValue(row.amount, baseline, row.years) <= MAX_RESULT)
        )
          errors.rows[index].years =
            'This result is too large to show. Use a smaller amount, rate or number of years.';
      });
      return { ok: false, errors };
    }
    const totals = { invested: 0, assetValue: 0, baselineValue: 0, difference: 0, weightedRate: 0 };
    let weighted = 0;
    const rows = parsed.map((row) => {
      const assetValue = futureValue(row.amount, row.rate, row.years);
      const baselineValue = futureValue(row.amount, baseline, row.years);
      const opportunity = baselineValue - assetValue;
      totals.invested += row.amount;
      totals.assetValue += assetValue;
      totals.baselineValue += baselineValue;
      weighted += row.amount * row.rate;
      return Object.assign({}, row, {
        baseline,
        assetValue,
        baselineValue,
        opportunityCost: opportunity,
        gapPercent: baselineValue > 0 ? (opportunity / baselineValue) * 100 : 0,
      });
    });
    totals.difference = totals.baselineValue - totals.assetValue;
    totals.weightedRate = totals.invested > 0 ? weighted / totals.invested : 0;
    return { ok: true, baseline, rows, totals };
  }

  function loanPayment(principal, annualRatePercent, months) {
    if (!(principal > 0) || !(annualRatePercent >= 0) || !(months >= 1))
      throw new RangeError(
        'loanPayment needs a positive amount, a rate of 0 or more, and at least one month',
      );
    const monthly = annualRatePercent / 100 / 12;
    if (monthly === 0) return principal / months;
    // Keep the small positive denominator precise when 1 + monthly rounds to
    // one, or subtracting the discount factor from one loses significant digits.
    return (principal * monthly) / -Math.expm1(-months * Math.log1p(monthly));
  }

  // Keep the ideal fixed-payment balance and distribute display rounding over the schedule.
  function amortize(input) {
    const source = input || {};
    const amount = parseNumber(source.amount);
    const rate = parseNumber(source.rate);
    const years = parseNumber(source.years);
    const errors = {
      amount: checkAmount(amount, MAX_AMOUNT, source.amount),
      rate: checkRate(rate, source.rate),
      years:
        Number.isInteger(years) && years >= 1 && years <= MAX_LOAN_YEARS
          ? ''
          : hasBadComma(source.years)
            ? COMMA_HINT
            : 'Use 1 to 50 whole years.',
    };
    if (errors.amount || errors.rate || errors.years) return { ok: false, errors };

    // The schedule runs in whole cents, so a loan that rounds to no cents, or to a
    // 0-cent payment, has nothing to show; refuse it instead of reporting $0.00.
    const principalCents = Math.round(amount * 100);
    if (principalCents < 1)
      return { ok: false, errors: { amount: 'Enter at least $0.01.', rate: '', years: '' } };
    const months = years * 12;
    const monthly = rate / 100 / 12;
    const principal = principalCents / 100;
    const idealPayment = loanPayment(principal, rate, months);
    const paymentCents = Math.round(idealPayment * 100);
    if (idealPayment < 0.01)
      return {
        ok: false,
        errors: {
          amount: 'This amount is too small to repay over this many years.',
          rate: '',
          years: '',
        },
      };
    let balance = principalCents;
    let idealBalance = principal;
    let idealInterestTotal = 0;
    let interestTotal = 0;
    const schedule = [];
    const logFactor = Math.log1p(monthly);
    const discountDenominator = -Math.expm1(-months * logFactor);
    for (let month = 1; month <= months; month += 1) {
      // Calculating the remaining balance directly avoids amplifying rounding
      // errors on long, high-rate loans. At 0%, the balance is linear.
      const remaining = months - month;
      const nextIdeal =
        monthly === 0
          ? (principal * remaining) / months
          : (principal * -Math.expm1(-remaining * logFactor)) / discountDenominator;
      const nextBalance = Math.round(nextIdeal * 100);
      const principalPart = balance - nextBalance;
      idealInterestTotal += idealBalance * monthly;
      const roundedInterestTotal = Math.round(idealInterestTotal * 100);
      const interest = roundedInterestTotal - interestTotal;
      interestTotal = roundedInterestTotal;
      balance = nextBalance;
      idealBalance = nextIdeal;
      schedule.push({
        month,
        payment: (principalPart + interest) / 100,
        interest: interest / 100,
        principal: principalPart / 100,
        balance: balance / 100,
      });
    }
    const yearly = [];
    for (let index = 0; index < schedule.length; index += 12) {
      const slice = schedule.slice(index, index + 12);
      yearly.push({
        year: index / 12 + 1,
        payment: slice.reduce((sum, row) => sum + Math.round(row.payment * 100), 0) / 100,
        interest: slice.reduce((sum, row) => sum + Math.round(row.interest * 100), 0) / 100,
        principal: slice.reduce((sum, row) => sum + Math.round(row.principal * 100), 0) / 100,
        balance: slice[slice.length - 1].balance,
      });
    }
    return {
      ok: true,
      amount,
      rate,
      years,
      months,
      payment: paymentCents / 100,
      totalInterest: interestTotal / 100,
      totalPaid: (principalCents + interestTotal) / 100,
      schedule,
      yearly,
    };
  }

  function breakEven(input) {
    const source = input || {};
    const fixed = parseNumber(source.fixed);
    const price = parseNumber(source.price);
    const variable = parseNumber(source.variable);
    const errors = {
      fixed: checkAmount(fixed, MAX_AMOUNT, source.fixed),
      price: checkAmount(price, MAX_AMOUNT, source.price),
      variable: !Number.isFinite(variable)
        ? numberError(source.variable)
        : variable < 0
          ? 'Use $0 or more.'
          : '',
    };
    if (!errors.price && !errors.variable && variable >= price)
      errors.variable = 'This has to be lower than the price, or no sale covers its own cost.';
    if (errors.fixed || errors.price || errors.variable) return { ok: false, errors };

    const margin = price - variable;
    const exactUnits = fixed / margin;
    // toFixed trims float noise such as 7.000000000000001 before rounding up.
    const units = Math.ceil(Number(exactUnits.toFixed(6)));
    const table = [];
    [0, 0.5, 1, 1.5, 2].forEach((multiple) => {
      const count = multiple === 1 ? units : Math.round(units * multiple);
      if (table.some((row) => row.units === count)) return;
      table.push({
        units: count,
        revenue: count * price,
        variableCosts: count * variable,
        fixedCosts: fixed,
        profit: count * margin - fixed,
        isBreakEven: count === units,
      });
    });
    return {
      ok: true,
      fixed,
      price,
      variable,
      margin,
      marginRatio: (margin / price) * 100,
      exactUnits,
      exactRevenue: exactUnits * price,
      units,
      revenue: units * price,
      table,
    };
  }

  // Numeric fields never need "_", and dropping it keeps the link separator unambiguous.
  function cleanField(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f_]/g, '')
      .trim()
      .slice(0, MAX_FIELD);
  }

  function encodeState(state) {
    const source = state || defaultState();
    const params = new URLSearchParams();
    params.set('tab', TABS.includes(source.tab) ? source.tab : 'opportunity');
    const opportunity = source.opportunity || {};
    params.set('base', cleanField(opportunity.baseline));
    (Array.isArray(opportunity.rows) ? opportunity.rows.slice(0, MAX_ROWS) : []).forEach((row) => {
      const item = row || {};
      params.append(
        'asset',
        [
          cleanField(item.amount),
          cleanField(item.rate),
          cleanField(item.years),
          String(item.label == null ? '' : item.label).slice(0, MAX_LABEL),
        ].join('_'),
      );
    });
    const loan = source.loan || {};
    params.set('loan', [loan.amount, loan.rate, loan.years].map(cleanField).join('_'));
    const breakeven = source.breakeven || {};
    params.set(
      'breakeven',
      [breakeven.fixed, breakeven.price, breakeven.variable].map(cleanField).join('_'),
    );
    return params.toString();
  }

  // True only for a hash this tool wrote, so an in-page anchor never resets the inputs.
  function isStateHash(hash) {
    return /(?:^#?|&)(?:tab|base|asset|loan|breakeven)=/.test(String(hash || ''));
  }

  function decodeState(hash) {
    const state = defaultState();
    const text = String(hash || '').replace(/^#/, '');
    if (!text || text.length > MAX_HASH || !isStateHash(text)) return state;
    let params;
    try {
      params = new URLSearchParams(text);
    } catch (error) {
      return state;
    }
    if (TABS.includes(params.get('tab'))) state.tab = params.get('tab');
    if (params.has('base')) state.opportunity.baseline = cleanField(params.get('base'));
    const assets = params.getAll('asset').slice(0, MAX_ROWS);
    if (assets.length) {
      state.opportunity.rows = assets.map((entry) => {
        const parts = entry.split('_');
        return {
          label: parts
            .slice(3)
            .join('_')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .slice(0, MAX_LABEL),
          amount: cleanField(parts[0]),
          rate: cleanField(parts[1]),
          years: cleanField(parts[2]),
        };
      });
    }
    const triple = (key, target, names) => {
      if (!params.has(key)) return;
      const parts = params.get(key).split('_');
      names.forEach((name, index) => {
        if (parts[index] !== undefined) target[name] = cleanField(parts[index]);
      });
    };
    triple('loan', state.loan, ['amount', 'rate', 'years']);
    triple('breakeven', state.breakeven, ['fixed', 'price', 'variable']);
    return state;
  }

  // RFC 4180 quoting, plus a leading apostrophe on text that a spreadsheet would run as a formula.
  // Plain numbers such as "-5584.80" stay numbers.
  function csvCell(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    let text = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function toCsv(rows) {
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  const money = (value) => roundCents(value).toFixed(2);

  function csvRows(tab, result) {
    if (!result || !result.ok) return null;
    if (tab === 'opportunity') {
      const rows = [
        [
          'Holding',
          'Amount',
          'Rate (%)',
          'Years',
          'Baseline rate (%)',
          'Grows to',
          'At baseline',
          'Difference',
          'Gap (%)',
        ],
      ];
      result.rows.forEach((row) =>
        rows.push([
          row.label,
          money(row.amount),
          String(row.rate),
          String(row.years),
          String(row.baseline),
          money(row.assetValue),
          money(row.baselineValue),
          money(row.opportunityCost),
          roundCents(row.gapPercent).toFixed(2),
        ]),
      );
      rows.push([
        'Total',
        money(result.totals.invested),
        roundCents(result.totals.weightedRate).toFixed(2),
        '',
        String(result.baseline),
        money(result.totals.assetValue),
        money(result.totals.baselineValue),
        money(result.totals.difference),
        '',
      ]);
      return rows;
    }
    if (tab === 'loan') {
      const rows = [['Payment', 'Amount paid', 'Interest', 'Principal', 'Balance']];
      result.schedule.forEach((row) =>
        rows.push([
          String(row.month),
          money(row.payment),
          money(row.interest),
          money(row.principal),
          money(row.balance),
        ]),
      );
      rows.push([
        'Total',
        money(result.totalPaid),
        money(result.totalInterest),
        money(result.amount),
        '',
      ]);
      return rows;
    }
    if (tab === 'breakeven') {
      const rows = [['Units sold', 'Revenue', 'Variable costs', 'Fixed costs', 'Profit']];
      result.table.forEach((row) =>
        rows.push([
          String(row.units),
          money(row.revenue),
          money(row.variableCosts),
          money(row.fixedCosts),
          money(row.profit),
        ]),
      );
      return rows;
    }
    return null;
  }

  return Object.freeze({
    TABS,
    MAX_ROWS,
    MAX_LABEL,
    EXAMPLE_ROWS,
    defaultState,
    parseNumber,
    roundCents,
    formatMoney,
    formatPercent,
    formatCount,
    futureValue,
    opportunityCost,
    loanPayment,
    amortize,
    breakEven,
    encodeState,
    decodeState,
    isStateHash,
    csvCell,
    toCsv,
    csvRows,
  });
});
