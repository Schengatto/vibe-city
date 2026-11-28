import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('  OK ', message); } else { fail++; console.log('  XX FAIL:', message); }
};

process.env.BOARDS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-shift-validator-')), 'boards.json');

const { validateRun, hasValidator, validatorFor } = require('./run-validate.js');
require('./validators');
const { checkShiftLog, shiftScoreExtras } = require('./validators/shift.js');
const { loadPureScript } = require('./pure-scripts.js');
const { jobScore, SHIFT_MINUTES, SHIFT_RULES_VERSION } = loadPureScript('job-score.js', ['jobScore', 'SHIFT_MINUTES', 'SHIFT_RULES_VERSION']);

const fareTip = (pay, timerLeft) => timerLeft > 0 ? Math.ceil(pay * 0.5 / 5) * 5 : 0;
const quickBonus = (pay, timerLeft, timerTotal) => timerLeft > timerTotal * 0.5 ? 20 : 0;
const MISSION_FORMULAS = {
  taxi: { pay: distance => 15 + Math.round(distance * 0.022 / 5) * 5, timer: distance => Math.round(distance / 2.5) + 240, tip: fareTip, pickup: true },
  pizza: { pay: distance => 20 + Math.round(distance * 0.025 / 5) * 5, timer: distance => Math.round(distance / 2.6) + 240, tip: fareTip, pickup: true },
  ambulance: { pay: distance => 30 + Math.round(distance * 0.03 / 5) * 5, timer: distance => Math.round(distance / 2.5) + 240, tip: fareTip, pickup: true },
  patrol: { pay: () => 45, timer: distance => Math.round(distance / 2.2) + 840, tip: quickBonus, pickup: false },
  fire: { pay: distance => 35 + Math.round(distance * 0.02 / 5) * 5, timer: distance => Math.round(distance / 2.2) + 960, tip: quickBonus, pickup: false },
};
const JOBS = Object.keys(MISSION_FORMULAS);
const DEFAULT_JOBS = Array.from({ length: 10 }, (_, index) => ({ distance: 1000 + index * 50, pxPerFrame: index === 9 ? 1 : 6 }));
const STARTED_AT = Date.UTC(2026, 10, 25, 12);
const SHIFT_FRAMES = SHIFT_MINUTES * 3600;
const PLAYED_MS = SHIFT_FRAMES * 1000 / 60;
const NOW = STARTED_AT + PLAYED_MS + 5000;

const runFor = job => ({ mode: 'shift', job, roomCode: 'PSHIFT', mutators: [], startedAt: STARTED_AT, nonce: 'nonce' });

function jobEvents(job, startFrame, { distance, pxPerFrame = 6, timerScale = 1, payDelta = 0, timerDelta = 0 }) {
  const formula = MISSION_FORMULAS[job];
  const pay = formula.pay(distance) + payDelta;
  const timerTotal = Math.round(formula.timer(distance) * timerScale) + timerDelta;
  const travelFrames = Math.ceil(distance / pxPerFrame);
  const timerLeft = Math.max(0, timerTotal - travelFrames);
  const tip = formula.tip(pay, timerLeft, timerTotal);
  const endFrame = startFrame + travelFrames;
  const pickup = formula.pickup ? [['jp', startFrame, 1200, 1300]] : [];
  return {
    events: [...pickup, ['js', startFrame, 1200, 1300, pay, timerTotal], ['jc', endFrame, 2200, 1300, pay, tip, timerLeft, timerTotal, distance]],
    endFrame,
    points: jobScore({ job, pay, tip, timerLeft, timerTotal }),
  };
}

function shiftLog(job, { firstJob = {}, gapFrames = 200, timerScale = 1 } = {}) {
  const events = [];
  let frame = 120, score = 0;
  DEFAULT_JOBS.forEach((defaults, index) => {
    const built = jobEvents(job, frame, { ...defaults, timerScale, ...(index === 0 ? firstJob : {}) });
    events.push(...built.events);
    score += built.points;
    frame = built.endFrame + gapFrames;
  });
  return { v: 1, rules: SHIFT_RULES_VERSION, job, minutes: SHIFT_MINUTES, frames: SHIFT_FRAMES, score, mutators: [], events };
}

