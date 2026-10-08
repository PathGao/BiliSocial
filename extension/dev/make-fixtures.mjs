// Builds BiliSocial/dev-fixtures/storage.json (+ storage.js for dev/index.html), outside the extension folder so a loaded
// extension never carries it, in the DESIGN.md storage shape. Everything is synthetic: fake mids, names, titles and
// avatars, generated from a fixed seed. Nothing is fetched.
// Run: node extension/dev/make-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../dev-fixtures");
const now = Math.floor(Date.now() / 1000);

// Deterministic fake data.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (a) => a[Math.floor(rand() * a.length)];

// Avatar: a colored circle with one character, as an inline SVG data URI.
const face = (ch, hue) =>
  "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 55% 62%)"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#fff" font-family="sans-serif">${ch}</text></svg>`);

// Six fake interest areas. Each has a B站 分区 (name + tid), name parts and title words, so both the social and the
// content side of the graph find clusters.
const THEMES = [
  { zone: "知识", tid: 201, hue: 210, a: ["物理", "数学", "历史", "地理", "冷知识", "科普"], b: ["研究所", "课代表", "小站", "笔记", "实验室"], w: ["为什么", "原理", "公式", "论文", "宇宙", "实验", "古代", "地图", "统计"] },
  { zone: "科技", tid: 95, hue: 190, a: ["数码", "极客", "硬件", "电脑", "手机"], b: ["测评", "研究社", "老张", "工作室", "日记"], w: ["评测", "开箱", "芯片", "续航", "显卡", "拆解", "对比", "性能", "新品"] },
  { zone: "游戏", tid: 17, hue: 280, a: ["游戏", "像素", "通关", "单机", "联机"], b: ["攻略组", "解说", "实况", "玩家", "研究员"], w: ["攻略", "通关", "boss", "隐藏", "剧情", "速通", "新手", "彩蛋", "联机"] },
  { zone: "音乐", tid: 3, hue: 330, a: ["吉他", "钢琴", "编曲", "合唱", "民谣"], b: ["小屋", "练习生", "乐队", "频道", "演奏"], w: ["翻唱", "演奏", "教程", "和弦", "原创", "现场", "伴奏", "改编", "乐理"] },
  { zone: "美食", tid: 211, hue: 25, a: ["家常", "厨房", "烘焙", "深夜", "街头"], b: ["小厨", "食堂", "日记", "探店", "做饭"], w: ["做法", "家常菜", "教程", "探店", "早餐", "面条", "烤箱", "火锅", "甜点"] },
  { zone: "动画", tid: 1, hue: 140, a: ["番剧", "动画", "手书", "二次元", "声优"], b: ["杂谈", "观察室", "放送", "评论", "补番"], w: ["盘点", "新番", "推荐", "名场面", "解析", "神作", "角色", "完结", "补番"] }
];
const ALL_ZONES = THEMES.map((t) => [t.zone, t.tid]);

const people = {};
const themeOf = {};
let nextMid = 10000001;
function person(t, ov = "") {
  const mid = String(nextMid++);
  const name = `${pick(t.a)}${pick(t.b)}${randInt(1, 99)}`;
  people[mid] = { mid, name, face: face(name[0], t.hue + randInt(-15, 15)), sign: `${t.zone}区的测试账号`, ov };
  themeOf[mid] = t;
  return mid;
}

// 240 followings (40 per theme) and 360 second-layer accounts (60 per theme) they follow.
const followings = [];
const layer2 = {};
for (const t of THEMES) {
  layer2[t.zone] = Array.from({ length: 60 }, () => person(t));
  for (let i = 0; i < 40; i++) followings.push(person(t, i % 9 === 0 ? `知名${t.zone}UP主` : ""));
}
followings.sort(() => rand() - 0.5);

// 关注的关注: about half the lists are hidden (code 22115); public ones lean to the account's own theme.
const circle = {};
for (const mid of followings) {
  const t = themeOf[mid];
  if (rand() < 0.45) { circle[mid] = { code: 22115, total: 0, list: [], at: now - 86400 }; continue; }
  const list = new Set();
  const n = randInt(15, 60);
  while (list.size < n) {
    const r = rand();
    const pool = r < 0.75 ? (rand() < 0.5 ? layer2[t.zone] : followings.filter((m) => themeOf[m] === t)) : layer2[pick(THEMES).zone];
    const m = pick(pool);
    if (m !== mid) list.add(m);
  }
  circle[mid] = { code: 0, total: list.size, list: [...list], at: now - 86400 };
}

