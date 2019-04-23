/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirm from '/extlib/RichConfirm.js';
import TabIdFixer from '/extlib/TabIdFixer.js';

import {
  log as internalLogger,
  wait,
  configs
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as MetricsData from '/common/metrics-data.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsUpdate from '/common/tabs-update.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as Permissions from '/common/permissions.js';
import * as TSTAPI from '/common/tst-api.js';
import * as SidebarConnection from '/common/sidebar-connection.js';

import Tab from '/common/Tab.js';
import Window from '/common/Window.js';

import * as ApiTabsListener from './api-tabs-listener.js';
import * as Commands from './commands.js';
import * as Tree from './tree.js';
import * as TreeStructure from './tree-structure.js';
import * as BackgroundCache from './background-cache.js';
import * as TabContextMenu from './tab-context-menu.js';
import * as Migration from './migration.js';
import './browser-action-menu.js';
import './successor-tab.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('background/background', ...args);
}

export const onInit    = new EventListenerManager();
export const onBuilt   = new EventListenerManager();
export const onReady   = new EventListenerManager();
export const onDestroy = new EventListenerManager();
export const onTreeCompletelyAttached = new EventListenerManager();

let mInitialized = false;
const mPreloadedCaches = new Map();

export async function init() {
  MetricsData.add('init: start');
  window.addEventListener('pagehide', destroy, { once: true });

  onInit.dispatch();
  SidebarConnection.init();

  // Read caches from existing tabs at first, for better performance.
  // Those promises will be resolved while waiting for waitUntilCompletelyRestored().
  browser.windows.getAll({
    populate:    true,
    windowTypes: ['normal']
  }).catch(ApiTabs.createErrorHandler())
    .then(windows => {
      for (const window of windows) {
        const tab = window.tabs[window.tabs.length - 1];
        browser.sessions.getTabValue(tab.id, Constants.kWINDOW_STATE_CACHED_TABS)
          .catch(ApiTabs.createErrorSuppressor())
          .then(cache => mPreloadedCaches.set(tab.id, cache));
      }
    });

  let promisedWindows;
  await MetricsData.addAsync('init: waiting for waitUntilCompletelyRestored, ContextualIdentities.init and configs.$loaded', Promise.all([
    waitUntilCompletelyRestored().then(() => {
      // don't wait at here for better performance
      promisedWindows = browser.windows.getAll({
        populate:    true,
        windowTypes: ['normal']
      }).catch(ApiTabs.createErrorHandler());
    }),
    ContextualIdentities.init(),
    configs.$loaded
  ]));
  MetricsData.add('init: prepare');
  EventListenerManager.debug = configs.debug;

  Migration.migrateConfigs();
  configs.grantedRemovingTabIds = []; // clear!
  MetricsData.add('init: Migration.migrateConfigs');

  updatePanelUrl();

  const windows = await MetricsData.addAsync('init: getting all tabs across windows', promisedWindows); // wait at here for better performance
  const restoredFromCache = await MetricsData.addAsync('init: rebuildAll', rebuildAll(windows));
  mPreloadedCaches.clear();
  await MetricsData.addAsync('init: TreeStructure.loadTreeStructure', TreeStructure.loadTreeStructure(windows, restoredFromCache));

  ApiTabsListener.startListen();

  // Open new tab now (after listening is started, before the end of initialization),
  // because the sidebar may fail to track tabs.onCreated for the tab while its
  // initializing process.
  const promisedNotificationTab = Migration.notifyNewFeatures();
  if (promisedNotificationTab)
    await promisedNotificationTab;

  ContextualIdentities.startObserve();
  onBuilt.dispatch();
  MetricsData.add('init: started listening');

  //provide reloadSidebars() implementation for use in Tab context menu (avoiding cyclical dependencies)
  const reloadSidebarsCommand = reloadSidebars;
  TabContextMenu.init(reloadSidebarsCommand);
  MetricsData.add('init: started initializing of context menu');

  Permissions.clearRequest();

  for (const windowId of restoredFromCache.keys()) {

    //MAYBE: Is await needed for lines commented with "//await needed?"
    //Can remove some of the 4 added await uses, possibly later, to speed-up,
    //but suggest doing *after* fixing the remaining major initialization issues from #2238 (in case this help to avoid or pinpoint them) like:
    // "Error: Could not establish connection. Receiving end does not exist" 
    // and "Tab opened during init never sets favicon or sometimes title"?
  
    if (!restoredFromCache[windowId])
      await BackgroundCache.reserveToCacheTree(windowId); //await needed?
    await TabsUpdate.completeLoadingTabs(windowId); //await needed?
  }

  for (const tab of Tab.getAllTabs(null, { iterator: true })) {
    await updateSubtreeCollapsed(tab); //await needed?
  }
  for (const tab of Tab.getActiveTabs()) {
    for (const ancestor of tab.$TST.ancestors) {
      Tree.collapseExpandTabAndSubtree(ancestor, {
        collapsed: false,
        justNow:   true
      });
    }
  }

  // we don't need to await that for the initialization of TST itself.
  //waiting to see if helps fix the m
  await MetricsData.addAsync('init: initializing API for other addons', TSTAPI.initAsBackend()); //await needed?

  mInitialized = true;
  onReady.dispatch();
  BackgroundCache.activate();
  TreeStructure.startTracking();

  if (configs.useCachedTree && configs.useCachedTreeBackgroundExport) {
    //WARNING: simply results in "Error: Could not establish connection. Receiving end does not exist" on sendMessage()
    //so disabled by default now, and never done if caching is disabled
    //workaround for: https://github.com/piroor/treestyletab/issues/2199 and parts of https://github.com/piroor/treestyletab/issues/2238
    await exportTabsToSidebar();
  }

  log(`Startup metrics for ${TabsStore.tabs.size} tabs: `, MetricsData.toString());
}

