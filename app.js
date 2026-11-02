// CRUFU 2027 隊內追蹤 app
// 資料：data.js（由 build_data.py 產生）；設定、交棒紀錄、GPS 透過 Supabase 的 team 函式全隊同步，
// 本機 localStorage 當快取（沒訊號時照樣能看、能按交棒）
'use strict';

// 網址帶 reset（例如 …/#k=隊伍密碼&reset）：清掉這支手機記住的一切、取消通知訂閱，再當成第一次打開（測試第一次使用流程用）
{
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has('reset') && !window.CRUFU_SIM) {
    try { Object.keys(localStorage).filter(k => k.startsWith('crufu.')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* 存不了就算了 */ }
    const go = () => location.replace(location.pathname + location.search + (h.get('k') ? '#k=' + encodeURIComponent(h.get('k')) : ''));
    ('serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null))
      .then(r => r && r.pushManager && r.pushManager.getSubscription()).then(sub => sub && sub.unsubscribe())
      .catch(() => {}).finally(go);
    throw new Error('reset');                   // 停在這裡，後面的程式不要再把舊資料存回去
  }
}

const D = window.CRUFU_DATA;
const T = D.track;                         // [lat, lon, 累積 km, 高度 m]
const TZ = 'Asia/Taipei';
const RUNNERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const OVERHEAD_SEC = 60;                   // 每棒交棒、找人的時間
const LEVEL_COLOR = { 低: '#22c55e', 中: '#f59e0b', 難: '#ef4444' };
const CAR_COLOR = { 1: '#e5484d', 2: '#3b82f6' };
// 地圖圖示：icons/ 裡每位跑者一張頭像（runner1～10.png）、兩台車各一張；原始大圖在專案的 icons_src/
const ICONS = { runner: r => `icons/runner${r}.png`, car1: 'icons/car1.png', car2: 'icons/car2.png' };
// 模擬模式（網址加 ?sim，sim.js 提供假資料）的存檔加 sim. 前綴，不會蓋掉正式的設定與隊伍密碼
const LS_PRE = window.CRUFU_SIM ? 'sim.' : '';
const LS_CFG = LS_PRE + 'crufu.cfg.v1', LS_STATE = LS_PRE + 'crufu.state.v1';

// ---------- 儲存 ----------
function load(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ? { ...def, ...v } : def; }
  catch (e) { return def; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 私密模式等情況存不了就算了 */ } }

const cfg = load(LS_CFG, {
  me: null,                                 // 我是幾號
  planStart: D.planStart,                   // 預計出發時間（抽籤梯次公布後改）
  paces: Object.fromEntries(RUNNERS.map(r => [r, 420])),  // 每人平地配速（秒/公里）
  names: {},                                // 隊員名字 {號碼: 名字}，沒填的顯示「N 號」
  order: [...RUNNERS],                      // 每輪 10 棒的跑者順序；前 5 棒坐 Car1、後 5 棒坐 Car2
  assign: {},                               // 個別棒次調整 {棒次: 跑者}，沒填的照 order
  sub: {},                                  // 受傷代跑的棒次 {棒次: true}，允許同一輪有人多跑
  demo: true,                               // 示範模式：用模擬時間與模擬交棒紀錄
  demoHours: 7.5,                           // 示範模式的「現在」＝出發後幾小時
  testPoint: null,                          // 測試交接點 {lat, lon}：管理員測試自動交棒用，正式比賽前要取消
  os: '',                                   // 第一次使用設定選的手機系統 ios／android（空的就自動判斷）
  showCrew: false,                          // 地圖顯示全隊每個人的位置（只存在這支手機）
  mapStyle: 'street',                       // 地圖底圖：street 街道（類似 Google 地圖）／dark 深色／sat 衛星
});
let state = load(LS_STATE, { raceStart: null, finishes: {} });  // 真實比賽紀錄
const saveCfg = () => save(LS_CFG, cfg);
const saveState = () => save(LS_STATE, state);

// ---------- 雲端同步（Supabase 的 team 函式） ----------
// 隊伍密碼從隊友連結的 #k=… 帶進來，存在這支手機；管理員密碼只有隊長手機有
const API = 'https://ifeclpphlctouqfzbdsb.supabase.co/functions/v1/team';
const LS_KEY = LS_PRE + 'crufu.key.v1', LS_PIN = LS_PRE + 'crufu.pin.v1', LS_PEND = LS_PRE + 'crufu.pending.v1';
const SHARED = ['planStart', 'paces', 'names', 'order', 'assign', 'sub', 'testPoint'];   // 全隊共用、只有管理員能改的設定
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* 存不了就算了 */ } };
const sync = { key: lsGet(LS_KEY), pin: lsGet(LS_PIN), admin: false, ok: false, err: '', last: 0,
  cfgAt: null, since: null, busy: false, again: false, cfgDirty: false, loc: {} };
let pending = [];                          // 離線時按的交棒，連上後依序補送
try { pending = JSON.parse(localStorage.getItem(LS_PEND)) || []; } catch (e) { pending = []; }
const savePending = () => lsSet(LS_PEND, pending.length ? JSON.stringify(pending) : '');
// iPhone 的「加入主畫面」版和 Safari 版存檔是分開的：Safari 裡把隊伍密碼留在網址上，加入主畫面時一起帶過去
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function keepHashForIOS() {
  const h = sync.key && isIOS && !isStandalone && !window.CRUFU_SIM
    ? `#k=${encodeURIComponent(sync.key)}${cfg.me ? `&me=${cfg.me}` : ''}` : '';
  history.replaceState(null, '', location.pathname + location.search + h);
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const got = h.get('k') && !window.CRUFU_SIM;
  if (got) {
    sync.key = h.get('k'); lsSet(LS_KEY, sync.key);
    // 網址上的號碼只給 iPhone 主畫面版用（從 Safari 加入主畫面時帶過去）；
    // 一般瀏覽器不採用，免得有人從網址列複製連結分享，大家都變成同一個人
    if (isIOS && isStandalone && /^(10|[1-9])$/.test(h.get('me') || '')) { cfg.me = +h.get('me'); saveCfg(); }
  }
  if (location.hash) keepHashForIOS();
  return got;
}
readHash();
// iOS 26 主畫面版畫面高度被算短：量出跟螢幕差多少，補到 --ios-gap（底部導覽列往下貼齊）
function fixIosGap() {
  if (!isIOS || !isStandalone) return;
  const portrait = innerHeight > innerWidth;
  const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const gap = full - innerHeight;
  window.iosGap = gap;                       // 只記錄，管理工具顯示用（往下補會被切掉，已撤掉）
}
fixIosGap();
addEventListener('resize', fixIosGap);
addEventListener('orientationchange', () => setTimeout(fixIosGap, 300));
const canEdit = () => !sync.key || sync.admin;

async function api(op, body = {}) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, key: sync.key, pin: sync.pin || undefined, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `連線錯誤 ${r.status}`), { status: r.status });
  return j;
}
async function pushConfig() {
  sync.cfgDirty = false;
  try { await api('config', { data: Object.fromEntries(SHARED.map(k => [k, cfg[k]])) }); }
  catch (e) { sync.cfgDirty = true; throw e; }
}
// 改了共用設定：存本機，管理員再推上雲端
let pushTimer;
function sharedChanged() {
  saveCfg();
  if (!sync.key) return;
  sync.cfgDirty = true;
  clearTimeout(pushTimer); pushTimer = setTimeout(doSync, 800);
}
async function doSync() {
  if (!sync.key) return;
  if (sync.busy) { sync.again = true; return; }
  sync.busy = true;
  try {
    while (pending.length) {
      try { await api(pending[0].op, pending[0]); }
      catch (e) { if (e.status !== 400) throw e; }   // 參數錯誤的那筆丟掉，不要卡住後面
      pending.shift(); savePending();
    }
    if (sync.cfgDirty && sync.admin) await pushConfig();
    const j = await api('sync', { since: sync.since || undefined });
    Object.assign(sync, { admin: j.admin, ok: true, err: '', last: Date.now(), watchAt: j.watchAt || null });
    if (j.config) {
      if (j.config.updated_at !== sync.cfgAt && !sync.cfgDirty) {
        SHARED.forEach(k => { if (j.config.data[k] !== undefined) cfg[k] = j.config.data[k]; });   // null 也要套用（例如取消測試交接點）
        sync.cfgAt = j.config.updated_at; saveCfg();
      }
    } else if (sync.admin) await pushConfig();     // 雲端還沒有設定：用管理員手機上的設定當初始值
    const st = { raceStart: null, finishes: {} };
    j.events.forEach(e => { const t = Date.parse(e.at); if (e.leg === 0) st.raceStart = t; else st.finishes[e.leg] = t; });
    state = st; saveState();
    if (st.raceStart && cfg.demo) { cfg.demo = false; saveCfg(); toast('比賽已開跑，自動關閉示範模式'); }
    else if (cfg.demo && !cfg.demoChosen) { cfg.demo = false; saveCfg(); }   // 已連上隊伍：預設看真實資料
    j.locations.forEach(addLoc);
    autoHandoff();
    sync.since = j.locations.length ? j.locations[j.locations.length - 1].received_at : (sync.since || j.now);
  } catch (e) {
    sync.ok = false; sync.err = e.message;
  } finally {
    sync.busy = false;
    if (sync.again) { sync.again = false; setTimeout(doSync, 0); }
  }
  if (!document.getElementById('sheet-bg').classList.contains('open')) render();
  else refreshSetup();
  if (sync.ok && !cfg.setupDone && !setupShown && !window.CRUFU_SIM && !document.getElementById('sheet-bg').classList.contains('open')) {
    setupShown = true; openSetup();
  }
}
// 交棒、取消交棒：先改本機畫面，再排進待送清單（沒訊號也不會丟）
function record(op, leg, at) {
  if (op === 'finish') { if (leg === 0) state.raceStart = at; else state.finishes[leg] = at; }
  else delete state.finishes[leg];
  saveState();
  if (!sync.key) return;
  pending.push({ op, leg, at: at ? new Date(at).toISOString() : undefined, by: cfg.me ? String(cfg.me) : '' });
  savePending(); doSync();
}
// ---------- GPS 自動交棒 ----------
// 跑者 GPS 剩 500 m → 全隊手機提醒下一棒準備；進到終點 80 m 內 → 自動記錄完成（時間用 GPS 到點那一刻）
// 伺服器的 watch 函式有在跑時由伺服器做（鎖屏也有推播），這裡只是備援；只看 20 分鐘內的點；同一棒每支手機只自動一次，判斷錯了到棒次頁「取消這棒的完成紀錄」，不會再被自動補回
// 跑者手機沒回報 GPS 時，照樣用手動按鈕
const AUTO_NEAR_KM = 0.5, AUTO_ARRIVE_KM = 0.08, LS_AUTO = LS_PRE + 'crufu.auto.v1';
let autoSeen = {};                          // {棒次: 'near'|'done'}
try { autoSeen = JSON.parse(localStorage.getItem(LS_AUTO)) || {}; } catch (e) { autoSeen = {}; }
const saveAuto = () => lsSet(LS_AUTO, JSON.stringify(autoSeen));
const buzz = () => { try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* 不支援震動就算了 */ } };
const serverWatch = () => !!sync.watchAt && Date.now() - Date.parse(sync.watchAt) < 3 * 60e3;
function autoHandoff() {
  if (cfg.demo || !sync.key || serverWatch()) return;
  if (autoSeen._start !== state.raceStart) { autoSeen = { _start: state.raceStart }; saveAuto(); }   // 重新開跑（例如測試後清除紀錄）就重算
  const now = nowMs(), sch = schedule(now, raceState(now)), s = sch.find(x => x.status === 'run');
  if (!s || autoSeen[s.n] === 'done') return;
  const nx = sch[s.n];
  for (const p of sync.loc[String(s.runner)] || []) {
    if (p.t < s.start + 60e3 || now - p.t > 20 * 60e3) continue;
    const sn = snapKm(p.lat, p.lon, s.L.endKm - 1.5, s.L.endKm + 0.3);
    if (!sn || sn.off > 150) continue;
    const left = s.L.endKm - sn.km;
    if (left <= AUTO_ARRIVE_KM) {
      autoSeen[s.n] = 'done'; saveAuto();
      record('finish', s.n, p.t); buzz();
      toast(nx ? `GPS 到點：第 ${s.n} 棒 ${runnerName(s.runner)} 自動交棒給 ${runnerName(nx.runner)}` : 'GPS 到點：完賽！🎉');
      return;
    }
    if (left <= AUTO_NEAR_KM && !autoSeen[s.n]) {
      autoSeen[s.n] = 'near'; saveAuto(); buzz();
      toast(`${runnerName(s.runner)} 剩約 ${Math.max(100, Math.round(left * 10) * 100)} m${nx ? `，下一棒 ${runnerName(nx.runner)} 準備` : ' 到終點'}`);
    }
  }
}
// ---------- 推播通知（伺服器的 watch 函式送出；手機鎖屏也收得到） ----------
const VAPID_PUBLIC = 'BG_mXvYI_n0yLNdII27wUN-YocjTuRKt3eKr0NfIlWUjmVZ6OTsNIHgxzt3yiI54fOyE8_4Ej9oIbE31yW6-8to';
const WATCH_API = API.replace(/team$/, 'watch');
const pushOK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const push = { state: 'checking', endpoint: '' };   // checking／on／off／denied／need-install（iPhone 要先加入主畫面）／unsupported
let swReg = null;
const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function pushInit() {
  if (window.CRUFU_SIM) { push.state = 'unsupported'; return; }
  if (!pushOK) { push.state = isIOS && !isStandalone ? 'need-install' : 'unsupported'; return; }
  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    const sub = await swReg.pushManager.getSubscription();
    push.endpoint = sub ? sub.endpoint : '';
    push.state = Notification.permission === 'denied' ? 'denied' : sub ? 'on' : 'off';
    if (sub && sync.key) api('subscribe', { sub: sub.toJSON(), person: cfg.me || '' }).catch(() => {});   // 順便更新「我是幾號」
  } catch (e) { push.state = 'unsupported'; }
}
async function enablePush() {
  if (!sync.key) throw new Error('請先用隊友連結連上隊伍');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { push.state = perm === 'denied' ? 'denied' : 'off'; throw new Error('沒有允許通知'); }
  swReg = swReg || await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = await swReg.pushManager.getSubscription()
    || await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(VAPID_PUBLIC) });
  await api('subscribe', { sub: sub.toJSON(), person: cfg.me || '' });
  push.endpoint = sub.endpoint; push.state = 'on';
}
async function disablePush() {
  const sub = swReg && await swReg.pushManager.getSubscription();
  if (sub) { await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  push.endpoint = ''; push.state = 'off';
}
async function testPush() {
  const r = await fetch(WATCH_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: sync.key, op: 'test', endpoint: push.endpoint }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `送出失敗（${j.status || r.status}）`);
}
// 通知說明：條列，每項 20 字內
const tips = (title, items) => `<div class="muted" style="font-size:13px;padding-top:8px"><b>${title}</b>
  <ul style="margin:4px 0 0;padding-left:20px;line-height:1.7">${items.map(t => `<li>${t}</li>`).join('')}</ul></div>`;
