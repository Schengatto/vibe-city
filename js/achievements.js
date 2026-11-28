const ACH_CATALOGUE = [
  { id: 'firstShift', cat: 'jobs', kind: 'flag', goal: 1 },
  { id: 'taxi25', cat: 'jobs', kind: 'counter', goal: 25 },
  { id: 'pizza25', cat: 'jobs', kind: 'counter', goal: 25 },
  { id: 'ambulance25', cat: 'jobs', kind: 'counter', goal: 25 },
  { id: 'patrol25', cat: 'jobs', kind: 'counter', goal: 25 },
  { id: 'fire25', cat: 'jobs', kind: 'counter', goal: 25 },
  { id: 'jobs200', cat: 'jobs', kind: 'counter', goal: 200 },
  { id: 'allRounder', cat: 'jobs', kind: 'set', goal: 5 },
  { id: 'cleanTaxi10', cat: 'skill', kind: 'counter', goal: 10 },
  { id: 'photoFinish', cat: 'skill', kind: 'flag', goal: 1 },
  { id: 'speedDemon', cat: 'skill', kind: 'flag', goal: 1 },
  { id: 'onTheRun', cat: 'skill', kind: 'flag', goal: 1 },
  { id: 'bulletproof', cat: 'skill', kind: 'flag', goal: 1 },
  { id: 'backToWork', cat: 'skill', kind: 'flag', goal: 1 },
  { id: 'bronzeAny', cat: 'medals', kind: 'flag', goal: 1 },
  { id: 'silverAny', cat: 'medals', kind: 'flag', goal: 1 },
  { id: 'goldAny', cat: 'medals', kind: 'flag', goal: 1 },
  { id: 'goldAll', cat: 'medals', kind: 'set', goal: 5 },
  { id: 'personalBest5', cat: 'medals', kind: 'counter', goal: 5 },
  { id: 'tankDriver', cat: 'chaos', kind: 'flag', goal: 1 },
  { id: 'garage', cat: 'chaos', kind: 'set', goal: 8 },
  { id: 'slippery', cat: 'chaos', kind: 'flag', goal: 1 },
  { id: 'fiveStars', cat: 'chaos', kind: 'flag', goal: 1 },
  { id: 'pacifist', cat: 'chaos', kind: 'flag', goal: 1 },
  { id: 'heavyMetal', cat: 'chaos', kind: 'flag', goal: 1 },
];

const ACH_MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
const ACH_PHOTO_FINISH_FRAMES = 60;
const ACH_BACK_TO_WORK_FRAMES = 3600;
const ACH_SLIPPERY_ARM_WANTED = 4;

function achMedalRank(medal) {
  return Object.prototype.hasOwnProperty.call(ACH_MEDAL_RANK, medal) ? ACH_MEDAL_RANK[medal] : 0;
}

function achShiftComplete(payload) {
  return payload.mode === 'shift' && payload.complete === true;
}

function achJobCounter(job) {
  return (payload, ctx, session, current) => (payload.job === job ? current + 1 : current);
}

function achShiftMedalAtLeast(rank) {
  return payload => achShiftComplete(payload) && achMedalRank(payload.medal) >= rank;
}

function achBackInTime(payload, session) {
  const elapsed = payload.frame - session.lastDownFrame;
  return Number.isFinite(payload.frame) && session.lastDownFrame >= 0 && elapsed >= 0 && elapsed <= ACH_BACK_TO_WORK_FRAMES;
}

