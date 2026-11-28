const PUBLIC_SHIFT_BOARD_LIMIT = 20;
const PUBLIC_SHIFT_DAY_MS = 86400000;
const PUBLIC_SHIFT_WEEK_MS = 7 * PUBLIC_SHIFT_DAY_MS;
const PUBLIC_SHIFT_ALL_TIME = 'all';
const publicShiftBoardSelection = { job: SHIFT_JOBS[0], period: PUBLIC_SHIFT_ALL_TIME };
let publicShiftBoardRequestId = 0;

function publicShiftWeekId(ms) {
  const date = new Date(ms);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekdayFromMonday = (date.getUTCDay() + 6) % 7;
  const thursday = midnight + (3 - weekdayFromMonday) * PUBLIC_SHIFT_DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / PUBLIC_SHIFT_WEEK_MS);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

async function fetchPublicShiftBoard(url) {
  try {
    const answer = await (await fetch(url)).json();
    return answer && answer.ok === true && Array.isArray(answer.entries) ? answer : null;
  } catch (error) {
    return null;
  }
}

function createPublicShiftBoardTable(answer) {
  const { table, body } = createBoardTable(['#', t('scores.name'), t('scores.score'), t('board.colJobs'), t('scores.date')], 'wide');
  for (const entry of answer.entries) {
    const jobs = entry.meta && entry.meta.jobs != null ? String(entry.meta.jobs) : '';
    appendBoardRow(body, [
      ['', boardRankLabel(entry.rank)],
      ['nm', entry.name],
      ['sc', formatRunScore(entry.value)],
      ['', jobs],
      ['', new Date(entry.at).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })],
    ]);
  }
  const lastRank = answer.entries[answer.entries.length - 1].rank;
  if (answer.me && answer.me.rank > lastRank) {
    appendBoardRow(body, [
      ['', String(answer.me.rank)],
      ['nm', t('board.you', { name: playerName })],
      ['sc', formatRunScore(answer.me.value)],
      ['', ''],
      ['', ''],
    ], 'me');
  }
  return table;
}

async function loadPublicShiftBoard(area) {
  const requestId = ++publicShiftBoardRequestId;
  const { job, period } = publicShiftBoardSelection;
  area.textContent = '';
  area.appendChild(createBoardMessage('board.loading'));
  const periodId = period === PUBLIC_SHIFT_ALL_TIME ? PUBLIC_SHIFT_ALL_TIME : publicShiftWeekId(Date.now());
  const url = runClient.boardsUrl(`shift:${job}:${periodId}`, PUBLIC_SHIFT_BOARD_LIMIT, playerName || '');
  const answer = url ? await fetchPublicShiftBoard(url) : null;
  if (requestId !== publicShiftBoardRequestId || !area.isConnected) return;
  area.textContent = '';
  if (!answer) area.appendChild(createBoardMessage('board.offline'));
  else if (!answer.entries.length) area.appendChild(createBoardMessage('board.empty'));
  else area.appendChild(createPublicShiftBoardTable(answer));
}

function renderShiftPublicBoard(view) {
  const jobBar = document.createElement('div'), periodBar = document.createElement('div'), area = document.createElement('div');
  jobBar.className = periodBar.className = 'boardTabs';
  area.className = 'boardArea';
  const weekLabel = t('board.thisWeek', { week: publicShiftWeekId(Date.now()).split('-')[1] });
  const choices = [
    ...SHIFT_JOBS.map(job => ({ bar: jobBar, key: 'job', value: job, label: t('shift.job.' + job) })),
    { bar: periodBar, key: 'period', value: PUBLIC_SHIFT_ALL_TIME, label: t('board.allTime') },
    { bar: periodBar, key: 'period', value: 'week', label: weekLabel },
  ];
  const syncChips = () => {
    for (const choice of choices) {
      const isActive = publicShiftBoardSelection[choice.key] === choice.value;
      choice.button.className = isActive ? 'boardTab active' : 'boardTab';
      choice.button.setAttribute('aria-pressed', String(isActive));
    }
  };
  for (const choice of choices) {
    choice.button = document.createElement('button');
    choice.button.textContent = choice.label;
    choice.button.onclick = () => {
      publicShiftBoardSelection[choice.key] = choice.value;
      syncChips();
      loadPublicShiftBoard(area);
    };
    choice.bar.appendChild(choice.button);
  }
  syncChips();
  view.append(jobBar, periodBar, area);
  loadPublicShiftBoard(area);
}

registerBoardTab({ id: 'shifts', labelKey: 'board.shifts', render: view => renderShiftPublicBoard(view) });
