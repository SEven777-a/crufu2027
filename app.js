// CRUFU 2027 隊內追蹤 app（第一版：不接 GPS，用「交棒時間＋配速＋坡度」推估）
// 資料：data.js（由 build_data.py 產生）；設定與比賽紀錄暫存在這支手機的 localStorage
'use strict';

const D = window.CRUFU_DATA;
const T = D.track;                         // [lat, lon, 累積 km, 高度 m]
const TZ = 'Asia/Taipei';
const RUNNERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const OVERHEAD_SEC = 60;                   // 每棒交棒、找人的時間
const LEVEL_COLOR = { 低: '#22c55e', 中: '#f59e0b', 難: '#ef4444' };
const CAR_COLOR = { 1: '#e5484d', 2: '#3b82f6' };
// 地圖自訂圖示：把圖檔放進 icons/ 再填路徑（例如 'icons/runner.png'），留空就用預設圓點
const ICONS = { runner: '', car1: '', car2: '' };
const LS_CFG = 'crufu.cfg.v1', LS_STATE = 'crufu.state.v1';

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
  mapStyle: 'street',                       // 地圖底圖：street 街道（類似 Google 地圖）／dark 深色／sat 衛星
});
let state = load(LS_STATE, { raceStart: null, finishes: {} });  // 真實比賽紀錄
const saveCfg = () => save(LS_CFG, cfg);
const saveState = () => save(LS_STATE, state);

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
const fmtPace = s => `${Math.floor(s / 60)}'${String(Math.round(s % 60)).padStart(2, '0')}"`;
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
    else if (prevDone) { end = Math.max(start + dur, now + 60e3); status = 'run'; prevDone = false; }
    else { end = start + dur; status = 'todo'; }
    prevEnd = end;
    return { L, n, runner: runnerOf(n), car: carOf(n), dur, planStart, planEnd, start, end, status };
  });
}