// 耳機語音朗讀：手機系統的設定，網頁沒辦法代開，第一次使用設定時帶大家打開
const voiceCard = os => `<div class="card">${tips('跑步時用耳機聽通知', os === 'android'
  ? ['開啟 Google 助理設定', '找到朗讀通知並打開', '各品牌位置略有不同']
  : ['開啟手機設定', '點通知再點朗讀通知', '打開朗讀通知', '下方清單中打開 CRUFU', '只支援 AirPods 和 Beats 耳機'])}</div>`;
function pushCard(setup) {
  const st = push.state;
  const body = st === 'on' && setup ? `<div>✅ 通知已開啟</div>
      <button class="btn" data-act="push-test" style="margin-top:10px">傳測試通知給自己</button>
      ${tips('測試方法', ['按下按鈕後馬上鎖螢幕', '幾秒內跳出測試通知就成功', '沒收到請到手機設定開啟通知'])}`
    : st === 'on' ? `<div class="kv"><span>✅ 已開啟</span><span><button class="chip plain" data-act="push-test">傳測試通知</button> <button class="chip plain" data-act="push-off">關閉</button></span></div>`
    : st === 'off' ? `<button class="btn" data-act="push-on">開啟通知</button>`
    : st === 'denied' ? tips('通知被封鎖', isIOS ? ['到手機設定的通知', '把 CRUFU 改成允許', '回來重新整理'] : ['到 Chrome 網站設定', '把這個網站改成允許通知', '回來重新整理'])
    : st === 'need-install' ? tips('iPhone 要先加入主畫面', ['按 Safari 下方分享按鈕', '選加入主畫面', '從主畫面 CRUFU 圖示打開', '再回來按開啟通知', '需要 iOS 16.4 以上'])
    : st === 'checking' ? '<div class="muted">檢查中…</div>'
    : tips('這個瀏覽器不支援通知', ['Android 請用 Chrome 打開', 'iPhone 請用 Safari 打開', 'iPhone 要 iOS 16.4 以上']);
  return `<div class="card">${body}
    ${setup ? '' : tips('什麼時候會通知', ['跑者剩 500 公尺', '自動交棒完成', '跑者停留超過 3 分鐘', '收不到跑者位置', '手機鎖螢幕也收得到', '自己跑時只收剩 500 公尺和交棒'])}</div>`;
}

// ---------- 第一次使用設定：我是誰 → OwnTracks 定位 → 通知 ----------
const OT_STORE = { ios: 'https://apps.apple.com/app/owntracks/id692424691', android: 'https://play.google.com/store/apps/details?id=org.owntracks.android' };
let otCfg = null, setupShown = false;
function myLoc() { const a = cfg.me && sync.loc[String(cfg.me)]; return a && a[a.length - 1]; }
function openSetup() {
  sheetLeg = null;
  const me = cfg.me, loc = myLoc(), locOk = loc && Date.now() - loc.t < 10 * 60e3;
  const os = cfg.os || (isIOS ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : '');
  const osBtn = (v, t) => `<button class="btn ${os === v ? '' : 'ghost'}" data-act="set-os" data-os="${v}">${t}</button>`;
  const ios = os === 'ios';
  const guide = !os ? '<div class="muted" style="margin-top:10px">先選你的手機系統 ↑</div>' : `
    <div style="margin-top:12px"><b>1. 安裝 OwnTracks</b>（裝過的跳過）</div>
    <a class="btn ghost" href="${OT_STORE[os]}" target="_blank" rel="noopener">${ios ? 'App Store' : 'Play 商店'} 安裝 OwnTracks</a>
    <div style="margin-top:12px"><b>2. 先打開 OwnTracks 一次</b>，它會要權限：</div>
    <div>· 位置：選${ios ? '<b>「使用 App 期間」</b>' : '<b>「僅在使用該應用程式時允許」</b>'}，「精確位置」要打開</div>
    <div>· 通知：允許（OwnTracks 自己的，不影響我們的提醒）</div>
    <div>· 出現說明頁按「下一步／Next」到底就好，<b>裡面的設定都不用填</b></div>
    <div style="margin-top:6px">· <b>打開「允許外部設定」</b>（不開的話下一步會出現 not allowed）：${ios
      ? 'OwnTracks 進到 <b>Settings</b> → 滑到最下面 <b>Remote Control</b> → 打開 <b>Allow external configuration</b>'
      : 'OwnTracks 選單 → <b>Preferences／設定</b> → 找到 <b>Allow external configuration</b>（或含 external configuration 字樣的選項）→ 打開'}</div>
    <div style="margin-top:12px"><b>3. 回到這個畫面</b>，按這顆（會自動跳到 OwnTracks 並帶入設定）：</div>
    <button class="btn" data-act="ot-setup">一鍵設定 OwnTracks</button>
    <div style="margin-top:6px">${ios ? '跳出「匯入設定？」之類的視窗按<b>「OK／匯入」</b>；沒跳視窗也沒關係，代表已直接套用'
      : '會看到一頁設定內容，按右上角的<b>「匯入／Import」</b>（打勾或下載圖示，或在 ⋮ 選單裡）'}</div>
    <div style="margin-top:12px"><b>4. 記住用法：打開 OwnTracks＝上線，關掉＝下線</b></div>
    <div>· 開著時隊友看得到你；<b>縮小、關螢幕都沒關係</b>，一樣會回報</div>
    <div>· 不想被看到時，從多工畫面把 OwnTracks 滑掉就下線了</div>
    <div>· <b>比賽當天整場都要開著</b>，跑到一半被關掉，全隊會收到「⚠ 收不到位置」</div>
    ${ios ? '' : '<div>· Android 建議到 <b>設定 → 應用程式 → OwnTracks → 電池</b> 選「不限制」，免得被省電功能關掉</div>'}
    <div style="margin-top:12px"><b>5. 回到這個畫面，拿著手機走動一下</b>，1～2 分鐘內上面會變成 ✅</div>
    <div class="muted" style="font-size:12px;margin-top:6px">一鍵設定沒反應？<button class="chip plain" data-act="ot-manual">改用手動設定</button></div>
    <div id="ot-manual"></div>`;
  const step = (ok, t) => `<h2>${ok ? '✅' : '⬜'} ${t}</h2>`;
  openSheet(`<div class="sheet-head" id="setup-sheet"><h3>第一次使用設定</h3><button data-act="close">稍後</button></div>
    <p class="muted" style="font-size:13px;margin-top:0">照步驟做完，隊友就看得到你的位置，比賽中的提醒你也收得到。</p>
    ${step(!!me, '① 你是誰')}
    <div class="card"><div class="kv"><span>我是</span><select data-act="set-me"><option value="">請選擇</option>${RUNNERS.map(r => `<option value="${r}" ${r === me ? 'selected' : ''}>${r} 號 · ${runnerName(r)}</option>`).join('')}</select></div></div>
    ${step(locOk, '② 定位（OwnTracks）')}
    <div class="card" style="font-size:14px;line-height:1.7">
      ${locOk ? `<div>✅ 已收到你的位置（${agoText(loc.t)}）</div>` : `<div class="muted">${me ? '還沒收到你的位置，照下面做：' : '先完成第 ① 步'}</div>`}
      ${me && !locOk ? `<div style="margin-top:8px">你的手機是：</div><div class="btn-row" style="margin-top:6px">${osBtn('ios', 'iPhone')}${osBtn('android', 'Android')}</div>${guide}` : ''}
    </div>
    ${step(push.state === 'on', '③ 通知')}
    ${pushCard(true)}
    ${push.state === 'on' ? `<h2>🎧 ④ 耳機語音</h2>${voiceCard(os)}` : ''}
    <button class="btn" data-act="setup-done" style="margin-top:14px">完成</button>`);
}
function refreshSetup() {
  if (!document.getElementById('setup-sheet')) return;
  const sh = document.getElementById('sheet'), y = sh.scrollTop;
  openSetup(); sh.scrollTop = y;
}
async function getOtCfg() {
  if (!otCfg || otCfg.deviceId !== String(cfg.me)) otCfg = (await api('otconfig', { person: String(cfg.me) })).config;
  return otCfg;
}

function syncStatus() {
  if (!sync.key) return '<span class="slow">未連線（只存在這支手機）</span>';
  const p = pending.length ? ` · ${pending.length} 筆待送` : '';
  if (sync.ok) return `<span class="fast">已連線</span> · ${fmtT(sync.last)} 更新${p}`;
  return `<span class="slow">${esc(sync.err || '連線中…')}</span>${p}`;
}

