# -*- coding: utf-8 -*-
"""为全部标的生成离线公告/新闻分片（每只最近 100 条公告 + 20 条新闻）。

数据源：东方财富公告接口 + 东方财富新闻搜索接口。
产物：
  kline-news-pack-XXXX.js  按代码前 4 位分片，zlib+base64 压缩
  kline-news-index.js      分片索引
"""
import base64
import json
import re
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
IDX = DATA / "kline-index.js"
ANN = "https://np-anotice-stock.eastmoney.com/api/security/ann"
NEWS = "https://search-api-web.eastmoney.com/search/jsonp"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
}
MAX_ANN = 100
MAX_NEWS = 20
WORKERS = 8


def load_symbols():
    text = IDX.read_text(encoding="utf-8")
    raw = text[text.index("["):]
    arr = json.loads(raw.strip().rstrip(";"))
    out, seen = [], set()
    for x in arr:
        code = str(x.get("c", ""))
        name = str(x.get("n", ""))
        if len(code) != 6 or not code.isdigit() or code in seen:
            continue
        seen.add(code)
        out.append((code, name))
    return out


def clean(s, limit=None):
    s = str(s or "")
    s = re.sub(r"<[^>]*>", "", s)
    s = re.sub(r"[\r\n\t]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] if limit else s


def fetch_ann(code):
    try:
        r = requests.get(ANN, params={
            "sr": -1, "page_size": MAX_ANN, "page_index": 1, "ann_type": "A",
            "client_source": "web", "stock_list": code,
        }, headers=HEADERS, timeout=15)
        data = r.json().get("data") or {}
        items = []
        for it in (data.get("list") or [])[:MAX_ANN]:
            d = str(it.get("notice_date") or "")[:10]
            t = clean(it.get("title"))
            if d and t:
                items.append([d, t, "", "A", "公告"])
        return items
    except Exception:
        return []


def fetch_news(code):
    try:
        param = {
            "uid": "", "keyword": code, "type": ["cmsArticleWebOld"],
            "client": "web", "clientType": "web", "clientVersion": "curr",
            "param": {"cmsArticleWebOld": {
                "searchScope": "default", "sort": "time", "pageIndex": 1,
                "pageSize": MAX_NEWS, "preTag": "", "postTag": "",
            }},
        }
        r = requests.get(NEWS, params={"cb": "cb", "param": json.dumps(param, ensure_ascii=False, separators=(",", ":"))},
                         headers=HEADERS, timeout=15)
        txt = r.text
        m = re.search(r"^[^(]*\((.*)\)\s*$", txt, re.S)
        if not m:
            return []
        obj = json.loads(m.group(1))
        arr = ((obj.get("result") or {}).get("cmsArticleWebOld") or [])[:MAX_NEWS]
        items = []
        for it in arr:
            d = str(it.get("date") or "")[:10]
            t = clean(it.get("title"))
            s = clean(it.get("content"), 60)
            src = clean(it.get("mediaName"), 12)
            if d and t:
                items.append([d, t, s, "N", src])
        return items
    except Exception:
        return []


def one(code, name):
    ann = fetch_ann(code)
    news = fetch_news(code)
    seen, items = set(), []
    for it in ann + news:
        k = it[0] + "|" + it[1]
        if k in seen:
            continue
        seen.add(k)
        items.append(it)
    items.sort(key=lambda x: x[0], reverse=True)
    return code, name, items


def write_packs(data):
    groups = {}
    for code, (name, items) in data.items():
        groups.setdefault(code[:4], {})[code] = [name, items]
    index = {}
    total_raw = 0
    for prefix, obj in groups.items():
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        total_raw += len(raw)
        b64 = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")
        out = DATA / f"kline-news-pack-{prefix}.js"
        out.write_text("window.__KNP=window.__KNP||{};window.__KNP[\"%s\"]=\"%s\";" % (prefix, b64), encoding="utf-8")
        index[prefix] = len(obj)
    idx = DATA / "kline-news-index.js"
    idx.write_text("window.KLINE_NEWS_PACK_INDEX=%s;\n" % json.dumps(index, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    return len(groups), total_raw


def main():
    syms = load_symbols()
    print("symbols", len(syms), flush=True)
    data = {}
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(one, c, n): (c, n) for c, n in syms}
        for fut in as_completed(futs):
            code, name = futs[fut]
            try:
                c, n, items = fut.result()
                if items:
                    data[c] = (n, items)
            except Exception:
                pass
            done += 1
            if done % 200 == 0:
                print("progress", done, "packs_data", len(data), flush=True)
            time.sleep(0.01)
    packs, raw = write_packs(data)
    items = sum(len(v[1]) for v in data.values())
    print("done symbols_with_data=%d items=%d packs=%d raw=%.1fMB" % (len(data), items, packs, raw / 1048576), flush=True)


if __name__ == "__main__":
    main()
