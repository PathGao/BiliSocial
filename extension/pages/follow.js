// #follow: UP 主管理 (关注分拣台). Left: tags with counts; main: UP cards with 更新状态 filter, search, sort,
// multi-select batch actions (tag, 取消关注), 已取消关注 view with 重新关注, and AI batch tagging with a reviewable proposal.
// Tags live in bs_up_tags / bs_up_tag_map; this page writes them directly. B站 writes go through bs-follow.

// 更新状态 of one UP: active | slow | dead | none (没投过稿) | stale (slowDays 以上没更, 慢更还是断更待查) | unchecked (未查).
// The newest known post wins, from bs_content[mid] (latest 30 videos, fetched once) or bs_last_post (the video feed,
// re-read on every refresh) — so an UP who posted after their videos were fetched still turns 活跃.
// Not seen in a feed that reaches back past slowDays and no videos fetched → stale.
function followStatus(c, now, slowDays = 90, deadDays = 365, lp = null, mid = "") {
  const byAge = (last) => {
    const days = (now - last) / 86400;
    return days >= deadDays ? "dead" : days >= slowDays ? "slow" : "active";
  };
  const fetched = c && c.code === 0;
  const last = Math.max(fetched ? Math.max(0, ...(c.v || []).map((v) => v.c || 0)) : 0, lp?.map?.[mid] || 0);
  if (last) return byAge(last);
  if (fetched) return "none";
  if (lp && lp.since <= now - slowDays * 86400) return "stale";
  return "unchecked";
}