const mutated = (log, change) => { const copy = structuredClone(log); change(copy); return copy; };
const lastFrame = log => log.events[log.events.length - 1][1];
const verdictOf = (log, { job = log.job, now = NOW } = {}) => validateRun({ run: runFor(job), log, name: 'FEDE', now });
const reasonOf = (log, options) => verdictOf(log, options).reason;

console.log('# registry');
{
  ok(hasValidator('shift'), 'shift validator registered through validators/index.js');
  ok(typeof validatorFor('shift').checkStart === 'function', 'shift validator has a checkStart');
}

console.log('# valid 5-minute shift per job');
for (const job of JOBS) {
  const log = shiftLog(job);
  const verdict = verdictOf(log);
  const completions = log.events.filter(tuple => tuple[0] === 'jc');
  const recomputed = completions.reduce((sum, [, , , , pay, tip, timerLeft, timerTotal]) => sum + jobScore({ job, pay, tip, timerLeft, timerTotal }), 0);
  ok(verdict.ok && verdict.value === recomputed && recomputed === log.score && recomputed > 0, `${job}: passes, value ${verdict.value} equals the sum of jobScore`);
  ok(verdict.meta && verdict.meta.jobs === 10 && Math.abs(verdict.ms - PLAYED_MS) < 1, `${job}: meta.jobs 10 and ms from frames`);
  ok(verdict.boards && verdict.boards.join() === `shift:${job}:all,shift:${job}:2026-W48`, `${job}: all-time and ISO-week board ids`);
}
{
  const tips = shiftLog('taxi').events.filter(tuple => tuple[0] === 'jc').map(tuple => tuple[5]);
  const bonuses = shiftLog('patrol').events.filter(tuple => tuple[0] === 'jc').map(tuple => tuple[5]);
  ok(tips.includes(0) && tips.some(tip => tip > 0), 'fixture covers taxi rides with and without a tip');
  ok(bonuses.includes(0) && bonuses.includes(20), 'fixture covers patrol arrests with and without the bonus');
}

console.log('# header');
{
  const log = shiftLog('taxi');
  ok(reasonOf(mutated(log, copy => { copy.rules = 99; })) === 'rules_version', 'unknown rules version -> rules_version');
  ok(reasonOf(mutated(log, copy => { delete copy.rules; })) === 'rules_version', 'missing rules version -> rules_version');
  ok(reasonOf(mutated(log, copy => { copy.v = 2; })) === 'shape', 'log version 2 -> shape');
  ok(reasonOf(null, { job: 'taxi' }) === 'shape', 'null log -> shape');
  ok(reasonOf(log, { job: 'pizza' }) === 'shape', 'job mismatch with the token -> shape');
  ok(reasonOf(mutated(log, copy => { copy.minutes = 4; })) === 'shape', 'minutes other than SHIFT_MINUTES -> shape');
  ok(reasonOf(mutated(log, copy => { copy.frames = SHIFT_FRAMES + 3; })) === 'shape', 'frames 3 above minutes*3600 -> shape');
  ok(verdictOf(mutated(log, copy => { copy.frames = SHIFT_FRAMES - 2; })).ok, 'frames 2 below minutes*3600 accepted');
  ok(reasonOf(mutated(log, copy => { copy.mutators = ['tightClock']; })) === 'shape', 'mutators differing from the token -> shape');
  ok(reasonOf(mutated(log, copy => { delete copy.mutators; })) === 'shape', 'missing mutators -> shape');
  ok(reasonOf(mutated(log, copy => { copy.score = 1.5; })) === 'shape', 'non-integer score -> shape');
  ok(reasonOf(mutated(log, copy => { copy.events = {}; })) === 'events', 'events not an array -> events');
}

