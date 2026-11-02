/*
 * Product names keep their own spelling inside all-caps eyebrows, kickers and labels:
 * "ALCORPHOTO · FREE PHOTO EDITOR" reads "AlcorPhoto · FREE PHOTO EDITOR". Each name in
 * an uppercase text node is wrapped once in a span with text-transform:none (set through
 * the CSSOM, so strict style-src policies allow it). Text anywhere else is left untouched:
 * a name that is already PascalCase needs no span, and inside a flex button the span would
 * become its own flex item and widen the space ("Open  AlcorPhoto"). Text added later
 * (editors, the phone frame) is handled as it appears. Attributes, form fields and code
 * are never touched.
 */
(function () {
  'use strict';
  var NAMES =
    /\bAlcor(?:Photo|Video|QR|Music|Translate|Maps?|Reconcile|ERP|Finance|OS|Apps?|Taste|Ads|Stock|Margin|Browser|Frame)\b/g;
  var SKIP =
    'script,style,noscript,textarea,input,select,option,code,pre,svg,[contenteditable],[data-alcor-name]';

  function wrapText(node) {
    var text = node.nodeValue;
    NAMES.lastIndex = 0;
    if (!NAMES.test(text)) return;
    var parent = node.parentElement;
    if (!parent || parent.closest(SKIP)) return;
    // Only uppercase text needs the span; the computed value includes what the label inherits.
    if (window.getComputedStyle(parent).textTransform !== 'uppercase') return;
    var fragment = document.createDocumentFragment();
    var last = 0;
    NAMES.lastIndex = 0;
    for (var match; (match = NAMES.exec(text)); ) {
      if (match.index > last)
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      var span = document.createElement('span');
      span.setAttribute('data-alcor-name', '');
      span.style.textTransform = 'none';
      span.textContent = match[0];
      fragment.appendChild(span);
      last = match.index + match[0].length;
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(fragment, node);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      wrapText(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return node.nodeValue.indexOf('Alcor') === -1
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    var hits = [];
    for (var node; (node = walker.nextNode()); ) hits.push(node);
    hits.forEach(wrapText);
  }

  var pending = [];
  var scheduled = false;
  function flush() {
    scheduled = false;
    var batch = pending;
    pending = [];
    batch.forEach(function (node) {
      if (node.isConnected) scan(node);
    });
  }

  function start() {
    scan(document.body);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.type === 'characterData') pending.push(record.target);
        else
          for (var j = 0; j < record.addedNodes.length; j += 1) {
            var added = record.addedNodes[j];
            if (added.nodeType === 1 && added.hasAttribute('data-alcor-name')) continue;
            pending.push(added);
          }
      }
      if (pending.length && !scheduled) {
        scheduled = true;
        (window.requestAnimationFrame || setTimeout)(flush);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
