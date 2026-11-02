/**
 * Marks the current page's link in the navigation, so the demo site has a script for the
 * contract's link check to resolve. No network access, no storage.
 */
for (const link of document.querySelectorAll('nav a')) {
  if (link.pathname === window.location.pathname) link.setAttribute('aria-current', 'page');
}
