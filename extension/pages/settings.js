// #settings: 更新状态 thresholds, 关系图 mix alpha, 推送, then AI (optional). Everything lives in bs_settings:
// { slowDays, deadDays, alpha, push, pushMinutes, ai: { baseUrl, apiKey, model }, aiNewTags, aiRemove }.
// One save bar for the whole page. Saving writes only the fields that differ from what this page last saw stored, merged
// into bs_settings as read at save time, so the graph page's alpha slider is never undone. Pure helpers live in
// globalThis.BsSettings for pages/settings.selftest.js; the page part runs only where BS exists.
(() => {
  // The form as flat fields, in page order; baseUrl, apiKey and model are stored under bs_settings.ai.
  const DEFAULTS = { slowDays: 90, deadDays: 365, alpha: 0.5, push: false, pushMinutes: 15, baseUrl: "", apiKey: "", model: "", aiNewTags: 5, aiRemove: false };
  const AI_KEYS = ["baseUrl", "apiKey", "model"];
  const SECTION = { slowDays: "更新状态", deadDays: "更新状态", alpha: "关系图", push: "推送", pushMinutes: "推送", baseUrl: "AI", apiKey: "AI", model: "AI", aiNewTags: "AI", aiRemove: "AI" };

  const int = (v, min, max, d) => {
    const n = Math.round(Number(v));
    return String(v ?? "").trim() === "" || !Number.isFinite(n) ? d : Math.min(max, Math.max(min, n));
  };

  // Stored or typed values -> what gets stored: whole numbers in range, alpha in steps of 0.05, trimmed text.
  function clean(f) {
    const a = Number(f.alpha);
    return {
      baseUrl: String(f.baseUrl ?? "").trim(),
      apiKey: String(f.apiKey ?? "").trim(),
      model: String(f.model ?? "").trim(),
      aiNewTags: int(f.aiNewTags, 0, 50, DEFAULTS.aiNewTags),
      aiRemove: f.aiRemove === true,
      slowDays: int(f.slowDays, 1, 3650, DEFAULTS.slowDays),
      deadDays: int(f.deadDays, 2, 3650, DEFAULTS.deadDays),
      alpha: Number.isFinite(a) ? Math.min(1, Math.max(0, Math.round(a * 20) / 20)) : DEFAULTS.alpha,
      push: f.push === true,
      pushMinutes: int(f.pushMinutes, 5, 1440, DEFAULTS.pushMinutes)
    };
  }

  const flat = (s = {}) => clean({ ...DEFAULTS, ...s, ...s.ai, ai: undefined });
  const changed = (a, b) => Object.keys(DEFAULTS).filter((k) => a[k] !== b[k]);

  // The stored object after writing `keys` of the form into `latest` (bs_settings read just now). Other fields,
  // including ones this page does not know, stay as they are in `latest`.
  function merge(latest = {}, form, keys) {
    const next = { ...latest };
    for (const k of keys) {
      if (AI_KEYS.includes(k)) next.ai = { ...next.ai, [k]: form[k] };
      else next[k] = form[k];
    }
    return next;
  }

  // Storage changed from `before` to `after`: fields the user has not touched follow it, edited ones keep the edit.
  function follow(form, before, after) {
    const next = { ...form };
    for (const k of Object.keys(DEFAULTS)) if (form[k] === before[k]) next[k] = after[k];
    return next;
  }

  const sections = (keys) => [...new Set(keys.map((k) => SECTION[k]))];

  globalThis.BsSettings = { DEFAULTS, clean, flat, changed, merge, follow, sections };
  if (!globalThis.BS) return;

  // ---------------- page ----------------
  const { esc, toast } = BS;
  // Preset endpoints and each one's current fast model (MoonDigest options.js AI_PRESETS, #108).
  const PRESETS = [
    ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-flash"],
    ["智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4.7-flash"],
    ["Kimi", "https://api.moonshot.cn/v1", "kimi-k2.6"],
    ["MiniMax", "https://api.minimaxi.com/v1", "MiniMax-M2.7-highspeed"],
    ["OpenRouter", "https://openrouter.ai/api/v1", "~google/gemini-flash-latest"],
    ["Ollama（本机）", "http://localhost:11434/v1", ""]
  ];
  const THINKING = /^https?:\/\/(api\.deepseek\.com|open\.bigmodel\.cn|api\.z\.ai|api\.moonshot\.(cn|ai))(\/|:|$)/i; // same as Ai.thinkingToggle

  let root = null;
  let saved = flat(); // what this page last saw in storage
  let pushTags = 0;
  let canNotify = true;
  let statusTimer = 0;
  let leaving = false;

  const pct = (a) => `关注关系 ${Math.round(a * 100)}% · 投稿内容 ${Math.round((1 - a) * 100)}%`;
  const $ = (sel) => root.querySelector(sel);

  function readForm() {
    const v = (id) => $(`#${id}`).value;
    return clean({
      baseUrl: v("aiBase"), apiKey: v("aiKey"), model: v("aiModel"), aiNewTags: v("aiNewTags"), aiRemove: $("#aiRemove").checked,
      slowDays: v("slowDays"), deadDays: v("deadDays"), alpha: 1 - Number(v("alpha")), push: $("#push").checked, pushMinutes: v("pushMinutes")
    });
  }

  function fill(f) {
    const set = (id, val) => ($(`#${id}`).value = val);
    set("aiBase", f.baseUrl); set("aiKey", f.apiKey); set("aiModel", f.model); set("aiNewTags", f.aiNewTags);
    $("#aiRemove").checked = f.aiRemove;
    set("slowDays", f.slowDays); set("deadDays", f.deadDays); set("alpha", Math.round((1 - f.alpha) * 100) / 100);
    $("#push").checked = f.push;
    set("pushMinutes", f.pushMinutes);
  }

  const row = (label, hint, ctl, attrs = "") =>
    `<div class="row"${attrs}><div class="lab">${label}${hint ? `<p class="hint">${hint}</p>` : ""}</div><div class="ctl">${ctl}</div></div>`;

  function render() {
    root.innerHTML = `<div class="opt">
      <p class="noai" id="noAi">不配 AI 也能用：关注、粉丝、关系图、我的位置、动态和推送。配了 AI，再多出 ✦ AI 打标签和给圈子起名。</p>

      <section class="sec">
        <div class="sec-head"><h2>更新状态</h2><p>关注页按最后投稿时间，把 UP 主分成活跃、慢更、断更。</p></div>
        <div class="rows">
          ${row(`<label class="name" for="slowDays">慢更</label>`, "超过这么多天没投稿，算慢更。", `<input id="slowDays" type="number" min="1" max="3650" step="1"> 天`)}
          ${row(`<label class="name" for="deadDays">断更</label>`, "超过这么多天没投稿，算断更。要比慢更的天数多。", `<input id="deadDays" type="number" min="2" max="3650" step="1"> 天`)}
        </div>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>关系图</h2><p>两个人像不像，看关注关系和投稿内容。关系图页上的滑块也是这一项。</p></div>
        <div class="rows">
          <div class="row wide">
            <div class="mix"><span class="hint">关注关系</span><input id="alpha" type="range" min="0" max="1" step="0.05" aria-label="投稿内容占比"><span class="hint">投稿内容</span></div>
            <p id="alphaText" class="hint"></p>
          </div>
        </div>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>推送</h2><p>关注的 UP 主发新视频时，弹系统通知。浏览器开着才会推。</p></div>
        <div class="rows">
          ${row(`<label class="name" for="push">打开推送</label>`, "只推「关注」页里打开了推送的标签下的 UP 主。", `<input id="push" type="checkbox" class="switch">`)}
          ${row(`<label class="name" for="pushMinutes">检查间隔</label>`, "5 到 1440 分钟。", `<input id="pushMinutes" type="number" min="5" max="1440" step="1"> 分钟`, ` data-push`)}
          ${row(`<span class="name">试一下</span>`, "", `<button type="button" data-act="push-test">发一条试试</button>`, ` data-push`)}
          <p id="pushWarn" class="warn" role="status"></p>
        </div>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>AI</h2><p>可选。用来批量给 UP 主打标签、给关系图的圈子起名。填任何兼容 OpenAI 的接口。</p><span id="aiPill" class="pill off"></span></div>
        <div class="rows">
          ${row(`<label class="name" for="aiBase">接口地址</label>`, "点输入框可选常用的平台。", `<input id="aiBase" type="url" list="aiPresets" placeholder="https://api.deepseek.com/v1" autocomplete="off">
            <datalist id="aiPresets">${PRESETS.map(([n, u]) => `<option value="${esc(u)}">${esc(n)}</option>`).join("")}</datalist>`)}
          ${row(`<label class="name" for="aiKey">API Key</label>`, "只存在这台电脑的扩展里。", `<input id="aiKey" type="password" placeholder="sk-…" autocomplete="off">`)}
          ${row(`<label class="name" for="aiModel">模型</label>`, `<span id="modelHint"></span>`, `<input id="aiModel" type="text" autocomplete="off">`)}
          ${row(`<span class="name">测试连接</span>`, `<span id="aiStatus"></span>`, `<button type="button" data-act="ai-test">测试</button>`)}
          ${row(`<label class="name" for="aiNewTags">一次最多新建几个标签</label>`, "0 到 50。填 0 只用已有标签。调小不会删掉已有的标签。", `<input id="aiNewTags" type="number" min="0" max="50" step="1"> 个`)}
          ${row(`<label class="name" for="aiRemove">允许 AI 去掉已有标签</label>`, "关着时 AI 只加标签。不管开不开，都要你点「应用」才会改。", `<input id="aiRemove" type="checkbox" class="switch">`)}
        </div>
      </section>
    </div>
    <div class="savebar" id="saveBar" hidden><div class="savebar-in">
      <p id="saveStatus" class="status" role="status"></p>
      <span id="unsaved" class="unsaved">有未保存的修改<span id="where" class="where"></span></span>
      <button type="button" class="primary" data-act="save">保存</button>
    </div></div>`;
    fill(saved);
    sync();
  }

  // Everything that follows the form: the save bar, push rows, hints, disabled reasons.
  function sync() {
    const f = readForm();
    const diff = changed(f, saved);
    $("#unsaved").hidden = !diff.length;
    $("[data-act=save]").hidden = !diff.length;
    $("#where").textContent = diff.length ? `：${sections(diff).join("、")}` : "";
    $("#saveBar").hidden = !diff.length && !$("#saveStatus").textContent;

    $("#alphaText").textContent = pct(f.alpha);
    for (const el of root.querySelectorAll("[data-push]")) el.hidden = !f.push;
    $("#pushWarn").textContent = !f.push ? ""
      : !canNotify ? "通知权限被关了，推送发不出来。把开关关掉再打开，重新允许。"
      : pushTags ? "" : "还没有标签打开推送：去「关注」页点「管理标签」，给要推送的标签勾上「推送」。";

    const preset = PRESETS.find(([, u]) => u === f.baseUrl.replace(/\/+$/, ""));
    $("#aiModel").placeholder = preset?.[2] || "deepseek-flash";
    $("#modelHint").textContent = (preset?.[2] ? `${preset[0]} 现在的快模型是 ${preset[2]}。` : "比如 deepseek-flash、glm-4.7-flash、kimi-k2.6。") +
      (THINKING.test(f.baseUrl) ? "会自动关掉模型的「思考」，回复更快、不容易被截断。" : "");
    const test = $("[data-act=ai-test]");
    const ready = f.baseUrl && f.model;
    if (!test.hasAttribute("aria-busy")) test.disabled = !ready;
    const st = $("#aiStatus");
    if (!ready) { st.textContent = "先填接口地址和模型，才能测试。"; st.className = ""; }
    else if (!st.className) st.textContent = "用上面填的（没保存也行）发一条很短的请求。";

    const aiSaved = Boolean(saved.baseUrl && saved.model);
    $("#noAi").hidden = aiSaved;
    $("#aiPill").textContent = aiSaved ? "已配置" : "没配也能用";
    $("#aiPill").className = `pill ${aiSaved ? "ok" : "off"}`;
  }

  function aiStatus(text, cls) {
    const st = $("#aiStatus");
    st.textContent = text;
    st.className = cls;
  }

  function barStatus(text, error = false) {
    const el = $("#saveStatus");
    el.textContent = text;
    el.dataset.error = String(error);
    clearTimeout(statusTimer);
    if (text && !error) statusTimer = setTimeout(() => root && (el.textContent = "", sync()), 3000);
    sync();
  }

  // Ask for the AI endpoint's origin; dev page has no chrome.permissions.
  async function allowHost(baseUrl) {
    let origin;
    try { origin = new URL(baseUrl).origin; } catch { throw new Error("接口地址不像网址"); }
    if (!chrome.permissions) return;
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) throw new Error(`没有允许访问 ${origin}`);
  }

  async function save() {
    const f = readForm();
    const keys = changed(f, saved);
    if (!keys.length) return;
    if (f.deadDays <= f.slowDays) return barStatus("断更的天数要比慢更多", true);
    if (keys.includes("baseUrl") && f.baseUrl) await allowHost(f.baseUrl); // first: needs the click's user gesture
    const latest = (await BS.get("bs_settings")) || {};
    const next = merge(latest, f, keys);
    await chrome.storage.local.set({ bs_settings: next });
    // Show what was stored (clamped, rounded), keep edits made to other fields meanwhile.
    const stored = flat(next);
    const form = readForm();
    for (const k of keys) form[k] = stored[k];
    saved = stored;
    fill(form);
    barStatus("已保存");
  }

  async function onClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === "save") await save();
      else if (act === "ai-test") {
        const f = readForm();
        await allowHost(f.baseUrl);
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
        aiStatus("正在测试…", "busy");
        await BS.send("bs-ai-test", { ai: { baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.model } });
        aiStatus(changed(f, saved).some((k) => ["baseUrl", "apiKey", "model"].includes(k)) ? "能用。记得点下面的「保存」。" : "能用。", "ok");
      } else if (act === "push-test") {
        await BS.send("bs-push-test");
        toast("发了一条通知，看看屏幕角落。没看到的话，去系统设置里允许浏览器发通知");
      }
    } catch (err) {
      if (act === "ai-test") aiStatus(err.message, "err");
      else if (act === "save") barStatus(err.message, true);
      else toast(err.message, { error: true });
    } finally {
      btn.removeAttribute("aria-busy");
      if (root) sync();
    }
  }

  async function onChange(e) {
    const t = e.target;
    if (t.type === "number") t.value = readForm()[t.id]; // the box shows what would be stored
    if ($("#saveStatus").dataset.error === "true") $("#saveStatus").textContent = "";
    if (t.id === "push" && t.checked && chrome.permissions) {
      // chrome.permissions.request needs this click; the switch is still only an edit until 保存.
      if (await chrome.permissions.request({ permissions: ["notifications"] })) canNotify = true;
      else { t.checked = false; toast("没有通知权限，推送开不了", { error: true }); }
    }
    if (t.id === "aiBase" || t.id === "aiModel" || t.id === "aiKey") aiStatus("", "");
    sync();
  }

  // Storage moved (graph slider, another tab, our own save): untouched fields follow, edits stay.
  function onSettings(changes) {
    if (!root || !changes.bs_settings) return;
    const after = flat(changes.bs_settings.newValue);
    fill(follow(readForm(), saved, after));
    saved = after;
    sync();
  }

  const dirty = () => root && changed(readForm(), saved).length > 0;
  const onUnload = (e) => { if (dirty()) e.preventDefault(); };
  // In-app tabs change the hash, which beforeunload does not see.
  async function onNav(e) {
    const a = e.target.closest?.("a[href^='#']");
    if (!a || leaving || !dirty()) return;
    e.preventDefault();
    e.stopPropagation();
    if (await BS.confirm("设置还没保存，离开会丢掉这些修改。", { ok: "不保存，离开", danger: true })) {
      leaving = true;
      location.hash = a.getAttribute("href");
    }
  }

  BS.page("settings", {
    async mount(el) {
      el.innerHTML = "<div></div>"; // listeners go on this child: #view outlives this page
      root = el.firstElementChild;
      leaving = false;
      const { bs_settings: got, bs_up_tags: tags = [] } = await BS.get(["bs_settings", "bs_up_tags"]);
      pushTags = tags.filter((t) => t.push).length;
      if (chrome.permissions) canNotify = await chrome.permissions.contains({ permissions: ["notifications"] });
      if (!root) return;
      saved = flat(got);
      render();
      root.addEventListener("click", onClick);
      root.addEventListener("change", onChange);
      root.addEventListener("input", sync);
      window.addEventListener("beforeunload", onUnload);
      document.addEventListener("click", onNav, true);
      BS.onStore("bs_settings", onSettings);
      BS.onStore("bs_up_tags", (c) => {
        pushTags = (c.bs_up_tags.newValue || []).filter((t) => t.push).length;
        if (root) sync();
      });
    },
    unmount() {
      root = null;
      clearTimeout(statusTimer);
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onNav, true);
    }
  });
})();
