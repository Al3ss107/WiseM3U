'use strict';

/**
 * Selezione dei rami: un ramo (gruppo che contiene canali) e' attivo
 * finche' il suo path non compare in disabledPaths. Niente alberi,
 * niente whitelist: una sola lista di path disattivati.
 */

function makeBranchSelector(disabledPaths) {
  const disabled = new Set(disabledPaths || []);
  return (path) => !disabled.has(String(path == null ? '' : path));
}

function matchesKeywords(text, keywords) {
  if (!keywords || !keywords.length) return false;
  const hay = String(text || '').toLowerCase();
  return keywords.some((k) => k && hay.includes(String(k).toLowerCase()));
}

module.exports = { makeBranchSelector, matchesKeywords };
