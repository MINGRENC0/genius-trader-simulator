/* 天才交易员模拟器 公共模块：数据解码、交易规则、成交、挂单、存档。
   桌面版与手机版共用，避免同一规则改两遍。 */
(function (global) {
  'use strict';

  /* ---------------- 交易规则 ---------------- */
  var FEE_RATE = 0.0002;   // 佣金 0.02%
  var MIN_FEE = 5;         // 单笔最低 5 元
  var SELL_TAX = 0.0005;   // 卖出印花税 0.05%
  var FEES = { rate: FEE_RATE, min: MIN_FEE, tax: SELL_TAX };
  var LIMIT_PCT = { '创业板': 0.2, '科创板': 0.2, '北证': 0.3 };

  var HK_STAMP = 0.001;      // 港股印花税 0.1%（双边）
  var HK_TRADE_FEE = 0.000085; // 交易费/征费/会费合计约 0.0085%
  function feeOf(amount, sym) {
    var fee = Math.max(amount * FEES.rate, FEES.min);
    if (sym && sym.cat === '港股通') fee += amount * (HK_STAMP + HK_TRADE_FEE);
    return fee;
  }
  function sellFeeOf(amount, sym) {
    if (sym && sym.cat === '港股通') return feeOf(amount, sym); // 港股无 A 股卖出印花税，印花税已含在双边费用里
    return feeOf(amount) + amount * FEES.tax;
  }
  function setFees(opt) {
    opt = opt || {};
    var r = Number(opt.rate), m = Number(opt.min), t = Number(opt.tax);
    FEES.rate = isFinite(r) && r >= 0 && r <= 0.01 ? r : 0.0002;
    FEES.min = isFinite(m) && m >= 0 && m <= 100 ? m : 5;
    FEES.tax = isFinite(t) && t >= 0 && t <= 0.01 ? t : 0.0005;
    return { rate: FEES.rate, min: FEES.min, tax: FEES.tax };
  }
  function getFees() { return { rate: FEES.rate, min: FEES.min, tax: FEES.tax }; }
  function limitPctOf(cat, sym) {
    if (sym && /ST/i.test(sym.name || '')) return 0.05; // ST/*ST 涨跌幅 5%
    if (LIMIT_PCT[cat]) return LIMIT_PCT[cat];
    // 创业板/科创板 ETF 涨跌幅 20%
    if (cat === 'ETF' && sym && /创业板|科创/.test(sym.name || '')) return 0.20;
    return 0.10;
  }
  function limitsOf(prevClose, cat, sym) {
    var p = limitPctOf(cat, sym);
    return {
      up: Math.round(prevClose * (1 + p) * 100) / 100,
      dn: Math.round(prevClose * (1 - p) * 100) / 100
    };
  }
  // 港股通按每手股数；科创板 200 股起、1 股递增；其余 100 股整数倍
  function lotRule(sym) {
    var cat = sym && sym.cat;
    if (cat === '港股通') {
      var lot = 100;
      if (global.KLINE_LOTS && sym.code && global.KLINE_LOTS[sym.code] > 0) {
        lot = global.KLINE_LOTS[sym.code];
      }
      return { min: lot, step: lot, hk: true };
    }
    if (cat === '科创板') return { min: 200, step: 1 };
    if (cat === '北证') return { min: 100, step: 1 };
    return { min: 100, step: 100 };
  }

  /* ---------------- 决策标签 ---------------- */
  var TAGS = ['突破', '回踩', '超跌', '追涨', '其他'];

  /* ---------------- 成交 ---------------- */
  function executeTrade(r, side, price, frac, opts) {
    opts = opts || {};
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    var bar = r.sym.bars[r.cur];
    var prev = r.cur > 0 ? r.sym.bars[r.cur - 1].c : bar.o;
    var lim = limitsOf(prev, r.sym.cat, r.sym);
    if (r.sym.cat !== '港股通') {
      if (side === 'B' && price >= lim.up - 0.001) return { ok: false, error: '涨停封板，买不进去' };
      if (side === 'S' && price <= lim.dn + 0.001) return { ok: false, error: '跌停封板，卖不出去' };
    }

    if (side === 'B') {
      var rule = lotRule(r.sym);
      var want = opts.qty > 0
        ? Math.floor(opts.qty / rule.step) * rule.step
        : Math.floor((r.cash * frac) / price / rule.step) * rule.step;
      if (want > 0 && want < rule.min) want = rule.min;
      // 两融账户里，普通买入同样占用总敞口额度，避免用融券所得现金绕过杠杆上限
      if (r.margin) {
        var mMax = marginMaxQty(r, price);
        if (mMax < rule.min) {
          return { ok: false, error: '两融额度不足，无法继续买入' };
        }
        if (want > mMax) want = mMax;
      }
      var qty = Math.min(want, Math.floor(r.cash / price / rule.step) * rule.step);
      while (qty >= rule.min && qty * price + feeOf(qty * price, r.sym) > r.cash) qty -= rule.step;
      if (qty < rule.min) {
        return { ok: false, error: '现金不足，无法买入 ' + rule.min + ' 股' };
      }
      var cost = qty * price;
      var fee = feeOf(cost, r.sym);
      var prevCost = r.avgCost * r.shares;
      var wasFlat = r.shares <= 0;
      r.cash -= cost + fee;
      r.shares += qty;
      r.avgCost = (prevCost + cost + fee) / r.shares;
      if (r.entryIdx == null) r.entryIdx = r.cur;
      if (wasFlat) r.entryTag = opts.tag || '';
      r.dayBought = { i: r.cur, qty: (r.dayBought && r.dayBought.i === r.cur ? r.dayBought.qty : 0) + qty };
      r.orders.push({ i: r.cur, side: 'B', price: price, qty: qty, fee: fee, tag: opts.tag || '', src: opts.src || '手动' });
      return { ok: true, side: 'B', qty: qty, fee: fee, price: price };
    }

    if (r.shares <= 0) return { ok: false, error: '当前空仓，没有可卖出的份额' };
    var locked = (r.sym.cat !== '港股通' && r.dayBought && r.dayBought.i === r.cur) ? r.dayBought.qty : 0;
    var sellable = r.shares - locked;
    if (sellable <= 0) return { ok: false, error: 'T+1：当日买入的份额需下一交易日才能卖出' };
    var q;
    var rule2 = lotRule(r.sym);
    if (rule2.step !== 100 || rule2.min !== 100) {
      q = opts.qty > 0 ? Math.floor(opts.qty / rule2.step) * rule2.step : Math.floor(sellable * frac / rule2.step) * rule2.step;
      if (sellable <= rule2.min) q = sellable;
      else if (q < rule2.min) q = rule2.min;
      q = Math.min(q, sellable);
    } else {
      q = opts.qty > 0
        ? Math.min(Math.floor(opts.qty / 100) * 100, sellable)
        : Math.floor((sellable * frac) / 100) * 100;
      if (q < 100) q = sellable;
      q = Math.min(q, sellable);
    }
    if (q <= 0) return { ok: false, error: '暂无持仓' };

    var proceeds = q * price;
    var sfee = sellFeeOf(proceeds, r.sym);
    var pnl = (price - r.avgCost) * q - sfee;
    r.cash += proceeds - sfee;
    r.shares -= q;
    r.closed.push({
      i: r.cur,
      pnl: pnl,
      ret: r.avgCost ? price / r.avgCost - 1 : 0,
      cost: r.avgCost || 0,
      price: price,
      hold: r.cur - (r.entryIdx == null ? r.cur : r.entryIdx),
      tag: r.entryTag || '',
      src: opts.src || '手动'
    });
    r.orders.push({ i: r.cur, side: 'S', price: price, qty: q, fee: sfee, pnl: pnl, src: opts.src || '手动' });
    if (r.shares <= 0) { r.shares = 0; r.avgCost = 0; r.entryIdx = null; r.entryTag = ''; }
    return { ok: true, side: 'S', qty: q, fee: sfee, price: price };
  }

  /* ---------------- 融资融券（训练简化模型） ---------------- */
  // 融资保证金比例 80%；融资年化 6.5%，融券年化 8.5%；维持担保比例 140% 警戒、130% 强平
  var MARGIN = { ratio: 0.8, finRate: 0.065, shortRate: 0.085, warn: 1.4, close: 1.3 };

  // 每局可单独保存两融参数，避免中途改设置影响已开始的对局
  function marginCfg(r) {
    var c = (r && r.marginCfg) || {};
    return {
      ratio: c.ratio > 0 ? c.ratio : MARGIN.ratio,
      finRate: c.finRate >= 0 ? c.finRate : MARGIN.finRate,
      shortRate: c.shortRate >= 0 ? c.shortRate : MARGIN.shortRate,
      warn: MARGIN.warn,
      close: MARGIN.close
    };
  }

  function marginDebt(r, price) {
    return (r.finDebt || 0) + (r.finInterest || 0) +
      (r.shortShares || 0) * price + (r.shortInterest || 0);
  }
  function equityOf(r, price) {
    return r.cash + (r.shares || 0) * price - marginDebt(r, price);
  }
  function maintRatio(r, price) {
    var liab = marginDebt(r, price);
    if (!(liab > 0.005)) return Infinity;
    return (r.cash + (r.shares || 0) * price) / liab;
  }
  function marginAvail(r, price) {
    return Math.max(0, r.cash + (r.shares || 0) * price - marginDebt(r, price));
  }

  // 当前价下还能增加的总敞口（融资买入或融券卖出共用）
  // 约束：持仓市值 + 融券市值 <= 净资产 / 保证金比例
  function marginCapacity(r, price) {
    if (!r || !r.margin || r.sym.cat === '港股通' || !(price > 0)) return 0;
    var equity = r.cash + (r.shares || 0) * price - marginDebt(r, price);
    var exposure = ((r.shares || 0) + (r.shortShares || 0)) * price;
    return Math.max(0, equity / marginCfg(r).ratio - exposure);
  }

  // 当前价下融资买入/融券卖出最多可下单的股数
  function marginMaxQty(r, price) {
    if (!r || !r.margin || r.sym.cat === '港股通' || !(price > 0)) return 0;
    var rule = lotRule(r.sym);
    var q = Math.floor(marginCapacity(r, price) / price / rule.step) * rule.step;
    return q >= rule.min ? q : 0;
  }
  // 按自然日计息：相邻两根 K 线之间的实际天数（周末/节假日同样计息）
  function nightDays(r) {
    var prev = r.cur > 0 ? r.sym.bars[r.cur - 1] : null;
    var cur = r.sym.bars[r.cur];
    if (!prev || !cur || !prev.d || !cur.d) return 1;
    var t1 = Date.parse(prev.d + 'T00:00:00Z'), t2 = Date.parse(cur.d + 'T00:00:00Z');
    if (!isFinite(t1) || !isFinite(t2) || t2 <= t1) return 1;
    var n = Math.round((t2 - t1) / 86400000);
    return Math.min(Math.max(n, 1), 10); // 长假最多按 10 天封顶，避免数据缺口放大误差
  }
  function accrueMargin(r) {
    if (!r || !r.margin) return 0;
    var cfg = marginCfg(r);
    var px = r.sym.bars[r.cur].c;
    var days = nightDays(r);
    var add = 0;
    if (r.finDebt > 0.005) {
      var i1 = r.finDebt * cfg.finRate / 360 * days;
      r.finInterest = (r.finInterest || 0) + i1;
      add += i1;
    }
    if (r.shortShares > 0) {
      var i2 = r.shortShares * px * cfg.shortRate / 360 * days;
      r.shortInterest = (r.shortInterest || 0) + i2;
      add += i2;
    }
    if (add) r.totalInterest = (r.totalInterest || 0) + add;
    return add;
  }

  function finBuy(r, price, frac, opts) {
    opts = opts || {};
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    if (!r.margin) return { ok: false, error: '本局未开启融资融券' };
    if (r.sym.cat === '港股通') return { ok: false, error: '港股通不支持融资融券' };
    var bar = r.sym.bars[r.cur];
    var prev = r.cur > 0 ? r.sym.bars[r.cur - 1].c : bar.o;
    var lim = limitsOf(prev, r.sym.cat, r.sym);
    if (price >= lim.up - 0.001) return { ok: false, error: '涨停封板，买不进去' };
    var rule = lotRule(r.sym);
    var maxQty = marginMaxQty(r, price);
    if (!(maxQty >= rule.min)) return { ok: false, error: '保证金不足，无法融资买入' };
    var qty = opts.qty > 0
      ? Math.floor(opts.qty / rule.step) * rule.step
      : Math.floor(maxQty * frac / rule.step) * rule.step;
    if (!isFinite(qty) || qty > maxQty) qty = maxQty;
    if (qty < rule.min) return { ok: false, error: '可用保证金不足，至少需买入 ' + rule.min + ' 股' };
    var cost = qty * price;
    var fee = feeOf(cost, r.sym);
    // 先用自己的现金，不足部分才计入融资负债，因此 100% 就是满仓满融
    var payCash = Math.min(r.cash, cost + fee);
    var borrow = cost + fee - payCash;
    var prevCost = r.avgCost * r.shares;
    var wasFlat = r.shares <= 0;
    r.cash -= payCash;
    r.shares += qty;
    r.avgCost = (prevCost + cost + fee) / r.shares;
    r.finDebt = (r.finDebt || 0) + borrow;
    r.finShares = (r.finShares || 0) + qty;
    if (r.entryIdx == null) r.entryIdx = r.cur;
    if (wasFlat) r.entryTag = opts.tag || '';
    r.dayBought = { i: r.cur, qty: (r.dayBought && r.dayBought.i === r.cur ? r.dayBought.qty : 0) + qty };
    r.orders.push({
      i: r.cur, side: 'B', price: price, qty: qty, fee: fee,
      tag: opts.tag || '', src: opts.src || '手动', kind: '融资买入'
    });
    return { ok: true, side: 'B', qty: qty, fee: fee, price: price, kind: 'F' };
  }

  function repaySell(r, price, frac, opts) {
    opts = opts || {};
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    if (!r.margin) return { ok: false, error: '本局未开启融资融券' };
    if (r.sym.cat === '港股通') return { ok: false, error: '港股通不支持融资融券' };
    if (r.shares <= 0) return { ok: false, error: '当前空仓，没有可卖出的份额' };
    var rule = lotRule(r.sym);
    var locked = (r.dayBought && r.dayBought.i === r.cur) ? r.dayBought.qty : 0;
    var sellable = r.shares - locked;
    if (sellable <= 0) return { ok: false, error: 'T+1：当日买入的份额需下一交易日才能卖出' };
    var q = opts.qty > 0
      ? Math.floor(opts.qty / rule.step) * rule.step
      : Math.floor((sellable * frac) / rule.step) * rule.step;
    if (q < rule.min) q = sellable;
    q = Math.max(0, Math.min(q, sellable));
    if (q <= 0) return { ok: false, error: '暂无持仓' };
    var proceeds = q * price;
    var sfee = sellFeeOf(proceeds, r.sym);
    var pnl = (price - r.avgCost) * q - sfee;
    r.cash += proceeds - sfee;
    r.shares -= q;
    if (r.finShares) r.finShares = Math.max(0, r.finShares - q);
    // 卖券还款：先息后本
    if (r.finDebt > 0 || r.finInterest > 0) {
      var pay = Math.min(r.cash, (r.finDebt || 0) + (r.finInterest || 0));
      var ip = Math.min(r.finInterest || 0, pay);
      r.finInterest = (r.finInterest || 0) - ip;
      pay -= ip;
      r.finDebt = (r.finDebt || 0) - pay;
      r.cash -= (ip + pay);
      if (r.finDebt < 0.005) r.finDebt = 0;
      if (r.finInterest < 0.005) r.finInterest = 0;
    }
    r.closed.push({
      i: r.cur, pnl: pnl, ret: r.avgCost ? price / r.avgCost - 1 : 0,
      cost: r.avgCost || 0, price: price,
      hold: r.cur - (r.entryIdx == null ? r.cur : r.entryIdx),
      tag: r.entryTag || '', src: opts.src || '手动'
    });
    r.orders.push({
      i: r.cur, side: 'S', price: price, qty: q, fee: sfee, pnl: pnl,
      src: opts.src || '手动', kind: '卖券还款'
    });
    if (r.shares <= 0) { r.shares = 0; r.avgCost = 0; r.entryIdx = null; r.entryTag = ''; r.finShares = 0; }
    return { ok: true, side: 'S', qty: q, fee: sfee, price: price, kind: 'R' };
  }

  function shortSell(r, price, frac, opts) {
    opts = opts || {};
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    if (!r.margin) return { ok: false, error: '本局未开启融资融券' };
    if (r.sym.cat === '港股通') return { ok: false, error: '港股通不支持融资融券' };
    var bar = r.sym.bars[r.cur];
    var prev = r.cur > 0 ? r.sym.bars[r.cur - 1].c : bar.o;
    var lim = limitsOf(prev, r.sym.cat, r.sym);
    if (price <= lim.dn + 0.001) return { ok: false, error: '跌停封板，卖不出去' };
    var rule = lotRule(r.sym);
    var maxQty = marginMaxQty(r, price);
    if (!(maxQty >= rule.min)) return { ok: false, error: '保证金不足，无法融券卖出' };
    var qty = opts.qty > 0
      ? Math.floor(opts.qty / rule.step) * rule.step
      : Math.floor(maxQty * frac / rule.step) * rule.step;
    if (!isFinite(qty) || qty > maxQty) qty = maxQty;
    if (qty < rule.min) return { ok: false, error: '可用保证金不足，至少需融券卖出 ' + rule.min + ' 股' };
    var proceeds = qty * price;
    var sfee = sellFeeOf(proceeds, r.sym);
    r.cash += proceeds - sfee;
    var before = r.shortShares || 0;
    r.shortAvg = before > 0 ? ((r.shortAvg || 0) * before + price * qty) / (before + qty) : price;
    r.shortShares = before + qty;
    if (r.shortEntryIdx == null) r.shortEntryIdx = r.cur;
    if (!r.shortTag) r.shortTag = opts.tag || '';
    r.orders.push({
      i: r.cur, side: 'S', price: price, qty: qty, fee: sfee,
      tag: opts.tag || '', src: opts.src || '手动', kind: '融券卖出'
    });
    return { ok: true, side: 'S', qty: qty, fee: sfee, price: price, kind: 'S' };
  }

  function coverShort(r, price, frac, opts) {
    opts = opts || {};
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    if (!r.margin) return { ok: false, error: '本局未开启融资融券' };
    if (!(r.shortShares > 0)) return { ok: false, error: '当前没有融券持仓' };
    var rule = lotRule(r.sym);
    var qty = opts.qty > 0
      ? Math.floor(opts.qty / rule.step) * rule.step
      : Math.floor((r.shortShares * frac) / rule.step) * rule.step;
    if (qty < rule.min) qty = r.shortShares;
    qty = Math.min(qty, r.shortShares);
    if (qty <= 0) return { ok: false, error: '暂无可还券数量' };
    var cost = qty * price;
    var fee = feeOf(cost, r.sym);
    if (cost + fee > r.cash + 0.005) return { ok: false, error: '现金不足，无法买券还券' };
    r.cash -= cost + fee;
    var before = r.shortShares;
    var ip = before > 0 ? (r.shortInterest || 0) * qty / before : 0;
    var pnl = ((r.shortAvg || 0) - price) * qty - fee - ip;
    r.shortInterest = Math.max(0, (r.shortInterest || 0) - ip);
    r.shortShares = before - qty;
    r.closed.push({
      i: r.cur, pnl: pnl,
      ret: r.shortAvg ? (r.shortAvg - price) / r.shortAvg : 0,
      cost: r.shortAvg || 0, price: price,
      hold: r.cur - (r.shortEntryIdx == null ? r.cur : r.shortEntryIdx),
      tag: r.shortTag || '', src: opts.src || '手动'
    });
    r.orders.push({
      i: r.cur, side: 'B', price: price, qty: qty, fee: fee, pnl: pnl,
      src: opts.src || '手动', kind: '买券还券'
    });
    if (r.shortShares <= 0) { r.shortShares = 0; r.shortAvg = 0; r.shortEntryIdx = null; r.shortTag = ''; r.shortInterest = 0; }
    return { ok: true, side: 'B', qty: qty, fee: fee, price: price, kind: 'C' };
  }

  // 维持担保比例低于 130% 时强制平仓（先卖券还款，再买券还券）
  function checkMarginCall(r) {
    if (!r || !r.margin || r.finished) return null;
    // 已无持仓（可能只剩强平后的欠款）时不再重复触发平仓
    if ((r.shares || 0) <= 0 && (r.shortShares || 0) <= 0) {
      r.maint = Infinity;
      return null;
    }
    var px = r.sym.bars[r.cur].c;
    var liab = marginDebt(r, px);
    if (!(liab > 0.005)) {
      r.maint = Infinity;
      return null;
    }
    var ratio = (r.cash + (r.shares || 0) * px) / liab;
    r.maint = ratio;
    if (r.minMaint == null || ratio < r.minMaint) r.minMaint = ratio;
    if (ratio >= marginCfg(r).close) return null;
    var detail = { ratio: ratio, sold: 0, covered: 0 };
    // 强平同样受 T+1 限制：当日买入的份额不能卖出，只能先处置此前持仓
    var locked = (r.sym.cat !== '港股通' && r.dayBought && r.dayBought.i === r.cur) ? (r.dayBought.qty || 0) : 0;
    var sellable = Math.max(0, (r.shares || 0) - locked);
    if (sellable > 0) {
      var qty = sellable;
      var proceeds = qty * px;
      var sfee = sellFeeOf(proceeds, r.sym);
      var pnl = (px - r.avgCost) * qty - sfee;
      r.cash += proceeds - sfee;
      r.closed.push({
        i: r.cur, pnl: pnl, ret: r.avgCost ? px / r.avgCost - 1 : 0,
        cost: r.avgCost || 0, price: px,
        hold: r.cur - (r.entryIdx == null ? r.cur : r.entryIdx),
        tag: r.entryTag || '', src: '强制平仓'
      });
      r.orders.push({
        i: r.cur, side: 'S', price: px, qty: qty, fee: sfee, pnl: pnl,
        src: '强制平仓', kind: '强制平仓'
      });
      detail.sold = qty;
      r.shares -= qty;
      if (r.finShares) r.finShares = Math.max(0, r.finShares - qty);
      if (r.shares <= 0) {
        r.shares = 0; r.avgCost = 0; r.entryIdx = null; r.entryTag = ''; r.finShares = 0;
      }
    }
    if (r.finDebt > 0 || r.finInterest > 0) {
      var pay = Math.min(r.cash, (r.finDebt || 0) + (r.finInterest || 0));
      var ip = Math.min(r.finInterest || 0, pay);
      r.finInterest = (r.finInterest || 0) - ip;
      pay -= ip;
      r.finDebt = (r.finDebt || 0) - pay;
      r.cash -= (ip + pay);
      if (r.finDebt < 0.005) r.finDebt = 0;
      if (r.finInterest < 0.005) r.finInterest = 0;
    }
    if (r.shortShares > 0) {
      var sq = r.shortShares;
      var cost = sq * px;
      var cfee = feeOf(cost, r.sym);
      var sp = ((r.shortAvg || 0) - px) * sq - cfee - (r.shortInterest || 0);
      r.cash -= cost + cfee;
      r.closed.push({
        i: r.cur, pnl: sp,
        ret: r.shortAvg ? (r.shortAvg - px) / r.shortAvg : 0,
        cost: r.shortAvg || 0, price: px,
        hold: r.cur - (r.shortEntryIdx == null ? r.cur : r.shortEntryIdx),
        tag: r.shortTag || '', src: '强制平仓'
      });
      r.orders.push({
        i: r.cur, side: 'B', price: px, qty: sq, fee: cfee, pnl: sp,
        src: '强制平仓', kind: '强制平仓'
      });
      detail.covered = sq;
      r.shortShares = 0; r.shortAvg = 0; r.shortEntryIdx = null; r.shortTag = ''; r.shortInterest = 0;
    }
    r.marginCall = (r.marginCall || 0) + 1;
    r.forcedAt = r.sym.bars[r.cur].d;
    return detail;
  }


  /* ---------------- 当日分时（按日K确定性还原） ---------------- */
  var SIM_N = 240;

  function hashSeed(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function r3(v) { return Math.round(v * 1000) / 1000; }
  function pxFmt(p) { return p >= 10 ? p.toFixed(2) : p.toFixed(3); }

  // 用日K的 开/高/低/收/量 还原 240 个分钟点（确定性：代码+日期做种子）
  function simPath(sym, i) {
    if (!sym || !sym.bars || i < 0 || i >= sym.bars.length) return null;
    var cache = sym._sim || (sym._sim = []);
    if (cache[i]) return cache[i];
    var bar = sym.bars[i];
    var o = bar.o, c = bar.c, h = bar.h, l = bar.l;
    var prev = i > 0 ? sym.bars[i - 1].c : o;
    var rnd = mulberry32(hashSeed(sym.code + '|' + bar.d));
    var pts = new Array(SIM_N), avg = new Array(SIM_N), w = new Array(SIM_N);
    var k, x;

    // 阳线先探低后冲高，阴线反之；在随机分钟精确触到 low / high
    var bull = c >= o;
    var t1 = 10 + Math.floor(rnd() * 100);
    var t2 = t1 + 20 + Math.floor(rnd() * 90);
    if (t2 > SIM_N - 6) t2 = SIM_N - 6;
    if (t1 >= t2 - 4) t1 = Math.max(4, t2 - 6);
    var anchors = [
      { i: 0, p: o },
      { i: t1, p: bull ? l : h },
      { i: t2, p: bull ? h : l },
      { i: SIM_N - 1, p: c }
    ];
    var amp = (h - l) * 0.06;
    var ai = 0;
    for (k = 0; k < SIM_N; k++) {
      while (ai < anchors.length - 2 && k > anchors[ai + 1].i) ai++;
      var A = anchors[ai], B = anchors[ai + 1];
      var span = Math.max(1, B.i - A.i);
      var t = Math.max(0, Math.min(1, (k - A.i) / span));
      var p = A.p + (B.p - A.p) * t;
      p += (rnd() * 2 - 1) * amp * Math.sin(Math.PI * t);
      if (k === 0) p = o;
      else if (k === t1) p = bull ? l : h;
      else if (k === t2) p = bull ? h : l;
      else if (k === SIM_N - 1) p = c;
      pts[k] = { p: r3(Math.max(l, Math.min(h, p))), v: 0 };
    }

    // 成交量 U 型分布：开盘、尾盘更活跃
    var wsum = 0;
    for (k = 0; k < SIM_N; k++) {
      x = k / (SIM_N - 1);
      w[k] = 0.5 + 2.8 * Math.pow(Math.abs(x - 0.5) * 2, 2) + rnd() * 0.45;
      wsum += w[k];
    }
    var total = bar.v || 0;
    for (k = 0; k < SIM_N; k++) pts[k].v = total * w[k] / wsum;

    // 均价线 = 累计成交额 / 累计成交量
    var pv = 0, vv = 0;
    for (k = 0; k < SIM_N; k++) {
      pv += pts[k].p * pts[k].v;
      vv += pts[k].v;
      avg[k] = vv > 0 ? pv / vv : pts[k].p;
    }

    var out = { pts: pts, avg: avg, prevClose: prev, bar: bar, o: o, h: h, l: l, c: c };
    cache[i] = out;
    return out;
  }

  function minLabel(k) {
    var m = k < 120 ? 570 + k : 780 + (k - 120);
    if (k >= SIM_N - 1) m = 900;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // 画分时图（桌面/手机共用）。返回几何信息，页面可叠加挂单价格线。
  function drawIntraday(ctx, W, H, r, hover) {
    var path = r && simPath(r.sym, r.cur);
    if (!path) return null;
    var pts = path.pts, avg = path.avg, bar = path.bar, prev = path.prevClose;
    var n = pts.length;
    var padL = 12, padR = W < 560 ? 50 : 58, padT = 24, padB = 20;
    var plotW = W - padL - padR;
    if (plotW < 100 || H < 160) return null;
    var gap = 8;
    var bodyH = H - padT - padB;
    var priceH = bodyH * 0.72;
    var volTop = padT + priceH + gap;
    var volH = Math.max(10, bodyH - priceH - gap);

    var lo = Math.min(bar.l, prev), hi = Math.max(bar.h, prev);
    var pd = (hi - lo) * 0.09;
    if (!(pd > 0)) pd = Math.max(hi * 0.01, 0.01);
    lo -= pd; hi += pd;
    var dec = hi < 10 ? 3 : 2;
    var yOf = function (v) { return padT + (hi - v) / (hi - lo) * priceH; };
    var xOf = function (k) { return padL + (k / (n - 1)) * plotW; };
    var up = bar.c >= prev;
    var lineColor = up ? '#f6465d' : '#2ebd85';

    var hoverK = null;
    if (hover && hover.x >= padL && hover.x <= padL + plotW) {
      hoverK = Math.max(0, Math.min(n - 1, Math.round((hover.x - padL) / plotW * (n - 1))));
    }

    ctx.font = (W < 560 ? 9.5 : 10.5) + 'px -apple-system,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'middle';

    // 横向网格 + 右侧价格
    for (var g = 0; g <= 4; g++) {
      var pv2 = lo + (hi - lo) * g / 4;
      var gy = yOf(pv2);
      ctx.strokeStyle = '#161f2d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
      ctx.stroke();
      ctx.fillStyle = '#63718a';
      ctx.textAlign = 'left';
      ctx.fillText(pv2.toFixed(dec), padL + plotW + 7, gy);
    }

    // 时间轴
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [0, 60, 120, 180, n - 1].forEach(function (k) {
      var x = xOf(k);
      ctx.strokeStyle = '#121a26';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + priceH);
      ctx.stroke();
      ctx.fillStyle = '#5a677b';
      ctx.fillText(minLabel(k), Math.max(14, Math.min(padL + plotW - 14, x)), H - padB + 5);
    });

    // 昨收线
    if (prev > 0) {
      var yp = yOf(prev);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(140,155,175,.55)';
      ctx.beginPath();
      ctx.moveTo(padL, yp);
      ctx.lineTo(padL + plotW, yp);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(150,165,185,.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('昨收 ' + prev.toFixed(dec), padL + 2, yp - 7);
    }

    // 价格线 + 渐变面积
    var grad = ctx.createLinearGradient(0, padT, 0, padT + priceH);
    grad.addColorStop(0, up ? 'rgba(246,70,93,.22)' : 'rgba(46,189,133,.22)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(pts[0].p));
    for (var kk = 1; kk < n; kk++) ctx.lineTo(xOf(kk), yOf(pts[kk].p));
    ctx.lineTo(xOf(n - 1), padT + priceH);
    ctx.lineTo(xOf(0), padT + priceH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(pts[0].p));
    for (kk = 1; kk < n; kk++) ctx.lineTo(xOf(kk), yOf(pts[kk].p));
    ctx.stroke();

    // 均价线
    if (path.avg) {
      ctx.strokeStyle = 'rgba(245,197,66,.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(avg[0]));
      for (kk = 1; kk < n; kk++) ctx.lineTo(xOf(kk), yOf(avg[kk]));
      ctx.stroke();
    }

    // 成交量
    var maxV = 0;
    for (kk = 0; kk < n; kk++) if (pts[kk].v > maxV) maxV = pts[kk].v;
    if (maxV > 0) {
      ctx.strokeStyle = '#161f2d';
      ctx.beginPath();
      ctx.moveTo(padL, volTop + volH);
      ctx.lineTo(padL + plotW, volTop + volH);
      ctx.stroke();
      var vw = Math.max(1, plotW / n * 0.8);
      for (kk = 0; kk < n; kk++) {
        var hh = Math.max(1, pts[kk].v / maxV * volH * 0.9);
        var p0 = kk ? pts[kk - 1].p : pts[0].p;
        ctx.fillStyle = pts[kk].p >= p0 ? 'rgba(246,70,93,.5)' : 'rgba(46,189,133,.5)';
        ctx.fillRect(xOf(kk) - vw / 2, volTop + volH - hh, vw, hh);
      }
      ctx.fillStyle = '#5a677b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('VOL', padL, volTop + 7);
    }

    // 顶部标注：左侧日期/十字光标信息，右侧模拟声明
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (hoverK == null) {
      ctx.fillStyle = '#8fb3ff';
      ctx.fillText(bar.d + ' · 收盘 ' + bar.c.toFixed(dec), padL, 11);
    } else {
      var chg2 = pts[hoverK].p / prev - 1;
      ctx.fillStyle = chg2 >= 0 ? '#f6465d' : '#2ebd85';
      ctx.fillText(minLabel(hoverK) + '  ' + pts[hoverK].p.toFixed(dec) + '  ' +
        (chg2 >= 0 ? '+' : '') + (chg2 * 100).toFixed(2) + '%  均价 ' + avg[hoverK].toFixed(dec), padL, 11);
    }
    ctx.fillStyle = '#6d7a8e';
    ctx.textAlign = 'right';
    ctx.fillText('模拟分时 · 按日K还原', padL + plotW, 11);

    // 价格类挂单的触发线
    var list = r.pendingList || [];
    for (var q = 0; q < list.length; q++) {
      var od = list[q];
      if (!(od.price > 0)) continue;
      if (od.type !== 'BUY_LIMIT' && od.type !== 'SELL_LIMIT') continue;
      var oy = yOf(od.price);
      if (oy < padT - 2 || oy > padT + priceH + 2) continue;
      var isBuy = od.type === 'BUY_LIMIT';
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = isBuy ? 'rgba(246,70,93,.55)' : 'rgba(46,189,133,.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, oy);
      ctx.lineTo(padL + plotW, oy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isBuy ? 'rgba(255,150,166,.92)' : 'rgba(126,235,183,.92)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(strategyLabel(od.type) + ' ' + pxFmt(od.price), padL + 2, oy + 10);
    }

    // 十字光标
    if (hoverK != null) {
      var hx = xOf(hoverK);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#3d4b5f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, H - padB);
      ctx.stroke();
      ctx.setLineDash([]);
      var hp = yOf(pts[hoverK].p);
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      ctx.arc(hx, hp, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c2635';
      ctx.fillRect(padL + plotW + 2, hp - 9, padR - 4, 18);
      ctx.fillStyle = '#d4dfef';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pts[hoverK].p.toFixed(dec), padL + plotW + padR / 2, hp);
    }

    return {
      xOf: xOf, yOf: yOf, padL: padL, plotW: plotW, padT: padT, priceH: priceH,
      n: n, pts: pts, avg: avg, prev: prev, bar: bar, dec: dec
    };
  }

  /* ---------------- 隔夜挂单（市价 / 限价，次日生效） ---------------- */
  var STRATEGIES = [
    { k: 'MKT_BUY', label: '市价买入', side: 'B', need: 'none' },
    { k: 'MKT_SELL', label: '市价卖出', side: 'S', need: 'none' },
    { k: 'BUY_LIMIT', label: '限价买入', side: 'B', need: 'price' },
    { k: 'SELL_LIMIT', label: '限价卖出', side: 'S', need: 'price' }
  ];

  var STRAT_LABEL = {};
  for (var si = 0; si < STRATEGIES.length; si++) STRAT_LABEL[STRATEGIES[si].k] = STRATEGIES[si].label;

  function strategyLabel(t) { return STRAT_LABEL[t] || '挂单'; }

  var NEED_PRICE = { BUY_LIMIT: 1, SELL_LIMIT: 1 };

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function ensurePending(r) {
    if (!r) return [];
    if (!Array.isArray(r.pendingList)) r.pendingList = [];
    // 旧存档只有单笔 pending，迁移进列表
    if (r.pending && r.pending.type && STRAT_LABEL[r.pending.type]) {
      var p = r.pending;
      r.pendingList.push({
        id: newId(), type: p.type, price: p.price || 0,
        frac: p.frac || 0.5, qty: 0, tag: p.tag || '',
        i: p.i == null ? r.cur : p.i
      });
    }
    r.pending = null;
    // 旧策略挂单不再支持，只保留市价/限价买卖
    r.pendingList = r.pendingList.filter(function (p) {
      return p && STRAT_LABEL[p.type];
    }).map(function (p) {
      if (!p.id) p.id = newId();
      return p;
    });
    return r.pendingList;
  }

  // type 见 STRATEGIES；qty 为股数（0 表示按 frac 仓位）
  // mode：'N' 普通 / 'F' 融资 / 'S' 融券，未开启两融时自动回落到普通
  function placePending(r, type, price, frac, tag, pct, qty, mode) {
    if (!r || r.finished) return { ok: false, error: '本局已结束' };
    if (!STRAT_LABEL[type]) return { ok: false, error: '未知的挂单类型' };
    var needP = !!NEED_PRICE[type];
    if (needP && !(price > 0)) return { ok: false, error: '请输入有效限价' };
    var rule = lotRule(r.sym);
    var q = Number(qty);
    if (!isFinite(q) || q < 0) q = 0;
    if (q > 0 && q < rule.min) return { ok: false, error: '股数至少 ' + rule.min + ' 股' };
    q = Math.floor(q / rule.step) * rule.step;
    mode = (mode === 'F' || mode === 'S') ? mode : 'N';
    if (mode !== 'N' && (!r.margin || r.sym.cat === '港股通')) mode = 'N';
    // 两融挂单同样受当前额度限制，避免挂出永远无法成交的天量单
    if (mode !== 'N' && q > 0) {
      var qmax = marginMaxQty(r, needP ? Number(price) : r.sym.bars[r.cur].c);
      if (qmax < rule.min) return { ok: false, error: '两融额度不足，无法挂单' };
      if (q > qmax) q = qmax;
    }
    var o = {
      id: newId(), type: type,
      price: needP ? Number(price) : 0,
      frac: frac || 0.5, qty: q, tag: tag || '', i: r.cur, mode: mode
    };
    ensurePending(r).push(o);
    return { ok: true, order: o };
  }

  function pendingLabel(p) {
    var base = strategyLabel(p && p.type);
    if (p && p.mode === 'F') return '融资' + base;
    if (p && p.mode === 'S') return '融券' + base;
    return base;
  }

  // 按挂单的交易方式分派：普通买卖 / 融资买入还款 / 融券卖出买券
  function pendingExec(r, side, price, frac, opts) {
    var m = (opts && opts.mode) || 'N';
    if (m === 'F' && r.margin) {
      return side === 'B' ? finBuy(r, price, frac, opts) : repaySell(r, price, frac, opts);
    }
    if (m === 'S' && r.margin) {
      return side === 'B' ? coverShort(r, price, frac, opts) : shortSell(r, price, frac, opts);
    }
    return executeTrade(r, side, price, frac, opts);
  }

  // 传 id 撤单笔，不传则撤销全部
  function cancelPending(r, id) {
    if (!r) return { ok: false, n: 0 };
    var list = ensurePending(r);
    if (id == null) {
      var n = list.length;
      r.pendingList = [];
      return { ok: true, n: n };
    }
    var before = list.length;
    r.pendingList = list.filter(function (p) { return p.id !== id; });
    return { ok: true, n: before - r.pendingList.length };
  }

  // 揭晓新的一根 K 线后调用：市价单按开盘价成交，限价单按模拟分时撮合，当日未触发失效
  function triggerPendingList(r, frac) {
    var out = { fills: [], failed: [], expired: [] };
    if (!r || r.finished) return out;
    var list = ensurePending(r);
    if (!list.length) return out;
    var bar = r.sym.bars[r.cur];

    function fail(p, msg) { out.failed.push({ type: p.type, msg: msg }); }
    function fill(p, side, res) {
      out.fills.push({
        type: p.type, side: side, qty: res.qty, price: res.price,
        fee: res.fee, label: pendingLabel(p), mode: p.mode || 'N'
      });
    }

    // 市价单：下一交易日开盘价成交
    for (var m = 0; m < list.length; m++) {
      var mp = list[m];
      if (mp.type !== 'MKT_BUY' && mp.type !== 'MKT_SELL') continue;
      var ms = mp.type === 'MKT_BUY' ? 'B' : 'S';
      var mr = pendingExec(r, ms, bar.o, mp.frac || frac, { tag: mp.tag, src: '市价', qty: mp.qty || 0, mode: mp.mode });
      if (!mr.ok) fail(mp, mr.error);
      else fill(mp, ms, mr);
      mp._done = true;
    }

    // 限价单：按当日模拟分时触价成交
    var limits = list.filter(function (p) { return !p._done && NEED_PRICE[p.type]; });
    if (limits.length) {
      var path = simPath(r.sym, r.cur);
      var pts = path.pts, n = pts.length;
      var jobs = limits.map(function (p) { return { p: p, done: false }; });
      for (var k = 0; k < n; k++) {
        var px = pts[k].p;
        for (var s = 0; s < jobs.length; s++) {
          var j = jobs[s];
          if (j.done) continue;
          var p = j.p;
          var hit = (p.type === 'BUY_LIMIT' && px <= p.price) || (p.type === 'SELL_LIMIT' && px >= p.price);
          if (!hit) continue;
          var side = p.type === 'BUY_LIMIT' ? 'B' : 'S';
          var res = pendingExec(r, side, px, p.frac || frac, { tag: p.tag, src: '限价', qty: p.qty || 0, mode: p.mode });
          if (!res.ok) { fail(p, res.error); j.done = true; continue; }
          fill(p, side, res);
          j.done = true;
        }
      }
      for (var s2 = 0; s2 < jobs.length; s2++) {
        if (!jobs[s2].done) out.expired.push({ type: jobs[s2].p.type });
      }
    }

    for (var c = 0; c < list.length; c++) delete list[c]._done;
    r.pendingList = [];
    return out;
  }

  /* ---------------- 周期聚合 ---------------- */
  // 以周一为一周起点，把日K合并成周K；map 记录每根日K所属的周下标
  function weekKey(ds) {
    var y = +ds.slice(0, 4), m = +ds.slice(5, 7) - 1, d = +ds.slice(8, 10);
    var t = new Date(Date.UTC(y, m, d));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.getUTCFullYear() + '-' + (t.getUTCMonth() + 1) + '-' + t.getUTCDate();
  }

  function toWeekly(bars) {
    var out = [], map = new Array(bars.length), cur = null, key = '';
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var k = weekKey(b.d);
      if (k !== key) {
        cur = { d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 };
        out.push(cur);
        key = k;
      } else {
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.c = b.c;
        cur.v += (b.v || 0);
        cur.d = b.d;
      }
      map[i] = out.length - 1;
    }
    return { bars: out, map: map };
  }

  /* ---------------- 存档 ---------------- */
  var ROUND_KEY = 'klineCampRound';

  // 控制训练记录体积：资金曲线最多保留约 80 个点
  function compactCurve(curve) {
    if (!curve || !curve.length) return [];
    if (curve.length <= 80) return curve;
    var step = Math.ceil(curve.length / 80);
    var out = [];
    for (var i = 0; i < curve.length; i += step) out.push(curve[i]);
    if (out[out.length - 1] !== curve[curve.length - 1]) out.push(curve[curve.length - 1]);
    return out;
  }

  function saveRound(r) {
    if (!r || r.finished) return;
    ensurePending(r);
    try {
      localStorage.setItem(ROUND_KEY, JSON.stringify({
        v: 6,
        code: r.sym.code,
        start: r.start, len: r.len, end: r.end, cur: r.cur,
        sd: r.sym.bars[r.start].d, cd: r.sym.bars[r.cur].d,
        initial: r.initial, cash: r.cash, shares: r.shares,
        avgCost: r.avgCost, entryIdx: r.entryIdx, entryTag: r.entryTag || '',
        dayBought: r.dayBought || null,
        pendingList: r.pendingList || [],
        orders: r.orders, closed: r.closed, curve: r.curve,
        peak: r.peak, mdd: r.mdd,
        margin: !!r.margin,
        finDebt: r.finDebt || 0, finInterest: r.finInterest || 0,
        finShares: r.finShares || 0,
        shortShares: r.shortShares || 0, shortAvg: r.shortAvg || 0,
        shortInterest: r.shortInterest || 0,
        shortEntryIdx: r.shortEntryIdx == null ? null : r.shortEntryIdx,
        shortTag: r.shortTag || '',
        maint: isFinite(r.maint) ? r.maint : null,
        minMaint: isFinite(r.minMaint) ? r.minMaint : null,
        marginCall: r.marginCall || 0,
        forcedAt: r.forcedAt || '',
        totalInterest: r.totalInterest || 0,
        marginCfg: r.marginCfg || null
      }));
    } catch (e) { /* 隐私模式写入失败可忽略 */ }
  }

  function clearRound() {
    try { localStorage.removeItem(ROUND_KEY); } catch (e) { }
  }

  async function loadRound(raw, warmup) {
    var o;
    try { o = JSON.parse(localStorage.getItem(ROUND_KEY) || 'null'); } catch (e) { return null; }
    if (!o || (o.v !== 5 && o.v !== 6) || !o.code) return null;
    if (!(o.len > 0)) return null;
    var sym = null;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].code === o.code) { sym = raw[i]; break; }
    }
    if (!sym) return null;
    try { await ensureBars(sym); } catch (e) { return null; }

    // v5 存档按日期定位，数据起点/长度变化后仍能恢复
    var oldStart = o.start, oldCur = o.cur;
    if (o.sd && o.cd) {
      var si = -1, ci = -1;
      for (var j = 0; j < sym.bars.length; j++) {
        if (sym.bars[j].d === o.sd) si = j;
        if (sym.bars[j].d === o.cd) ci = j;
      }
      if (si < 0 || ci < 0) return null;
      o.start = si;
      o.cur = ci;
      o.end = si + o.len - 1;
    }
    if (o.cur < o.start || o.end >= sym.bars.length || sym.bars.length < warmup + o.len) return null;
    var delta = o.start - oldStart;
    if (delta) {
      o.orders = (o.orders || []).map(function (x) { x.i += delta; return x; });
      o.closed = (o.closed || []).map(function (x) { x.i += delta; return x; });
      if (o.curve) o.curve.forEach(function (x) { x.i += delta; });
      if (o.entryIdx != null) o.entryIdx += delta;
      if (o.shortEntryIdx != null) o.shortEntryIdx += delta;
      if (o.dayBought && o.dayBought.i != null) o.dayBought.i += delta;
      if (o.pendingList) o.pendingList.forEach(function (x) { if (x.i != null) x.i += delta; });
    }

    // 挂单：v5 为列表
    var pl = [];
    if (Array.isArray(o.pendingList)) pl = o.pendingList.filter(function (p) { return p && STRAT_LABEL[p.type]; });
    for (var pi = 0; pi < pl.length; pi++) {
      if (!pl[pi].id) pl[pi].id = newId();
      if (!(pl[pi].frac > 0)) pl[pi].frac = 0.5;
      if (!(pl[pi].qty >= 0)) pl[pi].qty = 0;
      if (pl[pi].mode !== 'F' && pl[pi].mode !== 'S') pl[pi].mode = 'N';
    }

    return {
      sym: sym,
      start: o.start, len: o.len, end: o.end, cur: o.cur,
      initial: o.initial, cash: o.cash, shares: o.shares,
      avgCost: o.avgCost, entryIdx: o.entryIdx == null ? null : o.entryIdx,
      entryTag: o.entryTag || '',
      dayBought: o.dayBought || null,
      pendingList: pl, pending: null,
      orders: o.orders || [], closed: o.closed || [],
      curve: o.curve && o.curve.length ? o.curve : [{ i: o.start, eq: o.initial }],
      peak: o.peak || o.initial, mdd: o.mdd || 0,
      margin: !!o.margin,
      finDebt: o.finDebt || 0, finInterest: o.finInterest || 0,
      finShares: o.finShares || 0,
      shortShares: o.shortShares || 0, shortAvg: o.shortAvg || 0,
      shortInterest: o.shortInterest || 0,
      shortEntryIdx: o.shortEntryIdx == null ? null : o.shortEntryIdx,
      shortTag: o.shortTag || '',
      maint: typeof o.maint === 'number' ? o.maint : Infinity,
      minMaint: typeof o.minMaint === 'number' ? o.minMaint : null,
      marginCall: o.marginCall || 0,
      forcedAt: o.forcedAt || '',
      totalInterest: o.totalInterest || 0,
      marginCfg: o.marginCfg || null,
      finished: false
    };
  }

  /* ---------------- 沪深300 基准 ---------------- */
  var INDEX_CODE = '000300';

  function findIndex(raw) {
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].code === INDEX_CODE) return raw[i];
    }
    return null;
  }

  function dateMap(sym) {
    var m = {};
    if (!sym) return m;
    for (var i = 0; i < sym.bars.length; i++) m[sym.bars[i].d] = sym.bars[i].c;
    return m;
  }

  function indexReturn(raw, d0, d1) {
    var sym = findIndex(raw);
    if (!sym) return null;
    var m = dateMap(sym);
    var c0 = m[d0], c1 = m[d1];
    return (c0 && c1) ? c1 / c0 - 1 : null;
  }

  // 返回与 dates 对齐、以 100 为基点的指数序列（缺数据处为 null）
  function indexSeries(raw, dates) {
    var sym = findIndex(raw);
    if (!sym) return null;
    var m = dateMap(sym);
    var base = m[dates[0]];
    if (!base) return null;
    return dates.map(function (d) {
      var c = m[d];
      return c ? c * 100 / base : null;
    });
  }

  /* ---------------- 数据解码 ---------------- */
  var DAY_MS = 86400000;
  var DATE_CACHE = (function () {
    var base = Date.UTC(2019, 0, 1);
    var out = [];
    for (var i = 0; i < 4096; i++) {
      var d = new Date(base + i * DAY_MS);
      out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'));
    }
    return out;
  })();

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function inflateBytes(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器版本过低，无法解压行情数据');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  var PACK_STEP = 22;
  var PACKS = {};
  var PACK_LOADING = {};
  var PACK_ORDER = [];
  var PACK_LIMIT = 8; // 只保留最近使用的几个分片，避免手机内存累积

  function touchPack(p) {
    var i = PACK_ORDER.indexOf(p);
    if (i >= 0) PACK_ORDER.splice(i, 1);
    PACK_ORDER.push(p);
    while (PACK_ORDER.length > PACK_LIMIT) {
      var old = PACK_ORDER.shift();
      if (old !== p) delete PACKS[old];
    }
  }

  function decodeEntry(bytes, e) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var bars = new Array(e.k);
    var pos = e.o * PACK_STEP;
    for (var i = 0; i < e.k; i++, pos += PACK_STEP) {
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

  function scriptLoad(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { if (s.parentNode) s.parentNode.removeChild(s); resolve(); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  // 按分片加载行情，分片内标的 K 线仍按需解码
  async function loadPack(p) {
    if (PACKS[p]) { touchPack(p); return PACKS[p]; }
    if (!PACK_LOADING[p]) {
      PACK_LOADING[p] = (async function () {
        await scriptLoad('../data/kline-pack-' + p + '.js');
        var raw = global.__KP && global.__KP[p];
        if (!raw) throw new Error('缺少行情分片 ' + p);
        var bytes = await inflateBytes(base64ToBytes(raw.pack));
        var map = {};
        for (var i = 0; i < raw.index.length; i++) map[raw.index[i].c] = raw.index[i];
        PACKS[p] = { bytes: bytes, map: map };
        touchPack(p);
        try { delete global.__KP[p]; } catch (e) { }
        return PACKS[p];
      })();
      PACK_LOADING[p].then(function () { delete PACK_LOADING[p]; },
        function () { delete PACK_LOADING[p]; });
    }
    return PACK_LOADING[p];
  }

  async function ensureBars(sym) {
    if (!sym) return null;
    if (sym.bars) return sym.bars;
    var pack = await loadPack(sym.p);
    var e = pack.map[sym.code];
    if (!e) throw new Error('分片缺少 ' + sym.code);
    sym.bars = decodeEntry(pack.bytes, e);
    sym._bars = sym.bars;
    return sym.bars;
  }

  async function loadData() {
    if (global.KLINE_FMT === 3 && global.KLINE_INDEX) {
      return global.KLINE_INDEX.map(function (e) {
        return {
          code: e.c, name: e.n, cat: e.t, sector: e.i || '', ind: null,
          k: e.k, p: e.p, lo: e.lo || 0
        };
      });
    }
    if (global.KLINE_PACK && global.KLINE_INDEX) {
      var bytes = await inflateBytes(base64ToBytes(global.KLINE_PACK));
      var out = [];
      for (var i = 0; i < global.KLINE_INDEX.length; i++) {
        var e = global.KLINE_INDEX[i];
        out.push({ code: e.c, name: e.n, cat: e.t, sector: e.i || '', ind: null,
          k: e.k, p: '', bars: decodeEntry(bytes, e) });
      }
      return out;
    }
    return (global.KLINE_DATA || []).map(function (s) {
      return {
        code: s.code,
        name: s.name,
        cat: s.cat,
        sector: s.ind || '',
        ind: null,
        k: s.bars.length,
        p: '',
        bars: s.bars.map(function (a) {
          return { d: a[0], o: a[1], c: a[2], h: a[3], l: a[4], v: a[5] };
        })
      };
    });
  }

  /* ---------------- 新手教程（高亮引导） ---------------- */
  function tour(steps, opts) {
    opts = opts || {};
    var idx = 0, closed = false, poll = null, wrap, hole, card;
    var esc = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    };
    var css =
      '#kcTour{position:fixed;inset:0;z-index:99999;pointer-events:none}' +
      '#kcTour .hole{position:absolute;border:2px solid #4c8dff;border-radius:12px;box-shadow:0 0 0 9999px rgba(4,8,14,.8);transition:left .22s,top .22s,width .22s,height .22s;pointer-events:none}' +
      '#kcTour .card{position:absolute;pointer-events:auto;background:linear-gradient(180deg,#162031,#0e1622);border:1px solid #2a3a52;border-radius:14px;padding:16px 16px 12px;box-shadow:0 18px 48px rgba(0,0,0,.6);width:336px;max-width:calc(100vw - 28px);box-sizing:border-box}' +
      '#kcTour .tt{font-size:15px;font-weight:600;color:#e8f0fc;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;align-items:baseline}' +
      '#kcTour .tt i{font-style:normal;font-size:11px;color:#6f7f96;font-weight:400;white-space:nowrap}' +
      '#kcTour .tx{font-size:12.5px;line-height:1.8;color:#a9b7cb;white-space:pre-line}' +
      '#kcTour .hint{margin-top:9px;font-size:11.5px;line-height:1.6;color:#f0b429}' +
      '#kcTour .btns{display:flex;align-items:center;gap:8px;margin-top:14px}' +
      '#kcTour .btns .skip{font-size:11.5px;color:#63718a;margin-right:auto;background:none;border:none;cursor:pointer;padding:4px 0}' +
      '#kcTour .btns button{padding:7px 13px;border-radius:8px;font-size:12.5px;border:1px solid #24344a;background:#0f1824;color:#9fb0c6;cursor:pointer;font-family:inherit}' +
      '#kcTour .btns .go{background:linear-gradient(135deg,#4c8dff,#3f6df0);border-color:transparent;color:#fff;font-weight:600}' +
      '#kcTour .btns .go[disabled]{opacity:.5;cursor:default}';
    wrap = document.createElement('div');
    wrap.id = 'kcTour';
    wrap.innerHTML = '<style>' + css + '</style><div class="hole" style="display:none"></div><div class="card"></div>';
    document.body.appendChild(wrap);
    hole = wrap.querySelector('.hole');
    card = wrap.querySelector('.card');

    function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function target(sel) { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } }

    function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

    function place() {
      if (closed) return;
      var st = steps[idx] || {};
      var el = target(st.sel);
      var vw = window.innerWidth, vh = window.innerHeight;
      if (el) {
        var r = el.getBoundingClientRect();
        hole.style.display = 'block';
        hole.style.left = clampNum(r.left - 5, 1, vw - 8) + 'px';
        hole.style.top = clampNum(r.top - 5, 1, vh - 8) + 'px';
        hole.style.width = clampNum(r.width + 10, 8, vw - 4) + 'px';
        hole.style.height = clampNum(r.height + 10, 8, vh - 4) + 'px';
      } else {
        hole.style.display = 'none';
      }
      card.innerHTML =
        '<div class="tt">' + esc(st.title || '') + '<i>' + (idx + 1) + ' / ' + steps.length + '</i></div>' +
        '<div class="tx">' + esc(st.text || '') + '</div>' +
        (st.hint ? '<div class="hint">' + esc(st.hint) + '</div>' : '') +
        '<div class="btns">' +
        '<button class="skip" type="button">跳过教程</button>' +
        (idx > 0 ? '<button class="prev" type="button">上一步</button>' : '') +
        '<button class="go" type="button">' + (idx === steps.length - 1 ? '完成' : '下一步') + '</button>' +
        '</div>';
      var cw = card.offsetWidth, ch = card.offsetHeight;
      var x, y;
      if (el) {
        var r2 = el.getBoundingClientRect();
        x = clampNum(r2.left + r2.width / 2 - cw / 2, 10, vw - cw - 10);
        y = r2.bottom + 14;
        if (y + ch > vh - 10) y = r2.top - ch - 14;
        if (y < 10) y = clampNum(vh - ch - 10, 10, vh - ch - 10);
      } else {
        x = clampNum((vw - cw) / 2, 10, vw - cw - 10);
        y = clampNum((vh - ch) / 2, 10, vh - ch - 10);
      }
      card.style.left = x + 'px';
      card.style.top = y + 'px';
      wrap.querySelector('.skip').onclick = function () { finish(true); };
      var prev = wrap.querySelector('.prev');
      if (prev) prev.onclick = function () { go(idx - 1); };
      wrap.querySelector('.go').onclick = function () { go(idx + 1); };
    }

    function startPoll() {
      stopPoll();
      var st = steps[idx];
      if (!st || !st.done) return;
      poll = setInterval(function () {
        if (closed) return;
        var ok = false;
        try { ok = !!st.done(); } catch (e) { ok = false; }
        if (ok) {
          stopPoll();
          setTimeout(function () { if (!closed && steps[idx] === st) go(idx + 1); }, 520);
        }
      }, 250);
    }

    function enter() {
      var st = steps[idx];
      if (!st) return finish(false);
      if (st.before) { try { st.before(); } catch (e) { } }
      setTimeout(function () {
        if (closed) return;
        var el = target(st.sel);
        if (el && el.scrollIntoView) {
          try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { }
        }
        place();
        startPoll();
      }, 90);
    }

    function go(n) {
      if (closed) return;
      var cur = steps[idx];
      stopPoll();
      if (cur && cur.after) { try { cur.after(); } catch (e) { } }
      if (n >= steps.length) return finish(false);
      idx = Math.max(0, n);
      enter();
    }

    function finish(skipped) {
      if (closed) return;
      closed = true;
      stopPoll();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (opts.onEnd) { try { opts.onEnd(skipped); } catch (e) { } }
    }

    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    enter();
    return { close: function () { finish(true); } };
  }

  /* ---------------- 筹码分布（价格维度成交量分布） ---------------- */
  // bars: K线数组；end: 截止索引（含）；opt.span: 统计窗口根数；opt.levels: 价格档数
  function chipProfile(bars, end, opt) {
    opt = opt || {};
    if (!bars || !bars.length) return null;
    end = Math.max(0, Math.min(Math.round(Number(end) || 0), bars.length - 1));
    var span = Math.max(10, Math.round(Number(opt.span) || 120));
    if (span > end + 1) span = end + 1;
    var levels = Math.max(20, Math.min(Math.round(Number(opt.levels) || 48), 120));
    // 真实流通股本（iFinD）：用于按真实换手率衰减旧筹码；缺省时退回按成交量估算
    var floatShares = Number(opt.floatShares) || 0;
    if (!(floatShares > 0) && opt.code && global.KLINE_SHARES) {
      var sh = global.KLINE_SHARES[opt.code];
      if (sh && sh[1] > 0) floatShares = sh[1];
    }
    var decay = Number(opt.decay) > 0 ? Number(opt.decay) : 1;
    var from = end - span + 1;
    var hi = -Infinity, lo = Infinity, i, k, b;
    for (i = from; i <= end; i++) {
      b = bars[i];
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
      lo = isFinite(lo) ? lo : (bars[end].c || 1);
      hi = lo + Math.max(lo * 0.01, 0.01);
    }
    var pad = (hi - lo) * 0.04;
    hi += pad;
    lo -= pad;
    if (lo < 0) lo = 0;
    var step = (hi - lo) / levels;
    var chips = [];
    for (k = 0; k < levels; k++) chips[k] = 0;
    var sumV = 0;
    for (i = from; i <= end; i++) sumV += bars[i].v;
    var avgV = (sumV / span) || 1;

    // 逐日：旧筹码按换手率衰减，再按当日振幅把成交量分配到价格档
    for (i = from; i <= end; i++) {
      b = bars[i];
      var t;
      if (floatShares > 0) {
        // 真实换手率 = 成交量(手)×100 ÷ 流通A股
        t = b.v * 100 / floatShares * decay;
        if (t < 0.0001) t = 0.0001;
        if (t > 0.6) t = 0.6;
      } else {
        t = b.v / (avgV * 5);
        if (t < 0.05) t = 0.05;
        if (t > 0.5) t = 0.5;
      }
      for (k = 0; k < levels; k++) chips[k] *= (1 - t);
      var kLo = Math.floor((b.l - lo) / step);
      var kHi = Math.floor((b.h - lo) / step);
      if (kLo < 0) kLo = 0;
      if (kHi >= levels) kHi = levels - 1;
      if (kHi < kLo) kHi = kLo;
      var range = b.h - b.l;
      var ws = [], wsum = 0;
      for (k = kLo; k <= kHi; k++) {
        var pc = lo + (k + 0.5) * step;
        var d = range > step ? Math.abs(pc - b.c) / range : 0;
        var w = 1 - 0.8 * d;
        if (w < 0) w = 0;
        ws.push(w);
        wsum += w;
      }
      if (wsum <= 0) {
        var kc = Math.floor((b.c - lo) / step);
        if (kc < 0) kc = 0;
        if (kc >= levels) kc = levels - 1;
        chips[kc] += t;
      } else {
        for (var j = 0; j < ws.length; j++) {
          chips[kLo + j] += t * ws[j] / wsum;
        }
      }
    }

    var total = 0, peak = 0;
    for (k = 0; k < levels; k++) {
      total += chips[k];
      if (chips[k] > peak) peak = chips[k];
    }
    if (!(total > 0)) return null;
    var prices = [], weights = [], avg = 0, profit = 0;
    var close = bars[end].c;
    for (k = 0; k < levels; k++) {
      prices[k] = lo + (k + 0.5) * step;
      weights[k] = chips[k] / total;
      avg += prices[k] * weights[k];
      // 现价落在档内时按比例计入获利盘，避免档宽影响结果
      var lowEdge = prices[k] - step / 2;
      var highEdge = lowEdge + step;
      if (highEdge <= close) profit += weights[k];
      else if (lowEdge < close) profit += weights[k] * (close - lowEdge) / step;
    }
    var acc = 0, p05 = prices[0], p15 = prices[0], p85 = prices[levels - 1], p95 = prices[levels - 1];
    var got05 = false, got15 = false, got85 = false;
    for (k = 0; k < levels; k++) {
      acc += weights[k];
      if (!got05 && acc >= 0.05) { p05 = prices[k]; got05 = true; }
      if (!got15 && acc >= 0.15) { p15 = prices[k]; got15 = true; }
      if (!got85 && acc >= 0.85) { p85 = prices[k]; got85 = true; }
      if (acc >= 0.95) { p95 = prices[k]; break; }
    }
    // 筹码峰：局部密度极大值，用作支撑/阻力参考
    var peaks = [];
    for (k = 1; k < levels - 1; k++) {
      if (weights[k] >= weights[k - 1] && weights[k] > weights[k + 1] && weights[k] > 0.004) {
        peaks.push({ price: prices[k], weight: weights[k] });
      }
    }
    peaks.sort(function (a, b) { return b.weight - a.weight; });
    peaks = peaks.slice(0, 3);
    var support = 0, resistance = 0;
    for (k = 0; k < peaks.length; k++) {
      if (peaks[k].price < close && peaks[k].price > support) support = peaks[k].price;
      if (peaks[k].price > close && (!resistance || peaks[k].price < resistance)) resistance = peaks[k].price;
    }
    if (!support && p05 < close) support = p05;
    if (!resistance && p95 > close) resistance = p95;
    return {
      levels: levels, prices: prices, weights: weights, peak: peak / total,
      lo: lo, hi: hi, step: step, close: close, span: span,
      avgCost: avg, profit: profit, trapped: 1 - profit,
      low90: p05, high90: p95, low70: p15, high70: p85,
      support: support, resistance: resistance, peaks: peaks,
      concentration: (p95 + p05) > 0 ? (p95 - p05) / (p95 + p05) * 100 : 0
    };
  }

  // 在指定竖向条带内绘制筹码柱（yP 为价格→像素函数）
  function drawChips(ctx, prof, box, yP, close, opt) {
    opt = opt || {};
    if (!prof || !box || box.w < 26 || !(box.bottom - box.top > 40)) return false;
    var x = box.x, w = box.w, top = box.top, bot = box.bottom;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.014)';
    ctx.fillRect(x, top, w, bot - top);
    ctx.strokeStyle = '#151e2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, bot);
    ctx.stroke();
    ctx.font = (opt.font || '10px') + ' -apple-system,"Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5a677b';
    ctx.fillText(opt.title || '筹码', x + 4, top + 9);

    var maxW = prof.peak > 0 ? prof.peak : 1;
    var usable = Math.max(4, w - 6);
    for (var k = 0; k < prof.levels; k++) {
      var wt = prof.weights[k];
      if (wt <= 0) continue;
      var p = prof.prices[k];
      var yA = yP(Math.min(prof.hi, p + prof.step / 2));
      var yB = yP(Math.max(prof.lo, p - prof.step / 2));
      var y0 = Math.max(top, Math.min(yA, yB));
      var y1 = Math.min(bot, Math.max(yA, yB));
      if (y1 <= y0) continue;
      var bw = Math.max(1, (wt / maxW) * usable);
      ctx.fillStyle = p <= close ? (opt.profitColor || 'rgba(246,70,93,.62)') : (opt.trapColor || 'rgba(86,138,200,.58)');
      ctx.fillRect(x + w - 2 - bw, y0, bw, Math.max(1, y1 - y0 - 0.6));
    }
    var yc = yP(close);
    if (yc >= top && yc <= bot) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(231,238,248,.5)';
      ctx.beginPath();
      ctx.moveTo(x, yc);
      ctx.lineTo(x + w, yc);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    var ys = [yP(prof.high90), yP(prof.low90)];
    ctx.strokeStyle = 'rgba(120,140,170,.45)';
    ctx.setLineDash([1, 3]);
    for (var s = 0; s < ys.length; s++) {
      var yy = ys[s];
      if (yy < top || yy > bot) continue;
      ctx.beginPath();
      ctx.moveTo(x + w - 16, yy);
      ctx.lineTo(x + w, yy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    return true;
  }

  /* ---------------- 神奇九转（TD 序列 9 计数） ---------------- */
  // 收盘价对比 4 根前：连涨为上升结构（dir=1，卖点），连跌为下跌结构（dir=-1，买点）
  function nineTurn(bars) {
    var out = [];
    for (var i = 0; i < (bars ? bars.length : 0); i++) {
      if (i < 4) { out.push(null); continue; }
      var c = bars[i].c, p4 = bars[i - 4].c, prev = out[i - 1];
      var dir = c > p4 ? 1 : (c < p4 ? -1 : 0);
      if (!dir) { out.push(null); continue; }
      var n = (prev && prev.dir === dir && prev.n < 9) ? prev.n + 1 : 1;
      out.push({ dir: dir, n: n, nine: n === 9 });
    }
    return out;
  }

  /* 盘口派生指标
     - 股本优先取 window.KLINE_SHARES（同花顺 iFinD 真实股本：总股本、流通A股，单位股）
       市值 = 总股本 × 收盘价；流通市值 = 流通A股 × 收盘价；换手率 = 成交量(手)×100 ÷ 流通A股 × 100%
     - 缺股本时（ETF/退市标的）退化为估算：近 20~60 根成交量中位数 ÷ 2% 作为流通股本，市值按流通市值 ×1.1
     - 外盘/内盘：日频真实主动买卖无法批量获取，统一按收盘位于当日区间的比例拆分成交量，标记 est */
  function quoteStats(sym, i) {
    if (!sym || !sym.bars || !sym.bars.length) return null;
    var bars = sym.bars;
    var idx = Math.max(0, Math.min(bars.length - 1, i == null ? bars.length - 1 : i));
    var bar = bars[idx];
    var vol = bar.v || 0;
    var range = bar.h - bar.l;
    var ratio = range > 0 ? (bar.c - bar.l) / range : 0.5;
    ratio = Math.max(0.08, Math.min(0.92, ratio));
    var buy = vol * ratio;

    var table = global.KLINE_SHARES || {};
    var sh = table[sym.code];
    if (sh && sh[0] > 0 && sh[1] > 0) {
      return {
        cap: sh[0] * bar.c,
        floatCap: sh[1] * bar.c,
        turn: vol * 100 / sh[1] * 100,
        buy: buy,
        sell: vol - buy,
        real: true
      };
    }

    var samples = [], k, v;
    for (k = Math.max(0, idx - 60); k < idx; k++) {
      v = bars[k].v;
      if (v > 0) samples.push(v);
    }
    if (!samples.length) {
      for (k = 0; k <= idx; k++) {
        v = bars[k].v;
        if (v > 0) samples.push(v);
      }
    }
    var med = 0;
    if (samples.length) {
      samples.sort(function (a, b) { return a - b; });
      var mid = samples.length >> 1;
      med = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
    }
    var floatHands = med > 0 ? med / 0.02 : 0;
    var floatCap = floatHands * 100 * bar.c;
    return {
      cap: floatCap * 1.1,
      floatCap: floatCap,
      turn: floatHands > 0 ? (vol / floatHands) * 100 : 0,
      buy: buy,
      sell: vol - buy,
      real: false
    };
  }

  /* ---------------- 心理训练：传闻、行为诊断、连续赛季 ---------------- */
  var RUMOR_TPL = [
    { dir: 1, text: '传：有机构近期密集调研标的公司，关注其新增产能与订单节奏。' },
    { dir: 1, text: '传：渠道反馈标的公司主力产品近期动销环比改善，库存有去化迹象。' },
    { dir: 1, text: '传：标的公司或参与产业链整合，市场对其资产注入存在预期。' },
    { dir: 1, text: '传：有活跃资金反复出现在标的公司龙虎榜，短线情绪偏强。' },
    { dir: -1, text: '传：市场传闻标的公司大股东近期有减持安排，规模尚未确认。' },
    { dir: -1, text: '传：有投资者质疑标的公司应收账款周转放缓，现金流质量存疑。' },
    { dir: -1, text: '传：标的公司核心客户订单出现调整，短期业绩可能承压。' },
    { dir: -1, text: '传：研报提示标的公司所在行业竞争加剧，价格战风险上升。' },
    { dir: 0, text: '传：标的公司近期接待多家机构调研，但未披露具体交流内容。' },
    { dir: 0, text: '传：市场对标的公司所在板块的分歧加大，多空双方均有加仓。' },
    { dir: 1, text: '传：有券商将标的公司移出降级名单，认为其盈利拐点已现。' },
    { dir: 1, text: '传：标的公司新产线传出试产顺利消息，良率高于市场预期。' },
    { dir: 1, text: '传：北向资金连续多日增持标的公司，持股比例接近披露线。' },
    { dir: 1, text: '传：标的公司获得新客户定点，订单将在下季度开始交付。' },
    { dir: 1, text: '传：行业景气度回升，标的公司产品报价出现年内首次上调。' },
    { dir: 1, text: '传：标的公司拟推出股权激励，考核目标被解读为业绩信心。' },
    { dir: 1, text: '传：标的公司大股东质押比例下降，市场解读为资金压力缓解。' },
    { dir: 1, text: '传：有资金在尾盘持续扫货标的公司，疑似提前获知利好消息。' },
    { dir: 1, text: '传：标的公司所在行业被纳入政策支持名单，补贴细则待落地。' },
    { dir: -1, text: '传：标的公司供应商透露订单交付推迟，短期收入确认或受影响。' },
    { dir: -1, text: '传：有机构在内部会议中下调标的公司评级，理由为估值偏高。' },
    { dir: -1, text: '传：标的公司高管亲属账户出现减持记录，引发市场猜测。' },
    { dir: -1, text: '传：标的公司募投项目进度不及预期，投产时间可能后延。' },
    { dir: -1, text: '传：行业库存高企，标的公司产品价格出现松动迹象。' },
    { dir: -1, text: '传：标的公司应收账款账龄拉长，坏账计提比例或被上调。' },
    { dir: -1, text: '传：监管问询函传闻流出，标的公司信披合规性受到关注。' },
    { dir: -1, text: '传：标的公司主要股东之间就董事会席位存在分歧。' },
    { dir: -1, text: '传：有做空资金在期权市场建立头寸，押注标的公司短期回落。' },
    { dir: 0, text: '传：标的公司将于近期召开业绩说明会，市场关注管理层指引。' },
    { dir: 0, text: '传：标的公司所在板块成交额放大，但资金流向分歧明显。' },
    { dir: 0, text: '传：标的公司办公地址搬迁，被解读为扩张或收缩两种版本。' },
    { dir: 0, text: '传：标的公司被纳入某指数样本观察名单，调整结果尚未公布。' },
    { dir: 0, text: '传：标的公司近期人事变动，市场对其战略连续性看法不一。' }
  ];

  // 资讯噪音：与真实公告混排的匿名快讯（无方向性，只增加信息噪音）
  var NEWS_TPL = [
    '标的公司发布公告：董事会审议通过修订公司章程的议案。',
    '标的公司披露投资者关系活动记录表，机构关注成本控制进展。',
    '交易所互动平台：标的公司回复投资者关于产能利用率的提问。',
    '标的公司公告：拟使用闲置自有资金进行现金管理。',
    '标的公司发布股东大会决议公告，各项议案均获通过。',
    '标的公司公告：副总经理因个人原因辞去职务。',
    '行业数据：本月同类产品产量环比小幅波动，价格总体平稳。',
    '标的公司公告：获得政府补助，金额占最近一期净利润比例较低。',
    '标的公司披露：控股股东所持部分股份解除质押。',
    '标的公司公告：变更持续督导保荐代表人。',
    '标的公司发布业绩说明会预告，将于近期与投资者交流。',
    '行业协会发布月度运行数据，整体开工率与上月基本持平。',
    '标的公司公告：全资子公司完成工商变更登记。',
    '标的公司披露：使用部分闲置募集资金暂时补充流动资金。',
    '标的公司公告：会计政策变更，对当期利润影响有限。',
    '标的公司发布澄清公告：媒体报道内容与实际情况存在差异。',
    '标的公司公告：回购股份进展，本月累计回购比例不足 1%。',
    '标的公司披露：董事减持计划时间过半，尚未实施。',
    '行业新闻：多项国家标准开始征求意见，落地时间未定。',
    '标的公司公告：签订日常经营合同，金额未达披露标准。',
    '标的公司披露：子公司通过高新技术企业重新认定。',
    '标的公司公告：变更注册地址并换发营业执照。',
    '行业新闻：上游原材料报价小幅调整，供需格局未有明显变化。',
    '标的公司公告：部分限售股将于下月解禁，数量占比有限。'
  ];

  function seedOf(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function randOf(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // 在 span 个位置里随机取 n 个互不重复的落点（升序），保证密度均匀又不撞车
  function pickSpots(rnd, n, span) {
    var slots = [], i;
    for (i = 0; i < span; i++) slots.push(i);
    for (i = 0; i < n; i++) {
      var j = i + Math.floor(rnd() * (span - i));
      var t = slots[i]; slots[i] = slots[j]; slots[j] = t;
    }
    return slots.slice(0, n).sort(function (a, b) { return a - b; });
  }

  // 确定性生成：同一标的 + 起点 + 长度永远得到同一组传闻，刷新不丢
  // 密度：平均每 3 根 K 线一条
  function genRumors(sym, start, len) {
    var code = (sym && sym.code) || 'x';
    var rnd = randOf(seedOf(code + '|' + start + '|' + len + '|R'));
    var n = Math.max(2, Math.round(len / 3));
    var lo = start + 3, hi = start + len - 3;
    var span = Math.max(1, hi - lo + 1);
    if (n > span) n = span;
    var spots = pickSpots(rnd, n, span);
    var out = [];
    for (var k = 0; k < n; k++) {
      var t = RUMOR_TPL[Math.floor(rnd() * RUMOR_TPL.length)];
      out.push({ i: lo + spots[k], dir: t.dir, title: t.text });
    }
    return out;
  }

  // 资讯噪音：按缺口补足"平均每 3 根一条"的资讯密度，确定性生成
  function genNewsNoise(sym, start, len, count) {
    count = Math.floor(count || 0);
    if (count <= 0) return [];
    var code = (sym && sym.code) || 'x';
    var rnd = randOf(seedOf(code + '|' + start + '|' + len + '|N'));
    var lo = start + 2, hi = start + len - 2;
    var span = Math.max(1, hi - lo + 1);
    if (count > span) count = span;
    var spots = pickSpots(rnd, count, span);
    var out = [];
    for (var k = 0; k < count; k++) {
      out.push({ i: lo + spots[k], title: NEWS_TPL[Math.floor(rnd() * NEWS_TPL.length)] });
    }
    return out;
  }

  // 传闻验证：看传闻出现后 10 根（且不超过本局终点）的方向是否与传闻一致
  function verifyRumors(rumors, bars, end) {
    return (rumors || []).map(function (x) {
      var dir = x.dir || 0;
      var i = Math.max(0, Math.min(bars.length - 1, x.i));
      var j = Math.min(bars.length - 1, Math.max(i + 1, Math.min(end == null ? i + 10 : end, i + 10)));
      var move = bars[i].c > 0 ? bars[j].c / bars[i].c - 1 : 0;
      return {
        i: x.i, dir: dir, title: x.title, move: move,
        hit: dir === 0 ? null : (move * dir > 0.005)
      };
    });
  }

  // 从成交反推行为倾向：处置效应、锚定、过度交易、追高、卖出质量、连亏加仓
  function analyzeBehavior(r) {
    var closed = (r.closed || []).slice();
    var orders = (r.orders || []).slice();
    var bars = (r.sym && r.sym.bars) || [];
    var nBar = Math.max(1, r.cur - r.start + 1);
    var wins = closed.filter(function (t) { return t.pnl > 0; });
    var losses = closed.filter(function (t) { return t.pnl <= 0; });
    var avg = function (arr, key) {
      return arr.length ? arr.reduce(function (a, b) { return a + (b[key] || 0); }, 0) / arr.length : null;
    };
    var holdWin = avg(wins, 'hold');
    var holdLoss = avg(losses, 'hold');
    var disposition = holdWin > 0 && holdLoss != null ? holdLoss / holdWin : null;

    var anchorN = 0;
    closed.forEach(function (t) {
      if (t.cost > 0 && t.price > 0 && Math.abs(t.price / t.cost - 1) <= 0.01) anchorN++;
    });
    var anchorPct = closed.length ? anchorN / closed.length : null;

    var trips = closed.length;
    var turnover = trips / nBar * 100;

    var chase = closed.filter(function (t) { return t.tag === '追涨'; });
    var chaseWin = chase.length ? chase.filter(function (t) { return t.pnl > 0; }).length / chase.length : null;

    var after = [], goodSell = 0;
    closed.forEach(function (t) {
      if (!(t.price > 0) || t.i == null) return;
      var j = Math.min(bars.length - 1, t.i + 10);
      if (j <= t.i) return;
      var mv = bars[j].c / t.price - 1;
      after.push(mv);
      if (mv < 0) goodSell++;
    });
    var avgAfter = after.length ? after.reduce(function (a, b) { return a + b; }, 0) / after.length : null;
    var sellGood = after.length ? goodSell / after.length : null;

    var events = orders.slice().sort(function (a, b) { return a.i - b.i; });
    var streak = 0, lastBuy = 0, revenge = 0, revengeExtra = 0;
    events.forEach(function (o) {
      if (o.pnl != null) {
        if (o.pnl < 0) streak++; else streak = 0;
      }
      if (o.side === 'B' && o.kind !== '买券还券') {
        var amt = (o.qty || 0) * (o.price || 0);
        if (amt <= 0) return;
        if (streak >= 2 && lastBuy > 0 && amt > lastBuy * 1.2) {
          revenge++;
          revengeExtra += amt - lastBuy;
        }
        lastBuy = amt;
      }
    });

    return {
      trades: trips, bars: nBar,
      holdWin: holdWin, holdLoss: holdLoss, disposition: disposition,
      anchorN: anchorN, anchorPct: anchorPct,
      turnover: turnover,
      chaseN: chase.length, chaseWin: chaseWin,
      sellN: after.length, sellGood: sellGood, afterMove: avgAfter,
      revenge: revenge, revengeExtra: revengeExtra
    };
  }

  var SEASON_KEY = 'klineCampSeason';
  function seasonGet() {
    try {
      var o = JSON.parse(localStorage.getItem(SEASON_KEY) || 'null');
      return o && o.active ? o : null;
    } catch (e) { return null; }
  }
  function seasonSave(o) {
    try { localStorage.setItem(SEASON_KEY, JSON.stringify(o)); } catch (e) {}
  }
  function seasonBegin(len, cap) {
    var o = { active: true, len: len, n: 1, cap: cap, startCap: cap, startT: Date.now(), rounds: [] };
    seasonSave(o);
    return o;
  }
  function seasonReset() {
    try { localStorage.removeItem(SEASON_KEY); } catch (e) {}
  }

  global.KC = {
    FEE_RATE: FEE_RATE, MIN_FEE: MIN_FEE, SELL_TAX: SELL_TAX,
    chipProfile: chipProfile, drawChips: drawChips, nineTurn: nineTurn,
    quoteStats: quoteStats,
    setFees: setFees, getFees: getFees,
    feeOf: feeOf, sellFeeOf: sellFeeOf, limitPctOf: limitPctOf, limitsOf: limitsOf, lotRule: lotRule,
    TAGS: TAGS,
    executeTrade: executeTrade,
    MARGIN: MARGIN, marginCfg: marginCfg, marginDebt: marginDebt, equityOf: equityOf, maintRatio: maintRatio,
    marginAvail: marginAvail, marginMaxQty: marginMaxQty, accrueMargin: accrueMargin, checkMarginCall: checkMarginCall,
    finBuy: finBuy, repaySell: repaySell, shortSell: shortSell, coverShort: coverShort,
    STRATEGIES: STRATEGIES, strategyLabel: strategyLabel, pendingLabel: pendingLabel,
    placePending: placePending, cancelPending: cancelPending, ensurePending: ensurePending,
    triggerPendingList: triggerPendingList,
    simPath: simPath, drawIntraday: drawIntraday,
    ROUND_KEY: ROUND_KEY,
    toWeekly: toWeekly,
    compactCurve: compactCurve,
    saveRound: saveRound, clearRound: clearRound, loadRound: loadRound,
    indexReturn: indexReturn, indexSeries: indexSeries, INDEX_CODE: INDEX_CODE,
    tour: tour,
    genRumors: genRumors, genNewsNoise: genNewsNoise, verifyRumors: verifyRumors, analyzeBehavior: analyzeBehavior,
    seasonGet: seasonGet, seasonSave: seasonSave, seasonBegin: seasonBegin, seasonReset: seasonReset,
    loadData: loadData, ensureBars: ensureBars, loadPack: loadPack, DATE_CACHE: DATE_CACHE
  };
})(typeof window !== 'undefined' ? window : this);
