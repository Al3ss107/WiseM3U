'use strict';

/**
 * WiseM3U lint: blocking errors only for real problems (undefined
 * variables, duplicate keys/arguments, unreachable code). Style rules
 * stile non sono imposte: il codebase ha una formattazione coerente e un
 * riformattamento massivo renderebbe il diff illeggibile.
 */

const globals = require('globals');

module.exports = [
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
    },
  },
  {
    files: ['public/configure.js', 'public/i18n.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, WM_I18N: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
    },
  },
];
