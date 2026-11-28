const RUN_API_TIMEOUT_MS = 8000;
const RUN_API_RETRY_MS = 3000;
const RUN_API_NETWORK_ERROR = Object.freeze({ ok: false, error: 'network' });
const RUN_PAUSE_BUDGET_MS = 600000;
const RUN_FRAME_MS = 1000 / 60;
const RUN_BOARD_STATUS_KEYS = {
  sending: 'board.status.sending', offline: 'board.status.offline', pausedTooLong: 'board.status.pausedTooLong',
  noName: 'board.status.noName', serverRestarted: 'board.status.serverRestarted', tooLong: 'board.status.tooLong',
  rejected: 'board.status.rejected',
};
const RUN_BOARD_ERROR_STATUS = {
  bad_name: 'noName', bad_token: 'serverRestarted', token_expired: 'pausedTooLong', too_large: 'tooLong', rejected: 'rejected',
};

let runBoardSession = null;

function runApiBase() {
  const serverUrl = netServerUrl();
  return serverUrl ? serverHttpBase(serverUrl) : null;
}

const waitRunApi = ms => new Promise(resolve => setTimeout(resolve, ms));

async function postRunApiOnce(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    const answer = await response.json().catch(() => null);
    return answer && typeof answer === 'object' ? answer : { ok: false, error: 'server_error' };
  } finally {
    clearTimeout(timer);
  }
}

function postRunApi(path, body) {
  const base = runApiBase();
  if (!base) return Promise.resolve(RUN_API_NETWORK_ERROR);
  const attempt = () => postRunApiOnce(base + path, body);
  return attempt().catch(() => waitRunApi(RUN_API_RETRY_MS).then(attempt)).catch(() => RUN_API_NETWORK_ERROR);
}

const runClient = {
  async start({ mode, job, roomCode, challengeId, race }) {
    const answer = await postRunApi('/runs/start', { mode, job, roomCode, challengeId, race });
    return answer.ok ? { token: answer.token, startedAt: answer.startedAt } : null;
  },
  submit(token, log) {
    return postRunApi('/runs/submit', { token, name: playerName, log });
  },
  boardsUrl(boardId, limit, name) {
    const base = runApiBase();
    if (!base) return null;
    const query = new URLSearchParams({ id: boardId, limit: String(limit) });
    if (name) query.set('name', name);
    return base + '/boards?' + query;
  },
};

const runBoardStatusFor = answer => (answer.ok ? 'ranked' : RUN_BOARD_ERROR_STATUS[answer.error] || 'offline');

function runBoardRankText(boards, job) {
  const jobName = t('shift.job.' + job);
  const isAllTime = board => board.id.endsWith(':all');
  const ranks = boards.filter(board => Number.isInteger(board.rank))
    .sort((first, second) => isAllTime(first) - isAllTime(second))
    .map(board => t(isAllTime(board) ? 'board.rankAll' : 'board.rankWeek', { rank: board.rank, job: jobName }));
  if (!ranks.length) return t('board.status.unranked');
  return ranks.join('  ·  ') + (boards.some(board => isAllTime(board) && board.improved) ? '   ' + t('board.newBest') : '');
}

function showRunBoardStatus(state, details) {
  const element = $('#runBoardStatus'); if (!element) return;
  const text = state === 'ranked' ? runBoardRankText(details.boards, details.job) : t(RUN_BOARD_STATUS_KEYS[state]);
  element.textContent = t('board.status.label') + '  ' + text;
  element.classList.remove('hidden');
}

async function submitShiftRun(session, log, job) {
  if (!log) return showRunBoardStatus('tooLong');
  if (!String(playerName || '').trim()) return showRunBoardStatus('noName');
  if (Date.now() - session.startedLocally > log.frames * RUN_FRAME_MS + RUN_PAUSE_BUDGET_MS) return showRunBoardStatus('pausedTooLong');
  showRunBoardStatus('sending');
  try {
    const started = await session.tokenRequest;
    if (!started) return showRunBoardStatus('offline');
    await waitRunApi(Math.max(0, log.frames * RUN_FRAME_MS - (Date.now() - session.tokenReadyAt)));
    const answer = await runClient.submit(started.token, log);
    showRunBoardStatus(runBoardStatusFor(answer), { boards: answer.boards, job });
  } catch {
    showRunBoardStatus('offline');
  }
}

gameEvents.on('run:start', payload => {
  runBoardSession = null;
  if (payload.mode !== 'shift' || payload.mutators.length) return;
  const session = { startedLocally: Date.now(), tokenReadyAt: null, tokenRequest: null };
  session.tokenRequest = runClient.start({ mode: 'shift', job: payload.job, roomCode: runConfig.roomCode }).then(started => {
    session.tokenReadyAt = Date.now();
    return started;
  });
  runBoardSession = session;
});

gameEvents.on('run:end', payload => {
  const session = runBoardSession;
  runBoardSession = null;
  if (!session || payload.complete !== true) return;
  submitShiftRun(session, encodeShiftLog(runState, payload.frame - runState.startFrame), payload.job);
});

if (typeof module !== 'undefined') module.exports = { runClient, runBoardStatusFor, showRunBoardStatus, RUN_API_TIMEOUT_MS, RUN_API_RETRY_MS };
