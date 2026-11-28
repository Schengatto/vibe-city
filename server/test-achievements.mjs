import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '..', 'js', 'achievements.js');
const require = createRequire(import.meta.url);
const { ACH_CATALOGUE, achInitial, achSessionInitial, achEvaluate, achProgressOf, achSeedFromBests } = require(modulePath);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const NOW = 1700000000000;
const LATER = NOW + 1000;
const JOBS = ['taxi', 'pizza', 'ambulance', 'patrol', 'fire'];

const runEvents = (events, start = {}) => {
  let progress = start.progress || achInitial();
  let session = start.session || achSessionInitial();
  const unlocked = [];
  for (const [type, payload, ctx] of events) {
    const result = achEvaluate(progress, session, type, payload, ctx, start.now || NOW);
    progress = result.progress;
    session = result.session;
    unlocked.push(...result.unlocked);
  }
  return { progress, session, unlocked };
};
const unlocks = (events, id, start) => runEvents(events, start).unlocked.includes(id);
const repeat = (count, event) => Array.from({ length: count }, () => event);
const jobDone = (job, extra = {}, ctx = {}) => ['job:complete', { job, timerLeft: 1000, timerTotal: 3000, frame: 100000, ...extra }, ctx];
const shiftEnd = (extra = {}) => ['run:end', { mode: 'shift', complete: true, job: 'taxi', medal: 'bronze', jobsDone: 5, jobsFailed: 0, newBest: false, ...extra }, {}];
const wanted = (from, to, vehicleKind = 'car') => ['wanted:change', { from, to }, { vehicleKind, wanted: from }];
const taxiRide = () => [['job:start', { job: 'taxi' }], jobDone('taxi')];
const taxiRides = count => Array.from({ length: count }, taxiRide).flat();
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

console.log('1) catalogue');
const ids = ACH_CATALOGUE.map(row => row.id);
ok(ACH_CATALOGUE.length === 25, `25 rows (${ACH_CATALOGUE.length})`);
ok(new Set(ids).size === 25, 'ids are unique');
ok(ids.every(id => /^[a-zA-Z0-9]{1,32}$/.test(id)), 'ids match ^[a-zA-Z0-9]{1,32}$');
ok(ACH_CATALOGUE.every(row => ['jobs', 'skill', 'medals', 'chaos', 'combo'].includes(row.cat)), 'every cat is valid');
ok(ACH_CATALOGUE.every(row => ['flag', 'counter', 'set'].includes(row.kind)), 'every kind is valid');
ok(ACH_CATALOGUE.every(row => Number.isInteger(row.goal) && row.goal >= 1 && (row.kind !== 'flag' || row.goal === 1)), 'goals are positive integers, flags have goal 1');
ok(ids.join(',') === 'firstShift,taxi25,pizza25,ambulance25,patrol25,fire25,jobs200,allRounder,cleanTaxi10,photoFinish,speedDemon,onTheRun,bulletproof,backToWork,bronzeAny,silverAny,goldAny,goldAll,personalBest5,tankDriver,garage,slippery,fiveStars,pacifist,heavyMetal', 'catalogue order');
const goals = Object.fromEntries(ACH_CATALOGUE.map(row => [row.id, row.goal]));
ok(goals.taxi25 === 25 && goals.jobs200 === 200 && goals.allRounder === 5 && goals.cleanTaxi10 === 10 && goals.goldAll === 5 && goals.personalBest5 === 5 && goals.garage === 8, 'counter and set goals');
ok(JSON.stringify(achInitial()) === JSON.stringify({ v: 1, unlocked: {}, counters: {}, sets: {} }), 'achInitial shape');
ok(JSON.stringify(achSessionInitial()) === JSON.stringify({ rideDamaged: false, lastDownFrame: -1, slipperyArmed: false, runKills: 0, runComboBreaks: 0 }), 'achSessionInitial shape');
ok(achInitial() !== achInitial() && achSessionInitial() !== achSessionInitial(), 'initial states are fresh objects');

console.log('2) firstShift');
ok(unlocks([shiftEnd()], 'firstShift'), 'complete shift unlocks');
ok(!unlocks([shiftEnd({ complete: false })], 'firstShift'), 'quit shift does not unlock');
ok(!unlocks([shiftEnd({ mode: 'race' })], 'firstShift'), 'non-shift run does not unlock');