//auto-fix if tab sync or other issues occur, either automatically (eg. to be called from syncTabsOrder()) or on-demand (eg. via sidebar context menu by user)
//workaround for: https://github.com/piroor/treestyletab/issues/2199 and parts of https://github.com/piroor/treestyletab/issues/2238
export async function reloadSidebars() {
  const promisedWindows = browser.windows.getAll({
    populate:    true,
    windowTypes: ['normal']
  }).catch(ApiTabs.createErrorHandler());

  const windows = await MetricsData.addAsync('reinit: getting all tabs across windows', promisedWindows);
  /*const restoredFromCache = */ await MetricsData.addAsync('reinit: rebuildAll', rebuildAll(windows));
  mPreloadedCaches.clear();
  //await MetricsData.addAsync('init: TreeStructure.loadTreeStructure', TreeStructure.loadTreeStructure(windows, restoredFromCache));
  //need to notify Sidebar to refresh?
}
export async function exportTabsToSidebar() {
  //is this required only for session restore?

  const skipInitIfAlreadyOpen = true //original = true;

  // notify that the master process is ready.
  for (const window of TabsStore.windows.values()) {
    if (skipInitIfAlreadyOpen && SidebarConnection.isOpen(window.id))
      return;
    //changed to await to see if reduces frequency of below error
    await TabsUpdate.completeLoadingTabs(window.id); // failsafe

    //WARNING: sendMessage() results in "Error: Could not establish connection. Receiving end does not exist"
    //MAYBE: so if want to continue to use this, should either have sidebar do after init or cache here until requested by sidebar?

    browser.runtime.sendMessage({
      type:     Constants.kCOMMAND_PING_TO_SIDEBAR,
      windowId: window.id,
      tabs:     window.export(true) // send tabs together to optimize further initialization tasks in the sidebar
    });
  }
}

function updatePanelUrl() {
  const panel = browser.extension.getURL(`/sidebar/sidebar.html?style=${encodeURIComponent(configs.style)}`);
  browser.sidebarAction.setPanel({ panel });
}

function waitUntilCompletelyRestored() {
  log('waitUntilCompletelyRestored');
  return new Promise((resolve, _aReject) => {
    let timeout;
    let resolver;
    let onNewTabRestored = async (tab, _info = {}) => {
      clearTimeout(timeout);
      log('new restored tab is detected.');
      // Read caches from restored tabs while waiting, for better performance.
      browser.sessions.getTabValue(tab.id, Constants.kWINDOW_STATE_CACHED_TABS)
        .catch(ApiTabs.createErrorSuppressor())
        .then(cache => mPreloadedCaches.set(tab.id, cache));
      //uniqueId = uniqueId && uniqueId.id || '?'; // not used
      timeout = setTimeout(resolver, 100);
    };
    browser.tabs.onCreated.addListener(onNewTabRestored);
    resolver = (() => {
      log('timeout: all tabs are restored.');
      browser.tabs.onCreated.removeListener(onNewTabRestored);
      timeout = resolver = onNewTabRestored = undefined;
      resolve();
    });
    timeout = setTimeout(resolver, 500);
  });
}

