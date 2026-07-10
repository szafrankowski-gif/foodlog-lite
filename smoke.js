// foodlog-lite jsdomスモークテスト（実行: npm i --no-save jsdom && node smoke.js）
// スマホ390px / PC1280px の両方で起動〜描画〜タイムライン操作を確認する。
// 本体foodlogの旧スキーマ（dayType宣言）データを事前投入し、移行と既存データ互換も同時に検証する。
"use strict";
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("jsdomが必要です。実行前に: npm i --no-save jsdom"); process.exit(1); }
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

let fail = 0, count = 0;
function check(label, cond) {
  count++;
  if (cond) return;
  fail++;
  console.error("NG: " + label);
}

function run(width) {
  const dom = new JSDOM(html, { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const wide = width >= 900;
  window.matchMedia = () => ({ matches: wide, addEventListener() {}, removeEventListener() {} });
  window.alert = () => {};
  window.confirm = () => false;
  window.prompt = () => null;
  // 本体foodlog旧スキーマ（dayType宣言・acts無し）のデータを投入 → load()の移行コードを通す
  window.localStorage.setItem("mealoglite:data", JSON.stringify({
    [todayKey]: {
      dayType: "climb",
      foods: [
        { name: "テスト定食", p: 20, f: 12, c: 40, t: "12:30" },
        { name: "のどあめ", p: 0, c: 5 }, // f無しの旧データ互換（F表示は省略される）
      ],
    },
  }));
  window.eval(appSrc);
  const doc = window.document;
  const L = width + "px";

  // タブ：振り返りタブは出ない（記録・設定の2つ）
  const tabs = [...doc.querySelectorAll(".tab")].map((b) => b.textContent);
  check(`${L}: タブは2つ（記録・設定）`, tabs.length === 2 && !tabs.some((t) => t.includes("振り返り")));

  // 非表示フラグの確認：ゲージ・実績トグル・食材ペース・タイル・測定データが出ていない
  check(`${L}: たんぱく質ゲージ非表示`, !doc.querySelector(".gauge"));
  check(`${L}: 実績トグル非表示`, !doc.querySelector(".daytype"));
  check(`${L}: 食材ペース非表示`, !doc.querySelector(".pacebox"));
  check(`${L}: タイル（睡眠・体重・サプリ）非表示`, !doc.querySelector(".tiles"));
  check(`${L}: 本体形式の詳細数値は非表示`, !doc.querySelector(".foodnums small"));
  check(`${L}: 品目行は残る（2件）`, doc.querySelectorAll(".foodrow").length === 2);

  // PFC目安（事実表示）：品目行と達成カードの日計
  const pfcs = [...doc.querySelectorAll(".pfc")].map((e) => e.textContent.trim());
  check(`${L}: 品目行にPFC目安`, pfcs.length === 2 && pfcs[0] === "P20 F12 C40");
  check(`${L}: f無しの旧データはF省略`, pfcs[1] === "P0 C5");
  const pfcLine = doc.querySelector(".litepfc");
  check(`${L}: 日計のPFC目安`, pfcLine && pfcLine.textContent.includes("P 20・F 12・C 45"));

  // タイムライン：時刻あり1件が●、時刻なし1件が⏱なし枠
  check(`${L}: タイムラインの●が1つ`, doc.querySelectorAll(".tldot").length === 1);
  check(`${L}: ⏱なし枠にチップ1つ`, doc.querySelectorAll(".tlnonechip").length === 1);

  // 達成系：記録数は事実のみ・ストリーク表示・ひとことボタン（締めボタンは廃止済み）
  const lite = doc.querySelector(".litecard");
  check(`${L}: 記録数「今日 2件」表示`, lite && lite.textContent.includes("今日 2件 記録できました"));
  check(`${L}: 連続記録の表示`, lite && lite.textContent.includes("連続記録 1日目"));
  const cheerBtn = doc.querySelector("[data-cheer]");
  check(`${L}: 「担当栄養士からひとこと」ボタン`, cheerBtn && cheerBtn.textContent.includes("担当栄養士からひとこと"));
  check(`${L}: 締めボタンは存在しない`, !doc.querySelector("[data-close]"));

  // 入力プレースホルダの文言
  const ta = doc.querySelector(".mealinput");
  check(`${L}: プレースホルダ変更済み`, ta && ta.getAttribute("placeholder").includes("なんでも1枚 or 一言で"));

  // 旧人格が残っていない
  check(`${L}: 「ばかお」文言なし`, !doc.body.innerHTML.includes("ばかお"));

  // ●タップ → 品名ポップ（時刻編集リンク付き）
  doc.querySelector(".tldot").dispatchEvent(new window.Event("click", { bubbles: true }));
  const pop = doc.querySelector(".tlpop");
  check(`${L}: ●タップで品名ポップ`, pop && pop.textContent.includes("テスト定食") && pop.textContent.includes("12:30"));
  check(`${L}: ポップに時刻編集リンク`, !!doc.querySelector("[data-tledit]"));

  // ひとことボタン：APIキー未登録なら案内を出す（クラッシュしない）
  doc.querySelector("[data-cheer]").dispatchEvent(new window.Event("click", { bubbles: true }));
  check(`${L}: キー未登録のひとことは案内表示`, (doc.querySelector(".errmsg") || {}).textContent?.includes("APIキー"));

  // 既存データ互換：移行後もdayType→acts変換・裏の栄養データが温存されている
  const saved = JSON.parse(window.localStorage.getItem("mealoglite:data"));
  check(`${L}: dayType→acts移行`, Array.isArray(saved[todayKey].acts) && saved[todayKey].acts.includes("climb"));
  check(`${L}: 栄養データは裏で温存`, saved[todayKey].foods[0].p === 20 && saved[todayKey].foods[0].c === 40);

  // レイアウト：900px境界
  if (wide) {
    check(`${L}: 振り返り非表示時は1カラム（wide-single）`, !!doc.querySelector(".wide-single") && !doc.querySelector(".wide-grid"));
  } else {
    check(`${L}: モバイルは通常フロー`, !doc.querySelector(".wide-single") && !doc.querySelector(".wide-grid"));
  }
}

run(390);
run(1280);

if (fail) { console.error(`\n${count}件中 ${fail}件 失敗`); process.exit(1); }
console.log(`OK: jsdomスモーク ${count}件 すべて通過（390px / 1280px）`);
