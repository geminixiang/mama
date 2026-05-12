const POLL_MS = 2000;
let polling = false;

async function getState() {
  return chrome.storage.local.get(["serverUrl", "browserId", "browserToken"]);
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

function slimTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title,
    url: tab.url,
    status: tab.status,
  };
}

async function executeCommand(command) {
  const payload = command.payload || {};
  switch (command.type) {
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.map(slimTab) };
    }
    case "open_tab": {
      const tab = await chrome.tabs.create({ url: String(payload.url) });
      return { tab: slimTab(tab) };
    }
    case "activate_tab": {
      const tabId = Number(payload.tabId);
      if (!tabId) throw new Error("tabId is required");
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return { tab: slimTab(tab) };
    }
    case "reload_tab": {
      const tabId = Number(payload.tabId) || (await activeTab())?.id;
      if (!tabId) throw new Error("No active tab to reload");
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, 15000).catch(() => undefined);
      const tab = await chrome.tabs.get(tabId);
      return { tab: slimTab(tab) };
    }
    case "get_active_tab": {
      const tab = await activeTab();
      return { tab: tab ? slimTab(tab) : null };
    }
    case "screenshot": {
      const tab = await activeTab();
      const windowId = Number(payload.windowId) || tab?.windowId;
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      return { dataUrl, url: tab?.url, title: tab?.title, windowId };
    }
    default:
      throw new Error(`Unknown command type: ${command.type}`);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab load"));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function postResult(state, command, result) {
  await fetch(`${state.serverUrl}/api/browser/commands/${encodeURIComponent(command.id)}/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.browserToken}`,
    },
    body: JSON.stringify({ browserId: state.browserId, ...result }),
  });
}

async function pollOnce() {
  const state = await getState();
  if (!state.serverUrl || !state.browserId || !state.browserToken) return;

  const resp = await fetch(
    `${state.serverUrl}/api/browser/commands?browserId=${encodeURIComponent(state.browserId)}`,
    { headers: { authorization: `Bearer ${state.browserToken}` } },
  );
  if (!resp.ok) return;
  const data = await resp.json();
  for (const command of data.commands || []) {
    try {
      const commandData = await executeCommand(command);
      await postResult(state, command, { ok: true, data: commandData });
    } catch (err) {
      await postResult(state, command, { ok: false, error: err.message || String(err) });
    }
  }
}

function startPolling() {
  if (!polling) {
    polling = true;
    setInterval(() => pollOnce().catch(() => undefined), POLL_MS);
  }
  chrome.alarms.create("mama-poll", { periodInMinutes: 0.5 });
  pollOnce().catch(() => undefined);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mama-poll") pollOnce().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(startPolling);
chrome.runtime.onInstalled.addListener(startPolling);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "wake") startPolling();
});
startPolling();