console.log('3) per-job counters');
for (const job of JOBS) {
  const id = `${job}25`;
  ok(unlocks(repeat(25, jobDone(job)), id), `${id}: 25 ${job} jobs unlock`);
  ok(!unlocks(repeat(24, jobDone(job)), id), `${id}: 24 ${job} jobs do not unlock`);
}
const pizzaOnly = runEvents(repeat(25, jobDone('pizza')));
ok(!pizzaOnly.progress.counters.taxi25 && !pizzaOnly.unlocked.includes('taxi25'), 'other jobs do not count for taxi25');

console.log('4) jobs200');
const mixedJobs = count => Array.from({ length: count }, (_, index) => jobDone(JOBS[index % JOBS.length]));
ok(unlocks(mixedJobs(200), 'jobs200'), '200 jobs unlock');
ok(!unlocks(mixedJobs(199), 'jobs200'), '199 jobs do not unlock');

console.log('5) allRounder');
ok(unlocks(JOBS.map(job => jobDone(job)), 'allRounder'), 'five distinct jobs unlock');
const fourDistinct = runEvents([...JOBS.slice(0, 4).map(job => jobDone(job)), jobDone('taxi'), jobDone('pizza')]);
ok(!fourDistinct.unlocked.includes('allRounder') && fourDistinct.progress.sets.allRounder.length === 4, 'four distinct jobs plus repeats do not unlock');

console.log('6) cleanTaxi10');
ok(unlocks(taxiRides(10), 'cleanTaxi10'), 'ten clean taxi rides unlock');
ok(!unlocks(taxiRides(9), 'cleanTaxi10'), 'nine clean taxi rides do not unlock');
const damaged = runEvents([...taxiRides(5), ['job:start', { job: 'taxi' }], ['vehicle:damage', { amount: 1 }], jobDone('taxi'), ...taxiRides(9)]);
ok(!damaged.unlocked.includes('cleanTaxi10') && damaged.progress.counters.cleanTaxi10 === 9, 'damaged ride resets the streak');
ok(unlocks(taxiRides(1), 'cleanTaxi10', { progress: damaged.progress, session: damaged.session }), 'streak rebuilds after a damaged ride');
const failed = runEvents([...taxiRides(9), ['job:fail', { job: 'taxi', reason: 'timeout' }], ...taxiRides(9)]);
ok(!failed.unlocked.includes('cleanTaxi10') && failed.progress.counters.cleanTaxi10 === 9, 'taxi job:fail resets the streak');
const failedWithoutStart = runEvents([...taxiRides(3), ['job:fail', { job: 'taxi' }]]);
ok(failedWithoutStart.progress.counters.cleanTaxi10 === 0, 'taxi job:fail without job:start resets the streak');
const otherFail = runEvents([...taxiRides(3), ['job:fail', { job: 'pizza' }]]);
ok(otherFail.progress.counters.cleanTaxi10 === 3, 'non-taxi job:fail keeps the streak');
const acrossSessions = runEvents(taxiRides(5));
ok(unlocks(taxiRides(5), 'cleanTaxi10', { progress: acrossSessions.progress, session: achSessionInitial() }), 'streak persists across sessions');
const damageBeforeRide = runEvents([['vehicle:damage', { amount: 3 }], ...taxiRides(10)]);
ok(damageBeforeRide.unlocked.includes('cleanTaxi10'), 'damage before job:start does not taint the ride');

console.log('7) photoFinish and speedDemon');
ok(unlocks([jobDone('pizza', { timerLeft: 60 })], 'photoFinish'), 'timerLeft 60 unlocks photoFinish');
ok(!unlocks([jobDone('pizza', { timerLeft: 61 })], 'photoFinish'), 'timerLeft 61 does not unlock photoFinish');
ok(!unlocks([jobDone('pizza', { timerLeft: 0 })], 'photoFinish'), 'timerLeft 0 does not unlock photoFinish');
ok(unlocks([jobDone('pizza', { timerLeft: 500, timerTotal: 1000 })], 'speedDemon'), 'half the timer left unlocks speedDemon');
ok(!unlocks([jobDone('pizza', { timerLeft: 499, timerTotal: 1000 })], 'speedDemon'), 'just under half does not unlock speedDemon');
ok(!unlocks([jobDone('pizza', { timerLeft: 0, timerTotal: 0 })], 'speedDemon'), 'zero timerTotal does not unlock speedDemon');

