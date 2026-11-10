# -*- coding: utf-8 -*-
"""kline-data.js 的读写：索引 + 压缩二进制（v2），并兼容旧的 JSON 格式。

v2 结构：
    window.KLINE_FMT=2;
    window.KLINE_INDEX=[{c,n,t,i,o,k},...];  // 代码/名称/板块/行业/起始bar序号/bar数量
    window.KLINE_PACK="<base64(zlib(定长bar))>";

每条 bar 定长 22 字节（小端）：
    uint16 日期偏移（自 2019-01-01）
    uint32 开、高、低、收（价格 ×1000）
    uint32 成交量
"""

import base64
import json
import os
import struct
import zlib
from datetime import date

BAR = struct.Struct("<Hiiiii")
EPOCH = date(2019, 1, 1)
EPOCH_ORD = EPOCH.toordinal()
FMT_HEAD = "window.KLINE_FMT=2;\n"
I32 = 0x7FFFFFFF


def _i32(x):
    return max(-I32, min(int(round(x)), I32))


def sanitize(data):
    """前复权会让部分高分红股早期价格变成负数，打包时剔除这些 K 线。"""
    out = []
    removed = 0
    for s in data:
        bars = [b for b in s["bars"] if b[1] > 0 and b[2] > 0 and b[3] > 0 and b[4] > 0]
        removed += len(s["bars"]) - len(bars)
        item = dict(s)
        item["bars"] = bars
        out.append(item)
    return out, removed


def _pack_bars(bars):
    out = bytearray()
    for b in bars:
        d = b[0]
        off = date(int(d[0:4]), int(d[5:7]), int(d[8:10])).toordinal() - EPOCH_ORD
        out += BAR.pack(
            off & 0xFFFF,
            _i32(b[1] * 1000),
            _i32(b[3] * 1000),
            _i32(b[4] * 1000),
            _i32(b[2] * 1000),
            _i32(b[5]),
        )
    return bytes(out)


def save(data, path):
    """把 [{code,name,cat,ind,bars}] 写成 v2 打包文件，返回文件字节数。"""
    data, _ = sanitize(data)
    index = []
    raw = bytearray()
    for s in data:
        idx = len(raw) // BAR.size
        raw += _pack_bars(s["bars"])
        index.append({
            "c": s["code"],
            "n": s["name"],
            "t": s["cat"],
            "i": s.get("ind") or "",
            "o": idx,
            "k": len(s["bars"]),
        })
    pack = base64.b64encode(zlib.compress(bytes(raw), 9)).decode("ascii")
    with open(path, "w", encoding="utf-8") as fp:
        fp.write(FMT_HEAD)
        fp.write("window.KLINE_INDEX=" + json.dumps(index, ensure_ascii=False, separators=(",", ":")) + ";\n")
        fp.write('window.KLINE_PACK="' + pack + '";\n')
    return os.path.getsize(path)


def load(path):
    with open(path, encoding="utf-8") as fp:
        txt = fp.read()
    if "window.KLINE_PACK=" in txt:
        return _load_packed(txt)
    return _load_legacy(txt)


def _load_packed(txt):
    i = txt.index("window.KLINE_INDEX=") + len("window.KLINE_INDEX=")
    j = txt.index("window.KLINE_PACK=")
    index = json.loads(txt[i:j].strip().rstrip(";"))
    k = j + len('window.KLINE_PACK="')
    m = txt.index('"', k)
    raw = zlib.decompress(base64.b64decode(txt[k:m]))

    out = []
    for e in index:
        base = e["o"] * BAR.size
        bars = []
        for n in range(e["k"]):
            off, o, h, l, c, v = BAR.unpack_from(raw, base + n * BAR.size)
            bars.append([
                date.fromordinal(EPOCH_ORD + off).isoformat(),
                o / 1000.0, c / 1000.0, h / 1000.0, l / 1000.0, v,
            ])
        out.append({"code": e["c"], "name": e["n"], "cat": e["t"], "ind": e.get("i", ""), "bars": bars})
    return out


def _load_legacy(txt):
    txt = txt.strip()
    if txt.startswith("window.KLINE_DATA="):
        txt = txt[len("window.KLINE_DATA="):]
    txt = txt.rstrip().rstrip(";")
    return json.loads(txt)


if __name__ == "__main__":
    import shutil
    import sys

    p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "legacy", "kline-data.js")
    before = os.path.getsize(p)
    data = load(p)
    data, removed = sanitize(data)
    if removed:
        print(f"剔除非正价格K线 {removed} 根（前复权所致）")

    tmp = p + ".new"
    save(data, tmp)

    # 回读校验：条数、K线根数、抽样价格必须一致
    check = load(tmp)
    if len(check) != len(data):
        raise SystemExit("校验失败：标的数量不一致")
    for a, b in zip(data, check):
        if len(a["bars"]) != len(b["bars"]):
            raise SystemExit("校验失败：K线数量不一致 " + a["code"])
        for i in (0, len(a["bars"]) // 2, len(a["bars"]) - 1):
            x, y = a["bars"][i], b["bars"][i]
            if x[0] != y[0] or abs(x[1] - y[1]) > 0.0015 or abs(x[2] - y[2]) > 0.0015:
                raise SystemExit(f"校验失败：数据不一致 {a['code']} {i}")

    legacy = p.replace(".js", ".legacy.js")
    if not os.path.exists(legacy):
        shutil.copy2(p, legacy)
    os.replace(tmp, p)

    bars = sum(len(s["bars"]) for s in data)
    print(f"标的 {len(data)} 只 / {bars:,} 根K线")
    print(f"{before/1048576:.1f} MB -> {os.path.getsize(p)/1048576:.1f} MB")
    print(f"旧格式备份：{legacy}")
