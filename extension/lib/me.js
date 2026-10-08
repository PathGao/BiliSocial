// 我的位置: scoring for 助力 and 常互动 (pure, also runs under node), plus the background `bs-stat` handler.
// Defines globalThis.Me. Times are unix seconds; `now` is passed in so tests are deterministic.
(() => {
  const DAY = 86400;
  const STAT_TTL = 7 * DAY;

  // A video's play count as a share of my most-played video (0..1).
  function playShares(videos) {
    const max = Math.max(1, ...(videos || []).map((v) => Number(v.play) || 0));
    const out = {};
    for (const v of videos || []) out[v.bvid] = (Number(v.play) || 0) / max;
    return out;
  }

  // Comments under my videos plus comments under reposts of my videos.
  const helpComments = (e) => (e.comments || 0) + (e.repostComments || 0);

  // 助力 = follower × play share × 3 if they reposted, + 10 per repost + 1 per comment (so unknown fans still sort).
  // Comments carry no video in bs_interactions, so a comment-only helper gets a flat 0.2 share.
  function helpScore(e, shares, follower) {
    const reposts = e.reposts || [];
    const share = reposts.length ? Math.max(...reposts.map((r) => shares[r.bvid] || 0)) : 0.2;
    return (Number(follower) || 0) * share * (reposts.length ? 3 : 1) + reposts.length * 10 + helpComments(e);
  }

  // 助力 comes in three kinds: 转发 (reposted my video), 评论 (under my videos or under reposts of them), 点赞 (liked my
  // videos or comments). "all" = repost or comment. Coins and favorites can't be attributed: B站 only gives counts.
  const KIND = {
    all: (e) => (e.reposts || []).length || helpComments(e),
    repost: (e) => (e.reposts || []).length,
    comment: (e) => helpComments(e),
    like: (e) => e.like || 0
  };

  // Most followers first; unknown follower counts sink to the bottom, ordered by the kind's own count.
  function rankHelpers(inter, stats = {}, kind = "all") {
    const shares = playShares(inter?.videos);
    const n = KIND[kind] || KIND.all;
    return Object.entries(inter?.byMid || {})
      .filter(([, e]) => n(e))
      .map(([mid, e]) => {
        const follower = stats[mid]?.follower;
        return { mid, e, follower, score: helpScore(e, shares, follower) };
      })
      .sort((a, b) =>
        (b.follower != null) - (a.follower != null) ||
        (b.follower || 0) - (a.follower || 0) ||
        (b.e.reposts || []).length - (a.e.reposts || []).length ||
        n(b.e) - n(a.e));
  }

  // Everyone of that kind who needs a follower count: reposters first, then verified accounts, then by count.
  function statCandidates(inter, people = {}, n = Infinity, kind = "all") {
    const k = KIND[kind] || KIND.all;
    return Object.entries(inter?.byMid || {})
      .filter(([, e]) => k(e))
      .map(([mid, e]) => [mid, (e.reposts || []).length * 1000 + (people[mid]?.ov ? 500 : 0) + k(e)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([mid]) => mid);
  }

  // Half the weight is gone after a year without contact; never below 0.2 so old friends stay visible.
  const decay = (last, now) => (last ? 0.2 + 0.8 * Math.pow(0.5, Math.max(0, now - last) / (365 * DAY)) : 0.2);

  // 互动 = (私信 ×1 + 评论 ×2 (my videos and reposts) + 回复 ×2 + 赞 ×0.5 + @ ×3 + 转发 ×5) × decay(last contact).
  function interactionScore(e, now) {
    const raw = (e.pm?.count || 0) + helpComments(e) * 2 + (e.reply || 0) * 2 + (e.like || 0) * 0.5 + (e.atMe || 0) * 3 + (e.reposts || []).length * 5;
    return raw * decay(e.last, now);
  }

  function rankInteractions(inter, now) {
    return Object.entries(inter?.byMid || {})
      .map(([mid, e]) => ({ mid, e, score: interactionScore(e, now) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  // Earliest known contact across PM, reposts and every counted kind in span.
  function firstContact(e) {
    const ts = [e.pm?.first, ...(e.reposts || []).map((r) => r.at), ...Object.values(e.span || {}).map((x) => x.first)].filter(Boolean);
    return ts.length ? Math.min(...ts) : 0;
  }

  // Which parts of bs_interactions are still incomplete, from the interactions job's phase cursor.
  // Job order: videos -> scan (转发, 评论) -> feeds (点赞, 回复, @) -> sessions -> pm (私信). No job record = old complete data,
  // and so is data saved before this run started (a re-sync keeps the last result until it finishes).
  const PHASES = ["videos", "scan", "feeds", "sessions", "pm"];
  function syncGaps(job, dataAt = 0) {
    if (!job || job.finishedAt || (dataAt && job.startedAt && dataAt < job.startedAt)) return { help: false, like: false, pm: false };
    const i = PHASES.indexOf(job.cursor?.phase); // -1: no unit saved yet in this run
    return { help: i < 2, like: i < 3, pm: true };
  }

  // Background: { mids } -> { [mid]: follower }; cached 7 days in bs_stats, saved one by one so the page fills in live.
  async function stat(mids) {
    const nowS = Math.floor(Date.now() / 1000);
    const cache = await Store.get("bs_stats", {});
    const out = {};
    for (const mid of [...new Set((mids || []).map(String))].slice(0, 50)) {
      const c = cache[mid];
      if (c && nowS - c.at < STAT_TTL) { out[mid] = c.follower; continue; }
      try {
        const s = await Bili.relationStat(mid);
        await Store.patch("bs_stats", { [mid]: { follower: s.follower, at: nowS } });
        out[mid] = s.follower;
      } catch (e) {
        if (typeof e.code !== "number") throw e; // THROTTLED / NOT_LOGGED_IN stop the batch; a gone account is skipped
      }
    }
    return out;
  }

  globalThis.Me = { playShares, helpScore, rankHelpers, statCandidates, decay, interactionScore, rankInteractions, firstContact, syncGaps, stat };
})();