// ---------- GPS（OwnTracks 回報；person＝號碼，車上手機用 car1／car2） ----------
const GPS_FRESH = 5 * 60e3;                // 超過 5 分鐘沒回報就改回推估
function addLoc(r) {
  const a = (sync.loc[r.person] ||= []);
  a.push({ t: Date.parse(r.recorded_at), lat: r.lat, lon: r.lon, batt: r.batt });
  a.sort((x, y) => x.t - y.t);
  const cut = Date.now() - 40 * 60e3;
  while (a.length > 1 && a[0].t < cut) a.shift();
}
// 把 GPS 點投影到路線（k0–k1 公里範圍內的線段），回傳公里數與離路線的距離（公尺）
function snapKm(lat, lon, k0, k1) {
  const cx = 111320 * Math.cos(lat * Math.PI / 180), cy = 110540;
  let best = null;
  for (let i = 1; i < T.length; i++) {
    const a = T[i - 1], b = T[i];
    if (b[2] < k0 || a[2] > k1) continue;
    const ax = (a[1] - lon) * cx, ay = (a[0] - lat) * cy, bx = (b[1] - lon) * cx, by = (b[0] - lat) * cy;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const f = L2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + f * dx, ay + f * dy);
    if (!best || d < best.off) best = { off: d, km: a[2] + f * (b[2] - a[2]) };
  }
  return best;
}
// 跑步中那棒的 GPS：位置、本棒進度、目前配速（近 5 分鐘）、本棒平均配速；沒有新鮮資料回傳 null
function gpsOf(s, now) {
  if (cfg.demo || !sync.key) return null;
  const a = sync.loc[String(s.runner)];
  const last = a && a[a.length - 1];
  if (!last || now - last.t > GPS_FRESH || last.t < s.start) return null;
  const k0 = s.L.startKm - 0.5, k1 = s.L.endKm + 0.5;
  const sn = snapKm(last.lat, last.lon, k0, k1);
  const g = { pos: [last.lat, last.lon], t: last.t, batt: last.batt, off: !sn || sn.off > 300 };
  if (g.off) return g;
  g.km = Math.min(s.L.endKm, Math.max(s.L.startKm, sn.km));
  g.frac = (g.km - s.L.startKm) / s.L.km;
  const okPace = p => p > 150 && p < 1200 ? p : null;      // 2:30～20:00/km 以外當成雜訊
  const first = a.find(p => p.t >= last.t - 5 * 60e3 && p.t >= s.start);
  if (first && first !== last) {
    const f = snapKm(first.lat, first.lon, k0, k1);
    if (f && f.off < 300 && g.km - f.km > 0.15) g.pace = okPace((last.t - first.t) / 1000 / (g.km - f.km));
  }
  const done = g.km - s.L.startKm;
  if (done > 0.3) g.avg = okPace((last.t - s.start) / 1000 / done);
  return g;
}
const agoText = t => { const m = Math.round((nowMs() - t) / 60000); return m < 1 ? '剛剛' : `${m} 分鐘前`; };

// ---------- 格式 ----------
const fmtT = ms => new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
function fmtDT(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
// 倒數：超過一天顯示「N 天 H 時」，一天內顯示時:分:秒
function fmtCountdown(sec) {
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天 ${Math.floor(sec % 86400 / 3600)} 時`;
  return fmtDur(sec);
}
function fmtLong(sec) {
  if (sec < 0) return '0 分';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} 天 ${h} 小時` : h ? `${h} 小時 ${m} 分` : `${m} 分`;
}
const fmtPace = s => { s = Math.round(s); return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`; };
function parsePace(str) {
  const m = String(str).trim().match(/^(\d{1,2})[:'’](\d{1,2})"?$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function fmtDelta(ms) {
  const m = Math.round(ms / 60000);
  if (Math.abs(m) < 1) return '<span>準時</span>';
  return m < 0 ? `<span class="fast">快 ${-m} 分</span>` : `<span class="slow">慢 ${m} 分</span>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const runnerName = r => cfg.names[r] ? esc(cfg.names[r]) : `${r} 號`;
// 導航：用 Google 地圖開車路線到指定座標
// 導航圖示：一般導航 app 常見的斜箭頭
const NAV_ICON = '<svg class="nav-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 3L3 10.5l7.2 2.3L12.5 20z"/></svg>';
const navUrl = ([lat, lon]) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

// ---------- 配速模型：坡度修正 ----------
// 上坡每 1% 慢約 3.5%；下坡每 1% 快約 1.8%，最多快 12%
const gradeFactor = g => g >= 0 ? 1 + 3.5 * g : Math.max(0.88, 1 + 1.8 * g);
// 每棒的「等效平地公里數」：乘上平地配速就是預估用時
const effKm = D.legs.map(L => {
  let e = 0;
  for (let i = 1; i < T.length; i++) {
    const a = T[i - 1], b = T[i];
    const lo = Math.max(a[2], L.startKm), hi = Math.min(b[2], L.endKm);
    if (hi <= lo) continue;
    const seg = b[2] - a[2];
    e += (hi - lo) * gradeFactor(seg > 0 ? (b[3] - a[3]) / (seg * 1000) : 0);
  }
  return e;
});

const runnerOf = n => cfg.assign[n] || cfg.order[(n - 1) % 10];
const carOfRunner = r => cfg.order.indexOf(r) < 5 ? 1 : 2;
const carOf = n => ((n - 1) % 10) < 5 ? 1 : 2;
const legSec = n => effKm[n - 1] * cfg.paces[runnerOf(n)] + OVERHEAD_SEC;
const isNight = (a, b) => b > Date.parse(D.nightStart) && a < Date.parse(D.nightEnd);

// ---------- 時間軸 ----------
const demoNoise = n => Math.sin(n * 12.9898) * 0.07;   // 示範用：每棒固定的 ±7% 快慢
function nowMs() { return cfg.demo ? Date.parse(cfg.planStart) + cfg.demoHours * 3600e3 : Date.now(); }
function raceState(now) {
  if (!cfg.demo) return state;
  const ps = Date.parse(cfg.planStart);
  if (now < ps) return { raceStart: null, finishes: {} };
  const st = { raceStart: ps, finishes: {} };
  let t = ps;
  for (const L of D.legs) {
    const d = legSec(L.n) * (1 + demoNoise(L.n)) * 1000;
    if (t + d > now) break;
    t += d; st.finishes[L.n] = t;
  }
  return st;
}

// 每棒的預定時間（照計畫）與目前推估時間（有實際交棒就用實際）
function schedule(now, st) {
  let tPlan = Date.parse(cfg.planStart);
  let prevEnd = st.raceStart ?? tPlan;
  let prevDone = st.raceStart != null;
  return D.legs.map(L => {
    const n = L.n, dur = legSec(n) * 1000;
    const planStart = tPlan, planEnd = tPlan + dur;
    tPlan = planEnd;
    const start = prevEnd;
    let end, status;
    if (prevDone && st.finishes[n] != null) { end = st.finishes[n]; status = 'done'; }
    else if (prevDone) {
      status = 'run'; prevDone = false;
      const g = gpsOf({ runner: runnerOf(n), start, L }, now);
      const pace = g && !g.off && (g.avg || g.pace);
      end = pace ? Math.max(now + 60e3, g.t + ((L.endKm - g.km) * pace + OVERHEAD_SEC) * 1000)
                 : Math.max(start + dur, now + 60e3);
    }
    else { end = start + dur; status = 'todo'; }
    prevEnd = end;
    return { L, n, runner: runnerOf(n), car: carOf(n), dur, planStart, planEnd, start, end, status };
  });
}

// 進行中那棒：推估完成比例與所在公里數（之後有 GPS 就改用實際位置）
// 進度條：圖示站在條上，跟著進度往前移。個人用奔跑小人，全隊用一台車（跑步中那棒所屬的車）
const pctW = f => Math.min(100, Math.max(0, f * 100)).toFixed(1);
const figBar = (frac, src, cls) => `<div class="fig-bar ${cls}"><div class="bar"><i style="width:${pctW(frac)}%"></i></div><img src="${src}" alt="" style="left:${pctW(frac)}%"></div>`;
const avBar = (frac, r) => figBar(frac, `icons/run${r}.png`, 'runner');
function carsBar(sch, now) {
  const run = sch.find(s => s.status === 'run'), next = sch.find(s => s.status === 'todo');
  const km = run ? run.L.startKm + run.L.km * progressOf(run, now).frac : Math.max(0, ...sch.filter(s => s.status === 'done').map(s => s.L.endKm));
  const car = (run || next || sch[sch.length - 1]).car;
  return figBar(km / D.totalKm, `icons/car${car}-cut.png`, 'car');
}
function progressOf(s, now) {
  const g = gpsOf(s, now);
  if (g && !g.off) return { frac: Math.min(0.99, g.frac), km: g.km, g };
  const frac = Math.min(0.99, Math.max(0, (now - s.start) / s.dur));
  return { frac, km: s.L.startKm + frac * s.L.km, g };
}
function posAtKm(km) {
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m][2] <= km) lo = m; else hi = m; }
  const a = T[lo], b = T[hi], f = b[2] > a[2] ? (km - a[2]) / (b[2] - a[2]) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// 兩車輪班：每 5 棒一段，Car1 跑每輪第 1–5 棒、Car2 跑第 6–10 棒
// 空檔＝本車交出最後一棒到本車下一段第一棒起跑；這段時間要開車移動到下個起點
function blocks(sch) {
  return [0, 1, 2, 3, 4, 5].map(b => {
    const legs = sch.slice(b * 5, b * 5 + 5), last = legs[4], next = sch[b * 5 + 10];
    const status = legs.every(s => s.status === 'done') ? 'done' : legs.some(s => s.status !== 'todo') ? 'run' : 'todo';
    return { car: b % 2 ? 2 : 1, legs, start: legs[0].start, end: last.end, status, next,
      idle: next ? next.start - last.end : null };
  });
}

// 棒次表檢查。大會規定：每人跑 3 棒、每輪剛好一棒；受傷時剩餘棒次可由隊友代跑
// errors＝違反規定；warns＝合規但要注意（代跑、跨輪連續跑）
function checkAssign() {
  const errors = [], warns = [];
  for (let r = 0; r < 3; r++) {
    const legsOf = {}, hasSub = Array.from({ length: 10 }, (_, i) => r * 10 + i + 1).some(n => cfg.sub[n]);
    for (let i = 1; i <= 10; i++) { const n = r * 10 + i; (legsOf[runnerOf(n)] ||= []).push(n); }
    for (const p of RUNNERS) {
      const c = legsOf[p] || [];
      const list = hasSub ? warns : errors;
      if (!c.length) list.push(`第 ${r + 1} 輪沒有排到 ${runnerName(p)}`);
      if (c.length > 1) list.push(`${runnerName(p)} 在第 ${r + 1} 輪跑了 ${c.length} 棒（第 ${c.join('、')} 棒）`);
    }
  }
  for (let n = 1; n < 30; n++) if (runnerOf(n) === runnerOf(n + 1)) warns.push(`${runnerName(runnerOf(n))} 連續跑第 ${n}、${n + 1} 棒，中間沒有休息`);
  Object.keys(cfg.sub).forEach(n => warns.push(`第 ${n} 棒是受傷代跑（${runnerName(runnerOf(+n))}）`));
  return { errors, warns };
}
const setAssign = (n, v) => { if (v === cfg.order[(n - 1) % 10]) delete cfg.assign[n]; else cfg.assign[n] = v; };
// 改單棒跑者：一般情況和同一輪的另一棒對調（保持每輪每人一棒）；代跑模式直接換人
// 已開跑或已完成的棒次不能改
function assignLeg(n, v, sub) {
  const sch = schedule(nowMs(), raceState(nowMs())), r0 = Math.floor((n - 1) / 10) * 10, old = runnerOf(n);
  if (sch[n - 1].status !== 'todo') return toast('這棒已經開跑，不能改');
  if (!sub) {
    const m = sch.slice(r0, r0 + 10).find(s => s.n !== n && s.runner === v);
    if (m && m.status !== 'todo') return toast(`${runnerName(v)} 本輪已經跑過，只能用受傷代跑`);
    if (m) { setAssign(m.n, old); delete cfg.sub[m.n]; toast(`第 ${n} 棒和第 ${m.n} 棒的跑者對調`); }
  }
  setAssign(n, v);
  if (sub) cfg.sub[n] = true; else delete cfg.sub[n];
  sharedChanged();
}

