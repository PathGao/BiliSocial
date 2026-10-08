// Service worker: message router + job runner. Other agents add ONE importScripts line and ONE router case each,
// at the marked spots below.
importScripts("lib/bili.js", "lib/store.js", "lib/jobs.js");
importScripts("lib/ai.js", "lib/push.js");
importScripts("lib/me.js");
importScripts("lib/graph-ai.js");
importScripts("lib/feed.js");

const ROUTES = {
  "bs-job-start": (m) => Jobs.start(m.job, m.opts || null),
  "bs-job-stop": (m) => Jobs.stop(m.job),
  // act 1 follow, 2 unfollow; keeps bs_followings and bs_unfollowed in step. Unfollow adds bs_unfollowed[mid] = { at,
  // tagIds, source: "app" } unless a record exists (the 关注 page may also write it, then moves the tags itself); follow
  // removes the record and puts its tags back where bs_up_tag_map has none. Both are safe to repeat from a page.
  "bs-follow": async (m) => {
    const mid = String(m.mid);
    await Bili.modifyRelation(mid, m.act);
    const at = Math.floor(Date.now() / 1000);
    let rec;
    if (m.act === 2) {
      const tagIds = (await Store.get("bs_up_tag_map", {}))[mid] || [];
      await Store.update("bs_unfollowed", (u) => (u[mid] ? u : { ...u, [mid]: { at, tagIds, source: "app" } }));
    } else {
      await Store.update("bs_unfollowed", (u) => {
        rec = u[mid];
        delete u[mid];
        return u;
      });
      const live = new Set((await Store.get("bs_up_tags", [])).map((t) => t.id));
      const ids = (rec?.tagIds || []).filter((id) => live.has(id));
      if (ids.length) await Store.update("bs_up_tag_map", (map) => (map[mid]?.length ? map : { ...map, [mid]: ids }));
    }
    await Store.update("bs_followings", (f) => {
      const list = (f.list || []).filter((x) => x !== mid);
      const followTime = { ...f.followTime };
      if (m.act === 1) followTime[mid] = at;
      else delete followTime[mid];
      const special = { ...f.special };
      const groups = { ...f.groups };
      if (m.act === 2) { delete special[mid]; delete groups[mid]; } // B站 drops the groups with the follow
      return { ...f, list: m.act === 1 ? [mid, ...list] : list, followTime, special, groups };
    });
  },
  // 特别关注 on/off for an account I follow; keeps bs_followings.special in step. Off moves it from -10 back to its own
  // groups (默认分组 0 when it has none), so it stays followed.
  "bs-special": async (m) => {
    const mid = String(m.mid);
    const f = await Store.get("bs_followings", {});
    if (!f.list?.includes(mid)) throw new Error("还没关注这个人，不能设特别关注");
    if (m.on) await Bili.copyUsers(mid, -10);
    else await Bili.moveUsers(mid, -10, f.groups?.[mid]?.length ? f.groups[mid] : 0);
    await Store.update("bs_followings", (cur) => {
      const special = { ...cur.special };
      if (m.on) special[mid] = 1;
      else delete special[mid];
      return { ...cur, special };
    });
  },
  "bs-ai-tag": (m) => Ai.tag(m),
  "bs-ai-test": (m) => Ai.test(m.ai),
  "bs-push-test": () => Push.test(),
  "bs-stat": (m) => Me.stat(m.mids),
  "bs-ai-name-groups": (m) => GraphAi.nameGroups(m),
  "bs-feed": (m) => Feed.page(m),
  "bs-open-app": (m) => Feed.open(m),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const route = ROUTES[msg?.type];
  if (!route) return false;
  Promise.resolve()
    .then(() => route(msg))
    .then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: e.message, code: e.code }));
  return true;
});

// The toolbar button opens the app, reusing an open app tab.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const tabs = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const tab = tabs.find((c) => c.documentUrl?.startsWith(url)); // app.html#route
  if (tab?.tabId >= 0) {
    await chrome.tabs.update(tab.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// A killed worker comes back on the keep-alive alarm (or any event) and picks up jobs still marked running.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bs-keepalive") Jobs.resumeAll();
});
// After a browser restart nothing else may wake the worker (alarms are not guaranteed to survive a restart).
chrome.runtime.onStartup.addListener(() => Jobs.resumeAll());
// Tabs opened before an install or update have no content script, or an old copy with a dead chrome.runtime. Inject the
// manifest's scripts; the fresh copy tells the old one to remove its chips and stop (MoonDigest #31).
chrome.runtime.onInstalled.addListener(async () => {
  const cs = chrome.runtime.getManifest().content_scripts[0];
  const tabs = await chrome.tabs.query({ url: cs.matches });
  await Promise.allSettled(tabs.map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: cs.js })));
});
Jobs.resumeAll();
