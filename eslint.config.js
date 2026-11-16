'use strict';

/**
 * Lint di WiseM3U: errori bloccanti solo per problemi reali (variabili non
 * definite, chiavi/argomenti duplicati, codice irraggiungibile). Le regole di
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
    files: ['public/configure.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
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
