/* foodlog v2 — 食事ログPWA（実績ベース判定・歩数参考表示）｜更新: 2026-07-09 */
"use strict";

const FLOOR = 100, CEILING = 120;
const CARB_LIMIT = { rest: 250, active: 330 }; // 61kg・高活動量での維持ライン。血糖対策は量でなく質とタイミングで
const DATA_KEY = "mealog:data";
const API_KEY_KEY = "mealog:apikey";
const GH_TOKEN_KEY = "mealog:ghtoken";
const GIST_ID_KEY = "mealog:gistid";
const LAST_SYNC_KEY = "mealog:lastsync";
const GIST_FILE = "foodlog-data.json";
// 用途別モデル（コストと質のバランス。変えたい時はここを編集）
const MODEL_ESTIMATE = "claude-haiku-4-5-20251001"; // テキスト概算：軽量・高速・低コスト
const MODEL_PHOTO    = "claude-sonnet-4-6";          // 写真解析：認識精度重視
const MODEL_BAKAO    = "claude-sonnet-4-6";          // ばかお評価：文章の質重視
const MODEL_TEST     = MODEL_ESTIMATE;               // キー保存時のテスト用（最安）

const DAY_LABEL = { rest: "休養", trainA: "筋トレA", trainB: "筋トレB", climb: "登攀", jiujitsu: "柔術", mountain: "山行", aerobic: "有酸素" };
const DAY_SHORT = { trainA: "筋A", trainB: "筋B", climb: "登", jiujitsu: "柔", mountain: "山", aerobic: "有" };

// ---- v2: 実績ベース判定 ----
// dayTypeの「宣言」を廃止。その日の実績（筋トレチェック・登攀・柔術・山行）から運動日/休養日を自動判定する。
// 筋トレ(A/B)は「1種目以上チェック」で初めて実績＝運動日。登攀・柔術・山行はトグル自体が実績。
// 歩数は参考表示のみ（目標や警告に使わない）。休養日で15,000歩超の日だけ一行提案を出す（目標値は変えない）。
const ACTS = ["trainA", "trainB", "climb", "jiujitsu", "mountain", "aerobic"];
const STEP_NOTE_MIN = 15000;
const dayActs = (dd) => (dd && dd.acts) || [];
const checkedCount = (dd) => ((((dd || {}).workout) || {}).checks || []).length;
// トグル自体が実績となる身体活動（＝運動日・翌朝の手首チェック対象）：登攀・柔術・山行
const isPhysicalAct = (a) => a === "climb" || a === "jiujitsu" || a === "mountain";
// 有酸素(aerobic)は設計上、運動日判定に影響しない（糖質レバーに触らない純粋な実績記録）
const isActiveDay = (dd) =>
  dayActs(dd).some(isPhysicalAct) ||
  (dayActs(dd).some((a) => a === "trainA" || a === "trainB") && checkedCount(dd) > 0);
// 今週（月曜始まり）の有酸素実施回数
function weeklyAerobic(anchorKey) {
  const w = weekInfo(anchorKey);
  let n = 0;
  for (let i = 0; i < w.dayN; i++) {
    const dd = data[toKey(new Date(w.start.getFullYear(), w.start.getMonth(), w.start.getDate() + i))];
    if (dayActs(dd).includes("aerobic")) n++;
  }
  return n;
}
const actLabel = (dd) => dayActs(dd).length ? dayActs(dd).map((a) => DAY_LABEL[a]).join("+") : "休養";
const actShort = (dd) => dayActs(dd).map((a) => DAY_SHORT[a] || "").join("");
// 翌朝の手首チェックを出す前日の実績：筋トレ(MENUあり=trainA/B)に加え、登攀・柔術・山行も対象
const wristTrig = (dd) => dayActs(dd).some((a) => MENU[a] || isPhysicalAct(a));

// ---- サプリ確認（優先度高：クレアチン・ビタミンD）----
// クレアチンは食事記録に「クレアチン」が含まれていれば自動でチェック扱い。タイルのタップで手動上書き可。
const hasCreatineFood = (dd) => (((dd || {}).foods) || []).some((f) => /クレアチン/.test(f.name || ""));
const creatineOn = (dd) => (dd && dd.creatine != null) ? !!dd.creatine : hasCreatineFood(dd);
const vitdOn = (dd) => !!(dd && dd.vitd);
// 体重など小数1桁で表示
const fmt1 = (v) => (v == null || v === "" || isNaN(Number(v))) ? (v ?? "") : Number(v).toFixed(1);
// 糖質ゲージの色：未記録=muted／記録あり=通常／目標到達=達成色／120%以上=アンバー（数字と色だけで語る）
// mutedは「未入力・無効」の意味に限定し、1gでも記録があればice＝進行中（たんぱくゲージと同じ文法）
function carbBarColor(carbs, limit) {
  const r = limit > 0 ? carbs / limit : 0;
  return r >= 1.2 ? "var(--amber)" : r >= 1.0 ? "var(--green)" : carbs > 0 ? "var(--ice)" : "var(--muted)";
}

const MENU = {
  trainA: [
    { id: "rdl",     name: "KB RDL",             spec: "16kg 10×3・3秒下ろし" },
    { id: "goblet",  name: "ゴブレットスクワット", spec: "16kg 10×3・下で2秒" },
    { id: "swing",   name: "KBスイング",          spec: "16kg 15×3" },
    { id: "cossack", name: "コサックスクワット",   spec: "左右6×3" },
    { id: "calf",    name: "片脚カーフレイズ",     spec: "KB保持 12×2" },
  ],
  trainB: [
    { id: "pullup",  name: "懸垂",               spec: "できる回数×3" },
    { id: "row",     name: "片手ロウ",           spec: "8-10kg 10×3" },
    { id: "pushup",  name: "PUバー腕立て",        spec: "10×3" },
    { id: "ohp",     name: "ショルダープレス",     spec: "中立 8-10kg 10×3" },
    { id: "extrot",  name: "外旋（腱板）",         spec: "2-3kg 15×3" },
    { id: "plank",   name: "肘つきプランク",       spec: "30秒×3" },
    { id: "neck",    name: "首アイソメ",           spec: "前後左右 各10秒×3" },
  ],
};

const PACE = [
  { key: "saba",  label: "鯖缶",         target: 3, color: "#5FC9DE" },
  { key: "fish",  label: "生魚・別魚種", target: 1, color: "#5FC9DE" },
  { key: "tuna",  label: "ツナ缶",       target: 2, color: "#9D8CE0" },
  { key: "red",   label: "赤身肉",       target: 1, color: "#E08C8C" },
  { key: "shell", label: "貝類",         target: 1, color: "#F0B458" },
  { key: "liver", label: "鶏レバー",     target: 1, max: 2, color: "#C98C5F" },
];

const SEED = {
  "2026-06-30": { dayType: "rest", sleep: null, walked: false, weight: null, comment: null, foods: [
    { name: "バナナ", p: 1, c: 27 }, { name: "ゆで卵", p: 6, c: 0 },
    { name: "プロテイン+クレアチン+牛乳", p: 27, c: 8 },
    { name: "鯖缶（そうめん）", p: 20, c: 0, omega3: true, cat: "saba" },
    { name: "そうめん", p: 5, c: 40 },
    { name: "プチトマト・オクラ", p: 2, c: 6, veg: true, fiber: true },
    { name: "かぼちゃ蒸し", p: 2, c: 15, veg: true, fiber: true },
    { name: "ゆで卵", p: 6, c: 0 }, { name: "かりんとう", p: 1, c: 15 },
    { name: "赤身ステーキ400g", p: 90, c: 0, cat: "red" },
    { name: "付け合わせ（人参・玉ねぎ・ポテト）", p: 5, c: 33, veg: true },
    { name: "ご飯1膳", p: 4, c: 55 },
  ] },
  "2026-07-01": { dayType: "rest", sleep: null, walked: false, weight: null, comment: null, foods: [
    { name: "バナナ", p: 1, c: 27 },
    { name: "玄米", p: 4, c: 50, fiber: true },
    { name: "鯖缶（ボウル）", p: 20, c: 0, omega3: true, cat: "saba" },
    { name: "オクラ・トマト・しそ", p: 2, c: 6, veg: true, fiber: true },
    { name: "かぼちゃ", p: 2, c: 15, veg: true, fiber: true },
    { name: "炒り卵（卵2個）", p: 12, c: 1 },
    { name: "プロテイン+クレアチン+牛乳", p: 23, c: 8 },
    { name: "焼肉（タン・カルビ・ロース・ハラミ）", p: 40, c: 2, cat: "red" },
    { name: "プルコギ", p: 10, c: 8 },
    { name: "ナムル・キムチ・海苔・サンチュ", p: 5, c: 8, veg: true, fiber: true },
    { name: "スープ", p: 2, c: 3 }, { name: "ポップコーン", p: 3, c: 18 },
  ] },
  "2026-07-02": { dayType: "climb", sleep: null, walked: false, weight: null, comment: null, foods: [
    { name: "バナナ", p: 1, c: 27 },
    { name: "鯖缶（うどん）", p: 20, c: 0, omega3: true, cat: "saba" },
    { name: "うどん", p: 6, c: 50 },
    { name: "みょうが・しそ・トマト・オクラ", p: 2, c: 6, veg: true, fiber: true },
    { name: "かぼちゃ小鉢", p: 2, c: 15, veg: true, fiber: true },
    { name: "プロテイン+クレアチン+牛乳", p: 23, c: 8 },
    { name: "小魚アーモンド+ミックスナッツ20g", p: 4, c: 4, fiber: true },
    { name: "チョコひとかけ", p: 0, c: 5 }, { name: "プラム2個", p: 1, c: 15 },
    { name: "牛丼アタマ大盛り（松屋）", p: 24, c: 90, cat: "red" },
    { name: "生卵", p: 6, c: 0 },
    { name: "味噌汁（わかめ・油揚げ）", p: 2, c: 4, fiber: true },
  ] },
  "2026-07-03": { dayType: "rest", sleep: null, walked: false, weight: null, comment: null, foods: [
    { name: "白桃アールグレイタルト（スタバ）", p: 3, c: 33 },
  ] },
};

