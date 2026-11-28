import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const context = vm.createContext(stubs.makeSimStubs('JOBS01', 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
vm.runInContext(BUNDLE, context, { timeout: 5000 });
const run = expr => vm.runInContext(expr, context);

const RECORD_SPAWNS = extraDrawsBetweenSpawns => `(() => {
  const burnSharedStream = () => { for (let k = 0; k < ${extraDrawsBetweenSpawns}; k++) random(); };
  const position = point => point ? [point.x, point.y] : null;
  resetJobRandom();
  const draws = [];
  for (let round = 0; round < 6; round++) {
    burnSharedStream(); taxi.phase = 'idle'; spawnFare(); draws.push(position(taxi.fare));
    burnSharedStream(); if (taxi.fare) { startRide(); draws.push(position(taxi.dest)); }
    burnSharedStream(); pizza.phase = 'idle'; spawnOrder(); draws.push(position(pizza.client));
    burnSharedStream(); rescue.phase = 'idle'; spawnEmergency(); draws.push(position(rescue.patient));
    burnSharedStream(); patrol.phase = 'idle'; spawnCrime(); draws.push(position(patrol.robber));
    burnSharedStream(); firejob.phase = 'idle'; spawnFire(); draws.push(firejob.site && [firejob.site.x, firejob.site.y, firejob.site.seed]);
  }
  return JSON.stringify(draws);
})()`;

console.log('1) job spawns ignore extra draws on the shared stream');
const quietDraws = run(RECORD_SPAWNS(0));
const noisyDraws = run(RECORD_SPAWNS(7));
ok(JSON.parse(quietDraws).filter(Boolean).length >= 30, 'the spawn sequence places jobs');
ok(quietDraws === noisyDraws, 'render and audio stand-in draws leave every job draw unchanged');
ok(run(RECORD_SPAWNS(0)) === quietDraws, 'resetJobRandom restarts the same sequence');

console.log('2) helpers without a source keep drawing from the shared stream');
const jobStreamUntouched = run(`(() => {
  resetJobRandom(); const expected = jobRandom();
  resetJobRandom(); randomPublicSidewalkNear(player.x, player.y, 500, 1600); randomPublicRoadNear(player.x, player.y, 500, 1600);
  return jobRandom() === expected;
})()`);
ok(jobStreamUntouched, 'randomPublicSidewalkNear and randomPublicRoadNear default to random');

console.log('3) job draw sites in missions.js use the job stream');
const missionsSource = readSource('missions.js');
const JOB_DRAW_FUNCTIONS = ['spawnFare', 'startRide', 'spawnOrder', 'spawnEmergency', 'completeRescue', 'spawnCrime', 'spawnFire'];
for (const name of JOB_DRAW_FUNCTIONS) {
  const body = extractTopLevel(missionsSource, name);
  const helperCalls = body.match(/randomPublic\w+Near\((?:[^()]|\([^()]*\))*\)/g) || [];
  ok(/\b(jobRandom|jobRnd|jobPick)\b/.test(body), `${name} draws from the job stream`);
  ok(!/(?<![\w.])(rnd|rndi|pick|random)\(/.test(body), `${name} has no shared-stream draw`);
  ok(helperCalls.every(call => call.endsWith(', jobRandom)')), `${name} passes jobRandom to every position helper`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
