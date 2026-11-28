'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PURE_DIRS = [path.resolve(__dirname, 'sim'), path.resolve(__dirname, '..', 'js')];
const PURE_FILES = ['job-score.js'];
const RUN_TIMEOUT_MS = 1000;

const contexts = new Map();

function contextFor(relPath) {
  if (contexts.has(relPath)) return contexts.get(relPath);
  const filePath = PURE_DIRS.map(dir => path.join(dir, relPath)).find(candidate => fs.existsSync(candidate));
  if (!filePath) throw new Error(`pure script ${relPath} not found in ${PURE_DIRS.join(' | ')}`);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: relPath, timeout: RUN_TIMEOUT_MS });
  contexts.set(relPath, context);
  return context;
}

function loadPureScript(relPath, names) {
  return vm.runInContext(`({${names.join(', ')}})`, contextFor(relPath), { timeout: RUN_TIMEOUT_MS });
}

module.exports = { loadPureScript, PURE_FILES, PURE_DIRS };