// ---------- 状態 ----------
let data = {};
let view = "log";        // log | review | settings
let cursor = new Date();
let range = 14;
let busy = false, commentBusy = false;
let errMsg = "", setMsg = "";
let inputText = "";

// ---------- ユーティリティ ----------
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtJP = (d) => `${d.getMonth() + 1}/${d.getDate()}（${"日月火水木金土"[d.getDay()]}）`;
const emptyDay = () => ({ foods: [], acts: [], sleep: null, weight: null, comment: null });
const sumP = (dd) => (dd && dd.foods || []).reduce((s, f) => s + (Number(f.p) || 0), 0);
const sumC = (dd) => (dd && dd.foods || []).reduce((s, f) => s + (Number(f.c) || 0), 0);
const getDay = (k) => data[k] || emptyDay();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function load() {
  let stored = null;
  try { const raw = localStorage.getItem(DATA_KEY); if (raw) stored = JSON.parse(raw); } catch (e) {}
  data = Object.assign({}, SEED, stored || {});
  // v2移行：旧dayType宣言 → acts実績配列（旧データは宣言を実績として引き継ぐ）
  for (const k of Object.keys(data)) {
    const dd = data[k];
    if (!dd) continue;
    if (dd.dayType === "active") dd.dayType = "climb";
    if (!Array.isArray(dd.acts)) {
      dd.acts = (dd.dayType && dd.dayType !== "rest") ? [dd.dayType] : [];
    }
  }
  save();
}
function save() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) {}
  schedulePush();
}
function updateDay(key, patch) {
  data[key] = Object.assign({}, getDay(key), patch, { _m: Date.now() });
  save();
  render();
}
function apiKey() { return localStorage.getItem(API_KEY_KEY) || ""; }

// ---------- デバイス間同期（GitHub 秘密Gist） ----------
// データの正本＝秘密Gist内の foodlog-data.json。各端末は起動時にpull→マージし、変更のたびに自動push。
// マージは「日付ごとに更新時刻(_m)が新しい方を採用」。オフライン時はlocalStorageで動き続け、復帰時に同期。
const ghToken = () => localStorage.getItem(GH_TOKEN_KEY) || "";
const gistId = () => localStorage.getItem(GIST_ID_KEY) || "";
let syncState = ghToken() ? "idle" : "off"; // off | idle | busy | ok | error
let syncReady = !ghToken(); // 初回pullが済むまでpushしない（他端末のデータを上書きしないため）
let pushTimer = null;

async function ghApi(path, opts = {}) {
  return fetch("https://api.github.com" + path, Object.assign({
    headers: {
      "Authorization": "Bearer " + ghToken(),
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
  }, opts));
}

function mergeRemote(remote) {
  if (!remote || typeof remote !== "object") return;
  for (const k of Object.keys(remote)) {
    const r = remote[k], l = data[k];
    if (!r) continue;
    if (!l || (Number(r._m) || 0) > (Number(l._m) || 0)) data[k] = r;
  }
}

async function syncPull() {
  if (!ghToken()) return;
  let id = gistId();
  if (!id) {
    // 初回：既存のfoodlog Gistを探す（他端末が作成済みの場合）
    const res = await ghApi("/gists?per_page=100");
    if (!res.ok) throw new Error("gist list " + res.status);
    const list = await res.json();
    const hit = (Array.isArray(list) ? list : []).find((g) => g.files && g.files[GIST_FILE]);
    if (!hit) return; // まだどの端末も作っていない→この後のpushで新規作成
    id = hit.id;
    localStorage.setItem(GIST_ID_KEY, id);
  }
  const res = await ghApi("/gists/" + id);
  if (res.status === 404) { localStorage.removeItem(GIST_ID_KEY); return; }
  if (!res.ok) throw new Error("gist get " + res.status);
  const g = await res.json();
  const f = g.files && g.files[GIST_FILE];
  if (!f) return;
  let content = f.content;
  if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url)).text();
  mergeRemote(JSON.parse(content));
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) {}
}

async function syncPush() {
  if (!ghToken()) return;
  const content = JSON.stringify(data);
  let id = gistId();
  let res = null;
  if (id) {
    res = await ghApi("/gists/" + id, { method: "PATCH", body: JSON.stringify({ files: { [GIST_FILE]: { content } } }) });
    if (res.status === 404) { localStorage.removeItem(GIST_ID_KEY); id = ""; }
  }
  if (!id) {
    res = await ghApi("/gists", { method: "POST", body: JSON.stringify({ public: false, description: "foodlog data (auto-sync)", files: { [GIST_FILE]: { content } } }) });
    if (res.ok) { const g = await res.json(); if (g.id) localStorage.setItem(GIST_ID_KEY, g.id); }
  }
  if (!res || !res.ok) throw new Error("gist push " + (res ? res.status : "?"));
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
}

function schedulePush() {
  if (!ghToken() || !syncReady) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try { syncState = "busy"; await syncPush(); syncState = "ok"; }
    catch (e) { syncState = "error"; }
    if (view === "settings") render();
  }, 2500);
}

async function syncNow() {
  if (!ghToken()) return;
  syncState = "busy"; render();
  try {
    await syncPull();
    await syncPush();
    syncState = "ok";
  } catch (e) { syncState = "error"; }
  syncReady = true;
  render();
}

// 食材ペースの週は「月曜始まり・日曜終わり」の固定週（WEEK_STARTで変更可：1=月,0=日）
const WEEK_START = 1;
function weekInfo(anchorKey) {
  const [y, m, d] = anchorKey.split("-").map(Number);
  const anchor = new Date(y, m - 1, d);
  const offset = (anchor.getDay() - WEEK_START + 7) % 7; // 週初からの経過日数（0=週初日）
  const start = new Date(y, m - 1, d - offset);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return { start, end, dayN: offset + 1, remain: 6 - offset };
}
function pace7(anchorKey) {
  const w = weekInfo(anchorKey);
  const counts = { saba: 0, fish: 0, tuna: 0, red: 0, shell: 0, liver: 0 };
  for (let i = 0; i < w.dayN; i++) {
    const dd = data[toKey(new Date(w.start.getFullYear(), w.start.getMonth(), w.start.getDate() + i))];
    ((dd && dd.foods) || []).forEach((f) => { if (f.cat && counts[f.cat] != null) counts[f.cat]++; });
  }
  return counts;
}
function weekAvgFor(anchor) {
  let sum = 0, n = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(anchor); d.setDate(d.getDate() - i);
    const dd = data[toKey(d)];
    if (dd && dd.foods.length) { sum += sumP(dd); n++; }
  }
  return n ? Math.round(sum / n) : null;
}
// 当日を含む直近7日で体重が記録された日の平均（小数1桁）。記録2日未満は非表示（null）。導出値なのでCSV列は増やさない。
function weightAvg7(anchor) {
  let sum = 0, n = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(anchor); d.setDate(d.getDate() - i);
    const dd = data[toKey(d)];
    const w = dd && dd.weight;
    if (w != null && w !== "" && !isNaN(Number(w))) { sum += Number(w); n++; }
  }
  return n >= 2 ? (sum / n).toFixed(1) : null;
}

// ---------- Anthropic API ----------
const NUTRITION_RULES = `各品目について次を判定：
- p: たんぱく質g(整数)
- c: 糖質(炭水化物)g(整数)
- veg: 緑黄色野菜か(にんじん/トマト/かぼちゃ/ほうれん草/小松菜/ブロッコリー/オクラ/ピーマン等ならtrue)
- omega3: オメガ3が豊富な魚か(鯖/いわし/あじ/鮭/さんま等の青魚・鮭ならtrue。ツナ・白身魚はfalse)
- fiber: 食物繊維が豊富か(海藻/きのこ/豆類/野菜/全粒穀物/玄米等ならtrue)
- cat: 食材カテゴリ。鯖の缶詰なら"saba"、それ以外の魚(鮭/いわし/あじ/さんま/白身魚/生魚/焼き魚、および鯖の生・焼き)なら"fish"、ツナ缶なら"tuna"、牛・ラム等の赤身肉(焼肉/ステーキ/牛丼含む)なら"red"、貝類(あさり/牡蠣/しじみ/ホタテ等)なら"shell"、鶏レバー・レバー(焼き鳥のレバー串含む)なら"liver"、いずれでもなければ""(空文字)
- t: 食べた時刻。本文に時刻の記載があれば"HH:MM"形式（例：「21時に」→"21:00"、「昼12時半」→"12:30"）。記載がなければnull
ユーザーがたんぱく質や糖質のg数を明記していた場合はその値を優先すること。
出力はJSON配列のみ。各要素は {"name":品名,"p":int,"c":int,"veg":bool,"omega3":bool,"fiber":bool,"cat":string,"t":文字列orNull}。
前置き・説明・コードフェンス・マークダウンは一切不要。`;

async function callApi(body) {
  const key = apiKey();
  if (!key) throw new Error("NO_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "API error");
  return json.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function parseItems(raw) {
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  return parsed.filter((x) => x && x.name).map((x) => {
    const it = { name: String(x.name), p: Math.max(0, Math.round(Number(x.p) || 0)), c: Math.max(0, Math.round(Number(x.c) || 0)) };
    if (x.veg) it.veg = true;
    if (x.omega3) it.omega3 = true;
    if (x.fiber) it.fiber = true;
    if (["saba", "fish", "tuna", "red", "shell"].includes(x.cat)) it.cat = x.cat;
    return it;
  });
}

async function estimateNutrition(text) {
  const raw = await callApi({
    model: MODEL_ESTIMATE, max_tokens: 1200,
    messages: [{ role: "user", content:
`あなたは栄養士です。次の食事メモから品目ごとに推定してください。
分量の記載(例「玄米150g」「卵2個」)は分量として解釈。分量指定がなければ一般的な1食分で推定。
${NUTRITION_RULES}

食事メモ：${text}` }],
  });
  return parseItems(raw);
}

async function estimateFromPhoto(base64, mediaType, hint) {
  const content = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text:
`あなたは栄養士です。この食事写真に写っている品目を特定し、それぞれの栄養を推定してください。
${hint ? "補足メモ：" + hint + "\n" : ""}${NUTRITION_RULES}` },
  ];
  const raw = await callApi({ model: MODEL_PHOTO, max_tokens: 1200, messages: [{ role: "user", content }] });
  return parseItems(raw);
}

