const SHIFT_LOG_VERSION = 1;
const SHIFT_LOG_TUPLES = {
  'job:start': entry => ['js', Math.round(entry.x), Math.round(entry.y), Math.round(entry.pay), Math.round(entry.timerTotal)],
  'job:pickup': entry => ['jp', Math.round(entry.x), Math.round(entry.y)],
  'job:complete': entry => ['jc', Math.round(entry.x), Math.round(entry.y), Math.round(entry.pay), Math.round(entry.tip),
    Math.round(entry.timerLeft), Math.round(entry.timerTotal), Math.round(entry.distance)],
  'job:fail': entry => ['jf', entry.reason],
  'vehicle:damage': entry => ['vd', Math.round(entry.amount)],
  'player:down': entry => ['pd', entry.reason],
  'combo:change': entry => ['cc', entry.multiplier, Math.round(entry.streak)],
  'combo:break': entry => ['cb', entry.reason, entry.multiplier],
};

function encodeShiftLog(state, frames) {
  if (state.logTruncated) return null;
  const events = [];
  for (const entry of state.log) {
    const toTuple = SHIFT_LOG_TUPLES[entry.type];
    if (!toTuple || (entry.type.startsWith('job:') && entry.job !== state.job)) continue;
    const [code, ...values] = toTuple(entry);
    events.push([code, entry.frame - state.startFrame, ...values]);
  }
  return { v: SHIFT_LOG_VERSION, rules: SHIFT_RULES_VERSION, job: state.job, minutes: SHIFT_MINUTES, frames, score: state.score, mutators: [], events };
}

if (typeof module !== 'undefined') module.exports = { encodeShiftLog, SHIFT_LOG_TUPLES, SHIFT_LOG_VERSION };
