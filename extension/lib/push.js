// 推送: every bs_settings.pushMinutes, ask B站 whether the video feed has anything new; if so read feed page 1 and
// notify videos whose author has a tag with push on. State in bs_push { baseline, seen: [bvid] }. Defines globalThis.Push.
// The first check only records a baseline, so turning push on never floods old videos.
(() => {
  const ALARM = "bs-push";
  const SEEN_MAX = 300;

  // Pure: feed items to notify. Only UPs carrying a push-on tag, only bvids not seen before.
  function pick(items, tags, tagMap, seen) {
    const on = new Set((tags || []).filter((t) => t.push).map((t) => t.id));
    const old = new Set(seen || []);
    return (items || []).filter((it) => it.bvid && !old.has(it.bvid) && (tagMap?.[it.mid] || []).some((id) => on.has(id)));
  }

  // Pure: next seen list, newest first, capped.
  const nextSeen = (items, seen) => [...new Set([...(items || []).map((it) => it.bvid).filter(Boolean), ...(seen || [])])].slice(0, SEEN_MAX);

  async function check() {
    const s = await Store.get("bs_settings", {});
    const tags = await Store.get("bs_up_tags", []);
    if (!s.push || !chrome.notifications || !tags.some((t) => t.push)) return;
    const st = await Store.get("bs_push", {});
    if (st.baseline && !(await Bili.feedUpdate(st.baseline)).updateNum) return;
    const feed = await Bili.feedVideo();
    if (st.baseline) {
      const tagMap = await Store.get("bs_up_tag_map", {});
      const names = new Map(tags.map((t) => [t.id, t.name]));
      for (const it of pick(feed.items, tags, tagMap, st.seen)) {
        chrome.notifications.create(it.bvid, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: `${it.name} 发了新视频`,
          message: it.title || "",
          contextMessage: (tagMap[it.mid] || []).map((id) => names.get(id)).filter(Boolean).join("、")
        });
      }
    }
    await Store.set("bs_push", { baseline: feed.baseline || st.baseline || "", seen: nextSeen(feed.items, st.seen) });
  }

  // Keep one alarm while push is on; recreate only when the period changes (create() restarts the timer).
  async function schedule() {
    const s = await Store.get("bs_settings", {});
    const period = Math.max(1, Number(s.pushMinutes) || 15);
    const cur = await chrome.alarms.get(ALARM);
    if (!s.push) return cur && chrome.alarms.clear(ALARM);
    if (cur?.periodInMinutes !== period) chrome.alarms.create(ALARM, { periodInMinutes: period });
  }

  async function test() {
    if (!chrome.notifications) throw new Error("还没有通知权限，先打开推送开关");
    chrome.notifications.create("bs-test", { type: "basic", iconUrl: "icons/icon128.png", title: "B站社交圈", message: "推送能用。有新视频时会这样提醒你。" });
  }

  // chrome.notifications only exists once the optional permission is granted.
  let hooked = false;
  function hookClicks() {
    if (hooked || !chrome.notifications) return;
    hooked = true;
    chrome.notifications.onClicked.addListener((id) => {
      chrome.notifications.clear(id);
      if (id !== "bs-test") chrome.tabs.create({ url: `https://www.bilibili.com/video/${id}` });
    });
  }

  if (globalThis.chrome?.alarms) {
    hookClicks();
    chrome.permissions.onAdded.addListener(hookClicks);
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === ALARM) check().catch((e) => console.warn("push check", e));
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.bs_settings) schedule();
    });
    schedule();
  }

  globalThis.Push = { pick, nextSeen, check, schedule, test };
})();
