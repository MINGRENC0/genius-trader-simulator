# -*- coding: utf-8 -*-
"""抓取真实 5 分钟分时（Baostock），生成 kline-intra.js。

用法：
    python fetch_intra.py fetch [--years 2] [--workers 6] [--limit 5]
    python fetch_intra.py pack  [--years 2]

数据来源：Baostock 免费接口，frequency=5（5 分钟），adjustflag=3（不复权）。
不复权的分时与日线前复权价格不一致，打包时按「当日日线收盘 / 当日分时收盘」
得到当天的复权系数，整体缩放，保证与日 K 完全对齐。
"""

import argparse
import json
import math
import os
import sys
import time
from datetime import date, timedelta
from multiprocessing import Pool

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "cache", "intra5")
DAILY = os.path.join(ROOT, "data", "legacy", "kline-data.js")
OUT = os.path.join(ROOT, "data", "legacy", "kline-intra.js")


def bao_code(code):
    if code.startswith(("5", "6")):
        return "sh." + code
    return "sz." + code


def load_symbols(years):
    import data_fmt

    data = data_fmt.load(DAILY)
    cutoff = date.today() - timedelta(days=int(365.25 * years) + 10)
    out = []
    for s in data:
        days = [b[0] for b in s["bars"] if b[0] >= cutoff.isoformat()]
        if days:
            out.append((s["code"], days[0], days[-1]))
    return out


def fetch_one(job):
    """抓一个标的的全部分时，写入缓存文件。返回 (code, rows, ok)。"""
    code, beg, end = job
    path = os.path.join(CACHE, code + ".jsonl")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, encoding="utf-8") as fp:
            return code, sum(1 for _ in fp), True

    import baostock as bs

    lg = bs.login()
    if lg.error_code != "0":
        return code, 0, False

    tmp = path + ".tmp"
    rows = 0
    try:
        b = date(int(beg[:4]), int(beg[5:7]), int(beg[8:10]))
        e_all = date(int(end[:4]), int(end[5:7]), int(end[8:10]))
        with open(tmp, "w", encoding="utf-8") as fp:
            while b <= e_all:
                e = min(date(b.year + 1, b.month, b.day) - timedelta(days=1), e_all)
                rs = bs.query_history_k_data_plus(
                    bao_code(code), "date,time,close,volume",
                    start_date=b.isoformat(), end_date=e.isoformat(),
                    frequency="5", adjustflag="3",
                )
                if rs.error_code != "0":
                    break
                while rs.next():
                    d = rs.get_row_data()
                    # time: 20260901093500000 -> 0935
                    fp.write("%s,%s,%s,%s\n" % (d[0], d[1][8:12], d[2], d[3]))
                    rows += 1
                b = e + timedelta(days=1)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001
        try:
            os.remove(tmp)
        except OSError:
            pass
        return code, 0, False
    finally:
        bs.logout()
    return code, rows, True


def do_fetch(years, workers, limit=None):
    os.makedirs(CACHE, exist_ok=True)
    jobs = load_symbols(years)
    if limit:
        jobs = jobs[:limit]
    print(f"待抓取 {len(jobs)} 只标的，{years} 年窗口，{workers} 进程", flush=True)

    t0 = time.time()
    done = rows = fail = 0
    with Pool(workers) as pool:
        for code, n, ok in pool.imap_unordered(fetch_one, jobs):
            done += 1
            rows += n
            if not ok:
                fail += 1
            if done % 10 == 0 or done == len(jobs):
                cost = time.time() - t0
                print(f"  {done}/{len(jobs)}  行数 {rows:,}  失败 {fail}  "
                      f"{cost:.0f}s", flush=True)
    print(f"完成：{rows} 行，失败 {fail} 只，用时 {(time.time()-t0)/60:.1f} 分钟", flush=True)


def do_pack(years):
    import struct

    import data_fmt

    daily = {s["code"]: s for s in data_fmt.load(DAILY)}
    cutoff = (date.today() - timedelta(days=int(365.25 * years) + 10)).isoformat()

    index, raw = [], bytearray()
    CH = 48
    DAYREC = CH * 2 + CH + 4      # 96 字节价格 + 48 字节量 + 4 字节日期/序号
    for code in sorted(os.listdir(CACHE)):
        if not code.endswith(".jsonl"):
            continue
        code = code[:-6]
        sym = daily.get(code)
        if not sym:
            continue
        path = os.path.join(CACHE, code + ".jsonl")
        by_day = {}
        with open(path, encoding="utf-8") as fp:
            for line in fp:
                p = line.rstrip("\n").split(",")
                if len(p) != 4 or p[0] < cutoff:
                    continue
                by_day.setdefault(p[0], []).append(p)

        bars = {b[0]: b for b in sym["bars"]}
        off0 = len(raw)
        cnt = 0
        for d in sorted(by_day):
            bar = bars.get(d)
            pts = by_day[d]
            if not bar or len(pts) < CH:
                continue
            o, c, h, l, v = bar[1], bar[2], bar[3], bar[4], bar[5]
            last = float(pts[-1][2])
            if last <= 0 or h <= l:
                continue
            k = c / last                      # 当日复权系数
            lo, hi = l / k, h / k             # 还原到不复权坐标
            vals = [float(p[2]) for p in pts[:CH]]
            vals = [min(max(x, lo), hi) for x in vals]
            span = hi - lo
            if span <= 0:
                continue
            # 价格：48 个 uint16（相对当日最低价的 16 位刻度）
            raw += struct.pack("<48H", *[int((x - lo) / span * 65535) for x in vals])
            # 成交量：48 个 uint8（相对当日峰值的对数刻度，0~255）
            vols = [int(float(p[3])) for p in pts[:CH]]
            vmax = max(vols) or 1
            raw += bytes([min(255, int(round(255 * math.log1p(x) / math.log1p(vmax)))) for x in vols])
            # 日索引（相对 2020-01-01 的天数，uint16）
            raw += struct.pack("<HH", date(int(d[:4]), int(d[5:7]), int(d[8:10])).toordinal() - date(2020, 1, 1).toordinal(), cnt)
            cnt += 1
        if cnt:
            index.append({"c": code, "o": off0 // DAYREC, "k": cnt})

    import base64
    import zlib

    pack = base64.b64encode(zlib.compress(bytes(raw), 9)).decode("ascii")
    with open(OUT, "w", encoding="utf-8") as fp:
        fp.write("window.KINTRA_FMT=1;\n")
        fp.write("window.KINTRA_INDEX=" + json.dumps(index, separators=(",", ":")) + ";\n")
        fp.write('window.KINTRA_PACK="' + pack + '";\n')
    days = sum(e["k"] for e in index)
    print(f"打包完成：{len(index)} 只 / {days:,} 个交易日")
    print(f"大小：{os.path.getsize(OUT)/1048576:.1f} MB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "pack"])
    ap.add_argument("--years", type=float, default=2.0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if a.cmd == "fetch":
        do_fetch(a.years, a.workers, a.limit or None)
    else:
        do_pack(a.years)