console.log('8) onTheRun');
ok(unlocks([jobDone('fire', {}, { wanted: 3 })], 'onTheRun'), 'job at 3 stars unlocks');
ok(!unlocks([jobDone('fire', {}, { wanted: 2 })], 'onTheRun'), 'job at 2 stars does not unlock');

console.log('9) bulletproof');
ok(unlocks([shiftEnd({ jobsFailed: 0, jobsDone: 5 })], 'bulletproof'), 'five jobs and no fails unlock');
ok(!unlocks([shiftEnd({ jobsFailed: 1, jobsDone: 8 })], 'bulletproof'), 'one fail does not unlock');
ok(!unlocks([shiftEnd({ jobsFailed: 0, jobsDone: 4 })], 'bulletproof'), 'four jobs do not unlock');
ok(!unlocks([shiftEnd({ complete: false })], 'bulletproof'), 'quit shift does not unlock');

console.log('10) backToWork');
ok(unlocks([['player:down', { frame: 1000 }], jobDone('taxi', { frame: 4600 })], 'backToWork'), 'job 3600 frames after down unlocks');
ok(!unlocks([['player:down', { frame: 1000 }], jobDone('taxi', { frame: 4601 })], 'backToWork'), 'job 3601 frames after down does not unlock');
ok(!unlocks([jobDone('taxi', { frame: 10 })], 'backToWork'), 'job without a prior down does not unlock');
ok(!unlocks([['player:down', {}], jobDone('taxi', { frame: 10 })], 'backToWork'), 'down without a frame does not arm');
ok(!unlocks([['player:down', { frame: 1000 }], jobDone('taxi', { frame: 900 })], 'backToWork'), 'job frame before down does not unlock');

console.log('11) medal flags');
const bronze = runEvents([shiftEnd({ medal: 'bronze' })]).unlocked;
const silver = runEvents([shiftEnd({ medal: 'silver' })]).unlocked;
const gold = runEvents([shiftEnd({ medal: 'gold' })]).unlocked;
const medalIds = list => ['bronzeAny', 'silverAny', 'goldAny'].filter(id => list.includes(id)).join(',');
ok(medalIds(bronze) === 'bronzeAny', 'bronze unlocks bronzeAny only');
ok(medalIds(silver) === 'bronzeAny,silverAny', 'silver unlocks bronzeAny and silverAny');
ok(medalIds(gold) === 'bronzeAny,silverAny,goldAny', 'gold unlocks all three');
ok(medalIds(runEvents([shiftEnd({ medal: 'gold', complete: false })]).unlocked) === '', 'quit gold shift unlocks no medal');
ok(medalIds(runEvents([shiftEnd({ medal: null })]).unlocked) === '', 'no medal unlocks no medal flag');

console.log('12) goldAll');
ok(unlocks(JOBS.map(job => shiftEnd({ job, medal: 'gold' })), 'goldAll'), 'gold in five distinct jobs unlocks');
const fourGolds = runEvents([...JOBS.slice(0, 4).map(job => shiftEnd({ job, medal: 'gold' })), shiftEnd({ job: 'taxi', medal: 'gold' }), shiftEnd({ job: 'fire', medal: 'silver' })]);
ok(!fourGolds.unlocked.includes('goldAll') && fourGolds.progress.sets.goldAll.length === 4, 'four golds, a repeat and a silver do not unlock');
ok(!unlocks([...JOBS.slice(0, 4).map(job => shiftEnd({ job, medal: 'gold' })), shiftEnd({ job: 'fire', medal: 'gold', complete: false })], 'goldAll'), 'quit gold shift does not count');

console.log('13) personalBest5');
const bestRun = mode => ['run:end', { mode, complete: true, newBest: true }];
ok(unlocks([bestRun('race'), bestRun('shift'), bestRun('race'), bestRun('daily'), bestRun('race')], 'personalBest5'), 'five new bests in any mode unlock');
ok(!unlocks(repeat(4, bestRun('race')), 'personalBest5'), 'four new bests do not unlock');
ok(!unlocks(repeat(5, ['run:end', { mode: 'race', newBest: false }]), 'personalBest5'), 'runs without a new best do not count');