async function fetchBakao(key) {
  const day = getDay(key);
  const total = sumP(day), carbs = sumC(day);
  const active = isActiveDay(day);
  const target = active ? CEILING : FLOOR;
  const hasVeg = day.foods.some((f) => f.veg);
  const hasOmega3 = day.foods.some((f) => f.omega3);
  const foodList = day.foods.map((f) => `${f.t ? f.t + " " : ""}${f.name}(P${f.p}${f.c != null ? "/C" + f.c : ""})`).join("、");
  const [y, m, d] = key.split("-").map(Number);
  const dateLabel = fmtJP(new Date(y, m - 1, d));
  const isToday = toKey(new Date()) === key;
  const now = new Date(), hh = now.getHours(), mm = pad(now.getMinutes());
  const phase = !isToday ? "past"
    : (hh >= 3 && hh < 12) ? "morning"
    : (hh >= 12 && hh < 18) ? "midday"
    : (hh >= 18 && hh < 24) ? "evening" : "closing";
  const phaseNote = {
    past: "これは過去の日の振り返りです。締めの総括として評価してください。",
    morning: "まだ一日の序盤（この人は起床9:30）。締めの総括は絶対にしないこと。ここまでの立ち上がりを評価し、残りの食事でどう届くかの見通しを軽く示す。",
    midday: "まだ一日の中盤。締めの総括は絶対にしないこと。「今日はここまで」等の締め言葉も禁止。進捗として評価し、夜（この人の夕食は遅め）で目標に届く道筋を一言添える。",
    evening: "一日の終盤だが、この人は夜型（練習20〜23時、夕食も遅い）でまだ食事が残っている可能性が高い。締めすぎず、残りの補給の余地に触れてよい。",
    closing: "就寝（2:30）前の時間帯。今日の締めの総括として評価してよい。",
  }[phase];
  const pc = pace7(key);
  const raw = await callApi({
    model: MODEL_BAKAO, max_tokens: 500,
    messages: [{ role: "user", content:
`あなたは「塔ノ岳 ばかお」という栄養担当のコーチです。48歳男性クライマー・登山者（170cm/61kg、維持目標、TFCC損傷回復期、血糖やや高め・HbA1c5.9、起床9:30・就寝2:30の夜型）の食事ログに、一言評価を返します。

評価の姿勢（厳守）：
- 事実を淡々と。達成率が低い日に「満点」「完璧」と言わない
- ダメ出しもしない
- 完璧主義による息切れが最大リスクの人なので、圧をかけない
- 良い点をひとつ具体的に挙げる。提案はあっても軽く一つまで

現在時刻：${hh}:${mm}
時間帯の扱い（最重要）：${phaseNote}

目標：たんぱく質は基準100g（毎日必達）、運動日は120gを目標にする（120gは上限ではなく、超えても全く問題ない）。糖質の目安は休養日250g前後、運動日330g前後（維持目標・高活動量のため十分に摂る方針。血糖対策は玄米優先・食後散歩・ドカ食い回避で行い、総量を過度に絞らない）。

筋トレ設計：週2（A=ヒンジ・脚／B=引く・押す・体幹）。筋トレ日は目標120gを狙い、トレ60分前に補食+コラーゲン+C、トレ後60分に回復食。翌朝の手首に違和感が出たら一段戻すルール。

運動日/休養日の判定は「実績ベース」：その日に筋トレのチェック・登攀・柔術・山行の実績があれば運動日。宣言でなく実績で決まる。

対象日（${dateLabel}・${actLabel(day)}${active ? "＝運動日" : "＝休養日"}）のデータ：
- たんぱく質：${total}g（目標${target}g）
- 糖質：${carbs}g
- 歩数：${day.steps != null ? day.steps.toLocaleString() + "歩（参考値。目標や警告には使わない。ただし休養日で15,000歩を超えている日は、糖質+40〜50g程度の追加補給に軽く触れてよい。責めない・警告調にしない）" : "記録なし"}
- サプリ：クレアチン${creatineOn(day) ? "済" : "未"}／ビタミンD${vitdOn(day) ? "済" : "未"}（クレアチン3〜5gは毎日方針。未の日はごく軽く一言リマインドしてよい。説教はしない）
- 有酸素（Zone2）：本日${dayActs(day).includes("aerobic") ? "実施" : "なし"}／今週${weeklyAerobic(key)}回（目安1〜2回。糖質目標には影響しない。未実施を責めない。実施日は一言認めてよい）
- 睡眠：${day.sleep != null ? day.sleep + "時間（目標7時間）" : "記録なし"}${(day.bedtime || day.waketime) ? `／就寝${day.bedtime ?? "—"}・起床${day.waketime ?? "—"}（目標2:30就寝・9:30起床。ズレはセットで崩れるので就寝側を主因として見る）` : ""}${day.rhr != null ? `／安静時心拍${day.rhr}bpm（平常より明らかに高い朝は回復不足のサイン）` : ""}${day.mood ? `／本人の体調メモ：「${day.mood}」（数字と体感の対応を一言で拾う）` : ""}
- 緑黄色野菜：${hasVeg ? "あり" : "なし"}／オメガ3の魚：${hasOmega3 ? "あり" : "なし"}
- 運動実績：${actLabel(day)}${dayActs(day).filter((a)=>MENU[a]).map((a)=>`／${DAY_LABEL[a]}種目：${(((day.workout||{}).checks)||[]).filter((id)=>MENU[a].some((ex)=>ex.id===id)).length}/${MENU[a].length}`).join("")}${(day.workout&&day.workout.note)?`（メモ：${day.workout.note}）`:""}
${(day.muscle != null || day.fatpct != null) ? `- 体組成：体重${fmt1(day.weight) || "—"}kg／骨格筋量${day.muscle ?? "—"}kg／体脂肪率${day.fatpct ?? "—"}%（維持目標。骨格筋量の減少傾向にだけ注意を払う）
` : ""}${day.wrist ? `- 翌朝の手首：${day.wrist==="ok"?"違和感なし":"違和感あり"}
` : ""}- 食べたもの（時刻付き。血糖対策は総量でなく質とタイミング：時刻の偏り＝1食への糖質集中や、就寝2:30直前の重い食事があれば軽く触れてよい。時刻なしの品目は詮索しない）：${foodList}
- 直近7日平均：${weekAvgFor(new Date(y, m - 1, d)) ?? "—"}g
- 今週の食材ペース（月曜始まり・日曜締め、本日${weekInfo(key).dayN}日目）：鯖缶${pc.saba}/3、生魚${pc.fish}/1、ツナ${pc.tuna}/2、赤身${pc.red}/1、貝${pc.shell}/1、鶏レバー${pc.liver}/1〜2（レバーはビタミンA過剰回避のため週2が上限。週3以上のときだけ「今週はもう十分」と一言添える）（週前半の未達を責めない。週後半で残りが多い場合のみ軽く献立提案してよい）

出力：日本語で2〜3文の一言評価のみ。前置き・見出し・絵文字・マークダウン不要。`} ],
  });
  return raw.trim();
}

// InBody・Fitbit等のスクショから測定データを読み取る（体組成・睡眠）
async function extractHealthData(base64, mediaType) {
  const raw = await callApi({
    model: MODEL_PHOTO, max_tokens: 400,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text:
`この健康系アプリ（体組成計・睡眠トラッカー等）のスクリーンショットから、写っている数値だけを読み取ってください。
- weight: 体重(kg)
- muscle: 骨格筋量(kg)
- fatpct: 体脂肪率(%)
- sleep: 睡眠時間（小数の時間。例：6時間37分→6.6）
- bedtime: 就寝時刻（"HH:MM"の24時間表記。例：4時48分就寝→"4:48"）
- waketime: 起床時刻（"HH:MM"の24時間表記。例：11時31分→"11:31"）
- rhr: 安静時心拍(bpm)
- steps: 歩数（整数。「20,321歩」→20321）
- aerobic: 有酸素運動の記録画面か（「ウォーキング」「ランニング」「サイクリング」「ハイキング」等の有酸素系アクティビティ名と、時間・平均心拍などが表示された画面ならtrue。「ワークアウト」「筋トレ」「ウェイト」等の筋力トレーニング画面、体組成・睡眠・日次サマリー画面はnull）
写っていない・読み取れない項目はnull。睡眠スコアは不要。出力はJSONオブジェクトのみ：
{"weight":数値orNull,"muscle":数値orNull,"fatpct":数値orNull,"sleep":数値orNull,"bedtime":文字列orNull,"waketime":文字列orNull,"rhr":数値orNull,"steps":数値orNull,"aerobic":真偽値orNull}
前置き・説明・コードフェンス不要。` },
    ] }],
  });
  const o = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const num = (v) => (v == null || isNaN(Number(v))) ? null : Math.round(Number(v) * 10) / 10;
  const tm = (v) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim())) ? v.trim() : null;
  return { weight: num(o.weight), muscle: num(o.muscle), fatpct: num(o.fatpct),
           sleep: num(o.sleep), bedtime: tm(o.bedtime), waketime: tm(o.waketime),
           rhr: o.rhr != null && !isNaN(Number(o.rhr)) ? Math.round(Number(o.rhr)) : null,
           steps: o.steps != null && !isNaN(Number(o.steps)) ? Math.round(Number(o.steps)) : null,
           aerobic: o.aerobic === true };
}

// 写真を縮小してbase64化（通信量・コスト対策）
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1200;
      let { width, height } = img;
      if (Math.max(width, height) > MAX) {
        const r = MAX / Math.max(width, height);
        width = Math.round(width * r); height = Math.round(height * r);
      }
      const cv = document.createElement("canvas");
      cv.width = width; cv.height = height;
      cv.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = cv.toDataURL("image/jpeg", 0.82);
      resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

