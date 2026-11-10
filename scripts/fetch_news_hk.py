# -*- coding: utf-8 -*-
"""补充港股离线公告/新闻分片（kline-news-pack-HK.js）。"""
import json
import re
import zlib
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from fetch_news_all import DATA, IDX, one


def main():
    text = IDX.read_text(encoding="utf-8")
    arr = json.loads(text[text.index("["):].strip().rstrip(";"))
    hk = [(str(x["c"]), str(x["n"])) for x in arr if len(str(x["c"])) == 5]
    print("hk symbols", len(hk), flush=True)
    data = {}
    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(one, c, n): (c, n) for c, n in hk}
        for fut in as_completed(futs):
            code, name = futs[fut]
            try:
                c, n, items = fut.result()
                if items:
                    data[c] = [n, items]
            except Exception:
                pass
            done += 1
            if done % 100 == 0:
                print("progress", done, "with_data", len(data), flush=True)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    b64 = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")
    (DATA / "kline-news-pack-HK.js").write_text(
        "window.__KNP=window.__KNP||{};window.__KNP[\"HK\"]=\"%s\";" % b64, encoding="utf-8")
    idx_path = DATA / "kline-news-index.js"
    text = idx_path.read_text(encoding="utf-8")
    m = re.search(r"window\.KLINE_NEWS_PACK_INDEX=(\{.*\});", text, re.S)
    idx = json.loads(m.group(1)) if m else {}
    idx["HK"] = len(data)
    idx_path.write_text("window.KLINE_NEWS_PACK_INDEX=%s;\n" %
                        json.dumps(idx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("done hk with_data=%d items=%d raw=%.1fMB" %
          (len(data), sum(len(v[1]) for v in data.values()), len(raw) / 1048576), flush=True)


if __name__ == "__main__":
    main()