// ---------- 共用元件 ----------
function chips(s) {
  const L = s.L;
  return `<span class="chip ${L.level}">${L.level}</span>`
    + (isNight(s.start, s.end) ? ' <span class="chip plain">🌙 夜間</span>' : '')
    + (L.tunnel ? ' <span class="chip plain">隧道</span>' : '')
    + (L.n > 1 && L.n % 5 === 1 ? ' <span class="chip plain">換車</span>' : '');
}
function elevSvg(a, b) {
  const pts = T.filter(p => p[2] >= a - 1e-6 && p[2] <= b + 1e-6);
  if (pts.length < 2) return '';
  const W = 600, H = 110, padB = 4;
  const eles = pts.map(p => p[3]), lo = Math.min(...eles) - 10, hi = Math.max(...eles) + 10;
  const x = km => (km - a) / (b - a) * W, y = e => H - padB - (e - lo) / (hi - lo) * (H - 20);
  const xy = p => `${x(p[2]).toFixed(1)},${y(p[3]).toFixed(1)}`;
  const line = pts.map(xy).join(' ');
  // 單色高度剖面，只把陡上坡（> 5%）塗紅
  let steep = '';
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], g = (q[3] - p[3]) / Math.max(1, (q[2] - p[2]) * 1000);
    if (g > 0.05) steep += `<polygon points="${x(p[2]).toFixed(1)},${H} ${xy(p)} ${xy(q)} ${x(q[2]).toFixed(1)},${H}" fill="#ef4444" opacity=".8"/>`;
  }
  return `<svg class="elev" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="${x(pts[0][2]).toFixed(1)},${H} ${line} ${x(pts[pts.length - 1][2]).toFixed(1)},${H}" fill="#3b82f6" opacity=".3"/>${steep}
    <polyline points="${line}" fill="none" stroke="#93c5fd" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <text x="4" y="14" fill="#a8adb7" font-size="13">${Math.round(hi - 10)} m</text>
    <text x="4" y="${H - 8}" fill="#a8adb7" font-size="13">${Math.round(lo + 10)} m</text></svg>
    <div class="muted" style="font-size:12px;margin-top:4px"><b style="color:#ef4444">紅色</b>＝陡上坡（坡度超過 5%）</div>`;
}
// 夜間棒提醒（大會規定，違規整隊取消資格）
function nightBox(s) {
  if (!isNight(s.start, s.end)) return '';
  return `<div class="night">🌙 <b>夜間棒</b>（${fmtT(Date.parse(D.nightStart))}～隔天 ${fmtT(Date.parse(D.nightEnd))}）：跑者穿<b>反光背心</b>、戴<b>頭燈</b>、開<b>尾燈</b>，違規會整隊取消資格。在接力點等候的隊友也要穿反光背心。</div>`;
}
function demoBar() {
  const tp = cfg.testPoint && !cfg.demo
    ? `<div class="demo-bar"><span>🧪 測試交接點啟用中：自動交棒以「${fmtDT(cfg.testPoint.at)} 設定的位置」為終點，正式比賽前要取消</span><button data-act="${sync.admin ? 'admin' : 'settings'}">${sync.admin ? '管理' : '設定'}</button></div>` : '';
  if (!cfg.demo) return tp;
  return `<div class="demo-bar"><span>示範模式：模擬時間 ${fmtDT(nowMs())}，交棒紀錄是假的</span><button data-act="settings">調整</button></div>`;
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.style.display = 'none'; }, 2200);
}

// ---------- 分頁：我 ----------
function renderMe(now, sch) {
  const el = document.getElementById('tab-me'), st = raceState(now);
  if (!cfg.me) {
    el.innerHTML = `${demoBar()}<h1>你是幾號？</h1><p class="muted">選了之後，這頁會顯示你的下一棒倒數與路況。之後可以在設定裡改。</p>
      <div class="pick">${RUNNERS.map(r => `<button data-act="pick-me" data-v="${r}">${r}</button>`).join('')}</div>`;
    return;
  }
  const mine = sch.filter(s => s.runner === cfg.me);
  const next = mine.find(s => s.status !== 'done');
  let hero = '';
  if (!mine.length) {
    hero = `<div class="hero idle"><div class="name">目前沒有排到你的棒次</div><div class="label">到「棒次」點任一棒可以改指派</div></div>`;
  } else if (!next) {
    hero = `<div class="hero idle"><div class="label">你的三棒都跑完了</div><div class="name">辛苦了 🎉</div></div>`;
  } else if (next.status === 'run') {
    const p = progressOf(next, now);
    hero = `<div class="hero car${next.car}">
      <div class="label">你正在跑 · 第 ${next.n} 棒 · Car${next.car}</div>
      <div class="big num" data-elapsed="${next.start}">${fmtDur((now - next.start) / 1000)}</div>
      ${avBar(p.frac, next.runner)}
      <div class="row"><span>推估 ${(p.frac * 100).toFixed(0)}% · ${(next.L.km * (1 - p.frac)).toFixed(1)} km 到交棒點</span><span>預計 ${fmtT(next.end)}</span></div>
      <button class="btn" data-act="finish" data-n="${next.n}">完成交棒</button></div>`;
  } else {
    const prev = sch[next.n - 2];
    hero = `<div class="hero car${next.car}">
      <div class="label">你的下一棒 · 第 ${next.n} 棒 · Car${next.car}</div>
      <div class="cd-row"><span class="cd-label">距離起跑還有</span><span class="big num" data-countdown="${next.start}">${fmtCountdown((next.start - now) / 1000)}</span></div>
      <div class="handoff">
        ${prev ? runnerFig(prev.runner, runnerName(prev.runner), prev.car) : '<div class="fig"><div class="bib start">起點</div></div>'}
        <svg class="handoff-arrow" viewBox="0 0 48 24" aria-hidden="true"><path d="M2 12h40M32 4l10 8-10 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${runnerFig(cfg.me, '我', next.car, true)}
      </div>
      <div class="handoff-time">推估 <b class="num">${fmtDT(next.start)}</b> 起跑</div>
      <div class="handoff-sub">${st.raceStart ? `比原計畫 ${fmtDelta(next.start - next.planStart)}` : `原計畫 ${fmtDT(next.planStart)}`} · 依配速與實際交棒推算</div></div>`;
  }
  const focus = next || mine[mine.length - 1];
  const legCard = focus ? `<div class="card">
      <div class="row"><b>第 ${focus.n} 棒</b><span>${chips(focus)}</span></div>
      <div class="muted" style="font-size:14px;margin-top:6px">${esc(focus.L.reason)}</div>
      <div class="stats">
        <div class="stat"><b>${focus.L.km.toFixed(2)}</b><span>公里</span></div>
        <div class="stat"><b style="color:var(--slow)">+${focus.L.gain}</b><span>爬升 m</span></div>
        <div class="stat"><b style="color:var(--low)">−${focus.L.loss}</b><span>下降 m</span></div>
      </div>
      ${nightBox(focus)}
      <div style="margin-top:12px">${elevSvg(focus.L.startKm, focus.L.endKm)}</div>
      <div class="kv"><span>平地配速（設定）</span><span class="num">${fmtPace(cfg.paces[cfg.me])}/km</span></div>
      <div class="kv"><span>坡度估算配速</span><span class="num">${fmtPace((focus.dur / 1000 - OVERHEAD_SEC) / focus.L.km)}/km</span></div>
      <div class="kv"><span>預計用時</span><span class="num">${fmtDur(focus.dur / 1000 - OVERHEAD_SEC)}</span></div>
    </div>` : '';
  const list = mine.map((s, i) => {
    const gap = i ? `<div class="muted" style="font-size:12px;margin:-2px 0 8px 8px">↑ 中間隔 ${s.n - mine[i - 1].n - 1} 棒，約 ${fmtLong((s.start - mine[i - 1].end) / 1000)}</div>` : '';
    return gap + legRow(s, now);
  }).join('');
  el.innerHTML = `${demoBar()}
    <div class="row"><h1>${runnerName(cfg.me)}</h1><button class="chip plain" data-act="settings">⚙ 設定</button></div>
    ${hero}${carTaskCard(sch)}${legCard}<h2>我的棒次</h2>${list}`;
}


// 交棒圖示：跑者像素小人（icons/run<號碼>.png）＋名牌（文字用該棒所屬車的顏色）
const runnerFig = (r, label, car, me) => `<div class="fig${me ? ' me' : ''}"><img src="icons/run${r}.png" alt=""><div class="bib" style="color:${CAR_COLOR[car]}">${esc(label)}</div></div>`;

// 本車任務：本車在跑就顯示下一個交接點；本車空檔就顯示下一個任務與剩餘時間
function carTaskCard(sch) {
  const myNext = sch.find(s => s.runner === cfg.me && s.status !== 'done');
  const car = myNext ? myNext.car : carOfRunner(cfg.me), other = 3 - car;
  const run = sch.find(s => s.status === 'run');
  const nextMine = sch.find(s => s.car === car && s.status !== 'done');
  if (!nextMine) return `<div class="card"><div class="row"><b>Car${car} 任務</b><span class="muted">本車棒次都完成了</span></div>
    <a class="btn ghost" style="margin-top:12px" href="${navUrl(D.legs[29].end)}" target="_blank" rel="noopener">${NAV_ICON} 導航到終點七星潭</a></div>`;
  let status, rows, dest, destName;
  if (run && run.car === car) {
    const nx = sch[run.n];                       // 下一棒（可能換車或已是終點）
    status = `本車跑步中 · 第 ${run.n} 棒 ${runnerName(run.runner)}`;
    dest = run.L.end;
    destName = !nx ? '終點七星潭' : nx.car === car ? `第 ${nx.n} 棒起點` : `第 ${run.n} 棒終點`;
    const back = sch[run.n + 5];                 // 換車後，本車下一段的第一棒
    rows = `<div class="kv"><span>下一個交接點</span><span>${destName}</span></div>
      <div class="kv"><span>預計抵達</span><span class="num">${fmtT(run.end)}（剩 <span data-countdown="${run.end}">${fmtCountdown((run.end - nowMs()) / 1000)}</span>）</span></div>`
      + (!nx ? '' : nx.car === car
        ? `<div class="kv"><span>接棒</span><span>${runnerName(nx.runner)}</span></div>`
        : `<div class="kv"><span>交棒後</span><span>交給 Car${other}，本車${back ? `空檔約 <b>${fmtLong((back.start - run.end) / 1000)}</b>` : '任務結束'}</span></div>`);
  } else {
    status = run ? `本車空檔中 · Car${other} 在跑` : '尚未開跑';
    dest = nextMine.L.start;
    destName = `第 ${nextMine.n} 棒起點`;
    rows = `<div class="kv"><span>下一個任務</span><span>${destName} · ${runnerName(nextMine.runner)} 起跑</span></div>
      <div class="kv"><span>預計起跑</span><span class="num">${fmtDT(nextMine.start)}</span></div>
      <div class="kv"><span>剩餘</span><span class="num"><b data-countdown="${nextMine.start}">${fmtCountdown((nextMine.start - nowMs()) / 1000)}</b></span></div>`;
  }
  return `<div class="card"><div class="row"><b><span class="dot car${car}"></span>Car${car} 任務</b><span class="muted" style="font-size:13px">${status}</span></div>
    ${rows}<a class="btn ghost" style="margin-top:12px" href="${navUrl(dest)}" target="_blank" rel="noopener">${NAV_ICON} 導航到${destName}</a></div>`;
}