// ---------- CSV / バックアップ ----------
function buildCsv() {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["日付","時刻","区分","品名","たんぱく質g","糖質g","緑黄色野菜","オメガ3","食物繊維","食材カテゴリ","日合計P","日合計C","睡眠h","就寝","起床","安静時心拍","歩数","体調","体重kg","骨格筋量kg","体脂肪率","クレアチン","ビタミンD"].join(",")];
  for (const k of Object.keys(data).sort()) {
    const dd = data[k];
    if (!dd || !(dd.foods || []).length) continue;
    const dp = sumP(dd), dc = sumC(dd);
    dd.foods.forEach((f, i) => {
      rows.push([k, (f.t || ""), q(actLabel(dd)), q(f.name), f.p ?? 0, f.c ?? 0,
        f.veg ? 1 : 0, f.omega3 ? 1 : 0, f.fiber ? 1 : 0, f.cat || "",
        i === 0 ? dp : "", i === 0 ? dc : "",
        i === 0 ? (dd.sleep ?? "") : "", i === 0 ? (dd.bedtime ?? "") : "", i === 0 ? (dd.waketime ?? "") : "", i === 0 ? (dd.rhr ?? "") : "", i === 0 ? (dd.steps ?? "") : "", i === 0 ? q(dd.mood ?? "") : '""', i === 0 ? fmt1(dd.weight) : "", i === 0 ? (dd.muscle ?? "") : "", i === 0 ? (dd.fatpct ?? "") : "", i === 0 ? (creatineOn(dd) ? 1 : 0) : "", i === 0 ? (vitdOn(dd) ? 1 : 0) : ""].join(","));
    });
  }
  return rows.join("\n");
}
function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
const exportCsv = () => download(`mealog_${toKey(new Date())}.csv`, "\uFEFF" + buildCsv(), "text/csv;charset=utf-8");
const exportJson = () => download(`mealog_backup_${toKey(new Date())}.json`, JSON.stringify(data, null, 2), "application/json");
function importJson(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const obj = JSON.parse(r.result);
      if (typeof obj !== "object" || !obj) throw new Error();
      if (confirm("バックアップから復元します。現在のデータに上書きマージされます。よろしいですか？")) {
        const now = Date.now();
        for (const k of Object.keys(obj)) { if (obj[k] && typeof obj[k] === "object") obj[k]._m = now; }
        data = Object.assign({}, data, obj);
        save(); setMsg = "復元しました。"; render();
      }
    } catch (e) { alert("ファイルを読み込めませんでした。"); }
  };
  r.readAsText(file);
}

// ---------- アクション ----------
// ---- 食事時刻（血糖の質とタイミング方針用）----
// 優先順位：AIが本文から読んだ時刻 > 写真ファイルの撮影時刻 > 今日を開いていれば現在時刻 > なし（後からタップで修正可）
const nowHHMM = () => { const d = new Date(); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
const validHHMM = (s) => typeof s === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.trim()) ? s.trim() : null;
function stampFoods(items, key, fileTime) {
  const isToday = toKey(new Date()) === key;
  return items.map((f) => {
    let t = validHHMM(f.t);
    if (!t && fileTime) t = fileTime;
    if (!t && isToday) t = nowHHMM();
    return Object.assign({}, f, { t: t || null });
  });
}
// 写真の撮影時刻：EXIF(DateTimeOriginal)を直接読む。取れなければlastModifiedで代用。
// Androidのフォトピッカー等はlastModifiedを「選択時刻」に書き換えることがあるため、EXIFが正。
function exifDateTime(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null; // not JPEG
    let o = 2;
    while (o + 4 < v.byteLength) {
      if (v.getUint8(o) !== 0xFF) break;
      const marker = v.getUint8(o + 1);
      const size = v.getUint16(o + 2);
      if (marker === 0xE1) { // APP1 (Exif)
        const s = o + 4;
        if (v.getUint32(s) === 0x45786966) { // "Exif"
          const t = s + 6; // TIFFヘッダ起点
          const le = v.getUint16(t) === 0x4949; // バイト順
          const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
          const readIfd = (ofs, want) => {
            const n = u16(t + ofs); const found = {};
            for (let i = 0; i < n; i++) {
              const e = t + ofs + 2 + i * 12;
              const tag = u16(e);
              if (want.includes(tag)) found[tag] = { type: u16(e + 2), count: u32(e + 4), val: u32(e + 8), at: e + 8 };
            }
            return { found, next: u32(t + ofs + 2 + n * 12) };
          };
          const ifd0 = readIfd(u32(t + 4), [0x8769, 0x0132]); // ExifIFDポインタ, DateTime
          let dtEntry = null;
          if (ifd0.found[0x8769]) {
            const exifIfd = readIfd(ifd0.found[0x8769].val, [0x9003]); // DateTimeOriginal
            dtEntry = exifIfd.found[0x9003] || null;
          }
          if (!dtEntry) dtEntry = ifd0.found[0x0132] || null;
          if (dtEntry && dtEntry.type === 2 && dtEntry.count >= 19) {
            const p = t + dtEntry.val;
            let str = "";
            for (let i = 0; i < 19; i++) str += String.fromCharCode(v.getUint8(p + i));
            // "YYYY:MM:DD HH:MM:SS"
            const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
            if (m) return { key: `${m[1]}-${m[2]}-${m[3]}`, hhmm: `${Number(m[4])}:${m[5]}` };
          }
        }
      }
      if (marker === 0xDA) break; // 画像データ開始
      o += 2 + size;
    }
  } catch (e) {}
  return null;
}

async function photoHHMM(file, key) {
  try {
    const head = await file.slice(0, 128 * 1024).arrayBuffer(); // EXIFは先頭にある
    const ex = exifDateTime(head);
    if (ex) return ex.key === key ? ex.hhmm : null; // 別の日の写真は採用しない
  } catch (e) {}
  return fileHHMM(file, key); // EXIFなし→lastModifiedで代用
}

