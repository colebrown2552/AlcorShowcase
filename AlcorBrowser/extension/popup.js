/**
 * AlcorBrowser popup (the "hub" panel).
 *
 * Shows the link to the broker, the update channel and recent agent calls. It never talks to the
 * broker itself: every request goes to the service worker (`chrome.runtime.sendMessage`), which owns
 * the native port and forwards `status`, `update` and `restart` to the broker. `reload` is local.
 */

/** @param {string} id - Element id. @returns {HTMLElement} The element. */
const $ = (id) => document.getElementById(id);

/**
 * Ask the service worker for a hub reply; an unreachable worker reads as "not connected".
 * @param {string} req - `status`, `connect`, `update`, `restart` or `reload`.
 * @returns {Promise<object>} The reply: `{connected, ...}` plus `ext` (this extension's own facts).
 */
const ask = (req) =>
  chrome.runtime
    .sendMessage({ kind: 'hub', req })
    .catch((e) => ({ connected: false, error: String(e) }));

/** How the broker names its update source, as shown to people. */
const CHANNEL_LABELS = { directory: 'local folder', web: 'web', none: 'not set' };

/**
 * Format an epoch-seconds timestamp as a short age such as "40s", "5m" or "2h".
 * @param {number} ts - Epoch seconds.
 * @returns {string} The age.
 */
const ago = (ts) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
};

/**
 * Draw one hub reply into the page. Page text is only ever assigned with `textContent`, because
 * the values (update notes, URLs) come from outside the extension.
 * @param {object} v - The reply from `ask`.
 */
function render(v) {
  const ext = v.ext || {};
  $('installed').textContent = `v${ext.version || '?'} · ${ext.build || ''}`;
  const conn = $('conn');
  conn.className = 'dot ' + (v.connected && !v.timeout ? 'ok' : 'bad');
  conn.querySelector('span').textContent = v.connected && !v.timeout ? 'Connected' : 'Offline';
  $('broker').textContent = v.broker_version ? 'v' + v.broker_version : 'not reachable';
  $('channelKind').textContent = CHANNEL_LABELS[v.channel_kind] || v.channel_kind || '—';
  $('profile').textContent = ext.profile || '—';
  $('tabs').textContent = v.tabs_named ?? '—';

  const ch = v.channel || {},
    card = $('updateCard'),
    badge = $('updBadge');
  $('avail').textContent = ch.version ? 'v' + ch.version : 'No channel';
  $('published').textContent = ch.published
    ? `Published ${ch.published}${ch.build ? ' · ' + String(ch.build).slice(0, 12) : ''}`
    : '';
  const notes = $('notes');
  notes.textContent = '';
  for (const n of (ch.notes || []).slice(0, 6)) {
    const li = document.createElement('li');
    li.textContent = n;
    notes.append(li);
  }
  const fresh = !!v.update_available;
  card.className = 'card update' + (fresh ? '' : ' none');
  badge.className = 'badge' + (fresh ? ' new' : '');
  badge.textContent = fresh ? 'update available' : ch.version ? 'up to date' : '—';
  $('btnUpdate').disabled = !fresh || !v.connected;
  $('btnRestart').disabled = !v.connected;

  const act = $('activity');
  act.textContent = '';
  const rows = v.recent || [];
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No agent calls yet';
    act.append(li);
  }
  for (const r of rows.slice(-8).reverse()) {
    const li = document.createElement('li');
    for (const [cls, text] of [
      ['t', ago(r.ts)],
      ['a', r.agent || ''],
      [
        'tool',
        (r.tool || '').replace('browser_', '') +
          (r.origin ? ' · ' + r.origin.replace(/^https?:\/\//, '') : ''),
      ],
      ['r ' + (r.ok ? 'ok' : 'bad'), r.ok ? '✓' : '✕'],
    ]) {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      li.append(s);
    }
    act.append(li);
  }
}

/** Fetch a fresh reply and draw it. @param {string} [req] - Hub request name. */
async function refresh(req = 'status') {
  render(await ask(req));
}

/** Show a message and disable every button while a long action (update, restart) runs. */
function busy(text) {
  $('msg').textContent = text;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
}

$('btnUpdate').onclick = async () => {
  busy('Updating: the broker restarts and the extension reloads itself…');
  await ask('update');
  setTimeout(() => window.close(), 2500);
};
$('btnRestart').onclick = async () => {
  busy('Restarting the broker…');
  await ask('restart');
  // The restart lane takes several seconds; reconnect the worker, then redraw.
  setTimeout(
    () =>
      refresh('connect').then(() => {
        $('msg').textContent = '';
      }),
    12000,
  );
};
$('btnReload').onclick = async () => {
  busy('Reloading the extension…');
  await ask('reload');
  setTimeout(() => window.close(), 600);
};

(async () => {
  const v = await ask('status');
  render(v);
  if (!v.connected) {
    $('msg').textContent = 'Reconnecting…';
    await refresh('connect');
    $('msg').textContent = '';
  }
})();