function destroy() {
  browser.runtime.sendMessage({
    type:  TSTAPI.kUNREGISTER_SELF
  }).catch(ApiTabs.createErrorSuppressor());

  // This API doesn't work as expected because it is not notified to
  // other addons actually when browser.runtime.sendMessage() is called
  // on pagehide or something unloading event.
  TSTAPI.sendMessage({
    type: TSTAPI.kNOTIFY_SHUTDOWN
  }).catch(ApiTabs.createErrorSuppressor());

  onDestroy.dispatch();
  ApiTabsListener.endListen();
  ContextualIdentities.endObserve();
}

async function rebuildAll(windows) {
  const restoredFromCache = new Map();
  await Promise.all(windows.map(async (window) => {
    await MetricsData.addAsync(`rebuildAll: tabs in window ${window.id}`, async () => {
      const trackedWindow = TabsStore.windows.get(window.id);
      if (!trackedWindow)
        Window.init(window.id);

      for (const tab of window.tabs) {
        TabIdFixer.fixTab(tab);
        Tab.track(tab);
        Tab.init(tab, { existing: true });
        tryStartHandleAccelKeyOnTab(tab);
      }
      try {
        if (configs.useCachedTree) {
          log(`trying to restore window ${window.id} from cache`);
          const restored = await MetricsData.addAsync(`rebuildAll: restore tabs in window ${window.id} from cache`, BackgroundCache.restoreWindowFromEffectiveWindowCache(window.id, {
            owner: window.tabs[window.tabs.length - 1],
            tabs:  window.tabs,
            caches: mPreloadedCaches
          }));
          restoredFromCache.set(window.id, restored);
          log(`window ${window.id}: restored from cache?: `, restored);
          if (restored)
            return;
        }
      }
      catch(e) {
        log(`failed to restore tabs for ${window.id} from cache `, e);
      }
      try {
        log(`build tabs for ${window.id} from scratch`);
        Window.init(window.id);
        for (let tab of window.tabs) {
          tab = Tab.get(tab.id);
          tab.$TST.clear(); // clear dirty restored states
          TabsUpdate.updateTab(tab, tab, { forceApply: true });
          tryStartHandleAccelKeyOnTab(tab);
        }
      }
      catch(e) {
        log(`failed to build tabs for ${window.id}`, e);
      }
      restoredFromCache.set(window.id, false);
    });
    for (const tab of Tab.getGroupTabs(window.id, { iterator: true })) {
      if (!tab.discarded)
        tab.$TST.shouldReloadOnSelect = true;
    }
  }));
  return restoredFromCache;
}

export async function tryStartHandleAccelKeyOnTab(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;
  const granted = await Permissions.isGranted(Permissions.ALL_URLS);
  if (!granted ||
      /^(about|chrome|resource):/.test(tab.url))
    return;
  try {
    //log(`tryStartHandleAccelKeyOnTab: initialize tab ${tab.id}`);
    browser.tabs.executeScript(tab.id, {
      file:            '/common/handle-accel-key.js',
      allFrames:       true,
      matchAboutBlank: true,
      runAt:           'document_start'
    }).catch(ApiTabs.createErrorSuppressor(ApiTabs.handleMissingTabError));
  }
  catch(error) {
    console.log(error);
  }
}

export function reserveToUpdateInsertionPosition(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    if (tab.$TST.reservedUpdateInsertionPosition)
      clearTimeout(tab.$TST.reservedUpdateInsertionPosition);
    tab.$TST.reservedUpdateInsertionPosition = setTimeout(() => {
      if (!tab.$TST)
        return;
      delete tab.$TST.reservedUpdateInsertionPosition;
      updateInsertionPosition(tab);
    }, 100);
  }
}