// 写真ファイルの撮影時刻（lastModified）。開いている日と同じ日付のときだけ採用
function fileHHMM(file, key) {
  try {
    const d = new Date(file.lastModified);
    if (toKey(d) !== key) return null;
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch (e) { return null; }
}

async function submitText() {
  const t = inputText.trim();
  if (!t || busy) return;
  if (!apiKey()) { errMsg = "APIキーが未登録です。設定タブで登録すると送信できます。"; render(); return; }
  busy = true; errMsg = ""; render();
  try {
    const items = await estimateNutrition(t);
    if (!items.length) errMsg = "うまく読み取れませんでした。言い方を変えて試してください。";
    else {
      const key = toKey(cursor);
      const day = getDay(key);
      inputText = "";
      updateDay(key, { foods: day.foods.concat(stampFoods(items, key)), comment: null });
    }
  } catch (e) {
    errMsg = e.message === "NO_KEY" ? "設定タブでAPIキーを登録してください。" : "概算に失敗しました。通信とAPIキーを確認してください。";
  } finally { busy = false; render(); }
}

async function onPhotoPicked(file) {
  if (!file || busy) return;
  if (!apiKey()) { errMsg = "APIキーが未登録です。設定タブで登録すると写真解析が使えます。"; render(); return; }
  busy = true; errMsg = ""; render();
  try {
    const { base64, mediaType } = await resizeImage(file);
    const items = await estimateFromPhoto(base64, mediaType, inputText.trim());
    if (!items.length) errMsg = "写真から品目を読み取れませんでした。テキストで補足してみてください。";
    else {
      const key = toKey(cursor);
      const day = getDay(key);
      inputText = "";
      updateDay(key, { foods: day.foods.concat(stampFoods(items, key, await photoHHMM(file, key))), comment: null });
    }
  } catch (e) { errMsg = "写真の解析に失敗しました。もう一度試してください。"; }
  finally { busy = false; render(); }
}

async function getBakao() {
  const key = toKey(cursor);
  if (commentBusy || !getDay(key).foods.length) return;
  if (!apiKey()) { errMsg = "APIキーが未登録です。設定タブで登録すると評価が使えます。"; render(); return; }
  commentBusy = true; errMsg = ""; render();
  try {
    const c = await fetchBakao(key);
    if (c) updateDay(key, { comment: c });
  } catch (e) { errMsg = "評価の取得に失敗しました。"; }
  finally { commentBusy = false; render(); }
}

async function onInbodyPicked(file) {
  if (!file || busy) return;
  if (!apiKey()) { errMsg = "APIキーが未登録です。設定タブで登録すると読み取りが使えます。"; render(); return; }
  busy = true; errMsg = ""; render();
  try {
    const { base64, mediaType } = await resizeImage(file);
    const r = await extractHealthData(base64, mediaType);
    if (r.weight == null && r.muscle == null && r.fatpct == null && r.sleep == null && r.bedtime == null && r.waketime == null && r.rhr == null && r.steps == null && !r.aerobic) {
      errMsg = "数値を読み取れませんでした。数値が写った画面で撮り直してみてください。";
    } else {
      const key = toKey(cursor);
      const patch = {};
      if (r.weight != null) patch.weight = String(r.weight);
      if (r.muscle != null) patch.muscle = r.muscle;
      if (r.fatpct != null) patch.fatpct = r.fatpct;
      if (r.sleep != null) patch.sleep = String(r.sleep);
      if (r.bedtime != null) patch.bedtime = r.bedtime;
      if (r.waketime != null) patch.waketime = r.waketime;
      if (r.rhr != null) patch.rhr = r.rhr;
      if (r.steps != null) patch.steps = r.steps;
      if (r.aerobic) {
        const cur = dayActs(getDay(key));
        if (!cur.includes("aerobic")) patch.acts = cur.concat("aerobic");
      }
      updateDay(key, patch);
    }
  } catch (e) { errMsg = "読み取りに失敗しました。もう一度試してください。"; }
  finally { busy = false; render(); }
}

function removeFood(i) {
  const key = toKey(cursor);
  const day = getDay(key);
  updateDay(key, { foods: day.foods.filter((_, idx) => idx !== i), comment: null });
}

// ---------- 描画 ----------
function isWide() { return window.matchMedia("(min-width: 900px)").matches; }

// innerHTML全書き換え方式でもゲージのtransitionを発火させるFLIP。
// 同じ日の再描画（食事の追加・削除）のときだけ、前回の高さ/幅から新しい値へアニメさせる。
// 日付移動・タブ切替では動かさない（「今日の増分」だけを動きで伝える）。
let animPrev = null, animNext = null;
function applyFillAnim() {
  const next = animNext; animNext = null;
  if (!next) return;
  if (animPrev && animPrev.key === next.key) {
    const g = $(".gauge .fill");
    if (g && animPrev.gauge !== next.gauge) {
      g.style.transition = "none"; g.style.height = animPrev.gauge + "%";
      g.offsetHeight; // reflowを挟んで旧値を確定させる
      g.style.transition = ""; g.style.height = next.gauge + "%";
    }
    const c = $("[data-carbfill]");
    if (c && animPrev.carb !== next.carb) {
      c.style.transition = "none"; c.style.width = animPrev.carb + "%";
      c.offsetWidth;
      c.style.transition = ""; c.style.width = next.carb + "%";
    }
  }
  animPrev = next;
}

function render() {
  const app = $("#app");
  const wide = isWide();
  let body;
  if (view === "settings") {
    body = `<div class="${wide ? "wide-single" : ""}">${renderSettings()}</div>`;
  } else if (wide) {
    // 大画面：記録（左）+ 振り返り（右）を同時表示
    body = `<div class="wide-grid"><div class="wcol">${renderLog()}</div><div class="wcol sub">${renderReview()}</div></div>`;
  } else {
    body = view === "log" ? renderLog() : renderReview();
  }
  app.innerHTML = `
    <div class="tabs">
      ${(wide ? [["log","記録・振り返り"],["settings","設定"]] : [["log","記録"],["review","振り返り"],["settings","設定"]]).map(([v,l]) =>
        `<button class="tab ${view===v || (wide && v==="log" && view==="review") ?"on":""}" data-view="${v}">${l}</button>`).join("")}
    </div>
    ${body}
  `;
  bindEvents();
  applyFillAnim();
}

function renderLog() {
  const key = toKey(cursor);
  const day = getDay(key);
  const total = sumP(day), carbs = sumC(day);
  const active = isActiveDay(day);
  const target = active ? CEILING : FLOOR;
  const isToday = toKey(new Date()) === key;
  const hitFloor = total >= FLOOR, hitCeil = total >= CEILING;
  // 120g到達もgreen（amberは注意・境界系に一本化。「120gは超えても問題ない」思想と色を揃え、到達は✓で伝える）
  const barColor = hitFloor ? "var(--green)" : "var(--ice)";
  const pct = Math.min(total / CEILING, 1) * 100;
  const floorPct = (FLOOR / CEILING) * 100;
  const carbLimit = CARB_LIMIT[active ? "active" : "rest"];
  const carbHot = carbs >= carbLimit * 1.2; // 超過表示はバー色(carbBarColor)と同じ120%発火。100〜119%は達成扱い
  const carbColor = carbBarColor(carbs, carbLimit);
  const carbPct = Math.min(carbLimit > 0 ? carbs / carbLimit : 0, 1) * 100;
  const carbDiff = carbs < carbLimit ? `あと ${carbLimit - carbs}g` : `+${carbs - carbLimit}g`;
  animNext = { key, gauge: pct, carb: carbPct }; // FLIP用に今回の描画値を記録
  const hasVeg = day.foods.some((f) => f.veg);
  const hasOm = day.foods.some((f) => f.omega3);
  const hasFi = day.foods.some((f) => f.fiber);
  const wavg = weekAvgFor(cursor);
  const w7 = weightAvg7(cursor);
  const pc = pace7(key);
  const wi = weekInfo(key);
  const wd = ["日","月","火","水","木","金","土"][new Date(key.split("-")[0], key.split("-")[1]-1, key.split("-")[2]).getDay()];

  return `
    <div class="datenav">
      <button class="navbtn" data-move="-1">‹</button>
      <div>
        <div class="datetitle">${fmtJP(cursor)}</div>
        ${!isToday ? `<button class="todaybtn" data-today>今日へ戻る</button>` : ""}
      </div>
      <button class="navbtn" data-move="1" ${isToday ? "disabled" : ""}>›</button>
    </div>

    <div class="daytype daytype6">
      ${ACTS.map((t) =>
        `<button class="dt ${t==="aerobic"?"aero":"active"} ${day.acts.includes(t)?"on":""}" data-act="${t}">${DAY_LABEL[t]}</button>`).join("")}
    </div>
    <div class="hint" style="margin-top:-8px;margin-bottom:8px">実績判定：<b style="color:${active?"var(--amber)":"var(--green)"}">${active?"運動日 · 目標120g／糖質330g":"休養日 · 基準100g／糖質250g"}</b>${day.acts.some((a)=>a==="trainA"||a==="trainB") && !active ? "（筋トレは1種目チェックで運動日になります）" : ""}<br>今週の有酸素 <b class="mono">${weeklyAerobic(key)}</b>/1〜2${day.acts.includes("aerobic") ? "（有酸素は糖質目標に影響しません）" : ""}</div>

    ${dayActs(day).filter((a) => MENU[a]).map((a) => `
    <div class="section" style="padding-top:0;padding-bottom:14px">
      <div class="seclabel">今日のメニュー（${DAY_LABEL[a]}）</div>
      <div class="card pacebox">
        ${MENU[a].map((ex) => {
          const on = ((day.workout && day.workout.checks) || []).includes(ex.id);
          return `<div class="pacerow" data-ex="${ex.id}" style="cursor:pointer">
            <span class="box lg ${on?"on":""}">${on?"✓":""}</span>
            <span style="font-size:14px;flex:1;color:${on?"var(--text)":"var(--muted)"}">${ex.name}</span>
            <span style="font-size:11px;color:var(--muted);flex-shrink:0" class="mono">${ex.spec}</span>
          </div>`;
        }).join("")}
      </div>
    </div>`).join("")}
    ${dayActs(day).some((a) => MENU[a]) ? `
    <div class="section" style="padding-top:0;padding-bottom:14px;margin-top:-8px">
      <input class="setinput" data-wnote placeholder="メモ（例：RDL 18kgに上げた／スイング違和感で中止）"
        value="${esc((day.workout && day.workout.note) || "")}" style="font-size:13px">
    </div>` : ""}

    ${(() => {
      const yd = new Date(cursor); yd.setDate(yd.getDate() - 1);
      const ydd = data[toKey(yd)];
      if (!ydd || !wristTrig(ydd)) return "";
      return `<div class="section" style="padding-top:0;padding-bottom:14px">
        <div class="card" style="padding:12px 14px;border-color:${day.wrist==="ng"?"var(--amber)":"var(--line)"}">
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px">昨日は${actLabel(ydd)}。翌朝の手首は？</div>
          <div style="display:flex;gap:8px">
            <button class="dt ${day.wrist==="ok"?"rest on":"rest"}" data-wrist="ok" style="padding:8px 0">違和感なし</button>
            <button class="dt ${day.wrist==="ng"?"active on":"active"}" data-wrist="ng" style="padding:8px 0">違和感あり</button>
          </div>
          ${day.wrist==="ng"?`<div style="font-size:11px;color:var(--amber);margin-top:8px">判断基準：一段戻す（重量↓ or テンポ段階↓）。2回続いたら2割減。</div>`:""}
          ${day.wrist==="ok"?`<div style="font-size:11px;color:var(--green);margin-top:8px">前進OK。テンポ→ポーズ→片側化→回数の順で。</div>`:""}
        </div>
      </div>`;
    })()}

    <div class="gaugewrap">
      <div class="gauge">
        <div class="tube"><div class="fill" style="height:${pct}%;background:${barColor}"></div></div>
        <div class="floorline" style="bottom:${floorPct}%"></div>
        <div class="ceilline"></div>
      </div>
      <div class="gmain">
        <div class="glabel">たんぱく質</div>
        <div><span class="gnum mono" style="color:${barColor}">${total}</span><span class="gunit mono"> g</span></div>
        <div class="gtarget">今日の目標 ${target}g（${actLabel(day)}）</div>
        <div class="statusrow">
          <span class="box ${hitFloor?"on":""}">${hitFloor?"✓":""}</span>
          <span>基準 100g</span>
          <span class="detail mono" style="color:${hitFloor?"var(--green)":"var(--muted)"}">${hitFloor?"到達 · 合格":`あと ${FLOOR-total}g`}</span>
        </div>
        <div class="statusrow" style="opacity:${active?1:.5}">
          <span class="box ${hitCeil?"on":""}">${hitCeil?"✓":""}</span>
          <span>運動日目標 120g</span>
          <span class="detail mono" style="color:${hitCeil?"var(--green)":"var(--muted)"}">${hitCeil?"到達":`あと ${CEILING-total}g`}</span>
        </div>
        ${wavg != null ? `<div class="weekavg">直近7日平均　<span class="mono" style="color:var(--text);font-size:14px">${wavg}g</span></div>` : ""}
      </div>
    </div>

    <div class="card carbcard ${carbHot?"hot":""}">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div style="font-size:12px;color:var(--muted)">糖質（目安 ${carbLimit}g／${active?"運動日":"休養日"}）</div>
        <div><span class="mono" style="font-size:26px;font-weight:700;color:${carbColor}">${carbs}</span><span class="mono" style="font-size:13px;color:var(--muted)"> g</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
        <div class="hbar"><div class="fill" data-carbfill style="width:${carbPct}%;background:${carbColor}"></div></div>
        <span class="mono" style="flex-shrink:0;font-size:12px;color:var(--muted)">${carbDiff}</span>
      </div>
      ${carbHot ? `<div style="font-size:11px;color:var(--amber);margin-top:6px">目安超え。食後の散歩がおすすめ。</div>` : ""}
    </div>
    ${(day.steps != null && day.steps >= STEP_NOTE_MIN && !active) ? `
    <div class="walknote">👣 歩数 ${day.steps.toLocaleString()}歩（参考）。休養日ですが活動量が多い日です。糖質＋40〜50gを目安に補給してOK（目標値は変わりません）。</div>` : ""}

    <div class="pills">
      <div class="pill ${hasVeg?"on":""}"><span class="ico">🥬</span>緑黄色野菜</div>
      <div class="pill ${hasOm?"on":""}"><span class="ico">🐟</span>魚 オメガ3</div>
      <div class="pill ${hasFi?"on":""}"><span class="ico">🌾</span>食物繊維</div>
    </div>

    <div class="section">
      <div class="seclabel">今週の食材ペース（月〜日・${wd}曜＝${wi.dayN}日目）</div>
      <div class="card pacebox">
        ${PACE.map((row) => {
          const n = pc[row.key];
          const hi = row.max || row.target;
          const met = n >= row.target && n <= hi;
          const over = n > hi;
          const dots = Array.from({ length: Math.max(hi, n) }).map((_, i) =>
            `<span class="dot" style="${i < n ? `background:${over && i >= hi ? "var(--amber)" : row.color};border-color:${over && i >= hi ? "var(--amber)" : row.color}` : i < row.target ? `border-color:${row.color}` : "opacity:.4"}"></span>`).join("");
          const range = row.max ? `${row.target}〜${row.max}` : `${row.target}`;
          const stat = over ? `${n}/${range}・今週は十分` : met ? `達成 ${n}/${range}` : `${n}/${range}・あと${row.target - n}`;
          return `<div class="pacerow">
            <span class="pacename">${row.label}</span>
            <div class="dots">${dots}</div>
            <span class="pacestat mono ${met?"met":""}" ${over?`style="color:var(--amber)"`:""}>${stat}</span>
          </div>`;
        }).join("")}
      </div>
      <div class="pacenote">目安：鯖缶3・生魚1〜2・ツナ2〜3・赤身1・貝1・鶏レバー1〜2（50〜80g/回、上限あり）／週。月曜に0から再スタート、日曜が締め${wi.remain > 0 ? `（今週あと${wi.remain}日）` : "（今日が最終日）"}</div>
    </div>

    <div class="inputrow">
      <button class="iconbtn" data-photo ${busy?"disabled":""}>📷</button>
      <textarea class="mealinput" rows="2" placeholder="食べたものを書く／写真だけでもOK" ${busy?"disabled":""}>${esc(inputText)}</textarea>
      <button class="sendbtn" data-send ${busy?"disabled":""}>${busy?'<span class="spin">◐</span>':"⏎"}</button>
    </div>
    <div class="hint">${busy ? "解析中…" : apiKey() ? "AIが自動概算します。g数を書けばその値を優先。" : "AI概算には設定タブでAPIキー登録が必要です。"}</div>
    ${errMsg ? `<div class="errmsg">${esc(errMsg)}</div>` : ""}

    <div class="foodlist">
      ${day.foods.length === 0
        ? `<div class="emptymsg">まだ記録がありません。写真か一言でどうぞ。</div>`
        : day.foods.map((f, i) => `
          <div class="foodrow">
            <button class="timechip mono" data-ftime="${i}" title="タップで時刻を修正">${f.t ? esc(f.t) : "--:--"}</button>
            <div class="foodname"><span class="nm">${esc(f.name)}</span><span class="badges">${f.veg?"🥬":""}${f.omega3?"🐟":""}${f.fiber?"🌾":""}</span></div>
            <div class="foodnums">
              <span class="mono" style="color:var(--ice);font-size:15px">${f.p}<small style="color:var(--muted)">P</small></span>
              <span class="mono" style="color:var(--muted);font-size:13px">${f.c ?? 0}<small>C</small></span>
              <button class="delbtn" data-del="${i}">🗑</button>
            </div>
          </div>`).join("")}
    </div>

    ${day.foods.length ? `
      <div class="bakaobox">
        ${day.comment ? `
          <div class="bakaocard">
            <div class="bakaotitle">🥗 ばかおの一言</div>
            <div class="bakaotext">${esc(day.comment)}</div>
            <button class="linkbtn" data-bakao>${commentBusy?"更新中…":"評価を更新"}</button>
          </div>` : `
          <button class="bakaobtn" data-bakao ${commentBusy?"disabled":""}>${commentBusy?'<span class="spin">◐</span> ばかおが見ています…':"💬 ばかおの一言評価をもらう"}</button>`}
      </div>` : ""}

    <div class="tiles">
      <div class="tile">
        <span class="ico">🌙</span>
        <input class="tileinput mono" data-field="sleep" inputmode="decimal" placeholder="—" value="${day.sleep ?? ""}">
        <span class="tilelabel">睡眠 h</span>
      </div>
      <div class="tile">
        <span class="ico">⚖️</span>
        <input class="tileinput mono" data-field="weight" inputmode="decimal" placeholder="—" value="${fmt1(day.weight)}">
        <span class="tilelabel">体重 kg</span>
        ${w7 != null ? `<span class="tilelabel mono">7日平均 ${w7}</span>` : ""}
      </div>
      <button class="tile ${creatineOn(day)?"on":""}" data-supp="creatine">
        <span class="ico">💊</span>
        <span class="mono" style="font-size:15px;font-weight:900;color:${creatineOn(day)?"var(--green)":"var(--muted)"}">${creatineOn(day)?"✓":"—"}</span>
        <span class="tilelabel">クレアチン</span>
      </button>
      <button class="tile ${vitdOn(day)?"on":""}" data-supp="vitd">
        <span class="ico">☀️</span>
        <span class="mono" style="font-size:15px;font-weight:900;color:${vitdOn(day)?"var(--green)":"var(--muted)"}">${vitdOn(day)?"✓":"—"}</span>
        <span class="tilelabel">ビタミンD</span>
      </button>
    </div>
    ${(day.creatine == null && hasCreatineFood(day)) ? `<div class="walknote">💊 食事記録の「クレアチン」から自動チェック済み。</div>` : ""}

    <div class="section" style="padding-bottom:8px">
      <div class="seclabel">測定データ（InBody・Fitbit等のスクショ）</div>
      <div class="card" style="margin-top:10px;padding:12px 14px;display:flex;align-items:center;gap:12px">
        <button class="iconbtn" data-inbody ${busy?"disabled":""} style="width:44px;height:44px">📊</button>
        <div style="flex:1;font-size:13px;color:var(--muted)">
          ${(day.muscle != null || day.fatpct != null || day.bedtime || day.waketime || day.rhr != null || day.steps != null)
            ? `<span style="color:var(--text)">${day.muscle != null ? `筋量 <b class="mono" style="color:var(--green)">${day.muscle}</b>kg` : ""}${day.fatpct != null ? ` ・体脂肪 <b class="mono" style="color:var(--ice)">${day.fatpct}</b>%` : ""}${(day.bedtime || day.waketime) ? `<br>睡眠 <b class="mono" style="color:var(--violet)">${day.bedtime ?? "—"}〜${day.waketime ?? "—"}</b>（目標2:30〜9:30）` : ""}${day.rhr != null ? ` ・安静時心拍 <b class="mono" style="color:var(--ice)">${day.rhr}</b>bpm` : ""}${day.steps != null ? `<br>歩数 <b class="mono" style="color:var(--text)">${day.steps.toLocaleString()}</b>歩<span style="color:var(--muted)">（参考表示）</span>` : ""}</span>`
            : "体組成計や睡眠トラッカーのスクショから、体重・筋量・体脂肪・睡眠・就寝起床・心拍・歩数を自動記録します。"}
        </div>
        ${(day.weight != null || day.muscle != null || day.fatpct != null || day.sleep != null || day.bedtime || day.waketime || day.rhr != null || day.steps != null)
          ? `<button class="delbtn" data-measdel title="この日の測定データを削除">🗑</button>` : ""}
      </div>
      <input class="setinput" data-mood placeholder="体調ひとこと（任意。例：すっきり／だるい）"
        value="${esc(day.mood || "")}" style="margin-top:8px;font-size:13px">
    </div>
  `;
}

function renderReview() {
  const today = new Date();
  const days = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const k = toKey(d), dd = data[k];
    days.push({
      key: k, label: `${d.getMonth()+1}/${d.getDate()}`,
      p: sumP(dd), c: sumC(dd), has: !!(dd && dd.foods.length),
      badge: actShort(dd), active: isActiveDay(dd),
      steps: dd && dd.steps != null ? dd.steps : null,
      creatine: creatineOn(dd), vitd: vitdOn(dd),
      weight: dd && dd.weight ? Number(dd.weight) : null,
      muscle: dd && dd.muscle != null ? Number(dd.muscle) : null,
      fatpct: dd && dd.fatpct != null ? Number(dd.fatpct) : null,
      veg: !!((dd && dd.foods) || []).some((f) => f.veg),
      omega3: !!((dd && dd.foods) || []).some((f) => f.omega3),
      fiber: !!((dd && dd.foods) || []).some((f) => f.fiber),
    });
  }
  const logged = days.filter((x) => x.has);
  const avgP = logged.length ? Math.round(logged.reduce((s, x) => s + x.p, 0) / logged.length) : 0;
  const floorDays = logged.filter((x) => x.p >= FLOOR).length;
  const creDays = logged.filter((x) => x.creatine).length;
  const vdDays = logged.filter((x) => x.vitd).length;
  const om3Days = days.filter((x) => x.omega3).length;
  const vegDays = days.filter((x) => x.veg).length;
  const fiDays = days.filter((x) => x.fiber).length;

  return `
    <div class="rangebtns">
      <button class="rbtn ${range===14?"on":""}" data-range="14">2週間</button>
      <button class="rbtn ${range===30?"on":""}" data-range="30">1ヶ月</button>
      <button class="csvbtn" data-csv>⬇ CSV</button>
    </div>
    <div class="sumgrid">
      <div class="sumcard"><div class="sumlabel">平均たんぱく質</div><div><span class="sumval mono" style="color:${avgP>=FLOOR?"var(--green)":"var(--ice)"}">${avgP}</span><span class="sumunit mono"> g</span></div><div class="sumnote">記録 ${logged.length}日</div></div>
      <div class="sumcard"><div class="sumlabel">基準100g 達成</div><div><span class="sumval mono" style="color:var(--green)">${floorDays}</span><span class="sumunit mono">/${logged.length}日</span></div><div class="sumnote">合格した日数</div></div>
      <div class="sumcard"><div class="sumlabel">💊 クレアチン</div><div><span class="sumval mono" style="color:${creDays===logged.length&&logged.length?"var(--green)":"var(--ice)"}">${creDays}</span><span class="sumunit mono">/${logged.length}日</span></div><div class="sumnote">ビタミンD ${vdDays}日</div></div>
      <div class="sumcard"><div class="sumlabel">魚(オメガ3)</div><div><span class="sumval mono" style="color:var(--ice)">${om3Days}</span><span class="sumunit mono"> 日</span></div><div class="sumnote">緑黄${vegDays}·繊維${fiDays}日</div></div>
    </div>
    <div class="chartbox">
      <div class="seclabel">たんぱく質の推移</div>
      ${proteinChart(days)}
      <div class="chartnote">緑の破線＝基準100g／橙線＝運動日目標120g</div>
    </div>
    <div class="chartbox">
      <div class="seclabel">⚖️ 体重の推移</div>
      ${weightChart(days)}
    </div>
    <div class="chartbox">
      <div class="seclabel">💪 骨格筋量の推移</div>
      ${compChart(days, "muscle", "#7FD68B", "kg")}
    </div>
    <div class="chartbox">
      <div class="seclabel">体脂肪率の推移</div>
      ${compChart(days, "fatpct", "#F0B458", "%")}
    </div>
    <div class="section" style="padding-top:0">
      <div class="seclabel">日別ログ</div>
      <div class="daylist">
        ${days.slice().reverse().map((x) => `
          <div class="dayrow ${x.has?"":"off"}">
            <span class="daydate mono">${x.label}</span>
            ${x.badge?`<span class="daybadge">${x.badge}</span>`:""}
            <span class="dayicons">${x.veg?"🥬":""}${x.omega3?"🐟":""}${x.fiber?"🌾":""}${x.creatine?"💊":""}${x.steps!=null?`<span class="mono" style="font-size:10px;color:var(--muted)"> ${(x.steps/1000).toFixed(1)}k歩</span>`:""}</span>
            <span class="dayp mono" style="color:${!x.has?"var(--muted)":x.p>=FLOOR?"var(--green)":"var(--ice)"}">${x.has?x.p+"g":"—"}</span>
          </div>`).join("")}
      </div>
    </div>
  `;
}

