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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-http-api-'));
process.env.BOARDS_FILE = path.join(TMP, 'boards.json');
process.env.TRUST_PROXY = '1';

const boards = require('./boards.js');
const runs = require('./runs.js');
const { registerValidator } = require('./run-validate.js');
const api = require('./http-api.js');

const START_VERDICTS = {
  NOWW: { ok: false, error: 'challenge_not_current', status: 409 },
  MISS: { ok: false, error: 'challenge_mismatch', status: 400 },
  MUTS: { ok: false, error: 'mutators_not_allowed', status: 400 },
  RACE: { ok: false, error: 'race_unknown', status: 400 },
  ODDD: { ok: false, error: 'something_else', status: 418 },
};
registerValidator('stub', {
  checkStart: body => START_VERDICTS[body.roomCode] || { ok: true },
  validate: ({ log }) => {
    if (log.explode) throw new Error('boom');
    if (log.forged) return { ok: false, reason: 'secret_reason_forged' };
    return { ok: true, value: log.score, ms: 300000, boards: ['shift:taxi:all', 'shift:taxi:2026-W48'], meta: { jobs: 3 } };
  },
});
registerValidator('shift', { validate: () => ({ ok: false, reason: 'unused' }) });
registerValidator('tiny', { maxLogBytes: 20, validate: () => ({ ok: true, value: 1, ms: 1, boards: ['shift:fire:all'] }) });

const logLines = [];
const originalLog = console.log;
console.log = (...parts) => { logLines.push(parts.join(' ')); originalLog(...parts); };