async function updateInsertionPosition(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;

  const prev = tab.$TST.previousTab;
  if (prev)
    browser.sessions.setTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_AFTER,
      prev.$TST.uniqueId.id
    ).catch(ApiTabs.createErrorSuppressor());
  else
    browser.sessions.removeTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_AFTER
    ).catch(ApiTabs.createErrorSuppressor());

  const next = tab.$TST.nextTab;
  if (next)
    browser.sessions.setTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_BEFORE,
      next.$TST.uniqueId.id
    ).catch(ApiTabs.createErrorSuppressor());
  else
    browser.sessions.removeTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_BEFORE
    ).catch(ApiTabs.createErrorSuppressor());
}


export function reserveToUpdateAncestors(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    if (tab.$TST.reservedUpdateAncestors)
      clearTimeout(tab.$TST.reservedUpdateAncestors);
    tab.$TST.reservedUpdateAncestors = setTimeout(() => {
      if (!tab.$TST)
        return;
      delete tab.$TST.reservedUpdateAncestors;
      updateAncestors(tab);
    }, 100);
  }
}

async function updateAncestors(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;

  browser.sessions.setTabValue(
    tab.id,
    Constants.kPERSISTENT_ANCESTORS,
    tab.$TST.ancestors.map(ancestor => ancestor.$TST.uniqueId.id)
  ).catch(ApiTabs.createErrorSuppressor());
}

export function reserveToUpdateChildren(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    if (tab.$TST.reservedUpdateChildren)
      clearTimeout(tab.$TST.reservedUpdateChildren);
    tab.$TST.reservedUpdateChildren = setTimeout(() => {
      if (!tab.$TST)
        return;
      delete tab.$TST.reservedUpdateChildren;
      updateChildren(tab);
    }, 100);
  }
}

async function updateChildren(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;

  browser.sessions.setTabValue(
    tab.id,
    Constants.kPERSISTENT_CHILDREN,
    tab.$TST.children.map(child => child.$TST.uniqueId.id)
  ).catch(ApiTabs.createErrorSuppressor());
}

function reserveToUpdateSubtreeCollapsed(tab) {
  if (!mInitialized ||
      !TabsStore.ensureLivingTab(tab))
    return;
  if (tab.$TST.reservedUpdateSubtreeCollapsed)
    clearTimeout(tab.$TST.reservedUpdateSubtreeCollapsed);
  tab.$TST.reservedUpdateSubtreeCollapsed = setTimeout(() => {
    if (!tab.$TST)
      return;
    delete tab.$TST.reservedUpdateSubtreeCollapsed;
    updateSubtreeCollapsed(tab);
  }, 100);
}

async function updateSubtreeCollapsed(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;
  if (tab.$TST.subtreeCollapsed)
    tab.$TST.addState(Constants.kTAB_STATE_SUBTREE_COLLAPSED, { permanently: true });
  else
    tab.$TST.removeState(Constants.kTAB_STATE_SUBTREE_COLLAPSED, { permanently: true });
}

export async function confirmToCloseTabs(tabIds, options = {}) {
  tabIds = tabIds.filter(id => !configs.grantedRemovingTabIds.includes(id));
  const count = tabIds.length;
  log('confirmToCloseTabs ', { tabIds, count, options });
  if (count <= 1 ||
      !configs.warnOnCloseTabs ||
      Date.now() - configs.lastConfirmedToCloseTabs < 500)
    return true;

  const tabs = await browser.tabs.query({
    active:   true,
    windowId: options.windowId
  }).catch(ApiTabs.createErrorHandler());

  const granted = await Permissions.isGranted(Permissions.ALL_URLS);
  if (!granted ||
      /^(about|chrome|resource):/.test(tabs[0].url) ||
      (!options.showInTab &&
       SidebarConnection.isOpen(options.windowId) &&
       SidebarConnection.hasFocus(options.windowId)))
    return browser.runtime.sendMessage({
      type:     Constants.kCOMMAND_CONFIRM_TO_CLOSE_TABS,
      tabIds:   tabs.map(tab => tab.id),
      windowId: options.windowId
    }).catch(ApiTabs.createErrorHandler());

  const result = await RichConfirm.showInTab(tabs[0].id, {
    message: browser.i18n.getMessage('warnOnCloseTabs_message', [count]),
    buttons: [
      browser.i18n.getMessage('warnOnCloseTabs_close'),
      browser.i18n.getMessage('warnOnCloseTabs_cancel')
    ],
    checkMessage: browser.i18n.getMessage('warnOnCloseTabs_warnAgain'),
    checked: true
  });
  switch (result.buttonIndex) {
    case 0:
      if (!result.checked)
        configs.warnOnCloseTabs = false;
      configs.grantedRemovingTabIds = Array.from(new Set((configs.grantedRemovingTabIds || []).concat(tabIds)));
      log('confirmToCloseTabs: granted ', configs.grantedRemovingTabIds);
      return true;
    default:
      return false;
  }
}
Commands.onTabsClosing.addListener((tabIds, options = {}) => {
  return confirmToCloseTabs(tabIds, options);
});

