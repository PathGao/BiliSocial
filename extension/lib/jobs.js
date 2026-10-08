// Resumable crawl jobs (mine, circle, content, interactions). Defines globalThis.Jobs. Needs Bili and Store.
// Progress goes to bs_jobs[job]: { running, done, total, step, startedAt, finishedAt, error, throttled, cursor, hold, after, beat }.
//
// Surviving the service worker being killed:
// - Every job persists what it has finished (content skips accounts already in storage, circle those stored or checked
//   during this run; mine, circle and interactions keep a phase cursor, interactions also its working state in bs_interactions_work), so a restart redoes at most one unit.
// - While any job runs, an extension API call every 20 s keeps the worker alive (each call resets the idle timer),
//   and a 1-minute "bs-keepalive" alarm wakes a killed worker; background.js then calls Jobs.resumeAll(), which
//   restarts every job still marked running.
(() => {
  const WORK = "bs_interactions_work";
  const now = () => Math.floor(Date.now() / 1000);
  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const pick = (x) => ({ mid: x.mid, name: x.name, face: x.face, sign: x.sign || "", ov: x.ov || "" });
  const LOGIN_FIRST = "先同步「我的关注和粉丝」";
  // arc/search codes that mean the account is gone for good; any other code is temporary and retried next run.
  // -404 啥都木有 (no such user), -626 用户不存在.
  const GONE_CODES = new Set([-404, -626]);
  // Names B站 puts on a closed account; the default face is noface.jpg.
  const PLACEHOLDER_NAMES = new Set(["", "账号已注销"]);
  const isDefaultFace = (f) => !f || /\/noface\.(jpg|gif|png)/.test(f);

  // Pure: the bs_people entry after seeing `nu`. A placeholder never replaces a known name or face; a closed account
  // keeps its old name and gets gone: true.
  function mergePerson(old, nu) {
    const gone = nu.name === "账号已注销";
    if (!old) return gone ? { ...nu, gone: true } : nu;
    const out = { ...old, ...nu };
    if (PLACEHOLDER_NAMES.has(nu.name || "") && old.name) out.name = old.name;
    if (isDefaultFace(nu.face) && !isDefaultFace(old.face)) out.face = old.face;
    if (gone) {
      out.gone = true;
      if (!nu.sign) out.sign = old.sign || "";
    } else delete out.gone;
    return out;
  }

  const running = new Map(); // job -> { stop, promise }

  // Collects map entries in memory and writes them in one storage call. due(): 5 entries waiting or 15 s since the last
  // write, so a killed worker loses little.
  function buffer(key, onlyMissing) {
    let pending = {};
    let n = 0, at = Date.now();
    return {
      add(id, value) { if (!onlyMissing || !pending[id]) { pending[id] = value; n++; } },
      due: () => n >= 5 || (n > 0 && Date.now() - at >= 15000),
      async flush() {
        const out = pending;
        pending = {};
        n = 0;
        at = Date.now();
        if (!Object.keys(out).length) return;
        await Store.update(key, (cur) => {
          for (const [k, v] of Object.entries(out)) if (!onlyMissing || !cur[k]) cur[k] = key === "bs_people" ? mergePerson(cur[k], v) : v;
          return cur;
        });
      }
    };
  }

  // ---------------------------------------------------------------- mine
  async function mine(ctx) {
    const { api } = ctx;
    const c = ctx.cursor || { phase: "me" };
    if (c.phase === "me") {
      await ctx.progress({ step: "读取我的账号", done: 0, total: 0, cursor: c });
      const nav = await api.nav();
      if (!nav.isLogin) throw fail("未登录 B站：先在这个浏览器里登录 B站", "NOT_LOGGED_IN");
      const stat = await api.relationStat(nav.mid);
      const card = (await api.userCards([nav.mid]).catch(() => []))[0];
      await Store.set("bs_me", { mid: nav.mid, name: nav.name, face: nav.face, sign: card?.sign || "", following: stat.following, follower: stat.follower, at: now() });
      c.phase = "followings";
    }
    const me = await Store.get("bs_me");
    if (c.phase === "followings") {
      await ctx.progress({ step: "拉我的关注", done: 0, total: me.following, cursor: c });
      const list = [];
      const followTime = {};
      const special = {};
      const groups = {};
      const people = buffer("bs_people");
      let total = 0;
      for (let pn = 1; pn <= 100; pn++) {
        const r = await api.followings(me.mid, pn);
        if (r.code !== 0) throw fail(`拉我的关注失败：${r.code} ${r.message || ""}`);
        total = r.total;
        for (const x of r.list) {
          list.push(x.mid);
          if (x.mtime) followTime[x.mid] = x.mtime;
          if (x.special) special[x.mid] = 1;
          if (x.groups?.length) groups[x.mid] = x.groups;
          people.add(x.mid, pick(x));
        }
        await ctx.progress({ done: list.length, total: Math.max(r.total, list.length) });
        if (!r.list.length || list.length >= r.total) break;
      }
      await people.flush();
      const fresh = { list: [...new Set(list)], followTime, special, groups, complete: list.length >= total };
      const unf = await Store.get("bs_unfollowed", {});
      const tagMap = await Store.get("bs_up_tag_map", {});
      const live = new Set((await Store.get("bs_up_tags", [])).map((t) => t.id));
      let diff;
      await Store.update("bs_followings", (cur) => {
        diff = followDiff(cur, fresh, unf, tagMap, live, ctx.startedAt, now());
        return diff.followings;
      });
      // Only entries this sync decided change; the 关注 page writes these keys too.
      await Store.update("bs_unfollowed", (u) => {
        for (const [mid, rec] of Object.entries(diff.gone)) if (!u[mid]) u[mid] = rec;
        for (const mid of diff.back) delete u[mid];
        return u;
      });
      await Store.update("bs_up_tag_map", (m) => {
        for (const mid of Object.keys(diff.gone)) delete m[mid];
        for (const [mid, ids] of Object.entries(diff.restore)) if (!m[mid]?.length) m[mid] = ids;
        return m;
      });
      c.phase = "fans";
    }
    if (c.phase === "fans") {
      await ctx.progress({ step: "拉我的粉丝", done: 0, total: me.follower, cursor: c });
      const list = [];
      const seen = new Set();
      const people = buffer("bs_people");
      let total = 0;
      for (let pn = 1; pn <= 100; pn++) {
        const r = await api.followers(me.mid, pn);
        total = r.total;
        for (const x of r.list) {
          if (seen.has(x.mid)) continue;
          seen.add(x.mid);
          list.push({ mid: x.mid, followTime: x.mtime, mutual: x.mutual });
          people.add(x.mid, pick(x));
        }
        await ctx.progress({ done: list.length, total: Math.max(r.total, list.length) });
        if (!r.list.length || list.length >= r.total) break;
      }
      await people.flush();
      await Store.set("bs_fans", fansDiff(await Store.get("bs_fans", null), list, total, now()));
    }
  }

  // Pure: the new bs_followings plus what changes in bs_unfollowed / bs_up_tag_map. cur = stored bs_followings (with the
  // app's own follows and unfollows during the sync), fresh = the list B站 just gave ({ list, followTime, special, groups,
  // complete }), unf = bs_unfollowed, startedAt = when this sync started.
  // - A follow made here after startedAt and missing from fresh (B站 lags a few seconds) is kept.
  // - An account in unf counts as followed again only when its followTime is newer than the unfollow (back, with its
  //   tags in restore); otherwise (stale list, no followTime) the record stays and it is left out of the list.
  // - Accounts in cur and not in fresh, not already in unf, were unfollowed on B站: gone[mid] = { at, tagIds, source:
  //   "bili" }, their tags move into the record. Only when fresh is complete: a cut list proves nothing.
  function followDiff(cur, fresh, unf, tagMap, live, startedAt, at) {
    const inFresh = new Set(fresh.list);
    const ft = { ...fresh.followTime };
    const kept = (cur.list || []).filter((m) => !inFresh.has(m) && (cur.followTime?.[m] || 0) >= startedAt);
    for (const m of kept) ft[m] = cur.followTime[m];
    const back = [];
    const restore = {};
    const list = [...kept, ...fresh.list].filter((m) => {
      const u = unf[m];
      if (!u) return true;
      if (!((ft[m] || 0) > (u.at || 0))) return false;
      back.push(m);
      const ids = (u.tagIds || []).filter((id) => live.has(id));
      if (ids.length) restore[m] = ids;
      return true;
    });
    const gone = {};
    if (fresh.complete) {
      for (const m of cur.list || []) {
        if (!inFresh.has(m) && !kept.includes(m) && !unf[m]) gone[m] = { at, tagIds: tagMap[m] || [], source: "bili" };
      }
    }
    const inList = new Set(list);
    const only = (o) => Object.fromEntries(Object.entries(o || {}).filter(([m]) => inList.has(m)));
    return {
      followings: { at, list, followTime: only(ft), special: only(fresh.special), groups: only(fresh.groups) },
      gone, back, restore
    };
  }

  // Pure: the new bs_fans. Fans in the old list and not in the new one go to the front of `lost` ({ mid, at, followTime },
  // newest first, ≤500); one who follows again leaves it. When B站 gave only part of the list (fewer than total), only
  // fans who followed after the oldest one returned can be told apart from the cut, so only those count as lost.
  function fansDiff(old, list, total, at) {
    const now = new Set(list.map((f) => f.mid));
    const complete = list.length >= total;
    const floor = complete || !list.length ? -Infinity : Math.min(...list.map((f) => f.followTime || 0));
    const gone = old?.list?.length
      ? old.list.filter((f) => !now.has(f.mid) && (f.followTime || 0) >= floor).map((f) => ({ mid: f.mid, at, followTime: f.followTime }))
      : [];
    const lost = [...gone, ...(old?.lost || []).filter((f) => !now.has(f.mid))].slice(0, 500);
    return { at, list, lost };
  }

  // ---------------------------------------------------------------- circle
  // bs_circle[mid] = { code, total, list, plain, same, sameAt, at, checkedAt }. For someone else B站 gives only the newest
  // 100 followings (2 pages); they come first in list (`plain` of them, absent = all). A cut list (total > plain) then
  // gets the account's followings I follow too from same/followings (not capped; `same` = how many it returned,
  // `sameAt` = when), appended without duplicates: those are the edges between my follows the graph needs.
  // Mode, fixed when a run starts and kept in the cursor so a resume keeps it:
  // - "new": only accounts not stored yet (first run; the automatic run for new follows).
  // - "update" (re-run after a finish): page 1 of each stored public list, see refresh(); hidden lists only once their
  //   last check is HIDDEN_DAYS old; accounts not stored get the whole list.
  // - "full" (opts.full): every list again.
  // Phase 2 fills the common follows of every cut list: in "new" mode only those never filled (also older records),
  // otherwise all of them again (1–2 requests each).
  const CAP = 100;
  const HIDDEN_DAYS = 30; // hidden lists almost never open up: a light monthly probe (the user chose 30 over 7)
  const plainOf = (d) => (d.list || []).slice(0, d.plain ?? (d.list || []).length);
  const isCut = (d) => d?.code === 0 && d.total > plainOf(d).length;
  async function circle(ctx) {
    const targets = (await Store.get("bs_followings"))?.list;
    if (!targets?.length) throw fail(LOGIN_FIRST);
    const c = ctx.cursor || { mode: ctx.opts.full ? "full" : ctx.rerun && !ctx.opts.newOnly ? "update" : "new", phase: "lists" };
    const name = { new: "拉关注的关注", update: "更新关注的关注", full: "全部重查关注的关注" }[c.mode];
    const since = ctx.startedAt;
    const out = buffer("bs_circle");
    const people = buffer("bs_people");
    const flush = async () => { await people.flush(); await out.flush(); };
    let have = await Store.get("bs_circle", {});
    const save = (mid, d) => { have[mid] = d; out.add(mid, d); };

    // A public entry with a new plain list; the common follows found before stay while the list is still cut.
    const withPlain = (old, total, plain) => {
      const d = { code: 0, total, list: plain, plain: plain.length, at: now(), checkedAt: now() };
      if (old?.code === 0 && old.sameAt && total > plain.length) {
        Object.assign(d, { list: [...new Set([...plain, ...old.list.slice(plainOf(old).length)])], same: old.same, sameAt: old.sameAt });
      }
      return d;
    };
    // The whole plain list (≤2 pages); `first` = page 1 when already fetched.
    async function fetchList(mid, old, first) {
      const list = [];
      let total = 0;
      for (let pn = 1; pn <= CAP / 50; pn++) {
        const r = pn === 1 && first ? first : await ctx.api.followings(mid, pn);
        if (r.code !== 0) { if (pn === 1) return { code: r.code, total: 0, list: [], at: now(), checkedAt: now() }; break; } // 22115 = hidden
        total = r.total || total;
        for (const x of r.list) { list.push(x.mid); people.add(x.mid, pick(x)); }
        if (r.list.length < 50 || list.length >= total) break;
      }
      return withPlain(old, total, [...new Set(list)]);
    }
    // Update mode, one request: page 1 is newest first, so the entries before the first stored one are new follows.
    // When the total grew by exactly that many, nothing was removed: the new ones go on top (still ≤100). Otherwise
    // (a removal, >50 new, a stored list that does not add up, a hidden list) the whole list is fetched again.
    async function refresh(mid, old) {
      const r = await ctx.api.followings(mid, 1);
      if (r.code !== 0 || old.code !== 0) return fetchList(mid, old, r);
      const prev = plainOf(old);
      const known = new Set(prev);
      const i = r.list.findIndex((x) => known.has(x.mid));
      if (i < 0 || prev.length !== Math.min(old.total, CAP) || r.total !== old.total + i) return fetchList(mid, old, r);
      const fresh = r.list.slice(0, i);
      for (const x of fresh) people.add(x.mid, pick(x));
      return withPlain(old, r.total, [...fresh.map((x) => x.mid), ...prev].slice(0, CAP));
    }

    try {
      if (c.phase === "lists") {
        const stale = (d) => now() - (d.checkedAt || d.at || 0) >= HIDDEN_DAYS * 86400;
        const skip = (mid) => have[mid] && (c.mode === "new" || (c.mode === "update" && have[mid].code !== 0 && !stale(have[mid])));
        const doneNow = (mid) => have[mid] && (have[mid].checkedAt || have[mid].at || 0) >= since;
        // "new" counts stored accounts as done; "update" leaves the hidden ones it skips out of the total.
        const work = c.mode === "update" ? targets.filter((m) => !skip(m)) : targets;
        let done = work.filter((m) => skip(m) || doneNow(m)).length;
        await ctx.progress({ step: `${name} · 第 1/2 步${c.mode === "update" ? " · 只查第一页" : ""}`, done, total: work.length, cursor: c });
        for (const mid of work) {
          if (skip(mid) || doneNow(mid)) continue;
          save(mid, c.mode === "update" && have[mid] ? await refresh(mid, have[mid]) : await fetchList(mid, have[mid]));
          done++;
          if (out.due()) await flush();
          await ctx.progress({ done });
        }
        await flush();
        c.phase = "same";
      }
      have = await Store.get("bs_circle", {});
      const doneSame = (d) => (d.sameAt || 0) >= since;
      const work = targets.filter((m) => isCut(have[m]) && (c.mode !== "new" || !have[m].sameAt || doneSame(have[m])));
      let done = work.filter((m) => doneSame(have[m])).length;
      await ctx.progress({ step: `${name} · 第 2/2 步 · 补共同关注`, done, total: work.length, cursor: c });
      for (const mid of work) {
        const d = have[mid];
        if (doneSame(d)) continue;
        const mids = [];
        let code = 0;
        // ponytail: 40 pages = 2000 common follows; more follows than that would need a bigger cap
        for (let pn = 1; pn <= 40; pn++) {
          const r = await ctx.api.sameFollowings(mid, pn);
          if (r.code !== 0) { code = r.code; break; }
          for (const x of r.list) mids.push(x.mid);
          if (r.list.length < 50 || mids.length >= r.total) break;
        }
        // Hidden since phase 1: recorded as hidden. Another code: left as is, asked again next run.
        if (code === 22115) save(mid, { code, total: 0, list: [], at: now(), checkedAt: now() });
        else if (!code) {
          const plain = plainOf(d);
          save(mid, { ...d, list: [...new Set([...plain, ...mids])], plain: plain.length, same: mids.length, sameAt: now() });
        }
        done++;
        if (out.due()) await flush();
        await ctx.progress({ done });
      }
    } finally {
      await flush();
    }
  }

  // ---------------------------------------------------------------- content
  // My followings, then accounts followed by ≥5 of them (top 450), same target set as the notes crawl.
  function contentTargets(followings, circleMap, myMid) {
    const l1 = followings.map(String);
    const l1set = new Set(l1);
    const inCount = new Map();
    for (const d of Object.values(circleMap)) if (d.code === 0) for (const v of d.list) inCount.set(String(v), (inCount.get(String(v)) || 0) + 1);
    const l2 = [...inCount]
      .filter(([v, c]) => !l1set.has(v) && v !== String(myMid) && c >= 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 450)
      .map(([v]) => v);
    return [...l1, ...l2];
  }

  // Phase 1 pages the video feed back past slowDays: everyone who posted since then shows up there, so 活跃 is known in
  // minutes (bs_last_post). Phase 2 asks arc/search per account, accounts missing from the feed first (they are the
  // ones whose 慢更 / 断更 / 没投过稿 is still open), then the rest of my followings, then second-layer accounts.
  async function content(ctx) {
    const followings = (await Store.get("bs_followings"))?.list;
    if (!followings?.length) throw fail(LOGIN_FIRST);
    const c = ctx.cursor || { phase: "feed", offset: "" };
    const slowDays = (await Store.get("bs_settings", {})).slowDays || 90;
    const lp = await Store.get("bs_last_post", null);
    const fresh = lp && now() - lp.at < 6 * 3600 && lp.since <= now() - slowDays * 86400;
    if (c.phase === "feed" && !fresh) {
      const map = c.offset && lp ? lp.map : {};
      let since = c.offset && lp ? lp.since : now();
      let pages = 0;
      await ctx.progress({ step: `第 1/2 步 · 翻视频动态，找 ${slowDays} 天内发过视频的人`, done: 0, total: 0, cursor: c });
      // ponytail: 600-page cap (~12000 videos); more follows than that per slowDays would need a bigger cap
      for (let p = 0; p < 600; p++) {
        const r = await ctx.api.feedVideo(c.offset);
        for (const it of r.items) {
          if (!it.mid || !it.at) continue;
          if (!map[it.mid] || it.at > map[it.mid]) map[it.mid] = it.at;
          if (it.at < since) since = it.at;
        }
        c.offset = r.offset;
        pages++;
        if (pages % 10 === 0 || !r.hasMore) {
          await Store.set("bs_last_post", { at: now(), since, map });
          await ctx.progress({ done: Object.keys(map).length, cursor: c });
        }
        if (!r.hasMore || !r.offset || since <= now() - slowDays * 86400) break;
      }
      await Store.set("bs_last_post", { at: now(), since, map });
    }
    c.phase = "arc";
    const seen = (await Store.get("bs_last_post", {}))?.map || {};
    const all = contentTargets(followings, await Store.get("bs_circle", {}), (await Store.get("bs_me"))?.mid);
    const l1 = new Set(followings.map(String));
    const targets = [...all.filter((m) => l1.has(m) && !seen[m]), ...all.filter((m) => l1.has(m) && seen[m]), ...all.filter((m) => !l1.has(m))];
    const have = await Store.get("bs_content", {});
    // Records from older builds with a temporary code are asked again.
    const known = (m) => have[m] && (!have[m].code || GONE_CODES.has(have[m].code));
    const out = buffer("bs_content");
    let done = targets.filter(known).length;
    let skipped = 0;
    const step = "第 2/2 步 · 查每个人的投稿";
    await ctx.progress({ step, done, total: targets.length, cursor: c, skipped });
    try {
      for (const mid of targets) {
        if (known(mid)) continue;
        let r;
        try {
          r = await ctx.api.arcSearch(mid);
        } catch (e) {
          // THROTTLED / NETWORK / STOPPED stop the job. A gone account is recorded; any other answer (WBI -403, -509,
          // HTTP 5xx ...) is temporary: not stored, so the next run asks again.
          if (typeof e.code === "string") throw e;
          if (!GONE_CODES.has(e.code)) {
            skipped++;
            await ctx.progress({ skipped, step: `${step}（${skipped} 个暂时没查到，下次再查）` });
            continue;
          }
          r = { code: e.code, count: 0, tlist: {}, v: [] };
        }
        out.add(mid, { ...r, at: now() });
        done++;
        if (out.due()) await out.flush();
        await ctx.progress({ done });
      }
    } finally {
      await out.flush();
    }
  }

  // ---------------------------------------------------------------- interactions
  // Working state (bs_interactions_work); every unit (a video, a notification kind, a PM session) is assigned, never
  // added to, so redoing a unit after a restart does not double count.
  //
  // 更新 (incremental, the default once a scan has finished) keeps the last finished work in w.prev and redoes only
  // units that changed, with the same result as a full scan:
  // - a video whose comment count (from the space feed) is unchanged keeps its per-person comment counts; the repost
  //   list is reused when the repost count is unchanged. Every repost's own comment area is checked through dynDetail
  //   (1 request each), because comments under a repost do not change the video's counts; it is re-scanned only when
  //   its comment count changed.
  // - notifications are kept by item id and paged from the newest until the first item seen before with the same time
  //   (items are newest first and a like item moves back to the top when it gets a new like).
  // - PM sessions: the whole session list is read again (it also drops deleted sessions); a session whose session_ts is
  //   unchanged keeps its count, the others are counted again.
  // Equal counts can hide a deleted comment plus a new one, and expired notifications stay counted; 完整重扫
  // (opts.full) starts from nothing.
  const freshWork = () => ({ phase: "videos", videos: [], vi: 0, perVideo: {}, feeds: {}, feedItems: {}, talkers: [], sess: {}, ti: 0, pm: {} });
  // acc[mid] = [count, first, last]; work saved by older builds has [count, last].
  const bump = (acc, mid, at) => {
    const [n, first, last] = acc[mid] || [0, 0, 0];
    at = at || 0;
    acc[mid] = [n + 1, at && (!first || at < first) ? at : first, Math.max(last, at)];
  };
  const triple = (v) => (v.length > 2 ? v : [v[0], v[1], v[1]]);

  // Pure: work state -> bs_interactions. Counts stay plain numbers; span[field] = { first, last } for counted fields.
  function aggregate(w, myMid) {
    const byMid = {};
    const entry = (mid) => (byMid[mid] ||= { pm: { count: 0, first: 0, last: 0 }, reply: 0, like: 0, atMe: 0, comments: 0, repostComments: 0, reposts: [], span: {}, last: 0 });
    const touch = (e, at) => { if (at > e.last) e.last = at; };
    const add = (mid, field, v) => {
      const [n, first, last] = triple(v);
      const e = entry(mid);
      e[field] += n;
      const sp = e.span[field];
      e.span[field] = sp ? { first: Math.min(sp.first || first, first || sp.first), last: Math.max(sp.last, last) } : { first, last };
      touch(e, last);
    };
    for (const [kind, field] of [["reply", "reply"], ["like", "like"], ["at", "atMe"]]) {
      for (const [mid, v] of Object.entries(w.feeds[kind] || {})) add(mid, field, v);
    }
    for (const v of w.videos) {
      const pv = w.perVideo[v.bvid];
      if (!pv) continue;
      for (const [mid, c] of Object.entries(pv.c)) add(mid, "comments", c);
      for (const [mid, c] of Object.entries(pv.rc || {})) add(mid, "repostComments", c); // work from older builds
      for (const r of pv.r) {
        const e = entry(r.mid);
        e.reposts.push({ bvid: v.bvid, dynId: r.dynId, at: r.at });
        touch(e, r.at);
        for (const [mid, c] of Object.entries(r.c || {})) add(mid, "repostComments", c);
      }
    }
    for (const [mid, p] of Object.entries(w.pm)) { const e = entry(mid); e.pm = { ...p }; touch(e, p.last); }
    delete byMid[String(myMid)];
    return {
      at: now(),
      videos: w.videos.map(({ bvid, aid, title, play, dynId, at }) => ({ bvid, aid, title, play, dynId, at })),
      byMid
    };
  }

  // Every top-level comment and every sub-comment of one comment area, counted by author into acc.
  async function scanComments(api, type, oid, acc, people) {
    for (let pn = 1; pn <= 500; pn++) {
      const r = await api.replies(type, oid, pn);
      if (!r.list.length) break;
      for (const x of r.list) {
        bump(acc, x.mid, x.at);
        people.add(x.mid, { mid: x.mid, name: x.name, face: x.face, sign: "", ov: "" });
        if (!x.rcount) continue;
        for (let sp = 1; sp <= 100; sp++) {
          const s = await api.subReplies(type, oid, x.rpid, sp);
          for (const y of s.list) {
            bump(acc, y.mid, y.at);
            people.add(y.mid, { mid: y.mid, name: y.name, face: y.face, sign: "", ov: "" });
          }
          if (s.list.length < 20) break;
        }
      }
    }
  }

  // One video: { n, f, c, r: [{ mid, dynId, at, n, c }] }; n/f = comment/repost counts it was scanned at, c = per-person
  // comment counts. old = the same video from the last finished scan, reused where its counts did not change.
  async function scanVideo(api, v, old, people) {
    const pv = { n: v.comments, f: v.forwards, c: {}, r: [] };
    if (old && old.n === v.comments) pv.c = old.c;
    else await scanComments(api, v.commentType || 1, v.commentOid || v.aid, pv.c, people);
    if (!v.forwards) return pv;
    // Reposts and the comments under each repost: B站 notifications miss these.
    const oldR = new Map((old?.r || []).filter((r) => r.c).map((r) => [r.dynId, r]));
    let list = [];
    if (old && old.f === v.forwards && old.r.length && old.r.every((r) => r.c)) list = old.r.map(({ mid, dynId }) => ({ mid, dynId }));
    else {
      let offset = "";
      for (let p = 0; p < 500; p++) {
        const r = await api.forwards(v.dynId, offset);
        for (const f of r.items) { people.add(f.mid, pick(f)); list.push({ mid: f.mid, dynId: f.dynId }); }
        if (!r.hasMore || !r.offset) break;
        offset = r.offset;
      }
    }
    for (const f of list) {
      const d = await api.dynDetail(f.dynId);
      const o = oldR.get(f.dynId);
      const rec = { mid: f.mid, dynId: f.dynId, at: d.at, n: d.comments || 0, c: {} };
      if (o && o.n === rec.n) rec.c = o.c;
      else if (d.comments && d.commentOid) await scanComments(api, d.commentType, d.commentOid, rec.c, people);
      pv.r.push(rec);
    }
    return pv;
  }

  async function interactions(ctx) {
    const { api } = ctx;
    const me = await Store.get("bs_me");
    if (!me?.mid) throw fail(LOGIN_FIRST);
    let w = ctx.cursor && (await Store.get(WORK));
    if (!w) {
      const last = ctx.opts.full ? null : await Store.get(WORK, null);
      w = {
        ...freshWork(),
        prev: last?.phase === "done" ? { perVideo: last.perVideo || {}, feedItems: last.feedItems || {}, sess: last.sess || {}, pm: last.pm || {} } : null,
        // A re-run keeps showing the last complete result until the new one is complete.
        keepOld: ctx.rerun && !!(await Store.get("bs_interactions", null))
      };
    }
    const prev = w.prev;
    const note = prev ? "（没变的跳过）" : "";
    const people = buffer("bs_people", true);
    const save = async () => {
      await people.flush();
      await Store.set(WORK, w);
      if (!w.keepOld || w.phase === "done") await Store.set("bs_interactions", aggregate(w, me.mid));
      await ctx.progress({ cursor: { phase: w.phase } });
    };

    if (w.phase === "videos") {
      let offset = "";
      for (let p = 0; p < 500; p++) {
        await ctx.progress({ step: `第 1/5 步 · 找我的投稿（已找到 ${w.videos.length} 个）`, done: 0, total: 0 });
        const r = await api.spaceDynamics(me.mid, offset);
        for (const it of r.items) if (it.bvid) w.videos.push(it);
        if (!r.hasMore || !r.offset) break;
        offset = r.offset;
      }
      w.phase = "scan";
      await save();
    }

    if (w.phase === "scan") {
      while (w.vi < w.videos.length) {
        await ctx.progress({ step: `第 2/5 步 · 扫我视频的评论和转发${note}`, done: w.vi, total: w.videos.length });
        const v = w.videos[w.vi];
        w.perVideo[v.bvid] = await scanVideo(api, v, prev?.perVideo[v.bvid], people);
        w.vi++;
        await save();
      }
      w.phase = "feeds";
    }

    if (w.phase === "feeds") {
      for (const [kind, label] of [["reply", "回复我的"], ["like", "收到的赞"], ["at", "@我的"]]) {
        if (w.feeds[kind]) continue;
        const old = prev?.feedItems[kind];
        const items = { ...old }; // id -> [at, [mid]]
        let cursor = null;
        for (let page = 1, stop = false; page <= 2000 && !stop; page++) {
          await ctx.progress({ step: `第 3/5 步 · 拉「${label}」通知（第 ${page} 页）`, done: 0, total: 0 });
          const r = await api.msgfeed(kind, cursor);
          for (const it of r.items) {
            const mids = it.users.map((u) => u.mid);
            const key = it.id || `${it.at}:${mids.join(",")}`;
            if (old?.[key]?.[0] === it.at) { stop = true; break; }
            items[key] = [it.at, mids];
            for (const u of it.users) people.add(u.mid, pick(u));
          }
          if (!r.cursor) break;
          cursor = r.cursor;
        }
        const acc = {};
        for (const [at, mids] of Object.values(items)) for (const mid of mids) bump(acc, mid, at);
        w.feedItems[kind] = items;
        w.feeds[kind] = acc;
        await save();
      }
      w.phase = "sessions";
    }

    if (w.phase === "sessions") {
      const sess = {};
      let endTs;
      for (let page = 1; page <= 1000; page++) {
        await ctx.progress({ step: `第 4/5 步 · 拉私信会话列表（${Object.keys(sess).length} 个）`, done: 0, total: 0 });
        const r = await api.sessions(endTs);
        // B站 service accounts (创作助手 and the like) are notifications, not people: never counted as 私信.
        for (const s of r.list) if (!s.system && !(s.talker in sess)) sess[s.talker] = s.ts;
        if (!r.hasMore || !r.list.length) break;
        endTs = r.list[r.list.length - 1].ts;
      }
      w.sess = sess;
      w.talkers = Object.keys(sess);
      const known = await Store.get("bs_people", {});
      const missing = w.talkers.filter((t) => !known[t]);
      for (let i = 0; i < missing.length; i += 50) {
        for (const c of await api.userCards(missing.slice(i, i + 50))) people.add(c.mid, c);
      }
      w.phase = "pm";
      await save();
    }

    if (w.phase === "pm") {
      // Only counts and times; message text is never read into storage.
      while (w.ti < w.talkers.length) {
        const t = w.talkers[w.ti];
        if (prev && prev.sess[t] === w.sess[t]) {
          if (prev.pm[t]) w.pm[t] = prev.pm[t];
          w.ti++;
          continue;
        }
        await ctx.progress({ step: `第 5/5 步 · 数每个私信对话的条数${note}`, done: w.ti, total: w.talkers.length });
        let count = 0, first = 0, last = 0, endSeq;
        for (let page = 0; page < 1000; page++) {
          const r = await api.sessionMsgs(t, endSeq);
          let fresh = 0;
          for (const m of r.list) {
            if (endSeq && m.seq >= endSeq) continue;
            fresh++;
            count++;
            last = Math.max(last, m.at);
            first = first ? Math.min(first, m.at) : m.at;
          }
          if (!r.hasMore || !fresh) break;
          endSeq = r.minSeq || r.list[r.list.length - 1].seq;
        }
        if (count) w.pm[t] = { count, first, last };
        w.ti++;
        if (w.ti % 10 === 0) await save();
      }
      w.phase = "done";
      w.prev = null;
    }
    await save();
  }

  // ---------------------------------------------------------------- runner
  const JOBS = { mine, circle, content, interactions };

  let pinger = null;
  function keepAlive() {
    if (running.size && !pinger) {
      pinger = setInterval(() => chrome.runtime?.getPlatformInfo?.(), 20000);
      chrome.alarms?.create("bs-keepalive", { periodInMinutes: 1 });
    } else if (!running.size && pinger) {
      clearInterval(pinger);
      pinger = null;
      chrome.alarms?.clear("bs-keepalive");
    }
  }

  // When B站 pauses the shared queue, every running job says so (the shell shows 「被限流，N 秒后重试」 until hold.until).
  const holdAll = (hold) => { for (const name of running.keys()) Store.patchIn("bs_jobs", name, { hold }).catch(() => {}); };

  // Start or resume a job; resolves once it is marked running (the job itself continues in the background).
  // All jobs share one ~1 req/s queue and 投稿内容 drives 更新状态, so 关注的关注 waits for it: started while 投稿内容
  // runs, it is queued (bs_jobs.circle.after = "content"); started first, it is paused and queued when 投稿内容 starts.
  // The queue mark is stored, so it survives the worker being killed; 投稿内容 starts it when it finishes or is stopped.
  // 关注的关注 opts: full = re-fetch everyone; newOnly = only accounts not stored yet; neither = update after a finish.
  async function start(name, opts = null) {
    if (!JOBS[name]) throw fail(`没有这个任务：${name}`);
    if (running.has(name)) return;
    if (name === "circle" && running.has("content")) {
      await Store.patchIn("bs_jobs", name, { after: "content", running: false, error: null, throttled: false });
      return;
    }
    const state = { stop: false };
    const halt = new Promise((_, reject) => (state.abort = () => reject(fail("已停止", "STOPPED"))));
    halt.catch(() => {});
    running.set(name, state); // before any await: two starts at once (resumeAll + a click) must not run the job twice
    keepAlive();
    if (globalThis.Bili) globalThis.Bili.onHold = holdAll;
    if (name === "content" && running.has("circle")) {
      const circle = running.get("circle");
      await stop("circle");
      await circle.promise;
      await Store.patchIn("bs_jobs", "circle", { after: "content" });
    }
    const prev = (await Store.get("bs_jobs", {}))[name] || {};
    const cursor = prev.cursor && !prev.finishedAt ? prev.cursor : null;
    // A resumed run keeps its options (a killed full re-crawl stays full); a new run takes the ones passed now.
    const runOpts = cursor || (prev.running && !opts) ? prev.opts || null : opts;
    await Store.patchIn("bs_jobs", name, {
      running: true, beat: now(), finishedAt: null, error: null, throttled: false, hold: null, after: null, opts: runOpts,
      ...(cursor ? {} : { startedAt: now(), done: 0, total: 0, step: "", cursor: null })
    });
    // A stop lands right away, even mid back-off: the request in flight is dropped.
    // Every answered request and every progress write is a heartbeat (bs_jobs.beat, at most every 20 s) for the watchdog.
    let beatAt = now();
    const beat = () => {
      if (now() - beatAt < 20) return {};
      beatAt = now();
      return { beat: beatAt };
    };
    const api = new Proxy({}, {
      get: (_, key) => async (...args) => {
        if (state.stop) throw fail("已停止", "STOPPED");
        const call = globalThis.Bili[key](...args);
        call.catch(() => {});
        const r = await Promise.race([call, halt]);
        const b = beat();
        if (b.beat) Store.patchIn("bs_jobs", name, b).catch(() => {});
        return r;
      }
    });
    const ctx = { api, cursor, opts: runOpts || {}, startedAt: (await Store.get("bs_jobs", {}))[name]?.startedAt || now(), rerun: !!prev.finishedAt, progress: (fields) => Store.patchIn("bs_jobs", name, { ...fields, ...beat() }) };
    let ended = "error";
    state.promise = JOBS[name](ctx)
      .then(
        () => { ended = "done"; return Store.patchIn("bs_jobs", name, { running: false, finishedAt: now(), lastFinishedAt: now(), step: "", cursor: null, hold: null }); },
        (e) => {
          if (state.restart) { ended = "restart"; return; } // the watchdog starts it again from its cursor
          if (e.code === "STOPPED") ended = "stopped";
          return Store.patchIn("bs_jobs", name, e.code === "STOPPED" ? { running: false, hold: null } : { running: false, hold: null, error: e.message, throttled: e.code === "THROTTLED" });
        }
      )
      .finally(async () => {
        running.delete(name);
        keepAlive();
        const jobs = await Store.get("bs_jobs", {});
        // Use case: the user comes back days later and refreshes 我的关注和粉丝. 投稿内容 then re-reads the video feed
        // (who posted lately) and fetches only new follows, so 活跃/慢更/断更 are current again in a few minutes.
        if (ended === "done" && name === "mine") start("content").catch(() => {});
        // New follows also need their 关注的关注 once the map exists; only the missing ones are fetched.
        if (name === "content" && ended === "done" && jobs.circle?.lastFinishedAt && !jobs.circle?.after && !running.has("circle") && (await missingCircle())) start("circle", { newOnly: true }).catch(() => {});
        // After an error (限流, 网络) 关注的关注 stays queued: it would hit the same wall.
        if (name === "content" && (ended === "done" || ended === "stopped") && jobs.circle?.after === "content") start("circle").catch(() => {});
        // 关注的关注 finds the second-layer accounts 投稿内容 also covers; fetch the ones it has not seen yet.
        if (name === "circle" && ended === "done" && !running.has("content") && (await missingContent())) start("content").catch(() => {});
      });
  }

  async function missingCircle() {
    const followings = (await Store.get("bs_followings"))?.list || [];
    const have = await Store.get("bs_circle", {});
    return followings.some((m) => !have[m]);
  }

  async function missingContent() {
    const followings = (await Store.get("bs_followings"))?.list;
    if (!followings?.length) return false;
    const have = await Store.get("bs_content", {});
    return contentTargets(followings, await Store.get("bs_circle", {}), (await Store.get("bs_me"))?.mid).some((m) => !have[m] || (have[m].code && !GONE_CODES.has(have[m].code)));
  }

  // Watchdog: a job marked running with no heartbeat for 3 minutes and no pause of the queue is stuck (a request that
  // never settled, a lost promise). Its in-memory run is dropped and it starts again from its cursor. One restart at a
  // time per job; the fresh run writes a new beat first, so the next check leaves it alone.
  const STALE = 180;
  const restarting = new Set();
  async function revive(name, j) {
    // A pause of the queue (plus a minute for the first request after it) is not a hang.
    if (restarting.has(name) || (j.hold?.until || 0) + 60 > now() || now() - (j.beat || 0) <= STALE) return;
    restarting.add(name);
    try {
      const st = running.get(name);
      if (st) {
        st.stop = st.restart = true;
        st.abort();
        await st.promise;
      }
      await start(name);
    } finally {
      restarting.delete(name);
    }
  }

  async function stop(name) {
    const state = running.get(name);
    if (state) { state.stop = true; state.abort(); }
    else await Store.patchIn("bs_jobs", name, { running: false, after: null, hold: null }); // queued, or a stale flag from a killed worker
  }

  // Restart every job still marked running (the worker was killed mid-job).
  async function resumeAll() {
    const jobs = await Store.get("bs_jobs", {});
    // lastFinishedAt is never cleared by a restart (pages use it for "finished once"); older records only have finishedAt.
    for (const [name, j] of Object.entries(jobs)) if (j.finishedAt && !j.lastFinishedAt) await Store.patchIn("bs_jobs", name, { lastFinishedAt: j.finishedAt });
    // 0.1.0 paused 关注的关注 for 投稿内容 and kept the resume in memory only, so a reload lost it. Its records have no
    // `after` key at all (this build always writes one): queue that paused circle behind the running content.
    const c = jobs.circle;
    if (jobs.content?.running && c && !("after" in c) && !c.running && !c.finishedAt && !c.error && c.done) {
      await Store.patchIn("bs_jobs", "circle", { after: "content" });
    }
    for (const [name, j] of Object.entries(jobs)) {
      if (!j.running || !JOBS[name] || restarting.has(name)) continue;
      if (!running.has(name)) await start(name);
      else await revive(name, j);
    }
  }

  globalThis.Jobs = { start, stop, resumeAll, wait: (name) => running.get(name)?.promise, aggregate, contentTargets, fansDiff, followDiff, mergePerson };
})();
