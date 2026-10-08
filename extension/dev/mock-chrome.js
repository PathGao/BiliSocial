// Dev-only fake chrome.* so app.html's pages render from file:// (dev/index.html). No-op inside the real extension.
// Storage starts from window.BS_FIXTURES (BiliSocial/dev-fixtures/storage.js, made by make-fixtures.mjs); jobs fake their progress.
(() => {
  if (globalThis.chrome?.runtime?.id) return;

  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const data = clone(window.BS_FIXTURES || {});
  const listeners = new Set();

  function emit(changes) {
    for (const fn of listeners) fn(changes, "local");
  }
  const local = {
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        if (k in data) out[k] = clone(data[k]);
        else if (typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
      }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        changes[k] = { oldValue: clone(data[k]) };
        delete data[k];
      }
      emit(changes);
    }
  };

  // ---- fake jobs ----
  // Progress looks like the real thing: real step names and totals, one unit per 0.3 s × running jobs (the real queue
  // is ~1.2 s per request, shared). Jobs already marked running in the fixture keep moving, 关注的关注 queues behind
  // 投稿内容 like lib/jobs.js. ?sync puts the fake fixture mid-sync (like the real snapshot); ?hold adds a 90 s 限流
  // pause to every running job.
  const q = new URLSearchParams(location.search);
  const now = () => Math.floor(Date.now() / 1000);
  const FAKE = { mine: ["拉我的关注", 60], circle: ["拉关注的关注", 240], content: ["第 2/2 步 · 查每个人的投稿", 600], interactions: ["第 5/5 步 · 数每个私信对话的条数", 908] };
  const base = { finishedAt: null, error: null, throttled: false, hold: null, after: null };
  if (q.has("sync")) {
    data.bs_jobs = {
      ...data.bs_jobs,
      circle: { ...base, running: false, after: "content", done: 116, total: 240, step: FAKE.circle[0], startedAt: now() - 3600, cursor: null },
      content: { ...base, lastFinishedAt: now() - 86400, running: true, done: 94, total: 600, step: FAKE.content[0], startedAt: now() - 900, cursor: { phase: "arc" } },
      interactions: { ...base, running: true, done: 126, total: 908, step: FAKE.interactions[0], startedAt: now() - 1200, cursor: { phase: "pm" } }
    };
  }
  if (q.has("hold")) for (const j of Object.values(data.bs_jobs || {})) if (j.running) j.hold = { until: now() + 90, why: "throttled", n: 1, of: 2 };

  const timers = {};
  async function patchJob(job, fields) {
    const jobs = (await local.get("bs_jobs")).bs_jobs || {};
    jobs[job] = { ...jobs[job], ...fields };
    await local.set({ bs_jobs: jobs });
  }
  const runningCount = () => Object.values(data.bs_jobs || {}).filter((j) => j.running).length;
  function tick(job) {
    timers[job] = setTimeout(async () => {
      const j = data.bs_jobs?.[job];
      if (!j?.running) return void delete timers[job];
      if (j.hold?.until > now()) return tick(job);
      const done = (j.done || 0) + 1;
      if (done < j.total) { await patchJob(job, { done, hold: null }); return tick(job); }
      delete timers[job];
      await patchJob(job, { done, running: false, step: "", finishedAt: now(), lastFinishedAt: now(), cursor: null, hold: null });
      if (job === "content" && data.bs_jobs.circle?.after === "content") startJob("circle");
    }, 300 * Math.max(1, runningCount()));
  }
  async function startJob(job) {
    if (!FAKE[job]) throw new Error(`没有这个任务：${job}`);
    if (timers[job]) return;
    if (job === "circle" && data.bs_jobs?.content?.running) return patchJob(job, { after: "content" });
    if (job === "content" && data.bs_jobs?.circle?.running) { await stopJob("circle"); await patchJob("circle", { after: "content" }); }
    const prev = data.bs_jobs?.[job] || {};
    const fresh = prev.finishedAt || !prev.done;
    await patchJob(job, {
      ...base, running: true, step: !fresh && prev.step ? prev.step : FAKE[job][0], done: fresh ? 0 : prev.done,
      total: fresh || !prev.total ? FAKE[job][1] : prev.total, startedAt: fresh ? now() : prev.startedAt
    });
    tick(job);
  }
  async function stopJob(job) {
    clearTimeout(timers[job]);
    delete timers[job];
    await patchJob(job, { running: false, after: null, hold: null });
    if (job === "content" && data.bs_jobs.circle?.after === "content") startJob("circle");
  }
  for (const [job, j] of Object.entries(data.bs_jobs || {})) if (j.running && FAKE[job]) tick(job);

  async function handle(msg) {
    switch (msg.type) {
      case "bs-job-start": return startJob(msg.job);
      case "bs-job-stop": return stopJob(msg.job);
      case "bs-follow": {
        const f = (await local.get("bs_followings")).bs_followings || { list: [] };
        const list = f.list.filter((x) => x !== String(msg.mid));
        const special = { ...f.special };
        if (msg.act === 2) delete special[msg.mid];
        await local.set({ bs_followings: { ...f, list: msg.act === 1 ? [String(msg.mid), ...list] : list, special } });
        // Same bs_unfollowed bookkeeping as background.js: unfollow records { at, tagIds, source: "app" } unless one exists;
        // follow drops the record and puts its tags back where bs_up_tag_map has none.
        const mid = String(msg.mid);
        const got = await local.get(["bs_unfollowed", "bs_up_tag_map"]);
        const gone = got.bs_unfollowed || {};
        const map = got.bs_up_tag_map || {};
        if (msg.act === 2) gone[mid] ||= { at: Math.floor(Date.now() / 1000), tagIds: map[mid] || [], source: "app" };
        else {
          if (gone[mid]?.tagIds?.length && !map[mid]?.length) map[mid] = gone[mid].tagIds;
          delete gone[mid];
        }
        await local.set({ bs_unfollowed: gone, bs_up_tag_map: map });
        return null;
      }
      // Fake AI: every other UP gets a new tag 「试试」, the rest lose their first tag if they have one.
      case "bs-ai-tag": {
        const first = (mid) => (data.bs_up_tags || []).find((t) => t.id === data.bs_up_tag_map?.[mid]?.[0])?.name;
        const rows = msg.mids.slice(0, 6).map((mid) => [mid, first(mid) ? { add: [], remove: [first(mid)], reason: "开发页假删" } : { add: ["试试"], remove: [], reason: "开发页假答" }]);
        return { newTags: ["试试"], assignments: Object.fromEntries(rows), note: "开发页的假提案" };
      }
      case "bs-special": {
        const f = (await local.get("bs_followings")).bs_followings || { list: [] };
        if (!f.list.includes(String(msg.mid))) throw new Error("还没关注这个人，不能设特别关注");
        const special = { ...f.special };
        if (msg.on) special[msg.mid] = 1;
        else delete special[msg.mid];
        await local.set({ bs_followings: { ...f, special } });
        return null;
      }
      // Fake follower counts: cached ones kept, the rest random, ~200 ms per batch.
      case "bs-stat": {
        await new Promise((r) => setTimeout(r, 200));
        const stats = (await local.get("bs_stats")).bs_stats || {};
        const out = {};
        for (const mid of msg.mids) out[mid] = (stats[mid] ||= { follower: Math.floor(10 ** (1 + Math.random() * 5)), at: now() }).follower;
        await local.set({ bs_stats: stats });
        return out;
      }
      case "bs-ai-name-groups": return { names: msg.groups.map((g, k) => ({ key: g.key, name: `假圈子${k + 1}`, desc: "开发页的假名字" })) };
      // ---- feed agent: fake 关注 video feed for #feed (6 pages of 12, one video every 5 hours) and the chip link ----
      case "bs-feed": {
        const n = Number(msg.offset) || 0, mids = data.bs_followings?.list || ["1"], people = data.bs_people || {};
        const items = Array.from({ length: 12 }, (_, i) => {
          const k = n * 12 + i, mid = mids[(k * 7) % mids.length], name = people[mid]?.name || mid;
          return { bvid: `BVdev${k}`, title: `开发页的假视频 ${k + 1}：${name} 的新投稿`, cover: "", duration: `${3 + (k % 20)}:${String(k % 60).padStart(2, "0")}`, play: (k * 7919) % 300000, mid, name, face: people[mid]?.face || "", at: Math.floor(Date.now() / 1000) - k * 5 * 3600 };
        });
        return { items, offset: String(n + 1), hasMore: n < 5 };
      }
      case "bs-open-app": location.hash = msg.hash; return null;
      // ---- end feed agent ----
      case "bs-ai-test": case "bs-push-test": return "ok";
      default: throw new Error(`开发页没有这个后台功能：${msg.type}`);
    }
  }

  globalThis.chrome = {
    storage: {
      local,
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) }
    },
    runtime: {
      getURL: (p) => `../${p}`,
      async sendMessage(msg) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          return { ok: true, data: await handle(msg) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
    },
    cookies: { get: async () => ({ value: "dev" }) }
  };
})();