// 投稿内容: up to 30 fake videos per account, mostly in its own 分区.
const contentMap = {};
for (const mid of [...followings, ...Object.values(layer2).flat()]) {
  const t = themeOf[mid];
  const v = [];
  let c = now - randInt(1, followings.includes(mid) && rand() < 0.2 ? 600 : 60) * 86400;
  for (let i = 0, n = randInt(5, 30); i < n; i++) {
    const [zone, tid] = rand() < 0.85 ? [t.zone, t.tid] : pick(ALL_ZONES);
    v.push({ t: `${pick(t.w)}${pick(t.w)}：${pick(t.w)}的${pick(t.w)}`, tid, zone, c, p: randInt(300, 900000), len: `${randInt(1, 40)}:${String(randInt(0, 59)).padStart(2, "0")}` });
    c -= randInt(2, 30) * 86400;
  }
  const tlist = {};
  for (const x of v) tlist[x.zone] = (tlist[x.zone] || 0) + 1;
  contentMap[mid] = { code: 0, count: v.length + randInt(0, 40), tlist, v: v.map(({ zone, ...x }) => x), at: now - 3600 };
}

// Synthetic fans: fake mids and names; every 5th one is mutual.
const fans = [];
for (let i = 1; i <= 60; i++) {
  const mid = String(9000000000 + i);
  people[mid] = { mid, name: `测试粉丝${String(i).padStart(3, "0")}`, face: "", sign: "", ov: "" };
  fans.push({ mid, followTime: now - i * randInt(3, 20) * 86400, mutual: i % 5 === 0 });
}

// Synthetic interactions: 5 fake videos, 16 fake contacts (the first 8 are fans).
const videos = Array.from({ length: 5 }, (_, i) => ({
  bvid: `BV1fake${i}00000`, aid: String(100000 + i), title: `测试视频 ${i + 1}`, play: randInt(500, 150000), dynId: String(800000000000000000 + i), at: now - (i + 1) * 40 * 86400
}));
const byMid = {};
for (let i = 1; i <= 16; i++) {
  const mid = i <= 8 ? fans[i - 1].mid : String(8000000000 + i);
  if (!people[mid]) people[mid] = { mid, name: `测试用户${i}`, face: "", sign: "", ov: "" };
  const pmCount = i % 3 === 0 ? randInt(2, 80) : 0;
  const first = now - randInt(100, 2000) * 86400;
  const e = {
    pm: pmCount ? { count: pmCount, first, last: now - randInt(1, 90) * 86400 } : { count: 0, first: 0, last: 0 },
    reply: randInt(0, 6), like: randInt(0, 20), atMe: randInt(0, 2), comments: randInt(0, 8), repostComments: i % 4 === 0 ? randInt(0, 2) : 0,
    reposts: i % 4 === 0 ? [{ bvid: videos[i % 5].bvid, dynId: String(900000000000000000 + i), at: now - randInt(1, 300) * 86400 }] : [],
    span: {},
    last: 0
  };
  for (const f of ["reply", "like", "atMe", "comments", "repostComments"]) {
    if (e[f]) { const last = now - randInt(1, 400) * 86400; e.span[f] = { first: last - randInt(0, 300) * 86400, last }; }
  }
  e.last = Math.max(e.pm.last, ...Object.values(e.span).map((x) => x.last), ...e.reposts.map((r) => r.at));
  byMid[mid] = e;
}