function proteinChart(days) {
  const W = 448, H = 180, padL = 30, padB = 18, padT = 8;
  // 140g超の日を無言でクリップしない（スケールを実測に追従させ、頑張った日の差分を残す）
  const maxY = Math.max(140, ...days.map((d) => d.has ? d.p : 0));
  const iw = (W - padL) / days.length;
  const y = (v) => padT + (H - padT - padB) * (1 - Math.min(v, maxY) / maxY);
  const bars = days.map((d, i) => {
    const x = padL + i * iw + iw * 0.15;
    const bw = iw * 0.7;
    const v = d.has ? d.p : 0;
    const color = v >= FLOOR ? "#7FD68B" : v > 0 ? "#5FC9DE" : "#22303C"; // 120g超もgreen（amberは注意系に一本化）
    const h = (H - padT - padB) * (Math.min(v, maxY) / maxY);
    return `<rect x="${x.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h,1).toFixed(1)}" rx="2" fill="${color}"/>`;
  }).join("");
  const step = days.length > 20 ? 5 : days.length > 10 ? 2 : 1;
  const labels = days.map((d, i) => i % step === 0
    ? `<text x="${(padL + i * iw + iw/2).toFixed(1)}" y="${H-4}" font-size="9" fill="#8598A6" text-anchor="middle">${d.label}</text>` : "").join("");
  const axis = [0, 50, 100, maxY].map((v) =>
    `<text x="${padL-5}" y="${(y(v)+3).toFixed(1)}" font-size="9" fill="#8598A6" text-anchor="end">${v}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:8px">
    ${axis}${bars}
    <line x1="${padL}" x2="${W}" y1="${y(FLOOR).toFixed(1)}" y2="${y(FLOOR).toFixed(1)}" stroke="#7FD68B" stroke-width="1.5" stroke-dasharray="4 3"/>
    <line x1="${padL}" x2="${W}" y1="${y(CEILING).toFixed(1)}" y2="${y(CEILING).toFixed(1)}" stroke="#F0B458" stroke-width="1.5"/>
    ${labels}
  </svg>`;
}

function weightChart(days) {
  // x座標は「記録日の並び順」でなく実際の日付位置に置く（欠測期間の傾きを歪めない）
  const pts = days.map((d, di) => ({ ...d, di })).filter((d) => d.weight != null);
  if (pts.length < 2) return `<div style="font-size:12px;color:var(--muted);padding:14px 0">体重の記録が2日分たまるとグラフが出ます。</div>`;
  const W = 448, H = 150, padL = 34, padB = 18, padT = 10;
  const ws = pts.map((p) => p.weight);
  const lo = Math.min(...ws) - 1, hi = Math.max(...ws) + 1;
  const x = (p) => padL + (W - padL - 8) * (days.length === 1 ? 0.5 : p.di / (days.length - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p.weight).toFixed(1)}`).join(" ");
  const dots = pts.map((p) => `<circle cx="${x(p).toFixed(1)}" cy="${y(p.weight).toFixed(1)}" r="3" fill="#5FC9DE"/>`).join("");
  const labels = pts.map((p, i) => (pts.length <= 8 || i === 0 || i === pts.length - 1)
    ? `<text x="${x(p).toFixed(1)}" y="${H-4}" font-size="9" fill="#8598A6" text-anchor="middle">${p.label}</text>` : "").join("");
  const axis = [lo, (lo+hi)/2, hi].map((v) =>
    `<text x="${padL-5}" y="${(y(v)+3).toFixed(1)}" font-size="9" fill="#8598A6" text-anchor="end">${v.toFixed(1)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:8px">
    ${axis}<path d="${path}" fill="none" stroke="#5FC9DE" stroke-width="2"/>${dots}${labels}
  </svg>`;
}

function compChart(days, field, color, unit) {
  // weightChartと同じく実際の日付位置でx座標を取る
  const pts = days.map((d, di) => ({ ...d, di })).filter((d) => d[field] != null);
  if (pts.length < 2) return `<div style="font-size:12px;color:var(--muted);padding:14px 0">記録が2回分たまるとグラフが出ます（${unit}）。</div>`;
  const W = 448, H = 140, padL = 36, padB = 18, padT = 10;
  const vs = pts.map((p) => p[field]);
  const lo = Math.min(...vs) - 0.5, hi = Math.max(...vs) + 0.5;
  const x = (p) => padL + (W - padL - 8) * (days.length === 1 ? 0.5 : p.di / (days.length - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p[field]).toFixed(1)}`).join(" ");
  const dots = pts.map((p) => `<circle cx="${x(p).toFixed(1)}" cy="${y(p[field]).toFixed(1)}" r="3" fill="${color}"/>`).join("");
  const labels = pts.map((p, i) => (pts.length <= 8 || i === 0 || i === pts.length - 1)
    ? `<text x="${x(p).toFixed(1)}" y="${H-4}" font-size="9" fill="#8598A6" text-anchor="middle">${p.label}</text>` : "").join("");
  const axis = [lo, (lo+hi)/2, hi].map((v) =>
    `<text x="${padL-5}" y="${(y(v)+3).toFixed(1)}" font-size="9" fill="#8598A6" text-anchor="end">${v.toFixed(1)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:8px">
    ${axis}<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>${dots}${labels}
  </svg>`;
}

function renderSettings() {
  const hasKey = !!apiKey();
  return `
    <div class="section" style="padding-top:4px">
      <div class="card setbox">
        <div class="settitle">🔑 Anthropic APIキー（AI概算・ばかお評価用）</div>
        <div class="setdesc">
          写真解析・自動概算・ばかおの一言に使います。キーは<b>この端末の中にだけ</b>保存され、外部には送信されません（Anthropicへの通信を除く）。<br>
          取得：console.anthropic.com → API Keys → Create Key。従量課金ですが1回の概算は1円未満〜数円程度です。
        </div>
        <div style="font-size:12px;margin-bottom:8px;color:${hasKey?"var(--green)":"var(--amber)"}">現在：${hasKey ? "登録済み ✓" : "未登録（AI概算・写真解析・ばかお評価は使えません）"}</div>
        <input class="setinput mono" id="apikeyInput" type="password" placeholder="sk-ant-..." value="${hasKey ? "●●●●●●●●●●●●" : ""}">
        <div class="setrow">
          <button class="setbtn" data-savekey>保存してテスト</button>
          ${hasKey ? `<button class="setbtn danger" data-delkey>キーを削除</button>` : ""}
        </div>
        ${setMsg ? `<div class="okmsg">${esc(setMsg)}</div>` : ""}
      </div>

      <div class="card setbox">
        <div class="settitle">🔄 デバイス間同期（GitHub Gist）</div>
        <div class="setdesc">
          あなたのGitHubアカウントの<b>秘密Gist</b>にデータを自動保存し、スマホ・PCどの端末からも同じデータを参照できます。<br>
          設定：GitHubでgist権限（Read and write）のみの Fine-grained トークンを発行し、下に貼って保存（各端末で1回）。以降は全自動——起動時に取得、変更のたびに保存。マージは日付ごとに新しい方が優先されます。
        </div>
        <div style="font-size:12px;margin-bottom:8px;color:${ghToken() ? (syncState === "error" ? "var(--amber)" : "var(--green)") : "var(--amber)"}">
          現在：${!ghToken() ? "未設定（データはこの端末内のみ）"
            : syncState === "busy" ? '<span class="spin">↻</span> 同期中…'
            : syncState === "error" ? "同期エラー（トークン・通信を確認してください）"
            : (() => { const t = Number(localStorage.getItem(LAST_SYNC_KEY) || 0); return t ? `同期済み ✓（最終 ${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2,"0")}）` : "設定済み（初回同期待ち）"; })()}
        </div>
        <input class="setinput mono" id="ghtokenInput" type="password" placeholder="github_pat_..." value="${ghToken() ? "●●●●●●●●●●●●" : ""}">
        <div class="setrow">
          <button class="setbtn" data-savegh>保存して同期</button>
          ${ghToken() ? `<button class="setbtn ghost" data-syncnow>今すぐ同期</button><button class="setbtn danger" data-delgh>トークン削除</button>` : ""}
        </div>
        ${gistId() ? `<div style="font-size:11px;color:var(--muted);margin-top:8px;word-break:break-all">分析用Gist ID（AIに全データ分析を頼むときに伝える）：<br><span class="mono" style="color:var(--text);user-select:all">${esc(gistId())}</span></div>` : ""}
      </div>

      <div class="card setbox">
        <div class="settitle">💾 バックアップ</div>
        <div class="setdesc">データはこの端末のブラウザ内に保存されています。ブラウザのデータ消去で消えるので、ときどき書き出しておくと安心です。</div>
        <div class="setrow">
          <button class="setbtn ghost" data-exportjson>JSONで書き出し</button>
          <button class="setbtn ghost" data-importjson>JSONから復元</button>
          <button class="setbtn ghost" data-exportcsv>CSVで書き出し</button>
        </div>
      </div>

      <div class="card setbox">
        <div class="settitle">ℹ️ このアプリについて</div>
        <div class="setdesc">
          foodlog v2 — たんぱく質 基準100g／運動日目標120g方式の食事＋筋トレログ。<br>
          <b>v2＝実績ベース判定</b>：運動日/休養日は宣言でなく、その日の実績（筋トレ1種目以上チェック・登攀・柔術・山行）から自動判定。有酸素（Zone2）トグルは週次実績の記録のみで糖質目標には影響しない（Fitbit等のワークアウト画面スクショを📊に読ませると自動ON）。<br>
          歩数はスクショ📊から参考表示のみ（目標・警告には使わない。休養日で15,000歩超の日だけ補給の一言が出ます）。<br>
          筋トレ：週2（A=ヒンジ・脚／B=引く・押す・体幹）。翌朝の手首で前進/一段戻すを判定。サプリ確認：クレアチン（食事記録から自動チェック）・ビタミンD。<br>
          糖質目安：休養日250g・運動日330g（血糖対策は質とタイミングで）。食材ペース：鯖缶3・生魚1〜2・ツナ2〜3・赤身1・貝1／週（月曜始まり・日曜締めの固定週）。<br>
          データ保存：この端末＋（同期設定時）あなたのGitHub秘密Gist。Anthropic・GitHub以外の外部には何も送信しません。
        </div>
      </div>
    </div>
  `;
}

// ---------- イベント ----------
function bindEvents() {
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => { view = b.dataset.view; errMsg = ""; setMsg = ""; render(); }));

  document.querySelectorAll("[data-move]").forEach((b) =>
    b.addEventListener("click", () => { const d = new Date(cursor); d.setDate(d.getDate() + Number(b.dataset.move)); cursor = d; errMsg = ""; render(); }));
  const tb = $("[data-today]"); if (tb) tb.addEventListener("click", () => { cursor = new Date(); render(); });

  document.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const key = toKey(cursor);
      const day = getDay(key);
      const a = b.dataset.act;
      const cur = dayActs(day);
      const acts = cur.includes(a) ? cur.filter((x) => x !== a) : cur.concat(a);
      updateDay(key, { acts, comment: null });
    }));

  const ta = $(".mealinput");
  if (ta) {
    ta.addEventListener("input", () => { inputText = ta.value; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitText(); });
  }
  const send = $("[data-send]"); if (send) send.addEventListener("click", submitText);
  const photo = $("[data-photo]"); if (photo) photo.addEventListener("click", () => $("#photoInput").click());
  const ib = $("[data-inbody]"); if (ib) ib.addEventListener("click", () => $("#inbodyInput").click());

  document.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => removeFood(Number(b.dataset.del))));

  document.querySelectorAll("[data-ftime]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.ftime);
      const key = toKey(cursor);
      const day = getDay(key);
      const cur = (day.foods[i] && day.foods[i].t) || "";
      const v = prompt("食べた時刻（例 21:30）。空欄で時刻なしに戻します。", cur);
      if (v === null) return; // キャンセル
      const t = v.trim() === "" ? null : validHHMM(v);
      if (v.trim() !== "" && !t) { alert("HH:MM形式で入力してください（例 8:05、21:30）"); return; }
      const foods = day.foods.map((f, idx) => idx === i ? Object.assign({}, f, { t }) : f);
      updateDay(key, { foods });
    }));

  const bk = $("[data-bakao]"); if (bk) bk.addEventListener("click", getBakao);

  document.querySelectorAll("[data-field]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const v = inp.value.replace(/[^0-9.]/g, "");
      updateDay(toKey(cursor), { [inp.dataset.field]: v || null });
    }));
  document.querySelectorAll("[data-supp]").forEach((b) =>
    b.addEventListener("click", () => {
      const key = toKey(cursor);
      const day = getDay(key);
      const which = b.dataset.supp;
      if (which === "creatine") updateDay(key, { creatine: !creatineOn(day) });
      else updateDay(key, { vitd: !vitdOn(day) });
    }));
  const mdel = $("[data-measdel]"); if (mdel) mdel.addEventListener("click", () => {
    if (confirm("この日の測定データ（体重・筋量・体脂肪・睡眠・就寝起床・心拍・歩数）を削除しますか？食事や運動の記録は残ります。")) {
      updateDay(toKey(cursor), { weight: null, muscle: null, fatpct: null, sleep: null, bedtime: null, waketime: null, rhr: null, steps: null });
    }
  });
  document.querySelectorAll("[data-ex]").forEach((row) =>
    row.addEventListener("click", () => {
      const key = toKey(cursor);
      const day = getDay(key);
      const w = Object.assign({ checks: [], note: "" }, day.workout || {});
      const id = row.dataset.ex;
      w.checks = w.checks.includes(id) ? w.checks.filter((x) => x !== id) : w.checks.concat(id);
      updateDay(key, { workout: w });
    }));
  const md = $("[data-mood]"); if (md) {
    md.addEventListener("change", () => {
      updateDay(toKey(cursor), { mood: md.value.trim() || null });
    });
  }
  const wn = $("[data-wnote]"); if (wn) {
    wn.addEventListener("change", () => {
      const key = toKey(cursor);
      const day = getDay(key);
      updateDay(key, { workout: Object.assign({ checks: [] }, day.workout || {}, { note: wn.value }) });
    });
  }
  document.querySelectorAll("[data-wrist]").forEach((b) =>
    b.addEventListener("click", () => {
      const key = toKey(cursor);
      const cur = getDay(key).wrist;
      updateDay(key, { wrist: cur === b.dataset.wrist ? null : b.dataset.wrist });
    }));

  document.querySelectorAll("[data-range]").forEach((b) =>
    b.addEventListener("click", () => { range = Number(b.dataset.range); render(); }));
  const csv = $("[data-csv]"); if (csv) csv.addEventListener("click", exportCsv);

  const sk = $("[data-savekey]"); if (sk) sk.addEventListener("click", async () => {
    const v = $("#apikeyInput").value.trim();
    if (!v || v.startsWith("●")) { setMsg = "キーを入力してください。"; render(); return; }
    localStorage.setItem(API_KEY_KEY, v);
    setMsg = "テスト中…"; render();
    try {
      await callApi({ model: MODEL_TEST, max_tokens: 10, messages: [{ role: "user", content: "1+1=" }] });
      setMsg = "保存しました。AI機能が使えます。";
    } catch (e) {
      setMsg = "保存しましたが、テストに失敗しました（" + e.message + "）。通信状況か、キーが正しいか確認してください。";
    }
    render();
  });
  const dk = $("[data-delkey]"); if (dk) dk.addEventListener("click", () => {
    if (confirm("APIキーを削除しますか？")) { localStorage.removeItem(API_KEY_KEY); setMsg = "削除しました。"; render(); }
  });

  const sg = $("[data-savegh]"); if (sg) sg.addEventListener("click", async () => {
    const v = $("#ghtokenInput").value.trim();
    if (!v || v.startsWith("●")) { setMsg = "トークンを入力してください。"; render(); return; }
    localStorage.setItem(GH_TOKEN_KEY, v);
    setMsg = ""; syncReady = false;
    await syncNow();
    setMsg = syncState === "error" ? "トークンを保存しましたが同期に失敗しました。gist権限（Read and write）が付いているか確認してください。" : "同期を開始しました。";
    render();
  });
  const sn = $("[data-syncnow]"); if (sn) sn.addEventListener("click", () => syncNow());
  const dg = $("[data-delgh]"); if (dg) dg.addEventListener("click", () => {
    if (confirm("同期トークンを削除しますか？（Gist上のデータは残ります。この端末はローカル保存に戻ります）")) {
      localStorage.removeItem(GH_TOKEN_KEY); syncState = "off"; setMsg = "削除しました。"; render();
    }
  });

  const ej = $("[data-exportjson]"); if (ej) ej.addEventListener("click", exportJson);
  const ec = $("[data-exportcsv]"); if (ec) ec.addEventListener("click", exportCsv);
  const ij = $("[data-importjson]"); if (ij) ij.addEventListener("click", () => $("#importInput").click());
}