if (typeof module === "object") module.exports = { followStatus };
else (() => {
  const { esc, toast, fmtAgo, avatar, errText, nameOf, nameHtml } = BS;
  const KEYS = ["bs_people", "bs_followings", "bs_content", "bs_last_post", "bs_jobs", "bs_up_tags", "bs_up_tag_map", "bs_unfollowed", "bs_settings"];
  const STATUS = [["", "全部"], ["active", "活跃"], ["slow", "慢更"], ["dead", "断更"], ["stale", "慢更或断更 · 待查"], ["none", "没投过稿"], ["unchecked", "未查"]];
  const STATUS_TEXT = Object.fromEntries(STATUS);
  // New-tag colors stay clear of the meaning colors (pink 你在哪, blue 下一步, red 删除/出错, amber 等待, green 保留).
  const COLORS = ["#8e6cd8", "#2e9e9e", "#9a7b4f", "#5c6bc0", "#7a8a2e", "#a0569a", "#6b7a8f", "#86708a"];
  const space = (mid) => `https://space.bilibili.com/${mid}`;

  let root = null;
  let D = {}; // storage snapshot
  let ups = new Map(); // mid -> derived card data
  let shown = []; // mids in the list right now
  let hintArgs = null; // renderHint's last [counts, base], for bs_jobs-only redraws
  const S = { side: "all", status: "", q: "", sort: "last", sel: new Set(), busy: false };

  // ---------- data ----------
  async function load() {
    D = await BS.get(KEYS);
    D.tags = D.bs_up_tags || [];
    D.map = D.bs_up_tag_map || {};
    D.gone = D.bs_unfollowed || {};
    const people = D.bs_people || {};
    const content = D.bs_content || {};
    const set = D.bs_settings || {};
    const now = Date.now() / 1000;
    ups = new Map();
    for (const mid of [...(D.bs_followings?.list || []), ...Object.keys(D.gone)]) {
      if (ups.has(mid)) continue;
      const p = people[mid] || {};
      const c = content[mid];
      const nm = nameOf(p, mid);
      ups.set(mid, {
        mid,
        name: nm.missing ? `未获取名字（${mid}）` : nm.name, // plain text: search, sort, confirm lists
        nameHtml: nameHtml(p, mid),
        face: p.face,
        sign: p.sign || "",
        ov: p.ov || "",
        status: followStatus(c, now, set.slowDays || 90, set.deadDays || 365, D.bs_last_post, mid),
        last: Math.max(0, ...(c?.v || []).map((v) => v.c || 0), D.bs_last_post?.map?.[mid] || 0),
        count: c?.count || 0,
        zone: Object.entries(c?.tlist || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
        titles: (c?.v || []).slice(0, 3),
        followed: D.bs_followings?.followTime?.[mid] || 0,
        special: !!D.bs_followings?.special?.[mid]
      });
    }
    if (!["all", "untagged", "special", "gone"].includes(S.side) && !D.tags.some((t) => t.id === S.side)) S.side = "all";
  }

  const following = () => D.bs_followings?.list || [];
  const tagsOf = (mid) => (D.map[mid] || []).map((id) => D.tags.find((t) => t.id === id)).filter(Boolean);
  const write = (obj) => chrome.storage.local.set(obj);

  // Side-filtered mids (before 更新状态 / search).
  function sideMids() {
    if (S.side === "gone") return Object.keys(D.gone).sort((a, b) => D.gone[b].at - D.gone[a].at);
    const list = following();
    if (S.side === "all") return list;
    if (S.side === "untagged") return list.filter((m) => !tagsOf(m).length);
    if (S.side === "special") return list.filter((m) => ups.get(m).special);
    return list.filter((m) => D.map[m]?.includes(S.side));
  }

  // A job's live progress while it runs; otherwise `why`, how it last ended, and a start/continue button.
  function jobNote(id, label, why) {
    const j = D.bs_jobs?.[id] || {};
    if (j.running) return `正在${esc(j.step || `同步${label}`)}${j.total ? ` ${j.done}/${j.total}` : j.done ? `（已找到 ${j.done} 个）` : ""}。`;
    const last = j.throttled ? "上次被 B站 限流暂停了。" : j.error ? `上次出错：${esc(errText(j.error))}。` : "";
    const verb = j.finishedAt ? "再同步一次" : j.done || j.cursor ? "继续同步" : "开始同步";
    return `${why}${last}<button type="button" data-act="start" data-job="${id}">${verb}${label}</button>`;
  }

  // 更新状态 needs the 投稿内容 job; say so where the 未查 count is, with its live status or start button.
  function renderHint(counts, base) {
    const el = root?.querySelector("#fwHint");
    if (!el) return;
    const open = (counts.unchecked || 0) + (counts.stale || 0);
    if (!open || S.side === "gone") { el.hidden = true; return; }
    el.hidden = false;
    const missing = base.filter((m) => !D.bs_content?.[m]).length;
    const stale = counts.stale ? `「待查」= ${D.bs_settings?.slowDays || 90} 天没在视频动态出现，查完投稿才分得清慢更还是断更。` : "";
    el.innerHTML = !missing && !D.bs_jobs?.content?.running
      ? `${open} 个 UP 主查过了，但 B站 没给投稿列表，看不出最后投稿时间。`
      : stale + jobNote("content", "投稿内容", `${open} 个 UP 主还不知道最后投稿时间。还要查 ${missing} 个，约 ${Math.ceil(missing / 60)} 分钟。`) + (D.bs_jobs?.content?.running ? "状态边查边更新。" : "");
  }

  // ---------- render ----------
  function render() {
    if (!root) return;
    renderSide();
    const base = sideMids();
    const counts = {};
    for (const m of base) counts[ups.get(m).status] = (counts[ups.get(m).status] || 0) + 1;
    root.querySelector("#fwSeg").innerHTML = STATUS.filter(([id]) => id !== "stale" || counts.stale).map(([id, label]) => {
      const n = id ? counts[id] || 0 : base.length;
      return `<button type="button" data-status="${id}" aria-pressed="${S.status === id}"${n ? "" : ' class="zero"'}>${label} ${n}</button>`;
    }).join("");
    renderHint(...(hintArgs = [counts, base]));
    renderSuggest();

    const q = S.q.trim().toLowerCase();
    shown = base.filter((m) => (!S.status || ups.get(m).status === S.status) && (!q || ups.get(m).name.toLowerCase().includes(q)));
    if (S.side !== "gone") {
      const cmp = S.sort === "name" ? (a, b) => ups.get(a).name.localeCompare(ups.get(b).name, "zh")
        : S.sort === "follow" ? (a, b) => ups.get(b).followed - ups.get(a).followed
        : (a, b) => ups.get(b).last - ups.get(a).last;
      shown = [...shown].sort(cmp);
    }
    for (const m of [...S.sel]) if (!shown.includes(m)) S.sel.delete(m);

    const list = root.querySelector("#fwList");
    if (!following().length && S.side !== "gone") list.innerHTML = `<p class="empty">${jobNote("mine", "我的关注和粉丝", "还没有关注数据。")}</p>`;
    else if (!shown.length) list.innerHTML = `<p class="empty">${S.side === "gone" && !base.length ? "还没取消关注过谁" : "没有符合条件的 UP 主"}</p>`;
    else list.innerHTML = shown.map(card).join("");
    renderSel();
  }

  function renderSide() {
    const list = following();
    const n = (fn) => list.filter(fn).length;
    const item = (id, label, count, pre = "", post = "") =>
      `<button type="button" class="side-item${S.side === id ? " on" : ""}${count ? "" : " zero"}" data-side="${esc(id)}">${pre}<span class="side-name">${esc(label)}</span>${post}<span class="side-count">${count}</span></button>`;
    const pushOff = !D.bs_settings?.push && D.tags.some((t) => t.push);
    root.querySelector("#fwSide").innerHTML = [
      item("all", "全部", list.length),
      item("untagged", "未打标签", n((m) => !tagsOf(m).length)),
      item("special", "特别关注", n((m) => ups.get(m).special), `<span class="star-mark" aria-hidden="true">★</span>`),
      D.tags.length ? `<div class="side-head">标签 · 只存在扩展里</div>` : "",
      ...D.tags.map((t) => item(t.id, t.name, n((m) => D.map[m]?.includes(t.id)),
        `<i class="dot" style="--c:${esc(t.color)}"></i>`, t.push ? `<span class="push-mark${pushOff ? " off" : ""}" title="这个标签的新视频会推送">推送</span>` : "")),
      pushOff ? `<p class="side-note">推送没开：总开关在<a href="#settings">「设置」</a>里关着</p>` : "",
      `<hr>`,
      item("gone", "已取消关注", Object.keys(D.gone).length)
    ].join("");
  }

  function card(mid) {
    const u = ups.get(mid);
    const gone = D.gone[mid];
    const tags = gone ? (gone.tagIds || []).map((id) => D.tags.find((t) => t.id === id)).filter(Boolean) : tagsOf(mid);
    const meta = [
      u.zone,
      u.last ? `最后投稿 ${fmtAgo(u.last)}` : u.status === "stale" ? `${D.bs_settings?.slowDays || 90} 天以上没投稿` : "",
      u.count ? `${u.count} 个视频` : "",
      u.followed && !gone ? `关注于 ${fmtAgo(u.followed)}` : "",
      gone ? `${gone.source === "bili" ? "在 B站 取关" : "在这里取关"} · ${fmtAgo(gone.at)}` : ""
    ].filter(Boolean).join(" · ");
    return `<article class="card up${S.sel.has(mid) ? " selected" : ""}" data-mid="${esc(mid)}">
      <input type="checkbox" class="up-check" ${S.sel.has(mid) ? "checked" : ""} aria-label="选中 ${esc(u.name)}">
      ${avatar(u.face, 48)}
      <div class="up-body">
        <div class="up-head">
          <a class="up-name" href="${space(mid)}" target="_blank" rel="noopener">${u.nameHtml}</a>
          <span class="st st-${u.status}">${STATUS_TEXT[u.status]}</span>
          ${u.ov ? `<span class="up-ov" title="${esc(u.ov)}">${esc(u.ov.replace(/^bilibili\s*/, ""))}</span>` : ""}
        </div>
        ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
        ${u.sign ? `<div class="up-sign" title="${esc(u.sign)}">${esc(u.sign)}</div>` : ""}
        ${u.titles.length ? `<ul class="up-titles">${u.titles.map((v) => `<li><span class="t">${esc(v.t)}</span><span class="meta">${fmtAgo(v.c)}</span></li>`).join("")}</ul>` : ""}
        ${tags.length ? `<div class="chips">${tags.map((t) => `<span class="chip" style="--c:${esc(t.color)}">${esc(t.name)}</span>`).join("")}</div>` : ""}
      </div>
      ${gone ? `<button type="button" data-refollow="${esc(mid)}">重新关注</button>`
        : `<button type="button" class="star${u.special ? " on" : ""}" data-star="${esc(mid)}" aria-pressed="${u.special}" title="${u.special ? "取消特别关注" : "设为特别关注"}" aria-label="特别关注 ${esc(u.name)}">${u.special ? "★" : "☆"}</button>`}
    </article>`;
  }

  function renderSel() {
    const bar = root.querySelector("#fwSel");
    const n = S.sel.size;
    // 「全选这里的 N 个」 sits in the toolbar whatever is selected, so it is there before the first tick and never moves the list.
    const all = root.querySelector("#fwAll");
    all.textContent = !shown.length ? "这里没有 UP 主" : n === shown.length ? `已全选这里的 ${n} 个` : `全选这里的 ${shown.length} 个`;
    all.disabled = !shown.length || n === shown.length;
    bar.hidden = !n;
    if (!n) return;
    const opts = D.tags.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    bar.innerHTML = `<span class="sel-count">已选 ${n} 个</span>
      <button type="button" class="link" data-sel="none">清空</button>
      <span class="sel-actions">${S.side === "gone"
        ? `<button type="button" data-sel="refollow">重新关注</button>`
        : `<select data-sel="add" aria-label="给选中的加标签"><option value="">加标签…</option>${opts}<option value="__new">新标签…</option></select>
           <select data-sel="remove" aria-label="给选中的去掉标签"><option value="">去标签…</option>${opts}</select>
           <button type="button" data-sel="special-on">设为特别关注</button>
           <button type="button" data-sel="special-off">取消特别关注</button>
           <button type="button" data-sel="ai"><span class="ai-spark"></span>AI 打标签</button>
           <button type="button" class="danger" data-sel="unfollow">取消关注</button>`}</span>`;
  }

  // ---------- tag writes ----------
  function newTag(name, color) {
    return { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, color: color || COLORS[D.tags.length % COLORS.length], rule: "", push: false };
  }
  const cleanName = (s) => String(s ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);

  async function changeTags(mids, add, remove) {
    const map = { ...D.map };
    for (const m of mids) {
      const ids = [...new Set([...(map[m] || []).filter((id) => !remove.includes(id)), ...add])];
      if (ids.length) map[m] = ids;
      else delete map[m];
    }
    await write({ bs_up_tag_map: map });
  }

  // ---------- follow / unfollow ----------
  async function unfollow(mids) {
    const names = mids.map((m) => ups.get(m)?.name || m);
    const list = names.slice(0, 20).join("、") + (names.length > 20 ? ` 等 ${names.length} 人` : "");
    const ok = await BS.confirm(`在 B站 取消关注这 ${mids.length} 个 UP 主？\n\n${list}\n\n标签会记着，在「已取消关注」里可以重新关注。`, { ok: "取消关注", danger: true });
    if (!ok) return;
    await relationBatch(mids, 2, "取消关注");
  }

  async function refollow(mids) {
    const names = mids.map((m) => ups.get(m)?.name || m).slice(0, 20).join("、");
    if (!(await BS.confirm(`在 B站 重新关注 ${mids.length} 个 UP 主？\n\n${names}`, { ok: "重新关注" }))) return;
    await relationBatch(mids, 1, "重新关注");
  }

  // 特别关注 is B站's only group the phone app pushes new videos for. bs-special changes it (stays followed);
  // the background updates bs_followings.special.
  async function special(mids, on) {
    mids = mids.filter((m) => ups.get(m) && ups.get(m).special !== on);
    if (!mids.length) return toast(on ? "选中的都已经是特别关注了" : "选中的都不是特别关注");
    const names = mids.map((m) => ups.get(m).name);
    const list = names.slice(0, 20).join("、") + (names.length > 20 ? ` 等 ${names.length} 人` : "");
    const why = "特别关注的 UP 主发视频，手机 B站 会推送。";
    if (!(await BS.confirm(`在 B站 ${on ? "把这" : "取消这"} ${mids.length} 个 UP 主${on ? "设为" : "的"}特别关注？\n\n${list}\n\n${why}${on ? "" : "取消后还是关注着，只是不再推送。"}`, { ok: on ? "设为特别关注" : "取消特别关注" }))) return;
    S.busy = true;
    let done = 0;
    const label = on ? "设为特别关注" : "取消特别关注";
    try {
      for (const mid of mids) {
        toast(`正在${label} ${done + 1}/${mids.length}`);
        await BS.send("bs-special", { mid, on });
        done++;
      }
      toast(`已${label} ${done} 个`);
    } catch (e) {
      toast(`${label}第 ${done + 1} 个时出错：${errText(e)}${done ? `（前 ${done} 个已完成）` : ""}`, { error: true });
    } finally {
      S.busy = false;
    }
  }

  // UPs whose tag has push on but who are not 特别关注: our push only works while the browser is open.
  function renderSuggest() {
    const el = root.querySelector("#fwSpecial");
    const on = new Set(D.tags.filter((t) => t.push).map((t) => t.id));
    const mids = S.side === "gone" ? [] : following().filter((m) => !ups.get(m).special && (D.map[m] || []).some((id) => on.has(id)));
    el.hidden = !mids.length;
    if (!mids.length) return;
    const names = mids.slice(0, 5).map((m) => esc(ups.get(m).name)).join("、") + (mids.length > 5 ? ` 等 ${mids.length} 个` : "");
    el.innerHTML = `${names} 的标签开了推送，但不是特别关注。设成特别关注，浏览器关着时手机 B站 也会推。
      <button type="button" data-act="special-suggest">设为特别关注</button>`;
    el.dataset.mids = mids.join(",");
  }

  // One request per UP, in order; storage is updated after each so a failure keeps what already went through.
  async function relationBatch(mids, act, label) {
    S.busy = true;
    let done = 0;
    try {
      for (const mid of mids) {
        toast(`正在${label} ${done + 1}/${mids.length}`);
        await BS.send("bs-follow", { mid, act });
        const cur = await BS.get(["bs_unfollowed", "bs_up_tag_map", "bs_up_tags"]);
        const gone = cur.bs_unfollowed || {};
        const map = cur.bs_up_tag_map || {};
        if (act === 2) {
          // The background already wrote { at, tagIds, source: "app" }; merge so nothing it set is lost.
          gone[mid] = { at: Math.floor(Date.now() / 1000), source: "app", ...gone[mid], tagIds: map[mid] || gone[mid]?.tagIds || [] };
          delete map[mid];
        } else {
          const live = new Set((cur.bs_up_tags || []).map((t) => t.id));
          const ids = (gone[mid]?.tagIds || []).filter((id) => live.has(id));
          if (ids.length) map[mid] = ids;
          delete gone[mid];
        }
        await write({ bs_unfollowed: gone, bs_up_tag_map: map });
        S.sel.delete(mid);
        done++;
      }
      toast(`已${label} ${done} 个`);
    } catch (e) {
      toast(`${label}第 ${done + 1} 个时出错：${errText(e)}${done ? `（前 ${done} 个已完成）` : ""}`, { error: true });
    } finally {
      S.busy = false;
    }
  }

  // ---------- tag manager ----------
  function openTagManager() {
    const dlg = document.createElement("dialog");
    dlg.className = "bs-confirm fw-dlg";
    const rows = () => D.tags.map((t) => `<div class="tag-row" data-id="${esc(t.id)}">
        <input type="color" class="t-color" value="${esc(t.color)}" aria-label="颜色">
        <input type="text" class="t-name" value="${esc(t.name)}" maxlength="12" aria-label="名字">
        <input type="text" class="t-rule" value="${esc(t.rule || "")}" placeholder="说明，给 AI 看，可不填" aria-label="说明">
        <label class="toggle"><input type="checkbox" class="t-push" ${t.push ? "checked" : ""}> 推送</label>
        <button type="button" class="link del" data-del>删除</button>
      </div>`).join("") || `<p class="muted">还没有标签。</p>`;
    const draw = () => {
      dlg.querySelector(".tag-rows").innerHTML = rows();
      dlg.querySelector(".push-hint").hidden = !(D.tags.some((t) => t.push) && !D.bs_settings?.push);
    };
    dlg.innerHTML = `<h2>管理标签</h2>
      <p class="muted">标签只存在扩展里，不改 B站 的分组。</p>
      <div class="tag-rows"></div>
      <p class="muted push-hint" hidden>推送总开关在<a href="#settings">「设置」</a>里，现在是关的，打开后才会推。</p>
      <form class="tag-new"><input type="text" name="name" maxlength="12" placeholder="新标签名" aria-label="新标签名"><button type="submit">添加</button></form>
      <div class="dialog-actions"><button type="button" class="primary" data-close>完成</button></div>`;
    document.body.append(dlg);
    draw();
    dlg.showModal();
    const save = async (tags) => { await write({ bs_up_tags: tags }); D.tags = tags; draw(); };
    dlg.addEventListener("close", () => dlg.remove());
    dlg.querySelector("[data-close]").onclick = () => dlg.remove();
    dlg.querySelector(".tag-new").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = cleanName(e.target.name.value);
      if (!name) return;
      if (D.tags.some((t) => t.name === name)) return toast("已经有这个标签了", { error: true });
      await save([...D.tags, newTag(name)]);
      e.target.reset();
    });
    dlg.addEventListener("change", async (e) => {
      const row = e.target.closest(".tag-row");
      if (!row) return;
      const id = row.dataset.id;
      const t = { ...D.tags.find((x) => x.id === id) };
      if (e.target.matches(".t-name")) {
        const name = cleanName(e.target.value);
        if (!name || D.tags.some((x) => x.name === name && x.id !== id)) {
          toast(name ? "已经有这个标签了" : "名字不能为空", { error: true });
          return draw();
        }
        t.name = name;
      } else if (e.target.matches(".t-rule")) t.rule = e.target.value.trim();
      else if (e.target.matches(".t-color")) t.color = e.target.value;
      else if (e.target.matches(".t-push")) t.push = e.target.checked;
      await save(D.tags.map((x) => (x.id === id ? t : x)));
    });
    dlg.addEventListener("click", async (e) => {
      if (e.target.closest("a[href^='#']")) return dlg.remove();
      if (!e.target.matches("[data-del]")) return;
      const id = e.target.closest(".tag-row").dataset.id;
      const t = D.tags.find((x) => x.id === id);
      const n = following().filter((m) => D.map[m]?.includes(id)).length;
      if (!(await BS.confirm(`删除标签「${t.name}」？${n ? `${n} 个 UP 主会去掉这个标签。` : ""}`, { ok: "删除", danger: true }))) return;
      const map = {};
      for (const [m, ids] of Object.entries(D.map)) {
        const rest = ids.filter((x) => x !== id);
        if (rest.length) map[m] = rest;
      }
      await write({ bs_up_tag_map: map });
      await save(D.tags.filter((x) => x.id !== id));
    });
  }

  // ---------- AI batch tagging ----------
  function openAi() {
    const selMids = [...S.sel];
    const viewMids = S.side === "gone" ? [] : [...shown];
    const dlg = document.createElement("dialog");
    dlg.className = "bs-confirm fw-dlg wide";
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    let instruction = "";
    let scope = selMids.length ? "sel" : "view";
    let proposal = null;
    let off = new Set(); // unticked mids and "new:<name>"
    let asked = []; // mids sent, in list order

    const aiReady = D.bs_settings?.ai?.baseUrl && D.bs_settings?.ai?.model;
    // AI reads titles and 分区 from bs_content; say how many in the scope it can only judge by name and 签名.
    const noContent = (s) => (s === "sel" ? selMids : viewMids).filter((m) => !D.bs_content?.[m]?.v?.length).length;
    const scopeNote = (s) => (noContent(s) ? `其中 ${noContent(s)} 个还没查投稿，AI 只能看名字和签名。` : "");

    function drawAsk() {
      if (!aiReady) {
        dlg.innerHTML = `<h2><span class="ai-spark"></span>AI 打标签</h2>
          <p>还没设置 AI。先去<a href="#settings">「设置」</a>填一个兼容 OpenAI 的接口（DeepSeek、通义、Kimi 或本机 Ollama 都行），再回来写指令。</p>
          <div class="dialog-actions"><button type="button" data-close>关闭</button></div>`;
        return;
      }
      dlg.innerHTML = `<h2><span class="ai-spark"></span>AI 打标签</h2>
        <textarea rows="3" placeholder="比如：按内容分成 科普、游戏、生活，每人只打一个">${esc(instruction)}</textarea>
        <div class="scope">范围：
          <label><input type="radio" name="scope" value="sel" ${scope === "sel" ? "checked" : ""} ${selMids.length ? "" : "disabled"}> 选中的 ${selMids.length} 个</label>
          <label><input type="radio" name="scope" value="view" ${scope === "view" ? "checked" : ""} ${viewMids.length ? "" : "disabled"}> 当前列表 ${viewMids.length} 个</label>
        </div>
        <p class="muted">AI 看名字、签名、主要分区和最近 5 个标题，每 60 个一批，一批要等几十秒。只给建议，你勾选后才改。标签只存在扩展里，不改 B站。<span class="scope-note">${scopeNote(scope)}</span></p>
        <div class="dialog-actions"><button type="button" data-close>关闭</button><button type="button" class="primary" data-run>开始</button></div>`;
    }

    function drawReview() {
      const { newTags, assignments, note } = proposal;
      const mids = asked.filter((m) => assignments[m]);
      const chip = (name, cls) => {
        const t = D.tags.find((x) => x.name === name);
        return `<span class="chip ${cls}" style="--c:${esc(t?.color || "var(--ok)")}">${cls === "add" ? "+" : "−"} ${esc(name)}</span>`;
      };
      const picked = mids.filter((m) => !off.has(m)).length;
      dlg.innerHTML = `<h2><span class="ai-spark"></span>AI 的建议</h2>
        ${note ? `<p class="muted">${esc(note)}</p>` : ""}
        ${newTags.length ? `<div class="ai-new">新标签：${newTags.map((n) => `<label class="toggle"><input type="checkbox" data-new="${esc(n)}" ${off.has(`new:${n}`) ? "" : "checked"}> ${esc(n)}</label>`).join("")}</div>` : ""}
        ${mids.length ? `<div class="ai-tools"><button type="button" class="link" data-all="1">全选</button><button type="button" class="link" data-all="0">全不选</button></div>
        <div class="ai-rows">${mids.map((m) => {
          const a = assignments[m];
          const u = ups.get(m);
          return `<label class="ai-row${off.has(m) ? " off" : ""}"><input type="checkbox" data-mid="${esc(m)}" ${off.has(m) ? "" : "checked"}>
            ${avatar(u?.face, 28)}<span class="ai-row-body"><b>${u?.nameHtml || esc(m)}</b>
            <span class="chips">${a.add.map((n) => chip(n, "add")).join("")}${a.remove.map((n) => chip(n, "remove")).join("")}</span>
            ${a.reason ? `<span class="meta">${esc(a.reason)}</span>` : ""}</span></label>`;
        }).join("")}</div>` : `<p class="empty">AI 没有要改的。</p>`}
        <div class="dialog-actions"><button type="button" data-back>改指令</button><button type="button" data-close>关闭</button>
          <button type="button" class="primary" data-apply ${picked ? "" : "disabled"}>应用 ${picked} 个</button></div>`;
    }

    async function run(btn) {
      instruction = dlg.querySelector("textarea").value.trim();
      scope = dlg.querySelector("input[name=scope]:checked")?.value || scope;
      const mids = scope === "sel" ? selMids : viewMids;
      if (!instruction) return toast("先写要 AI 做什么", { error: true });
      if (!mids.length) return toast("范围里没有 UP 主", { error: true });
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = `AI 在看 ${mids.length} 个${mids.length > 60 ? `（${Math.ceil(mids.length / 60)} 批）` : ""}…`;
      try {
        proposal = await BS.send("bs-ai-tag", { instruction, mids });
        asked = mids;
        off = new Set();
        drawReview();
      } catch (e) {
        toast(e, { error: true });
        drawAsk();
      }
    }

    async function apply() {
      const { newTags, assignments } = proposal;
      const created = newTags.filter((n) => !off.has(`new:${n}`) && !D.tags.some((t) => t.name === n));
      const tags = [...D.tags];
      for (const n of created) tags.push(newTag(n, COLORS[tags.length % COLORS.length]));
      const idOf = new Map(tags.map((t) => [t.name, t.id]));
      const map = { ...D.map };
      const still = new Set(following()); // unfollowed while the proposal was open: no tags written back
      let changed = 0, skipped = 0;
      for (const [m, a] of Object.entries(assignments)) {
        if (off.has(m)) continue;
        if (!still.has(m)) { skipped++; continue; }
        const add = a.add.map((n) => idOf.get(n)).filter(Boolean); // unticked new tags have no id
        const remove = a.remove.map((n) => idOf.get(n)).filter(Boolean);
        const ids = [...new Set([...(map[m] || []).filter((id) => !remove.includes(id)), ...add])];
        if (ids.length) map[m] = ids;
        else delete map[m];
        changed++;
      }
      await write({ bs_up_tags: tags, bs_up_tag_map: map });
      dlg.remove();
      toast(`改了 ${changed} 个 UP 主的标签${created.length ? `，新建 ${created.length} 个标签` : ""}${skipped ? `，跳过 ${skipped} 个已取消关注的` : ""}`);
    }

    dlg.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-close]") || t.closest("a[href^='#']")) dlg.remove();
      else if (t.closest("[data-run]")) run(t.closest("[data-run]"));
      else if (t.closest("[data-back]")) drawAsk();
      else if (t.closest("[data-apply]")) apply();
      else if (t.closest("[data-all]")) {
        off = t.closest("[data-all]").dataset.all === "1" ? new Set([...off].filter((k) => k.startsWith("new:"))) : new Set([...off, ...Object.keys(proposal.assignments)]);
        drawReview();
      }
    });
    dlg.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "scope") return (dlg.querySelector(".scope-note").textContent = scopeNote(t.value));
      const key = t.dataset.mid || (t.dataset.new && `new:${t.dataset.new}`);
      if (!key) return;
      if (t.checked) off.delete(key);
      else off.add(key);
      drawReview();
    });
    drawAsk();
    dlg.showModal();
  }

  // ---------- events ----------
  function onClick(e) {
    const t = e.target;
    const side = t.closest("[data-side]");
    if (side) {
      S.side = side.dataset.side;
      S.sel.clear();
      return render();
    }
    const st = t.closest("[data-status]");
    if (st) {
      S.status = st.dataset.status;
      return render();
    }
    const start = t.closest("[data-act=start]");
    if (start) {
      start.disabled = true;
      return BS.send("bs-job-start", { job: start.dataset.job }).catch((err) => { start.disabled = false; toast(err, { error: true }); });
    }
    if (t.closest("[data-act=special-suggest]")) return S.busy ? toast("上一批还没做完") : special(root.querySelector("#fwSpecial").dataset.mids.split(","), true);
    const star = t.closest("[data-star]");
    if (star) return S.busy ? toast("上一批还没做完") : special([star.dataset.star], !ups.get(star.dataset.star).special);
    if (t.closest("[data-act=tags]")) return openTagManager();
    if (t.closest("[data-act=ai]")) return openAi();
    const sel = t.closest("[data-sel]");
    if (sel && sel.tagName === "BUTTON") {
      if (S.busy) return toast("上一批还没做完");
      const act = sel.dataset.sel;
      if (act === "all") shown.forEach((m) => S.sel.add(m));
      if (act === "none") S.sel.clear();
      if (act === "unfollow") return unfollow([...S.sel]);
      if (act === "refollow") return refollow([...S.sel]);
      if (act === "special-on" || act === "special-off") return special([...S.sel], act === "special-on");
      if (act === "ai") return openAi();
      return render();
    }
    const re = t.closest("[data-refollow]");
    if (re) return S.busy ? toast("上一批还没做完") : refollow([re.dataset.refollow]);
    const c = t.closest(".card.up");
    if (!c || t.closest("a")) return;
    if (t.matches(".up-check")) {
      if (t.checked) S.sel.add(c.dataset.mid);
      else S.sel.delete(c.dataset.mid);
      c.classList.toggle("selected", t.checked);
      return renderSel();
    }
    window.open(space(c.dataset.mid), "_blank", "noopener");
  }

  async function onChange(e) {
    const t = e.target;
    if (t.id === "fwSort") { S.sort = t.value; return render(); }
    const act = t.dataset.sel;
    if (!act || !t.value) return;
    const mids = [...S.sel];
    if (act === "add") {
      let id = t.value;
      if (id === "__new") {
        const name = cleanName(prompt("新标签名（≤12 字，只存在扩展里，不改 B站）") || "");
        if (!name) return renderSel();
        const old = D.tags.find((x) => x.name === name);
        id = old?.id;
        if (!old) {
          const nt = newTag(name);
          id = nt.id;
          await write({ bs_up_tags: [...D.tags, nt] });
          D.tags = [...D.tags, nt];
        }
      }
      await changeTags(mids, [id], []);
      toast(`给 ${mids.length} 个 UP 主加上了「${D.tags.find((x) => x.id === id)?.name}」`);
    } else if (act === "remove") {
      await changeTags(mids, [], [t.value]);
      toast(`从 ${mids.length} 个 UP 主去掉了「${D.tags.find((x) => x.id === t.value)?.name}」`);
    }
  }

  let qTimer = 0;
  BS.page("follow", {
    async mount(el) {
      root = el;
      el.innerHTML = `<div class="fw">
        <aside class="fw-side" aria-label="标签"><div id="fwSide" class="folder-list"></div><hr><button type="button" class="side-item" data-act="tags">管理标签</button></aside>
        <section class="fw-main">
          <div class="fw-bar">
            <input id="fwQ" type="search" placeholder="搜名字" aria-label="搜名字" autocomplete="off">
            <select id="fwSort" aria-label="排序">${[["last", "按最后投稿"], ["follow", "按关注时间"], ["name", "按名字"]].map(([v, t]) => `<option value="${v}" ${S.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>
            <button type="button" id="fwAll" class="link" data-sel="all"></button>
            <span class="spacer"></span>
            <button type="button" class="primary" data-act="ai"><span class="ai-spark"></span>AI 打标签</button>
          </div>
          <div id="fwSeg" class="seg" role="group" aria-label="更新状态"></div>
          <p id="fwHint" class="fw-hint" hidden></p>
          <p id="fwSpecial" class="fw-hint" hidden></p>
          <div id="fwList" class="fw-list"><p class="empty">加载中…</p></div>
          <div id="fwSel" class="selbar" hidden></div>
        </section></div>`;
      // Listeners go on the page's own element: #view outlives this page.
      el.firstElementChild.addEventListener("click", onClick);
      el.firstElementChild.addEventListener("change", onChange);
      el.querySelector("#fwQ").addEventListener("input", (e) => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => { S.q = e.target.value; render(); }, 150);
      });
      // bs_jobs ticks about once a second per running job: redraw only the hint / empty state then, not 900+ cards.
      BS.onStore(KEYS, async (ch) => {
        if (Object.keys(ch).every((k) => k === "bs_jobs")) {
          D.bs_jobs = ch.bs_jobs.newValue;
          return following().length && hintArgs ? renderHint(...hintArgs) : render();
        }
        await load();
        render();
      });
      await load();
      render();
    },
    unmount() { clearTimeout(qTimer); root = null; }
  });
})();
