import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const read = file => fs.readFileSync(path.join(jsDir, file), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

const RANKED_ANSWER = { ok: true, value: 4820, boards: [
  { id: 'shift:taxi:all', rank: 27, best: 4820, improved: true },
  { id: 'shift:taxi:2026-W48', rank: 3, best: 4820, improved: true },
] };
const jsonResponse = answer => Promise.resolve({ json: () => Promise.resolve(answer) });
const hangingFetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
const answerByPath = answers => url => jsonResponse(answers[new URL(url).pathname]);

function makeElement() {
  const classes = new Set(['hidden']);
  return { textContent: '', classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
}

function makeContext(fetchHandler) {
  const calls = [];
  const delays = [];
  const callsAtDelay = [];
  const element = makeElement();
  const context = vm.createContext({
    console, AbortController, URLSearchParams,
    fetch: (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return fetchHandler(url, init); },
    setTimeout: (callback, ms) => { delays.push(ms); callsAtDelay.push(calls.length); setImmediate(callback); return delays.length; },
    clearTimeout: () => {},
    $: selector => (selector === '#runBoardStatus' ? element : null),
  });
  vm.runInContext(`
    var matchElapsedFrames = 0;
    var playerName = 'Ada';
    var serverUrlForTest = 'ws://localhost:8787/';
    var netServerUrl = () => serverUrlForTest;
    var serverHttpBase = serverUrl => serverUrl.replace(/^ws/, 'http').replace(/\\/+$/, '');
    var t = (key, params) => (params ? key + ':' + Object.values(params).join(',') : key);
    var nowForTest = 1000;
    Date.now = () => nowForTest;
  `, context);
  for (const file of ['game-events.js', 'job-score.js', 'run.js', 'run-log.js', 'run-client.js']) vm.runInContext(read(file), context, { filename: file });
  return { context, calls, delays, callsAtDelay, element };
}

function playShift(harness, { mutators = [], mode = 'shift', outcome = 'time', score = 100 } = {}) {
  vm.runInContext(`
    gameEvents.enabled = true;
    runConfig = { mode: '${mode}', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: ${JSON.stringify(mutators)} };
    startRun();
  `, harness.context);
  return settle().then(() => {
    vm.runInContext(`matchElapsedFrames = 18000; runState.score = ${score}; finishRun('${outcome}');`, harness.context);
    return settle();
  });
}

const submitCalls = calls => calls.filter(call => call.url.endsWith('/runs/submit'));
const startCalls = calls => calls.filter(call => call.url.endsWith('/runs/start'));
const okAnswers = { '/runs/start': { ok: true, token: 'tok', startedAt: 1 }, '/runs/submit': RANKED_ANSWER };

console.log('1) token only for a shift with empty mutators');
let harness = makeContext(answerByPath(okAnswers));
await playShift(harness, { outcome: 'quit' });
ok(startCalls(harness.calls).length === 1, 'shift without mutators asks a token');
ok(JSON.stringify(startCalls(harness.calls)[0].body) === JSON.stringify({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }), 'start body carries mode, job and roomCode');
ok(startCalls(harness.calls)[0].url === 'http://localhost:8787/runs/start', 'base URL from netServerUrl, ws to http, trailing slash stripped');
harness = makeContext(answerByPath(okAnswers));
await playShift(harness, { mutators: ['lowGravity'] });
ok(harness.calls.length === 0, 'shift with mutators asks no token and submits nothing');
harness = makeContext(answerByPath(okAnswers));
await playShift(harness, { mode: 'race' });
ok(harness.calls.length === 0, 'other modes ask no token');

console.log('2) submit only on complete === true');
harness = makeContext(answerByPath(okAnswers));
await playShift(harness, { outcome: 'quit' });
ok(submitCalls(harness.calls).length === 0 && harness.element.classList.contains('hidden'), "finishRun('quit') never submits and shows no status");
harness = makeContext(answerByPath(okAnswers));
await playShift(harness);
const submitted = submitCalls(harness.calls);
ok(submitted.length === 1 && submitted[0].body.token === 'tok' && submitted[0].body.name === 'Ada', 'completed shift submits token and name');
ok(submitted[0].body.log.v === 1 && submitted[0].body.log.frames === 18000 && submitted[0].body.log.job === 'taxi', 'submitted log is the encoded shift log');

console.log('3) ranked status line');
const rankedText = harness.element.textContent;
ok(!harness.element.classList.contains('hidden'), 'status line visible');
ok(rankedText.startsWith('board.status.label  '), 'status line starts with the label');
ok(rankedText.indexOf('board.rankWeek:3,shift.job.taxi') > 0 && rankedText.indexOf('board.rankWeek') < rankedText.indexOf('board.rankAll:27,shift.job.taxi'), 'weekly rank then all-time rank');
ok(rankedText.endsWith('board.newBest'), 'new best marker when a board improved');

console.log('4) 8 s timeout and one retry after 3 s on network error');
harness = makeContext(hangingFetch);
const timedOut = await vm.runInContext("runClient.submit('tok', { v: 1 })", harness.context);
ok(harness.calls.length === 2, 'two attempts in total');
ok(harness.delays.filter(ms => ms === 8000).length === 2, 'each attempt has an 8 s abort timer');
ok(harness.delays.includes(3000) && harness.delays.indexOf(3000) === 1, 'retry waits 3 s after the first failure');
ok(timedOut.ok === false && timedOut.error === 'network', 'network error after the retry');
harness = makeContext(() => jsonResponse({ ok: false, error: 'rejected' }));
const refused = await vm.runInContext("runClient.submit('tok', { v: 1 })", harness.context);
ok(harness.calls.length === 1 && refused.error === 'rejected', 'a server answer is never retried');
let attempts = 0;
harness = makeContext(() => (++attempts === 1 ? Promise.reject(new TypeError('Failed to fetch')) : jsonResponse(RANKED_ANSWER)));
const recovered = await vm.runInContext("runClient.submit('tok', { v: 1 })", harness.context);
ok(harness.calls.length === 2 && recovered.ok === true, 'second attempt succeeds after a network error');
harness = makeContext(answerByPath(okAnswers));
vm.runInContext('serverUrlForTest = null', harness.context);
const noServerStart = await vm.runInContext("runClient.start({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' })", harness.context);
ok(noServerStart === null && harness.calls.length === 0, 'no server: start resolves null without a request');

console.log('5) status per server answer');
const statusFor = answer => vm.runInContext(`runBoardStatusFor(${JSON.stringify(answer)})`, harness.context);
const expectedStatus = {
  bad_name: 'badName', bad_token: 'serverRestarted', token_expired: 'pausedTooLong', too_large: 'tooLong', rejected: 'rejected',
  rate_limited: 'offline', server_error: 'offline', network: 'offline', bad_request: 'offline',
};
for (const [error, state] of Object.entries(expectedStatus)) ok(statusFor({ ok: false, error }) === state, `${error} -> ${state}`);
ok(statusFor(RANKED_ANSWER) === 'ranked', 'ok -> ranked');
for (const [error, key] of [['bad_token', 'board.status.serverRestarted'], ['token_expired', 'board.status.pausedTooLong'], ['bad_name', 'board.status.badName'], ['rejected', 'board.status.rejected']]) {
  harness = makeContext(answerByPath({ ...okAnswers, '/runs/submit': { ok: false, error } }));
  await playShift(harness);
  ok(harness.element.textContent === 'board.status.label  ' + key, `${error} answer shows ${key}`);
}
harness = makeContext(answerByPath({ ...okAnswers, '/runs/start': { ok: false, error: 'rate_limited' } }));
await playShift(harness);
ok(submitCalls(harness.calls).length === 0 && harness.element.textContent.endsWith('board.status.offline'), 'no token: not submitted, offline');
harness = makeContext(answerByPath(okAnswers));
vm.runInContext("playerName = ''", harness.context);
await playShift(harness);
ok(submitCalls(harness.calls).length === 0 && harness.element.textContent.endsWith('board.status.noName'), 'empty name: not submitted, set a name');
harness = makeContext(answerByPath(okAnswers));
await playShift(harness, { score: 0 });
ok(submitCalls(harness.calls).length === 0 && harness.element.classList.contains('hidden'), 'zero score: not submitted, status stays hidden');
harness = makeContext(answerByPath(okAnswers));
await playShift(harness);
ok(!harness.element.classList.contains('hidden'), 'ranked run shows the status');
await playShift(harness, { score: 0 });
ok(submitCalls(harness.calls).length === 1 && harness.element.classList.contains('hidden'), 'zero-score run after a ranked run hides the stale status');
harness = makeContext(answerByPath(okAnswers));
vm.runInContext('gameEvents.on("run:start", () => { runState.logTruncated = true; })', harness.context);
await playShift(harness);
ok(submitCalls(harness.calls).length === 0 && harness.element.textContent.endsWith('board.status.tooLong'), 'truncated log: not submitted, too long');
harness = makeContext(answerByPath(okAnswers));
vm.runInContext('gameEvents.on("run:start", () => { nowForTest += 300000 + 600001; })', harness.context);
await playShift(harness);
ok(submitCalls(harness.calls).length === 0 && harness.element.textContent.endsWith('board.status.pausedTooLong'), 'paused past the budget: not submitted');
harness = makeContext(() => new Promise(() => {}));
vm.runInContext("gameEvents.enabled = true; runConfig = { mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: [] }; startRun(); matchElapsedFrames = 18000; runState.score = 100; finishRun('time');", harness.context);
await settle();
ok(harness.element.textContent.endsWith('board.status.sending'), 'sending while the token or submit is pending');

console.log('6) boards URL');
harness = makeContext(answerByPath(okAnswers));
ok(vm.runInContext("runClient.boardsUrl('shift:taxi:all', 20, 'Ada')", harness.context) === 'http://localhost:8787/boards?id=shift%3Ataxi%3Aall&limit=20&name=Ada', 'boards URL with id, limit and name');
vm.runInContext('serverUrlForTest = null', harness.context);
ok(vm.runInContext("runClient.boardsUrl('shift:taxi:all', 20)", harness.context) === null, 'no server: null boards URL');

console.log('7) submit waits for the real shift time counted from the token answer');
let releaseStart;
const delayedStart = new Promise(resolve => { releaseStart = resolve; });
harness = makeContext(url => (url.endsWith('/runs/start') ? delayedStart.then(() => ({ json: () => Promise.resolve(okAnswers['/runs/start']) })) : jsonResponse(RANKED_ANSWER)));
vm.runInContext("gameEvents.enabled = true; runConfig = { mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: [] }; startRun(); matchElapsedFrames = 18000; runState.score = 100; finishRun('time');", harness.context);
await settle();
ok(submitCalls(harness.calls).length === 0 && harness.element.textContent.endsWith('board.status.sending'), 'sending while the start answer is late');
vm.runInContext('nowForTest += 295000', harness.context);
releaseStart();
await settle();
const shiftWaitIndex = harness.delays.findIndex(delay => Math.abs(delay - 300000) < 1);
ok(shiftWaitIndex >= 0, 'full shift time awaited after the late token answer, not the time already elapsed locally');
ok(harness.callsAtDelay[shiftWaitIndex] === 1 && submitCalls(harness.calls).length === 1, 'submit goes out only after the wait');

console.log('8) hardening');
harness = makeContext(answerByPath({ ...okAnswers, '/runs/submit': { ok: true, value: 10 } }));
await playShift(harness);
ok(harness.element.textContent.endsWith('board.status.offline'), 'ok answer without boards ends in the offline status');
const weeklyOnlyImproved = { ok: true, value: 1, boards: [
  { id: 'shift:taxi:all', rank: 9, best: 5000, improved: false },
  { id: 'shift:taxi:2026-W48', rank: 2, best: 100, improved: true },
] };
harness = makeContext(answerByPath({ ...okAnswers, '/runs/submit': weeklyOnlyImproved }));
await playShift(harness);
ok(harness.element.textContent.includes('board.rankAll:9') && !harness.element.textContent.includes('board.newBest'), 'weekly-only improvement shows no new best');
harness = makeContext(answerByPath(okAnswers));
vm.runInContext("gameEvents.enabled = true; runConfig = { mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: [] }; startRun(); matchElapsedFrames = 18000; gameEvents.emit('run:end', { complete: 'true', frame: 18000, job: 'taxi' });", harness.context);
await settle();
ok(submitCalls(harness.calls).length === 0, 'non-boolean complete never submits');

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
