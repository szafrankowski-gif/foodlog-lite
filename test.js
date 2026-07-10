// foodlog-lite 純関数テスト（標準ライブラリのみ。実行: node test.js）
// app.js の pure:begin〜pure:end ブロックを抽出して検証する。ブロックは自己完結が前提。
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const m = src.match(/\/\/ pure:begin([\s\S]*?)\/\/ pure:end/);
if (!m) { console.error("NG: app.jsに pure:begin〜pure:end ブロックが見つかりません"); process.exit(1); }
const pure = new Function(m[1] + `
  return { addDaysKey, timelinePos, litePhase, streakInfo, milestoneFor };
`)();

let fail = 0, count = 0;
function eq(label, got, want) {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  fail++;
  console.error(`NG: ${label}\n  got:  ${g}\n  want: ${w}`);
}
function approx(label, got, want) {
  count++;
  if (got != null && want != null && Math.abs(got - want) < 1e-9) return;
  fail++;
  console.error(`NG: ${label}\n  got:  ${got}\n  want: ${want}`);
}

// ---- addDaysKey：日付キー演算（月またぎ・年またぎ）----
eq("addDaysKey +1", pure.addDaysKey("2026-07-31", 1), "2026-08-01");
eq("addDaysKey -1", pure.addDaysKey("2026-01-01", -1), "2025-12-31");

// ---- timelinePos：5:00〜25:00の座標変換 ----
approx("5:00 → 左端0", pure.timelinePos("5:00"), 0);
approx("15:00 → 中央0.5", pure.timelinePos("15:00"), 0.5);
approx("9:30 → 0.225", pure.timelinePos("9:30"), 4.5 / 20);
approx("1:00 → 25:00相当で右端1", pure.timelinePos("1:00"), 1);   // 深夜(+24h)扱い
approx("0:30 → 24:30相当", pure.timelinePos("0:30"), 19.5 / 20);
approx("4:59 → 25時超はクランプで1", pure.timelinePos("4:59"), 1);
eq("時刻なし(null) → null", pure.timelinePos(null), null);
eq("不正文字列 → null", pure.timelinePos("ゆうがた"), null);
eq("不正分(24:70) → null", pure.timelinePos("24:70"), null);

// ---- litePhase：フェーズ切替（初記録日=1日目、既定8日目で解禁）----
const cfg = { phase2StartDay: 8, phase2Manual: null };
eq("1日目はフェーズ1", pure.litePhase("2026-07-01", "2026-07-01", cfg), 1);
eq("7日目はフェーズ1", pure.litePhase("2026-07-01", "2026-07-07", cfg), 1);
eq("8日目でフェーズ2", pure.litePhase("2026-07-01", "2026-07-08", cfg), 2);
eq("30日目もフェーズ2", pure.litePhase("2026-07-01", "2026-07-30", cfg), 2);
eq("記録がなければフェーズ1", pure.litePhase(null, "2026-07-08", cfg), 1);
eq("手動上書きtrue → 1日目でもフェーズ2", pure.litePhase("2026-07-01", "2026-07-01", { phase2StartDay: 8, phase2Manual: true }), 2);
eq("手動上書きfalse → 30日目でもフェーズ1", pure.litePhase("2026-07-01", "2026-07-30", { phase2StartDay: 8, phase2Manual: false }), 1);

// ---- streakInfo：連続／中断／再開／過去最長 ----
eq("連続3日（今日まで）", pure.streakInfo(["2026-07-08", "2026-07-09", "2026-07-10"], "2026-07-10"), { current: 3, best: 3 });
eq("今日未記録でも昨日までの連続は生きている", pure.streakInfo(["2026-07-08", "2026-07-09"], "2026-07-10"), { current: 2, best: 2 });
eq("一昨日で途切れ → current 0・過去最長は残る", pure.streakInfo(["2026-07-05", "2026-07-06", "2026-07-07"], "2026-07-10"), { current: 0, best: 3 });
eq("再開初日 → current 1・過去最長5", pure.streakInfo(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-10"], "2026-07-10"), { current: 1, best: 5 });
eq("記録ゼロ", pure.streakInfo([], "2026-07-10"), { current: 0, best: 0 });
eq("月またぎの連続", pure.streakInfo(["2026-07-30", "2026-07-31", "2026-08-01"], "2026-08-01"), { current: 3, best: 3 });

// ---- milestoneFor：節目3/7/14/30 ----
eq("連続3日は節目", pure.milestoneFor(3, 5), { type: "連続", days: 3 });
eq("連続が節目でなくても累計7日は節目", pure.milestoneFor(1, 7), { type: "累計", days: 7 });
eq("どちらも節目でなければnull", pure.milestoneFor(4, 6), null);
eq("連続30日", pure.milestoneFor(30, 45), { type: "連続", days: 30 });

if (fail) { console.error(`\n${count}件中 ${fail}件 失敗`); process.exit(1); }
console.log(`OK: 純関数テスト ${count}件 すべて通過`);
