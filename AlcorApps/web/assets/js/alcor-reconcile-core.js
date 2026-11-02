/*!
 * AlcorReconcile core 0.1.0
 * Browser port of the alcor-reconcile 0.1.0 Python core
 * (AlcorProduct/packages/alcor-reconcile/src/alcor_reconcile/core.py and cli.py).
 *
 * Pure module: no DOM, network, storage, timers, or console output. Money is exact
 * decimal arithmetic on BigInt coefficients and exponents (28 significant
 * digits, ROUND_HALF_EVEN, the Python default decimal context). JavaScript
 * floating point never touches an amount or the tolerance.
 *
 * Where Python returns a report or raises ReconcileError, this port returns the
 * same report or the same message. Where Python crashes with an uncaught
 * exception, this port raises RunError: a whole-run error with no report.
 * CSV input follows the 0.2.0 strict reader: malformed quoting, extra cells,
 * blank or duplicate headers, invalid UTF-8 and oversize fields are ReconcileErrors.
 * The web-only byte cap raises RunError.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlcorReconcileCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.1.0';
  const SCHEMA_VERSION = 1;
  const UNICODE_VERSION = '15.1.0';
  const FIELD_LIMIT = 131072;
  const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
  const STATUSES = Object.freeze([
    'matched',
    'amount_mismatch',
    'missing_left',
    'missing_right',
    'duplicate_key',
    'invalid_amount',
    'missing_key',
  ]);
  const SUMMARY_ORDER = Object.freeze([
    'matched',
    'amount_mismatch',
    'invalid_amount',
    'missing_left',
    'missing_right',
    'duplicate_key',
    'missing_key',
  ]);
  const REPORT_FIELDS = Object.freeze([
    'key',
    'status',
    'left_count',
    'right_count',
    'left_amount',
    'right_amount',
    'difference',
    'note',
  ]);
  const DUPLICATE_NOTE = 'duplicate keys are never silently resolved';
  const TOLERANCE_MESSAGE = '--tolerance must be a finite non-negative decimal';

  // Synthetic, public-safe sample data for the "Load sample data" button. Pinned by
  // the ui_sample case in tests/fixtures/alcorreconcile/cases.json (every status).
  const SAMPLE = Object.freeze({
    leftName: 'sample-invoices.csv',
    rightName: 'sample-payments.csv',
    left:
      'invoice_number,customer,invoice_date,amount_due\r\n' +
      'INV-1001,Sample Customer A,2026-01-05,1200.00\r\n' +
      'INV-1002,Sample Customer B,2026-01-07,450.00\r\n' +
      'INV-1003,Sample Customer C,2026-01-09,"2,500.00"\r\n' +
      'INV-1004,Sample Customer D,2026-01-12,89.99\r\n' +
      'INV-1005,Sample Customer E,2026-01-15,300.00\r\n' +
      'INV-1006,Sample Customer F,2026-01-18,75.50\r\n',
    right:
      'payment_id,invoice_ref,paid_on,amount_paid\r\n' +
      'PAY-501,inv-1001,2026-01-20,1200.00\r\n' +
      'PAY-502,INV-1002,2026-01-21,445.00\r\n' +
      'PAY-503,INV-1003,2026-01-22,$2500.00\r\n' +
      'PAY-504,INV-1005,2026-01-25,150.00\r\n' +
      'PAY-505,INV-1005,2026-01-26,150.00\r\n' +
      'PAY-506,INV-1006,2026-01-27,pending\r\n' +
      'PAY-507,INV-1008,2026-01-28,99.00\r\n' +
      'PAY-508,,2026-01-29,40.00\r\n',
    config: Object.freeze({
      left_key: 'invoice_number',
      right_key: 'invoice_ref',
      left_amount: 'amount_due',
      right_amount: 'amount_paid',
      tolerance: '0.00',
      case_sensitive: false,
    }),
  });

  // Generated from Python unicodedata 15.1.0 (Python 3.13). tests/validate_alcorreconcile.py
  // regenerates these strings and compares them whenever it runs on that Unicode version.
  const CASEFOLD_DATA =
    'r1t.q.1.w r51.1.1.lj r5c.n.1.w r60.7.1.w m67.37.37 r74.o.2.1 m8g.2x.lj r8i.3.2.1 r8p.8.2.1 m95.jg.32 r96.n.2.1 rag.1.1.-3d rah.3.2.1 ran.1.1.-7g rap.1.1.5u raq.2.2.1 rau.1.1.5q rav.1.1.1 rax.2.1.5p raz.1.1.1 rb2.1.1.27 rb3.1.1.5m rb4.1.1.5n rb5.1.1.1 rb7.1.1.5p rb8.1.1.5r rba.1.1.5v rbb.1.1.5t rbc.1.1.1 rbg.1.1.5v rbh.1.1.5x rbj.1.1.5y rbk.3.2.1 rbq.1.1.62 rbr.1.1.1 rbt.1.1.62 rbw.1.1.1 rby.1.1.62 rbz.1.1.1 rc1.2.1.61 rc3.2.2.1 rc7.1.1.63 rc8.1.1.1 rcc.1.1.1 rck.1.1.2 rcl.1.1.1 rcn.1.1.2 rco.1.1.1 rcq.1.1.2 rcr.9.2.1 rda.9.2.1 mds.2y.lo rdt.1.1.2 rdu.2.2.1 rdy.1.1.-2p rdz.1.1.-1k re0.k.2.1 rf4.1.1.-3m rf6.9.2.1 rfu.1.1.8bv rfv.1.1.1 rfx.1.1.-4j rfy.1.1.8bs rg1.1.1.1 rg3.1.1.-5f rg4.1.1.1x rg5.1.1.1z rg6.5.2.1 rn9.1.1.38 rog.2.2.1 rom.1.1.1 rov.1.1.38 rp2.1.1.12 rp4.3.1.11 rp8.1.1.1s rpa.2.1.1r mpc.qh.lk.ld rpd.h.1.w rpv.9.1.w mq8.qt.lk.ld rqq.1.1.1 rr3.1.1.8 rr4.1.1.-u rr5.1.1.-p rr9.1.1.-f rra.1.1.-m rrc.c.2.1 rs0.1.1.-1i rs1.1.1.-1c rs4.1.1.-1o rs5.1.1.-1s rs7.1.1.1 rs9.1.1.-7 rsa.1.1.1 rsd.3.1.-3m rsg.g.1.28 rsw.w.1.w rv4.h.2.1 rwa.r.2.1 rxs.1.1.f rxt.7.2.1 ry8.1c.2.1 r10x.12.1.1c m13b.12d.136 r3a8.12.1.5ls r3bb.1.1.5ls r3bh.1.1.5ls r3y0.6.1.-8 r5mo.1.1.-4su r5mp.1.1.-4st r5mq.1.1.-4sk r5mr.2.1.-4si r5mt.1.1.-4sj r5mu.1.1.-4sc r5mv.1.1.-4ro r5mw.1.1.r7n r5n4.17.1.-2bk r5od.3.1.-2bk r5xc.23.2.1 m61i.2w.mp m61j.38.lk m61k.3b.lm m61l.3d.lm m61m.2p.ji r61n.1.1.-1m m61q.37.37 r61s.1c.2.1 r64o.8.1.-8 r654.6.1.-8 r65k.8.1.-8 r660.8.1.-8 r66g.6.1.-8 m66o.qt.lv m66q.qt.lv.lc m66s.qt.lv.ld m66u.qt.lv.n6 r66x.4.2.-8 r67c.8.1.-8 m680.64g.qh m681.64h.qh m682.64i.qh m683.64j.qh m684.64k.qh m685.64l.qh m686.64m.qh m687.64n.qh m688.64g.qh m689.64h.qh m68a.64i.qh m68b.64j.qh m68c.64k.qh m68d.64l.qh m68e.64m.qh m68f.64n.qh m68g.65c.qh m68h.65d.qh m68i.65e.qh m68j.65f.qh m68k.65g.qh m68l.65h.qh m68m.65i.qh m68n.65j.qh m68o.65c.qh m68p.65d.qh m68q.65e.qh m68r.65f.qh m68s.65g.qh m68t.65h.qh m68u.65i.qh m68v.65j.qh m68w.674.qh m68x.675.qh m68y.676.qh m68z.677.qh m690.678.qh m691.679.qh m692.67a.qh m693.67b.qh m694.674.qh m695.675.qh m696.676.qh m697.677.qh m698.678.qh m699.679.qh m69a.67a.qh m69b.67b.qh m69e.67k.qh m69f.q9.qh m69g.q4.qh m69i.q9.n6 m69j.q9.n6.qh r69k.2.1.-8 r69m.2.1.-22 m69o.q9.qh r69q.1.1.-5j9 m69u.67o.qh m69v.qf.qh m69w.q6.qh m69y.qf.n6 m69z.qf.n6.qh r6a0.4.1.-2e m6a4.qf.qh m6aa.qh.lk.lc m6ab.qh.lk.ld m6ae.qh.n6 m6af.qh.lk.n6 r6ag.2.1.-8 r6ai.2.1.-2s m6aq.qt.lk.lc m6ar.qt.lk.ld m6as.qp.lv m6au.qt.n6 m6av.qt.lk.n6 r6aw.2.1.-8 r6ay.2.1.-34 r6b0.1.1.-7 m6b6.67w.qh m6b7.qx.qh m6b8.r2.qh m6ba.qx.n6 m6bb.qx.n6.qh r6bc.2.1.-3k r6be.2.1.-3i m6bg.qx.qh r6jq.1.1.-5st r6ju.1.1.-6gv r6jv.1.1.-6di r6k2.1.1.s r6lc.g.1.g r6mb.1.1.1 r792.q.1.q r8ow.1c.1.1c r8rk.1.1.1 r8rm.1.1.-8af r8rn.1.1.-2xy r8ro.1.1.-89z r8rr.3.2.1 r8rx.1.1.-8bg r8ry.1.1.-8al r8rz.1.1.-8bj r8s0.1.1.-8bi r8s2.1.1.1 r8s5.1.1.1 r8se.2.1.-8cf r8sg.1e.2.1 r8vf.2.2.1 r8vm.1.1.1 rwu8.n.2.1 rww0.e.2.1 rx0i.7.2.1 rx0y.v.2.1 rx2x.2.2.1 rx31.1.1.-r9g rx32.5.2.1 rx3f.1.1.1 rx3h.1.1.-wmg rx3k.2.2.1 rx3q.a.2.1 rx4a.1.1.-wn8 rx4b.1.1.-wnj rx4c.1.1.-wnf rx4d.1.1.-wn5 rx4e.1.1.-wn8 rx4g.1.1.-wlu rx4h.1.1.-wmi rx4i.1.1.-wlx rx4j.1.1.ps rx4k.8.2.1 rx50.1.1.-1c rx51.1.1.-wn7 rx52.1.1.-raw rx53.2.2.1 rx5c.1.1.1 rx5i.2.2.1 rx6d.1.1.1 rxv4.28.1.-tzk m1dkw.2u.2u m1dkx.2u.2x m1dky.2u.30 m1dkz.2u.2u.2x m1dl0.2u.2u.30 m1dl1.37.38 m1dl2.37.38 m1dlf.12s.12u m1dlg.12s.12d m1dlh.12s.12j m1dli.132.12u m1dlj.12s.12l r1ee9.q.1.w r1fcw.14.1.14 r1fhs.10.1.14 r1fn4.b.1.13 r1fng.f.1.13 r1fnw.7.1.13 r1fo4.2.1.13 r1h1c.1f.1.1s r1jfk.w.1.w r20cg.w.1.w r2olc.y.1.y';
  const DIGIT_ZERO_DATA =
    '1c 19c 1dc 1j4 1uu 1ye 21y 25i 292 2cm 2g6 2jq 2na 2qu 2ts 2xc 2zk 37k 39s 4ps 4r4 4zq 53k 58g 58w 5e8 5gw 5kw 5lc wtc xcg xds xjk xkg xn4 xyo 1eds 1fhc 1h68 1ht2 1hww 1hyu 1i34 1ib4 1ikw 1iog 1iz4 1j28 1j5c 1jhc 1jkg 1k5s 1kcw 1kf4 1kr4 1zkw 1znk 1zrk 2l72 2l7c 2l7m 2l7w 2l86 2n28 2ne8 2nsg 2onk 2sc0';
  const NONPRINTABLE_DATA =
    '0.v 2n.x c.0 ju.1 6.3 7.0 1.0 k.0 b1.0 12.1 1e.1 3.0 1j.7 r.3 6.g m.0 5c.0 1c.1 1n.1 2t.d 1n.1 1d.1 f.0 s.1 1.0 b.4 v.8 22.0 4h.0 8.1 2.1 m.0 7.0 1.2 4.1 9.1 2.1 4.7 1.3 2.0 5.1 p.1 3.0 6.3 2.1 m.0 7.0 2.0 2.0 2.1 1.0 5.3 2.1 3.2 1.6 4.0 1.6 h.9 3.0 9.0 3.0 m.0 7.0 2.0 5.1 a.0 3.0 3.1 1.e 4.1 c.6 7.0 3.0 8.1 2.1 m.0 7.0 2.0 5.1 9.1 2.1 3.6 3.3 2.0 5.1 i.9 2.0 6.2 3.0 4.2 2.0 1.0 2.2 2.2 3.2 c.3 5.2 3.0 4.1 1.5 1.d l.4 d.0 3.0 n.0 g.1 9.0 3.0 4.6 2.0 3.1 1.1 4.1 a.6 m.0 3.0 n.0 a.0 5.1 9.0 3.0 4.6 2.5 2.0 4.1 a.0 3.b d.0 3.0 1f.0 3.0 6.3 g.1 q.0 3.0 i.2 o.0 9.0 1.1 7.2 1.3 6.0 1.0 8.5 a.1 3.b 1m.3 t.10 2.0 1.0 5.0 o.0 1.0 n.1 5.0 1.0 7.0 a.1 4.v 20.0 10.3 13.0 10.0 f.0 d.10 5i.0 1.4 1.1 ah.0 4.1 7.0 1.0 4.1 15.0 4.1 x.0 4.1 7.0 1.0 4.1 f.0 1l.0 4.1 1v.1 w.2 q.5 2e.1 6.1 hs.0 s.2 2h.6 m.8 o.8 k.b d.0 3.0 2.b 2m.1 a.5 a.5 e.0 b.5 2h.6 17.4 1y.9 v.0 c.3 c.3 1.2 16.1 5.a 18.3 q.5 b.2 1q.1 1t.0 t.1 b.5 a.5 e.1 v.1c 25.2 1b.0 38.7 1o.2 f.2 1o.6 17.1 b.7 17.4 eu.1 6.1 12.1 6.1 8.0 1.0 1.0 1.0 v.1 1h.0 f.0 e.1 6.0 j.1 3.0 9.g o.7 1b.g 2.1 r.0 d.2 x.e x.e 3w.3 if.o b.k 1ec.1 w.0 9p.4 19.0 1.4 1.1 1k.6 2.d o.8 7.0 7.0 7.0 7.0 7.0 7.0 7.0 7.0 3i.x q.0 2h.b 5y.p g.0 1r.0 2e.1 2v.4 17.0 2m.0 2c.a 1c.0 mlp.2 1j.8 9o.j 54.7 5n.4 2.0 1.0 5.n 1n.2 a.5 1k.7 1y.7 c.5 38.a u.2 26.0 b.3 x.0 1j.8 e.1 a.1 2v.n s.9 6.1 6.1 6.8 7.0 7.0 1o.3 3i.1 a.5 8mc.b n.3 1d.6ir a6.1 2y.11 7.b 5.4 q.0 5.0 1.0 2.0 2.0 3h.f cd.1 1i.6 1.v 16.5 1f.0 j.0 4.3 5.0 3r.3 5a.2 6.1 6.1 6.1 3.2 7.0 7.c 2.1 c.0 q.0 j.0 2.0 f.1 e.x 3f.4 3.3 19.2 2g.0 d.2 1.1a 1a.3l t.2 1d.e s.3 10.8 u.4 17.4 u.0 11.3 e.15 4e.1 a.5 10.3 10.3 14.7 1g.a c.0 f.0 7.0 2.0 b.0 f.0 7.0 2.1u 8n.8 m.9 8.n 6.0 16.0 9.1w 6.1 1.0 18.0 2.2 1.1 n.0 20.7 9.1b j.0 2.4 x.2 r.4 1.1r 1k.3 k.1 1e.0 2.4 8.0 3.0 t.1 3.3 a.6 9.6 1s.v 13.3 c.8 1i.2 t.1 r.4 q.6 4.b 7.27 21.1i 1f.c 1f.6 1a.7 a.85 v.0 16.0 3.1 2.22 17.7 16.l q.11 s.j n.8 26.3 10.8 1q.0 5.c p.6 a.5 1h.0 i.7 13.8 2o.0 k.a i.0 1b.1p 7.0 1.0 4.0 f.0 b.5 1n.4 a.5 4.0 8.1 2.1 m.0 7.0 2.0 5.0 a.1 2.1 3.1 1.5 1.4 7.1 7.2 5.3u 2k.0 5.t 20.7 a.4l 1i.1 12.x 1x.a a.5 d.i 1m.5 a.1h r.1 f.3 n.54 1o.2r 2b.b 8.1 1.1 8.0 2.0 u.0 2.1 c.8 a.1x 8.1 1a.1 b.q 20.7 2b.c 21.6 a.6t 9.0 19.0 e.9 t.2 w.1 m.0 e.20 7.0 2.0 18.2 1.0 2.0 9.7 a.5 6.0 2.0 11.0 2.0 6.6 a.8l p.6 h.0 15.2 s.2d 1.e 1e.c pn.2t 33.0 5.a 5g.217 2r.c ts.f m.33d g7.6ns ft.6 v.0 a.3 29.0 a.5 u.1 6.9 1y.9 a.0 7.0 l.4 j.j3 2j.2s 23.3 1l.6 h.1r 5.a 2.d 4qg.7 ye.15 9.6w6 4.0 7.0 2.0 83.e 1.s 3.1 1.d 4.7 b0.1s3 2z.4 d.2 9.6 a.1 4.3mn 1a.1 n.8 38.1n 6u.9 13.1 22.7 34.k 1y.3d k.b k.b 2f.8 p.3q 2d.0 1z.0 2.1 1.1 2.1 4.0 c.0 1.0 7.0 1t.0 4.1 8.0 7.0 s.0 4.0 5.0 1.2 7.0 9g.1 84.1 ji.e 5.0 f.un v.5 6.5w 7.0 h.1 7.0 2.0 5.4 1q.w 1.33 19.2 e.1 a.3 2.8v v.g 1m.4 1.cv 16.kl 7.0 4.0 2.0 f.0 5h.1 g.14 24.3 a.3 2.ls 1w.23 1p.5d 4.0 r.0 2.0 1.1 1.0 a.0 4.0 1.0 1.5 1.3 1.0 1.0 1.0 3.0 2.0 1.1 1.0 1.0 1.0 1.0 1.0 2.0 1.1 4.0 7.0 4.0 4.0 1.0 a.0 h.4 3.0 5.0 h.1f 2.7h 18.3 2s.b f.1 f.0 f.0 11.9 4u.1j t.c 18.3 9.6 2.d 6.49 rc.3 h.2 d.2 3b.3 2n.5 c.3 1.e c.3 1k.7 a.5 14.7 u.1 2.25 9g.b e.1 d.2 9.6 1a.0 7.7 e.3 9.6 9.6 43.0 1j.10 a.sl wyo.v 37e.5 66.1 4g2.d 5rl.e ha.1wh f2.15t 3t7.4 38g.f9e7 6o.47bj';

  // Python str.isspace(): U+0009-000D, 001C-001F, 0020, 0085, 00A0, 1680, 2000-200A,
  // 2028, 2029, 202F, 205F, 3000. JavaScript \s differs (adds U+FEFF, lacks 001C-001F, 0085).
  const WS =
    '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const WS_EDGES = new RegExp('^[' + WS + ']+|[' + WS + ']+$', 'g');
  const WS_RUNS = new RegExp('[' + WS + ']+', 'g');
  const WS_ONE = new RegExp('^[' + WS + ']$');
  const CURRENCY = new RegExp('[$\\u20ac\\u00a3\\u00a5,' + WS + ']', 'g');

  class ReconcileError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ReconcileError';
      this.code = code || 'reconcile';
    }
  }

  class RunError extends Error {
    constructor(message, code, pythonException) {
      super(message);
      this.name = 'RunError';
      this.code = code;
      this.pythonException = pythonException || null;
    }
  }

  function fromB36(text) {
    return parseInt(text, 36);
  }

  const CASEFOLD = (function () {
    const map = new Map();
    for (const token of CASEFOLD_DATA.split(' ')) {
      const parts = token.slice(1).split('.').map(fromB36);
      if (token[0] === 'm') {
        map.set(parts[0], String.fromCodePoint.apply(null, parts.slice(1)));
      } else {
        for (let i = 0; i < parts[1]; i += 1) {
          const cp = parts[0] + i * parts[2];
          map.set(cp, String.fromCodePoint(cp + parts[3]));
        }
      }
    }
    return map;
  })();

  const DIGIT_ZEROS = Object.freeze(DIGIT_ZERO_DATA.split(' ').map(fromB36));

  const NONPRINTABLE = (function () {
    const starts = [];
    const ends = [];
    let previous = -1;
    for (const token of NONPRINTABLE_DATA.split(' ')) {
      const parts = token.split('.').map(fromB36);
      const start = previous + 1 + parts[0];
      previous = start + parts[1];
      starts.push(start);
      ends.push(previous);
    }
    return { starts, ends };
  })();

  function isPrintable(cp) {
    const { starts, ends } = NONPRINTABLE;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < starts[mid]) hi = mid - 1;
      else if (cp > ends[mid]) lo = mid + 1;
      else return false;
    }
    return true;
  }

  function decimalDigitValue(cp) {
    if (cp >= 48 && cp <= 57) return cp - 48;
    let lo = 0;
    let hi = DIGIT_ZEROS.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (DIGIT_ZEROS[mid] <= cp) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return -1;
    const value = cp - DIGIT_ZEROS[found];
    return value <= 9 ? value : -1;
  }

  function isPyWhitespace(cp) {
    return cp <= 0xffff && WS_ONE.test(String.fromCharCode(cp));
  }

  function pyStrip(text) {
    return text.replace(WS_EDGES, '');
  }

  function casefold(text) {
    let out = '';
    for (const ch of text) {
      const mapped = CASEFOLD.get(ch.codePointAt(0));
      out += mapped === undefined ? ch : mapped;
    }
    return out;
  }

  function hex(cp, width) {
    return cp.toString(16).padStart(width, '0');
  }

  /** Python repr() of a str. */
  function pyRepr(text) {
    const value = String(text);
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of value) {
      const cp = ch.codePointAt(0);
      if (ch === quote || ch === '\\') out += '\\' + ch;
      else if (ch === '\t') out += '\\t';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2);
      else if (cp < 0x7f || isPrintable(cp)) out += ch;
      else if (cp <= 0xff) out += '\\x' + hex(cp, 2);
      else if (cp <= 0xffff) out += '\\u' + hex(cp, 4);
      else out += '\\U' + hex(cp, 8);
    }
    return out + quote;
  }

  /** Python str ordering: compare by code point, not UTF-16 unit. */
  function compareCodePoints(a, b) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      let x = a.charCodeAt(i);
      let y = b.charCodeAt(i);
      if (x === y) continue;
      if (x >= 0xd800 && y >= 0xd800) {
        x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
        y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
      }
      return x < y ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  // ---------------------------------------------------------------------------
  // Decimal: {kind: 'finite'|'inf'|'nan'|'snan', sign: 0|1, coef: BigInt, exp: BigInt}
  // ---------------------------------------------------------------------------
  const PREC = 28n;
  const EMAX = 999999n;
  const EMIN = -999999n;
  const ETINY = EMIN - PREC + 1n;
  // libmpdec maximum context used by the exact Decimal(str) constructor.
  const MAX_EMAX = 999999999999999999n;
  const MAX_ETINY = -999999999999999999n - (999999999999999999n - 1n);
  const TEN_TO_PREC = 10n ** PREC;

  const POW10 = [];
  function pow10(n) {
    if (n < 64n) {
      const i = Number(n);
      if (POW10[i] === undefined) POW10[i] = 10n ** n;
      return POW10[i];
    }
    return 10n ** n;
  }

  function digitCount(coef) {
    return BigInt(coef === 0n ? 1 : coef.toString().length);
  }
  function adjusted(value) {
    return value.exp + digitCount(value.coef) - 1n;
  }
  function finite(sign, coef, exp) {
    return Object.freeze({ kind: 'finite', sign, coef, exp });
  }
  function special(kind, sign, coef) {
    return Object.freeze({ kind, sign, coef: coef || 0n, exp: 0n });
  }

  function overflow() {
    return new RunError(
      'an amount calculation exceeded the decimal range Python supports',
      'decimal_overflow',
      'decimal.Overflow',
    );
  }
  function invalidOperation(detail) {
    return new RunError(detail, 'decimal_invalid_operation', 'decimal.InvalidOperation');
  }

  function roundHalfEven(coef, shift) {
    if (shift <= 0n) return coef;
    const digits = digitCount(coef);
    if (shift > digits) return 0n;
    const divisor = pow10(shift);
    const quotient = coef / divisor;
    const twice = (coef % divisor) * 2n;
    if (twice > divisor || (twice === divisor && (quotient & 1n) === 1n)) return quotient + 1n;
    return quotient;
  }

  /** Apply the default context (prec 28, HALF_EVEN, Emax 999999, Emin -999999, clamp 0). */
  function finalize(sign, coef, exp) {
    if (coef === 0n) {
      if (exp > EMAX) exp = EMAX;
      if (exp < ETINY) exp = ETINY;
      return finite(sign, 0n, exp);
    }
    const digits = digitCount(coef);
    const adj = exp + digits - 1n;
    if (adj > EMAX) throw overflow();
    if (adj < EMIN) {
      if (exp < ETINY) {
        coef = roundHalfEven(coef, ETINY - exp);
        exp = ETINY;
      }
      return finite(sign, coef, exp);
    }
    if (digits > PREC) {
      const shift = digits - PREC;
      coef = roundHalfEven(coef, shift);
      exp += shift;
      if (coef === TEN_TO_PREC) {
        coef /= 10n;
        exp += 1n;
      }
      if (exp + PREC - 1n > EMAX) throw overflow();
    }
    return finite(sign, coef, exp);
  }

  function fixNaN(value) {
    let coef = value.coef;
    if (digitCount(coef) > PREC) coef %= TEN_TO_PREC;
    return special('nan', value.sign, coef);
  }

  /** Exact Decimal(str) constructor semantics; returns null where Python raises InvalidOperation. */
  function parseDecimal(text) {
    const stripped = pyStrip(String(text));
    let ascii = '';
    for (const ch of stripped) {
      const cp = ch.codePointAt(0);
      if (cp === 0x5f) continue;
      if (cp > 0 && cp <= 127) {
        ascii += ch;
        continue;
      }
      if (isPyWhitespace(cp)) {
        ascii += ' ';
        continue;
      }
      const digit = decimalDigitValue(cp);
      if (digit < 0) return null;
      ascii += String(digit);
    }
    let match = /^([+-]?)(inf|infinity)$/i.exec(ascii);
    if (match) return special('inf', match[1] === '-' ? 1 : 0);
    match = /^([+-]?)(s?)nan([0-9]*)$/i.exec(ascii);
    if (match)
      return special(
        match[2] ? 'snan' : 'nan',
        match[1] === '-' ? 1 : 0,
        match[3] ? BigInt(match[3]) : 0n,
      );
    match = /^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/.exec(ascii);
    if (!match) return null;
    const whole = match[2] !== undefined ? match[2] : '';
    const fraction = match[2] !== undefined ? match[3] || '' : match[4];
    const coef = BigInt(whole + fraction);
    const exp = (match[5] ? BigInt(match[5]) : 0n) - BigInt(fraction.length);
    const sign = match[1] === '-' ? 1 : 0;
    if (coef === 0n) {
      if (exp > MAX_EMAX || exp < MAX_ETINY) return null;
    } else if (exp + digitCount(coef) - 1n > MAX_EMAX || exp < MAX_ETINY) {
      return null;
    }
    return finite(sign, coef, exp);
  }

  function negate(value) {
    if (value.kind === 'snan') throw invalidOperation('a signaling NaN amount cannot be negated');
    if (value.kind === 'nan') return fixNaN(value);
    if (value.kind === 'inf') return special('inf', value.sign ? 0 : 1);
    if (value.coef === 0n) return finalize(0, 0n, value.exp);
    return finalize(value.sign ? 0 : 1, value.coef, value.exp);
  }

  function addZero(x, zeroExp) {
    if (zeroExp >= x.exp) return finalize(x.sign, x.coef, x.exp);
    const adj = adjusted(x);
    let target = adj - PREC + 1n;
    if (zeroExp > target) target = zeroExp;
    if (ETINY > target) target = ETINY;
    if (target < x.exp) return finalize(x.sign, x.coef * pow10(x.exp - target), target);
    return finalize(x.sign, x.coef, x.exp);
  }

  function addFinite(x, y) {
    if (x.coef === 0n && y.coef === 0n) {
      return finalize(x.sign && y.sign ? 1 : 0, 0n, x.exp < y.exp ? x.exp : y.exp);
    }
    if (y.coef === 0n) return addZero(x, y.exp);
    if (x.coef === 0n) return addZero(y, x.exp);
    let hi = x;
    let lo = y;
    if (lo.exp > hi.exp) {
      hi = y;
      lo = x;
    }
    // Sticky reduction: when lo lies wholly below every digit that can survive
    // rounding (and below hi's own last digit), any nonzero value there rounds
    // identically, so replace it instead of computing 10 ** (exponent gap).
    const hiAdj = adjusted(hi);
    let kept = hiAdj - PREC;
    if (ETINY > kept) kept = ETINY;
    let limit = kept - 2n;
    if (hi.exp < limit) limit = hi.exp;
    if (adjusted(lo) < limit) lo = finite(lo.sign, 1n, limit - 1n);
    const exp = hi.exp < lo.exp ? hi.exp : lo.exp;
    const a = hi.coef * pow10(hi.exp - exp) * (hi.sign ? -1n : 1n);
    const b = lo.coef * pow10(lo.exp - exp) * (lo.sign ? -1n : 1n);
    const sum = a + b;
    if (sum === 0n) return finalize(0, 0n, exp);
    return sum < 0n ? finalize(1, -sum, exp) : finalize(0, sum, exp);
  }

  /** left - right under the default context. */
  function subtract(a, b) {
    if (a.kind === 'snan' || b.kind === 'snan')
      throw invalidOperation('a signaling NaN amount cannot be compared');
    if (a.kind === 'nan') return fixNaN(a);
    if (b.kind === 'nan') return fixNaN(b);
    if (a.kind === 'inf') {
      if (b.kind === 'inf' && a.sign === b.sign)
        throw invalidOperation('Infinity minus Infinity is undefined');
      return a;
    }
    if (b.kind === 'inf') return special('inf', b.sign ? 0 : 1);
    return addFinite(a, finite(b.sign ? 0 : 1, b.coef, b.exp));
  }

  function absolute(value) {
    if (value.kind === 'snan') throw invalidOperation('a signaling NaN amount cannot be compared');
    if (value.kind === 'nan') return fixNaN(value);
    if (value.kind === 'inf') return special('inf', 0);
    return finalize(0, value.coef, value.exp);
  }

  /** Numeric ordering; NaN raises like Python's ordering comparisons. */
  function compare(a, b) {
    if (a.kind === 'nan' || a.kind === 'snan' || b.kind === 'nan' || b.kind === 'snan') {
      throw invalidOperation('a NaN amount cannot be compared with the tolerance');
    }
    const signOf = (v) => (v.kind === 'finite' && v.coef === 0n ? 0 : v.sign ? -1 : 1);
    const sa = signOf(a);
    const sb = signOf(b);
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (sa === 0) return 0;
    let magnitude;
    if (a.kind === 'inf' || b.kind === 'inf') {
      magnitude = a.kind === b.kind ? 0 : a.kind === 'inf' ? 1 : -1;
    } else {
      const adjA = adjusted(a);
      const adjB = adjusted(b);
      if (adjA !== adjB) magnitude = adjA > adjB ? 1 : -1;
      else {
        const exp = a.exp < b.exp ? a.exp : b.exp;
        const x = a.coef * pow10(a.exp - exp);
        const y = b.coef * pow10(b.exp - exp);
        magnitude = x === y ? 0 : x > y ? 1 : -1;
      }
    }
    return sa * magnitude;
  }

  /** Python Decimal.__str__ (to-scientific-string, capitals=1). */
  function decimalToString(value) {
    const sign = value.sign ? '-' : '';
    if (value.kind === 'inf') return sign + 'Infinity';
    if (value.kind === 'nan' || value.kind === 'snan') {
      return (
        sign +
        (value.kind === 'snan' ? 'sNaN' : 'NaN') +
        (value.coef === 0n ? '' : value.coef.toString())
      );
    }
    const digits = value.coef.toString();
    const exp = value.exp;
    const adj = exp + BigInt(digits.length) - 1n;
    if (exp <= 0n && adj >= -6n) {
      if (exp === 0n) return sign + digits;
      const point = digits.length + Number(exp);
      if (point > 0) return sign + digits.slice(0, point) + '.' + digits.slice(point);
      return sign + '0.' + '0'.repeat(-point) + digits;
    }
    const mantissa = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    return sign + mantissa + 'E' + (adj >= 0n ? '+' : '-') + (adj < 0n ? -adj : adj).toString();
  }

  /** core.parse_amount. */
  function parseAmount(value) {
    const original = value || '';
    let raw = pyStrip(original);
    if (!raw) throw new ReconcileError('amount is empty', 'amount');
    const negative = raw.startsWith('(') && raw.endsWith(')');
    if (negative) raw = raw.slice(1, -1);
    const amount = parseDecimal(raw.replace(CURRENCY, ''));
    // 0.2.0 finite-value rule: NaN, sNaN and Infinity are invalid amounts, never compared.
    if (amount === null || amount.kind !== 'finite')
      throw new ReconcileError('invalid amount: ' + pyRepr(original), 'amount');
    return negative ? negate(amount) : amount;
  }

  /** cli.py tolerance handling: Decimal(text), then reject non-finite values and negatives. */
  function parseTolerance(text) {
    const value = parseDecimal(text === undefined || text === null ? '0.00' : text);
    if (value === null || value.kind !== 'finite')
      throw new ReconcileError(TOLERANCE_MESSAGE, 'tolerance');
    if (value.sign && !(value.kind === 'finite' && value.coef === 0n))
      throw new ReconcileError(TOLERANCE_MESSAGE, 'tolerance');
    return value;
  }

  /** core.normalize_key. */
  function normalizeKey(value, caseSensitive) {
    const normalized = pyStrip(value || '').replace(WS_RUNS, ' ');
    return caseSensitive ? normalized : casefold(normalized);
  }

  // ---------------------------------------------------------------------------
  // Input: UTF-8 (utf-8-sig) decoding and the csv module's excel dialect.
  // ---------------------------------------------------------------------------
  function byteLength(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes.byteLength;
    return bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0;
  }

  function decodeUtf8(bytes, name) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ReconcileError(`${name}: CSV is not valid UTF-8`, 'invalid_utf8');
    }
  }

  const START_RECORD = 0;
  const START_FIELD = 1;
  const IN_FIELD = 2;
  const IN_QUOTED_FIELD = 3;
  const QUOTE_IN_QUOTED_FIELD = 4;
  const EAT_CRNL = 5;

  /**
   * csv.reader(excel dialect) over a file opened with newline=''. With strict (the 0.2.0
   * reader), a malformed record stops the scan and comes back as `error` after the
   * complete records before it, so readTable raises it in Python's order.
   */
  function scanCsv(text, name, strict) {
    const records = [];
    let fields = [];
    let field = '';
    let fieldLength = 0;
    let state = START_RECORD;
    const label = name || 'CSV';

    function save() {
      fields.push(field);
      field = '';
      fieldLength = 0;
    }
    function add(ch, lowSurrogate) {
      if (!lowSurrogate) {
        if (fieldLength >= FIELD_LIMIT) {
          if (strict) throw malformed(`field larger than field limit (${FIELD_LIMIT})`);
          throw new RunError(
            `${label}: a CSV field is longer than ${FIELD_LIMIT} characters`,
            'field_limit',
            'csv.Error',
          );
        }
        fieldLength += 1;
      }
      field += ch;
    }
    function malformed(detail) {
      return new ReconcileError(`${label}: malformed CSV: ${detail}`, 'malformed_csv');
    }
    function endOfLine() {
      switch (state) {
        case START_RECORD:
          break;
        case START_FIELD:
        case IN_FIELD:
        case QUOTE_IN_QUOTED_FIELD:
          save();
          state = START_RECORD;
          break;
        case IN_QUOTED_FIELD:
          return;
        case EAT_CRNL:
          state = START_RECORD;
          break;
        default:
          break;
      }
      records.push(fields);
      fields = [];
    }

    const length = text.length;
    try {
      for (let i = 0; i < length; i += 1) {
        const ch = text[i];
        const code = text.charCodeAt(i);
        const newline = ch === '\n' || ch === '\r';
        const low =
          code >= 0xdc00 &&
          code <= 0xdfff &&
          i > 0 &&
          text.charCodeAt(i - 1) >= 0xd800 &&
          text.charCodeAt(i - 1) <= 0xdbff;
        switch (state) {
          case START_RECORD:
            if (newline) {
              state = EAT_CRNL;
              break;
            }
            state = START_FIELD;
          // falls through
          case START_FIELD:
            if (newline) {
              save();
              state = EAT_CRNL;
            } else if (ch === '"') state = IN_QUOTED_FIELD;
            else if (ch === ',') save();
            else {
              add(ch, low);
              state = IN_FIELD;
            }
            break;
          case IN_FIELD:
            if (newline) {
              save();
              state = EAT_CRNL;
            } else if (ch === ',') {
              save();
              state = START_FIELD;
            } else add(ch, low);
            break;
          case IN_QUOTED_FIELD:
            if (ch === '"') state = QUOTE_IN_QUOTED_FIELD;
            else add(ch, low);
            break;
          case QUOTE_IN_QUOTED_FIELD:
            if (ch === '"') {
              add(ch, false);
              state = IN_QUOTED_FIELD;
            } else if (ch === ',') {
              save();
              state = START_FIELD;
            } else if (newline) {
              save();
              state = EAT_CRNL;
            } else if (strict) throw malformed(`',' expected after '"'`);
            else {
              add(ch, low);
              state = IN_FIELD;
            }
            break;
          case EAT_CRNL:
            // Unreachable: with newline='' a line always ends at \n, \r\n, or a lone \r.
            break;
          default:
            break;
        }
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) endOfLine();
      }
      if (length > 0 && text[length - 1] !== '\n' && text[length - 1] !== '\r') endOfLine();
      if (state === IN_QUOTED_FIELD) {
        if (strict) throw malformed('unexpected end of data');
        save();
        records.push(fields);
      }
    } catch (error) {
      if (!(strict && error instanceof ReconcileError)) throw error;
      return { records, error };
    }
    return { records, error: null };
  }

  /** The lenient csv.reader the 0.1.0 core used. Returns records. */
  function parseCsv(text, name) {
    return scanCsv(text, name, false).records;
  }

  /** csv.DictReader(strict=True) + core._read_csv 0.2.0: header plus data records, blank records skipped. */
  function readTable(text, name) {
    const { records, error } = scanCsv(text, name, true);
    if (records.length === 0)
      throw error || new ReconcileError(`${name}: CSV has no header`, 'no_header');
    const fields = records[0].map(String);
    if (fields.some((field) => !field))
      throw new ReconcileError(`${name}: CSV contains a blank header`, 'blank_header');
    const duplicates = duplicateHeaders(fields).sort(compareCodePoints);
    if (duplicates.length)
      throw new ReconcileError(
        `${name}: duplicate header(s): ${duplicates.join(', ')}`,
        'duplicate_header',
      );
    const lastIndex = new Map();
    fields.forEach((field, index) => lastIndex.set(field, index));
    const rows = [];
    for (let i = 1; i < records.length; i += 1) {
      if (records[i].length === 0) continue;
      // DictReader rows are numbered from 2 and count only non-blank records.
      if (records[i].length > fields.length)
        throw new ReconcileError(
          `${name}:${rows.length + 2}: row has more values than headers`,
          'extra_cells',
        );
      rows.push(records[i]);
    }
    if (error) throw error;
    return Object.freeze({ name, fields, rows, lastIndex });
  }

  function cellValue(table, row, name) {
    const index = table.lastIndex.get(name);
    if (index === undefined || index >= row.length) return '';
    return row[index] || '';
  }

  function duplicateHeaders(fields) {
    const counts = new Map();
    for (const field of fields) counts.set(field, (counts.get(field) || 0) + 1);
    return Array.from(counts)
      .filter(([, count]) => count > 1)
      .map(([field]) => field);
  }

  // ---------------------------------------------------------------------------
  // Reconciliation.
  // ---------------------------------------------------------------------------
  function normalizeConfig(config) {
    const source = config || {};
    return {
      left_key: String(source.left_key === undefined ? '' : source.left_key),
      right_key: String(source.right_key === undefined ? '' : source.right_key),
      left_amount:
        source.left_amount === undefined || source.left_amount === null
          ? null
          : String(source.left_amount),
      right_amount:
        source.right_amount === undefined || source.right_amount === null
          ? null
          : String(source.right_amount),
      tolerance:
        source.tolerance === undefined || source.tolerance === null
          ? '0.00'
          : String(source.tolerance),
      case_sensitive: source.case_sensitive === true,
    };
  }

  function requireField(table, name, side) {
    if (!table.lastIndex.has(name))
      throw new ReconcileError(
        `${side} CSV is missing required column(s): ${name}`,
        'missing_column',
      );
  }

  /** Rows with a blank key are set aside as missing_key findings (Python 0.2.0), never matched. */
  function indexRows(table, keyField, caseSensitive) {
    const index = new Map();
    const missing = [];
    table.rows.forEach((row, position) => {
      const key = normalizeKey(cellValue(table, row, keyField), caseSensitive);
      if (!key) {
        missing.push(position + 2);
        return;
      }
      const bucket = index.get(key);
      if (bucket) bucket.push(row);
      else index.set(key, [row]);
    });
    return { index, missing };
  }

  function missingKeyRow(side, line, keyField) {
    return {
      key: '',
      status: 'missing_key',
      left_count: side === 'left' ? 1 : 0,
      right_count: side === 'right' ? 1 : 0,
      left_amount: '',
      right_amount: '',
      difference: '',
      note: `${side} row ${line} has blank business-key column(s): ${keyField}`,
    };
  }

  function isoSecondsUtc(date) {
    return date.toISOString().slice(0, 19) + '+00:00';
  }

  /** core.reconcile_files over two already-read tables. */
  function reconcileTables(left, right, rawConfig, options) {
    const config = normalizeConfig(rawConfig);
    const opts = options || {};
    const tolerance = parseTolerance(config.tolerance);
    requireField(left, config.left_key, 'left');
    requireField(right, config.right_key, 'right');
    if (Boolean(config.left_amount) !== Boolean(config.right_amount)) {
      throw new ReconcileError('both amount columns must be supplied together', 'amount_pair');
    }
    if (config.left_amount) requireField(left, config.left_amount, 'left');
    if (config.right_amount) requireField(right, config.right_amount, 'right');

    const leftIndexed = indexRows(left, config.left_key, config.case_sensitive);
    const rightIndexed = indexRows(right, config.right_key, config.case_sensitive);
    const leftIndex = leftIndexed.index;
    const rightIndex = rightIndexed.index;
    const keys = Array.from(new Set([...leftIndex.keys(), ...rightIndex.keys()])).sort(
      compareCodePoints,
    );
    const withAmounts = Boolean(config.left_amount && config.right_amount);
    // Python 0.2.0 lists blank-key rows first, left then right, before the sorted keys.
    const rows = [
      ...leftIndexed.missing.map((line) => missingKeyRow('left', line, config.left_key)),
      ...rightIndexed.missing.map((line) => missingKeyRow('right', line, config.right_key)),
    ];

    for (const key of keys) {
      const leftMatches = leftIndex.get(key) || [];
      const rightMatches = rightIndex.get(key) || [];
      let status;
      let leftAmount = null;
      let rightAmount = null;
      let difference = null;
      let note = '';
      if (leftMatches.length === 0) status = 'missing_left';
      else if (rightMatches.length === 0) status = 'missing_right';
      else if (leftMatches.length > 1 || rightMatches.length > 1) {
        status = 'duplicate_key';
        note = DUPLICATE_NOTE;
      } else if (withAmounts) {
        try {
          leftAmount = parseAmount(cellValue(left, leftMatches[0], config.left_amount));
          rightAmount = parseAmount(cellValue(right, rightMatches[0], config.right_amount));
          difference = subtract(leftAmount, rightAmount);
          status = compare(absolute(difference), tolerance) <= 0 ? 'matched' : 'amount_mismatch';
        } catch (error) {
          if (!(error instanceof ReconcileError)) {
            if (error instanceof RunError) error.message = `key ${pyRepr(key)}: ${error.message}`;
            throw error;
          }
          status = 'invalid_amount';
          note = error.message;
        }
      } else status = 'matched';
      rows.push({
        key,
        status,
        left_count: leftMatches.length,
        right_count: rightMatches.length,
        left_amount: leftAmount === null ? '' : decimalToString(leftAmount),
        right_amount: rightAmount === null ? '' : decimalToString(rightAmount),
        difference: difference === null ? '' : decimalToString(difference),
        note,
      });
    }

    // Python 0.2.0 lists summary counts in its fixed status order (the web subset), not first-seen
    // row order, so the JSON export's key order matches json.dumps of the Python report.
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    const summary = {};
    for (const status of SUMMARY_ORDER) if (counts[status]) summary[status] = counts[status];

    return {
      schema_version: SCHEMA_VERSION,
      generated_at: isoSecondsUtc(opts.now instanceof Date ? opts.now : new Date()),
      left: left.name,
      right: right.name,
      config: {
        left_key: config.left_key,
        right_key: config.right_key,
        left_amount: config.left_amount,
        right_amount: config.right_amount,
        tolerance: decimalToString(tolerance),
        case_sensitive: config.case_sensitive,
      },
      summary,
      rows,
    };
  }

  /** Whole flow from decoded text. Left is read before right, as in Python. */
  function reconcileText(leftText, rightText, config, options) {
    const opts = options || {};
    const leftName = opts.leftName || 'left.csv';
    const rightName = opts.rightName || 'right.csv';
    parseTolerance(normalizeConfig(config).tolerance);
    const left = readTable(leftText, leftName);
    const right = readTable(rightText, rightName);
    return reconcileTables(left, right, config, opts);
  }

  /** Whole flow from bytes (ArrayBuffer or Uint8Array), with the web byte cap. */
  function reconcileBytes(leftBytes, rightBytes, config, options) {
    const opts = options || {};
    const leftName = opts.leftName || 'left.csv';
    const rightName = opts.rightName || 'right.csv';
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    parseTolerance(normalizeConfig(config).tolerance);
    checkSize(byteLength(leftBytes), leftName, maxBytes);
    const left = readTable(decodeUtf8(leftBytes, leftName), leftName);
    checkSize(byteLength(rightBytes), rightName, maxBytes);
    const right = readTable(decodeUtf8(rightBytes, rightName), rightName);
    return reconcileTables(left, right, config, opts);
  }

  function checkSize(size, name, maxBytes) {
    if (size > maxBytes) {
      throw new RunError(
        `${name}: the file is ${size} bytes; this browser tool reads files up to ${maxBytes} bytes`,
        'size_limit',
        null,
      );
    }
  }

  function exitCode(report) {
    return report.rows.some((row) => row.status !== 'matched') ? 1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Output.
  // ---------------------------------------------------------------------------
  // A leading run of control characters or spaces does not stop a spreadsheet from
  // running what follows (Excel drops leading NULs), so look past it.
  const FORMULA_START = /^(?:[\x00-\x20\x7f]*[=+\-@]|[\t\r])/;

  // A plain negative decimal such as -30.00 is a number, not a formula. Only the amount
  // columns are exempt, and only when the whole cell is a plain number.
  const PLAIN_NEGATIVE_NUMBER = /^-(?:[0-9]+(?:\.[0-9]+)?)(?:E[+-][0-9]+)?$/;
  const NUMERIC_FIELDS = Object.freeze(['left_amount', 'right_amount', 'difference']);

  function csvField(value, neutralize, numeric) {
    let text = String(value);
    if (neutralize && FORMULA_START.test(text) && !(numeric && PLAIN_NEGATIVE_NUMBER.test(text)))
      text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  /**
   * write_report(format='csv'): header plus rows, CRLF, minimal quoting.
   * neutralizeFormulas (default true) prefixes an apostrophe to any cell that
   * starts with = + - @ (after any leading control characters or spaces), TAB, or
   * CR so spreadsheets treat it as text. Plain negative numbers in the amount and
   * difference columns (for example -30.00) are left as numbers. Pass false
   * for byte parity with the Python writer.
   */
  function toCsv(report, options) {
    const neutralize = !(options && options.neutralizeFormulas === false);
    const lines = [REPORT_FIELDS.map((field) => csvField(field, neutralize)).join(',')];
    for (const row of report.rows)
      lines.push(
        REPORT_FIELDS.map((field) =>
          csvField(row[field], neutralize, NUMERIC_FIELDS.includes(field)),
        ).join(','),
      );
    return lines.join('\r\n') + '\r\n';
  }

  const JSON_SHORT = {
    '"': '\\"',
    '\\': '\\\\',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\b': '\\b',
    '\f': '\\f',
  };

  function jsonString(text) {
    let out = '"';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const code = text.charCodeAt(i);
      if (JSON_SHORT[ch]) out += JSON_SHORT[ch];
      else if (code < 0x20 || code > 0x7e) out += '\\u' + hex(code, 4);
      else out += ch;
    }
    return out + '"';
  }

  function jsonValue(value, depth) {
    if (value === null || value === undefined) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return jsonString(value);
    const pad = '  '.repeat(depth + 1);
    const close = '  '.repeat(depth);
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return (
        '[\n' +
        value.map((item) => pad + jsonValue(item, depth + 1)).join(',\n') +
        '\n' +
        close +
        ']'
      );
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return (
      '{\n' +
      keys
        .map((key) => pad + jsonString(key) + ': ' + jsonValue(value[key], depth + 1))
        .join(',\n') +
      '\n' +
      close +
      '}'
    );
  }

  /** json.dumps(report, indent=2) + '\n' (ensure_ascii, LF). */
  function toJson(report) {
    return jsonValue(report, 0) + '\n';
  }

  // ---------------------------------------------------------------------------
  // UI helper (not part of the Python surface): suggest a column by header name.
  // ---------------------------------------------------------------------------
  const KEY_HINTS = [
    'invoice_number',
    'invoice_id',
    'invoice',
    'order_id',
    'order',
    'reference',
    'ref',
    'number',
    'no',
    'num',
    'id',
    'key',
    'code',
    'sku',
  ];
  const AMOUNT_HINTS = [
    'amount',
    'total',
    'paid',
    'balance',
    'payment',
    'value',
    'sum',
    'price',
    'net',
    'gross',
  ];
  // A header containing one of these words is never suggested for that kind:
  // "Invoice Date" and "Paid" are not keys, "Payment ID" is not an amount.
  const KEY_EXCLUDE = ['date', 'time', 'due', ...AMOUNT_HINTS];
  const AMOUNT_EXCLUDE = [
    'date',
    'time',
    'id',
    'no',
    'num',
    'number',
    'ref',
    'reference',
    'key',
    'code',
    'sku',
  ];

  /** Header words: camelCase split, casefolded, split on anything that is not a letter or digit. */
  function headerTokens(field) {
    const spaced = String(field)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return casefold(spaced)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  }

  function suggestColumn(fields, kind) {
    const hints = kind === 'amount' ? AMOUNT_HINTS : KEY_HINTS;
    const exclude = kind === 'amount' ? AMOUNT_EXCLUDE : KEY_EXCLUDE;
    let best = null;
    let bestScore = 0;
    fields.forEach((field, index) => {
      const tokens = headerTokens(field);
      if (tokens.length === 0 || tokens.some((token) => exclude.includes(token))) return;
      const normal = tokens.join('_');
      hints.forEach((hint, rank) => {
        let score = 0;
        if (normal === hint) score = 300 - rank;
        else if (
          normal.startsWith(hint + '_') ||
          normal.endsWith('_' + hint) ||
          normal.includes('_' + hint + '_')
        )
          score = 200 - rank;
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      });
    });
    return best === null ? null : fields[best];
  }

  return Object.freeze({
    VERSION,
    SCHEMA_VERSION,
    UNICODE_VERSION,
    FIELD_LIMIT,
    DEFAULT_MAX_BYTES,
    STATUSES,
    REPORT_FIELDS,
    DUPLICATE_NOTE,
    SAMPLE,
    ReconcileError,
    RunError,
    decodeUtf8,
    parseCsv,
    readTable,
    duplicateHeaders,
    normalizeKey,
    casefold,
    pyRepr,
    compareCodePoints,
    isPrintable,
    decimalDigitValue,
    parseDecimal,
    parseAmount,
    parseTolerance,
    negate,
    subtract,
    compare,
    decimalToString,
    reconcileTables,
    reconcileText,
    reconcileBytes,
    exitCode,
    toCsv,
    toJson,
    suggestColumn,
  });
});
