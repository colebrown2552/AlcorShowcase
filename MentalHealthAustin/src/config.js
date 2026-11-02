// Runtime configuration read from the environment at build time (Create React App REACT_APP_* variables).

/** Base URL of the Flask API, without a trailing slash. Defaults to the local dev server. */
export const API_URL = (process.env.REACT_APP_API_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');

/** Optional base URL of the partner "nonprofit" API used only by the Developer Visuals page. Empty means disabled. */
export const NONPROFIT_API_URL = (process.env.REACT_APP_NONPROFIT_API_URL || '').replace(/\/+$/, '');