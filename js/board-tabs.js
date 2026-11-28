const boardTabs = [];
let activeBoardTabId = null;

function registerBoardTab(tab) {
  const index = boardTabs.findIndex(registered => registered.id === tab.id);
  if (index >= 0) boardTabs[index] = tab; else boardTabs.push(tab);
}

function renderBoardPanel(tabId) {
  const tabBar = $('#boardTabs'), content = $('#boardContent');
  if (!tabBar || !content || !boardTabs.length) return;
  const activeTab = boardTabs.find(tab => tab.id === (tabId || activeBoardTabId)) || boardTabs[0];
  activeBoardTabId = activeTab.id;
  tabBar.textContent = '';
  for (const tab of boardTabs) {
    const button = document.createElement('button');
    button.className = tab === activeTab ? 'boardTab active' : 'boardTab';
    button.setAttribute('aria-pressed', String(tab === activeTab));
    button.textContent = t(tab.labelKey);
    button.onclick = () => renderBoardPanel(tab.id);
    tabBar.appendChild(button);
  }
  content.textContent = '';
  const view = document.createElement('div');
  view.className = 'boardView';
  content.appendChild(view);
  activeTab.render(view);
}

function createBoardTable(headerLabels, className) {
  const table = document.createElement('table');
  table.className = className ? 'boardTable ' + className : 'boardTable';
  const head = document.createElement('thead'), headRow = document.createElement('tr');
  for (const label of headerLabels) {
    const headerCell = document.createElement('th');
    headerCell.textContent = label;
    headRow.appendChild(headerCell);
  }
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  table.append(head, body);
  return { table, body };
}

function appendBoardRow(body, cells, className) {
  const row = document.createElement('tr');
  if (className) row.className = className;
  for (const [cellClass, text] of cells) {
    const cell = document.createElement('td');
    if (cellClass) cell.className = cellClass;
    cell.textContent = text;
    row.appendChild(cell);
  }
  body.appendChild(row);
}

function createBoardMessage(key, params) {
  const message = document.createElement('div');
  message.className = 'boardMsg';
  message.textContent = t(key, params);
  return message;
}

function boardRankLabel(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
}

registerBoardTab({ id: 'global', labelKey: 'board.global', render: view => renderLeaderboard(view) });
registerBoardTab({ id: 'singleplayer', labelKey: 'board.singleplayer', render: view => renderScores(view) });
registerBoardTab({ id: 'missions', labelKey: 'board.missions', render: view => renderShiftBestsBoard(view) });

if (typeof module !== 'undefined') module.exports = { boardTabs, registerBoardTab, renderBoardPanel, createBoardTable, appendBoardRow, createBoardMessage, boardRankLabel };
