// #me 我的位置: who helped me (reposts/comments × their reach) and who I interact with most, plus an ego graph.
// Scoring lives in lib/me.js (globalThis.Me). Follower counts come from bs_stats, filled lazily via `bs-stat`.
(() => {
  const KEYS = ["bs_me", "bs_people", "bs_fans", "bs_interactions", "bs_stats", "bs_jobs"];
  const FILTERS = [["all", "全部"], ["pm", "有私信"], ["light", "只有评论点赞"], ["mutual", "互关"]];
  const GRAPH_N = 40;
  const { esc, fmtCount, fmtAgo, avatar, errText, nameHtml, nameText } = BS;

  let root = null;
  let d = {};
  let filter = "all";
  let interShown = 30; // 常互动 rows shown; scrolling to the bottom of its card adds the next batch
  const HELP_BATCH = 30;
  let helperShown = HELP_BATCH; // 助力 rows shown; scrolling to the bottom of the card adds the next batch
  let helperKind = "repost"; // repost | comment | like
  let likeAll = false; // 点赞: fetch follower counts for everyone, not only the top LIKE_AUTO
  const LIKE_AUTO = 200;

  const day = (sec) => (sec ? new Date(sec * 1000).toLocaleDateString("sv-SE") : ""); // 2025-08-19
  const space = (mid) => `https://space.bilibili.com/${mid}`;
  const person = (mid) => d.bs_people?.[mid] || { mid, face: "" };

  // Live status of a job that has not finished: what it is doing, or why it stopped. "" once finished.
  function jobText(j) {
    if (!j || j.finishedAt) return "";
    const prog = j.total ? ` ${j.done}/${j.total}` : "";
    if (j.running) return `还在同步：${j.step || "准备中"}${prog}`;
    if (j.throttled) return "被 B站 限流，已暂停，过一阵再继续";
    if (j.error) return `出错停下了：${errText(j.error)}`;
    return `同步停在：${j.step || "开头"}${prog}`;
  }

  // Status line plus a start/continue button when the job is not running.
  function jobAction(job, label) {
    const j = d.bs_jobs?.[job];
    const text = jobText(j);
    return `${text ? `<p class="me-status">${esc(text)}</p>` : ""}${j?.running ? "" :
      `<button type="button" class="primary" data-job="${job}">${esc(!j?.finishedAt && (j?.cursor || j?.done) ? "继续同步" : label)}</button>`}`;
  }

  function header(me, inter) {
    const mutual = (d.bs_fans?.list || []).filter((f) => f.mutual).length;
    return `<section class="me-head">
      ${avatar(me.face, 64)}
      <div class="me-who">
        <h1>${esc(me.name)}</h1>
        <div class="me-counts">
          <span><b>${fmtCount(me.follower)}</b> 粉丝</span>
          <span><b>${fmtCount(me.following)}</b> 关注</span>
          <span><b>${fmtCount(mutual)}</b> 互关</span>
        </div>
      </div>
      <div class="me-sync muted">${!inter?.at ? "" : jobText(d.bs_jobs?.interactions) ? jobAction("interactions", "同步互动记录")
        : `互动记录同步于 ${fmtAgo(d.bs_jobs?.interactions?.finishedAt || inter.at)}`}</div>
    </section>`;
  }

  function helperRow(h, videos) {
    const p = person(h.mid);
    const did = h.e.reposts.map((r) => {
      const v = videos[r.bvid];
      return `<a href="https://t.bilibili.com/${esc(r.dynId)}" target="_blank" rel="noreferrer">转发《${esc(v?.title || r.bvid)}》</a> ${day(r.at)}`;
    });
    if (helperKind === "like") did.length = 0;
    if (helperKind === "like" && h.e.like) did.push(`点赞 ${h.e.like} 次（视频和评论）`);
    else if (h.e.comments) did.push(`在我视频下评论 ${h.e.comments} 条`);
    // repostComments is per person, not per repost; for a reposter it is almost always under their own repost.
    if (helperKind !== "like" && h.e.repostComments) did.push(`${h.e.reposts.length ? "在自己的转发下回复" : "在转发动态下评论"} ${h.e.repostComments} 条`);
    return `<li class="me-row">
      <a href="${space(h.mid)}" target="_blank" rel="noreferrer">${avatar(p.face, 40)}</a>
      <div class="me-main">
        <div class="me-name"><a href="${space(h.mid)}" target="_blank" rel="noreferrer">${nameHtml(p, h.mid)}</a>
          <span class="me-tag">${h.follower != null ? `粉丝 ${fmtCount(h.follower)}` : missing.has(h.mid) ? "查不到粉丝数" : "粉丝数未查"}</span></div>
        <div class="me-did">${did.join("<br>")}</div>
      </div>
    </li>`;
  }

  const HELP_TABS = [["repost", "转发"], ["comment", "评论"], ["like", "点赞"]];
  function helpers(inter) {
    const all = Me.rankHelpers(inter, d.bs_stats, helperKind);
    const list = all.slice(0, helperShown);
    const videos = Object.fromEntries((inter.videos || []).map((v) => [v.bvid, v]));
    const gaps = gapsNow();
    const gap = helperKind === "like" ? gaps.like : gaps.help;
    const tabs = HELP_TABS.map(([k, label]) =>
      `<button type="button" data-help="${k}" aria-pressed="${helperKind === k}">${label} ${Me.rankHelpers(inter, {}, k).length}</button>`).join("");
    const body = list.length
      ? `<ol class="me-list">${list.map((h) => helperRow(h, videos)).join("")}</ol>
         <p class="me-foot muted">${all.length > list.length ? `已显示 ${list.length} / ${all.length} 人，往下滚加载更多` : `共 ${all.length} 人`}</p>`
      : `<p class="empty">${gap ? "还没扫到" : "还没人"}${HELP_TABS.find(([k]) => k === helperKind)[1]}过你</p>`;
    return `<section class="me-card me-pair">
      <h2>助力过我的人</h2>
      <div class="me-filters" role="group" aria-label="助力方式">${tabs}</div>
      <p class="me-hint muted">按粉丝数从高到低排，没查到粉丝数的排在后面。投币和收藏 B站 只给数量、不给是谁，所以没有。</p>
      ${gap ? `<p class="me-status">${helperKind === "like" ? "「收到的赞」通知还没拉完" : "你视频的评论和转发还没扫完"}，人数还会变。</p>` : ""}
      ${statLine(inter)}
      <div class="me-scroll" data-scroll="helpers">${body}</div>
    </section>`;
  }

  function breakdown(e) {
    const parts = [
      [e.pm?.count, "私信"], [e.comments, "评论"], [e.repostComments, "转发下评论"], [e.reply, "回复"], [e.like, "赞"], [e.atMe, "@"], [e.reposts?.length, "转发"]
    ].filter(([n]) => n);
    return parts.map(([n, label]) => `<span class="me-chip">${label} ${n}</span>`).join("");
  }

  function interactions(inter, mutual) {
    const now = Date.now() / 1000;
    const keep = {
      all: () => true,
      pm: (e) => e.pm?.count > 0,
      light: (e) => !e.pm?.count && !e.reposts?.length && !e.atMe,
      mutual: (_e, mid) => mutual.has(mid)
    }[filter];
    const all = Me.rankInteractions(inter, now).filter((x) => keep(x.e, x.mid));
    const list = all.slice(0, interShown);
    const rows = list.map((x) => {
      const p = person(x.mid);
      const first = Me.firstContact(x.e);
      return `<li class="me-row">
        <a href="${space(x.mid)}" target="_blank" rel="noreferrer">${avatar(p.face, 40)}</a>
        <div class="me-main">
          <div class="me-name"><a href="${space(x.mid)}" target="_blank" rel="noreferrer">${nameHtml(p, x.mid)}</a>
            ${mutual.has(x.mid) ? '<span class="me-tag">互关</span>' : ""}</div>
          <div class="me-chips">${breakdown(x.e)}</div>
        </div>
        <div class="me-dates muted">${first ? `最早 ${day(first)}<br>` : ""}${x.e.last ? `最近 ${day(x.e.last)}` : ""}</div>
      </li>`;
    });
    return `<section class="me-card me-fixed">
      <div class="me-card-head">
        <h2>常互动的人</h2>
        <div class="me-filters" role="group" aria-label="筛选">${FILTERS.map(([id, label]) =>
          `<button type="button" data-filter="${id}" aria-pressed="${filter === id}">${label}</button>`).join("")}</div>
      </div>
      <p class="me-hint muted">按互动分排：转发 ×5、@ ×3、评论和回复 ×2、私信 ×1、赞 ×0.5，越久没联系分越低。</p>
      ${partialNote()}
      <div class="me-scroll" data-scroll="inter">
        ${rows.length ? `<ol class="me-list">${rows.join("")}</ol>` : `<p class="empty">${gapsNow().pm ? "还没找到符合的人" : "没有符合的人"}</p>`}
        ${rows.length ? `<p class="me-foot muted">${all.length > list.length ? `已显示 ${list.length} / ${all.length} 人，往下滚加载更多` : `共 ${all.length} 人`}</p>` : ""}
      </div>
    </section>`;
  }

  const gapsNow = () => Me.syncGaps(d.bs_jobs?.interactions, d.bs_interactions?.at);

  // Shown under 常互动 and the ego graph while the interactions job has not finished.
  function partialNote() {
    const j = d.bs_jobs?.interactions;
    return gapsNow().pm ? `<p class="me-status">互动记录还没同步完（${esc(jobText(j).replace(/^还在同步：|^同步停在：/, ""))}），排名还会变。</p>` : "";
  }

  // Ego graph: me in the middle, stronger ties closer; lines in SVG, avatars as HTML so no-referrer works.
  function graph(me, inter) {
    // Everyone who reposted me is always drawn; the rest of the places go by interaction score.
    const ranked = Me.rankInteractions(inter, Date.now() / 1000);
    const reposters = ranked.filter((x) => x.e.reposts?.length);
    const top = [...reposters, ...ranked.filter((x) => !x.e.reposts?.length)].slice(0, Math.max(GRAPH_N, reposters.length))
      .sort((a, b) => b.score - a.score); // closer to the middle = stronger tie
    if (!top.length) return "";
    const max = top[0].score;
    const nodes = top.map((x, i) => {
      const a = i * 2.39996; // golden angle
      const r = 18 + 28 * Math.sqrt((i + 1) / top.length);
      const follower = d.bs_stats?.[x.mid]?.follower;
      const size = Math.round(Math.min(44, 22 + (follower ? 3.5 * Math.log10(follower + 1) : 0)));
      const kind = x.e.reposts?.length ? "help" : x.e.pm?.count ? "pm" : "plain";
      return { ...x, x: 50 + r * Math.cos(a), y: 50 + r * Math.sin(a), w: 0.15 + 1.2 * Math.sqrt(x.score / max), size, kind, follower };
    });
    const lines = nodes.map((n) => `<line x1="50" y1="50" x2="${n.x.toFixed(2)}" y2="${n.y.toFixed(2)}" class="${n.kind}" stroke-width="${n.w.toFixed(2)}"/>`).join("");
    const dots = nodes.map((n) => {
      const p = person(n.mid);
      const tip = `${nameText(p, n.mid)}${n.follower != null ? ` · 粉丝 ${fmtCount(n.follower)}` : ""}`;
      return `<a class="ego-node ${n.kind}" href="${space(n.mid)}" target="_blank" rel="noreferrer" title="${esc(tip)}"
        style="left:${n.x.toFixed(2)}%;top:${n.y.toFixed(2)}%">${avatar(p.face, n.size)}</a>`;
    }).join("");
    return `<section class="me-card me-pair">
      <h2>我在圈子里的位置</h2>
      <p class="me-hint muted">画了 ${top.length} 人：转发过你的 ${reposters.length} 人全画，其余按互动分取前几名。越靠中间、线越粗，互动越多；头像越大粉丝越多（粉丝数未查的画最小）。</p>
      ${partialNote()}
      <div class="ego-legend muted"><span class="help">转发过我（粉色实线）</span><span class="pm">有私信（虚线）</span><span class="plain">其他互动（浅灰）</span></div>
      <div class="ego">
        <svg viewBox="0 0 100 100" aria-hidden="true">${lines}</svg>
        ${dots}
        <span class="ego-node ego-me" style="left:50%;top:50%" title="${esc(me.name)}">${avatar(me.face, 56)}</span>
      </div>
    </section>`;
  }

  // Follower counts: bs-stat answers ≤50 per call at ~1 req/s on the queue the jobs share. One batch in flight at a time,
  // always for the tab on screen; a tab switch mid-batch just makes the next batch follow the new tab.
  // 点赞 can be thousands of people (an hour or more), so only the LIKE_AUTO most frequent likers are fetched unless asked.
  const tried = new Set(); // asked this page load
  const missing = new Set(); // asked, no answer (account gone or hidden)
  let statBusy = false;
  let statErr = "";
  const fresh = (m) => d.bs_stats?.[m]?.at > Date.now() / 1000 - 7 * 86400;

  function statTargets(inter, kind = helperKind) {
    const all = Me.statCandidates(inter, d.bs_people, Infinity, kind);
    return kind === "like" && !likeAll ? { all, list: all.slice(0, LIKE_AUTO) } : { all, list: all };
  }

  const runningJobs = () => Object.values(d.bs_jobs || {}).filter((j) => j.running).length;
  function minutes(n) {
    const m = Math.ceil((n * (1 + runningJobs())) / 60); // ponytail: assumes the shared queue splits evenly between running jobs
    return m <= 1 ? "不到 1 分钟" : `约 ${m} 分钟`;
  }

  function statLine(inter) {
    const { all, list } = statTargets(inter);
    const left = list.filter((m) => !fresh(m) && !missing.has(m)).length;
    const parts = [];
    if (statErr) parts.push(`粉丝数没查全：${esc(errText(statErr))} <button type="button" data-stat-retry>重试</button>`);
    else if (left) parts.push(`正在查粉丝数：${list.length - left}/${list.length}，还要${minutes(left)}`);
    if (list.length < all.length) {
      parts.push(`点赞的人多，先查了认证账号和点赞次数最多的 ${list.length} 人。<button type="button" data-like-all>查全部 ${all.length} 人（${minutes(all.length - list.length)}）</button>`);
    }
    if (parts.length && runningJobs()) parts.push("查粉丝数和正在跑的同步共用每秒约 1 次的请求，所以慢。");
    return parts.length ? `<p class="me-status">${parts.join("<br>")}</p>` : "";
  }

  function askStats(inter) {
    if (statBusy || statErr) return;
    const todo = statTargets(inter).list.filter((m) => !fresh(m) && !tried.has(m));
    if (!todo.length) return;
    const mids = todo.slice(0, 50);
    mids.forEach((m) => tried.add(m));
    statBusy = true;
    BS.send("bs-stat", { mids })
      .then((got) => mids.forEach((m) => { if (!(m in (got || {}))) missing.add(m); }))
      .catch((e) => {
        statErr = e; // errText reads its code
        mids.forEach((m) => tried.delete(m)); // asked again on 重试
      })
      .finally(() => {
        statBusy = false;
        if (root) render();
      });
  }

  function render() {
    const me = d.bs_me;
    const inter = d.bs_interactions;
    if (!me?.mid) {
      root.innerHTML = `<div class="me-empty"><p>还没有你的账号信息。要先同步「我的关注和粉丝」。</p>${jobAction("mine", "同步我的关注和粉丝")}</div>`;
      return;
    }
    if (!inter?.byMid) {
      root.innerHTML = `${header(me, inter)}<div class="me-empty">
        <p>还没有互动记录。同步「互动记录」会扫你视频的评论和转发、通知，还会数私信条数（不存内容）。</p>
        ${jobAction("interactions", "同步互动记录")}</div>`;
      return;
    }
    const mutual = new Set((d.bs_fans?.list || []).filter((f) => f.mutual).map((f) => String(f.mid)));
    // re-renders (stats batches, sync, next batch) keep each list's scroll place
    const keep = Object.fromEntries([...root.querySelectorAll("[data-scroll]")].map((x) => [x.dataset.scroll, x.scrollTop]));
    root.innerHTML = `${header(me, inter)}
      <div class="me-grid">${helpers(inter)}${graph(me, inter)}</div>
      ${interactions(inter, mutual)}`;
    for (const x of root.querySelectorAll("[data-scroll]")) x.scrollTop = keep[x.dataset.scroll] || 0;
    askStats(inter);
  }

  async function onClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.filter) {
      filter = b.dataset.filter; interShown = 30;
      render();
      const box = root.querySelector('[data-scroll="inter"]');
      if (box) box.scrollTop = 0;
    }
    else if (b.dataset.help) {
      helperKind = b.dataset.help; helperShown = HELP_BATCH;
      render();
      const box = root.querySelector('[data-scroll="helpers"]');
      if (box) box.scrollTop = 0;
    }
    else if (b.hasAttribute("data-like-all")) { likeAll = true; render(); }
    else if (b.hasAttribute("data-stat-retry")) { statErr = ""; render(); }
    else if (b.dataset.job) {
      b.disabled = true;
      try { await BS.send("bs-job-start", { job: b.dataset.job }); } catch (err) { BS.toast(err, { error: true }); b.disabled = false; }
    }
  }

  BS.page("me", {
    async mount(el) {
      root = document.createElement("div");
      root.className = "me";
      root.addEventListener("click", onClick);
      // scroll doesn't bubble: listen in the capture phase for the 助力 list reaching its bottom
      root.addEventListener("scroll", (e) => {
        const box = e.target;
        if (!(box instanceof Element) || !box.dataset.scroll) return;
        if (box.scrollTop + box.clientHeight < box.scrollHeight - 60) return;
        if (box.dataset.scroll === "helpers") {
          if (helperShown >= Me.rankHelpers(d.bs_interactions, d.bs_stats, helperKind).length) return;
          helperShown += HELP_BATCH;
        } else {
          if (!/往下滚/.test(box.querySelector(".me-foot")?.textContent || "")) return;
          interShown += 30;
        }
        render();
      }, true);
      el.append(root);
      BS.onStore(KEYS, (changes) => {
        for (const k of KEYS) if (k in changes) d[k] = changes[k].newValue;
        if (root) render();
      });
      d = await BS.get(KEYS);
      if (root) render();
    },
    unmount() {
      root = null;
    }
  });
})();
