// Run: /usr/local/bin/node extension/lib/me.selftest.js
const assert = require("node:assert/strict");
require("./me.js");
const { rankHelpers, rankInteractions, interactionScore, decay, statCandidates, firstContact } = globalThis.Me;

const DAY = 86400;
const now = 1_800_000_000;
const blank = () => ({ pm: { count: 0, first: 0, last: 0 }, reply: 0, like: 0, atMe: 0, comments: 0, repostComments: 0, reposts: [], span: {}, last: 0 });
const inter = {
  videos: [{ bvid: "BVbig", play: 125000 }, { bvid: "BVsmall", play: 900 }],
  byMid: {
    bigup: { ...blank(), comments: 3, repostComments: 2, span: { comments: { first: now - 420 * DAY, last: now - 400 * DAY } }, reposts: [{ bvid: "BVbig", dynId: "d1", at: now - 400 * DAY }], last: now - 400 * DAY },
    small1: { ...blank(), comments: 12, like: 30, last: now - 5 * DAY },
    small2: { ...blank(), comments: 9, reply: 4, last: now - 10 * DAY },
    smallrepost: { ...blank(), reposts: [{ bvid: "BVsmall", dynId: "d2", at: now - 3 * DAY }], last: now - 3 * DAY },
    pmpal: { ...blank(), pm: { count: 107, first: now - 40 * DAY, last: now - 2 * DAY }, comments: 1, like: 1, last: now - 2 * DAY },
    liker: { ...blank(), like: 3, last: now - 50 * DAY },
    ghost: blank()
  }
};
const stats = { bigup: { follower: 3_000_000 }, small1: { follower: 200 }, small2: { follower: 50 }, smallrepost: { follower: 5000 } };

// 助力: a big reposter outranks frequent small commenters; only reposters/commenters count.
const helpers = rankHelpers(inter, stats);
assert.equal(helpers[0].mid, "bigup");
assert.ok(!helpers.some((h) => h.mid === "liker" || h.mid === "ghost"));
// Sorted by follower count, most first; likes alone never count.
const order = helpers.map((h) => h.mid);
assert.ok(order.indexOf("smallrepost") < order.indexOf("small1") && order.indexOf("small1") < order.indexOf("small2"), order.join(","));
const partial = rankHelpers(inter, { small2: { follower: 50 } });
assert.equal(partial[0].mid, "small2", "known follower counts sort above unknown ones");
// Three 助力 kinds: likers only show under 点赞, reposters under 转发.
assert.ok(rankHelpers(inter, stats, "like").some((h) => h.mid === "liker"));
assert.ok(!rankHelpers(inter, stats, "repost").some((h) => h.mid === "small1"));
assert.equal(rankHelpers(inter, stats, "repost")[0].mid, "bigup");
assert.ok(statCandidates(inter, {}, Infinity, "like").includes("liker"));
// Missing follower counts: still ranked, by reposts then comments, no NaN.
const noStats = rankHelpers(inter, {});
assert.ok(noStats.every((h) => Number.isFinite(h.score)));
assert.equal(noStats[0].mid, "bigup"); // 1 repost (10) + 5 comments beats 12 comments

// Stat candidates: reposters first.
assert.deepEqual(statCandidates(inter, {}, 2).sort(), ["bigup", "smallrepost"]);

// 常互动: the PM partner tops the list; empty entries drop out.
const ranked = rankInteractions(inter, now);
assert.equal(ranked[0].mid, "pmpal");
assert.ok(!ranked.some((x) => x.mid === "ghost"));

// Recency decay: same counts, older contact scores lower; half the weight gone after a year; floor 0.2.
const e = { ...blank(), comments: 10 };
assert.ok(interactionScore({ ...e, last: now - DAY }, now) > interactionScore({ ...e, last: now - 400 * DAY }, now));
assert.ok(Math.abs(decay(now - 365 * DAY, now) - 0.6) < 1e-9);
assert.ok(decay(now - 100 * 365 * DAY, now) >= 0.2);
assert.equal(decay(0, now), 0.2);

// Missing data: empty or partial inputs do not throw.
assert.deepEqual(rankHelpers(undefined), []);
assert.deepEqual(rankInteractions({}, now), []);
assert.equal(interactionScore({}, now), 0);
assert.equal(firstContact(inter.byMid.pmpal), now - 40 * DAY);
assert.equal(firstContact(inter.byMid.liker), 0);
// span dates count as contact; repostComments weigh like comments in both scores.
assert.equal(firstContact(inter.byMid.bigup), now - 420 * DAY);
const c = { ...blank(), comments: 2, last: now };
const rc = { ...blank(), repostComments: 2, last: now };
assert.equal(interactionScore(c, now), interactionScore(rc, now));
assert.equal(rankHelpers({ videos: [], byMid: { rc } })[0]?.mid, "rc");

// Sync gaps follow the job's phase; a finished job or no job record means complete.
const { syncGaps } = globalThis.Me;
assert.deepEqual(syncGaps(undefined), { help: false, like: false, pm: false });
assert.deepEqual(syncGaps({ finishedAt: 1, cursor: null }), { help: false, like: false, pm: false });
assert.deepEqual(syncGaps({ running: true, cursor: null }), { help: true, like: true, pm: true });
assert.deepEqual(syncGaps({ running: true, cursor: { phase: "scan" } }), { help: true, like: true, pm: true });
assert.deepEqual(syncGaps({ running: true, cursor: { phase: "feeds" } }), { help: false, like: true, pm: true });
assert.deepEqual(syncGaps({ running: false, cursor: { phase: "pm" } }), { help: false, like: false, pm: true });
assert.deepEqual(syncGaps({ running: true, startedAt: 100, cursor: null }, 50), { help: false, like: false, pm: false }, "re-sync shows the last full result");
assert.deepEqual(syncGaps({ running: true, startedAt: 100, cursor: { phase: "scan" } }, 150), { help: true, like: true, pm: true });

console.log("me.selftest: ok");
