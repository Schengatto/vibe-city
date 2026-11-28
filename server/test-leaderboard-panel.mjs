import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function makeElement(tagName) {
  const element = {
    tagName, className: '', title: '', ownText: '', children: [], parent: null, attributes: {}, onclick: null,
    classList: { add: name => { element.className = (element.className + ' ' + name).trim(); } },
    get textContent() { return element.ownText + element.children.map(child => child.textContent).join(''); },
    set textContent(value) {
      for (const child of element.children) child.parent = null;
      element.children = [];
      element.ownText = String(value);
    },
    appendChild(node) { node.parent = element; element.children.push(node); return node; },
    append(...nodes) { for (const node of nodes) element.appendChild(node); },
    setAttribute(name, value) { element.attributes[name] = String(value); },
  };
  return element;
}
const findAll = (root, predicate) => root.children.flatMap(child => (predicate(child) ? [child] : []).concat(findAll(child, predicate)));
const byTag = (root, tagName) => findAll(root, node => node.tagName === tagName);
const byClass = (root, className) => findAll(root, node => node.className.split(' ').includes(className));

const uiSource = readSource('ui.js');
const shiftSource = readSource('shift.js');
const renderLeaderboardSource = (() => {
  const start = uiSource.indexOf('async function renderLeaderboard(');
  return uiSource.slice(start, uiSource.indexOf('\n}\n', start) + 2);
})();

function makeContext({ stored = {}, serverUrl = 'ws://board.test', fetchHandler = () => Promise.reject(new Error('offline')) } = {}) {
  const elements = { '#boardTabs': makeElement('div'), '#boardContent': makeElement('div') };
  const fetchCalls = [];
  const context = vm.createContext({
    console,
    document: { createElement: makeElement },
    $: selector => elements[selector] || null,
    t: (key, params) => (params ? key + JSON.stringify(params) : key),
    store: { get: (key, fallback) => (key in stored ? stored[key] : fallback) },
    dateLocale: () => 'en-GB',
    netServerUrl: () => serverUrl,
    serverHttpBase: url => url.replace(/^ws/, 'http'),
    fetch: (url, init) => { fetchCalls.push({ url, init }); return fetchHandler(url, init); },
    playerName: 'Ada',
    SHIFT_RULES_VERSION: 2,
    RUN_MEDAL_GLYPHS: { gold: '🥇', silver: '🥈', bronze: '🥉' },
    formatRunScore: score => String(score),
  });
  vm.runInContext(readSource('board-tabs.js'), context, { filename: 'board-tabs.js' });
  const helpers = ['renderScores', 'leaderboardUrl', 'fmtPlayed'].map(name => extractTopLevel(uiSource, name));
  const shiftHelpers = ['SHIFT_JOBS', 'readShiftBests', 'shiftBestEntry', 'createShiftJobRow', 'renderShiftBestsBoard'].map(name => extractTopLevel(shiftSource, name));
  vm.runInContext([...helpers, renderLeaderboardSource, ...shiftHelpers].join('\n'), context, { filename: 'board-renderers.js' });
  return { context, elements, fetchCalls, run: source => vm.runInContext(source, context) };
}
const viewOf = elements => elements['#boardContent'].children[0];
const rowTexts = table => byTag(byTag(table, 'tbody')[0], 'tr').map(row => row.children.map(cell => cell.textContent));

console.log('1) registry holds the three contexts in order');
{
  const { run, elements } = makeContext();
  ok(JSON.stringify(run('boardTabs.map(tab => tab.id)')) === '["global","singleplayer","missions"]', 'Global, Singleplayer, Missions registered in order');
  ok(JSON.stringify(run('boardTabs.map(tab => tab.labelKey)')) === '["board.global","board.singleplayer","board.missions"]', 'each tab has its board.* label key');
  run(`registerBoardTab({ id: 'shifts', labelKey: 'board.shifts', render: view => { view.textContent = 'public shifts'; } })`);
  run(`registerBoardTab({ id: 'shifts', labelKey: 'board.shifts', render: view => { view.textContent = 'public shifts v2'; } })`);
  ok(JSON.stringify(run('boardTabs.map(tab => tab.id)')) === '["global","singleplayer","missions","shifts"]', 'a tab registered later is appended, re-registering an id replaces it');
  run(`registerBoardTab({ id: 'global', labelKey: 'board.global', render: view => { view.textContent = 'global stub'; } })`);
  run('renderBoardPanel()');
  const buttons = elements['#boardTabs'].children;
  ok(buttons.map(button => button.textContent).join(',') === 'board.global,board.singleplayer,board.missions,board.shifts', 'tab bar shows one button per registered tab, labels through t()');
  ok(buttons[0].className === 'boardTab active' && buttons[0].attributes['aria-pressed'] === 'true', 'first tab is active by default');
  ok(buttons.slice(1).every(button => button.className === 'boardTab' && button.attributes['aria-pressed'] === 'false'), 'other tabs are not active');
  ok(viewOf(elements).className === 'boardView' && viewOf(elements).textContent === 'global stub', 'active tab renders into a fresh boardView');
  const firstView = viewOf(elements);
  buttons[3].onclick();
  ok(elements['#boardContent'].children.length === 1 && viewOf(elements).textContent === 'public shifts v2', 'clicking a tab renders that tab only');
  ok(firstView.parent === null, 'the previous view is detached, so a late async reply cannot touch the new tab');
  ok(elements['#boardTabs'].children[3].className === 'boardTab active', 'clicked tab becomes active');
  run('renderBoardPanel()');
  ok(viewOf(elements).textContent === 'public shifts v2', 'reopening the panel keeps the last chosen tab');
  run(`renderBoardPanel('missing')`);
  ok(viewOf(elements).textContent === 'global stub', 'an unknown id falls back to the first tab');
}

