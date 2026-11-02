/**
 * AlcorFields editor enhancements.
 *
 * The form works without this file; with it an editor gets a rich-text toolbar, list add/remove/reorder, the
 * media picker, a field filter, and a submit that sends the whole form as one JSON field (so a host's
 * max_input_vars limit can never drop part of a large page).
 *
 * The server validates everything again; nothing here is trusted. The inline allowlist below only keeps the
 * editor from producing markup that the server would refuse.
 */
(function () {
  'use strict';

  var form = document.getElementById('af-form');

  /** Inline tags the server accepts, and the only attributes each may carry (mirrors Alcor_Fields_Types). */
  var INLINE = {
    a: ['href', 'title', 'class'],
    abbr: ['title'],
    b: [],
    br: [],
    code: [],
    em: [],
    i: [],
    mark: [],
    s: [],
    small: [],
    span: ['aria-hidden', 'class'],
    strong: [],
    sub: [],
    sup: [],
  };

  document.addEventListener('click', function (event) {
    var confirmer = event.target.closest('[data-af-confirm]');
    if (confirmer && !window.confirm(confirmer.getAttribute('data-af-confirm'))) {
      event.preventDefault();
    }
  });
  if (!form) {
    return;
  }

  var dirty = false;
  var submitting = false;

  /**
   * Escapes text for use as HTML content.
   * @param {string} text - Plain text.
   * @returns {string} Text with &, < and > escaped.
   */
  function escapeText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Escapes text for use inside a double-quoted attribute value.
   * @param {string} text - Plain text.
   * @returns {string} Escaped text.
   */
  function escapeAttr(text) {
    return escapeText(text).replace(/"/g, '&quot;');
  }

  /**
   * Serializes a DOM fragment into the inline allowlist the server accepts.
   *
   * Anything outside the allowlist is flattened to its text, never copied, so pasted markup cannot smuggle
   * tags or attributes into the stored value.
   *
   * @param {Node} node - Element whose children are serialized.
   * @param {string[]} classes - Class values this field may keep.
   * @returns {string} Markup that uses only allowed tags and attributes.
   */
  function serialize(node, classes) {
    var out = '';
    node.childNodes.forEach(function (child, index) {
      if (child.nodeType === 3) {
        // contenteditable inserts zero-width spaces around some edits; they are not content.
        out += escapeText(child.nodeValue.replace(/​/g, ''));
        return;
      }
      if (child.nodeType !== 1) {
        return;
      }
      var tag = child.tagName.toLowerCase();
      // Code and embedded documents contribute nothing, not even their text.
      var inert = [
        'script',
        'style',
        'template',
        'noscript',
        'iframe',
        'object',
        'embed',
        'svg',
        'math',
      ];
      if (inert.indexOf(tag) !== -1) {
        return;
      }
      if (tag === 'div' || tag === 'p') {
        if (index > 0 && out !== '' && !/<br>$/.test(out)) {
          out += '<br>';
        }
        out += serialize(child, classes);
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(INLINE, tag)) {
        out += serialize(child, classes);
        return;
      }
      if (tag === 'br') {
        out += '<br>';
        return;
      }
      var attrs = '';
      INLINE[tag].forEach(function (name) {
        if (!child.hasAttribute(name)) {
          return;
        }
        var value = child.getAttribute(name);
        if (name === 'class' && classes.indexOf(value) === -1) {
          return;
        }
        if (name === 'aria-hidden' && value !== 'true') {
          return;
        }
        attrs += ' ' + name + '="' + escapeAttr(value) + '"';
      });
      if (tag === 'a' && attrs.indexOf(' href="') === -1) {
        out += serialize(child, classes);
        return;
      }
      if (tag === 'span' && attrs === '') {
        out += '<span>' + serialize(child, classes) + '</span>';
        return;
      }
      out += '<' + tag + attrs + '>' + serialize(child, classes) + '</' + tag + '>';
    });
    return out;
  }

  /**
   * Cleans markup the way the server will, by parsing it and serializing it again.
   * @param {string} html - Markup typed or pasted by the editor.
   * @param {string[]} classes - Class values this field may keep.
   * @returns {string} Allowlisted markup.
   */
  function cleanHtml(html, classes) {
    var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    return serialize(doc.body, classes);
  }

  /**
   * Replaces a rich-text textarea with a contenteditable editor and a toolbar.
   * The textarea stays in the form as the source of truth that gets submitted.
   * @param {HTMLTextAreaElement} textarea - A [data-af-rich] textarea.
   */
  function richEditor(textarea) {
    if (textarea.dataset.afReady) {
      return;
    }
    textarea.dataset.afReady = '1';
    var classes = JSON.parse(textarea.getAttribute('data-af-classes') || '[]');
    var wrap = document.createElement('div');
    wrap.className = 'af-rich';
    var bar = document.createElement('div');
    bar.className = 'af-rich-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');
    var editor = document.createElement('div');
    editor.className = 'af-rich-editor';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    var label = form.querySelector('label[for="' + textarea.id + '"]');
    if (label) {
      label.id = label.id || textarea.id + '-label';
      editor.setAttribute('aria-labelledby', label.id);
      label.addEventListener('click', function () {
        editor.focus();
      });
    }
    editor.innerHTML = cleanHtml(textarea.value, classes);

    function sync() {
      textarea.value = serialize(editor, classes);
      dirty = true;
    }

    function button(text, title, run) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'button button-small';
      b.textContent = text;
      b.title = title;
      // Keep the selection in the editor when a toolbar button is pressed.
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      b.addEventListener('click', run);
      bar.appendChild(b);
      return b;
    }

    var formatting = [];

    function format(run) {
      return function () {
        // In HTML mode the markup box is the truth; formatting would overwrite it.
        if (editor.hidden) {
          return;
        }
        editor.focus();
        run();
        sync();
      };
    }

    formatting.push(
      button(
        'B',
        'Bold',
        format(function () {
          document.execCommand('bold');
        }),
      ),
    );
    formatting.push(
      button(
        'I',
        'Italic',
        format(function () {
          document.execCommand('italic');
        }),
      ),
    );
    // Text inside a link or button cannot hold another link (the server refuses it; a browser would split it).
    if (!textarea.hasAttribute('data-af-no-links')) {
      formatting.push(
        button(
          'Link',
          'Make the selected words a link',
          format(function () {
            var url = window.prompt(
              'Link to (https://…, mailto:…, tel:… or #section):',
              'https://',
            );
            if (url && url !== 'https://') {
              document.execCommand('createLink', false, url.trim());
            }
          }),
        ),
      );
      formatting.push(
        button(
          'Unlink',
          'Remove the link',
          format(function () {
            document.execCommand('unlink');
          }),
        ),
      );
    }
    var source = button('HTML', 'Edit the underlying markup', function () {
      var toSource = textarea.hidden;
      if (toSource) {
        // The textarea takes the editor's current content.
        sync();
      } else {
        // Back to the visual editor with what was typed in the markup, cleaned the way the server will clean it.
        editor.innerHTML = cleanHtml(textarea.value, classes);
        textarea.value = serialize(editor, classes);
        dirty = true;
      }
      textarea.hidden = !toSource;
      editor.hidden = toSource;
      formatting.forEach(function (b) {
        b.disabled = toSource;
      });
      source.setAttribute('aria-pressed', String(toSource));
      (toSource ? textarea : editor).focus();
    });
    textarea.addEventListener('input', function () {
      dirty = true;
    });
    editor.addEventListener('input', sync);
    editor.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!document.execCommand('insertLineBreak')) {
          document.execCommand('insertHTML', false, '<br>');
        }
        sync();
      }
    });
    // Paste as plain text, on one line, so no foreign markup or styling enters the editor.
    editor.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
      sync();
    });
    textarea.hidden = true;
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(bar);
    wrap.appendChild(editor);
    wrap.appendChild(textarea);
  }

  /* ---------------------------------------------------------------- lists */

  /**
   * Returns the rows of a list in page order.
   * @param {Element} list - A [data-af-list] element.
   * @returns {Element[]} Its [data-af-row] children.
   */
  function rowsOf(list) {
    return Array.prototype.filter.call(
      list.querySelector('[data-af-rows]').children,
      function (el) {
        return el.hasAttribute('data-af-row');
      },
    );
  }

  /**
   * Updates a list's row numbers and enables or disables its move, remove and add buttons.
   * @param {Element} list - A [data-af-list] element.
   */
  function refreshList(list) {
    var rows = rowsOf(list);
    var min = parseInt(list.getAttribute('data-af-min'), 10);
    var max = parseInt(list.getAttribute('data-af-max'), 10);
    rows.forEach(function (row, i) {
      var number = row.querySelector(':scope > .af-row-tools .af-row-number');
      if (number) {
        number.textContent = String(i + 1);
      }
      row.querySelector(':scope > .af-row-tools [data-af-move="-1"]').disabled = i === 0;
      row.querySelector(':scope > .af-row-tools [data-af-move="1"]').disabled =
        i === rows.length - 1;
      row.querySelector(':scope > .af-row-tools [data-af-remove]').disabled = rows.length <= min;
    });
    var add = list.querySelector(':scope > [data-af-add]');
    if (add) {
      add.disabled = rows.length >= max;
    }
  }

  var uid = 0;
  form.addEventListener('click', function (event) {
    var add = event.target.closest('[data-af-add]');
    var move = event.target.closest('[data-af-move]');
    var remove = event.target.closest('[data-af-remove]');
    if (add) {
      var list = add.closest('[data-af-list]');
      var template = list.querySelector(':scope > template[data-af-row-template]');
      var fragment = template.content.cloneNode(true);
      uid++;
      // A new row must not repeat the ids of the template row it was copied from.
      fragment.querySelectorAll('[id]').forEach(function (el) {
        var old = el.id;
        el.id = old + '-n' + uid;
        fragment.querySelectorAll('[for="' + old + '"]').forEach(function (l) {
          l.setAttribute('for', el.id);
        });
        fragment.querySelectorAll('[data-af-pick-image="' + old + '"]').forEach(function (b) {
          b.setAttribute('data-af-pick-image', el.id);
        });
      });
      var row = fragment.querySelector('[data-af-row]');
      list.querySelector('[data-af-rows]').appendChild(fragment);
      enhance(row);
      refreshList(list);
      dirty = true;
      var first = row.querySelector('input, textarea, .af-rich-editor');
      if (first) {
        first.focus();
      }
    } else if (move) {
      var mrow = move.closest('[data-af-row]');
      var step = parseInt(move.getAttribute('data-af-move'), 10);
      var sibling = step < 0 ? mrow.previousElementSibling : mrow.nextElementSibling;
      if (sibling) {
        if (step < 0) {
          sibling.before(mrow);
        } else {
          sibling.after(mrow);
        }
        refreshList(mrow.closest('[data-af-list]'));
        move.focus();
        dirty = true;
      }
    } else if (remove) {
      var rrow = remove.closest('[data-af-row]');
      var rlist = rrow.closest('[data-af-list]');
      rrow.remove();
      refreshList(rlist);
      dirty = true;
      var next = rlist.querySelector('[data-af-add]');
      if (next) {
        next.focus();
      }
    }
  });

  /* ---------------------------------------------------------------- images */

  /**
   * Finds the width and height inputs that belong to an image input (same row, same base name).
   * @param {HTMLInputElement} input - An image URL input.
   * @returns {{width?: HTMLInputElement, height?: HTMLInputElement}} The inputs that exist.
   */
  function dimensionInputs(input) {
    var pattern = JSON.parse(input.getAttribute('data-af-name'));
    var base = pattern[pattern.length - 1];
    var scope = input.closest('[data-af-row]') || form;
    var found = {};
    ['width', 'height'].forEach(function (dim) {
      var want = JSON.stringify(pattern.slice(0, -1).concat([base + '_' + dim]));
      scope.querySelectorAll('[data-af-dimension="' + dim + '"]').forEach(function (el) {
        if (
          el.getAttribute('data-af-name') === want &&
          (el.closest('[data-af-row]') || form) === scope
        ) {
          found[dim] = el;
        }
      });
    });
    return found;
  }

  /**
   * Refreshes the thumbnail beside an image input.
   * @param {HTMLInputElement} input - An image URL input.
   */
  function previewFor(input) {
    var img = input.parentNode.querySelector('[data-af-preview]');
    if (!img) {
      return;
    }
    var value = input.value.trim();
    var base = form.getAttribute('data-af-asset-base') || '';
    img.src =
      /^https?:\/\//i.test(value) || value.charAt(0) === '/' ? value : value ? base + value : '';
  }

  form.addEventListener('click', function (event) {
    var pick = event.target.closest('[data-af-pick-image]');
    if (!pick || !window.wp || !wp.media) {
      return;
    }
    var input = document.getElementById(pick.getAttribute('data-af-pick-image'));
    var frame = wp.media({
      title: 'Choose an image',
      library: { type: 'image' },
      multiple: false,
      button: { text: 'Use this image' },
    });
    frame.on('select', function () {
      var file = frame.state().get('selection').first().toJSON();
      input.value = file.url;
      var dims = dimensionInputs(input);
      if (dims.width && file.width) {
        dims.width.value = file.width;
      }
      if (dims.height && file.height) {
        dims.height.value = file.height;
      }
      previewFor(input);
      dirty = true;
    });
    frame.open();
  });
  form.addEventListener('change', function (event) {
    if (event.target.matches('[data-af-image]')) {
      previewFor(event.target);
    }
    if (event.target.matches('[data-af-show]')) {
      event.target.closest('[data-af-group]').classList.toggle('is-hidden', !event.target.checked);
    }
  });
  form.addEventListener('input', function () {
    dirty = true;
  });
  // Enter in a one-line box never submits (the form's disabled default button already ensures that without JS).
  form.addEventListener('keydown', function (event) {
    if (
      event.key === 'Enter' &&
      event.target.matches('input[type="text"], input[type="number"], input[type="search"]')
    ) {
      event.preventDefault();
    }
  });

  /* ---------------------------------------------------------------- filter */

  var filter = form.querySelector('[data-af-filter]');
  if (filter) {
    filter.addEventListener('input', function () {
      var q = filter.value.trim().toLowerCase();
      form.querySelectorAll('[data-af-field]').forEach(function (field) {
        if (field.closest('template')) {
          return;
        }
        var text = field.textContent.toLowerCase();
        field.querySelectorAll('input, textarea').forEach(function (el) {
          text += ' ' + String(el.value).toLowerCase();
        });
        field.hidden = q !== '' && text.indexOf(q) === -1;
      });
    });
    filter.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
      }
    });
  }

  /* ---------------------------------------------------------------- submit as one JSON field */

  /**
   * Fills the list indexes of an input-name pattern from the rows' current order on the page.
   * @param {Element} el - The input (or list) the pattern belongs to.
   * @param {Array<string|null>} pattern - Name segments; null marks a list index.
   * @returns {Array<string|number>} The segments with real indexes.
   */
  function fillPattern(el, pattern) {
    var indexes = [];
    for (
      var row = el.closest('[data-af-row]');
      row;
      row = row.parentNode.closest('[data-af-row]')
    ) {
      indexes.unshift(rowsOf(row.closest('[data-af-list]')).indexOf(row));
    }
    var i = 0;
    return pattern.map(function (segment) {
      return segment === null ? indexes[i++] : segment;
    });
  }

  /**
   * Stores a value at a nested path, creating arrays for numeric segments and objects otherwise.
   * @param {object} target - Object to write into.
   * @param {Array<string|number>} path - Path segments.
   * @param {*} value - Value to store.
   */
  function put(target, path, value) {
    var node = target;
    for (var i = 0; i < path.length - 1; i++) {
      var key = path[i];
      if (node[key] === undefined) {
        node[key] = typeof path[i + 1] === 'number' ? [] : {};
      }
      node = node[key];
    }
    node[path[path.length - 1]] = value;
  }

  form.addEventListener('submit', function (event) {
    var submitter = event.submitter;
    if (submitter && submitter.getAttribute('formnovalidate') === null && !form.checkValidity()) {
      event.preventDefault();
      form.reportValidity();
      return;
    }
    var data = { complete: 1, shown: {} };
    form.querySelectorAll('[data-af-list]').forEach(function (list) {
      if (list.closest('template')) {
        return;
      }
      put(data, fillPattern(list, JSON.parse(list.getAttribute('data-af-name'))), []);
    });
    form.querySelectorAll('[data-af-name]').forEach(function (el) {
      if (el.closest('template') || el.hasAttribute('data-af-list')) {
        return;
      }
      put(data, fillPattern(el, JSON.parse(el.getAttribute('data-af-name'))), el.value);
    });
    form.querySelectorAll('[data-af-show]').forEach(function (box) {
      var key = box.name.replace(/^af\[shown\]\[/, '').replace(/\]$/, '');
      if (box.checked) {
        data.shown[key] = 1;
      }
    });
    form.querySelector('[data-af-json]').value = JSON.stringify(data);
    // The JSON field carries everything; sending the individual inputs too could exceed max_input_vars.
    form.querySelectorAll('[name^="af["]').forEach(function (el) {
      el.disabled = true;
    });
    form.querySelectorAll('template').forEach(function (t) {
      t.remove();
    });
    submitting = true;
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty && !submitting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /**
   * Upgrades the rich-text fields and lists inside a container (the whole form, or a newly added row).
   * @param {Element} root - Container to enhance.
   */
  function enhance(root) {
    root.querySelectorAll('textarea[data-af-rich]').forEach(function (t) {
      if (!t.closest('template')) {
        richEditor(t);
      }
    });
    root.querySelectorAll('[data-af-list]').forEach(function (list) {
      if (!list.closest('template')) {
        refreshList(list);
      }
    });
  }
  enhance(form);
  form.classList.add('af-enhanced');
})();
