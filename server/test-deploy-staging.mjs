import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('  OK ', message); } else { fail++; console.log('  XX FAIL:', message); }
};

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SERVER_DIR, '..');
const VALIDATORS_DIR = path.join(SERVER_DIR, 'validators');
const dockerfile = fs.readFileSync(path.join(SERVER_DIR, 'Dockerfile'), 'utf8');
const deployWorkflow = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'deploy.yml'), 'utf8');
const { PURE_FILES } = require('./pure-scripts.js');

console.log('# Dockerfile');
{
  ok(/^COPY \*\.js \.\/$/m.test(dockerfile), 'copies every server *.js');
  ok(/^COPY validators \.\/validators$/m.test(dockerfile), 'copies the validators folder');
  ok(/^COPY sim \.\/sim$/m.test(dockerfile), 'copies the staged sim folder');
}

console.log('# deploy workflow');
{
  ok(/cp [^\n]*server\/\*\.js/.test(deployWorkflow), 'copies server/*.js into the release');
  ok(/cp -r server\/validators release\/validators/.test(deployWorkflow), 'copies server/validators/ into the release');
  ok(deployWorkflow.includes(`require('./server/pure-scripts.js').PURE_FILES.join(' ')`), 'reads PURE_FILES from server/pure-scripts.js');
  ok(/for file in \$pure_files; do cp "js\/\$file" release\/sim\/; done/.test(deployWorkflow), 'stages every PURE_FILES entry into release/sim');
}

console.log('# PURE_FILES');
{
  ok(Array.isArray(PURE_FILES) && PURE_FILES.includes('job-score.js'), 'job-score.js is a pure file');
  for (const file of PURE_FILES) ok(fs.existsSync(path.join(ROOT_DIR, 'js', file)), `js/${file} exists`);
}

console.log('# local requires resolve');
{
  const sources = [
    ...fs.readdirSync(SERVER_DIR).filter(file => file.endsWith('.js')).map(file => path.join(SERVER_DIR, file)),
    ...fs.readdirSync(VALIDATORS_DIR).filter(file => file.endsWith('.js')).map(file => path.join(VALIDATORS_DIR, file)),
  ];
  for (const sourcePath of sources) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    for (const [, target] of source.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
      let resolved = null;
      try { resolved = require.resolve(path.resolve(path.dirname(sourcePath), target)); } catch {}
      ok(Boolean(resolved), `${path.relative(SERVER_DIR, sourcePath)} -> ${target} exists`);
    }
  }
  ok(fs.existsSync(path.join(VALIDATORS_DIR, 'index.js')), 'validators/index.js exists');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
