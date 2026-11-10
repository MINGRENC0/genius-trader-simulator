# -*- coding: utf-8 -*-
"""增量扩充标的池：向 kline-data.js 追加一批新个股。

用法：python update_data.py [数量]
"""

import os
import time
from collections import defaultdict
from datetime import date, timedelta

import data_fmt
from fetch_data import fetch_stock_list, fetch_kline, board_of, num, END

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(BASE_DIR, "data", "legacy", "kline-data.js")
INDEX_CODE = "000300"


def load_dataset(path=DATA_FILE):
    return data_fmt.load(path)


def save_dataset(data, path=DATA_FILE):
    return data_fmt.save(data, path)


def pick_new(rows, existing, add):
    by_ind = defaultdict(list)
    for x in rows:
        code = str(x.get("f12", ""))
        name = str(x.get("f14", ""))
        if not code or not name or code in existing:
            continue
        if "ST" in name or "退" in name:
            continue
        if num(x.get("f26")) > 20210101:
            continue
        if not code.startswith(("60", "68", "00", "30")):
            continue
        ind = str(x.get("f100") or "其他")
        by_ind[ind].append({
            "code": code,
            "name": name,
            "ind": ind,
            "mcap": num(x.get("f20")),
        })

    for lst in by_ind.values():
        lst.sort(key=lambda c: -c["mcap"])

    picks = []
    pending = list(by_ind.keys())
    while len(picks) < add and pending:
        rest = []
        for ind in pending:
            lst = by_ind[ind]
            if lst:
                picks.append(lst.pop(0))
                if len(picks) >= add:
                    break
            if lst:
                rest.append(ind)
        pending = rest
    return picks


def add_symbols(add=60, progress=None):
    data = load_dataset()
    existing = {s["code"] for s in data}
    if progress:
        progress("scan", 0, add)
    rows = fetch_stock_list()
    picks = pick_new(rows, existing, add)
    if not picks:
        raise RuntimeError("没有可新增的标的，可能已接近全市场")

    added = 0
    for i, s in enumerate(picks, 1):
        if progress:
            progress("fetch", i, len(picks))
        try:
            bars = fetch_kline(s["code"])
            if len(bars) < 400:
                continue
            data.append({
                "code": s["code"],
                "name": s["name"],
                "cat": board_of(s["code"]),
                "ind": s["ind"],
                "bars": bars,
            })
            added += 1
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.1)

    if progress:
        progress("save", len(picks), len(picks))
    save_dataset(data)
    return added


def refresh_bars(days=20, progress=None):
    """刷新已有标的最近若干天的 K 线，返回更新的标的数。"""
    data = load_dataset()
    total = len(data)
    changed = 0
    for i, s in enumerate(data, 1):
        if progress:
            progress("refresh", i, total)
        bars = s.get("bars") or []
        if not bars:
            continue
        beg = (date.fromisoformat(bars[-1][0]) - timedelta(days=days)).strftime("%Y%m%d")
        try:
            new = fetch_kline(s["code"], beg=beg, end=END)
        except Exception:  # noqa: BLE001
            continue
        if not new:
            continue
        keep = [b for b in bars if b[0] < new[0][0]]
        if len(keep) + len(new) == len(bars) and keep and keep[-1][0] == bars[-1][0]:
            continue
        s["bars"] = keep + new
        changed += 1
        time.sleep(0.05)
    if changed:
        save_dataset(data)
    return changed


def ensure_index():
    """抓取沪深300 日线，供结算页做大市对比。"""
    bars = fetch_kline(INDEX_CODE, beg="20190101", end=END)
    if len(bars) < 400:
        raise RuntimeError("沪深300 数据不足")
    data = load_dataset()
    item = {"code": INDEX_CODE, "name": "沪深300", "cat": "指数", "ind": "指数", "bars": bars}
    idx = next((i for i, s in enumerate(data) if s["code"] == INDEX_CODE), None)
    if idx is None:
        data.append(item)
    else:
        data[idx] = item
    save_dataset(data)
    return len(bars)


if __name__ == "__main__":
    import sys

    mode = sys.argv[1] if len(sys.argv) > 1 else "add"

    def show(phase, cur, total):
        if phase in ("fetch", "refresh"):
            print(f"\r{phase} {cur}/{total}", end="", flush=True)

    if mode == "refresh":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        print("\r刷新", refresh_bars(days, show), "只标的的最近 K 线")
    elif mode == "index":
        print("沪深300 写入", ensure_index(), "根日K")
    else:
        count = int(sys.argv[1]) if len(sys.argv) > 1 else 60
        print("新增", add_symbols(count, show), "只标的")