Tab.onCreated.addListener((tab, info = {}) => {
  if (!info.duplicated)
    return;
  // Duplicated tab has its own tree structure information inherited
  // from the original tab, but they must be cleared.
  reserveToUpdateAncestors(tab);
  reserveToUpdateChildren(tab);
  reserveToUpdateInsertionPosition([
    tab,
    tab.$TST.nextTab,
    tab.$TST.previousTab
  ]);
});

Tab.onUpdated.addListener((tab, changeInfo) => {
  // Loading of "about:(unknown type)" won't report new URL via tabs.onUpdated,
  // so we need to see the complete tab object.
  const status = changeInfo.status || tab && tab.status;
  const url = changeInfo.url ? changeInfo.url :
    status == 'complete' && tab ? tab.url : '';
  if (tab &&
      Constants.kSHORTHAND_ABOUT_URI.test(url)) {
    const shorthand = RegExp.$1;
    const oldUrl = tab.url;
    wait(100).then(() => { // redirect with delay to avoid infinite loop of recursive redirections.
      if (tab.url != oldUrl)
        return;
      browser.tabs.update(tab.id, {
        url: url.replace(Constants.kSHORTHAND_ABOUT_URI, Constants.kSHORTHAND_URIS[shorthand] || 'about:blank')
      }).catch(ApiTabs.createErrorSuppressor(ApiTabs.handleMissingTabError));
      if (shorthand == 'group')
        tab.$TST.addState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
    });
  }

  if (changeInfo.status || changeInfo.url)
    tryStartHandleAccelKeyOnTab(tab);
});

Tab.onTabInternallyMoved.addListener((tab, info = {}) => {
  reserveToUpdateInsertionPosition([
    tab,
    tab.$TST.previousTab,
    tab.$TST.nextTab,
    info.oldPreviousTab,
    info.oldNextTab
  ]);
});

Tab.onMoved.addListener((tab, moveInfo) => {
  reserveToUpdateInsertionPosition([
    tab,
    moveInfo.oldPreviousTab,
    moveInfo.oldNextTab,
    tab.$TST.previousTab,
    tab.$TST.nextTab
  ]);
});

Tree.onAttached.addListener((tab, attachInfo) => {
  reserveToUpdateAncestors([tab].concat(tab.$TST.descendants));
  reserveToUpdateChildren(attachInfo.parent);
});

Tree.onDetached.addListener((tab, detachInfo) => {
  reserveToUpdateAncestors([tab].concat(tab.$TST.descendants));
  reserveToUpdateChildren(detachInfo.oldParentTab);
});

Tree.onSubtreeCollapsedStateChanging.addListener((tab, _info) => { reserveToUpdateSubtreeCollapsed(tab); });

// This section should be removed and define those context-fill icons
// statically on manifest.json on future versions of Firefox.
// See also: https://github.com/piroor/treestyletab/issues/2053
function applyThemeColorToIcon() {
  if (configs.applyThemeColorToIcon) {
    const icons = { path: browser.runtime.getManifest().variable_color_icons };
    browser.browserAction.setIcon(icons);
    browser.sidebarAction.setIcon(icons);
  }
}
configs.$loaded.then(applyThemeColorToIcon);

configs.$addObserver(key => {
  switch (key) {
    case 'style':
      updatePanelUrl();
      break;
    case 'applyThemeColorToIcon':
      applyThemeColorToIcon();
      break;
    case 'debug':
      EventListenerManager.debug = configs.debug;
      break;

    case 'testKey': // for tests/utils.js
      browser.runtime.sendMessage({
        type:  Constants.kCOMMAND_NOTIFY_TEST_KEY_CHANGED,
        value: configs.testKey
      });
      break;
  }
});
