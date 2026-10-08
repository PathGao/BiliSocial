// bs-ai-name-groups: ask the configured AI (Ai.chat from lib/ai.js) to name each 关系图 圈子. Writes nothing; the page
// caches the answer in bs_group_names. Pure helpers are exported for the selftest (node, no chrome).
(() => {
  const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  // groups: [{ key, label, zones: [分区], members: [{ name, sign, titles: [..] }] }]
  function buildMessages(groups) {
    const blocks = groups.map((g, k) => [
      `## 圈子 ${k + 1}（key: ${g.key}）${g.zones?.length ? ` 主要分区：${g.zones.join("、")}` : ""}`,
      ...g.members.map((m) => `- ${cut(m.name, 20)}${m.sign ? `｜签名：${cut(m.sign, 40)}` : ""}${m.titles?.length ? `｜最近投稿：${m.titles.map((t) => cut(t, 24)).join(" / ")}` : ""}`)
    ].join("\n"));
    return [
      {
        role: "system",
        content: "你帮用户给 B站关注关系图里的「圈子」起名。每个圈子是一群常被同一批人关注、内容相近的 UP 主。" +
          "名字 2 到 6 个汉字，说清这群人是做什么的（如「硬核科普」「独立游戏」「家常菜」），不要用某个 UP 主的名字，各圈子名字不要重复。" +
          "再写一句不超过 25 字的说明。只回 JSON：{\"names\":[{\"key\":\"原样抄 key\",\"name\":\"...\",\"desc\":\"...\"}]}"
      },
      { role: "user", content: blocks.join("\n\n") }
    ];
  }

  // Model reply -> [{ key, name, desc }] for known keys only; names cut to 6 characters, descriptions to one line.
  function parse(text, keys) {
    const s = String(text || "").replace(/```(?:json)?/gi, "");
    let json;
    try { json = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { throw new Error("AI 回复格式不对，再试一次"); }
    const known = new Set(keys);
    const names = (json?.names || [])
      .filter((x) => known.has(String(x?.key)))
      .map((x) => ({ key: String(x.key), name: cut(String(x.name ?? "").replace(/[「」『』"“”]/g, ""), 6), desc: cut(x.desc, 40) }))
      .filter((x) => x.name);
    if (!names.length) throw new Error("AI 没给出名字，再试一次");
    return names;
  }

  async function nameGroups({ groups }) {
    if (!Array.isArray(groups) || !groups.length) throw new Error("没有要起名的圈子");
    const { bs_settings } = await chrome.storage.local.get("bs_settings");
    if (!bs_settings?.ai?.baseUrl) throw Object.assign(new Error("还没设置 AI，去「设置」里填好再来"), { code: "NO_AI" });
    const reply = await globalThis.Ai.chat(bs_settings.ai, buildMessages(groups));
    return { names: parse(reply, groups.map((g) => g.key)) };
  }

  const GraphAi = { buildMessages, parse, nameGroups };
  globalThis.GraphAi = GraphAi;
  if (typeof module !== "undefined") module.exports = GraphAi;
})();
