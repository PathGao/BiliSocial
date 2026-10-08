// AI for UP tagging: one OpenAI-compatible chat call, plus MoonDigest's batch-tag prompt and parser ported from videos to UPs.
// Defines globalThis.Ai. Pure helpers come first; the selftest loads this file in a vm without chrome.
(() => {
  const BATCH = 60;
  const MAX_NEW_TAGS = 5; // default for bs_settings.aiNewTags (0–50)
  const TIMEOUT_MS = 120000;
  const CUT = "AI 的回复被截断了。少选几个 UP 主再试，或换个输出上限更大、不带「思考」的模型";

  // DeepSeek, 智谱 (CN / intl) and Kimi (CN / intl) think by default and take this switch; others get no param (MoonDigest #108).
  const thinkingToggle = (baseUrl) => /^https?:\/\/(api\.deepseek\.com|open\.bigmodel\.cn|api\.z\.ai|api\.moonshot\.(cn|ai))(\/|:|$)/i.test(String(baseUrl || "").trim());
  // bs_settings.aiNewTags -> 0..50, missing = MAX_NEW_TAGS.
  const newTagCap = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? MAX_NEW_TAGS : Math.min(50, Math.max(0, Math.round(Number(v)))));

  const clean = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();

  // tags are names or [{ name, rule }].
  const tagNames = (tags) => (Array.isArray(tags) ? tags : []).map((t) => String((t && typeof t === "object" ? t.name : t) ?? "").trim()).filter(Boolean);

  // Prompt lines: 「名称：说明」, or just the name.
  function tagLines(tags) {
    return (Array.isArray(tags) ? tags : [])
      .map((t) => {
        const name = tagNames([t])[0];
        const rule = t && typeof t === "object" ? String(t.rule ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
        return name && (rule ? `${name}：${rule}` : name);
      })
      .filter(Boolean);
  }

  // New tag names: no commas, trimmed, at most 12 characters.
  const cleanTagName = (name) => String(name ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);

  // First complete {...} in the model output, skipping ``` fences and brackets inside strings.
  function extractJson(content) {
    const s = String(content || "").replace(/```(?:json)?/gi, "");
    const start = s.indexOf("{");
    if (start < 0) throw new Error("AI 回复格式不对");
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error("AI 回复不完整");
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      throw new Error("AI 回复格式不对");
    }
  }

  // The prompt item for one UP from storage: { mid, name, sign, zone, titles, currentTags }.
  function upItem(mid, people, content, tags, tagMap) {
    const p = people[mid] || {};
    const c = content[mid] || {};
    const zone = Object.entries(c.tlist || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const byId = new Map(tags.map((t) => [t.id, t.name]));
    return {
      mid,
      name: p.name || mid,
      sign: p.sign || "",
      zone,
      titles: (c.v || []).slice(0, 5).map((v) => v.t),
      currentTags: (tagMap[mid] || []).map((id) => byId.get(id)).filter(Boolean)
    };
  }

  // 序号|UP名|签名|主要分区|近期标题（5 个）|现有标签
  function upLine(it, n) {
    const list = (a) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []);
    return [n, clean(it.name), clean(it.sign).slice(0, 60), clean(it.zone), list(it.titles).join("；"), list(it.currentTags).join("、")].join("|");
  }

  function buildMessages({ instruction, tags, items, maxNewTags = MAX_NEW_TAGS, allowRemove = false }) {
    const lines = tagLines(tags);
    const system = [
      "你是 B站关注整理助手，按用户指令给关注的 UP 主打标签、做分类。",
      "用户指令写在 <<<指令>>> 和 <<<指令结束>>> 之间，它就是本次任务的要求。",
      "规则：",
      "- add 只能用已有标签名，或本次 new_tags 里列出的新标签名。",
      maxNewTags > 0
        ? `- 可以新建标签，至多 ${maxNewTags} 个，名称 ≤12字、不含逗号；已有标签能用就先用，不要重复造。`
        : "- 这次不能新建标签，new_tags 留空，只用已有标签。",
      allowRemove ? "- remove 只能填该 UP 主“现有标签”里的名称。" : "- 只加标签，不要去掉任何已有标签，remove 一律留空 []。",
      allowRemove ? "- 标签带说明（冒号后）的，按说明决定给 UP 主加上还是去掉这个标签。" : "- 标签带说明（冒号后）的，按说明决定要不要给 UP 主加上这个标签。",
      "- 一个 UP 主可以加多个标签，也可以一个都不加；指令或标签说明要求只选一个时，每个 UP 主只加其中一个。",
      "- 主要依据近期标题和主要分区，签名次之。",
      "- reason ≤20字。",
      "- 指令不适用的 UP 主不要放进 items。",
      "- note ≤60字，总结做了什么，或者为什么没有合适的。",
      "只输出严格 JSON，不要任何其他文字、不要代码块：",
      `{"new_tags": ["标签名"], "items": [{"i": 序号, "add": ["标签"], "remove": ["标签"], "reason": "≤20字"}], "note": "≤60字"}`,
      "",
      "已有标签（每行一个，格式：名称：说明，没有说明只写名称）：",
      ...(lines.length ? lines : ["（无）"])
    ].join("\n");
    const user = [
      "<<<指令>>>",
      String(instruction ?? "").trim(),
      "<<<指令结束>>>",
      "",
      "UP 主列表，每行格式：序号|UP名|签名|主要分区|近期标题（5 个，用；隔开）|现有标签（没有的字段留空）：",
      ...items.map((it, i) => upLine(it, i + 1))
    ].join("\n");
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  // Only tag changes survive: add = existing or this call's new tags (≤ maxNewTags), remove = the UP's current tags and
  // only with allowRemove. UPs with no change are left out. Assignments are keyed by mid.
  function parse(content, items, tags, { maxNewTags = MAX_NEW_TAGS, allowRemove = false } = {}) {
    const obj = extractJson(content);
    const existing = new Set(tagNames(tags));
    const newTags = [];
    for (const t of Array.isArray(obj.new_tags) ? obj.new_tags : []) {
      if (newTags.length >= maxNewTags) break;
      const name = cleanTagName(t && typeof t === "object" ? t.name : t);
      if (name && !existing.has(name) && !newTags.includes(name)) newTags.push(name);
    }
    const valid = new Set([...existing, ...newTags]);
    const byIndex = new Map();
    for (const r of Array.isArray(obj.items) ? obj.items : []) {
      const i = Number(r?.i);
      if (Number.isInteger(i) && !byIndex.has(i)) byIndex.set(i, r);
    }
    const assignments = {};
    items.forEach((item, idx) => {
      const r = byIndex.get(idx + 1);
      if (!r || !item?.mid) return;
      const current = new Set(tagNames(item.currentTags));
      const pick = (arr, ok) => [...new Set((Array.isArray(arr) ? arr : []).map(cleanTagName))].filter((x) => x && ok(x));
      const a = {
        add: pick(r.add, (x) => valid.has(x) && !current.has(x)),
        remove: allowRemove ? pick(r.remove, (x) => current.has(x)) : [],
        reason: String(r.reason ?? "").trim()
      };
      if (a.add.length || a.remove.length) assignments[item.mid] = a;
    });
    // A new tag no UP got is noise.
    const used = new Set(Object.values(assignments).flatMap((a) => a.add));
    return { newTags: newTags.filter((n) => used.has(n)), assignments, note: String(obj.note ?? "").trim() };
  }

  // Non-streaming chat completion; returns the reply text.
  // cutOk: a reply stopped by max_tokens still counts (the connection test asks for 1 token).
  async function chat(ai, messages, { maxTokens, cutOk = false } = {}) {
    const baseUrl = String(ai?.baseUrl || "").trim().replace(/\/+$/, "");
    const model = String(ai?.model || "").trim();
    if (!baseUrl) throw new Error("没填 AI 接口地址，去设置页填");
    if (!model) throw new Error("没填模型名，去设置页填");
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model, messages, stream: false, temperature: 0.2,
          ...(maxTokens && { max_tokens: maxTokens }),
          ...(thinkingToggle(baseUrl) && { thinking: { type: "disabled" } })
        })
      });
    } catch (e) {
      if (e?.name === "TimeoutError") throw new Error(`AI ${TIMEOUT_MS / 1000} 秒没回应`);
      throw new Error(`连不上 AI 接口：${e?.message || e}（设置页点「测试」会申请访问这个网址）`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`AI 接口返回 HTTP ${res.status}${detail ? `：${detail}` : ""}`);
    }
    const json = await res.json().catch(() => null);
    const choice = json?.choices?.[0];
    if (cutOk) return String(choice?.message?.content ?? "");
    if (choice?.finish_reason === "length") throw Object.assign(new Error(CUT), { code: "AI_CUT" });
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("AI 回复是空的，再试一次；还不行就换个模型");
    return text;
  }

  // bs-ai-tag: proposal { newTags, assignments: { mid: { add, remove, reason } }, note } for `mids`. Writes nothing.
  // Large scopes go in batches of BATCH; new tags from earlier batches count as existing for later ones, total ≤ aiNewTags.
  // Removes only when bs_settings.aiRemove is on.
  async function tag({ instruction, mids }) {
    if (!String(instruction ?? "").trim()) throw new Error("先写要 AI 做什么");
    if (!Array.isArray(mids) || !mids.length) throw new Error("没有要打标签的 UP 主");
    const st = await chrome.storage.local.get(["bs_settings", "bs_people", "bs_content", "bs_up_tags", "bs_up_tag_map"]);
    const tags = st.bs_up_tags || [];
    const items = mids.map((mid) => upItem(String(mid), st.bs_people || {}, st.bs_content || {}, tags, st.bs_up_tag_map || {}));
    const cap = newTagCap(st.bs_settings?.aiNewTags);
    const allowRemove = st.bs_settings?.aiRemove === true;
    const out = { newTags: [], assignments: {}, note: "" };
    const notes = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const known = [...tags, ...out.newTags.map((name) => ({ name }))];
      const maxNewTags = cap - out.newTags.length;
      const reply = await chat(st.bs_settings?.ai, buildMessages({ instruction, tags: known, items: batch, maxNewTags, allowRemove }));
      const r = parse(reply, batch, known, { maxNewTags, allowRemove });
      out.newTags.push(...r.newTags);
      Object.assign(out.assignments, r.assignments);
      if (r.note) notes.push(r.note);
    }
    out.note = notes.join(" ");
    return out;
  }

  // bs-ai-test: one tiny request with the given (unsaved) settings.
  async function test(ai) {
    await chat(ai, [{ role: "user", content: "ping" }], { maxTokens: 1, cutOk: true });
    return "ok";
  }

  globalThis.Ai = { BATCH, MAX_NEW_TAGS, CUT, thinkingToggle, newTagCap, upItem, upLine, buildMessages, parse, chat, tag, test };
})();
