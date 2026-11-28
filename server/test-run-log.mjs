import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.resolve(serverDir, '..', 'js');
const read = file => fs.readFileSync(path.join(jsDir, file), 'utf8');

process.env.BOARDS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-run-log-')), 'boards.json');
const { validateRun } = require('./run-validate.js');
require('./validators');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

function makeContext() {
  const context = vm.createContext({ console });
  vm.runInContext(`
    var matchElapsedFrames = 0;
    var playerName = 'Ada';
    var store = { data: {}, set(key, value) { this.data[key] = value; } };
    var $ = () => null;
    var t = key => key;
  `, context);
  for (const file of ['game-events.js', 'job-score.js', 'run.js', 'run-log.js']) vm.runInContext(read(file), context, { filename: file });
  return context;
}
const evaluate = (context, source) => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context));

console.log('1) tuple shapes on a scripted runState.log');
let context = makeContext();
const scriptedState = {
  mode: 'shift', job: 'taxi', score: 4820, startFrame: 100, logTruncated: false,
  log: [
    { type: 'run:start', frame: 100, mode: 'shift', job: 'taxi', rules: 1, mutators: [] },
    { type: 'vehicle:enter', frame: 100, vehicleKind: 'taxi' },
    { type: 'job:pickup', frame: 220, job: 'taxi', x: 1840.4, y: 2210.6 },
    { type: 'job:start', frame: 220, job: 'taxi', x: 1840.4, y: 2210.6, pay: 40, timerTotal: 712 },
    { type: 'job:start', frame: 230, job: 'pizza', x: 10, y: 10, pay: 20, timerTotal: 300 },
    { type: 'job:complete', frame: 1030, job: 'taxi', x: 3120.2, y: 2209.7, pay: 40, tip: 20, timerLeft: 105, timerTotal: 712, distance: 1280.49 },
    { type: 'vehicle:damage', frame: 1055, amount: 12.4, vehicleKind: 'taxi' },
    { type: 'wanted:change', frame: 1060, from: 0, to: 1 },
    { type: 'kill', frame: 1070, victimKind: 'cop' },
    { type: 'job:fail', frame: 4500, job: 'taxi', reason: 'late' },
    { type: 'job:fail', frame: 4510, job: 'pizza', reason: 'late' },
    { type: 'player:down', frame: 9100, reason: 'busted' },
    { type: 'combo:change', frame: 9200, multiplier: 1.5, streak: 3.2 },
    { type: 'combo:break', frame: 9300, reason: 'job.fail', multiplier: 1.5 },
    { type: 'run:end', frame: 18100, mode: 'shift', job: 'taxi', score: 4820, complete: true },
  ],
};
context.scriptedState = scriptedState;
const encoded = evaluate(context, 'encodeShiftLog(scriptedState, 18000)');
ok(same(encoded.events, [
  ['jp', 120, 1840, 2211],
  ['js', 120, 1840, 2211, 40, 712],
  ['jc', 930, 3120, 2210, 40, 20, 105, 712, 1280],
  ['vd', 955, 12],
  ['jf', 4400, 'late'],
  ['pd', 9000, 'busted'],
  ['cc', 9100, 1.5, 3],
  ['cb', 9200, 'job.fail', 1.5],
]), 'one tuple per encoded type, frames relative to startFrame, integers rounded, multiplier kept');
ok(!encoded.events.some(tuple => tuple[0] === 'k'), 'no k tuple');
ok(!encoded.events.some(tuple => tuple[2] === 10), 'job events of another job are dropped');
ok(same({ ...encoded, events: undefined }, { v: 1, rules: 1, job: 'taxi', minutes: 5, frames: 18000, score: 4820, mutators: [] }),
  'header v, rules, job, minutes, frames, score, mutators');
ok(encoded.events.every(tuple => tuple[1] >= 0 && tuple[1] <= encoded.frames), 'every f within [0, frames]');

console.log('2) truncated log');
context.truncatedState = { ...scriptedState, logTruncated: true };
ok(evaluate(context, 'encodeShiftLog(truncatedState, 18000)') === null, 'null when logTruncated');

console.log('3) bus-recorded shift accepted by the real shift validator');
context = makeContext();
vm.runInContext(`
  gameEvents.enabled = true;
  matchElapsedFrames = 60;
  runConfig = { mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: [] };
  startRun();
  gameEvents.on('job:complete', payload => { if (payload.job === runState.job) runState.score += jobScore(payload); });
  const at = (frame, type, payload) => { matchElapsedFrames = 60 + frame; gameEvents.emit(type, payload); };
  at(120, 'job:pickup', { job: 'taxi', x: 1840.4, y: 2210.6 });
  at(120, 'job:start', { job: 'taxi', x: 1840.4, y: 2210.6, pay: 35, timerTotal: 640 });
  at(150, 'job:start', { job: 'pizza', x: 900, y: 900, pay: 30, timerTotal: 500 });
  at(300, 'vehicle:damage', { amount: 2, vehicleKind: 'taxi' });
  at(320, 'vehicle:damage', { amount: 7.6, vehicleKind: 'taxi' });
  at(330, 'kill', { victimKind: 'civ' });
  at(400, 'job:complete', { job: 'taxi', x: 2840.7, y: 2210.6, pay: 35, tip: 20, timerLeft: 360, timerTotal: 640, distance: 1000.4 });
  at(500, 'job:pickup', { job: 'taxi', x: 2700, y: 2300 });
  at(500, 'job:start', { job: 'taxi', x: 2700, y: 2300, pay: 35, timerTotal: 640 });
  at(1140, 'job:fail', { job: 'taxi', reason: 'late' });
  at(1300, 'player:down', { reason: 'busted' });
  at(1310, 'job:pickup', { job: 'taxi', x: 1000, y: 1000 });
  at(1310, 'job:start', { job: 'taxi', x: 1000, y: 1000, pay: 35, timerTotal: 560 });
  at(1700, 'job:complete', { job: 'taxi', x: 1000, y: 1800.2, pay: 35, tip: 20, timerLeft: 170, timerTotal: 560, distance: 800.2 });
  matchElapsedFrames = 60 + 18000;
`, context);
const busLog = evaluate(context, 'encodeShiftLog(runState, matchElapsedFrames - runState.startFrame)');
ok(busLog.frames === 18000 && busLog.events.length === 11, 'frames counted from the run start, eleven tuples encoded');
ok(same(busLog.events.find(tuple => tuple[0] === 'vd'), ['vd', 320, 8]), 'damage under the run.js minimum is not recorded, the rest is rounded');
const startedAt = Date.UTC(2026, 10, 25, 12);
const run = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT', mutators: [], startedAt, nonce: 'nonce' };
const verdict = validateRun({ run, log: busLog, name: 'ADA', now: startedAt + 300000 + 5000 });
ok(verdict.ok === true && verdict.value === busLog.score && busLog.score > 0, 'shift validator accepts the encoded log (' + JSON.stringify(verdict) + ')');
ok(same(verdict.boards, ['shift:taxi:all', 'shift:taxi:2026-W48']), 'validator answers the taxi boards');

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