// 進行中那棒：推估完成比例與所在公里數（之後有 GPS 就改用實際位置）
function progressOf(s, now) {
  const frac = Math.min(0.99, Math.max(0, (now - s.start) / s.dur));
  return { frac, km: s.L.startKm + frac * s.L.km };
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
  saveCfg();
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
    <text x="4" y="14" fill="#8b909a" font-size="13">${Math.round(hi - 10)} m</text>
    <text x="4" y="${H - 8}" fill="#8b909a" font-size="13">${Math.round(lo + 10)} m</text></svg>
    <div class="muted" style="font-size:12px;margin-top:4px"><b style="color:#ef4444">紅色</b>＝陡上坡（坡度超過 5%）</div>`;
}
// 夜間棒提醒（大會規定，違規整隊取消資格）
function nightBox(s) {
  if (!isNight(s.start, s.end)) return '';
  return `<div class="night">🌙 <b>夜間棒</b>（${fmtT(Date.parse(D.nightStart))}～隔天 ${fmtT(Date.parse(D.nightEnd))}）：跑者穿<b>反光背心</b>、戴<b>頭燈</b>、開<b>尾燈</b>，違規會整隊取消資格。在接力點等候的隊友也要穿反光背心。</div>`;
}
function demoBar() {
  if (!cfg.demo) return '';
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
      <div class="bar"><i style="width:${(p.frac * 100).toFixed(0)}%"></i></div>
      <div class="row"><span>推估 ${(p.frac * 100).toFixed(0)}% · ${(next.L.km * (1 - p.frac)).toFixed(1)} km 到交棒點</span><span>預計 ${fmtT(next.end)}</span></div>
      <button class="btn" data-act="finish" data-n="${next.n}">完成交棒</button></div>`;
  } else {
    const prev = sch[next.n - 2];
    hero = `<div class="hero car${next.car}">
      <div class="label">你的下一棒 · 第 ${next.n} 棒 · Car${next.car}</div>
      <div class="cd-row"><span class="cd-label">距離起跑還有</span><span class="big num" data-countdown="${next.start}">${fmtCountdown((next.start - now) / 1000)}</span></div>
      <div class="handoff">
        ${prev ? runnerFig(runnerName(prev.runner), prev.car) : '<div class="fig"><div class="bib start">起點</div></div>'}
        <svg class="handoff-arrow" viewBox="0 0 48 24" aria-hidden="true"><path d="M2 12h40M32 4l10 8-10 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${runnerFig('我', next.car, true)}
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


// 交棒圖示：跑者剪影＋號碼布（號碼布文字用該棒所屬車的顏色）
const RUNNER_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="14" cy="4" r="2.2"/><path d="M10 8.5l4-1.5 2.5 3.5 3 1-.6 1.8-4-1.3-1.4-1.9-1.2 3.6 2.7 2.4V22h-2v-5l-3-2.6-1.6 3.9L4 21l-.8-1.8 3.9-1.6 2.4-5.8-1.8.8-1 2.6-1.8-.7 1.4-3.6z"/></svg>';
const runnerFig = (label, car, me) => `<div class="fig${me ? ' me' : ''}">${RUNNER_SVG}<div class="bib" style="color:${CAR_COLOR[car]}">${esc(label)}</div></div>`;

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
      <div class="bar"><i style="width:${(p.frac * 100).toFixed(0)}%"></i></div>
      <div class="row" style="font-size:13px"><span>已跑 <span class="num" data-elapsed="${run.start}">${fmtDur((now - run.start) / 1000)}</span>（推估位置）</span>
        <span>${nx ? `下一棒 ${runnerName(nx.runner)} · Car${nx.car}` : '最後一棒'}</span></div>
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
      <div class="bar"><i style="width:${(kmDone / D.totalKm * 100).toFixed(1)}%"></i></div>
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
function renderMap(now, sch) {
  document.getElementById('map-demo').innerHTML = demoBar();
  if (!map) return;
  const run = sch.find(s => s.status === 'run');
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
  const p = progressOf(run, now), pos = posAtKm(p.km);
  runnerMarker.setIcon(ICONS.runner
    ? L.divIcon({ className: '', iconSize: [36, 36],
        html: `<div class="runner-pin img" style="border-color:${CAR_COLOR[run.car]}"><img src="${ICONS.runner}" alt=""></div>` })
    : L.divIcon({ className: '', iconSize: [20, 20],
        html: `<div class="runner-pin" style="width:20px;height:20px;background:${CAR_COLOR[run.car]}"></div>` }));
  runnerMarker.setLatLng(pos).addTo(map);
  flagMarker.setLatLng(run.L.end).addTo(map);
  if (follow) map.panTo(pos);
  const nx = sch[run.n];
  card.innerHTML = `<div class="row"><span><span class="badge car${run.car}" style="display:inline-flex;width:28px;height:28px;font-size:13px;vertical-align:middle">${run.n}</span>
      <b style="margin-left:6px">${runnerName(run.runner)}</b> <span class="muted">Car${run.car}</span></span>
      <span class="num"><b>${(p.frac * 100).toFixed(0)}%</b> <span class="muted">· ${fmtT(run.end)} 預計抵達</span></span></div>
    <div class="muted" style="font-size:12px;margin-top:4px">位置是用配速推估的（尚未接 GPS）${nx ? ` · 下一棒 ${runnerName(nx.runner)}` : ''}</div>`;
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
    <p class="muted" style="font-size:13px;margin-top:0">大會規定：每人每輪剛好跑一棒、總共三棒；每輪前 5 棒的跑者坐 Car1、後 5 棒坐 Car2；受傷者剩下的棒次可由隊友代跑。</p>
    <div class="card rules">
      <div class="kv"><b>自動對調</b><span>某棒改成同一輪的另一個人，兩棒自動對調，每人每輪仍是一棒</span></div>
      <div class="kv"><b>已開跑鎖住</b><span>已完成或跑步中的棒次顯示 🔒，不能改</span></div>
      <div class="kv"><b>本輪已跑反灰</b><span>這一輪已經跑過的人選不到，標示「本輪已跑」</span></div>
      <div class="kv"><b>受傷代跑</b><span>在單棒詳情勾「受傷代跑」才允許有人多跑；受傷者退出後不能再回來跑</span></div>
      <div class="kv"><b>比賽中改順序</b><span>在「設定 → 棒次順序」改，只影響還沒跑的棒次</span></div>
      <div class="kv"><b>紅框／黃框</b><span>紅框是違反規定，要改；黃框是提醒（例如有人連跑兩棒、有代跑）</span></div>
    </div>
    <p class="muted" style="font-size:13px">換車提醒：同一輪內把 Car1 和 Car2 的人對調，兩人那一輪都要換車坐，記得在換車點（第 1、6、11…26 棒起點）先換好。</p>`);
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
function openSettings() {
  sheetLeg = null;
  const ps = Date.parse(cfg.planStart);
  openSheet(`<div class="sheet-head"><h3>設定</h3><button data-act="close">完成</button></div>
    <div class="card">
      <div class="kv"><span>我是</span><select data-act="set-me">${RUNNERS.map(r => `<option value="${r}" ${r === cfg.me ? 'selected' : ''}>${runnerName(r)}</option>`).join('')}</select></div>
      <div class="kv"><span>預計出發時間</span><input type="datetime-local" data-act="set-start" value="${toLocalInput(ps)}"></div>
    </div>
    <div class="row"><h2>棒次順序</h2><button class="chip plain" data-act="rules">📘 換棒規則</button></div>
    <p class="muted" style="font-size:13px;margin-top:0">每輪 10 棒照這個順序跑，第 2、3 輪相同。<b>左欄坐 Car1、右欄坐 Car2</b>。選到已經排在別棒的人，兩人會自動對調。比賽開始後再改，只影響還沒跑的棒次。</p>
    <div class="order-grid">${cfg.order.map((r, i) => `<label><span class="badge sm car${i < 5 ? 1 : 2}">${i + 1}</span>
      <select data-act="set-order" data-i="${i}">${RUNNERS.map(x => `<option value="${x}" ${x === r ? 'selected' : ''}>${runnerName(x)}</option>`).join('')}</select></label>`).join('')}</div>
    ${Object.keys(cfg.assign).length ? `<div class="card" style="margin-top:8px"><div class="kv"><span style="font-size:13px">另有個別調整：第 ${Object.keys(cfg.assign).sort((a, b) => a - b).join('、')} 棒</span>
      <button class="chip plain" data-act="clear-assign">全部清除</button></div></div>` : ''}
    <h2>隊員名字與平地配速（分:秒／公里）</h2>
    <div class="member-list">${RUNNERS.map(r => `<label><span class="muted num">${r}</span>
      <input data-act="set-name" data-r="${r}" value="${esc(cfg.names[r] || '')}" placeholder="${r} 號" maxlength="8">
      <input data-act="set-pace" data-r="${r}" value="${fmtPace(cfg.paces[r]).replace("'", ':').replace('"', '')}" inputmode="numeric" class="pace"></label>`).join('')}</div>
    <h2>示範模式</h2>
    <div class="card">
      <div class="kv"><span>用模擬時間看比賽中的畫面</span><input type="checkbox" data-act="set-demo" ${cfg.demo ? 'checked' : ''} style="width:22px;height:22px"></div>
      ${cfg.demo ? `<div style="padding-top:10px">模擬「出發後 <b id="demo-h">${cfg.demoHours}</b> 小時」＝<b id="demo-t">${fmtDT(nowMs())}</b>
        <input type="range" min="-1" max="30" step="0.25" value="${cfg.demoHours}" data-act="set-demo-h" style="width:100%;margin-top:8px;padding:0"></div>` : ''}
    </div>
    <h2>比賽紀錄</h2>
    <p class="muted" style="font-size:13px">目前紀錄只存在這支手機。之後接上後端，全隊的交棒紀錄才會同步。</p>
    <button class="btn warn" data-act="reset">清除這支手機的比賽紀錄</button>`);
}

