// eval/fake-dom.js — the smallest thing that lets content.js load under node.
//
// content.js is an IIFE that touches document/window/chrome at import time, so
// there is no way to require() it without these globals existing first. This is
// deliberately NOT a DOM implementation: elements are plain objects and
// querySelector is a lookup in a selector->nodes map that each test supplies.
// That is enough because the tests control the fixtures, and it keeps the
// harness at ~80 lines instead of pulling in jsdom.

function makeEl(spec) {
  const el = {
    tagName: (spec.tag || 'div').toUpperCase(),
    textContent: spec.text || '',
    content: spec.content,
    alt: spec.alt || '',
    dataset: spec.dataset || {},
    src: spec.src,
    attrs: Object.assign({}, spec.attrs),
    _sel: spec.sel || {},
  };
  if (spec.content !== undefined) el.attrs.content = spec.content;
  if (spec.src !== undefined) el.attrs.src = spec.src;
  el.getAttribute = k => (k in el.attrs ? el.attrs[k] : null);
  el.querySelector = sel => (el._sel[sel] || [])[0] || null;
  el.querySelectorAll = sel => el._sel[sel] || [];
  el.closest = () => null;
  el.contains = other => Object.values(el._sel).some(list => list.includes(other));
  el.getBoundingClientRect = () => ({ width: 0, height: 0 });
  return el;
}

// selectors: { '<css selector>': [elementSpec, ...] }
function makeDocument(selectors, opts) {
  const map = {};
  for (const [sel, specs] of Object.entries(selectors || {})) {
    map[sel] = specs.map(s => (s && s.tagName ? s : makeEl(s)));
  }
  return {
    readyState: (opts && opts.readyState) || 'complete',
    title: (opts && opts.title) || '',
    body: makeEl({ tag: 'body' }),
    addEventListener() {},
    querySelector(sel) { return (map[sel] || [])[0] || null; },
    querySelectorAll(sel) { return map[sel] || []; },
    // Lets a test inject markup after load, which is the whole point of the
    // SPA re-check tests. Mutating the caller's array would not work — the
    // constructor above copies it.
    __set(sel, specs) { map[sel] = specs.map(s => (s && s.tagName ? s : makeEl(s))); },
  };
}

// Installs globals and require()s content.js fresh. Returns its test hook.
function loadContentScript(opts) {
  const o = opts || {};
  const href = o.href || 'https://www.example.com/p/some-product';
  const url = new URL(href);

  global.window = {
    location: { href, hostname: url.hostname, pathname: url.pathname },
    __auraVersion: undefined,
  };
  global.document = makeDocument(o.selectors, o);
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.chrome = { runtime: { onMessage: { addListener() {} } } };

  const path = require.resolve('../content.js');
  delete require.cache[path];
  return require(path);
}

module.exports = { makeEl, makeDocument, loadContentScript };
