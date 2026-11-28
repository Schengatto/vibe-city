import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '..', 'js', 'combo.js');
const require = createRequire(import.meta.url);
const { COMBO_STEPS, COMBO_MAX, HEAVY_CRASH_DAMAGE, comboMultiplier, comboInitial, comboApply } = require(modulePath);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const onTime = { timerLeft: 10 };
const completeJobs = (count, start = comboInitial()) => {
  let state = start;
  for (let i = 0; i < count; i++) state = comboApply(state, 'job:complete', onTime).state;
  return state;
};

console.log('1) constants and initial state');
ok(JSON.stringify(COMBO_STEPS) === '[0,2,4,7,11]' && COMBO_MAX === 5 && HEAVY_CRASH_DAMAGE === 8, 'steps, max and heavy crash damage');
ok(JSON.stringify(comboInitial()) === JSON.stringify({ streak: 0, multiplier: 1, best: 1, breaks: 0, lastBreakFrame: -1 }), 'initial state');
const runSource = fs.readFileSync(path.resolve(here, '..', 'js', 'run.js'), 'utf8');
const runLogDamageMin = Number(/RUN_LOG_DAMAGE_MIN = (\d+)/.exec(runSource)[1]);
ok(HEAVY_CRASH_DAMAGE >= runLogDamageMin, `HEAVY_CRASH_DAMAGE >= RUN_LOG_DAMAGE_MIN (${runLogDamageMin})`);

console.log('2) comboMultiplier');
const multipliers = Array.from({ length: 13 }, (_, streak) => comboMultiplier(streak));
ok(JSON.stringify(multipliers) === '[1,1,2,2,3,3,3,4,4,4,4,5,5]', `streaks 0..12 (${multipliers})`);

console.log('3) on-time completions');
let state = comboInitial();
const appliedSequence = [];
const changeJobs = [];
for (let job = 1; job <= 12; job++) {
  const result = comboApply(state, 'job:complete', onTime);
  appliedSequence.push(result.applied);
  if (result.change) changeJobs.push(job);
  ok(result.broke === null, `job ${job} does not break`);
  state = result.state;
}
ok(appliedSequence.join(',') === '1,1,2,2,3,3,3,4,4,4,4,5', `applied sequence (${appliedSequence})`);
ok(changeJobs.join(',') === '2,4,7,11', `change only on jobs 2,4,7,11 (${changeJobs})`);
const stepUp = comboApply(completeJobs(1), 'job:complete', onTime);
ok(stepUp.change && stepUp.change.multiplier === 2 && stepUp.change.streak === 2, 'change carries new multiplier and streak');

console.log('4) late completion');
const beforeLate = completeJobs(4);
for (const timerLeft of [0, -5]) {
  const late = comboApply(beforeLate, 'job:complete', { timerLeft });
  ok(late.applied === 3 && late.state.streak === 4 && late.state.multiplier === 3, `timerLeft ${timerLeft}: applied current, streak frozen`);
  ok(late.change === null && late.broke === null && late.state.breaks === 0, `timerLeft ${timerLeft}: no change, no break`);
}

console.log('5) break reasons');
const breakEvents = [
  ['fail', 'job:fail', { reason: 'timeout', frame: 5 }],
  ['crash', 'vehicle:damage', { amount: 8, frame: 5 }],
  ['wanted', 'wanted:change', { from: 1, to: 2, frame: 5 }],
  ['down', 'player:down', { frame: 5 }],
];
for (const [reason, type, payload] of breakEvents) {
  const result = comboApply(completeJobs(5), type, payload);
  ok(result.state.streak === 0 && result.state.multiplier === 1 && result.state.breaks === 1 && result.state.lastBreakFrame === 5, `${reason}: streak 0, multiplier 1, breaks 1`);
  ok(result.broke && result.broke.reason === reason && result.broke.multiplier === 3, `${reason}: broke carries reason and lost multiplier 3`);
  ok(result.applied === null && result.change === null, `${reason}: applied and change null`);
}

console.log('6) non-breaking thresholds');
const streakFour = completeJobs(4);
const lightCrash = comboApply(streakFour, 'vehicle:damage', { amount: 7, frame: 1 });
ok(lightCrash.broke === null && lightCrash.state.streak === 4, 'damage 7 does not break');
const wantedFall = comboApply(streakFour, 'wanted:change', { from: 3, to: 1, frame: 1 });
ok(wantedFall.broke === null && wantedFall.state.streak === 4, 'wanted fall does not break');
const wantedEqual = comboApply(streakFour, 'wanted:change', { from: 2, to: 2, frame: 1 });
ok(wantedEqual.broke === null && wantedEqual.state.streak === 4, 'wanted equal does not break');

console.log('7) same-frame dedupe');
const downed = comboApply(completeJobs(3), 'player:down', { frame: 10 });
const failedSameFrame = comboApply(completeJobs(3, downed.state), 'job:fail', { reason: 'down', frame: 10 });
ok(failedSameFrame.broke === null && failedSameFrame.state.breaks === 1 && failedSameFrame.state.streak === 3, 'same-frame job:fail after player:down ignored');
ok(downed.broke.reason === 'down', 'first reason wins');
const failedLater = comboApply(completeJobs(3, downed.state), 'job:fail', { reason: 'down', frame: 11 });
ok(failedLater.broke && failedLater.broke.reason === 'fail' && failedLater.state.breaks === 2, 'different frame after rebuilding streak counts twice');

console.log('8) break at streak 0');
const idleBreak = comboApply(comboInitial(), 'job:fail', { reason: 'timeout', frame: 3 });
ok(idleBreak.broke === null && idleBreak.state.breaks === 0 && idleBreak.state.lastBreakFrame === -1, 'not counted');

console.log('9) immutability and unknown types');
const input = completeJobs(6);
const snapshot = JSON.stringify(input);
comboApply(input, 'job:complete', onTime);
comboApply(input, 'job:complete', { timerLeft: 0 });
comboApply(input, 'player:down', { frame: 2 });
comboApply(input, 'unknown:event', {});
ok(JSON.stringify(input) === snapshot, 'input state not mutated');
const unknown = comboApply(input, 'unknown:event', { frame: 2 });
ok(JSON.stringify(unknown.state) === snapshot && unknown.applied === null && unknown.change === null && unknown.broke === null, 'unknown type returns equal state and nulls');

console.log('10) best across a break');
const peak = completeJobs(8);
const afterBreak = comboApply(peak, 'player:down', { frame: 20 }).state;
const rebuilt = completeJobs(2, afterBreak);
ok(peak.best === 4 && afterBreak.best === 4 && rebuilt.best === 4 && rebuilt.multiplier === 2, 'best keeps highest multiplier reached');

console.log('11) loads in a bare vm context');
const bareContext = vm.createContext({});
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), bareContext);
ok(vm.runInContext('comboApply(comboInitial(), "job:complete", { timerLeft: 1 }).state.streak', bareContext) === 1, 'comboApply works in vm.createContext({})');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
