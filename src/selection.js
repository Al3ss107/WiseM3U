'use strict';

/**
 * Branch selection: a branch (group containing channels) is active as long
 * as its path does not appear in disabledPaths. No trees, no whitelist:
 * a single list of disabled paths.
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