console.log('14) tankDriver and garage');
ok(unlocks([['vehicle:enter', { vehicleKind: 'tank' }]], 'tankDriver'), 'entering a tank unlocks tankDriver');
ok(!unlocks([['vehicle:enter', { vehicleKind: 'car' }]], 'tankDriver'), 'entering a car does not unlock tankDriver');
const kinds = ['car', 'taxi', 'bus', 'truck', 'police', 'ambulance', 'firetruck', 'tank'];
ok(unlocks(kinds.map(vehicleKind => ['vehicle:enter', { vehicleKind }]), 'garage'), 'eight distinct vehicles unlock garage');
const sevenKinds = runEvents([...kinds.slice(0, 7), 'car', 'bus'].map(vehicleKind => ['vehicle:enter', { vehicleKind }]));
ok(!sevenKinds.unlocked.includes('garage') && sevenKinds.progress.sets.garage.length === 7, 'seven distinct vehicles plus repeats do not unlock garage');
ok(!runEvents([['vehicle:enter', { vehicleKind: null }]]).progress.sets.garage, 'null vehicleKind is not added');

console.log('15) slippery');
const escape = [wanted(3, 4), wanted(4, 3), wanted(3, 2), wanted(2, 1), wanted(1, 0)];
ok(unlocks(escape, 'slippery'), 'escape from 4 stars in a vehicle unlocks');
ok(!unlocks([wanted(3, 4), ['vehicle:enter', { vehicleKind: 'taxi' }], wanted(4, 3), wanted(3, 2), wanted(2, 1), wanted(1, 0)], 'slippery'), 'vehicle:enter disarms');
ok(!unlocks([wanted(3, 4), wanted(4, 0), ['player:down', { frame: 50 }]], 'slippery'), 'bust in player:down order (4 to 0) does not unlock');
ok(!unlocks([wanted(3, 4), wanted(4, 3), wanted(3, 2), wanted(2, 1), wanted(1, 0, null)], 'slippery'), 'on-foot drop to 0 does not unlock');
ok(!unlocks([wanted(2, 3), wanted(3, 2), wanted(2, 1), wanted(1, 0)], 'slippery'), 'never reaching 4 stars does not unlock');
ok(!unlocks([wanted(3, 4), ['player:down', { frame: 50 }], wanted(1, 0)], 'slippery'), 'player:down disarms');
ok(!unlocks([wanted(3, 4, null), wanted(4, 3), wanted(3, 2), wanted(2, 1), wanted(1, 0)], 'slippery'), 'reaching 4 stars on foot does not arm');

console.log('16) fiveStars');
ok(unlocks([wanted(4, 5)], 'fiveStars'), 'reaching 5 stars unlocks');
ok(!unlocks([wanted(3, 4)], 'fiveStars'), 'reaching 4 stars does not unlock');

console.log('17) pacifist');
ok(unlocks([['run:start', { mode: 'shift' }], shiftEnd()], 'pacifist'), 'shift without kills unlocks');
ok(!unlocks([['run:start', { mode: 'shift' }], ['kill', { victimKind: 'civilian' }], shiftEnd()], 'pacifist'), 'one kill blocks it');
ok(unlocks([['kill', { victimKind: 'civilian' }], ['run:start', { mode: 'shift' }], shiftEnd()], 'pacifist'), 'run:start resets the kill count');
ok(!unlocks([['run:start', { mode: 'shift' }], shiftEnd({ complete: false })], 'pacifist'), 'quit shift does not unlock');

console.log('18) heavyMetal');
ok(unlocks([['kill', { victimKind: 'soldier' }, { vehicleKind: 'tank' }]], 'heavyMetal'), 'soldier killed from a tank unlocks');
ok(!unlocks([['kill', { victimKind: 'soldier' }, { vehicleKind: 'car' }]], 'heavyMetal'), 'soldier killed from a car does not unlock');
ok(!unlocks([['kill', { victimKind: 'civilian' }, { vehicleKind: 'tank' }]], 'heavyMetal'), 'civilian killed from a tank does not unlock');