// ---------- 分頁：棒次 ----------
function legRow(s, now) {
  let right;
  if (s.status === 'done') right = `<div class="num">${fmtT(s.start)}–${fmtT(s.end)}</div><div class="t">${fmtDur((s.end - s.start) / 1000)}</div>`;
  else if (s.status === 'run') right = `<div><b>跑步中</b></div><div class="t">預計 ${fmtT(s.end)}</div>`;
  else right = `<div class="num">${fmtT(s.start)}</div><div class="t">預計起跑</div>`;
  // 右側小導航鍵：直接開 Google 地圖到這棒起點（點列的其他地方開詳情）
  return `<div class="leg ${s.status}${s.runner === cfg.me ? ' mine' : ''}" data-act="leg" data-n="${s.n}" role="button">
    <div class="badge car${s.car}">${s.n}</div>
    <div class="mid"><div><b>${runnerName(s.runner)}</b> ${chips(s)}</div><div class="t">${s.L.km.toFixed(1)} km · +${s.L.gain}/−${s.L.loss} m</div></div>
    <div class="right">${right}</div>
    ${s.status === 'done' ? '' : `<a class="nav-mini" href="${navUrl(s.L.start)}" target="_blank" rel="noopener" aria-label="導航到第 ${s.n} 棒起點">${NAV_ICON}</a>`}</div>`;
}
// 兩車輪班與空檔
function shiftCard(sch) {
  const rows = blocks(sch).map(k => {
    const tag = k.status === 'done' ? ' <span class="chip plain">完成</span>' : k.status === 'run' ? ' <span class="chip plain">進行中</span>' : '';
    const after = k.next ? `之後空檔 <b>${fmtLong(k.idle / 1000)}</b>` : '本車最後一段，結束後前往終點';
    // 下一個換車地點＝本車下一段第一棒的起點（最後一段就是終點）
    const dest = k.next ? k.next.L.start : D.legs[29].end;
    const nav = k.status === 'done' ? '' : `<a class="nav-mini" href="${navUrl(dest)}" target="_blank" rel="noopener" aria-label="導航到${k.next ? `第 ${k.next.n} 棒起點` : '終點'}">${NAV_ICON}</a>`;
    return `<div class="shift ${k.status}"><div class="row"><span><span class="badge sm car${k.car}">C${k.car}</span>
      第 ${k.legs[0].n}–${k.legs[4].n} 棒${tag}</span><span class="num">${fmtT(k.start)}–${fmtT(k.end)}</span></div>
      <div class="row"><span class="t">${after}</span>${nav}</div></div>`;
  }).join('');
  return `<h2>兩車輪班與空檔</h2><div class="card" style="padding:4px 16px">${rows}</div>`;
}
function renderLegs(now, sch, st) {
  const el = document.getElementById('tab-legs');
  const run = sch.find(s => s.status === 'run');
  const done = sch.filter(s => s.status === 'done');
  const last = sch[sch.length - 1];
  const ref = run || done[done.length - 1];
  const delta = ref ? (run ? run.start - run.planStart : ref.end - ref.planEnd) : 0;
  const cutoff = Date.parse(D.cutoff);
  const kmDone = done.length ? done[done.length - 1].L.endKm : 0;
  let hero;
  if (run) {
    const p = progressOf(run, now), nx = sch[run.n];
    hero = `<div class="hero car${run.car}">
      <div class="label">當前跑者 · 第 ${run.n} 棒 · Car${run.car} · ${run.L.km.toFixed(1)} km ${run.L.level}</div>
      <div class="name">${runnerName(run.runner)}</div>
      <div class="row" style="margin-top:8px"><span><span style="font-size:12px;opacity:.85">本棒進度</span><br><span class="big num" style="font-size:38px">${(p.frac * 100).toFixed(0)}%</span></span>
        <span style="text-align:right">預計交棒<br><b class="num" style="font-size:28px">${fmtT(run.end)}</b></span></div>
      ${avBar(p.frac, run.runner)}
      <div class="row" style="font-size:13px"><span>已跑 <span class="num" data-elapsed="${run.start}">${fmtDur((now - run.start) / 1000)}</span>（${p.g && !p.g.off ? 'GPS' : '推估'}）</span>
        <span>${nx ? `下一棒 ${runnerName(nx.runner)} · Car${nx.car}` : '最後一棒'}</span></div>
      ${p.g ? `<div style="font-size:13px;margin-top:4px">${p.g.off ? '⚠ 偏離路線 · ' : ''}${p.g.pace ? `目前配速 <b class="num">${fmtPace(p.g.pace)}</b> · ` : ''}${p.g.avg ? `本棒平均 <b class="num">${fmtPace(p.g.avg)}</b> · ` : ''}GPS ${agoText(p.g.t)}</div>` : ''}
      ${cfg.demo ? '' : `<button class="btn" data-act="finish" data-n="${run.n}">第 ${run.n} 棒完成交棒</button>`}</div>`;
  } else if (!st.raceStart) {
    hero = `<div class="hero idle"><div class="label">尚未開跑 · 預計出發 ${fmtDT(Date.parse(cfg.planStart))}</div>
      <div class="big num" data-countdown="${Date.parse(cfg.planStart)}">${fmtCountdown((Date.parse(cfg.planStart) - now) / 1000)}</div>
      ${cfg.demo ? '' : '<button class="btn" data-act="start">開跑（第 1 棒出發）</button>'}</div>`;
  } else {
    hero = `<div class="hero idle"><div class="label">完賽</div><div class="name">${fmtDT(last.end)} 抵達七星潭 🎉</div></div>`;
  }
  const issues = checkAssign();
  const rounds = [0, 1, 2].map(r => {
    const rs = sch.slice(r * 10, r * 10 + 10);
    return `<div class="round-title"><span>第 ${r + 1} 輪</span><span>${fmtT(rs[0].start)}–${fmtT(rs[9].end)}</span></div>`
      + rs.map(s => legRow(s, now)).join('');
  }).join('');
  el.innerHTML = `${demoBar()}<div class="row"><h1>棒次</h1><button class="chip plain" data-act="settings">⚙ 設定</button></div>
    ${hero}
    <div class="hero idle total">
      <div class="row"><span class="label">全隊總進度</span><span class="label">完成 ${done.length}/30 棒</span></div>
      <div class="row" style="align-items:flex-end;margin-top:4px">
        <span class="big num" style="font-size:34px">${(kmDone / D.totalKm * 100).toFixed(0)}%</span>
        <span style="text-align:right">預計完賽<br><b class="num ${last.end > cutoff ? 'slow' : ''}" style="font-size:24px">${fmtT(last.end)}</b></span></div>
      ${carsBar(sch, now)}
      <div class="row" style="font-size:13px"><span>${kmDone.toFixed(1)} / ${D.totalKm} km · 比預定 ${ref ? fmtDelta(delta) : '—'}</span>
        <span>關門 ${fmtT(cutoff)} · ${last.end > cutoff ? '<span class="slow">超過關門！</span>' : `餘裕 ${fmtLong((cutoff - last.end) / 1000)}`}</span></div>
    </div>
    ${issues.errors.length ? `<div class="issues">⚠ 違反大會規定（每人每輪剛好一棒）：<br>${issues.errors.join('<br>')}</div>` : ''}
    ${issues.warns.length ? `<div class="issues warn">注意：<br>${issues.warns.join('<br>')}</div>` : ''}
    ${shiftCard(sch)}
    <h2>30 棒</h2>
    ${rounds}
    <p class="muted" style="font-size:12px">${esc(D.routeNote)}。預計時間＝各人平地配速 × 坡度修正 ＋ 每棒 ${OVERHEAD_SEC} 秒交棒。</p>`;
}

