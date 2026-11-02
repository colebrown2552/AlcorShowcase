/**
 * Per-install settings for the extension worker (read once by agents.js).
 *
 * The installer (scripts/install.py) writes a copy of this file for each install. The updater never
 * replaces it; it only rewrites the `build` value, so keep `build` a quoted hex string.
 *
 * - host: the native-messaging host name registered with Chrome.
 * - profile_label: names this browser profile to the broker. The broker keeps one connection per
 *   label, so two profiles on one machine need different labels.
 * - build: id of the extension build this copy came from (set by the installer and the updater).
 * - install_dir: where this copy lives on disk. The broker compares `build.json` there with `build`
 *   to learn that a newer copy is on disk and ask the worker to reload.
 */
globalThis.ALCOR_BROWSER_CONFIG = {
  host: 'com.alcor.browser',
  profile_label: 'default',
  build: '',
  install_dir: '',
};