console.log('19) multiple unlocks in catalogue order');
const nearMilestones = { ...achInitial(), counters: { taxi25: 24, jobs200: 199 } };
const milestone = achEvaluate(nearMilestones, achSessionInitial(), 'job:complete', { job: 'taxi', timerLeft: 30, timerTotal: 3000 }, {}, NOW);
ok(milestone.unlocked.join(',') === 'taxi25,jobs200,photoFinish', `200th job is also 25th taxi (${milestone.unlocked})`);
const perfectShift = runEvents([['run:start', { mode: 'shift' }], shiftEnd({ medal: 'gold', jobsDone: 6, newBest: true })]);
ok(perfectShift.unlocked.join(',') === 'firstShift,bulletproof,bronzeAny,silverAny,goldAny,pacifist', `perfect shift order (${perfectShift.unlocked})`);
ok(perfectShift.progress.unlocked.goldAny === NOW && perfectShift.progress.counters.personalBest5 === 1, 'unlock date is now and counters advance');

console.log('20) freezing at goal and skipping unlocked ids');
const taxiDone = runEvents(repeat(25, jobDone('taxi')));
const afterGoal = runEvents(repeat(5, jobDone('taxi')), { progress: taxiDone.progress, now: LATER });
ok(afterGoal.progress.counters.taxi25 === 25 && afterGoal.progress.unlocked.taxi25 === NOW && !afterGoal.unlocked.includes('taxi25'), 'counter freezes at goal and keeps its date');
const shiftDone = runEvents([shiftEnd({ medal: null, jobsDone: 0 })]);
const secondShift = achEvaluate(shiftDone.progress, shiftDone.session, 'run:end', { mode: 'shift', complete: true, medal: null, jobsDone: 0 }, {}, LATER);
ok(secondShift.progress === shiftDone.progress && secondShift.unlocked.length === 0, 'unlocked flag stops evaluating (same reference)');
const oneJob = runEvents([jobDone('taxi', { timerLeft: 1000, timerTotal: 0 })]);
const duplicateJob = achEvaluate(oneJob.progress, oneJob.session, 'job:fail', { job: 'pizza' }, {}, LATER);
ok(duplicateJob.progress === oneJob.progress, 'event that changes no rule keeps the progress reference');
const garageFull = runEvents(kinds.map(vehicleKind => ['vehicle:enter', { vehicleKind }]));
const extraKind = runEvents([['vehicle:enter', { vehicleKind: 'boat' }]], { progress: garageFull.progress });
ok(extraKind.progress.sets.garage.length === 8, 'set freezes at goal');
const repeatVehicle = runEvents([['vehicle:enter', { vehicleKind: 'car' }]]);
const repeatAgain = achEvaluate(repeatVehicle.progress, repeatVehicle.session, 'vehicle:enter', { vehicleKind: 'car' }, {}, NOW);
ok(repeatAgain.progress === repeatVehicle.progress && repeatAgain.session === repeatVehicle.session, 'duplicate set member keeps progress and session references');

console.log('21) session transitions and missing inputs');
const session = achSessionInitial();
ok(achEvaluate(achInitial(), session, 'job:pickup', {}, {}, NOW).session === session, 'unrelated event keeps the session reference');
const damagedSession = runEvents([['vehicle:damage', { amount: 1 }]]).session;
ok(damagedSession.rideDamaged === true && achEvaluate(achInitial(), damagedSession, 'vehicle:damage', { amount: 2 }, {}, NOW).session === damagedSession, 'repeated damage keeps the session reference');
ok(runEvents([['job:start', { job: 'pizza' }]], { session: damagedSession }).session.rideDamaged === true, 'non-taxi job:start keeps rideDamaged');
ok(runEvents([['job:start', { job: 'taxi' }]], { session: damagedSession }).session.rideDamaged === false, 'taxi job:start clears rideDamaged');
ok(runEvents([['player:down', { frame: 77 }]]).session.lastDownFrame === 77, 'player:down records the frame');
ok(runEvents([['kill', {}], ['kill', {}], ['run:start', {}]]).session.runKills === 0, 'run:start resets runKills');
ok(runEvents([wanted(3, 4)]).session.slipperyArmed === true && runEvents([wanted(3, 4), wanted(4, 0)]).session.slipperyArmed === false, 'wanted arms at 4 in a vehicle and disarms at 0');
let missing;
try { missing = achEvaluate(achInitial(), achSessionInitial(), 'job:complete', undefined, undefined, NOW); } catch (error) { missing = null; }
ok(missing && missing.progress.counters.jobs200 === 1, 'missing payload and ctx are treated as empty');
ok(achEvaluate(achInitial(), achSessionInitial(), 'kill', undefined, undefined, NOW).session.runKills === 1, 'kill without payload counts');