console.log('2) Singleplayer reads the local scores');
{
  const scores = [
    { name: 'Ada', score: 900, min: 10, date: Date.UTC(2026, 10, 2) },
    { name: 'Bob', score: 500, min: 0, date: Date.UTC(2026, 10, 3) },
    { name: 'Cy', score: 300, min: 5, date: Date.UTC(2026, 10, 4) },
    { name: 'Dee', score: 100, min: 5, date: Date.UTC(2026, 10, 5) },
  ];
  const { run, elements } = makeContext({ stored: { scores } });
  run(`renderBoardPanel('singleplayer')`);
  const table = byTag(viewOf(elements), 'table')[0];
  ok(!!table && table.className === 'boardTable', 'scores render in a boardTable');
  ok(byTag(table, 'th').map(cell => cell.textContent).join(',') === '#,scores.name,scores.score,scores.duration,scores.date', 'headers are translated');
  const rows = rowTexts(table);
  ok(rows.length === 4 && rows[0][0] === '🥇' && rows[1][0] === '🥈' && rows[2][0] === '🥉' && rows[3][0] === '4', 'medals on the first three rows, rank after');
  ok(rows[0][1] === 'Ada' && rows[0][2] === '$900' && rows[0][3] === 'common.min_short{"n":10}', 'name, cash and duration of a timed match');
  ok(rows[1][3] === 'common.free', 'free play duration label');
  const empty = makeContext();
  empty.run(`renderBoardPanel('singleplayer')`);
  ok(byTag(viewOf(empty.elements), 'table').length === 0 && byClass(viewOf(empty.elements), 'boardMsg')[0].textContent === 'scores.empty', 'no scores: own empty state');
}

console.log('3) Missions reads the shift bests per job');
{
  const shiftBests = { taxi: { score: 3420, medal: 'silver', jobs: 9, rules: 2, date: 1 }, fire: { score: 900, medal: null, jobs: 3, rules: 1, date: 1 } };
  const { run, elements } = makeContext({ stored: { shiftBests } });
  run(`renderBoardPanel('missions')`);
  const rows = byClass(viewOf(elements), 'shiftRow');
  ok(rows.length === 5, 'one row per shift job');
  const taxi = rows[0], fire = rows[4];
  ok(taxi.children[0].textContent === 'shift.job.taxi' && taxi.children[1].textContent === 'shift.best{"score":"3420"} 🥈', 'taxi best with its medal');
  ok(fire.children[1].className === 'shiftBest old' && fire.children[1].title === 'shift.oldRules', 'a best under old rules is marked');
  ok(rows[1].children[1].textContent === 'shift.noBest', 'a job without a best says so');
  ok(rows.every(row => row.children.length === 2), 'board rows have no Start button');
  const empty = makeContext({ stored: { shiftBests: [] } });
  empty.run(`renderBoardPanel('missions')`);
  ok(byClass(viewOf(empty.elements), 'shiftRow').length === 0 && byClass(viewOf(empty.elements), 'boardMsg')[0].textContent === 'board.missionsEmpty', 'no shift best: own empty state');
}

