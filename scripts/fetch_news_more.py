# -*- coding: utf-8 -*-
"""把现有离线分片中的新闻补到每只标的最近 100 条。"""
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
NEWS = "https://search-api-web.eastmoney.com/search/jsonp"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
}
MAX_NEWS = 100
WORKERS = 8


def clean(s, limit=None):
    s = str(s or "")
    s = re.sub(r"<[^>]*>", "", s)
    s = re.sub(r"[\r\n\t]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] if limit else s


def fetch_news100(code):
    out = []
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
        m = re.search(r"^[^(]*\((.*)\)\s*$", r.text, re.S)
        if not m:
            return out
        obj = json.loads(m.group(1))
        arr = ((obj.get("result") or {}).get("cmsArticleWebOld") or [])[:MAX_NEWS]
        for it in arr:
            d = str(it.get("date") or "")[:10]
            t = clean(it.get("title"))
            s = clean(it.get("content"), 60)
            src = clean(it.get("mediaName"), 12)
            if d and t:
                out.append([d, t, s, "N", src])
    except Exception:
        pass
    return out


def load_packs():
    data = {}
    for p in sorted(DATA.glob("kline-news-pack-*.js")):
        text = p.read_text(encoding="utf-8")
        m = re.search(r'window\.__KNP\["([^"]+)"\]="([^"]+)"', text)
        if not m:
            continue
        try:
            raw = zlib.decompress(base64.b64decode(m.group(2)))
            obj = json.loads(raw.decode("utf-8"))
            for code, pack in obj.items():
                data[code] = [pack[0], pack[1]]
        except Exception:
            pass
    return data


def write_packs(data):
    groups = {}
    for code, (name, items) in data.items():
        prefix = "HK" if len(code) == 5 else code[:4]
        groups.setdefault(prefix, {})[code] = [name, items]
    index = {}
    total_raw = 0
    for prefix, obj in groups.items():
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        total_raw += len(raw)
        b64 = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")
        (DATA / f"kline-news-pack-{prefix}.js").write_text(
            "window.__KNP=window.__KNP||{};window.__KNP[\"%s\"]=\"%s\";" % (prefix, b64),
            encoding="utf-8")
        index[prefix] = len(obj)
    (DATA / "kline-news-index.js").write_text(
        "window.KLINE_NEWS_PACK_INDEX=%s;\n" % json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    return len(groups), total_raw


def main():
    data = load_packs()
    print("codes", len(data), flush=True)
    done = 0

    def one(code):
        name, items = data[code]
        anns = [x for x in items if x[3] != "N"]
        news = [x for x in items if x[3] == "N"]
        seen = {x[0] + "|" + x[1] for x in news}
        for it in fetch_news100(code):
            k = it[0] + "|" + it[1]
            if k not in seen:
                seen.add(k)
                news.append(it)
        news.sort(key=lambda x: x[0], reverse=True)
        return code, anns + news[:MAX_NEWS]

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(one, c): c for c in data}
        for fut in as_completed(futs):
            c = futs[fut]
            try:
                code, items = fut.result()
                data[code][1] = items
            except Exception:
                pass
            done += 1
            if done % 200 == 0:
                print("progress", done, flush=True)
            time.sleep(0.01)
    packs, raw = write_packs(data)
    items = sum(len(v[1]) for v in data.values())
    print("done items=%d packs=%d raw=%.1fMB" % (items, packs, raw / 1048576), flush=True)


if __name__ == "__main__":
    main()