console.log('22) achProgressOf');
const sample = runEvents([shiftEnd({ medal: null, jobsDone: 0 }), jobDone('taxi'), jobDone('taxi'), jobDone('pizza')]).progress;
ok(JSON.stringify(achProgressOf(sample, 'firstShift')) === JSON.stringify({ value: 1, goal: 1, done: true, date: NOW }), 'unlocked flag');
ok(JSON.stringify(achProgressOf(sample, 'fiveStars')) === JSON.stringify({ value: 0, goal: 1, done: false, date: null }), 'locked flag');
ok(JSON.stringify(achProgressOf(sample, 'taxi25')) === JSON.stringify({ value: 2, goal: 25, done: false, date: null }), 'counter in progress');
ok(JSON.stringify(achProgressOf(sample, 'allRounder')) === JSON.stringify({ value: 2, goal: 5, done: false, date: null }), 'set in progress');
ok(JSON.stringify(achProgressOf(taxiDone.progress, 'taxi25')) === JSON.stringify({ value: 25, goal: 25, done: true, date: NOW }), 'completed counter');
ok(achProgressOf(sample, 'nope') === null && achProgressOf(sample, 'toString') === null, 'unknown id returns null');

console.log('23) achSeedFromBests');
const seeded = achSeedFromBests(achInitial(), { taxi: { score: 900, medal: 'gold', jobs: 6 }, pizza: { medal: 'silver' }, fire: { medal: 'bronze' } }, NOW);
ok(seeded.unlocked.join(',') === 'bronzeAny,silverAny,goldAny', `medal flags backfilled in catalogue order (${seeded.unlocked})`);
ok(JSON.stringify(seeded.progress.sets.goldAll) === '["taxi"]' && !seeded.progress.unlocked.goldAll, 'gold job added to goldAll');
const silverFirst = achSeedFromBests(achInitial(), { pizza: { medal: 'silver' }, fire: { medal: 'bronze' } }, NOW);
ok(silverFirst.unlocked.join(',') === 'bronzeAny,silverAny', 'catalogue order regardless of entry order');
const allGold = achSeedFromBests(achInitial(), Object.fromEntries(JOBS.map(job => [job, { medal: 'gold' }])), NOW);
ok(allGold.unlocked.join(',') === 'bronzeAny,silverAny,goldAny,goldAll' && allGold.progress.unlocked.goldAll === NOW, 'five gold bests unlock goldAll');
const base = achInitial();
const garbageInputs = [null, undefined, 42, 'gold', [], [{ medal: 'gold' }], {}, { taxi: null, pizza: 7, fire: 'gold', patrol: [], ambulance: { medal: 'platinum' } }, { taxi: { medal: 'toString' } }, { taxi: { medal: '__proto__' } }];
ok(garbageInputs.every(input => { const result = achSeedFromBests(base, input, NOW); return result.progress === base && result.unlocked.length === 0; }), 'garbage input keeps the reference and unlocks nothing');
const alreadyBronze = { ...achInitial(), unlocked: { bronzeAny: 5 } };
const reseeded = achSeedFromBests(alreadyBronze, { taxi: { medal: 'bronze' } }, NOW);
ok(reseeded.progress === alreadyBronze && reseeded.unlocked.length === 0, 'already unlocked ids are skipped');
const seededAgain = achSeedFromBests(seeded.progress, { taxi: { medal: 'gold' } }, LATER);
ok(seededAgain.progress === seeded.progress && seededAgain.unlocked.length === 0, 'seeding twice is a no-op');
const seededPlus = achSeedFromBests(seeded.progress, { patrol: { medal: 'gold' } }, LATER);
ok(JSON.stringify(seededPlus.progress.sets.goldAll) === '["taxi","patrol"]' && seededPlus.progress.unlocked.goldAny === NOW, 'new gold job is added and existing dates kept');