// ---------- 分頁：地圖 ----------
let map, runnerMarker, flagMarker, follow = false;
const legLines = [], legPts = [], minorPins = [];
const PIN_ZOOM = 11;                       // 放大到這級以上才顯示每一棒的編號
let runGlow, runDash, runLegShown = 0;
// 棒次編號：外層給 Leaflet 定位，內層 span 依縮放等級改大小（見 index.html 的 .pin）
const pinIcon = (txt, major) => L.divIcon({ className: 'pin-wrap', iconSize: [0, 0],
  html: `<span class="pin${major ? ' major' : ''}">${txt}</span>` });
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true });
  // Esri 街道圖磚（免金鑰；OSM 會擋 file:// 開啟的網頁），用 CSS 濾鏡轉成深色（見 index.html 的 .dark-tiles）
  setBase(cfg.mapStyle);
  // 黑色外框墊在路線下面，深色底圖上比較看得清楚
  L.polyline(T.map(p => [p[0], p[1]]), { color: '#000', weight: 11, opacity: 0.6, interactive: false }).addTo(map);
  for (const Lg of D.legs) {
    const pts = T.filter(p => p[2] >= Lg.startKm - 0.2 && p[2] <= Lg.endKm + 0.2).map(p => [p[0], p[1]]);
    legPts.push(pts);
    legLines.push(L.polyline(pts, { color: LEVEL_COLOR[Lg.level], weight: 6, opacity: 0.95 }).addTo(map)
      .on('click', () => openLeg(Lg.n)));
    // 換車點（第 1、6、11…26 棒起點）一直顯示，其他棒放大才顯示
    const major = Lg.n % 5 === 1;
    const pin = L.marker(Lg.start, { icon: pinIcon(Lg.n, major), zIndexOffset: major ? 500 : 0 }).on('click', () => openLeg(Lg.n));
    if (major) pin.addTo(map); else minorPins.push(pin);
  }
  L.marker(D.legs[29].end, { icon: pinIcon('終', true), zIndexOffset: 500 }).addTo(map);
  // 進行中的棒次：外層光暈＋流動虛線（動畫在 index.html 的 .leg-run）
  runGlow = L.polyline([], { color: '#fff', weight: 16, opacity: 0.25, interactive: false, className: 'leg-glow' });
  runDash = L.polyline([], { color: '#fff', weight: 4, opacity: 1, dashArray: '8 14', interactive: false, className: 'leg-run' });
  map.on('zoomend', updatePins);
  runnerMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', iconSize: [20, 20] }), zIndexOffset: 1000 });
  flagMarker = L.circleMarker([0, 0], { radius: 9, color: '#fff', weight: 3, fillColor: '#111', fillOpacity: 1 });
  fitAll();
  map.on('dragstart', () => { follow = false; });
}
// 底圖：街道（亮色，配色接近 Google 地圖）／深色（同一張圖反相）／衛星
const BASES = { street: '街道', dark: '深色', sat: '衛星' };
let baseLayer;
function setBase(k) {
  if (!BASES[k]) k = 'street';
  if (baseLayer) baseLayer.remove();
  const svc = k === 'sat' ? 'World_Imagery' : 'World_Street_Map';
  baseLayer = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`,
    { maxZoom: 19, className: k === 'dark' ? 'dark-tiles' : '', attribution: 'Tiles © Esri' }).addTo(map);
  baseLayer.bringToBack();
  cfg.mapStyle = k; saveCfg();
  document.getElementById('btn-base').textContent = BASES[k];
}
function fitAll() { map.fitBounds(L.latLngBounds(T.map(p => [p[0], p[1]])), { padding: [20, 20] }); updatePins(); }
function updatePins() {
  const z = map.getZoom(), show = z >= PIN_ZOOM;
  minorPins.forEach(m => { if (show) m.addTo(map); else m.remove(); });
  // 依縮放等級切換編號大小：遠看小、放大後變大
  const el = map.getContainer();
  el.classList.toggle('pins-md', z >= 12 && z < 14);
  el.classList.toggle('pins-lg', z >= 14);
}
// 車子位置：
// 1) 車上有專用手機（u=car1／car2）且 10 分鐘內有回報 → 用它
// 2) 否則用這台車上「沒在跑」的隊友推算：10 分鐘內有回報的人裡，找彼此 300 m 內聚最多人的一群，取平均位置
// 3) 都沒有，專用手機 30 分鐘內有回報也先顯示
const CAR_FRESH = 10 * 60e3, CREW_RADIUS = 300;
const distM = (p, q) => Math.hypot((p.lat - q.lat) * 110540, (p.lon - q.lon) * 111320 * Math.cos(p.lat * Math.PI / 180));
function carPos(c, now, sch) {
  const a = sync.loc['car' + c], dev = a && a[a.length - 1];
  if (dev && now - dev.t < CAR_FRESH) return { lat: dev.lat, lon: dev.lon, t: dev.t, how: '車上手機' };
  const run = sch.find(s => s.status === 'run');
  const crew = [...new Set(sch.filter(s => s.car === c).map(s => String(s.runner)))]
    .filter(r => !run || String(run.runner) !== r);
  const pts = crew.map(r => { const b = sync.loc[r]; return b && b[b.length - 1]; })
    .filter(p => p && now - p.t < CAR_FRESH);
  let best = [];
  for (const p of pts) { const g = pts.filter(q => distM(p, q) < CREW_RADIUS); if (g.length > best.length) best = g; }
  if (best.length) return {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length, lon: best.reduce((s, p) => s + p.lon, 0) / best.length,
    t: Math.max(...best.map(p => p.t)), how: `${best.length} 位隊友推算`,
  };
  if (dev && now - dev.t < 30 * 60e3) return { lat: dev.lat, lon: dev.lon, t: dev.t, how: '車上手機' };
  return null;
}
const carMarkers = {};
// 隊友：地圖按「隊友」後，10 分鐘內有回報的人都用小頭像標在自己的位置（正在跑的人已經有大頭像，不重複；疊在車子圖示上面）
const crewMarkers = {};
function crewPoints(now, run) {
  if (cfg.demo || !cfg.showCrew) return [];
  return RUNNERS.filter(r => !run || run.runner !== r).map(r => {
    const a = sync.loc[String(r)], last = a && a[a.length - 1];
    return last && now - last.t < CAR_FRESH ? { r, ...last } : null;
  }).filter(Boolean);
}
function updateCrew(now, run) {
  const pts = crewPoints(now, run), shown = new Set(pts.map(p => p.r));
  for (const r in crewMarkers) if (!shown.has(+r)) crewMarkers[r].remove();
  // 50 m 內的人算同一群（例如都在車上），排成每列 3 人的格子，名字下面不寫時間以免擠在一起
  const groups = [];
  for (const p of pts) {
    const g = groups.find(g => distM(g[0], p) < 50);
    if (g) g.push(p); else groups.push([p]);
  }
  for (const g of groups) g.forEach((p, k) => {
    const cols = Math.min(3, g.length), x = (k % cols - (cols - 1) / 2) * 52, y = Math.floor(k / cols) * 60;
    const me = p.r === cfg.me, color = me ? 'var(--accent)' : CAR_COLOR[carOfRunner(p.r)];
    const html = `<div class="crew-pin${me ? ' me' : ''}" style="margin-left:${x}px;margin-top:${y}px"><div class="av" style="border-color:${color}"><img src="${ICONS.runner(p.r)}" alt=""></div>
      <span>${me ? '我' : runnerName(p.r)}${g.length > 1 ? '' : ` · ${agoText(p.t)}`}</span></div>`;
    (crewMarkers[p.r] ||= L.marker([0, 0], { zIndexOffset: me ? 960 : 950 }))
      .setIcon(L.divIcon({ className: 'pin-wrap', iconSize: [0, 0], html }))
      .setLatLng([g[0].lat, g[0].lon]).addTo(map);
  });
  return pts;
}
function updateCars(now, sch) {
  for (const c of [1, 2]) {
    const p = !cfg.demo && carPos(c, now, sch);
    if (!p) { if (carMarkers[c]) carMarkers[c].remove(); continue; }
    const html = ICONS['car' + c]
      ? `<div class="car-pin img" style="border-color:${CAR_COLOR[c]}"><img src="${ICONS['car' + c]}" alt=""></div>`
      : `<div class="car-pin" style="background:${CAR_COLOR[c]}">🚐<b>${c}</b></div>`;
    (carMarkers[c] ||= L.marker([0, 0], { zIndexOffset: 900 }))
      .setIcon(L.divIcon({ className: 'pin-wrap', iconSize: [0, 0], html }))
      .bindTooltip(`Car${c} · ${p.how} · ${agoText(p.t)}`).setLatLng([p.lat, p.lon]).addTo(map);
  }
}
const crewBtn = () => document.getElementById('btn-crew').classList.toggle('on', !!cfg.showCrew);
function renderMap(now, sch) {
  document.getElementById('map-demo').innerHTML = demoBar();
  if (!map) return;
  updateCars(now, sch);
  const run = sch.find(s => s.status === 'run');
  updateCrew(now, run);
  crewBtn();
  // 已完成淡化、未開始半透明，進行中最亮
  sch.forEach((s, i) => legLines[i].setStyle({ opacity: s.status === 'done' ? 0.25 : s.status === 'run' ? 1 : 0.6,
    weight: s.status === 'run' ? 8 : 6 }));
  if (run && runLegShown !== run.n) {
    runGlow.setLatLngs(legPts[run.n - 1]).addTo(map);
    runDash.setLatLngs(legPts[run.n - 1]).addTo(map);
    runLegShown = run.n;
  } else if (!run && runLegShown) { runGlow.remove(); runDash.remove(); runLegShown = 0; }
  const card = document.getElementById('map-card');
  if (!run) {
    runnerMarker.remove(); flagMarker.remove();
    card.innerHTML = sch[0].status === 'todo'
      ? `<b>尚未開跑</b> <span class="muted">· 預計 ${fmtDT(sch[0].start)} 出發</span>`
      : '<b>完賽 🎉</b>';
    return;
  }
  const p = progressOf(run, now), pos = p.g ? p.g.pos : posAtKm(p.km);
  runnerMarker.setIcon(ICONS.runner
    ? L.divIcon({ className: '', iconSize: [44, 44],
        html: `<div class="runner-pin img" style="border-color:${CAR_COLOR[run.car]}"><img src="${ICONS.runner(run.runner)}" alt=""></div>` })
    : L.divIcon({ className: '', iconSize: [20, 20],
        html: `<div class="runner-pin" style="width:20px;height:20px;background:${CAR_COLOR[run.car]}"></div>` }));
  runnerMarker.setLatLng(pos).addTo(map);
  flagMarker.setLatLng(run.L.end).addTo(map);
  if (follow) map.panTo(pos);
  const nx = sch[run.n];
  card.innerHTML = `<div class="row"><span><span class="badge car${run.car}" style="display:inline-flex;width:28px;height:28px;font-size:13px;vertical-align:middle">${run.n}</span>
      <b style="margin-left:6px">${runnerName(run.runner)}</b> <span class="muted">Car${run.car}</span></span>
      <span class="num"><b>${(p.frac * 100).toFixed(0)}%</b> <span class="muted">· ${fmtT(run.end)} 預計抵達</span></span></div>
    <div class="muted" style="font-size:12px;margin-top:4px">${p.g
      ? `GPS ${agoText(p.g.t)}${p.g.off ? ' · ⚠ 偏離路線' : ''}${p.g.pace ? ` · 目前 ${fmtPace(p.g.pace)}` : ''}${p.g.avg ? ` · 平均 ${fmtPace(p.g.avg)}` : ''}${p.g.batt != null ? ` · 電量 ${p.g.batt}%` : ''}`
      : `位置用配速推估（${cfg.demo ? '示範模式' : !sync.key ? '未連線' : '沒有收到這位跑者的 GPS'}）`}${nx ? ` · 下一棒 ${runnerName(nx.runner)}` : ''}</div>`;
}

// ---------- 彈出視窗：單棒詳情 ----------
let sheetLeg = null;
function openSheet(html) {
  document.getElementById('sheet').innerHTML = html;
  document.getElementById('sheet-bg').classList.add('open');
}
function closeSheet() { document.getElementById('sheet-bg').classList.remove('open'); sheetLeg = null; }
function openLeg(n) { sheetLeg = n; subMode = false; renderLegSheet(); document.getElementById('sheet').scrollTop = 0; }
function renderLegSheet() {
  const now = nowMs(), st = raceState(now), sch = schedule(now, st), s = sch[sheetLeg - 1];
  const doneList = sch.filter(x => x.status === 'done');
  const isLastDone = doneList.length && doneList[doneList.length - 1].n === s.n;
  const statusText = { done: '已完成', run: '跑步中', todo: '未開始' }[s.status];
  const actual = s.status === 'done'
    ? `<div class="kv"><span>實際</span><span class="num">${fmtT(s.start)} → ${fmtT(s.end)}</span></div>
       <div class="kv"><span>用時</span><span class="num"><b>${fmtDur((s.end - s.start) / 1000)}</b></span></div>
       <div class="kv"><span>平均配速</span><span class="num">${fmtPace((s.end - s.start) / 1000 / s.L.km)}/km</span></div>`
    : `<div class="kv"><span>${s.status === 'run' ? '起跑 → 預計交棒' : '預計'}</span><span class="num">${fmtDT(s.start)} → ${fmtT(s.end)}</span></div>`;
  let actions = '';
  if (cfg.demo) actions = '<p class="muted" style="font-size:13px">示範模式不能標記交棒；到設定關掉示範模式後才會記錄真實時間。</p>';
  else if (s.status === 'run') actions = `<button class="btn" data-act="finish" data-n="${s.n}">幫他標記完成</button>`;
  else if (isLastDone) actions = `<button class="btn warn" data-act="undo" data-n="${s.n}">取消這棒的完成紀錄</button>`;
  openSheet(`<div class="sheet-head"><h3>第 ${s.n} 棒 <span class="muted" style="font-size:14px">· ${statusText}</span></h3><button data-act="close">完成</button></div>
    <div style="margin:6px 0 10px">${chips(s)}</div>
    <div class="muted" style="font-size:14px">${esc(s.L.reason)}</div>
    <div class="stats">
      <div class="stat"><b>${s.L.km.toFixed(2)}</b><span>公里（${s.L.startKm}–${s.L.endKm}）</span></div>
      <div class="stat"><b style="color:var(--slow)">+${s.L.gain}</b><span>爬升 m</span></div>
      <div class="stat"><b style="color:var(--low)">−${s.L.loss}</b><span>下降 m</span></div>
    </div>
    ${nightBox(s)}
    <div style="margin-top:12px">${elevSvg(s.L.startKm, s.L.endKm)}</div>
    <div class="btn-row">
      <a class="btn ghost" href="${navUrl(s.L.start)}" target="_blank" rel="noopener">${NAV_ICON} 導航到起點</a>
      <a class="btn ghost" href="${navUrl(s.L.end)}" target="_blank" rel="noopener">${NAV_ICON} 導航到終點</a>
    </div>
    <div class="card" style="margin-top:12px">
      ${runnerPicker(s, sch)}
      <div class="kv"><span>預定（照計畫）</span><span class="num">${fmtDT(s.planStart)} → ${fmtT(s.planEnd)}</span></div>
      ${actual}
      <div class="kv"><span>平地配速 → 坡度估算</span><span class="num">${fmtPace(cfg.paces[s.runner])} → ${fmtPace((s.dur / 1000 - OVERHEAD_SEC) / s.L.km)}/km</span></div>
    </div>
    <p class="muted" style="font-size:12px">導航座標是草稿路線的位置，活動手冊公布後會換成正式接力點。</p>
    ${actions}`);
}

// 換棒規則說明：從單棒詳情或設定打開，「返回」回到原本的畫面
let rulesBack = null;
function openRules() {
  rulesBack = sheetLeg; sheetLeg = null;
  openSheet(`<div class="sheet-head"><h3>換棒規則</h3><button data-act="rules-back">返回</button></div>
    <h2 style="margin-top:4px">大會只規定三件事</h2>
    <div class="card rules">
      <div class="kv"><b>① 每輪跑一棒</b><span>30 棒分三輪，每輪 10 棒；每個人每輪跑 1 棒，總共 3 棒</span></div>
      <div class="kv"><b>② 坐哪台車</b><span>每輪第 1–5 棒的人坐 Car1，第 6–10 棒的人坐 Car2</span></div>
      <div class="kv"><b>③ 受傷可代跑</b><span>有人受傷跑不了，他剩下的棒次可以給隊友多跑</span></div>
    </div>
    <h2>在 app 裡怎麼換人</h2>
    <div class="card rules">
      <div class="kv"><b>想換人</b><span>點那一棒 → 選另一個人。兩人會<b>對調</b>，不會有人多跑或少跑</span></div>
      <div class="kv"><b>🔒 不能改</b><span>跑完的、正在跑的棒次</span></div>
      <div class="kv"><b>灰色選不到</b><span>這一輪已經跑過的人</span></div>
      <div class="kv"><b>有人受傷</b><span>點那一棒 → 勾「受傷代跑」才能讓別人多跑；受傷的人之後不能再回來跑</span></div>
      <div class="kv"><b>紅框／黃框</b><span>紅框＝違規，一定要改；黃框＝提醒，看看就好</span></div>
    </div>
    <p class="muted" style="font-size:13px">⚠ 如果把 Car1 和 Car2 的人對調，兩人那一輪也要<b>互換車子坐</b>，在換車點（第 1、6、11、16、21、26 棒起點）先換好。</p>`);
  document.getElementById('sheet').scrollTop = 0;
}

// 單棒跑者選單：已開跑的鎖住；一般模式選到同輪的人會自動對調，本輪已跑過的人不能選
let subMode = false;
function runnerPicker(s, sch) {
  const tags = (cfg.assign[s.n] ? ' <span class="chip plain">個別調整</span>' : '') + (cfg.sub[s.n] ? ' <span class="chip plain">代跑</span>' : '');
  if (s.status !== 'todo') return `<div class="kv"><span>跑者${tags}</span><span>${runnerName(s.runner)} · Car${s.car} 🔒</span></div>`;
  const sub = subMode || !!cfg.sub[s.n], r0 = Math.floor((s.n - 1) / 10) * 10;
  const ranThisRound = new Set(sch.slice(r0, r0 + 10).filter(x => x.status !== 'todo').map(x => x.runner));
  const opts = RUNNERS.map(r => {
    const off = !sub && ranThisRound.has(r) && r !== s.runner;
    return `<option value="${r}" ${r === s.runner ? 'selected' : ''} ${off ? 'disabled' : ''}>${runnerName(r)}${off ? '（本輪已跑）' : ''}</option>`;
  }).join('');
  if (!canEdit()) return `<div class="kv"><span>跑者${tags}</span><span>${runnerName(s.runner)} · Car${s.car}</span></div>
    <div class="muted" style="font-size:12px;padding-top:6px">換人要由管理員在這裡改。<button class="chip plain" data-act="rules" style="margin-left:4px">📘 換棒規則</button></div>`;
  return `<div class="kv"><span>跑者${tags}</span><span><select data-act="assign" data-n="${s.n}">${opts}</select> · Car${s.car}</span></div>
    <div class="kv"><span style="font-size:13px">受傷代跑<br><span class="muted">允許本輪已跑過的人再跑這棒</span></span>
      <input type="checkbox" data-act="set-sub" ${sub ? 'checked' : ''} style="width:22px;height:22px"></div>
    <div class="muted" style="font-size:12px;padding-top:6px">${sub
      ? '代跑模式：直接換人，不會對調。大會規定受傷者的剩餘棒次可由隊友代跑，但受傷者退賽後不能再回來跑。'
      : '選同一輪的其他人，兩棒會自動對調，維持每人每輪一棒。整體順序請到「設定 → 棒次順序」改。'}
      <button class="chip plain" data-act="rules" style="margin-left:4px">📘 換棒規則</button></div>`;
}

// ---------- 彈出視窗：設定 ----------
function toLocalInput(ms) {   // datetime-local 用台灣時間顯示
  const d = new Date(ms + 8 * 3600e3);
  return d.toISOString().slice(0, 16);
}
// 管理工具：只有管理員解鎖後從設定頁進來
function openAdmin() {
  if (!sync.admin) return openSettings();
  sheetLeg = null;
  openSheet(`<div class="sheet-head"><h3>管理工具</h3><button data-act="settings">返回設定</button></div>
    <h2 style="margin-top:0">隊友連結</h2>
    <div class="card">
        <button class="btn ghost" data-act="copy-link">複製隊友連結（含隊伍密碼）</button>
    </div>
    <h2>測試</h2>
    <div class="card">
        <div class="muted" style="font-size:12px;padding-top:0">正式發布前：清掉測試時的交棒紀錄、提醒紀錄和所有定位（名字、順序、配速、通知訂閱保留）。</div>
        <button class="btn warn" data-act="purge" style="margin-top:8px">清除所有測試資料</button>
        <div class="muted" style="font-size:12px;padding-top:12px">測試交接點：把「目前這棒的終點」暫時改成你現在的位置，在家附近走一圈就能測剩 500 m 提醒與自動交棒。</div>
        ${cfg.testPoint ? `<div class="kv"><span>🧪 啟用中（${fmtDT(cfg.testPoint.at)} 設定）</span><button class="chip plain" data-act="tp-clear">取消</button></div>`
          : `<button class="btn ghost" data-act="tp-set" style="margin-top:8px">把測試交接點設在我現在的位置</button>`}
        <div class="muted" style="font-size:12px;padding-top:12px">模擬隊友第一次使用：清掉這支手機記住的隊伍密碼、管理員、我是誰、通知訂閱，變回剛拿到連結的樣子（雲端資料不受影響）。</div>
        <button class="btn ghost" data-act="reset-phone" style="margin-top:8px">把這支手機重設成第一次使用（測試用）</button>
    </div>
    <p class="muted" style="font-size:11px">畫面 ${innerWidth}×${innerHeight}　螢幕 ${screen.width}×${screen.height}　差 ${window.iosGap ?? '—'}</p>
    <h2>比賽紀錄</h2>
    <p class="muted" style="font-size:13px">交棒紀錄全隊同步。清除會清掉全隊的紀錄。</p>
    <button class="btn warn" data-act="reset">清除全隊的比賽紀錄</button>`);
}
function openSettings() {
  sheetLeg = null;
  const ps = Date.parse(cfg.planStart);
  openSheet(`<div class="sheet-head"><h3>設定</h3><button data-act="close">完成</button></div>
    <h2 style="margin-top:0">隊伍連線</h2>
    <div class="card">
      <div class="kv"><span>狀態</span><span style="font-size:13px;text-align:right">${syncStatus()}</span></div>
      ${!sync.key ? `<div class="kv"><span>隊伍密碼</span><span><input id="key-in" style="width:120px" autocomplete="off"> <button class="chip plain" data-act="set-key">連線</button></span></div>
        <div class="muted" style="font-size:12px;padding-top:6px">用隊長傳的連結打開就會自動連線，不用手動輸入。</div>`
      : sync.admin ? `<div class="kv"><span>管理員</span><span>已解鎖 <button class="chip plain" data-act="lock">登出</button></span></div>
        <button class="btn ghost" data-act="admin" style="margin-top:10px">🛠 管理工具（隊友連結、測試、清除資料）</button>`
      : `<div class="kv"><span>管理員密碼</span><span><input id="pin-in" type="password" style="width:100px" autocomplete="off"> <button class="chip plain" data-act="unlock">解鎖</button></span></div>
        <div class="muted" style="font-size:12px;padding-top:6px">名字、棒次順序、配速、出發時間由管理員設定，全隊同步；交棒誰都可以按。</div>`}
    </div>
    ${sync.key ? `<button class="btn ghost" data-act="setup" style="margin-bottom:10px;border:1.5px solid var(--accent)">第一次使用設定（我是誰、定位、通知）</button>` : ''}
    <div class="card">
      <div class="kv"><span>我是</span><select data-act="set-me">${RUNNERS.map(r => `<option value="${r}" ${r === cfg.me ? 'selected' : ''}>${runnerName(r)}</option>`).join('')}</select></div>
      <div class="kv"><span>預計出發時間</span><input type="datetime-local" data-act="set-start" value="${toLocalInput(ps)}"></div>
    </div>
    <div class="row"><h2>棒次順序</h2><button class="chip plain" data-act="rules">📘 換棒規則</button></div>
    <p class="muted" style="font-size:13px;margin-top:0">每輪 10 棒照這個順序跑，第 2、3 輪相同。<b>左欄坐 Car1、右欄坐 Car2</b>。選到已經排在別棒的人，兩人會自動對調。比賽開始後再改，只影響還沒跑的棒次。</p>
    <div class="order-grid"><div class="car-head car1">🚐 Car1</div><div class="car-head car2">🚐 Car2</div>${cfg.order.map((r, i) => `<label class="car${i < 5 ? 1 : 2}"><span class="badge sm car${i < 5 ? 1 : 2}">${i + 1}</span>
      <select data-act="set-order" data-i="${i}">${RUNNERS.map(x => `<option value="${x}" ${x === r ? 'selected' : ''}>${runnerName(x)}</option>`).join('')}</select></label>`).join('')}</div>
    ${Object.keys(cfg.assign).length ? `<div class="card" style="margin-top:8px"><div class="kv"><span style="font-size:13px">另有個別調整：第 ${Object.keys(cfg.assign).sort((a, b) => a - b).join('、')} 棒</span>
      <button class="chip plain" data-act="clear-assign">全部清除</button></div></div>` : ''}
    <h2>隊員名字與平地配速（分:秒／公里）</h2>
    <div class="member-list">${RUNNERS.map(r => `<label><span class="muted num">${r}</span>
      <input data-act="set-name" data-r="${r}" value="${esc(cfg.names[r] || '')}" placeholder="${r} 號" maxlength="12">
      <input data-act="set-pace" data-r="${r}" value="${fmtPace(cfg.paces[r]).replace("'", ':').replace('"', '')}" inputmode="numeric" class="pace"></label>`).join('')}</div>
    ${sync.key ? `<h2>通知</h2>${pushCard()}` : ''}
    <h2>示範模式</h2>
    <div class="card">
      <div class="kv"><span>練習用：用假的時間看比賽中的畫面<br><span class="muted" style="font-size:12px">連上隊伍後預設關閉；比賽開跑後一定會自動關閉</span></span><input type="checkbox" data-act="set-demo" ${cfg.demo ? 'checked' : ''} style="width:22px;height:22px"></div>
      ${cfg.demo ? `<div style="padding-top:10px">模擬「出發後 <b id="demo-h">${cfg.demoHours}</b> 小時」＝<b id="demo-t">${fmtDT(nowMs())}</b>
        <input type="range" min="-1" max="30" step="0.25" value="${cfg.demoHours}" data-act="set-demo-h" style="width:100%;margin-top:8px;padding:0"></div>` : ''}
    </div>
    ${sync.key ? '' : `<h2>比賽紀錄</h2>
    <p class="muted" style="font-size:13px">目前紀錄只存在這支手機。</p>
    <button class="btn warn" data-act="reset">清除這支手機的比賽紀錄</button>`}`);
  // 不是管理員：共用設定一律唯讀（「我是」和示範模式除外）
  if (!canEdit()) document.querySelectorAll('#sheet [data-act^="set-"], #sheet [data-act="clear-assign"]').forEach(e => {
    if (!['set-me', 'set-demo', 'set-demo-h'].includes(e.dataset.act)) e.disabled = true;
  });
}

// ---------- 主畫面更新 ----------
let tab = 'me', purgeArmed = false, phoneArmed = false;
function render() {
  const now = nowMs(), st = raceState(now), sch = schedule(now, st);
  if (tab === 'me') renderMe(now, sch);
  if (tab === 'legs') renderLegs(now, sch, st);
  if (tab === 'map') renderMap(now, sch);
}
// 每秒只更新倒數與計時數字，每 15 秒重畫整頁
function tick() {
  const now = nowMs();
  document.querySelectorAll('[data-countdown]').forEach(e => { e.textContent = fmtCountdown((+e.dataset.countdown - now) / 1000); });
  document.querySelectorAll('[data-elapsed]').forEach(e => { e.textContent = fmtDur((now - +e.dataset.elapsed) / 1000); });
}
setInterval(() => { if (!cfg.demo) tick(); }, 1000);
setInterval(() => { if (!document.getElementById('sheet-bg').classList.contains('open')) render(); }, 15000);

function showTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach(e => e.classList.toggle('active', e.id === `tab-${t}`));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  if (t === 'map') { if (!map) initMap(); setTimeout(() => map.invalidateSize(), 0); }
  render();
}

// ---------- 操作 ----------
let resetArmed = false;
document.addEventListener('click', e => {
  const nav = e.target.closest('nav button');
  if (nav) return showTab(nav.dataset.tab);
  if (e.target.id === 'sheet-bg') return closeSheet();
  if (e.target.id === 'btn-fit') { follow = false; return fitAll(); }
  if (e.target.id === 'btn-follow') { follow = true; return render(); }
  if (e.target.id === 'btn-crew') {
    cfg.showCrew = !cfg.showCrew; saveCfg(); render();
    if (!cfg.showCrew) return;
    const now = nowMs(), pts = crewPoints(now, schedule(now, raceState(now)).find(s => s.status === 'run'));
    if (cfg.demo) return toast('示範模式不顯示真實位置，到設定關掉示範模式');
    if (!sync.key) return toast('還沒連上隊伍，看不到隊友位置');
    if (!pts.length) return toast('目前沒有隊友在 10 分鐘內回報位置');
    follow = false;
    if (pts.length === 1) map.setView([pts[0].lat, pts[0].lon], 15);
    else map.fitBounds(pts.map(p => [p.lat, p.lon]), { padding: [60, 60], maxZoom: 16 });
    return toast(`顯示 ${pts.length} 位隊友的位置`);
  }
  if (e.target.id === 'btn-base') { const ks = Object.keys(BASES); return setBase(ks[(ks.indexOf(cfg.mapStyle) + 1) % ks.length]); }
  if (e.target.closest('a')) return;                 // 導航連結交給瀏覽器開，不要觸發外層
  const a = e.target.closest('[data-act]');
  if (!a || a.tagName === 'SELECT' || a.tagName === 'INPUT') return;
  const n = +a.dataset.n;
  switch (a.dataset.act) {
    case 'pick-me': cfg.me = +a.dataset.v; saveCfg(); render(); break;
    case 'settings': openSettings(); document.getElementById('sheet').scrollTop = 0; break;
    case 'close': closeSheet(); render(); break;
    case 'rules': openRules(); break;
    case 'rules-back': if (rulesBack) openLeg(rulesBack); else openSettings(); document.getElementById('sheet').scrollTop = 0; break;
    case 'leg': openLeg(n); break;
    case 'goto-legs': showTab('legs'); break;
    case 'clear-assign': {   // 已開跑的棒次保留，只清還沒跑的
      const sch = schedule(nowMs(), raceState(nowMs()));
      for (const k of new Set([...Object.keys(cfg.assign), ...Object.keys(cfg.sub)]))
        if (cfg.demo || sch[k - 1].status === 'todo') { delete cfg.assign[k]; delete cfg.sub[k]; }
      sharedChanged(); toast('已清除還沒跑的個別調整'); openSettings(); render(); break;
    }
    case 'start':
      record('finish', 0, Date.now()); toast('開跑！第 1 棒出發'); render(); break;
    case 'finish':
      record('finish', n, Date.now()); toast(n < 30 ? `第 ${n} 棒完成，交棒給第 ${n + 1} 棒` : '完賽！🎉');
      if (sheetLeg) renderLegSheet(); render(); break;
    case 'undo':
      autoSeen[n] = 'done'; saveAuto();
      record('unfinish', n); toast(`已取消第 ${n} 棒的完成紀錄`); renderLegSheet(); render(); break;
    case 'reset':
      if (!resetArmed) { resetArmed = true; a.textContent = '再按一次確認清除'; setTimeout(() => { resetArmed = false; }, 4000); break; }
      resetArmed = false;
      if (sync.key) {
        api('reset').then(() => { pending = []; savePending(); state = { raceStart: null, finishes: {} }; saveState();
          toast('已清除全隊比賽紀錄'); closeSheet(); render(); }).catch(err => toast(err.message));
        break;
      }
      state = { raceStart: null, finishes: {} }; saveState(); toast('已清除比賽紀錄'); closeSheet(); render(); break;
    case 'set-key': {
      const v = document.getElementById('key-in').value.trim();
      if (!v) break;
      sync.key = v;
      api('check').then(() => { lsSet(LS_KEY, v); toast('已連線'); doSync().then(openSettings); })
        .catch(err => { sync.key = ''; toast(err.message); });
      break;
    }
    case 'unlock': {
      sync.pin = document.getElementById('pin-in').value.trim();
      api('check').then(j => {
        if (!j.admin) { sync.pin = ''; return toast('管理員密碼不對'); }
        sync.admin = true; lsSet(LS_PIN, sync.pin); toast('管理員已解鎖'); openSettings();
      }).catch(err => { sync.pin = ''; toast(err.message); });
      break;
    }
    case 'lock': sync.pin = ''; sync.admin = false; lsSet(LS_PIN, ''); toast('已登出管理員'); openSettings(); break;
    case 'setup': openSetup(); document.getElementById('sheet').scrollTop = 0; break;
    case 'setup-done': cfg.setupDone = true; saveCfg(); closeSheet(); render();
      toast(push.state === 'on' && myLoc() ? '設定完成 👍' : '之後可以在 設定 → 第一次使用設定 繼續'); break;
    case 'push-on': case 'push-off': case 'push-test': {
      const act = a.dataset.act; a.disabled = true;
      (act === 'push-on' ? enablePush() : act === 'push-off' ? disablePush() : testPush())
        .then(() => toast(act === 'push-on' ? '通知已開啟' : act === 'push-off' ? '通知已關閉' : '已送出，幾秒內會收到'))
        .catch(err => toast(err.message))
        .finally(() => { if (document.getElementById('setup-sheet')) refreshSetup(); else if (document.getElementById('sheet-bg').classList.contains('open')) openSettings(); });
      break;
    }
    case 'set-os': cfg.os = a.dataset.os; saveCfg(); refreshSetup(); break;
    case 'ot-setup':
      getOtCfg().then(c => { location.href = 'owntracks:///config?inline=' + encodeURIComponent(btoa(JSON.stringify(c))); })
        .catch(err => toast(err.message));
      break;
    case 'ot-manual':
      getOtCfg().then(c => {
        document.getElementById('ot-manual').innerHTML = `<div class="card" style="margin-top:8px;font-size:13px;line-height:1.7">
          OwnTracks → 設定（Settings）：<br>· 模式 Mode：<b>HTTP</b><br>· 網址 URL（長按全選複製）：
          <div style="word-break:break-all;user-select:all;background:var(--card2);padding:6px;border-radius:8px">${esc(c.url)}</div>
          · 裝置 ID（Device ID）：<b>${esc(c.deviceId)}</b>　· 縮寫（Tracker ID）：<b>${esc(c.tid)}</b><br>· 監控模式 Monitoring：<b>Move</b></div>`;
      }).catch(err => toast(err.message));
      break;
    case 'reset-phone':
      if (!phoneArmed) { phoneArmed = true; a.textContent = '再按一次確認重設'; setTimeout(() => { phoneArmed = false; }, 4000); break; }
      phoneArmed = false; toast('重設中…');
      disablePush().catch(() => {}).finally(() => {
        try { Object.keys(localStorage).filter(k => k.startsWith(LS_PRE + 'crufu.')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* 存不了就算了 */ }
        location.replace(location.pathname);    // 網址上的 #k=…&me=… 也一起拿掉
      });
      break;
    case 'purge':
      if (!purgeArmed) { purgeArmed = true; a.textContent = '再按一次確認清除（無法復原）'; setTimeout(() => { purgeArmed = false; }, 4000); break; }
      purgeArmed = false;
      api('purge').then(() => { pending = []; savePending(); state = { raceStart: null, finishes: {} }; saveState(); sync.loc = {};
        autoSeen = {}; saveAuto(); toast('已清除所有測試資料'); closeSheet(); render(); }).catch(err => toast(err.message));
      break;
    case 'admin': openAdmin(); break;
    case 'tp-set':
      if (!navigator.geolocation) { toast('這個瀏覽器拿不到位置'); break; }
      toast('取得位置中…');
      navigator.geolocation.getCurrentPosition(pos => {
        cfg.testPoint = { lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6), at: Date.now() };
        sharedChanged(); toast(`測試交接點已設定（誤差約 ${Math.round(pos.coords.accuracy)} m）`); openAdmin(); render();
      }, err => toast('拿不到位置：' + err.message), { enableHighAccuracy: true, timeout: 20000 });
      break;
    case 'tp-clear': cfg.testPoint = null; sharedChanged(); toast('已取消測試交接點'); openAdmin(); render(); break;
    case 'copy-link': {
      const url = `${location.origin}${location.pathname}?openExternalBrowser=1#k=${encodeURIComponent(sync.key)}`;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => toast('已複製，貼到 LINE 群組給隊友'))
        .catch(() => { a.outerHTML = `<div class="card" style="font-size:12px;word-break:break-all;user-select:all">${esc(url)}</div>`; });
      break;
    }
  }
});
document.addEventListener('change', e => {
  const a = e.target.dataset.act;
  if (!canEdit() && ['assign', 'set-sub', 'set-order', 'set-name', 'set-start', 'set-pace'].includes(a)) {
    toast('只有管理員能改'); return openSettings();
  }
  if (a === 'assign') {
    const n = +e.target.dataset.n;
    assignLeg(n, +e.target.value, subMode || !!cfg.sub[n]); renderLegSheet(); render();
  }
  if (a === 'set-sub') {
    subMode = e.target.checked;
    if (!subMode && sheetLeg && cfg.sub[sheetLeg]) { delete cfg.sub[sheetLeg]; sharedChanged(); }
    renderLegSheet(); render();
  }
  if (a === 'set-order') {
    // 比賽中改順序：已開跑、已完成的棒次先固定成目前的跑者，只影響還沒跑的棒次
    if (!cfg.demo) schedule(nowMs(), raceState(nowMs())).forEach(s => { if (s.status !== 'todo') cfg.assign[s.n] = s.runner; });
    const i = +e.target.dataset.i, v = +e.target.value, j = cfg.order.indexOf(v);
    if (j >= 0 && j !== i) cfg.order[j] = cfg.order[i];   // 對調，保持每人剛好一個位置
    cfg.order[i] = v;
    Object.keys(cfg.assign).forEach(n => { if (cfg.assign[n] === cfg.order[(n - 1) % 10]) delete cfg.assign[n]; });
    sharedChanged(); openSettings(); render();
  }
  if (a === 'set-name') {
    const v = e.target.value.trim().slice(0, 12);
    if (v) cfg.names[+e.target.dataset.r] = v; else delete cfg.names[+e.target.dataset.r];
    sharedChanged(); openSettings(); render();
  }
  if (a === 'set-me') {
    cfg.me = +e.target.value || null; saveCfg(); render(); keepHashForIOS(); refreshSetup();
    if (push.state === 'on') pushInit();
  }
  if (a === 'set-start' && e.target.value) {
    cfg.planStart = new Date(e.target.value + ':00+08:00').toISOString(); sharedChanged(); openSettings(); render();
  }
  if (a === 'set-pace') {
    const v = parsePace(e.target.value);
    if (v && v >= 180 && v <= 900) { cfg.paces[+e.target.dataset.r] = v; sharedChanged(); render(); }
    else { toast('配速格式像 7:00，範圍 3:00～15:00'); e.target.value = fmtPace(cfg.paces[+e.target.dataset.r]).replace("'", ':').replace('"', ''); }
  }
  if (a === 'set-demo') { cfg.demo = e.target.checked; cfg.demoChosen = true; saveCfg(); openSettings(); render(); }
});
document.addEventListener('input', e => {
  if (e.target.dataset.act === 'set-demo-h') {
    cfg.demoHours = +e.target.value; saveCfg();
    document.getElementById('demo-h').textContent = cfg.demoHours;
    document.getElementById('demo-t').textContent = fmtDT(nowMs());
    render();
  }
});

showTab('me');
function autoSetup() {
  if (sync.key && !cfg.setupDone && !setupShown && !window.CRUFU_SIM) { setupShown = true; openSetup(); }
}
autoSetup();
window.addEventListener('hashchange', () => { if (readHash()) { autoSetup(); doSync(); } });
// 每 15 秒同步一次；切回 app 時馬上同步
pushInit().then(refreshSetup);
doSync();
setInterval(() => { if (!document.hidden) doSync(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) doSync(); });