const server = http.createServer((req, res) => { if (!api.handleApi(req, res)) { res.writeHead(404); res.end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let ipCounter = 0;
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
function request(method, route, { body, rawBody, headers = {}, ip = freshIp(), keepOpen = false } = {}) {
  return new Promise(resolve => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const finalHeaders = { 'x-real-ip': ip, ...headers };
    if (payload !== undefined && !('content-type' in finalHeaders)) finalHeaders['content-type'] = 'application/json';
    if (payload !== undefined && !('content-length' in finalHeaders) && !('transfer-encoding' in finalHeaders)) {
      finalHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: finalHeaders }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', error => resolve({ status: 0, error }));
    if (keepOpen) req.write(payload);
    else req.end(payload);
  });
}
const post = (route, body, options = {}) => request('POST', route, { body, ...options });
const startStub = body => post('/runs/start', { mode: 'stub', roomCode: 'PTEST', ...body });
async function freshToken(body) { return (await startStub(body)).body.token; }

console.log('# headers, preflight, routing');
{
  const answer = await startStub({});
  ok(answer.status === 200 && answer.body.ok === true && typeof answer.body.token === 'string' && Number.isFinite(answer.body.startedAt), 'start answers {ok, token, startedAt}');
  ok(answer.headers['content-type'] === 'application/json; charset=utf-8', 'json content type');
  ok(answer.headers['cache-control'] === 'no-store', 'no-store');
  ok(answer.headers['access-control-allow-origin'] === '*', 'open CORS');
  ok(answer.headers['x-content-type-options'] === 'nosniff', 'nosniff');
  for (const route of ['/runs/start', '/runs/submit', '/boards']) {
    const preflight = await request('OPTIONS', route);
    ok(preflight.status === 204, `OPTIONS ${route} is 204`);
    ok(preflight.headers['access-control-allow-methods'] === 'GET, POST, OPTIONS'
      && preflight.headers['access-control-allow-headers'] === 'content-type'
      && preflight.headers['access-control-max-age'] === '600'
      && preflight.headers['access-control-allow-origin'] === '*', `preflight headers on ${route}`);
  }
  const wrongMethod = await request('GET', '/runs/start');
  ok(wrongMethod.status === 405 && wrongMethod.body.error === 'method_not_allowed', 'GET /runs/start is 405');
  ok((await request('DELETE', '/boards')).status === 405, 'DELETE /boards is 405');
  ok((await request('GET', '/not-an-api')).status === 404, 'unknown path left to the caller');
  ok((await request('GET', '/boards/extra')).status === 404, 'sub path of a route is not handled');
}

console.log('# body reader');
{
  const wrongType = await post('/runs/start', { mode: 'stub' }, { headers: { 'content-type': 'text/plain' } });
  ok(wrongType.status === 415 && wrongType.body.error === 'unsupported_type', '415 on text/plain');
  ok((await request('POST', '/runs/start', { rawBody: '{}', headers: { 'content-type': '' } })).status === 415, '415 without content type');
  const charsetOk = await post('/runs/start', { mode: 'stub', roomCode: 'PTEST' }, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  ok(charsetOk.status === 200, 'application/json with charset accepted');
  const oversized = await request('POST', '/runs/submit', { rawBody: 'x'.repeat(65_537) });
  ok(oversized.status === 413 && oversized.body.error === 'too_large', '413 at 65 537 bytes');
  ok(oversized.headers.connection === 'close', 'oversized request connection closed');
  const padding = 65_536 - JSON.stringify({ token: 'x', name: 'A', pad: '' }).length;
  const atLimit = await request('POST', '/runs/submit', { rawBody: JSON.stringify({ token: 'x', name: 'A', pad: 'p'.repeat(padding) }) });
  ok(atLimit.status === 401, 'a body of exactly 65 536 bytes is read (401 bad_token, not 413)');
  const streamed = await request('POST', '/runs/submit', { rawBody: 'y'.repeat(70_000), headers: { 'transfer-encoding': 'chunked' } });
  ok(streamed.status === 413 || streamed.status === 0, 'streamed overflow refused or socket destroyed');
  const badJson = await request('POST', '/runs/start', { rawBody: '{"mode":' });
  ok(badJson.status === 400 && badJson.body.error === 'bad_request', 'malformed JSON is 400');
  ok((await request('POST', '/runs/start', { rawBody: '[1,2]' })).body.error === 'bad_request', 'JSON array is 400');
  ok((await request('POST', '/runs/start', { rawBody: 'null' })).body.error === 'bad_request', 'JSON null is 400');
  api._setBodyTimeoutMs(200);
  const slow = await request('POST', '/runs/start', { rawBody: '{"mode":"st', headers: { 'content-length': 100 }, keepOpen: true });
  ok(slow.status === 408 && slow.body.error === 'timeout', '408 when the body does not arrive in time');
  ok(slow.headers.connection === 'close', 'slow request connection closed');
  api._reset();
}

console.log('# POST /runs/start');
{
  ok((await post('/runs/start', { mode: 'nope', roomCode: 'PTEST' })).body.error === 'unsupported_mode', 'unregistered mode is unsupported_mode');
  ok((await post('/runs/start', { roomCode: 'PTEST' })).status === 400, 'missing mode is 400');
  ok((await startStub({ roomCode: 'ab' })).body.error === 'bad_request', 'short room code refused');
  ok((await startStub({ roomCode: 'ABCDEFGHIJKLM' })).body.error === 'bad_request', '13-char room code refused');
  ok((await startStub({ roomCode: 'pt-st' })).body.error === 'bad_request', 'room code with a dash refused');
  const lower = await startStub({ roomCode: 'ptest' });
  ok(lower.status === 200 && runs.verify(lower.body.token).run.roomCode === 'PTEST', 'room code uppercased before the check');
  ok((await post('/runs/start', { mode: 'shift', roomCode: 'PSHIFT' })).body.error === 'bad_request', 'shift without job refused');
  ok((await post('/runs/start', { mode: 'shift', job: 'bus', roomCode: 'PSHIFT' })).body.error === 'bad_request', 'shift with unknown job refused');
  ok((await post('/runs/start', { mode: 'shift', job: 'fire', roomCode: 'PSHIFT' })).status === 200, 'shift with a known job accepted');
  ok((await startStub({ job: 'bus' })).body.error === 'bad_request', 'unknown job refused in any mode');
  ok((await startStub({ challengeId: 'daily:2026-11-27' })).status === 200, 'daily challenge id accepted');
  ok((await startStub({ challengeId: 'weekly:2026-W48' })).status === 200, 'weekly challenge id accepted');
  ok((await startStub({ challengeId: 'daily:2026-1-27' })).body.error === 'bad_request', 'malformed challenge id refused');
  ok((await startStub({ challengeId: ['daily:2026-11-27'] })).body.error === 'bad_request', 'challenge id as array refused');
  ok((await startStub({ race: 15 })).status === 200, 'race 15 accepted');
  ok((await startStub({ race: 16 })).body.error === 'bad_request', 'race 16 refused');
  ok((await startStub({ race: 1.5 })).body.error === 'bad_request', 'fractional race refused');
  const everyClaim = { job: 'ambulance', roomCode: 'ABCDEFGHIJKL', challengeId: 'weekly:2026-W48', race: 15 };
  ok((await startStub({ ...everyClaim, mutators: Array(5).fill('x'.repeat(24)) })).status === 200, 'every claim at its maximum with 5 long mutators fits a token');
  ok((await startStub({ ...everyClaim, mutators: Array(8).fill('x'.repeat(24)) })).body.error === 'bad_request', 'a token over 512 chars is never issued');
  const passed = await startStub({ roomCode: 'NOWW' });
  ok(passed.status === 409 && passed.body.error === 'challenge_not_current', 'checkStart challenge_not_current passed through as 409');
  ok((await startStub({ roomCode: 'MISS' })).body.error === 'challenge_mismatch', 'challenge_mismatch passed through');
  ok((await startStub({ roomCode: 'MUTS' })).body.error === 'mutators_not_allowed', 'mutators_not_allowed passed through');
  ok((await startStub({ roomCode: 'RACE' })).body.error === 'race_unknown', 'race_unknown passed through');
  const odd = await startStub({ roomCode: 'ODDD' });
  ok(odd.status === 400 && odd.body.error === 'bad_request', 'any other checkStart code answered as bad_request 400');
}

console.log('# POST /runs/submit');
{
  logLines.length = 0;
  const token = await freshToken({});
  const accepted = await post('/runs/submit', { token, name: '  Fede  ', log: { score: 4820 } });
  ok(accepted.status === 200 && accepted.body.ok === true && accepted.body.value === 4820, 'valid run accepted with its value');
  ok(accepted.body.boards.length === 2 && accepted.body.boards.every(board => board.rank === 1 && board.best === 4820 && board.improved === true), 'each board answered with rank, best, improved');
  ok(accepted.body.boards.map(board => board.id).join() === 'shift:taxi:all,shift:taxi:2026-W48', 'board ids from the validator');
  ok(boards.top('shift:taxi:all').entries[0].name === 'Fede', 'stored name normalized');
  const replay = await post('/runs/submit', { token, name: 'Fede', log: { score: 99999 } });
  ok(JSON.stringify(replay.body) === JSON.stringify(accepted.body) && replay.status === 200, 'replay answers the stored response');
  ok(boards.top('shift:taxi:all').entries[0].value === 4820, 'replay does not write again');

  const forgedToken = await freshToken({});
  const rejected = await post('/runs/submit', { token: forgedToken, name: 'Fede', log: { forged: true } });
  ok(rejected.status === 422 && rejected.body.error === 'rejected' && !JSON.stringify(rejected.body).includes('secret_reason'), 'validator rejection is 422 without the reason');
  const rejectionLine = logLines.find(line => line.includes('run-rejected'));
  ok(Boolean(rejectionLine) && rejectionLine.includes('stub') && rejectionLine.includes('secret_reason_forged') && /\b[0-9a-f]{12}$/.test(rejectionLine), 'rejection logged with mode, reason and a 12-hex IP hash');
  ok(!rejectionLine.includes('10.1.'), 'raw IP never logged');
  const rejectedReplay = await post('/runs/submit', { token: forgedToken, name: 'Fede', log: { score: 10 } });
  ok(rejectedReplay.status === 422, 'a rejected token stays consumed');

  const thrownToken = await freshToken({});
  const thrown = await post('/runs/submit', { token: thrownToken, name: 'Fede', log: { explode: true } });
  ok(thrown.status === 500 && thrown.body.error === 'server_error', 'a throwing validator answers server_error');
  ok(logLines.some(line => line.includes('validator-error') && line.includes('boom')), 'validator error logged server-side');
  const retriedAfterThrow = await post('/runs/submit', { token: thrownToken, name: 'Fede', log: { score: 5 } });
  ok(retriedAfterThrow.status === 200, 'a throwing validator does not consume the token');

  ok((await post('/runs/submit', { token: 'garbage', name: 'Fede', log: {} })).status === 401, 'bad token is 401');
  const expired = runs.issue({ mode: 'stub', roomCode: 'PTEST' }, Date.now() - runs.TOKEN_TTL_MS - 1000);
  const expiredAnswer = await post('/runs/submit', { token: expired.token, name: 'Fede', log: { score: 1 } });
  ok(expiredAnswer.status === 410 && expiredAnswer.body.error === 'token_expired', 'expired token is 410');

  const nameToken = await freshToken({});
  for (const [badName, label] of [['‮evil', 'bidi override'], ['<script>', '<script>'], ['abcdefghijklmno', '15 chars'], ['', 'empty'],
    ['   ', 'blank'], ['a​b', 'zero-width space'], ['a﻿b', 'BOM'], ['a b', 'no-break space'], ['a　b', 'ideographic space'], ['ok\u0007', 'control char'], ['Fede\u{1F600}', 'emoji'], [42, 'number']]) {
    const answer = await post('/runs/submit', { token: nameToken, name: badName, log: { score: 1 } });
    ok(answer.status === 400 && answer.body.error === 'bad_name', `bad name refused: ${label}`);
  }
  const unicodeName = await post('/runs/submit', { token: nameToken, name: "Zoë O'Neil-2", log: { score: 7 } });
  ok(unicodeName.status === 200, 'bad names do not consume the token; letters, digits, space, apostrophe and dash pass');
  ok(api.normalizeName('äbc  d') === 'äbc d', 'NFC and whitespace collapse');
  ok(api.normalizeName('abcdefghijklmn') === 'abcdefghijklmn', '14 chars accepted');
  ok(api.normalizeName('​ab') === null && api.normalizeName('ab‮') === null && api.normalizeName('﻿ab') === null, 'format chars refused');
  ok(api.normalizeName(' ab') === null && api.normalizeName('a　b') === null, 'non-ASCII spaces refused');
  ok(api.normalizeName(' \tab \t') === 'ab', 'surrounding space and tabs trimmed');

  const tinyToken = (await post('/runs/start', { mode: 'tiny', roomCode: 'PTEST' })).body.token;
  const tooBig = await post('/runs/submit', { token: tinyToken, name: 'Fede', log: { padding: 'x'.repeat(40) } });
  ok(tooBig.status === 413 && tooBig.body.error === 'too_large', 'maxLogBytes of the validator enforced');
  ok((await post('/runs/submit', { token: tinyToken, name: 'Fede', log: {} })).status === 200, 'oversized log does not consume the token');
}

console.log('# GET /boards');
{
  for (let index = 0; index < 60; index++) boards.submit('shift:pizza:all', { name: `P${index}`, value: index });
  const clamped = await request('GET', '/boards?id=shift:pizza:all&limit=500');
  ok(clamped.status === 200 && clamped.body.entries.length === 50 && clamped.body.total === 60, 'limit clamped to 50');
  ok((await request('GET', '/boards?id=shift:pizza:all&limit=0')).body.entries.length === 1, 'limit clamped to 1');
  ok((await request('GET', '/boards?id=shift:pizza:all&limit=-3')).body.entries.length === 1, 'negative limit clamped to 1');
  ok((await request('GET', '/boards?id=shift:pizza:all&limit=abc')).body.entries.length === 20, 'bad limit falls back to 20');
  ok((await request('GET', '/boards?id=shift:pizza:all')).body.entries.length === 20, 'default limit 20');
  const withMe = await request('GET', '/boards?id=shift:pizza:all&limit=5&name=%20p10%20');
  ok(withMe.body.me && withMe.body.me.value === 10 && withMe.body.me.rank === 50, 'name normalized and me returned');
  ok(withMe.body.order === 'desc' && withMe.body.entries[0].rank === 1 && withMe.body.entries[0].value === 59, 'entries ranked');
  ok(!('me' in (await request('GET', '/boards?id=shift:pizza:all&name=%3Cscript%3E')).body), 'bad name ignored on read');
  const badId = await request('GET', '/boards?id=shift:bus:all');
  ok(badId.status === 400 && badId.body.error === 'bad_request', 'bad board id is 400');
  ok((await request('GET', '/boards')).status === 400, 'missing board id is 400');
  const empty = await request('GET', '/boards?id=shift:fire:2026-W01');
  ok(empty.status === 200 && empty.body.total === 0 && empty.body.entries.length === 0, 'valid but empty board answers an empty list');
}

console.log('# rate limits');
{
  api._reset();
  const ip = '10.9.9.9';
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt++) statuses.push(await post('/runs/submit', { token: 'x' }, { ip }));
  ok(statuses.slice(0, 4).every(answer => answer.status === 401), 'submit burst of 4 passes');
  ok(statuses[4].status === 429 && statuses[4].body.error === 'rate_limited', 'fifth submit is 429');
  ok(Number(statuses[4].headers['retry-after']) >= 1, 'Retry-After in seconds');
  ok((await post('/runs/submit', { token: 'x' }, { ip: '10.9.9.10' })).status === 401, 'another IP has its own bucket');
  const startStatuses = [];
  for (let attempt = 0; attempt < 7; attempt++) startStatuses.push((await post('/runs/start', { mode: 'stub', roomCode: 'PTEST' }, { ip: '10.9.9.11' })).status);
  ok(startStatuses.slice(0, 6).every(status => status === 200) && startStatuses[6] === 429, 'start burst of 6 then 429');
  const boardStatuses = [];
  for (let attempt = 0; attempt < 21; attempt++) boardStatuses.push((await request('GET', '/boards?id=shift:taxi:all', { ip: '10.9.9.12' })).status);
  ok(boardStatuses.slice(0, 20).every(status => status === 200) && boardStatuses[20] === 429, 'boards burst of 20 then 429');
  ok((await request('OPTIONS', '/boards', { ip: '10.9.9.12' })).status === 204, 'preflight not rate limited');
  ok(api.GLOBAL_BUCKET_RATES.submit.perMinute === 600, 'global submit bucket 600 per minute');
}

console.log('# client IP and TRUST_PROXY');
{
  api._reset();
  delete process.env.TRUST_PROXY;
  const spoofed = [];
  for (let attempt = 0; attempt < 5; attempt++) spoofed.push((await post('/runs/submit', { token: 'x' }, { ip: `10.7.0.${attempt}` })).status);
  ok(spoofed[4] === 429, 'without TRUST_PROXY x-real-ip is ignored (one socket address, one bucket)');
  ok(api.clientIp({ headers: { 'x-real-ip': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } }) === '127.0.0.1', 'socket address used without TRUST_PROXY');
  process.env.TRUST_PROXY = '1';
  ok(api.clientIp({ headers: { 'x-real-ip': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } }) === '1.2.3.4', 'x-real-ip used with TRUST_PROXY=1');
  ok(api.clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }) === '127.0.0.1', 'socket address when the header is missing');
  ok((await post('/runs/submit', { token: 'x' }, { ip: '10.7.1.1' })).status === 401, 'with TRUST_PROXY=1 each x-real-ip has its own bucket');
  ok(/^[0-9a-f]{12}$/.test(api.hashIp('1.2.3.4')) && api.hashIp('1.2.3.4') !== api.hashIp('1.2.3.5'), '12-hex keyed IP hash');
  ok(api.hashIp('1.2.3.4') === runs.keyedHash('1.2.3.4').slice(0, 12) && api.hashIp('1.2.3.4') !== require('node:crypto').createHash('sha256').update('1.2.3.4').digest('hex').slice(0, 12), 'IP hash is keyed with the run secret');
  {
    const globalRate = api.GLOBAL_BUCKET_RATES.submit;
    const savedRate = { ...globalRate };
    api._reset();
    globalRate.burst = 2;
    const keyedIp = '10.7.7.7';
    for (let attempt = 0; attempt < 2; attempt++) await post('/runs/submit', { token: 'x' }, { ip: keyedIp });
    const refusedByGlobal = [await post('/runs/submit', { token: 'x' }, { ip: keyedIp }), await post('/runs/submit', { token: 'x' }, { ip: keyedIp })];
    ok(refusedByGlobal.every(answer => answer.status === 429), 'exhausted global submit bucket answers 429');
    globalRate.perMinute = 60_000_000;
    const afterRefill = [await post('/runs/submit', { token: 'x' }, { ip: keyedIp }), await post('/runs/submit', { token: 'x' }, { ip: keyedIp }), await post('/runs/submit', { token: 'x' }, { ip: keyedIp })];
    Object.assign(globalRate, savedRate);
    api._reset();
    ok(afterRefill[0].status === 401 && afterRefill[1].status === 401 && afterRefill[2].status === 429, 'global refusals do not spend the IP token');
  }
  for (let attempt = 0; attempt < 4; attempt++) await post('/runs/submit', { token: 'x' }, { ip: '10.6.6.6' });
  ok((await post('/runs/submit', { token: 'x' }, { ip: '10.6.6.6' })).status === 429, 'bucket exhausted before pruning');
  api.pruneIdleBuckets(Date.now() + 61_000);
  ok((await post('/runs/submit', { token: 'x' }, { ip: '10.6.6.6' })).status === 401, 'idle buckets pruned after a minute');
}