console.log('24) immutability in strict mode');
const strictContext = vm.createContext({});
vm.runInContext(`'use strict';\n${fs.readFileSync(modulePath, 'utf8')}`, strictContext);
const strictApi = vm.runInContext('({ achInitial, achSessionInitial, achEvaluate, achSeedFromBests, achProgressOf })', strictContext);
const frozenProgress = deepFreeze({ v: 1, unlocked: { firstShift: 1 }, counters: { taxi25: 24, jobs200: 199, cleanTaxi10: 9, personalBest5: 4 }, sets: { allRounder: ['taxi', 'pizza', 'fire', 'patrol'], garage: ['car'], goldAll: ['taxi', 'pizza', 'fire', 'patrol'] } });
const frozenSession = deepFreeze({ rideDamaged: false, lastDownFrame: 10, slipperyArmed: true, runKills: 0, runComboBreaks: 0 });
const frozenEvents = deepFreeze([
  ['job:complete', { job: 'taxi', timerLeft: 30, timerTotal: 40, frame: 100 }, { vehicleKind: 'taxi', wanted: 3 }],
  ['job:complete', { job: 'ambulance', timerLeft: 30, timerTotal: 40, frame: 100 }, { vehicleKind: 'taxi', wanted: 3 }],
  ['job:fail', { job: 'taxi' }, {}],
  ['job:start', { job: 'taxi' }, {}],
  ['vehicle:damage', { amount: 9 }, {}],
  ['vehicle:enter', { vehicleKind: 'tank' }, { vehicleKind: 'tank' }],
  ['wanted:change', { from: 1, to: 0 }, { vehicleKind: 'car' }],
  ['wanted:change', { from: 4, to: 5 }, { vehicleKind: 'car' }],
  ['kill', { victimKind: 'soldier' }, { vehicleKind: 'tank' }],
  ['player:down', { frame: 200 }, {}],
  ['run:start', { mode: 'shift' }, {}],
  ['run:end', { mode: 'shift', complete: true, job: 'ambulance', medal: 'gold', jobsDone: 5, jobsFailed: 0, newBest: true }, {}],
]);
const progressBefore = JSON.stringify(frozenProgress);
const sessionBefore = JSON.stringify(frozenSession);
const eventsBefore = JSON.stringify(frozenEvents);
let strictError = null;
let strictUnlocked = [];
try {
  for (const [type, payload, ctx] of frozenEvents) strictUnlocked.push(...strictApi.achEvaluate(frozenProgress, frozenSession, type, payload, ctx, NOW).unlocked);
  strictApi.achSeedFromBests(frozenProgress, deepFreeze({ ambulance: { medal: 'gold' }, taxi: { medal: 'silver' } }), NOW);
  strictApi.achProgressOf(frozenProgress, 'goldAll');
} catch (error) { strictError = error; }
ok(strictError === null, `no throw on frozen inputs in strict mode${strictError ? ` (${strictError.message})` : ''}`);
ok(JSON.stringify(frozenProgress) === progressBefore && JSON.stringify(frozenSession) === sessionBefore && JSON.stringify(frozenEvents) === eventsBefore, 'progress, session, payload and ctx unchanged');
ok(['taxi25', 'jobs200', 'cleanTaxi10', 'allRounder', 'goldAll', 'slippery', 'heavyMetal', 'personalBest5'].every(id => strictUnlocked.includes(id)), 'the frozen run did exercise unlocking rules');
const changed = strictApi.achEvaluate(frozenProgress, frozenSession, 'job:complete', { job: 'ambulance' }, {}, NOW);
ok(changed.progress !== frozenProgress && changed.progress.sets !== frozenProgress.sets && changed.progress.sets.allRounder !== frozenProgress.sets.allRounder && changed.progress.counters !== frozenProgress.counters, 'a change returns new progress, maps and set array');
ok(changed.session === frozenSession, 'session reference kept when the event has no transition');

console.log('25) load order and bare vm');
const html = fs.readFileSync(path.resolve(here, '..', 'index.html'), 'utf8');
const achievementsAt = html.indexOf('js/achievements.js');
ok(achievementsAt > html.indexOf('js/game-events.js') && achievementsAt < html.indexOf('js/ui.js') && html.indexOf('js/game-events.js') >= 0, 'index.html loads achievements.js after game-events.js and before ui.js');
const bareContext = vm.createContext({});
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), bareContext);
ok(vm.runInContext('achEvaluate(achInitial(), achSessionInitial(), "vehicle:enter", { vehicleKind: "tank" }, {}, 1).unlocked.join()', bareContext) === 'tankDriver', 'achEvaluate works in vm.createContext({})');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
