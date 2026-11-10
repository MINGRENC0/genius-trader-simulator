/* 天才交易员模拟器 · 期货核心：数据解码、保证金交易、存档。
   桌面端与手机端共用（同一响应式页面）。 */
(function (global) {
  'use strict';

  var EPOCH = Date.UTC(2019, 0, 1);
  var DAY = 86400000;
  var STEP = 22;
  var ROUND_KEY = 'klineFutRound';
  var DATE_CACHE = (function () {
    var list = [];
    for (var i = 0; i < 65536; i++) {
      var d = new Date(EPOCH + i * DAY);
      list[i] = d.getUTCFullYear() + '-' +
        String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(d.getUTCDate()).padStart(2, '0');
    }
    return list;
  })();

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function inflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function decode(bytes, e) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var bars = new Array(e.k);
    var pos = e.o * STEP;
    for (var i = 0; i < e.k; i++, pos += STEP) {
      bars[i] = {
        d: DATE_CACHE[view.getUint16(pos, true)],
        o: view.getInt32(pos + 2, true) / 1000,
        h: view.getInt32(pos + 6, true) / 1000,
        l: view.getInt32(pos + 10, true) / 1000,
        c: view.getInt32(pos + 14, true) / 1000,
        v: view.getInt32(pos + 18, true)
      };
    }
    return bars;
  }

  async function loadData() {
    var idx = global.KLINE_FUT_INDEX || [];
    var pack = global.KLINE_FUT_PACK;
    if (!pack) return [];
    var bytes = await inflate(base64ToBytes(pack));
    return idx.map(function (e) {
      return {
        code: e.c, name: e.n, ex: e.x, mul: e.mul, tick: e.tick, mr: e.mr,
        k: e.k, d0: e.d0, d1: e.d1, lo: e.lo, bars: decode(bytes, e)
      };
    });
  }

  /* ---------------- 账户与交易 ---------------- */
  function updn(r, price) {
    if (!r.dir || !r.lots) return 0;
    return (price - r.avg) * r.sym.mul * r.lots * r.dir;
  }
  function equityOf(r, price) { return r.cash + updn(r, price); }
  function marginOf(r, price) {
    if (!r.dir || !r.lots) return 0;
    return price * r.sym.mul * r.lots * r.sym.mr;
  }
  function availOf(r, price) { return equityOf(r, price) - marginOf(r, price); }
  function riskOf(r, price) {
    var m = marginOf(r, price);
    if (!(m > 0)) return 0;
    var e = equityOf(r, price);
    return e > 0 ? m / e : 99;
  }
  function feeOf(r, price, lots) {
    return price * r.sym.mul * lots * r.feeRate;
  }
  function maxLots(r, price, dir) {
    // 逐手试算，最多 500 手，避免极端价格下的死循环
    var n = 0, e0 = equityOf(r, price);
    for (var i = 1; i <= 500; i++) {
      var add = price * r.sym.mul * i * r.sym.mr;
      if (e0 - marginOf(r, price) < add + interestOf(r, price, i)) break;
      n = i;
    }
    return n;
  }
  function interestOf(r, price, lots) {
    // 期货无利息，保留接口便于扩展
    return 0;
  }

  function openPos(r, dir, price, lots, src) {
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    lots = Math.floor(lots);
    if (!(lots > 0)) return { ok: false, error: '请输入手数' };
    if (r.dir && r.dir !== dir) return { ok: false, error: '已有反向持仓，请先平仓' };
    var fee = feeOf(r, price, lots);
    var need = price * r.sym.mul * lots * r.sym.mr;
    if (availOf(r, price) < need + fee) {
      return { ok: false, error: '可用资金不足，最多可开 ' + maxLots(r, price, dir) + ' 手' };
    }
    if (r.dir === 0) {
      r.dir = dir;
      r.avg = price;
      r.lots = lots;
      r.entryIdx = r.cur;
    } else {
      r.avg = (r.avg * r.lots + price * lots) / (r.lots + lots);
      r.lots += lots;
    }
    r.cash -= fee;
    r.orders.push({
      i: r.cur, act: 'open', dir: dir, price: price, lots: lots, fee: fee, src: src || '手动'
    });
    return { ok: true, act: 'open', dir: dir, lots: lots, fee: fee };
  }

  function closePos(r, price, lots, src) {
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    if (!r.dir || !r.lots) return { ok: false, error: '当前没有持仓' };
    lots = lots > 0 ? Math.min(Math.floor(lots), r.lots) : r.lots;
    if (!(lots > 0)) return { ok: false, error: '请输入平仓手数' };
    var pnl = (price - r.avg) * r.sym.mul * lots * r.dir;
    var today = r.entryIdx === r.cur;
    var fee = feeOf(r, price, lots);
    var extra = today ? price * r.sym.mul * lots * 0.0001 : 0; // 平今仓加收 0.01%
    fee += extra;
    r.cash += pnl - fee;
    r.closed.push({
      i: r.cur, dir: r.dir, lots: lots, pnl: pnl, fee: fee, today: today,
      hold: r.cur - (r.entryIdx == null ? r.cur : r.entryIdx), src: src || '手动'
    });
    r.orders.push({
      i: r.cur, act: 'close', dir: r.dir, price: price, lots: lots, fee: fee, pnl: pnl, today: today, src: src || '手动'
    });
    r.lots -= lots;
    if (r.lots <= 0) { r.lots = 0; r.dir = 0; r.avg = 0; r.entryIdx = null; }
    return { ok: true, act: 'close', lots: lots, fee: fee, extraFee: extra, pnl: pnl };
  }

  function checkForced(r, price) {
    if (!r || r.finished || !r.dir || !r.lots) return null;
    var risk = riskOf(r, price);
    if (risk < 1) return null;
    var lots = r.lots;
    var slip = r.sym.tick || 0;
    var px = Math.max(0.0001, price + (r.dir > 0 ? -slip : slip)); // 强平按对手价滑点 1 跳
    closePos(r, px, lots, '强制平仓');
    r.forced = (r.forced || 0) + 1;
    return { risk: risk, lots: lots, price: px, slip: slip };
  }

  /* ---------------- 隔夜挂单 ---------------- */
  // act: 'open' 开仓（dir 1/-1）；'close' 平仓（按当前持仓方向）
  // 挂单在后续每根 K 线检查，触及挂单价即成交，可跨交易日保留
  function placePending(r, act, dir, price, lots, mode) {
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    mode = mode === 'market' ? 'market' : 'limit';
    price = Number(price);
    lots = Math.floor(Number(lots));
    if (mode === 'limit' && !(price > 0)) return { ok: false, error: '请输入挂单价格' };
    if (mode === 'market') price = 0;
    if (!(lots > 0)) return { ok: false, error: '请输入挂单手数' };
    if (!r.pending) r.pending = [];
    if (r.pending.length >= 10) return { ok: false, error: '最多同时挂 10 笔' };
    if (act === 'open') {
      dir = dir > 0 ? 1 : -1;
      if (r.dir && r.dir !== dir) return { ok: false, error: '已有反向持仓，请先平仓' };
      var px = mode === 'market' ? r.sym.bars[r.cur].c : price;
      var fee = feeOf(r, px, lots);
      var need = px * r.sym.mul * lots * r.sym.mr;
      if (availOf(r, px) < need + fee) {
        return { ok: false, error: '按该价格挂单可用资金不足，最多可开 ' + maxLots(r, px, dir) + ' 手' };
      }
    } else {
      if (!r.dir || !r.lots) return { ok: false, error: '当前没有持仓可平' };
      dir = r.dir;
      var booked = 0;
      for (var i = 0; i < r.pending.length; i++) {
        if (r.pending[i].act === 'close') booked += r.pending[i].lots;
      }
      if (booked + lots > r.lots) {
        return { ok: false, error: '平仓挂单超过可平手数（持仓 ' + r.lots + ' 手，已挂 ' + booked + ' 手）' };
      }
    }
    r.pkSeq = (r.pkSeq || 0) + 1;
    r.pending.push({ id: r.pkSeq, act: act, dir: dir, price: price, lots: lots, mode: mode, at: r.cur });
    return { ok: true, id: r.pkSeq };
  }

  function cancelPending(r, id) {
    if (!r || !r.pending) return false;
    for (var i = 0; i < r.pending.length; i++) {
      if (r.pending[i].id === id) { r.pending.splice(i, 1); return true; }
    }
    return false;
  }

  // 每根新 K 线调用：触及挂单价则成交；跳空时按更优的开盘价成交
  function checkPending(r) {
    if (!r || r.finished || !r.pending || !r.pending.length) return [];
    var bar = r.sym.bars[r.cur];
    var done = [], keep = [];
    for (var k = 0; k < r.pending.length; k++) {
      var p = r.pending[k], fill = null, res = null;
      var isMarket = p.mode === 'market';
      if (p.act === 'open') {
        if (isMarket) fill = bar.o;
        else if (p.dir > 0 && bar.l <= p.price) fill = Math.min(p.price, bar.o);
        else if (p.dir < 0 && bar.h >= p.price) fill = Math.max(p.price, bar.o);
        if (fill == null) { keep.push(p); continue; }
        res = openPos(r, p.dir, fill, p.lots, isMarket ? '市价挂单' : '限价挂单');
        done.push({ ok: res.ok, p: p, fill: fill, error: res.error });
      } else {
        if (!r.dir || !r.lots || r.dir !== p.dir) {
          done.push({ ok: false, p: p, fill: null, error: '持仓已变化，挂单撤销' });
          continue;
        }
        if (isMarket) fill = bar.o;
        else if (p.dir > 0 && bar.h >= p.price) fill = Math.max(p.price, bar.o);
        else if (p.dir < 0 && bar.l <= p.price) fill = Math.min(p.price, bar.o);
        if (fill == null) { keep.push(p); continue; }
        res = closePos(r, fill, Math.min(p.lots, r.lots), isMarket ? '市价挂单' : '限价挂单');
        done.push({ ok: res.ok, p: p, fill: fill, error: res.error });
      }
    }
    r.pending = keep;
    return done;
  }

  function newRound(sym, start, len, capital, feeRate) {
    return {
      sym: sym, start: start, len: len, end: start + len - 1, cur: start,
      initial: capital, cash: capital,
      dir: 0, lots: 0, avg: 0, entryIdx: null,
      orders: [], closed: [], pending: [], pkSeq: 0,
      rumors: [],
      curve: [{ i: start, eq: capital }], peak: capital, mdd: 0,
      feeRate: feeRate, forced: 0, finished: false
    };
  }

  function saveRound(r) {
    if (!r || r.finished) return;
    try {
      localStorage.setItem(ROUND_KEY, JSON.stringify({
        v: 2, code: r.sym.code,
        start: r.start, cur: r.cur, len: r.len, end: r.end,
        sd: r.sym.bars[r.start].d, cd: r.sym.bars[r.cur].d,
        initial: r.initial, cash: r.cash, dir: r.dir, lots: r.lots, avg: r.avg,
        entryIdx: r.entryIdx, orders: r.orders, closed: r.closed,
        pending: r.pending || [], pkSeq: r.pkSeq || 0,
        rumors: r.rumors || [],
        curve: r.curve, peak: r.peak, mdd: r.mdd,
        feeRate: r.feeRate, forced: r.forced || 0
      }));
    } catch (e) { }
  }
  function clearRound() {
    try { localStorage.removeItem(ROUND_KEY); } catch (e) { }
  }
  function loadRound(raw, warmup) {
    var o;
    try { o = JSON.parse(localStorage.getItem(ROUND_KEY) || 'null'); } catch (e) { return null; }
    if (!o || (o.v !== 1 && o.v !== 2) || !o.code) return null;
    var sym = null;
    for (var i = 0; i < raw.length; i++) if (raw[i].code === o.code) { sym = raw[i]; break; }
    if (!sym) return null;
    var si = -1, ci = -1;
    for (var j = 0; j < sym.bars.length; j++) {
      if (sym.bars[j].d === o.sd) si = j;
      if (sym.bars[j].d === o.cd) ci = j;
    }
    if (si < 0 || ci < 0) return null;
    if (ci < si || si + o.len - 1 >= sym.bars.length) return null;
    var delta = si - o.start;
    var shift = function (arr) {
      return (arr || []).map(function (x) { x.i += delta; return x; });
    };
    var r = {
      sym: sym, start: si, len: o.len, end: si + o.len - 1, cur: ci,
      initial: o.initial, cash: o.cash, dir: o.dir || 0, lots: o.lots || 0,
      avg: o.avg || 0, entryIdx: o.entryIdx == null ? null : o.entryIdx + delta,
      orders: shift(o.orders), closed: shift(o.closed),
      pending: (o.pending || []).map(function (x) { x.at = (x.at == null ? 0 : x.at) + delta; return x; }),
      pkSeq: o.pkSeq || 0,
      rumors: (o.rumors || []).map(function (x) { x.i = (x.i == null ? 0 : x.i) + delta; return x; }),
      curve: shift(o.curve), peak: o.peak || o.initial, mdd: o.mdd || 0,
      feeRate: o.feeRate > 0 ? o.feeRate : 0.0001, forced: o.forced || 0,
      finished: false
    };
    if (r.curve.length && r.curve[r.curve.length - 1].i !== r.cur) {
      r.curve.push({ i: r.cur, eq: equityOf(r, sym.bars[r.cur].c) });
    }
    return r;
  }

  /* ---------------- 心理训练：传闻、行为、赛季 ---------------- */
  var RUMOR_TPL = [
    { d: 1, t: '传主要产区天气异常，减产预期升温' },
    { d: 1, t: '市场传闻某大型贸易商正在囤货，现货升水扩大' },
    { d: 1, t: '机构调研显示下游补库意愿增强' },
    { d: 1, t: '传海外矿企发运受阻，到港量或低于预期' },
    { d: 1, t: '传部分产线临时检修，短期供应偏紧' },
    { d: 1, t: '宏观资金面转松，商品多头氛围升温' },
    { d: 1, t: '传某主力多头席位连续增仓' },
    { d: 1, t: '库存去化快于季节性，市场看涨情绪升温' },
    { d: 1, t: '出口订单回暖，需求端出现边际改善' },
    { d: 1, t: '传运费上涨推升到岸成本' },
    { d: -1, t: '传交易所拟上调保证金比例，投机资金或撤离' },
    { d: -1, t: '市场传闻进口配额将放宽，供应压力上升' },
    { d: -1, t: '下游需求走弱，库存连续累积' },
    { d: -1, t: '传某主力多头资金减仓离场' },
    { d: -1, t: '产区天气转好，减产炒作降温' },
    { d: -1, t: '传新增产能提前投产，远期供给宽松' },
    { d: -1, t: '现货成交清淡，贸易商降价出货' },
    { d: -1, t: '宏观数据不及预期，风险偏好回落' },
    { d: -1, t: '传仓单注册量大幅增加，盘面承压' },
    { d: -1, t: '远月合约贴水扩大，市场预期转弱' },
    { d: 0, t: '市场等待本周宏观数据指引，资金观望' },
    { d: 0, t: '远近月价差收敛，多空分歧加大' },
    { d: 0, t: '持仓量小幅变化，暂无明显驱动' },
    { d: 0, t: '交易所提示近期波动加大，注意风险' },
    { d: 0, t: '分析师观点分化，短期方向不明' },
    { d: 0, t: '现货报价持稳，市场成交一般' }
  ];
  function seedOf(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function randOf(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 平均每 3 根 K 线一条传闻，落点确定且不重复
  function genRumors(sym, start, len) {
    var corridor = Math.max(2, len - 2);
    var count = Math.max(2, Math.round(len / 3));
    if (count > corridor) count = corridor;
    var rnd = randOf(seedOf(sym.code + '|' + start + '|' + len + '|fut'));
    var arr = [];
    for (var i = 0; i < corridor; i++) arr.push(i);
    for (var j = 0; j < count; j++) {
      var k = j + Math.floor(rnd() * (corridor - j));
      var tmp = arr[j]; arr[j] = arr[k]; arr[k] = tmp;
    }
    var spots = arr.slice(0, count).sort(function (a, b) { return a - b; });
    return spots.map(function (off) {
      var t = RUMOR_TPL[Math.floor(rnd() * RUMOR_TPL.length)];
      return { i: start + 1 + off, dir: t.d, text: t.t };
    });
  }
  // 之后 10 根 K 线的方向是否与传闻一致
  function verifyRumors(list, bars, end) {
    return (list || []).map(function (x) {
      var j = Math.min(end, x.i + 10);
      if (!bars[x.i] || !bars[j] || j <= x.i) {
        return { text: x.text, dir: x.dir, i: x.i, ret: null, verdict: '无法验证' };
      }
      var ret = bars[j].c / bars[x.i].c - 1;
      var verdict;
      if (!x.dir) verdict = Math.abs(ret) < 0.005 ? '无法验证' : '中性';
      else if (Math.abs(ret) < 0.005) verdict = '无法验证';
      else verdict = ((ret > 0) === (x.dir > 0)) ? '证实' : '证伪';
      return { text: x.text, dir: x.dir, i: x.i, ret: ret, verdict: verdict };
    });
  }

  // 连亏加仓 / 处置效应 / 过度交易 / 追势
  function analyzeBehavior(r) {
    var out = {
      trips: 0, winRate: 0, avgHoldWin: 0, avgHoldLoss: 0,
      dispose: false, overtrade: false, turnover: 0,
      addCount: 0, addLots: 0, addHeat: 0, chaseCount: 0, chaseWin: 0
    };
    if (!r) return out;
    var closed = r.closed || [], orders = r.orders || [];
    var wins = 0, hw = 0, hl = 0, nw = 0, nl = 0;
    for (var i = 0; i < closed.length; i++) {
      var c = closed[i];
      if (c.pnl > 0) { wins++; hw += c.hold || 0; nw++; } else { hl += c.hold || 0; nl++; }
    }
    out.trips = closed.length;
    out.winRate = closed.length ? wins / closed.length : 0;
    out.avgHoldWin = nw ? hw / nw : 0;
    out.avgHoldLoss = nl ? hl / nl : 0;
    out.dispose = closed.length >= 4 && nw > 0 && nl > 0 &&
      out.avgHoldWin < out.avgHoldLoss * 0.8;
    var barsUsed = Math.max(1, r.cur - r.start + 1);
    out.turnover = closed.length / barsUsed * 100;
    out.overtrade = out.turnover > 8;

    var streak = 0, posLots = 0, posDir = 0, lastLots = 0;
    var bars = r.sym && r.sym.bars;
    for (var k = 0; k < orders.length; k++) {
      var o = orders[k];
      if (o.act === 'open') {
        if (bars && o.i >= 3) {
          var b1 = bars[o.i - 1], b2 = bars[o.i - 2], b3 = bars[o.i - 3];
          var up = b1 && b2 && b3 && b1.c > b2.c && b2.c > b3.c;
          var dn = b1 && b2 && b3 && b1.c < b2.c && b2.c < b3.c;
          if ((o.dir > 0 && up) || (o.dir < 0 && dn)) out.chaseCount++;
        }
        // 连亏两笔后继续开仓，且仓位不低于上一笔：视为亏损后加仓/加码
        var adding = (posDir === o.dir && posLots > 0) || (o.lots || 0) > lastLots;
        if (streak >= 2 && adding) {
          out.addCount++;
          out.addLots += o.lots || 0;
          out.addHeat += (o.price || 0) * (r.sym.mul || 1) * (o.lots || 0) * (r.sym.mr || 0.1);
        }
        if (posDir === o.dir) posLots += o.lots || 0;
        else { posDir = o.dir; posLots = o.lots || 0; }
      } else if (o.act === 'close') {
        if (posDir === o.dir) posLots = Math.max(0, posLots - (o.lots || 0));
        lastLots = o.lots || 0;
        if (posLots <= 0) { posLots = 0; posDir = 0; }
        if (o.pnl < 0) streak++; else streak = 0;
      }
    }
    return out;
  }

  var SEASON_KEY = 'klineFutSeason';
  function seasonGet() {
    try { return JSON.parse(localStorage.getItem(SEASON_KEY) || 'null'); } catch (e) { return null; }
  }
  function seasonSave(s) {
    try { localStorage.setItem(SEASON_KEY, JSON.stringify(s)); } catch (e) { }
  }
  function seasonBegin(len, cap) {
    return {
      len: Math.max(10, Math.min(50, Number(len) || 20)), done: false,
      startCap: Number(cap) || 500000, cap: Number(cap) || 500000,
      rounds: [], startT: Date.now()
    };
  }
  function seasonReset() {
    try { localStorage.removeItem(SEASON_KEY); } catch (e) { }
  }

  global.KC_FUT = {
    loadData: loadData, newRound: newRound,
    equityOf: equityOf, marginOf: marginOf, availOf: availOf, riskOf: riskOf, feeOf: feeOf,
    maxLots: maxLots, openPos: openPos, closePos: closePos, checkForced: checkForced,
    placePending: placePending, cancelPending: cancelPending, checkPending: checkPending,
    genRumors: genRumors, verifyRumors: verifyRumors, analyzeBehavior: analyzeBehavior,
    seasonGet: seasonGet, seasonSave: seasonSave, seasonBegin: seasonBegin, seasonReset: seasonReset,
    saveRound: saveRound, clearRound: clearRound, loadRound: loadRound, ROUND_KEY: ROUND_KEY
  };
})(typeof window !== 'undefined' ? window : this);
