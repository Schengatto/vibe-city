import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

const require = createRequire(import.meta.url);
const { isoWeekId } = require('./boards.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function makeElement(tagName, root) {
  const element = {
    tagName, className: '', ownText: '', children: [], parent: null, attributes: {}, onclick: null,
    get textContent() { return element.ownText + element.children.map(child => child.textContent).join(''); },
    set textContent(value) {
      for (const child of element.children) child.parent = null;
      element.children = [];
      element.ownText = String(value);
    },
    get isConnected() {
      let top = element;
      while (top.parent) top = top.parent;
      return top === root.element;
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

const boardsUiSource = readSource('boards-ui.js');
const shiftJobsSource = extractTopLevel(readSource('shift.js'), 'SHIFT_JOBS');

function makeContext({ serverUrl = 'http://board.test', fetchHandler = () => Promise.reject(new Error('offline')), playerName = 'Ada' } = {}) {
  const rootHolder = { element: null };
  const elements = { '#boardTabs': makeElement('div', rootHolder), '#boardContent': makeElement('div', rootHolder) };
  rootHolder.element = elements['#boardContent'];
  const fetchCalls = [];
  const context = vm.createContext({
    console,
    Date,
    document: { createElement: tagName => makeElement(tagName, rootHolder) },
    $: selector => elements[selector] || null,
    t: (key, params) => (params ? key + JSON.stringify(params) : key),
    dateLocale: () => 'en-GB',
    playerName,
    formatRunScore: value => Number(value).toLocaleString('en-US'),
    runClient: { boardsUrl: (id, limit, name) => (serverUrl ? `${serverUrl}/boards?id=${id}&limit=${limit}${name ? '&name=' + name : ''}` : null) },
    fetch: url => { fetchCalls.push(url); return fetchHandler(url); },
  });
  vm.runInContext(readSource('board-tabs.js'), context, { filename: 'board-tabs.js' });
  vm.runInContext(`${shiftJobsSource}\n${boardsUiSource}`, context, { filename: 'boards-ui.js' });
  const run = source => vm.runInContext(source, context);
  const click = label => byTag(elements['#boardContent'], 'button').find(button => button.textContent === label).onclick();
  return { run, elements, fetchCalls, click };
}
const answerOf = body => () => Promise.resolve({ json: () => Promise.resolve(body) });
const sampleEntries = [
  { rank: 1, name: 'Ada', value: 12345, ms: 1, at: Date.UTC(2026, 10, 25, 12), meta: { jobs: 7 } },
  { rank: 2, name: 'Bob', value: 900, ms: 1, at: Date.UTC(2026, 10, 3, 12) },
];
const viewOf = elements => elements['#boardContent'].children[0];
const rowTexts = table => byTag(byTag(table, 'tbody')[0], 'tr').map(row => row.children.map(cell => cell.textContent));

console.log('1) tab registered after the base tabs');
{
  const { run } = makeContext();
  ok(JSON.stringify(run('boardTabs.map(tab => tab.id)')) === '["global","singleplayer","missions","shifts"]', 'shifts is the fourth tab');
  ok(run(`boardTabs[3].labelKey`) === 'board.shifts', 'label key is board.shifts');
}

console.log('2) chip and period switching builds the board id');
{
  const { run, elements, fetchCalls, click } = makeContext({ fetchHandler: answerOf({ ok: true, entries: sampleEntries, total: 2 }) });
  run(`renderBoardPanel('shifts')`);
  await settle();
  ok(fetchCalls.length === 1 && fetchCalls[0] === 'http://board.test/boards?id=shift:taxi:all&limit=20&name=Ada', 'default is taxi all time with the nickname');
  const chips = byTag(viewOf(elements), 'button');
  ok(chips.length === 7, 'five job chips and two period chips');
  ok(chips[0].attributes['aria-pressed'] === 'true' && chips[0].className === 'boardTab active', 'taxi chip active and pressed');
  ok(chips[5].attributes['aria-pressed'] === 'true', 'all time chip pressed');
  click('shift.job.pizza');
  await settle();
  ok(fetchCalls[1].includes('id=shift:pizza:all&'), 'pizza chip loads shift:pizza:all');
  ok(byTag(viewOf(elements), 'button')[1].attributes['aria-pressed'] === 'true' && byTag(viewOf(elements), 'button')[0].attributes['aria-pressed'] === 'false', 'chip state follows the selection');
  const weekId = run('publicShiftWeekId(Date.now())');
  click('board.thisWeek{"week":"' + weekId.split('-')[1] + '"}');
  await settle();
  ok(fetchCalls[2].includes(`id=shift:pizza:${weekId}&`), 'week toggle loads the current week id');
  click('shift.job.fire');
  await settle();
  ok(fetchCalls[3].includes(`id=shift:fire:${weekId}&`) && fetchCalls.length === 4, 'one request per selection, fire keeps the week');
  ok(byTag(elements['#boardTabs'], 'button').length === 4, 'panel tab bar untouched by chip changes');
}

console.log('3) client ISO week id matches the server');
{
  const { run } = makeContext();
  const sample = [Date.UTC(2026, 11, 28), Date.UTC(2027, 0, 1), Date.UTC(2027, 0, 4), Date.UTC(2026, 10, 29, 23, 59), Date.UTC(2020, 11, 31), Date.UTC(2024, 11, 30)];
  for (let day = 0; day < 800; day++) sample.push(Date.UTC(2025, 0, 1) + day * 86400000 + 23 * 3600000);
  ok(sample.every(ms => run(`publicShiftWeekId(${ms})`) === isoWeekId(ms)), `identical on ${sample.length} timestamps`);
  ok(run(`publicShiftWeekId(${Date.UTC(2026, 10, 29, 23, 59)})`) === '2026-W48', '2026-11-29 23:59 UTC is W48');
}

console.log('4) columns and me row');
{
  const outside = makeContext({ fetchHandler: answerOf({ ok: true, entries: sampleEntries, total: 40, me: { rank: 31, value: 4200 } }) });
  outside.run(`renderBoardPanel('shifts')`);
  await settle();
  const table = byTag(viewOf(outside.elements), 'table')[0];
  ok(byTag(table, 'th').map(cell => cell.textContent).join(',') === '#,scores.name,scores.score,board.colJobs,scores.date', 'headers');
  const rows = rowTexts(table);
  ok(rows.length === 3, 'two entries plus the me row');
  ok(rows[0].join('|') === '🥇|Ada|12,345|7|25 Nov', 'score thousands, jobs and short date');
  ok(rows[1].join('|') === '🥈|Bob|900||3 Nov', 'missing meta leaves jobs empty');
  ok(rows[2].join('|') === '31|board.you{"name":"Ada"}|4,200||', 'me row: rank, you label, value, empty jobs and date');
  ok(byClass(table, 'me').length === 1, 'me row has the me class');

  const inside = makeContext({ fetchHandler: answerOf({ ok: true, entries: sampleEntries, total: 2, me: { rank: 2, value: 900 } }) });
  inside.run(`renderBoardPanel('shifts')`);
  await settle();
  ok(byClass(viewOf(inside.elements), 'me').length === 0, 'no me row when the player is listed');

  const anonymous = makeContext({ playerName: '', fetchHandler: answerOf({ ok: true, entries: sampleEntries, total: 2 }) });
  anonymous.run(`renderBoardPanel('shifts')`);
  await settle();
  ok(!anonymous.fetchCalls[0].includes('name='), 'name omitted when the nickname is empty');
}

console.log('5) empty, offline and loading states');
{
  const loading = makeContext({ fetchHandler: () => new Promise(() => {}) });
  loading.run(`renderBoardPanel('shifts')`);
  ok(byClass(viewOf(loading.elements), 'boardMsg')[0].textContent === 'board.loading', 'loading message while waiting');

  const empty = makeContext({ fetchHandler: answerOf({ ok: true, entries: [], total: 0 }) });
  empty.run(`renderBoardPanel('shifts')`);
  await settle();
  ok(byClass(viewOf(empty.elements), 'boardMsg')[0].textContent === 'board.empty' && byTag(viewOf(empty.elements), 'table').length === 0, 'empty board message');

  const cases = {
    'no server': { serverUrl: '' },
    'network error': {},
    'non-ok answer': { fetchHandler: answerOf({ ok: false, error: 'bad' }) },
    'non-JSON answer': { fetchHandler: () => Promise.resolve({ json: () => Promise.reject(new SyntaxError('x')) }) },
  };
  for (const [label, options] of Object.entries(cases)) {
    const offline = makeContext(options);
    offline.run(`renderBoardPanel('shifts')`);
    await settle();
    ok(byClass(viewOf(offline.elements), 'boardMsg')[0].textContent === 'board.offline', `offline message: ${label}`);
  }
  const noServer = makeContext({ serverUrl: '' });
  noServer.run(`renderBoardPanel('shifts')`);
  await settle();
  ok(noServer.fetchCalls.length === 0, 'no request without a server');
}

console.log('6) stale replies are ignored');
{
  const pending = [];
  const { run, elements, click } = makeContext({ fetchHandler: url => new Promise(resolve => pending.push({ url, resolve })) });
  const reply = (index, entries) => pending[index].resolve({ json: () => Promise.resolve({ ok: true, entries, total: entries.length }) });
  run(`renderBoardPanel('shifts')`);
  click('shift.job.pizza');
  reply(1, [{ rank: 1, name: 'Pizzaiolo', value: 5, ms: 1, at: 0 }]);
  await settle();
  reply(0, [{ rank: 1, name: 'LateTaxi', value: 9, ms: 1, at: 0 }]);
  await settle();
  const text = viewOf(elements).textContent;
  ok(text.includes('Pizzaiolo') && !text.includes('LateTaxi'), 'older reply does not overwrite the latest selection');

  const detached = makeContext({ fetchHandler: url => new Promise(resolve => pending.push({ url, resolve })) });
  const before = pending.length;
  detached.run(`renderBoardPanel('shifts')`);
  const view = viewOf(detached.elements);
  detached.elements['#boardContent'].textContent = '';
  reply(before, [{ rank: 1, name: 'Ghost', value: 1, ms: 1, at: 0 }]);
  await settle();
  ok(!view.textContent.includes('Ghost'), 'reply after the view was detached writes nothing');

  const reopened = makeContext({ fetchHandler: url => new Promise(resolve => pending.push({ url, resolve })) });
  const first = pending.length;
  reopened.run(`renderBoardPanel('shifts')`);
  reopened.run(`renderBoardPanel('shifts')`);
  reply(first, [{ rank: 1, name: 'OldView', value: 1, ms: 1, at: 0 }]);
  reply(first + 1, [{ rank: 1, name: 'NewView', value: 1, ms: 1, at: 0 }]);
  await settle();
  ok(viewOf(reopened.elements).textContent.includes('NewView') && !viewOf(reopened.elements).textContent.includes('OldView'), 'reply of a previous render of the tab is ignored');
}

console.log('7) source guard');
{
  ok(!/innerHTML/.test(boardsUiSource), 'boards-ui.js never uses innerHTML');
}

console.log(fail === 0 ? `\n✅  ${pass} ok, 0 fail` : `\n❌  ${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
