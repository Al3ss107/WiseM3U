'use strict';

/**
 * Client-side i18n for the configuration page.
 *
 * English is the source language and the default. Translations live in
 * /i18n/<code>.json as "source text" -> "translated text" pairs. Dynamic
 * strings may use {placeholders}; the engine turns them into patterns.
 *
 * The engine translates text nodes and the title/placeholder/aria-label/alt
 * attributes, and re-translates new DOM nodes produced by the UI. Elements
 * with data-i18n-html="key" are translated as whole HTML blocks.
 */
(function () {
  const LANGS = [
    { code: 'en', name: 'English' },
    { code: 'it', name: 'Italiano' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'zh', name: '简体中文' },
  ];
  const STORE_KEY = 'wisem3u_lang';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP']);
  const cache = new Map();

  let lang = 'en';
  let dict = null;
  let patterns = [];
  let observer = null;
  let scheduled = false;

  const normalize = (s) => String(s).replace(/\s+/g, ' ').trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function withSpaces(original, translated) {
    const lead = original.match(/^\s*/)[0];
    const trail = original.match(/\s*$/)[0];
    return lead + translated + trail;
  }

  function compilePatterns(dictionary) {
    const out = [];
    for (const [key, value] of Object.entries(dictionary)) {
      if (!key.includes('{') || !key.includes('}')) continue;
      const names = [];
      let re = '';
      let last = 0;
      const rePlaceholder = /\{([a-zA-Z0-9_]+)\}/g;
      let match;
      while ((match = rePlaceholder.exec(key))) {
        re += escapeRe(key.slice(last, match.index)) + '(.+?)';
        names.push(match[1]);
        last = match.index + match[0].length;
      }
      re += escapeRe(key.slice(last));
      out.push({ re: new RegExp('^' + re + '$'), names, value });
    }
    // more specific (longer) keys take precedence
    out.sort((a, b) => b.re.source.length - a.re.source.length);
    return out;
  }

  function fill(value, names, groups) {
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => {
      const i = names.indexOf(name);
      return i >= 0 && groups[i] !== undefined ? groups[i] : whole;
    });
  }

  /** Translates a string (also used for confirm/prompt). */
  function translate(text) {
    if (!dict) return String(text);
    const raw = String(text);
    const key = normalize(raw);
    if (!key) return raw;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return withSpaces(raw, dict[key]);
    for (const p of patterns) {
      const m = key.match(p.re);
      if (m) return withSpaces(raw, fill(p.value, p.names, m.slice(1)));
    }
    return raw;
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3 || node.__wmTranslating) return;
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName) || parent.closest('[data-i18n-html]')) return;
    if (node.__wmSrc === undefined) node.__wmSrc = node.nodeValue;
    const source = node.__wmSrc;
    if (!source || !source.trim()) return;
    const translated = translate(source);
    if (translated !== node.nodeValue) {
      node.__wmOut = translated;
      node.nodeValue = translated;
    }
  }

  function translateAttributes(el) {
    if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName)) return;
    if (el.closest('[data-i18n-html]')) return;
    if (!el.__wmAttrs) el.__wmAttrs = {};
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      if (el.__wmAttrs[attr] === undefined) el.__wmAttrs[attr] = el.getAttribute(attr);
      const source = el.__wmAttrs[attr];
      if (!source || !source.trim()) continue;
      const translated = translate(source);
      if (translated !== el.getAttribute(attr)) {
        el.__wmAttrsOut = el.__wmAttrsOut || {};
        el.__wmAttrsOut[attr] = translated;
        el.setAttribute(attr, translated);
      }
    }
  }

  function translateHtmlBlock(el) {
    if (el.__wmTranslating) return;
    if (el.__wmHtmlSrc === undefined) el.__wmHtmlSrc = el.innerHTML;
    const key = el.getAttribute('data-i18n-html');
    const translated = dict && dict[key];
    const html = translated || el.__wmHtmlSrc;
    if (html !== el.innerHTML) {
      el.__wmOutHtml = html;
      el.innerHTML = html;
    }
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== 1) return;
    if (root.hasAttribute && root.hasAttribute('data-i18n-html')) {
      translateHtmlBlock(root);
      return;
    }
    if (SKIP_TAGS.has(root.tagName)) return;
    translateAttributes(root);
    for (const el of root.querySelectorAll('*')) translateAttributes(el);
    const htmlBlocks = root.querySelectorAll('[data-i18n-html]');
    for (const block of htmlBlocks) translateHtmlBlock(block);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) translateTextNode(node);
  }

  function retranslateAll() {
    translateTree(document.body);
    document.title = translate('WiseM3U — configuration');
    const html = document.documentElement;
    html.lang = lang === 'zh' ? 'zh-CN' : lang;
  }

  function scheduleTranslate(nodes) {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const node of nodes) {
        if (node.nodeType === 3) translateTextNode(node);
        else if (node.nodeType === 1) translateTree(node);
      }
      nodes.length = 0;
    });
  }

  function startObserver() {
    if (observer) observer.disconnect();
    const pending = [];
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 || n.nodeType === 3) pending.push(n);
          }
        } else if (m.type === 'characterData') {
          const node = m.target;
          if (node.nodeValue === node.__wmOut) continue; // our translation
          node.__wmSrc = node.nodeValue;               // new text from the code
          pending.push(node);
        } else if (m.type === 'attributes') {
          const el = m.target;
          const attr = m.attributeName;
          const current = el.getAttribute(attr);
          if (el.__wmAttrsOut && el.__wmAttrsOut[attr] === current) continue; // our translation
          el.__wmAttrs = el.__wmAttrs || {};
          el.__wmAttrs[attr] = current; // the code wrote a new source value
          pending.push(el);
        }
      }
      if (pending.length) scheduleTranslate(pending);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
      characterDataOldValue: false,
    });
  }

  async function loadDictionary(code) {
    if (cache.has(code)) return cache.get(code);
    const res = await fetch(`/i18n/${code}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`translation ${code}: ${res.status}`);
    const data = await res.json();
    cache.set(code, data);
    return data;
  }

  async function setLanguage(code, options = {}) {
    const known = LANGS.some((l) => l.code === code);
    const target = known ? code : 'en';
    let data = null;
    try {
      data = await loadDictionary(target);
    } catch (err) {
      console.warn('[i18n]', err.message);
      code = 'en';
    }
    lang = known ? code : 'en';
    dict = data;
    patterns = dict ? compilePatterns(dict) : [];
    if (!options.silent) {
      localStorage.setItem(STORE_KEY, lang);
      const select = document.getElementById('langSelect');
      if (select) select.value = lang;
    }
    retranslateAll();
    document.dispatchEvent(new CustomEvent('wm:language', { detail: { language: lang } }));
    return lang;
  }

  function t(key) {
    if (!dict) return key;
    return dict[key] || key;
  }

  function locale() {
    return lang === 'zh' ? 'zh-CN' : lang === 'pt' ? 'pt-BR' : lang;
  }

  function init() {
    const select = document.getElementById('langSelect');
    if (select) {
      select.innerHTML = LANGS.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
      const saved = localStorage.getItem(STORE_KEY) || 'en';
      select.value = LANGS.some((l) => l.code === saved) ? saved : 'en';
      select.addEventListener('change', () => setLanguage(select.value));
    }

    // confirm/prompt/alert do not go through the DOM: translate the message here
    const nativeConfirm = window.confirm.bind(window);
    const nativePrompt = window.prompt.bind(window);
    const nativeAlert = window.alert.bind(window);
    window.confirm = (msg) => nativeConfirm(translate(msg));
    window.prompt = (msg, def) => nativePrompt(translate(msg), def);
    window.alert = (msg) => nativeAlert(translate(msg));

    const saved = localStorage.getItem(STORE_KEY) || 'en';
    setLanguage(saved, { silent: true }).finally(() => {
      startObserver();
      // the rest of the page may still be loading data: the observer covers new nodes
      setTimeout(retranslateAll, 300);
    });
  }

  window.WM_I18N = { languages: LANGS, setLanguage, t, translate, locale, getLanguage: () => lang };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