// Fake follow times, newest first, spread over ~8 years.
const followTime = {};
let t = now - randInt(1, 5) * 86400;
for (const mid of followings) { followTime[mid] = t; t -= randInt(600, 6 * 86400); }
const finished = { running: false, done: 1, total: 1, step: "", startedAt: now - 7200, finishedAt: now - 3600, lastFinishedAt: now - 3600, error: null, throttled: false, cursor: null };
const storage = {
  bs_me: { mid: "10000000", name: "开发用账号", face: face("我", 340), sign: "", following: followings.length, follower: fans.length, at: now - 3600 },
  bs_people: people,
  // Every 40th following is in 特别关注.
  bs_followings: { at: now - 3600, list: followings, followTime, special: Object.fromEntries(followings.filter((_, i) => i % 40 === 3).map((m) => [m, 1])), groups: {} },
  // Three fake fans who stopped following (names kept in bs_people).
  bs_fans: { at: now - 3600, list: fans, lost: [1, 2, 3].map((i) => {
    const mid = String(9100000000 + i);
    people[mid] = { mid, name: `测试取关${i}`, face: "", sign: "", ov: "" };
    return { mid, at: now - i * 5 * 86400, followTime: now - i * 200 * 86400 };
  }) },
  bs_circle: circle,
  bs_content: contentMap,
  bs_interactions: { at: now - 3600, videos, byMid },
  bs_up_tags: [],
  bs_up_tag_map: {},
  // Four fake unfollows: two on B站 (found by a sync), two from this app; one account closed (gone, old name kept).
  bs_unfollowed: Object.fromEntries([1, 2, 3, 4].map((i) => {
    const mid = String(9200000000 + i);
    people[mid] = { mid, name: `测试已取关${i}`, face: "", sign: "", ov: "", ...(i === 4 ? { gone: true } : {}) };
    return [mid, { at: now - i * 3 * 86400, tagIds: [], source: i % 2 ? "bili" : "app" }];
  })),
  bs_settings: { ai: { baseUrl: "", apiKey: "", model: "" }, alpha: 0.5, slowDays: 90, deadDays: 365, pushMinutes: 15 },
  bs_jobs: {
    mine: { ...finished, done: followings.length, total: followings.length },
    circle: { ...finished, done: Object.keys(circle).length, total: followings.length },
    content: { ...finished, done: Object.keys(contentMap).length, total: Object.keys(contentMap).length }
  }
};
addMeStory(storage);

// [me agent] Two synthetic stand-ins for #me (fake names): a big UP who reposted the most-played video and commented,
// and a private-message partner. Plus bs_stats follower counts for everyone in bs_interactions.
function addMeStory(s) {
  const { byMid, videos } = s.bs_interactions;
  const top = videos.reduce((a, v) => (v.play > a.play ? v : a));
  const blank = { pm: { count: 0, first: 0, last: 0 }, reply: 0, like: 0, atMe: 0, comments: 0, repostComments: 0, reposts: [], span: {}, last: 0 };
  const add = (mid, name, e) => { s.bs_people[mid] = { mid, name, face: "", sign: "", ov: "" }; byMid[mid] = { ...blank, ...e }; };
  const repostAt = now - 400 * 86400;
  add("8100000001", "测试大UP", { comments: 3, repostComments: 2, span: { comments: { first: repostAt - 5 * 86400, last: repostAt }, repostComments: { first: repostAt, last: repostAt + 86400 } }, reposts: [{ bvid: top.bvid, dynId: "900000000000000101", at: repostAt }], last: repostAt + 86400 });
  add("8100000002", "测试私信好友", { pm: { count: 107, first: now - 43 * 86400, last: now - 2 * 86400 }, comments: 1, like: 1, span: { comments: { first: now - 30 * 86400, last: now - 30 * 86400 }, like: { first: now - 2 * 86400, last: now - 2 * 86400 } }, last: now - 2 * 86400 });
  s.bs_stats = {};
  for (const mid of Object.keys(byMid)) s.bs_stats[mid] = { follower: randInt(10, 5000), at: now - 3600 };
  s.bs_stats["8100000001"] = { follower: 4200000, at: now - 3600 };
}

// Fans, contacts and unfollowed accounts above have no avatar yet.
for (const p of Object.values(storage.bs_people)) if (!p.face) p.face = face(pick([..."云山木星风月林川夏秋"]), randInt(0, 359));

fs.mkdirSync(OUT, { recursive: true });
const json = JSON.stringify(storage);
fs.writeFileSync(path.join(OUT, "storage.json"), json);
fs.writeFileSync(path.join(OUT, "storage.js"), `window.BS_FIXTURES = ${json};\n`);
console.log(`fixtures: ${followings.length} followings, ${Object.keys(circle).length} circle, ${Object.keys(contentMap).length} content, ${Object.keys(people).length} people → ${OUT}`);
