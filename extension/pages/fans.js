// #fans: my fans from bs_fans (first circle only; never fetch fans' followings). Counts at top, filters (互关 / 未互关 /
// 新粉丝 = last 30 days), search, sort, and 回关 (bs-follow act 1, after a confirm).
(() => {
  const { esc, toast, fmtAgo, fmtCount, avatar, errText, nameOf, nameHtml, nameText } = BS;
  const KEYS = ["bs_fans", "bs_people", "bs_followings", "bs_me", "bs_jobs"];
  const NEW_DAYS = 30;
  const S = { f: "", q: "", sort: "new" };
  let root = null;
  let D = {};
  let qTimer = 0;

  async function load() {
    D = await BS.get(KEYS);
    const people = D.bs_people || {};
    const mine = new Set(D.bs_followings?.list || []);
    const since = Date.now() / 1000 - NEW_DAYS * 86400;
    D.fans = (D.bs_fans?.list || []).map((f) => {
      const p = people[f.mid] || {};
      return { ...f, name: nameOf(p, f.mid).missing ? "" : p.name, label: nameText(p, f.mid), html: nameHtml(p, f.mid), face: p.face, sign: p.sign || "", ov: p.ov || "", mutual: !!f.mutual || mine.has(f.mid), fresh: f.followTime >= since };
    });
  }

  function render() {
    if (!root) return;
    const all = D.fans;
    const mine = D.bs_jobs?.mine || {};
    const n = { "": all.length, mutual: all.filter((f) => f.mutual).length, one: all.filter((f) => !f.mutual).length, fresh: all.filter((f) => f.fresh).length };
    root.querySelector("#fansSum").innerHTML = [
      [D.bs_me?.follower ?? all.length, "粉丝"],
      [n.mutual, "互关"],
      [n.fresh, `近 ${NEW_DAYS} 天新粉丝`]
    ].map(([v, l]) => `<div><b>${fmtCount(v)}</b><span>${l}</span></div>`).join("") +
      (mine.running ? `<p class="meta">正在${esc(mine.step || "同步")}${mine.total ? ` ${mine.done}/${mine.total}` : ""}，拉完会刷新。</p>`
        : D.bs_me?.follower > all.length ? `<p class="meta">B站 只给看最近的一部分粉丝，这里有 ${all.length} 个。</p>` : "");
    root.querySelector("#fansSeg").innerHTML = [["", "全部"], ["mutual", "互关"], ["one", "未互关"], ["fresh", "新粉丝"]]
      .map(([id, l]) => `<button type="button" data-f="${id}" aria-pressed="${S.f === id}"${n[id] ? "" : ' class="zero"'}>${l} ${n[id]}</button>`).join("");

    const q = S.q.trim().toLowerCase();
    let list = all.filter((f) => (S.f === "mutual" ? f.mutual : S.f === "one" ? !f.mutual : S.f === "fresh" ? f.fresh : true) && (!q || f.name.toLowerCase().includes(q)));
    list = [...list].sort(S.sort === "name" ? (a, b) => a.name.localeCompare(b.name, "zh") : S.sort === "old" ? (a, b) => a.followTime - b.followTime : (a, b) => b.followTime - a.followTime);

    const el = root.querySelector("#fansList");
    if (!all.length) {
      const last = mine.throttled ? "上次被 B站 限流暂停了。" : mine.error ? `上次出错：${esc(errText(mine.error))}。` : "";
      el.innerHTML = `<p class="empty">${mine.running ? "粉丝列表在最后一步拉，拉完就显示。"
        : D.bs_fans ? "还没有人关注你。" : `还没有粉丝数据。${last}<button type="button" data-start="mine">${mine.finishedAt ? "再同步一次" : mine.done || mine.cursor ? "继续同步" : "开始同步"}我的关注和粉丝</button>`}</p>`;
    }
    else if (!list.length) el.innerHTML = `<p class="empty">没有符合条件的粉丝</p>`;
    else el.innerHTML = list.map((f) => `<article class="card fan">
        ${avatar(f.face, 40)}
        <div class="up-body">
          <div class="fan-head">
            <a class="fan-name" href="https://space.bilibili.com/${esc(f.mid)}" target="_blank" rel="noopener">${f.html}</a>
            ${f.mutual ? `<span class="badge mutual">互关</span>` : ""}
            ${f.fresh ? `<span class="badge new">新粉丝</span>` : ""}
            ${f.ov ? `<span class="up-ov">${esc(f.ov.replace(/^bilibili\s*/, ""))}</span>` : ""}
          </div>
          ${f.sign ? `<div class="up-sign" title="${esc(f.sign)}">${esc(f.sign)}</div>` : ""}
          <div class="meta">${f.followTime ? `${fmtAgo(f.followTime)}关注了你 · ${new Date(f.followTime * 1000).toLocaleDateString("zh-CN")}` : ""}</div>
        </div>
        ${f.mutual ? "" : `<button type="button" data-back="${esc(f.mid)}">回关</button>`}
      </article>`).join("");
    renderLost();
  }

  // 最近取关我的: bs_fans.lost, written by the mine job when a fan is gone from the new list. Dates are when a sync noticed.
  function renderLost() {
    const el = root.querySelector("#fansLost");
    const lost = (D.bs_fans?.lost || []).slice(0, 50);
    el.hidden = !lost.length;
    if (!lost.length) return;
    const people = D.bs_people || {};
    el.innerHTML = `<h3>最近取关我的</h3><p class="meta">同步时发现不在粉丝列表里了，日期是发现的那天。</p>` + lost.map((f) => {
      const p = people[f.mid] || {};
      return `<div class="lost-row">${avatar(p.face, 24)}
        <a href="https://space.bilibili.com/${esc(f.mid)}" target="_blank" rel="noopener">${nameHtml(p, f.mid)}</a>
        <span class="meta">${new Date(f.at * 1000).toLocaleDateString("zh-CN")}${f.followTime ? ` · 关注过 ${esc(fmtSpanDays(f.at - f.followTime))}` : ""}</span></div>`;
    }).join("");
  }
  const fmtSpanDays = (sec) => (sec < 86400 ? "不到 1 天" : sec < 365 * 86400 ? `${Math.floor(sec / 86400)} 天` : `${(sec / (365 * 86400)).toFixed(1)} 年`);

  async function followBack(btn) {
    const f = D.fans.find((x) => x.mid === btn.dataset.back);
    if (!(await BS.confirm(`在 B站 关注「${f.label}」？`, { ok: "回关" }))) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try {
      await BS.send("bs-follow", { mid: f.mid, act: 1 });
      toast(`已回关 ${f.label}`);
    } catch (e) {
      toast(`回关失败：${errText(e)}`, { error: true });
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }

  BS.page("fans", {
    async mount(el) {
      root = el;
      el.innerHTML = `<div class="fans">
        <div id="fansSum" class="fans-sum"></div>
        <div class="fans-bar">
          <div id="fansSeg" class="seg" role="group" aria-label="筛选"></div>
          <span class="spacer"></span>
          <input id="fansQ" type="search" placeholder="搜名字" aria-label="搜名字" autocomplete="off">
          <select id="fansSort" aria-label="排序"><option value="new">最近关注我的在前</option><option value="old">最早关注我的在前</option><option value="name">按名字</option></select>
        </div>
        <div id="fansList" class="fans-list"><p class="empty">加载中…</p></div>
        <section id="fansLost" class="fans-lost" hidden></section></div>`;
      el.firstElementChild.addEventListener("click", (e) => { // not on #view, which outlives this page
        const f = e.target.closest("[data-f]");
        if (f) { S.f = f.dataset.f; return render(); }
        const go = e.target.closest("[data-start]");
        if (go) {
          go.disabled = true;
          return BS.send("bs-job-start", { job: go.dataset.start }).catch((err) => { go.disabled = false; toast(err, { error: true }); });
        }
        const b = e.target.closest("[data-back]");
        if (b) followBack(b);
      });
      el.querySelector("#fansSort").value = S.sort;
      el.querySelector("#fansSort").addEventListener("change", (e) => { S.sort = e.target.value; render(); });
      el.querySelector("#fansQ").addEventListener("input", (e) => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => { S.q = e.target.value; render(); }, 150);
      });
      BS.onStore(KEYS, async () => { await load(); render(); });
      await load();
      render();
    },
    unmount() { clearTimeout(qTimer); root = null; }
  });
})();
