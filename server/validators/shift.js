'use strict';

const { registerValidator, framesToMs, checkElapsed, isInt, worldSize } = require('../run-validate');
const { loadPureScript } = require('../pure-scripts');
const { isoWeekId } = require('../boards');

const { jobScore, SHIFT_MINUTES } = loadPureScript('job-score.js', ['jobScore', 'SHIFT_MINUTES']);

const SHIFT_ROOM_CODE = 'PSHIFT';
const LOG_VERSION = 1;
const FRAMES_PER_MINUTE = 3600;
const FRAME_SLACK = 2;
const MAX_EVENTS = 600;
const MAX_FIELD_VALUE = 1_000_000;
const PAY_TOLERANCE = 5;
const TIMER_TOLERANCE = 2;
const MAX_TRAVEL_PX_PER_FRAME = 10;
const MIN_JOB_GAP_FRAMES = 100;
const FAIL_REASONS = new Set(['abandon', 'vehicle', 'lost', 'late', 'escaped', 'down', 'toggle']);
const DOWN_REASONS = new Set(['dead', 'busted']);
const COMBO_BREAK_REASON_PATTERN = /^[a-z.]{1,16}$/;

const steppedPay = (basePay, ratePerPx) => distance => basePay + Math.round(distance * ratePerPx / 5) * 5;
const scaledTimer = (pxPerFrame, baseFrames) => (distance, timerScale) =>
  Math.round((Math.round(distance / pxPerFrame) + baseFrames) * timerScale);
const fareTip = (pay, timerLeft) => timerLeft > 0 ? Math.ceil(pay * 0.5 / 5) * 5 : 0;
const quickBonus = (pay, timerLeft, timerTotal) => timerLeft > timerTotal * 0.5 ? 20 : 0;

const JOB_RULES = {
  taxi: { minDistance: 390, maxDistance: 2500, pay: steppedPay(15, 0.022), timer: scaledTimer(2.5, 240), tip: fareTip, pickup: true },
  pizza: { minDistance: 570, maxDistance: 1900, pay: steppedPay(20, 0.025), timer: scaledTimer(2.6, 240), tip: fareTip, pickup: true },
  ambulance: { minDistance: 0, maxDistance: null, pay: steppedPay(30, 0.03), timer: scaledTimer(2.5, 240), tip: fareTip, pickup: true },
  patrol: { minDistance: 0, maxDistance: 2700, pay: () => 45, payTolerance: 0, timer: scaledTimer(2.2, 840), tip: quickBonus, pickup: false },
  fire: { minDistance: 570, maxDistance: 1900, pay: steppedPay(35, 0.02), timer: scaledTimer(2.2, 960), tip: quickBonus, pickup: false },
};

const SHIFT_RULES_VERSIONS = new Map([[1, 'score']]);
const shiftScoreExtras = [];

const TUPLE_FIELDS = {
  js: ['x', 'y', 'pay', 'timerTotal'],
  jp: ['x', 'y'],
  jc: ['x', 'y', 'pay', 'tip', 'timerLeft', 'timerTotal', 'distance'],
  jf: ['failReason'],
  vd: ['amount'],
  pd: ['downReason'],
  cc: ['multiplier', 'streak'],
  cb: ['breakReason', 'multiplier'],
};
const isCount = value => isInt(value, 0, MAX_FIELD_VALUE);
const FIELD_CHECKS = {
  x: (value, world) => isInt(value, 0, world.w),
  y: (value, world) => isInt(value, 0, world.h),
  pay: value => isInt(value, 1, MAX_FIELD_VALUE),
  timerTotal: value => isInt(value, 1, MAX_FIELD_VALUE),
  tip: isCount,
  timerLeft: isCount,
  distance: isCount,
  amount: isCount,
  streak: isCount,
  multiplier: value => Number.isFinite(value) && value >= 0 && value <= MAX_FIELD_VALUE,
  failReason: value => FAIL_REASONS.has(value),
  downReason: value => DOWN_REASONS.has(value),
  breakReason: value => typeof value === 'string' && COMBO_BREAK_REASON_PATTERN.test(value),
};

function parseEvent(tuple, minFrame, maxFrame, world) {
  if (!Array.isArray(tuple)) return null;
  const [type, frame, ...values] = tuple;
  const fields = typeof type === 'string' && Object.hasOwn(TUPLE_FIELDS, type) ? TUPLE_FIELDS[type] : null;
  if (!fields || values.length !== fields.length || !isInt(frame, minFrame, maxFrame)) return null;
  if (!fields.every((field, index) => FIELD_CHECKS[field](values[index], world))) return null;
  return Object.fromEntries([['type', type], ['frame', frame], ...fields.map((field, index) => [field, values[index]])]);
}

function parseEvents(tuples, maxFrame, world) {
  const events = [];
  for (const tuple of tuples) {
    const event = parseEvent(tuple, events.length ? events[events.length - 1].frame : 0, maxFrame, world);
    if (!event) return null;
    events.push(event);
  }
  return events;
}