// ---------- 主畫面更新 ----------
let tab = 'me';
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
      saveCfg(); toast('已清除還沒跑的個別調整'); openSettings(); render(); break;
    }
    case 'start':
      state = { raceStart: Date.now(), finishes: {} }; saveState(); toast('開跑！第 1 棒出發'); render(); break;
    case 'finish':
      state.finishes[n] = Date.now(); saveState(); toast(`第 ${n} 棒完成，交棒給第 ${n + 1} 棒`);
      if (sheetLeg) renderLegSheet(); render(); break;
    case 'undo':
      delete state.finishes[n]; saveState(); toast(`已取消第 ${n} 棒的完成紀錄`); renderLegSheet(); render(); break;
    case 'reset':
      if (!resetArmed) { resetArmed = true; a.textContent = '再按一次確認清除'; setTimeout(() => { resetArmed = false; }, 4000); break; }
      state = { raceStart: null, finishes: {} }; saveState(); resetArmed = false; toast('已清除比賽紀錄'); closeSheet(); render(); break;
  }
});
document.addEventListener('change', e => {
  const a = e.target.dataset.act;
  if (a === 'assign') {
    const n = +e.target.dataset.n;
    assignLeg(n, +e.target.value, subMode || !!cfg.sub[n]); renderLegSheet(); render();
  }
  if (a === 'set-sub') {
    subMode = e.target.checked;
    if (!subMode && sheetLeg) { delete cfg.sub[sheetLeg]; saveCfg(); }
    renderLegSheet(); render();
  }
  if (a === 'set-order') {
    // 比賽中改順序：已開跑、已完成的棒次先固定成目前的跑者，只影響還沒跑的棒次
    if (!cfg.demo) schedule(nowMs(), raceState(nowMs())).forEach(s => { if (s.status !== 'todo') cfg.assign[s.n] = s.runner; });
    const i = +e.target.dataset.i, v = +e.target.value, j = cfg.order.indexOf(v);
    if (j >= 0 && j !== i) cfg.order[j] = cfg.order[i];   // 對調，保持每人剛好一個位置
    cfg.order[i] = v;
    Object.keys(cfg.assign).forEach(n => { if (cfg.assign[n] === cfg.order[(n - 1) % 10]) delete cfg.assign[n]; });
    saveCfg(); openSettings(); render();
  }
  if (a === 'set-name') {
    const v = e.target.value.trim().slice(0, 8);
    if (v) cfg.names[+e.target.dataset.r] = v; else delete cfg.names[+e.target.dataset.r];
    saveCfg(); openSettings(); render();
  }
  if (a === 'set-me') { cfg.me = +e.target.value; saveCfg(); render(); }
  if (a === 'set-start' && e.target.value) {
    cfg.planStart = new Date(e.target.value + ':00+08:00').toISOString(); saveCfg(); openSettings(); render();
  }
  if (a === 'set-pace') {
    const v = parsePace(e.target.value);
    if (v && v >= 180 && v <= 900) { cfg.paces[+e.target.dataset.r] = v; saveCfg(); render(); }
    else { toast('配速格式像 7:00，範圍 3:00～15:00'); e.target.value = fmtPace(cfg.paces[+e.target.dataset.r]).replace("'", ':').replace('"', ''); }
  }
  if (a === 'set-demo') { cfg.demo = e.target.checked; saveCfg(); openSettings(); render(); }
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
