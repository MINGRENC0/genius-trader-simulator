# -*- coding: utf-8 -*-
"""拉取期货主力连续日K（2019 至今），打包为 kline-fut-data.js。
用法：python fetch_futures.py
"""
import base64
import json
import struct
import time
import zlib
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "kline-fut-data.js"
URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
UT = "fa5fd1943c7b386f172d6893dbfba10b"
HEAD = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
BEG, END = "20190101", "20261108"
BAR = struct.Struct("<Hiiiii")
EPOCH = date(2019, 1, 1).toordinal()
I32 = 0x7FFFFFFF

# code, 名称, 交易所, secid, 合约乘数, 最小变动, 保证金率
CONTRACTS = [
    ("RB", "螺纹钢", "上期所", "113.rbm", 10, 1, 0.10),
    ("CU", "沪铜", "上期所", "113.cum", 5, 10, 0.12),
    ("AL", "沪铝", "上期所", "113.alm", 5, 5, 0.12),
    ("ZN", "沪锌", "上期所", "113.znm", 5, 5, 0.12),
    ("NI", "沪镍", "上期所", "113.nim", 1, 10, 0.14),
    ("AU", "沪金", "上期所", "113.aum", 1000, 0.02, 0.12),
    ("AG", "沪银", "上期所", "113.agm", 15, 1, 0.14),
    ("RU", "橡胶", "上期所", "113.rum", 10, 5, 0.12),
    ("HC", "热卷", "上期所", "113.hcm", 10, 1, 0.10),
    ("BU", "沥青", "上期所", "113.bum", 10, 1, 0.12),
    ("M", "豆粕", "大商所", "114.mm", 10, 1, 0.09),
    ("Y", "豆油", "大商所", "114.ym", 10, 2, 0.09),
    ("P", "棕榈油", "大商所", "114.pm", 10, 2, 0.10),
    ("C", "玉米", "大商所", "114.cm", 10, 1, 0.08),
    ("I", "铁矿石", "大商所", "114.im", 100, 0.5, 0.13),
    ("J", "焦炭", "大商所", "114.jm", 100, 0.5, 0.15),
    ("JM", "焦煤", "大商所", "114.jmm", 60, 0.5, 0.15),
    ("EG", "乙二醇", "大商所", "114.egm", 10, 1, 0.10),
    ("MA", "甲醇", "郑商所", "115.MAM", 10, 1, 0.10),
    ("TA", "PTA", "郑商所", "115.TAM", 5, 2, 0.09),
    ("SR", "白糖", "郑商所", "115.SRM", 10, 1, 0.09),
    ("CF", "棉花", "郑商所", "115.CFM", 5, 5, 0.09),
    ("FG", "玻璃", "郑商所", "115.FGM", 20, 1, 0.12),
    ("SA", "纯碱", "郑商所", "115.SAM", 20, 1, 0.12),
    ("SC", "原油", "能源中心", "142.scm", 1000, 0.1, 0.15),
    ("EC", "欧线集运", "能源中心", "142.ecm", 50, 0.1, 0.18),
    ("IF", "沪深300", "中金所", "220.IFm", 300, 0.2, 0.12),
    ("IC", "中证500", "中金所", "220.ICm", 200, 0.2, 0.14),
    ("IH", "上证50", "中金所", "220.IHm", 200, 0.2, 0.12),
    ("IM", "中证1000", "中金所", "220.IMm", 200, 0.2, 0.15),
]


def i32(x):
    return max(-I32, min(int(round(x)), I32))


def fetch(secid):
    p = {"secid": secid, "ut": UT, "fields1": "f1,f2,f3,f4,f5,f6",
         "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
         "klt": "101", "fqt": "1", "beg": BEG, "end": END}
    last = None
    for n in range(3):
        try:
            d = requests.get(URL, params=p, headers=HEAD, timeout=25).json().get("data")
            if not d or not d.get("klines"):
                raise RuntimeError("empty")
            out = []
            for line in d["klines"]:
                x = line.split(",")
                out.append([x[0], float(x[1]), float(x[3]), float(x[4]), float(x[2]), int(float(x[5]))])
            return d.get("name") or "", out
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.4 * (n + 1))
    raise RuntimeError(last)


def pack(bars):
    raw = bytearray()
    for d, o, h, l, c, v in bars:
        off = date(int(d[0:4]), int(d[5:7]), int(d[8:10])).toordinal() - EPOCH
        raw += BAR.pack(off & 0xFFFF, i32(o * 1000), i32(h * 1000), i32(l * 1000), i32(c * 1000), i32(v))
    return bytes(raw)


def main():
    meta, raw, removed = [], bytearray(), 0
    for code, name, ex, secid, mul, tick, mr in CONTRACTS:
        try:
            _, bars = fetch(secid)
        except Exception as e:  # noqa: BLE001
            print("跳过", code, e)
            continue
        clean = []
        for b in bars:
            if b[1] > 0 and b[2] > 0 and b[3] > 0 and b[4] > 0:
                clean.append(b)
            else:
                removed += 1
        if len(clean) < 420:
            print("跳过", code, "K线不足", len(clean))
            continue
        off = len(raw) // BAR.size
        raw += pack(clean)
        meta.append({"c": code, "n": name, "x": ex, "mul": mul, "tick": tick, "mr": mr,
                     "k": len(clean), "o": off, "d0": clean[0][0], "d1": clean[-1][0],
                     "lo": round(min(b[3] for b in clean), 3)})
        print(code, name, len(clean), clean[0][0], "->", clean[-1][0], flush=True)

    meta.sort(key=lambda x: (x["x"], x["c"]))
    pack64 = base64.b64encode(zlib.compress(bytes(raw), 9)).decode("ascii")
    with open(OUT, "w", encoding="utf-8") as fp:
        fp.write("window.KLINE_FUT_FMT=1;\n")
        fp.write("window.KLINE_FUT_INDEX=" + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + ";\n")
        fp.write('window.KLINE_FUT_PACK="' + pack64 + '";\n')
    print("合约", len(meta), "K线", len(raw) // BAR.size, "剔除", removed,
          "大小", round(len(pack64) / 1048576, 2), "MB")


if __name__ == "__main__":
    main()
