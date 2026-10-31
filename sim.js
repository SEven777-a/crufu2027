// 模擬模式：網址加 ?sim 時載入（在 app.js 之前）
// 假的 10 人比賽：時間加速、每人每分鐘一筆 GPS（交棒由 app 的 GPS 自動交棒處理，也可打開「代按交棒」）；
// 攔截 team 函式的請求在本機回應，不連真的 Supabase，也不動正式 app 的存檔（存檔加 sim. 前綴）
'use strict';
window.CRUFU_SIM = true;
(() => {
  const D = window.CRUFU_DATA, T = D.track, START = Date.parse(D.planStart);
  const NAMES = { 1: '阿哲', 2: '小芸', 3: '大熊', 4: 'Ken', 5: '阿凱', 6: '小米', 7: '老王', 8: 'Amy', 9: '阿Ben', 10: '小安' };
  const PACES = { 1: 330, 2: 365, 3: 345, 4: 390, 5: 420, 6: 375, 7: 405, 8: 350, 9: 440, 10: 380 };  // 秒/公里
  const ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const CAR_KMH = 45;                         // 車子沿路線移動的速度
  const MIN = 60e3;

  // 固定種子的亂數：每次重開都是同一場比賽
  let seed = 2027;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  // ---------- 這場模擬比賽的「真實」經過 ----------
  const carOfLeg = i => (i % 10) < 5 ? 1 : 2;
  const runnerOfLeg = i => ORDER[i % 10];
  const legT = [];                            // 每棒真實起訖時間
  let t = START;
  D.legs.forEach((L, i) => {
    const r = runnerOfLeg(i);
    const slow = L.level === '難' ? 1.12 : L.level === '中' ? 1.05 : 1;
    const dur = L.km * PACES[r] * slow * (0.95 + rnd() * 0.14) + 40 + rnd() * 50;
    legT.push({ start: t, end: t + dur * 1000 });
    t += dur * 1000;
  });
  const legAt = tau => legT.findIndex(x => tau >= x.start && tau < x.end);

  // 路線上某公里的座標
  function posAtKm(km) {
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m][2] <= km) lo = m; else hi = m; }
    const a = T[lo], b = T[hi], f = b[2] > a[2] ? Math.min(1, Math.max(0, (km - a[2]) / (b[2] - a[2]))) : 0;
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
  }
  // 車子的行程：本車棒次開跑時先開到該棒終點（交接點）等；本段最後一棒交完，休息 5 分鐘後開到本車下一段的起點
  function carMoves(c) {
    const mv = [{ at: START, from: 0, to: 0 }];
    if (c === 2) mv.push({ at: START + 10 * MIN, from: 0, to: D.legs[5].startKm });
    D.legs.forEach((L, i) => {
      if (carOfLeg(i) !== c) return;
      mv.push({ at: legT[i].start, to: L.endKm });
      if (i % 5 === 4) mv.push({ at: legT[i].end + 5 * MIN, to: i + 6 < 30 ? D.legs[i + 6].startKm : D.legs[29].endKm });
    });
    let km = 0;
    return mv.map(m => { const o = { at: m.at, from: km, to: m.to }; km = m.to; return o; });
  }
  const MOVES = { 1: carMoves(1), 2: carMoves(2) };
  function carKm(c, tau) {
    let m = MOVES[c][0];
    for (const x of MOVES[c]) if (x.at <= tau) m = x;
    const need = Math.abs(m.to - m.from) / CAR_KMH * 3600e3;
    return m.from + (m.to - m.from) * (need ? Math.min(1, (tau - m.at) / need) : 1);
  }
  // 某人在某時刻的位置：正在跑 → 路線上；沒在跑 → 跟著自己的車（每人散開十幾公尺）
  function personAt(p, tau) {
    const i = legAt(tau), jitter = () => (rnd() - 0.5) * 0.00015;
    if (i >= 0 && runnerOfLeg(i) === p) {
      const L = D.legs[i], f = (tau - legT[i].start) / (legT[i].end - legT[i].start);
      const [lat, lon] = posAtKm(L.startKm + f * L.km);
      return [lat + jitter(), lon + jitter()];
    }
    const c = ORDER.indexOf(p) < 5 ? 1 : 2;
    const [lat, lon] = tau >= legT[29].end ? posAtKm(D.totalKm) : posAtKm(carKm(c, tau));
    return [lat + p * 0.00004 + jitter(), lon - p * 0.00003 + jitter()];
  }
  const battAt = (p, tau) => Math.max(8, Math.round(100 - (tau - START) / 3600e3 * (2.2 + p * 0.15)));

  // ---------- 模擬時鐘（覆寫 Date.now，app 的「現在」跟著走） ----------
  const realNow = Date.now.bind(Date);
  const clock = { base: START - 5 * MIN, real: realNow(), speed: 60 };
  Date.now = () => clock.base + (realNow() - clock.real) * clock.speed;
  const setSpeed = s => { clock.base = Date.now(); clock.real = realNow(); clock.speed = s; };
  const jump = ms => { clock.base = Date.now() + ms; clock.real = realNow(); };

  // ---------- 假的 team 函式 ----------
  const srv = {
    config: { planStart: D.planStart, paces: PACES, names: NAMES, order: ORDER, assign: {}, sub: {} },
    cfgAt: new Date(START - 86400e3).toISOString(),
    events: {}, undone: new Set(), genUntil: 0, auto: false,   // app 會用 GPS 自動交棒；打開「代按交棒」＝模擬有人手動按
  };
  const iso = ms => new Date(ms).toISOString();
  function autoPress(now) {
    if (now >= START && srv.events[0] == null && !srv.undone.has(0)) srv.events[0] = START;   // 開跑一律代按
    if (!srv.auto) return;
    legT.forEach((x, i) => {
      const at = x.end + 30e3;                // 到點後 30 秒有人按交棒
      if (now >= at && srv.events[i + 1] == null && !srv.undone.has(i + 1)) srv.events[i + 1] = at;
    });
  }
  function genLocations(now) {
    const from = Math.max(srv.genUntil, now - 20 * MIN), rows = [];
    for (let tau = Math.ceil(from / MIN) * MIN; tau <= now; tau += MIN) {
      ORDER.forEach(p => {
        const [lat, lon] = personAt(p, tau);
        rows.push({ person: String(p), lat, lon, acc: 10, vel: null, batt: battAt(p, tau), conn: 'm',
          recorded_at: iso(tau), received_at: iso(tau + 3e3) });
      });
    }
    srv.genUntil = now + 1;
    return rows;
  }
  function handle(b) {
    const now = Date.now(), admin = b.pin === 'sim';
    switch (b.op) {
      case 'sync':
        autoPress(now);
        return { admin, now: iso(now), config: { data: srv.config, updated_at: srv.cfgAt },
          events: Object.keys(srv.events).map(Number).sort((a, c) => a - c).map(leg => ({ leg, at: iso(srv.events[leg]) })),
          locations: genLocations(now) };
      case 'finish': srv.events[b.leg] = Date.parse(b.at); srv.undone.delete(b.leg); return { ok: true };
      case 'unfinish': delete srv.events[b.leg]; srv.undone.add(Number(b.leg)); return { ok: true };
      case 'config': srv.config = b.data; srv.cfgAt = iso(now); return { ok: true };
      case 'reset': srv.events = {}; srv.undone = new Set([...Array(31).keys()]); return { ok: true };
      case 'check': return { ok: true, admin };
    }
    return { error: '未知的操作' };
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opt) => {
    if (!String(url).includes('/functions/v1/team')) return realFetch(url, opt);
    const body = handle(JSON.parse(opt.body));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // ---------- 每次打開都重新開始：清掉上次模擬的存檔，預設「我是 1 號」、管理員已解鎖 ----------
  try {
    Object.keys(localStorage).filter(k => k.startsWith('sim.')).forEach(k => localStorage.removeItem(k));
    localStorage.setItem('sim.crufu.cfg.v1', JSON.stringify({ me: 1, demo: false }));
    localStorage.setItem('sim.crufu.key.v1', 'sim');
    localStorage.setItem('sim.crufu.pin.v1', 'sim');
  } catch (e) { /* 存不了也能跑，只是每次要重選「我是」 */ }

  // ---------- 控制列（底部導覽上方） ----------
  const fmt = ms => new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false });
  const css = `
    .sim-bar { position: fixed; left: 0; right: 0; bottom: calc(var(--nav-h) + env(safe-area-inset-bottom)); z-index: 1500;
      background: #4c1d95; color: #fff; font-size: 13px; padding: 6px 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .sim-bar b { font-variant-numeric: tabular-nums; }
    .sim-bar .grow { flex: 1; min-width: 120px; }
    .sim-bar button { background: rgba(255,255,255,.16); border-radius: 7px; padding: 4px 8px; font-size: 13px; }
    .sim-bar button.on { background: #fbbf24; color: #111; font-weight: 700; }
    body.sim .tab { bottom: calc(var(--nav-h) + env(safe-area-inset-bottom) + var(--sim-h, 40px)); }
    body.sim .toast { bottom: calc(var(--nav-h) + var(--sim-h, 40px) + 20px); }`;
  document.addEventListener('DOMContentLoaded', () => {
    document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
    document.body.classList.add('sim');
    const bar = document.createElement('div');
    bar.className = 'sim-bar';
    document.body.appendChild(bar);
    const draw = () => {
      const now = Date.now(), i = legAt(now);
      const what = now < START ? '開跑前' : i < 0 ? '已完賽' : `真實：第 ${i + 1} 棒 ${NAMES[runnerOfLeg(i)]} 在跑`;
      bar.innerHTML = `<span class="grow">🧪 模擬 <b>${fmt(now)}</b> · ${what}</span>
        ${[1, 60, 300, 900].map(s => `<button data-sp="${s}" class="${clock.speed === s ? 'on' : ''}">${s}×</button>`).join('')}
        <button data-j="30">+30分</button><button data-j="180">+3時</button>
        <button data-auto class="${srv.auto ? 'on' : ''}">代按交棒</button><button data-reset>重來</button>`;
      document.body.style.setProperty('--sim-h', bar.offsetHeight + 'px');   // 控制列在手機上會折成兩行
    };
    bar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.sp) setSpeed(+b.dataset.sp);
      else if (b.dataset.j) jump(b.dataset.j * MIN);
      else if ('auto' in b.dataset) srv.auto = !srv.auto;
      else if ('reset' in b.dataset) return location.reload();
      draw(); window.doSync && doSync();
    });
    draw();
    setInterval(draw, 1000);
    setInterval(() => window.doSync && doSync(), 2000);   // 加速時更常同步，畫面才跟得上
  });
})();