console.log('4) Global reads the server board');
{
  const answer = { qualifyMs: 180000, top: [
    { rank: 1, name: 'Zed', ppm: 120, matches: 4, ms: 3900000, best: { ppm: 150 } },
    { rank: 2, name: ' ada ', ppm: 80, matches: 2, ms: 1500000, best: null },
  ] };
  const { run, elements, fetchCalls } = makeContext({ fetchHandler: () => Promise.resolve({ ok: true, json: () => Promise.resolve(answer) }) });
  run(`renderBoardPanel('global')`);
  ok(byClass(viewOf(elements), 'boardMsg')[0].textContent === 'lb.loading', 'loading message shown while the request runs');
  await settle();
  ok(fetchCalls.length === 1 && fetchCalls[0].url === 'http://board.test/leaderboard?limit=20', 'fetches GET /leaderboard from the server');
  const table = byTag(viewOf(elements), 'table')[0];
  ok(!!table && table.className === 'boardTable wide', 'server board renders in a wide boardTable');
  const rows = rowTexts(table);
  ok(rows.length === 2 && rows[0].join('|') === '🥇|Zed|120|4|lb.dur_hm{"h":1,"m":"05"}|150', 'first row: medal, name, ppm, matches, played, best');
  ok(rows[1][5] === '—', 'missing best shows a dash');
  ok(byTag(byTag(table, 'tbody')[0], 'tr')[1].className === 'me', 'own row highlighted');
  ok(byClass(viewOf(elements), 'boardMsg').length === 0, 'loading message replaced');
  ok(byClass(viewOf(elements), 'boardNote')[0].textContent === 'lb.note lb.qualify{"n":3}', 'note explains the qualifying time');

  const noServer = makeContext({ serverUrl: null });
  noServer.run(`renderBoardPanel('global')`);
  await settle();
  ok(byClass(viewOf(noServer.elements), 'boardMsg')[0].textContent === 'lb.noServer' && noServer.fetchCalls.length === 0, 'no server configured: own message, no request');

  const emptyBoard = makeContext({ fetchHandler: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ top: [] }) }) });
  emptyBoard.run(`renderBoardPanel('global')`);
  await settle();
  ok(byClass(viewOf(emptyBoard.elements), 'boardMsg')[0].textContent === 'lb.empty', 'empty server board: own empty state');

  const failing = makeContext({ fetchHandler: () => Promise.resolve({ ok: false, status: 503 }) });
  failing.run(`renderBoardPanel('global')`);
  await settle();
  ok(byClass(viewOf(failing.elements), 'boardMsg')[0].textContent === 'lb.error', 'server error: error message');

  let resolveLate;
  const late = makeContext({ fetchHandler: () => new Promise(resolve => { resolveLate = resolve; }) });
  late.run(`renderBoardPanel('global')`);
  late.run(`renderBoardPanel('singleplayer')`);
  resolveLate({ ok: true, json: () => Promise.resolve(answer) });
  await settle();
  ok(byTag(viewOf(late.elements), 'table').length === 0 && byClass(viewOf(late.elements), 'boardMsg')[0].textContent === 'scores.empty', 'a late server reply does not overwrite the tab chosen meanwhile');
}

console.log('5) markup and wiring');
{
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
  ok((html.match(/id="boardBtn"/g) || []).length === 1 && /id="boardBtn"[^>]*data-i18n="menu\.board"/.test(html), 'one Leaderboard menu entry');
  ok(!/id="(scoresBtn|lbBtn|scoresPanel|lbPanel|scoreTable|lbTable)"/.test(html), 'old entries and panels removed');
  ok(/id="boardPanel"[\s\S]*id="boardTabs"[\s\S]*id="boardContent"[\s\S]*id="boardBack"/.test(html), 'board panel holds the tab bar, the content and the back button');
  const scriptIndex = file => html.indexOf(`<script src="js/${file}"></script>`);
  ok(scriptIndex('board-tabs.js') > scriptIndex('i18n.js') && scriptIndex('board-tabs.js') < scriptIndex('run-client.js') && scriptIndex('board-tabs.js') < scriptIndex('shift.js') && scriptIndex('board-tabs.js') < scriptIndex('ui.js'), 'board-tabs.js loads before every script that may register a tab');
  ok(/const PANELS = \[[^\]]*'boardPanel'/.test(uiSource) && !/'scoresPanel'|'lbPanel'/.test(uiSource), 'PANELS lists boardPanel instead of the old panels');
  ok(uiSource.includes("onClick('boardBtn', () => { showPanel('boardPanel'); renderBoardPanel(); });"), 'menu entry opens the board panel');
  ok(!/innerHTML/.test(readSource('board-tabs.js') + extractTopLevel(uiSource, 'renderScores') + renderLeaderboardSource + extractTopLevel(shiftSource, 'renderShiftBestsBoard')), 'board renderers never use innerHTML');
}

console.log(fail === 0 ? `\n✅  ${pass} ok, 0 fail` : `\n❌  ${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