console.log('# registerApiRoute');
{
  api.registerApiRoute('GET', '/test-route', (req, res, { query, ip, now }) => ({ ok: true, echo: query.get('q'), ipSeen: ip, fresh: Number.isFinite(now) }), 'boards');
  api.registerApiRoute('POST', '/test-echo', (req, res, { body }) => ({ ok: true, got: body.value }), 'start');
  api.registerApiRoute('GET', '/test-error', () => ({ ok: false, error: 'challenge_not_current' }));
  api.registerApiRoute('GET', '/test-throw', () => { throw new Error('kaput'); });
  const echoed = await request('GET', '/test-route?q=hi', { ip: '10.5.5.5' });
  ok(echoed.status === 200 && echoed.body.echo === 'hi' && echoed.body.ipSeen === '10.5.5.5' && echoed.body.fresh, 'GET route dispatched with query, ip and now');
  ok(echoed.headers['access-control-allow-origin'] === '*' && echoed.headers['x-content-type-options'] === 'nosniff', 'registered route gets the API headers');
  ok((await post('/test-echo', { value: 'v' })).body.got === 'v', 'POST route gets the parsed body');
  ok((await post('/test-echo', { value: 'v' }, { headers: { 'content-type': 'text/plain' } })).status === 415, 'POST route shares the body reader');
  ok((await request('OPTIONS', '/test-route')).status === 204, 'registered route answers preflight');
  ok((await request('POST', '/test-route')).status === 405, 'registered route refuses other methods');
  ok((await request('GET', '/test-error')).status === 409, 'error payload mapped to its status');
  const crashed = await request('GET', '/test-throw');
  ok(crashed.status === 500 && crashed.body.error === 'server_error', 'throwing handler is 500 server_error');
  let threw = false;
  try { api.registerApiRoute('GET', '/test-bad', () => ({ ok: true }), 'nope'); } catch { threw = true; }
  ok(threw, 'unknown bucket name refused');
}

server.close();
console.log = originalLog;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
