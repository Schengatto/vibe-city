const COMBO_STEPS = [0, 2, 4, 7, 11];
const COMBO_MAX = 5;
const HEAVY_CRASH_DAMAGE = 8;

function comboMultiplier(cleanStreak) {
  let multiplier = 1;
  for (let i = 0; i < COMBO_STEPS.length; i++) {
    if (COMBO_STEPS[i] <= cleanStreak) multiplier = i + 1;
  }
  return Math.min(multiplier, COMBO_MAX);
}

function comboInitial() {
  return { streak: 0, multiplier: 1, best: 1, breaks: 0, lastBreakFrame: -1 };
}

function comboBreakReason(type, payload) {
  if (type === 'job:fail') return 'fail';
  if (type === 'vehicle:damage' && payload.amount >= HEAVY_CRASH_DAMAGE) return 'crash';
  if (type === 'wanted:change' && payload.to > payload.from) return 'wanted';
  if (type === 'player:down') return 'down';
  return null;
}

function comboCompleteJob(state, payload) {
  const applied = state.multiplier;
  if (!(payload.timerLeft > 0)) return { state: { ...state }, applied, change: null, broke: null };
  const streak = state.streak + 1;
  const multiplier = comboMultiplier(streak);
  const change = multiplier > state.multiplier ? { multiplier, streak } : null;
  return { state: { ...state, streak, multiplier, best: Math.max(state.best, multiplier) }, applied, change, broke: null };
}

function comboApply(state, type, payload = {}) {
  if (type === 'job:complete') return comboCompleteJob(state, payload);
  const reason = comboBreakReason(type, payload);
  if (!reason || state.streak === 0 || payload.frame === state.lastBreakFrame) {
    return { state: { ...state }, applied: null, change: null, broke: null };
  }
  return {
    state: { ...state, streak: 0, multiplier: 1, breaks: state.breaks + 1, lastBreakFrame: payload.frame },
    applied: null,
    change: null,
    broke: { reason, multiplier: state.multiplier },
  };
}

if (typeof module !== 'undefined') module.exports = { COMBO_STEPS, COMBO_MAX, HEAVY_CRASH_DAMAGE, comboMultiplier, comboInitial, comboApply };
