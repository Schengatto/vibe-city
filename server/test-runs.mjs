import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('  OK ', message); } else { fail++; console.log('  XX FAIL:', message); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-runs-'));
process.env.BOARDS_FILE = path.join(TMP, 'boards.json');
const SECRET = 'test-secret-with-at-least-32-characters!';
process.env.RUNS_SECRET = SECRET;
process.env.TRUST_PROXY = '1';

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}
const signPayload = payload => {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadPart}.${crypto.createHmac('sha256', SECRET).update(payloadPart).digest('base64url')}`;
};
const decodePart = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const flipChar = (text, index) => text.slice(0, index) + (text[index] === 'A' ? 'B' : 'A') + text.slice(index + 1);

let boards = loadFresh('./boards.js');
let runs = loadFresh('./runs.js');
const NOW = Date.now();

console.log('# token round trip');
{
  const issued = runs.issue({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }, NOW);
  ok(issued.startedAt === NOW, 'startedAt is the server clock');
  ok(issued.token.length <= runs.MAX_TOKEN_LENGTH, 'token within 512 chars');
  const verified = runs.verify(issued.token, NOW + 1000);
  ok(verified.ok === true, 'fresh token verifies');
  ok(verified.run.mode === 'shift' && verified.run.job === 'taxi' && verified.run.roomCode === 'PSHIFT', 'mode, job and room carried');
  ok(verified.run.startedAt === NOW && /^[0-9a-f]{32}$/.test(verified.run.nonce), 'startedAt and 16-byte hex nonce carried');
  ok(verified.run.challengeId === null && verified.run.race === null && verified.run.mutators.length === 0, 'absent claims read as null / empty');
  const payload = decodePart(issued.token.split('.')[0]);
  ok(payload.v === 1 && payload.j === 'taxi' && !('c' in payload) && !('k' in payload) && !('u' in payload), 'payload carries only the given claims');
  const other = runs.issue({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }, NOW);
  ok(runs.verify(other.token, NOW).run.nonce !== verified.run.nonce, 'every token has its own nonce');
}

console.log('# optional claims: challenge, race, mutators (u)');
{
  const issued = runs.issue({ mode: 'race', roomCode: 'PRACE1', challengeId: 'daily:2026-11-27', race: 3, mutators: ['lowGravity', 'fog'] }, NOW);
  const payload = decodePart(issued.token.split('.')[0]);
  ok(Array.isArray(payload.u) && payload.u.join() === 'lowGravity,fog', 'mutators travel as u');
  ok(payload.c === 'daily:2026-11-27' && payload.k === 3, 'challenge as c and race as k');
  const { run } = runs.verify(issued.token, NOW);
  ok(run.mutators.join() === 'lowGravity,fog' && run.challengeId === 'daily:2026-11-27' && run.race === 3, 'verify exposes the claims');
  ok(!('u' in decodePart(runs.issue({ mode: 'race', roomCode: 'PRACE1', mutators: [] }, NOW).token.split('.')[0])), 'empty mutator list leaves u out');
}

console.log('# tampering');
{
  const { token } = runs.issue({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }, NOW);
  const [payloadPart, signaturePart] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ ...decodePart(payloadPart), j: 'fire' })).toString('base64url');
  ok(runs.verify(`${forgedPayload}.${signaturePart}`, NOW).error === 'bad_token', 'tampered payload refused');
  ok(runs.verify(`${payloadPart}.${flipChar(signaturePart, 5)}`, NOW).error === 'bad_token', 'tampered signature refused');
  ok(runs.verify(`${payloadPart}.${signaturePart.slice(0, -4)}`, NOW).error === 'bad_token', 'shorter signature refused before timingSafeEqual');
  ok(runs.verify(`${payloadPart}.${signaturePart}AAAA`, NOW).error === 'bad_token', 'longer signature refused');
  ok(runs.verify(`${payloadPart}.${signaturePart}.x`, NOW).error === 'bad_token', 'three parts refused');
  ok(runs.verify(`${payloadPart}.sig+/=`, NOW).error === 'bad_token', 'non base64url signature refused');
  ok(runs.verify(signPayload({ v: 1, n: 'a'.repeat(400), s: NOW, m: 'shift', r: 'PSHIFT' }), NOW).error === 'bad_token', 'validly signed token over 512 chars refused');
  ok(runs.verify(42, NOW).error === 'bad_token' && runs.verify(undefined, NOW).error === 'bad_token', 'non-string token refused');
  ok(runs.verify(signPayload({ v: 2, n: 'ab', s: NOW, m: 'shift', r: 'PSHIFT' }), NOW).error === 'bad_token', 'wrong version refused');
  ok(runs.verify(signPayload({ v: 1, s: NOW, m: 'shift', r: 'PSHIFT' }), NOW).error === 'bad_token', 'missing nonce refused');
  ok(runs.verify(signPayload({ v: 1, n: 'ab', s: NOW, m: 'shift', r: 'PSHIFT' }), NOW).ok === true, 'a correctly signed v1 payload verifies');
}

console.log('# expiry');
{
  const { token } = runs.issue({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }, NOW);
  ok(runs.TOKEN_TTL_MS === 3 * 3600 * 1000, 'TTL is 3 hours');
  ok(runs.verify(token, NOW + runs.TOKEN_TTL_MS).ok === true, 'token valid at exactly the TTL');
  ok(runs.verify(token, NOW + runs.TOKEN_TTL_MS + 1).error === 'token_expired', 'token past the TTL expired');
  ok(runs.verify(token, NOW - 1).error === 'bad_token', 'token from the future refused');
}

console.log('# single use through the boards nonce store');
{
  const { token } = runs.issue({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }, NOW);
  const { run } = runs.verify(token, NOW);
  ok(runs.storedResponse(run) === null, 'unused nonce has no stored response');
  const response = { ok: true, value: 10, boards: [] };
  ok(runs.consumeRun(run, response) === true, 'first consumption accepted');
  ok(runs.consumeRun(run, { ok: true, value: 99, boards: [] }) === false, 'second consumption refused');
  ok(runs.storedResponse(run).value === 10, 'replay returns the first stored response');
  boards.flush();
  const stored = JSON.parse(fs.readFileSync(process.env.BOARDS_FILE, 'utf8')).usedNonces[run.nonce];
  ok(stored && stored.exp === NOW + runs.TOKEN_TTL_MS, 'nonce stored with expiry startedAt + TTL');
  boards._reset();
  boards = loadFresh('./boards.js');
  runs = loadFresh('./runs.js');
  ok(runs.storedResponse(run) && runs.storedResponse(run).value === 10, 'consumed nonce survives a reload');
  ok(runs.verify(token, NOW).ok === true, 'fixed RUNS_SECRET keeps tokens valid across a reload');
}

console.log('# start body checks and replay over HTTP');
{
  const validate = loadFresh('./run-validate.js');
  loadFresh('./runs.js');
  const api = loadFresh('./http-api.js');
  let validatorCalls = 0;
  validate.registerValidator('shift', {
    validate: ({ log }) => { validatorCalls++; return { ok: true, value: log.score, ms: 300000, boards: ['shift:taxi:all'] }; },
  });
  const server = http.createServer((req, res) => { if (!api.handleApi(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let ipCounter = 0;
  const post = (route, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-real-ip': `10.0.0.${++ipCounter}` },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  const start = body => post('/runs/start', { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT', ...body });

  const good = await start({ mutators: ['fog', 'Rain2'] });
  ok(good.status === 200 && good.body.ok === true, 'start with valid mutators accepted');
  ok(decodePart(good.body.token.split('.')[0]).u.join() === 'fog,Rain2', 'mutators from the body land in u');
  ok((await start({ mutators: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] })).body.error === 'bad_request', '9 mutators refused');
  ok((await start({ mutators: ['bad-id'] })).body.error === 'bad_request', 'mutator id with a dash refused');
  ok((await start({ mutators: ['x'.repeat(25)] })).body.error === 'bad_request', 'mutator id over 24 chars refused');
  ok((await start({ mutators: [7] })).body.error === 'bad_request', 'non-string mutator refused');
  ok((await start({ mutators: 'fog' })).body.error === 'bad_request', 'mutators not an array refused');
  ok((await start({ mutators: ['x'.repeat(24), 'y'.repeat(24)] })).status === 200, 'two 24-char mutators accepted');

  const first = await post('/runs/submit', { token: good.body.token, name: 'Fede', log: { score: 500 } });
  ok(first.status === 200 && first.body.value === 500, 'first submit accepted');
  const replay = await post('/runs/submit', { token: good.body.token, name: 'Other', log: { score: 9000 } });
  ok(replay.status === 200 && JSON.stringify(replay.body) === JSON.stringify(first.body), 'replay returns the first answer verbatim');
  ok(validatorCalls === 1, 'replay never reaches the validator');
  const board = boards.top('shift:taxi:all', 50);
  ok(board.total === 1 && board.entries[0].value === 500 && board.entries[0].name === 'Fede', 'replay causes no second board write');
  server.close();
}

console.log('# validator registry and shared helpers');
{
  const validate = loadFresh('./run-validate.js');
  ok(validate.hasValidator('ghost') === false && validate.hasValidator(undefined) === false, 'unknown mode has no validator');
  validate.registerValidator('ghost', { validate: ctx => ({ ok: true, value: ctx.log.score, ms: 1, boards: [] }), maxLogBytes: 100 });
  ok(validate.hasValidator('ghost') && validate.validatorFor('ghost').maxLogBytes === 100 && validate.validatorFor('ghost').checkStart === null, 'registered with defaults');
  ok(validate.validateRun({ run: { mode: 'ghost' }, log: { score: 7 } }).value === 7, 'validateRun dispatches on run.mode');
  ok(validate.validateRun({ run: { mode: 'other' }, log: {} }).ok === false, 'validateRun refuses an unknown mode');
  let threw = false;
  try { validate.registerValidator('broken', {}); } catch { threw = true; }
  ok(threw, 'a validator needs a validate function');
  ok(Math.abs(validate.FRAME_MS - 1000 / 60) < 1e-9 && validate.framesToMs(18000) === 300000, 'FRAME_MS and framesToMs');
  const run = { startedAt: 1_000_000 };
  ok(validate.checkElapsed(18000, run, 1_000_000 + 300000) === null, 'exact elapsed passes');
  ok(validate.checkElapsed(18000, run, 1_000_000 + 298000) === null, 'within the 2 s slack passes');
  ok(validate.checkElapsed(18000, run, 1_000_000 + 297999) !== null, 'faster than frames allow fails');
  ok(validate.checkElapsed(18000, run, 1_000_000 + 900000) === null, '10-minute pause budget passes');
  ok(validate.checkElapsed(18000, run, 1_000_000 + 900001) !== null, 'beyond the pause budget fails');
  ok(validate.checkElapsed(18000, run, 1_000_000 + 303000, { leadMs: 3000, slackMs: 0, pauseBudgetMs: 0 }) === null, 'custom lead, slack and pause');
  ok(validate.clampPerMinute(50, 10, 60_000) === 10 && validate.clampPerMinute(3.7, 10, 60_000) === 3 && validate.clampPerMinute(NaN, 10, 1) === 0, 'clampPerMinute');
  ok(validate.isInt(3, 0, 5) && !validate.isInt(6, 0, 5) && !validate.isInt(1.5, 0, 5) && !validate.isInt('3', 0, 5), 'isInt');
  const sizes = ['PSHIFT', 'MABCD', 'GABCD', 'XABCD'].map(code => validate.worldSize(code));
  ok(sizes[0].w === 5888 && sizes[0].h === 5888 && sizes[1].w === 5888 && sizes[1].h === 11776
    && sizes[2].w === 11776 && sizes[3].w === 5888, 'worldSize from the first letter');
}

console.log('# pure scripts');
{
  const pure = loadFresh('./pure-scripts.js');
  const { jobScore, SHIFT_RULES_VERSION } = pure.loadPureScript('job-score.js', ['jobScore', 'SHIFT_RULES_VERSION']);
  ok(SHIFT_RULES_VERSION === 1, 'top-level const exposed');
  ok(jobScore({ job: 'taxi', pay: 40, tip: 20, timerLeft: 50, timerTotal: 100 }) === 200, 'jobScore runs in the vm');
  ok(pure.loadPureScript('job-score.js', ['jobScore']).jobScore === jobScore, 'file evaluated once and cached');
  const { globalThis: sandbox } = pure.loadPureScript('job-score.js', ['globalThis']);
  ok(typeof sandbox.require === 'undefined' && typeof sandbox.process === 'undefined' && typeof sandbox.module === 'undefined', 'no host globals in the sandbox');
  let threw = false;
  try { pure.loadPureScript('missing-file.js', ['x']); } catch { threw = true; }
  ok(threw, 'missing pure file throws');
  ok(pure.PURE_FILES.includes('job-score.js'), 'job-score.js listed in PURE_FILES');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