const ACH_RULES = {
  firstShift: { 'run:end': achShiftComplete },
  taxi25: { 'job:complete': achJobCounter('taxi') },
  pizza25: { 'job:complete': achJobCounter('pizza') },
  ambulance25: { 'job:complete': achJobCounter('ambulance') },
  patrol25: { 'job:complete': achJobCounter('patrol') },
  fire25: { 'job:complete': achJobCounter('fire') },
  jobs200: { 'job:complete': (payload, ctx, session, current) => current + 1 },
  allRounder: { 'job:complete': payload => payload.job },
  cleanTaxi10: {
    'job:complete': (payload, ctx, session, current) => {
      if (payload.job !== 'taxi') return current;
      return session.rideDamaged ? 0 : current + 1;
    },
    'job:fail': (payload, ctx, session, current) => (payload.job === 'taxi' ? 0 : current),
  },
  photoFinish: { 'job:complete': payload => payload.timerLeft > 0 && payload.timerLeft <= ACH_PHOTO_FINISH_FRAMES },
  speedDemon: { 'job:complete': payload => payload.timerTotal > 0 && payload.timerLeft >= payload.timerTotal / 2 },
  onTheRun: { 'job:complete': (payload, ctx) => ctx.wanted >= 3 },
  bulletproof: { 'run:end': payload => achShiftComplete(payload) && payload.jobsFailed === 0 && payload.jobsDone >= 5 },
  backToWork: { 'job:complete': (payload, ctx, session) => achBackInTime(payload, session) },
  bronzeAny: { 'run:end': achShiftMedalAtLeast(1) },
  silverAny: { 'run:end': achShiftMedalAtLeast(2) },
  goldAny: { 'run:end': achShiftMedalAtLeast(3) },
  goldAll: { 'run:end': payload => (achShiftComplete(payload) && payload.medal === 'gold' ? payload.job : null) },
  personalBest5: { 'run:end': (payload, ctx, session, current) => (payload.newBest === true ? current + 1 : current) },
  tankDriver: { 'vehicle:enter': payload => payload.vehicleKind === 'tank' },
  garage: { 'vehicle:enter': payload => payload.vehicleKind },
  slippery: {
    'wanted:change': (payload, ctx, session) => payload.to === 0 && payload.from === 1 && session.slipperyArmed && !!ctx.vehicleKind,
  },
  fiveStars: { 'wanted:change': payload => payload.to === 5 },
  pacifist: { 'run:end': (payload, ctx, session) => achShiftComplete(payload) && session.runKills === 0 },
  heavyMetal: { kill: (payload, ctx) => payload.victimKind === 'soldier' && ctx.vehicleKind === 'tank' },
};

const ACH_SESSION_TRANSITIONS = {
  'run:start': () => ({ runKills: 0, runComboBreaks: 0 }),
  'job:start': payload => (payload.job === 'taxi' ? { rideDamaged: false } : null),
  'vehicle:damage': () => ({ rideDamaged: true }),
  kill: (payload, ctx, session) => ({ runKills: session.runKills + 1 }),
  'player:down': payload => (Number.isFinite(payload.frame) ? { lastDownFrame: payload.frame, slipperyArmed: false } : { slipperyArmed: false }),
  'vehicle:enter': () => ({ slipperyArmed: false }),
  'wanted:change': (payload, ctx) => {
    if (payload.to >= ACH_SLIPPERY_ARM_WANTED && ctx.vehicleKind) return { slipperyArmed: true };
    return payload.to === 0 ? { slipperyArmed: false } : null;
  },
};

const ACH_SEED_RULES = {
  bronzeAny: best => achMedalRank(best.medal) >= 1,
  silverAny: best => achMedalRank(best.medal) >= 2,
  goldAny: best => achMedalRank(best.medal) >= 3,
  goldAll: (best, job) => (best.medal === 'gold' ? job : null),
};

function achBuildIndex() {
  const index = {};
  for (const row of ACH_CATALOGUE) {
    for (const type of Object.keys(ACH_RULES[row.id])) (index[type] = index[type] || []).push(row);
  }
  return index;
}

const ACH_EVENT_INDEX = achBuildIndex();
const ACH_SEED_ROWS = ACH_CATALOGUE.filter(row => ACH_SEED_RULES[row.id]);

function achInitial() {
  return { v: 1, unlocked: {}, counters: {}, sets: {} };
}

