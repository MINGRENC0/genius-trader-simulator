# -*- coding: utf-8 -*-
"""抓取 A 股个股 + ETF 日线（2019-01-01 至今），生成训练器数据文件。

个股选择方式：按东方财富行业分类，每个行业取市值前若干只，
剔除 ST/退市/2021 年后上市，保证有足够历史数据。
"""

import time
from collections import defaultdict
from pathlib import Path

import requests

import data_fmt

LEGACY_DATA = Path(__file__).resolve().parent.parent / "data" / "legacy" / "kline-data.js"

BEG = "20190101"
END = "20261108"
KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"

ETFS = [
    ("510050", "上证50ETF", "宽基"),
    ("510300", "沪深300ETF", "宽基"),
    ("510500", "中证500ETF", "宽基"),
    ("159915", "创业板ETF", "宽基"),
    ("159949", "创业板50ETF", "宽基"),
    ("512880", "证券ETF", "行业"),
    ("512690", "酒ETF", "行业"),
    ("159928", "消费ETF", "行业"),
    ("512170", "医疗ETF", "行业"),
    ("512660", "军工ETF", "行业"),
    ("518880", "黄金ETF", "商品"),
    ("511260", "十年国债ETF", "债券"),
    ("513100", "纳指ETF", "跨境"),
    ("513500", "标普500ETF", "跨境"),
    ("159920", "恒生ETF", "跨境"),
    ("512480", "半导体ETF", "行业"),
    ("515050", "5G通信ETF", "行业"),
    ("159995", "芯片ETF", "行业"),
    ("515030", "新能源车ETF", "行业"),
    ("515790", "光伏ETF", "行业"),
    ("588000", "科创50ETF", "宽基"),
]

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def secid_of(code):
    if code == "000300":          # 沪深300 是指数，走沪市通道
        return "1." + code
    return ("1." if code.startswith(("5", "6")) else "0.") + code


def board_of(code):
    if code.startswith("68"):
        return "科创板"
    if code.startswith(("43", "83", "87", "88", "92")):
        return "北证"
    if code.startswith(("30",)):
        return "创业板"
    if code.startswith("6"):
        return "沪市主板"
    return "深市主板"


def fetch_stock_list():
    rows, total, page = [], None, 1
    while True:
        params = {
            "pn": page, "pz": 100, "po": 1, "np": 1, "fltt": 2, "invt": 2,
            "fid": "f20",
            "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
            "fields": "f12,f14,f20,f100,f26",
        }
        try:
            data = requests.get(LIST_URL, params=params, timeout=20, headers=HEADERS).json()["data"]
        except Exception as exc:  # noqa: BLE001
            print("list page", page, "failed:", exc)
            break
        if not data or not data.get("diff"):
            break
        total = data.get("total", total)
        rows.extend(data["diff"])
        if total and len(rows) >= total:
            break
        page += 1
        time.sleep(0.08)
    print(f"股票列表：{len(rows)} / {total}")
    return rows


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def pick_stocks(rows, target=420):
    cand = []
    for x in rows:
        code = str(x.get("f12", ""))
        name = str(x.get("f14", ""))
        if not code or not name:
            continue
        if "ST" in name or "退" in name:
            continue
        if num(x.get("f26")) > 20210101:
            continue
        if not code.startswith(("60", "68", "00", "30")):
            continue
        cand.append({
            "code": code,
            "name": name,
            "ind": str(x.get("f100") or "其他"),
            "mcap": num(x.get("f20")),
        })

    by_ind = defaultdict(list)
    for c in cand:
        by_ind[c["ind"]].append(c)
    per_ind = max(2, target // max(1, len(by_ind)))
    picks = []
    for ind, lst in by_ind.items():
        lst.sort(key=lambda x: -x["mcap"])
        picks.extend(lst[:per_ind])
    picks.sort(key=lambda x: -x["mcap"])
    print(f"行业数：{len(by_ind)}，每行业取 {per_ind} 只，得到 {len(picks)} 只")
    return picks[: target + 60]


def fetch_kline(code, beg=BEG, end=END):
    params = {
        "secid": secid_of(code),
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101", "fqt": "1", "beg": beg, "end": end,
    }
    last_err = None
    for _ in range(3):
        try:
            resp = requests.get(KLINE_URL, params=params, timeout=20, headers=HEADERS)
            resp.raise_for_status()
            data = resp.json()["data"]
            if not data or not data.get("klines"):
                raise RuntimeError("empty")
            bars = []
            for line in data["klines"]:
                p = line.split(",")
                bars.append([
                    p[0],
                    round(float(p[1]), 3),
                    round(float(p[2]), 3),
                    round(float(p[3]), 3),
                    round(float(p[4]), 3),
                    int(float(p[5])),
                ])
            return bars
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.5)
    raise RuntimeError(last_err)


def main():
    out = []
    rows = fetch_stock_list()
    picks = pick_stocks(rows)
    total = len(picks) + len(ETFS)

    for i, s in enumerate(picks, 1):
        try:
            bars = fetch_kline(s["code"])
            if len(bars) < 400:
                print(f"SKIP {s['code']} {s['name']} 仅 {len(bars)} 根")
                continue
            out.append({
                "code": s["code"], "name": s["name"],
                "cat": board_of(s["code"]), "ind": s["ind"], "bars": bars,
            })
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP {s['code']} {s['name']}: {exc}")
        if i % 20 == 0:
            print(f"  个股进度 {i}/{len(picks)}")
            time.sleep(0.4)
        time.sleep(0.1)

    for code, name, ind in ETFS:
        try:
            bars = fetch_kline(code)
            if len(bars) < 400:
                print(f"SKIP ETF {code} {name} 仅 {len(bars)} 根")
                continue
            out.append({"code": code, "name": name, "cat": "ETF", "ind": ind, "bars": bars})
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP ETF {code} {name}: {exc}")
        time.sleep(0.12)

    size = data_fmt.save(out, str(LEGACY_DATA))

    bars_total = sum(len(s["bars"]) for s in out)
    stock_n = sum(1 for s in out if s["cat"] != "ETF")
    print(f"\n写入 data/legacy/kline-data.js: {len(out)} 只标的（个股 {stock_n} + ETF {len(out) - stock_n}），{bars_total} 根K线")
    print(f"文件大小：{size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