console.log('# checkStart');
{
  const { checkStart } = validatorFor('shift');
  ok(checkStart({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' }).ok, 'PSHIFT without mutators accepted');
  ok(checkStart({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT', mutators: [] }).ok, 'empty mutators accepted');
  ok(checkStart({ mode: 'shift', job: 'taxi', roomCode: 'PK3X9Q' }).error === 'mutators_not_allowed', 'room other than PSHIFT -> mutators_not_allowed');
  ok(checkStart({ mode: 'shift', job: 'taxi', roomCode: 'PSHIFT', mutators: ['tightClock'] }).error === 'mutators_not_allowed', 'non-empty mutators -> mutators_not_allowed');
}

console.log('# elapsed');
{
  const log = shiftLog('fire');
  ok(reasonOf(log, { now: STARTED_AT + PLAYED_MS - 2001 }) === 'elapsed', 'submitted faster than the played frames -> elapsed');
  ok(reasonOf(log, { now: STARTED_AT + PLAYED_MS + 600_001 }) === 'elapsed', 'submitted after the pause budget -> elapsed');
  ok(verdictOf(log, { now: STARTED_AT + PLAYED_MS - 2000 }).ok, '2 s slack accepted');
  ok(verdictOf(log, { now: STARTED_AT + PLAYED_MS + 600_000 }).ok, '10 min pause budget accepted');
}

console.log('# events');
{
  const log = shiftLog('taxi');
  const appended = tuple => mutated(log, copy => { copy.events.push(tuple); });
  ok(reasonOf(appended(['k', lastFrame(log), 'cop'])) === 'events', 'kill tuple k -> events');
  ok(reasonOf(appended(['zz', lastFrame(log)])) === 'events', 'unknown tuple -> events');
  ok(reasonOf(appended([['vd'], lastFrame(log), 12])) === 'events', 'array type coerced to a known name -> events');
  ok(reasonOf(appended(['jp', lastFrame(log), 10, 10, 10])) === 'events', 'wrong arity -> events');
  ok(reasonOf(appended(['vd', lastFrame(log) - 1, 12])) === 'events', 'decreasing frame -> events');
  ok(reasonOf(appended(['vd', SHIFT_FRAMES + 1, 12])) === 'events', 'frame beyond log.frames -> events');
  ok(reasonOf(appended(['vd', lastFrame(log) + 0.5, 12])) === 'events', 'non-integer frame -> events');
  ok(reasonOf(appended(['jf', lastFrame(log), 'teleport'])) === 'events', 'unknown fail reason -> events');
  ok(reasonOf(appended(['pd', lastFrame(log), 'asleep'])) === 'events', 'unknown down reason -> events');
  ok(reasonOf(mutated(log, copy => { copy.events[1][2] = 5889; })) === 'events', 'x outside the PSHIFT world -> events');
  ok(reasonOf(mutated(log, copy => { copy.events[0][3] = -1; })) === 'events', 'negative y -> events');
  const accepted = mutated(log, copy => {
    copy.events.push(['vd', lastFrame(log), 12], ['pd', lastFrame(log) + 5, 'busted'], ['cc', lastFrame(log) + 6, 2, 3], ['cb', lastFrame(log) + 7, 'crash', 1]);
  });
  ok(verdictOf(accepted).ok, 'vd, pd, cc and cb tuples accepted');
  const damage = count => ({ ...log, score: 0, events: Array.from({ length: count }, (_, index) => ['vd', index, 5]) });
  ok(reasonOf(damage(601)) === 'events', '601 events -> events');
  ok(reasonOf(damage(600)) === 'empty', '600 events pass the size check');
}

console.log('# job sequence');
{
  const taxiLog = shiftLog('taxi');
  const patrolLog = shiftLog('patrol');
  ok(reasonOf(mutated(taxiLog, copy => { copy.events.splice(1, 1); })) === 'sequence', 'jc without js -> sequence');
  ok(reasonOf(mutated(taxiLog, copy => { copy.events.splice(0, 1); })) === 'sequence', 'taxi jc without jp -> sequence');
  ok(reasonOf(mutated(patrolLog, copy => { copy.events.unshift(['jp', 0, 10, 10]); })) === 'sequence', 'patrol jp -> sequence');
  ok(reasonOf(mutated(patrolLog, copy => { copy.events.splice(1, 1); })) === 'sequence', 'js while a job is open -> sequence');
  ok(reasonOf(mutated(patrolLog, copy => { copy.events.splice(1, 0, ['jf', copy.events[0][1], 'late']); })) === 'sequence', 'jc after jf -> sequence');
  ok(verdictOf(mutated(taxiLog, copy => { [copy.events[0], copy.events[1]] = [copy.events[1], copy.events[0]]; })).ok, 'jp between js and jc accepted');
  ok(verdictOf(mutated(taxiLog, copy => { copy.events.unshift(['jf', 50, 'lost']); })).ok, 'jf before any js accepted (fare lost at pickup)');
}

console.log('# formulas');
for (const job of JOBS) {
  ok(reasonOf(shiftLog(job, { firstJob: { payDelta: 10 } })) === 'formula', `${job}: pay +10 -> formula`);
  ok(reasonOf(shiftLog(job, { firstJob: { payDelta: -10 } })) === 'formula', `${job}: pay -10 -> formula`);
  ok(reasonOf(shiftLog(job, { firstJob: { timerDelta: 3 } })) === 'formula', `${job}: timer +3 -> formula`);
  ok(reasonOf(shiftLog(job, { firstJob: { timerDelta: -3 } })) === 'formula', `${job}: timer -3 -> formula`);
  ok(verdictOf(shiftLog(job, { firstJob: { timerDelta: 2 } })).ok, `${job}: timer +2 within tolerance`);
}
{
  ok(verdictOf(shiftLog('taxi', { firstJob: { payDelta: 5 } })).ok, 'taxi: pay +5 within tolerance');
  ok(reasonOf(shiftLog('patrol', { firstJob: { payDelta: 5 } })) === 'formula', 'patrol: pay is exactly 45');
  const taxiLog = shiftLog('taxi');
  ok(reasonOf(mutated(taxiLog, copy => { copy.events[2][5] += 5; })) === 'formula', 'wrong tip -> formula');
  ok(reasonOf(mutated(taxiLog, copy => { copy.events[2][4] += 5; })) === 'formula', 'jc pay differs from js pay -> formula');
  ok(reasonOf(mutated(taxiLog, copy => { copy.events[2][6] = copy.events[2][7] + 1; })) === 'formula', 'timerLeft above timerTotal -> formula');
  const withFirstTimerLeft = (log, timerLeftOf) => mutated(log, copy => {
    const completion = copy.events.find(tuple => tuple[0] === 'jc');
    completion[6] = timerLeftOf(completion);
    copy.score = copy.events.filter(tuple => tuple[0] === 'jc').reduce((sum, [, , , , pay, tip, timerLeft, timerTotal]) =>
      sum + jobScore({ job: copy.job, pay, tip, timerLeft, timerTotal }), 0);
  });
  ok(reasonOf(withFirstTimerLeft(taxiLog, completion => completion[7])) === 'formula', 'taxi: timerLeft = timerTotal after travel frames -> formula');
  ok(reasonOf(withFirstTimerLeft(shiftLog('patrol'), completion => completion[7])) === 'formula', 'patrol: timerLeft = timerTotal after travel frames -> formula');
  ok(reasonOf(withFirstTimerLeft(taxiLog, completion => completion[6] + 3)) === 'formula', 'taxi: timerLeft 3 above the frames elapsed -> formula');
  ok(verdictOf(withFirstTimerLeft(taxiLog, completion => completion[6] + 2)).ok, 'taxi: timerLeft 2 above the frames elapsed within tolerance');
  ok(verdictOf(withFirstTimerLeft(shiftLog('patrol'), completion => completion[6] - 1)).ok, 'patrol: timerLeft one below the frames elapsed accepted');
  ok(reasonOf(mutated(shiftLog('fire'), copy => { copy.events[1][5] = 0; })) === 'formula', 'fire: missing quick bonus -> formula');
}

console.log('# distance caps');
{
  const caps = { taxi: 2500, pizza: 1900, patrol: 2700, fire: 1900, ambulance: Math.ceil(Math.hypot(5888, 5888)) };
  for (const job of JOBS) {
    ok(reasonOf(shiftLog(job, { firstJob: { distance: caps[job] + 1 } })) === 'distance', `${job}: distance ${caps[job] + 1} above cap -> distance`);
  }
  ok(verdictOf(shiftLog('patrol', { firstJob: { distance: 2680 } })).ok, 'patrol: landmark crime at 2680 px accepted');
  const floors = { taxi: 390, pizza: 570, fire: 570 };
  for (const [job, floor] of Object.entries(floors)) {
    ok(reasonOf(shiftLog(job, { firstJob: { distance: floor - 1 } })) === 'distance', `${job}: distance ${floor - 1} below the spawn-ring floor -> distance`);
    ok(verdictOf(shiftLog(job, { firstJob: { distance: floor } })).ok, `${job}: distance ${floor} at the floor accepted`);
  }
  ok(verdictOf(shiftLog('ambulance', { firstJob: { distance: 40 } })).ok, 'ambulance: no distance floor (injured next to a hospital)');
  ok(verdictOf(shiftLog('patrol', { firstJob: { distance: 40 } })).ok, 'patrol: no distance floor (crime at a landmark next to the player)');
}

console.log('# travel and pacing');
{
  ok(reasonOf(shiftLog('pizza', { firstJob: { pxPerFrame: 11 } })) === 'travel', 'ride faster than 10 px/frame -> travel');
  ok(verdictOf(shiftLog('pizza', { firstJob: { pxPerFrame: 10 } })).ok, 'ride at 10 px/frame accepted');
  ok(reasonOf(shiftLog('fire', { gapFrames: 37 })) === 'pacing', 'next job 37 frames after a completion -> pacing');
  ok(verdictOf(shiftLog('fire', { gapFrames: 38 })).ok, 'next job 38 frames after a completion accepted');
  for (const job of ['patrol', 'fire']) {
    ok(verdictOf(shiftLog(job, { gapFrames: 40 })).ok, `${job}: honest exit and re-enter after each completion (cooldown 40) accepted`);
  }
}

console.log('# score');
{
  const log = shiftLog('ambulance');
  ok(reasonOf(mutated(log, copy => { copy.score += 1; })) === 'score', 'score mismatch -> score');
  ok(reasonOf({ ...log, score: 0, events: [] }) === 'empty', 'empty shift -> empty');
}

console.log('# checkShiftLog and timerScale');
{
  const scaledLog = shiftLog('taxi', { timerScale: 0.7 });
  const result = checkShiftLog(scaledLog, runFor('taxi'), { timerScale: 0.7 });
  ok(result.ok && result.score === scaledLog.score && result.jobs === 10, 'checkShiftLog accepts a 0.7 timer scale log with that scale');
  ok(checkShiftLog(scaledLog, runFor('taxi')).reason === 'formula', 'the same log with the default scale -> formula');
}

console.log('# shiftScoreExtras');
{
  const comboBonus = (events, job) => (job === 'taxi' ? 7 : 0) * events.filter(event => event.type === 'cc').length;
  shiftScoreExtras.push(comboBonus);
  const log = shiftLog('taxi');
  const withCombo = mutated(log, copy => { copy.events.push(['cc', lastFrame(log), 2, 1], ['cc', lastFrame(log) + 1, 3, 2]); });
  ok(verdictOf({ ...withCombo, score: log.score + 14 }).value === log.score + 14, 'stub extra adds its points to the recomputed score');
  ok(reasonOf(withCombo) === 'score', 'a log missing the extra points -> score');
  shiftScoreExtras.splice(shiftScoreExtras.indexOf(comboBonus), 1);
  ok(verdictOf(withCombo).ok, 'without the extra the base score passes again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