// 写真・インポートのファイル選択（一度だけバインド）
document.getElementById("photoInput").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  onPhotoPicked(f);
});
// InBodyスクショ用の隠しinputを動的に用意（index.html変更を不要にするため）
(() => {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*"; inp.id = "inbodyInput"; inp.style.display = "none";
  document.body.appendChild(inp);
  inp.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    onInbodyPicked(f);
  });
})();

document.getElementById("importInput").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (f) importJson(f);
});

// スタイルはすべて index.html の <style> に集約（動的<style>追加は上書き事故のもとなので廃止）

// Service Worker登録（オフライン起動用）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// 起動
load();
// 起動時同期：初回pullが終わるまでpushしない（他端末のデータ保護）
if (ghToken()) {
  (async () => {
    try { syncState = "busy"; await syncPull(); syncState = "ok"; }
    catch (e) { syncState = "error"; }
    syncReady = true;
    render();
    schedulePush();
  })();
}
window.addEventListener("online", () => schedulePush());
// 画面幅がブレークポイント（900px）をまたいだら再描画
window.matchMedia("(min-width: 900px)").addEventListener("change", () => render());
// データのある最新日か今日のうち、新しい方を開く
(() => {
  const todayKey = toKey(new Date());
  const dated = Object.keys(data).filter((k) => (data[k].foods || []).length).sort();
  const latest = dated[dated.length - 1];
  if (latest && latest > todayKey) {
    const [y, m, d] = latest.split("-").map(Number);
    cursor = new Date(y, m - 1, d);
  }
})();
render();