function completionFailure(completion, openJob, rule, timerScale, distanceCap) {
  if (!openJob || (rule.pickup && openJob.pickupFrame === null)) return 'sequence';
  const { start, pickupFrame } = openJob;
  const { pay, tip, timerLeft, timerTotal, distance } = completion;
  if (pay !== start.pay || timerTotal !== start.timerTotal || timerLeft > timerTotal) return 'formula';
  if (timerLeft > Math.max(0, timerTotal - (completion.frame - start.frame)) + TIMER_TOLERANCE) return 'formula';
  if (Math.abs(pay - rule.pay(distance)) > (rule.payTolerance ?? PAY_TOLERANCE)) return 'formula';
  if (Math.abs(timerTotal - rule.timer(distance, timerScale)) > TIMER_TOLERANCE) return 'formula';
  if (tip !== rule.tip(pay, timerLeft, timerTotal)) return 'formula';
  if (distance < rule.minDistance || distance > distanceCap) return 'distance';
  if (completion.frame - (pickupFrame ?? start.frame) < Math.ceil(distance / MAX_TRAVEL_PX_PER_FRAME)) return 'travel';
  return null;
}

function walkJobs(events, rule, timerScale, world) {
  const distanceCap = rule.maxDistance ?? Math.hypot(world.w, world.h);
  const completions = [];
  let openJob = null, pendingPickupFrame = null, lastCompletionFrame = null;
  for (const event of events) {
    if (event.type === 'jp') {
      if (!rule.pickup || (openJob && openJob.pickupFrame !== null)) return { reason: 'sequence' };
      if (openJob) openJob.pickupFrame = event.frame;
      else pendingPickupFrame = event.frame;
    } else if (event.type === 'js') {
      if (openJob) return { reason: 'sequence' };
      if (lastCompletionFrame !== null && event.frame - lastCompletionFrame < MIN_JOB_GAP_FRAMES) return { reason: 'pacing' };
      openJob = { start: event, pickupFrame: pendingPickupFrame === event.frame ? event.frame : null };
      pendingPickupFrame = null;
    } else if (event.type === 'jf') {
      openJob = null; pendingPickupFrame = null;
    } else if (event.type === 'jc') {
      const reason = completionFailure(event, openJob, rule, timerScale, distanceCap);
      if (reason) return { reason };
      completions.push(event);
      lastCompletionFrame = event.frame; openJob = null;
    }
  }
  return { completions };
}

function sameMutators(logMutators, runMutators) {
  return Array.isArray(logMutators) && logMutators.length === runMutators.length
    && logMutators.every((mutatorId, index) => mutatorId === runMutators[index]);
}

function headerFailure(log, run) {
  if (!log || typeof log !== 'object' || log.v !== LOG_VERSION) return 'shape';
  if (!SHIFT_RULES_VERSIONS.has(log.rules)) return 'rules_version';
  const expectedFrames = SHIFT_MINUTES * FRAMES_PER_MINUTE;
  if (log.job !== run.job || !Object.hasOwn(JOB_RULES, log.job) || log.minutes !== SHIFT_MINUTES) return 'shape';
  if (!isInt(log.frames, expectedFrames - FRAME_SLACK, expectedFrames + FRAME_SLACK) || !Number.isInteger(log.score)) return 'shape';
  if (!sameMutators(log.mutators, run.mutators)) return 'shape';
  if (!Array.isArray(log.events) || log.events.length > MAX_EVENTS) return 'events';
  return null;
}

function checkShiftLog(log, run, { timerScale = 1 } = {}) {
  const headerReason = headerFailure(log, run);
  if (headerReason) return { ok: false, reason: headerReason };
  const world = worldSize(run.roomCode);
  const events = parseEvents(log.events, log.frames, world);
  if (!events) return { ok: false, reason: 'events' };
  const { reason, completions } = walkJobs(events, JOB_RULES[log.job], timerScale, world);
  if (reason) return { ok: false, reason };
  const score = completions.reduce((sum, { pay, tip, timerLeft, timerTotal }) =>
    sum + jobScore({ job: log.job, pay, tip, timerLeft, timerTotal }), 0)
    + shiftScoreExtras.reduce((sum, extra) => sum + extra(events, log.job), 0);
  if (score !== log.score) return { ok: false, reason: SHIFT_RULES_VERSIONS.get(log.rules) };
  if (score <= 0) return { ok: false, reason: 'empty' };
  return { ok: true, score, jobs: completions.length };
}

function validateShift({ run, log, now }) {
  const verdict = checkShiftLog(log, run);
  if (!verdict.ok) return verdict;
  if (checkElapsed(log.frames, run, now)) return { ok: false, reason: 'elapsed' };
  return {
    ok: true,
    value: verdict.score,
    ms: framesToMs(log.frames),
    boards: [`shift:${run.job}:all`, `shift:${run.job}:${isoWeekId(run.startedAt)}`],
    meta: { jobs: verdict.jobs },
  };
}

function checkShiftStart({ roomCode, mutators }) {
  return roomCode === SHIFT_ROOM_CODE && !(mutators && mutators.length) ? { ok: true } : { ok: false, error: 'mutators_not_allowed' };
}

registerValidator('shift', { validate: validateShift, checkStart: checkShiftStart });

module.exports = { checkShiftLog, shiftScoreExtras, SHIFT_RULES_VERSIONS, JOB_RULES, SHIFT_ROOM_CODE };