function achSessionInitial() {
  return { rideDamaged: false, lastDownFrame: -1, slipperyArmed: false, runKills: 0, runComboBreaks: 0 };
}

function achIsUnlocked(progress, id) {
  return Object.prototype.hasOwnProperty.call(progress.unlocked, id);
}

function achCurrentValue(progress, row) {
  if (row.kind === 'counter') return progress.counters[row.id] || 0;
  if (row.kind === 'set') return progress.sets[row.id] || [];
  return false;
}

function achNextValue(row, result, current) {
  if (row.kind === 'flag') return result ? true : current;
  if (row.kind === 'counter') return Number.isFinite(result) ? Math.min(Math.max(0, Math.floor(result)), row.goal) : current;
  return typeof result === 'string' && result && !current.includes(result) ? current.concat(result) : current;
}

function achIsComplete(row, value) {
  if (row.kind === 'flag') return value === true;
  if (row.kind === 'counter') return value >= row.goal;
  return value.length >= row.goal;
}

function achCopyProgress(progress) {
  return { ...progress, unlocked: { ...progress.unlocked }, counters: { ...progress.counters }, sets: { ...progress.sets } };
}

function achApplyResult(draft, row, result, now) {
  const current = achCurrentValue(draft.progress, row);
  const value = achNextValue(row, result, current);
  if (value === current) return;
  if (draft.progress === draft.base) draft.progress = achCopyProgress(draft.base);
  if (row.kind === 'counter') draft.progress.counters[row.id] = value;
  if (row.kind === 'set') draft.progress.sets[row.id] = value;
  if (!achIsComplete(row, value)) return;
  draft.progress.unlocked[row.id] = now;
  draft.unlocked.push(row.id);
}

function achNextSession(session, type, payload, ctx) {
  const transition = ACH_SESSION_TRANSITIONS[type];
  const patch = transition ? transition(payload, ctx, session) : null;
  if (!patch || Object.keys(patch).every(key => session[key] === patch[key])) return session;
  return { ...session, ...patch };
}

function achEvaluate(progress, session, type, payload, ctx, now) {
  const eventPayload = payload || {};
  const eventCtx = ctx || {};
  const draft = { base: progress, progress, unlocked: [] };
  for (const row of ACH_EVENT_INDEX[type] || []) {
    if (achIsUnlocked(progress, row.id)) continue;
    const result = ACH_RULES[row.id][type](eventPayload, eventCtx, session, achCurrentValue(progress, row));
    achApplyResult(draft, row, result, now);
  }
  return { progress: draft.progress, session: achNextSession(session, type, eventPayload, eventCtx), unlocked: draft.unlocked };
}

function achProgressOf(progress, id) {
  const row = ACH_CATALOGUE.find(entry => entry.id === id);
  if (!row) return null;
  const done = achIsUnlocked(progress, id);
  const current = achCurrentValue(progress, row);
  const value = row.kind === 'flag' ? (done ? 1 : 0) : row.kind === 'counter' ? current : current.length;
  return { value, goal: row.goal, done, date: done ? progress.unlocked[id] : null };
}

function achValidBests(shiftBests) {
  if (!shiftBests || typeof shiftBests !== 'object' || Array.isArray(shiftBests)) return [];
  return Object.entries(shiftBests).filter(([, best]) => best && typeof best === 'object' && !Array.isArray(best));
}

function achSeedFromBests(progress, shiftBests, now) {
  const draft = { base: progress, progress, unlocked: [] };
  const bests = achValidBests(shiftBests);
  for (const row of ACH_SEED_ROWS) {
    for (const [job, best] of bests) {
      if (achIsUnlocked(draft.progress, row.id)) break;
      achApplyResult(draft, row, ACH_SEED_RULES[row.id](best, job), now);
    }
  }
  return { progress: draft.progress, unlocked: draft.unlocked };
}

if (typeof module !== 'undefined') module.exports = { ACH_CATALOGUE, achInitial, achSessionInitial, achEvaluate, achProgressOf, achSeedFromBests };
