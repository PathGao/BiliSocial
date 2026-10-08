// Similarity, kNN links and clusters for the 关系图 (port of an earlier prototype, build.js). Pure functions, no DOM.
// Defines globalThis.BSGraph; also module.exports under node.
//   BSGraph.compute(storage, { alpha }) -> { stats, ids, nodes, edges, groups, sim(i, j) }
//   BSGraph.labelAgreement(storage, alpha) -> { pct, hit, tot, labelled } (share of top-3 neighbours with the same 「知名X UP主」 label)
// `storage` holds the DESIGN.md keys bs_followings, bs_circle, bs_content, bs_people, bs_me.
(() => {
  // B站 auto-follows its own service accounts for creators, so they say nothing about taste.
  // ponytail: name pattern for official accounts; extend the list if new ones show up big
  const OFFICIAL = /哔哩哔哩|bilibili|小助手|发电机|招财喵|激大励|小电视|创作中心|好好生活安利社/i;
  const K = 6; // kNN links per node
  const NEAR = 40; // neighbours kept per node (detail list + ego view)

  // The alpha-independent part (two N×N similarity matrices) is cached per storage object, so the alpha slider is cheap.
  const cache = new WeakMap();

  function prepare(st) {
    if (cache.has(st)) return cache.get(st);
    const people = st.bs_people || {};
    const circle = st.bs_circle || {};
    const content = st.bs_content || {};
    const myMid = String(st.bs_me?.mid ?? "");
    const L1 = (st.bs_followings?.list || []).map(String);
    const L1set = new Set(L1);
    const out = new Map(); // crawled L1 mid -> Set of followee mids
    let hidden = 0;
    for (const mid of L1) {
      const d = circle[mid];
      if (d && d.code === 0) out.set(mid, new Set((d.list || []).map(String)));
      else if (d) hidden++;
    }

    const inCount = new Map();
    for (const s of out.values()) for (const v of s) inCount.set(v, (inCount.get(v) || 0) + 1);
    const isOfficial = (v) => OFFICIAL.test(people[v]?.name || "");
    // Accounts followed by more than 10% of the crawled lists are stopwords for similarity
    const STOP = new Set([...inCount].filter(([v, c]) => c > out.size * 0.1 || isOfficial(v)).map(([v]) => v));
    // ponytail: fixed cut for second-layer nodes (followed by ≥5 of yours, top 400); tune if the map is too sparse or crowded
    const L2 = [...inCount.entries()]
      .filter(([v, c]) => !L1set.has(v) && v !== myMid && c >= 5 && !isOfficial(v))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 400)
      .map(([v]) => v);

    const ids = [...L1, ...L2];
    const N = ids.length;
    const idx = new Map(ids.map((m, i) => [m, i]));

    // Shared-feature similarity (co-citation + bibliographic coupling), each feature weighted 1/log(2+degree)
    const soc = new Float32Array(N * N); // co-occurrence weights, turned into scaled social similarity below
    const self = new Float32Array(N);
    function addFeature(members) {
      if (members.length < 1) return;
      const w = 1 / Math.log(2 + members.length);
      for (const i of members) self[i] += w;
      for (let a = 0; a < members.length; a++)
        for (let b = a + 1; b < members.length; b++) {
          const i = members[a], j = members[b];
          soc[i * N + j] += w;
          soc[j * N + i] += w;
        }
    }
    for (const s of out.values()) addFeature([...s].filter((v) => !STOP.has(v)).map((v) => idx.get(v)).filter((i) => i !== undefined));
    const followersOf = new Map();
    for (const [u, s] of out) {
      const i = idx.get(u);
      for (const v of s) {
        if (!followersOf.has(v)) followersOf.set(v, []);
        followersOf.get(v).push(i);
      }
    }
    for (const [v, m] of followersOf) if (m.length >= 2 && !STOP.has(v)) addFeature(m);

    const hasSoc = new Uint8Array(N);
    for (let i = 0; i < N; i++) hasSoc[i] = self[i] > 0 ? 1 : 0;
    const isDirect = (a, b) => out.get(ids[a])?.has(ids[b]) || false;
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++) {
        let s = 0;
        if (hasSoc[i] && hasSoc[j]) {
          s = soc[i * N + j] / Math.sqrt(self[i] * self[j]);
          if (isDirect(i, j)) s += 0.1;
          if (isDirect(j, i)) s += 0.1;
        }
        soc[i * N + j] = soc[j * N + i] = s;
      }
    // Rescale so the 99th percentile (of a 1-in-7 sample) is 1, comparable with cosine content similarity
    const sample = [];
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j += 7) { const v = soc[i * N + j]; if (v > 0) sample.push(v); }
    sample.sort((a, b) => a - b);
    const scale = sample[Math.floor(sample.length * 0.99)] || 1;
    for (let k = 0; k < N * N; k++) if (soc[k]) soc[k] = Math.min(1, soc[k] / scale);

    // Content: sub-zone (typeid) counts of the last 30 videos, and title character bigrams (TF-IDF)
    const vids = ids.map((m) => (content[m]?.code === 0 ? content[m].v : null));
    const tidVec = vids.map((v) => (v && v.length ? unit(v.reduce((m, x) => m.set(x.tid, (m.get(x.tid) || 0) + 1), new Map())) : null));
    const tf = vids.map((v) => {
      if (!v || !v.length) return null;
      const m = new Map();
      for (const x of v) for (const g of new Set(grams(x.t))) m.set(g, (m.get(g) || 0) + 1);
      return m;
    });
    const df = new Map();
    for (const m of tf) if (m) for (const g of m.keys()) df.set(g, (df.get(g) || 0) + 1);
    const docs = tf.filter(Boolean).length;
    const titleVec = tf.map((m) => {
      if (!m) return null;
      const v = new Map();
      for (const [g, c] of m) {
        const d = df.get(g);
        if (d < 2 || d > docs * 0.2) continue;
        v.set(g, (1 + Math.log(c)) * Math.log(docs / d));
      }
      return v.size ? unit(v) : null;
    });
    const hasCon = new Uint8Array(N);
    for (let i = 0; i < N; i++) hasCon[i] = tidVec[i] || titleVec[i] ? 1 : 0;
    // 0.4 × tid cosine + 0.6 × title cosine, summed feature by feature through an inverted index (pairwise Map cosines took ~2.5 s)
    const con = new Float32Array(N * N);
    function addDots(vecs, weight) {
      const posting = new Map();
      vecs.forEach((v, i) => { if (v) for (const [k, x] of v) { if (!posting.has(k)) posting.set(k, []); posting.get(k).push(i, x); } });
      for (const p of posting.values())
        for (let a = 0; a < p.length; a += 2)
          for (let b = a + 2; b < p.length; b += 2) con[p[a] * N + p[b]] += weight * p[a + 1] * p[b + 1];
    }
    addDots(tidVec, 0.4);
    addDots(titleVec, 0.6);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) con[j * N + i] = con[i * N + j];

    const P = { st, ids, N, L1len: L1.length, out, hidden, inCount, stop: STOP.size, soc, con, hasSoc, hasCon };
    cache.set(st, P);
    return P;
  }

  function unit(vec) {
    let n = 0;
    for (const v of vec.values()) n += v * v;
    n = Math.sqrt(n);
    if (n) for (const [k, v] of vec) vec.set(k, v / n);
    return vec;
  }
  function grams(title) {
    const t = String(title).toLowerCase().replace(/[【】\[\]()（）「」『』《》<>|｜!！?？,，.。:：;；~～·…\-—_#@"“”'‘’\/\s\d]+/g, " ");
    const out = [];
    for (const part of t.split(" ")) {
      if (!part) continue;
      if (/^[a-z]+$/.test(part)) { if (part.length > 2) out.push(part); continue; }
      for (let i = 0; i + 1 < part.length; i++) out.push(part.slice(i, i + 2));
    }
    return out;
  }

  // Mixed similarity; when one side lacks a signal the other carries the whole weight
  function simWith(P, alpha) {
    const { N, soc, con, hasSoc, hasCon } = P;
    return (i, j) => {
      const ws = hasSoc[i] && hasSoc[j] ? alpha : 0, wc = hasCon[i] && hasCon[j] ? 1 - alpha : 0;
      if (!ws && !wc) return 0;
      const k = i * N + j;
      return (ws * soc[k] + wc * con[k]) / (ws + wc);
    };
  }

  function compute(st, { alpha = 0.5 } = {}) {
    const P = prepare(st);
    const { ids, N, L1len, out, inCount } = P;
    const people = st.bs_people || {}, content = st.bs_content || {}, circle = st.bs_circle || {};
    const idx = new Map(ids.map((m, i) => [m, i]));
    const sim = simWith(P, alpha);

    // k nearest neighbours as layout links
    const edgeMap = new Map();
    const nearest = [];
    const row = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const cand = [];
      for (let j = 0; j < N; j++) if (j !== i) { const s = (row[j] = sim(i, j)); if (s > 0.03) cand.push(j); }
      cand.sort((a, b) => row[b] - row[a]);
      nearest.push(cand.slice(0, NEAR).map((j) => [j, +row[j].toFixed(3)]));
      for (const j of cand.slice(0, K)) {
        const key = i < j ? i * N + j : j * N + i;
        edgeMap.set(key, Math.max(edgeMap.get(key) || 0, row[j]));
      }
    }
    const edges = [...edgeMap].map(([k, s]) => [Math.floor(k / N), k % N, +s.toFixed(3)]);

    // Weighted label propagation on the kNN graph
    const adj = Array.from({ length: N }, () => []);
    for (const [a, b, s] of edges) { adj[a].push([b, s]); adj[b].push([a, s]); }
    const label = ids.map((_, i) => i);
    for (let it = 0; it < 30; it++) {
      let changed = 0;
      for (let i = 0; i < N; i++) {
        if (!adj[i].length) continue;
        const score = new Map();
        for (const [j, s] of adj[i]) score.set(label[j], (score.get(label[j]) || 0) + s);
        let best = label[i], bs = -1;
        for (const [l, s] of score) if (s > bs || (s === bs && l < best)) { best = l; bs = s; }
        if (best !== label[i]) { label[i] = best; changed++; }
      }
      if (!changed) break;
    }
    const groupSize = new Map();
    for (const l of label) groupSize.set(l, (groupSize.get(l) || 0) + 1);
    const groupsSorted = [...groupSize].filter(([, n]) => n >= 12).sort((a, b) => b[1] - a[1]).map(([l]) => l);
    const groupId = new Map(groupsSorted.map((l, k) => [l, k]));

    const nodes = ids.map((m, i) => {
      const p = people[m] || {};
      const c = content[m]?.code === 0 ? content[m] : null;
      return {
        mid: m,
        name: p.name || m,
        face: p.face || "",
        sign: p.sign || "",
        ov: p.ov || "",
        l2: i >= L1len ? 1 : 0,
        hidden: i < L1len && !out.has(m) && !!circle[m] ? 1 : 0,
        deg: inCount.get(m) || 0,
        g: groupId.has(label[i]) ? groupId.get(label[i]) : -1,
        outIn: out.has(m) ? [...out.get(m)].map((v) => idx.get(v)).filter((j) => j !== undefined) : [],
        near: nearest[i],
        zones: c ? Object.entries(c.tlist || {}).sort((a, b) => b[1] - a[1]).slice(0, 3) : [],
        vcount: c ? c.count ?? null : null,
        last: c?.v?.[0]?.c ?? null
      };
    });
    const groups = groupsSorted.map((l, k) => {
      const members = nodes.filter((n) => n.g === k).sort((a, b) => b.deg - a.deg);
      const z = new Map();
      for (const n of members) for (const [name, c] of n.zones) z.set(name, (z.get(name) || 0) + c / (n.vcount || 1));
      const zones = [...z].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
      const mids = members.slice(0, 15).map((n) => n.mid);
      return { id: k, size: members.length, top: members.slice(0, 4).map((n) => n.name), zones, mids, key: groupKey(mids) };
    });

    const stats = {
      l1: L1len, crawled: out.size, hidden: P.hidden, l2: N - L1len, edges: edges.length,
      content: P.hasCon.reduce((a, b) => a + b, 0), stop: P.stop, alpha
    };
    return { stats, ids, nodes, edges, groups, sim };
  }

  // Share of each labelled node's top-3 neighbours (among labelled nodes) with the same 「知名X UP主」 category.
  function labelAgreement(st, alpha) {
    const P = prepare(st);
    const sim = simWith(P, alpha);
    const people = st.bs_people || {};
    const cat = P.ids.map((m) => (people[m]?.ov || "").match(/知名(.{1,4}?)UP主/)?.[1] || null);
    const lab = P.ids.map((_, i) => i).filter((i) => cat[i]);
    let hit = 0, tot = 0;
    for (const i of lab) {
      const r = lab.filter((j) => j !== i).map((j) => [j, sim(i, j)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [j] of r) { tot++; if (cat[j] === cat[i]) hit++; }
    }
    return { pct: tot ? (100 * hit) / tot : 0, hit, tot, labelled: lab.length };
  }

  // 「可能想关注」: accounts I don't follow (L2), score = deg / max deg × mean of top-5 similarity to my followings × activity.
  // Accounts in `unfollowed` (bs_unfollowed) sink to the bottom with unfollowed: true. Official accounts are already out of L2.
  function recommend(res, { now = Date.now() / 1000, slowDays = 90, deadDays = 365, unfollowed = {}, groupLabel = null } = {}) {
    const { nodes, groups, sim } = res;
    const L1 = nodes.map((n, i) => i).filter((i) => !nodes[i].l2);
    const l2 = nodes.map((n, i) => i).filter((i) => nodes[i].l2 && !OFFICIAL.test(nodes[i].name));
    const maxDeg = Math.max(1, ...l2.map((i) => nodes[i].deg));
    const rows = l2.map((i) => {
      const n = nodes[i];
      const top = L1.map((j) => sim(i, j)).sort((a, b) => b - a).slice(0, 5);
      const meanSim = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
      const age = n.last ? (now - n.last) / 86400 : null;
      const act = age == null ? 0.8 : age <= slowDays ? 1 : age <= deadDays ? 0.6 : 0.3;
      const g = groups[n.g];
      const circle = g ? groupLabel?.(g) || (g.zones.length ? g.zones.join("·") : g.top[0]) : null;
      const reason = [
        `你关注的人里 ${n.deg} 人关注 TA`,
        circle ? `和『${circle}』圈最像` : null,
        n.last ? `${ago(now - n.last)}更新` : null
      ].filter(Boolean).join(" · ");
      return { i, mid: n.mid, score: (n.deg / maxDeg) * meanSim * act, meanSim, act, unfollowed: !!unfollowed[n.mid], reason };
    });
    return rows.sort((a, b) => a.unfollowed - b.unfollowed || b.score - a.score);
  }
  function ago(sec) {
    const d = Math.floor(sec / 86400);
    return d < 1 ? "今天" : d < 30 ? `${d} 天前` : d < 365 ? `${Math.floor(d / 30)} 个月前` : `${Math.floor(d / 365)} 年前`;
  }

  // A crawl counts as complete once it finished, or once every target is stored (circle/content skip stored accounts,
  // so a re-run after a finish starts at done = total). Paused / half-run jobs are not complete: no partial map (P8).
  // `lastFinishedAt` is honoured if core keeps it across re-runs (start() clears finishedAt).
  function jobReady(j) {
    return !!(j && (j.finishedAt || j.lastFinishedAt || (j.total > 0 && j.done >= j.total)));
  }

  // 圈子 names (bs_group_names: { [key]: { name, desc, mids, by, at } }). key = the 5 most-followed members, sorted.
  // Clusters shift a little on every recompute, so a stored name also matches a group sharing more than half of its
  // top-15 members. Groups are disjoint, so one stored name can match at most one group.
  const groupKey = (mids) => [...mids.slice(0, 5)].sort().join(",");
  function groupName(g, store) {
    if (store?.[g.key]) return store[g.key];
    let best = null, bo = 0.5;
    for (const e of Object.values(store || {})) {
      const have = new Set(e.mids || []);
      const o = g.mids.filter((m) => have.has(m)).length / Math.max(g.mids.length, have.size, 1);
      if (o > bo) { best = e; bo = o; }
    }
    return best;
  }

  const BSGraph = { compute, labelAgreement, recommend, grams, jobReady, groupKey, groupName };
  globalThis.BSGraph = BSGraph;
  if (typeof module !== "undefined") module.exports = BSGraph;
})();
