# K线训练营

真实 A 股 / 港股通 / ETF / 期货历史日 K 盲测交易训练器，纯前端页面 + 本地数据分片。

## 入口

| 端 | 文件 |
| --- | --- |
| A 股桌面 | `app/kline-training.html` |
| A 股手机 | `app/kline-mobile.html` |
| 期货 | `app/kline-futures.html` |

直接双击 HTML 即可使用。也可运行 `python scripts/serve.py`，再访问：

- 电脑：`http://127.0.0.1:8000/app/kline-training.html`
- 手机：`http://<本机局域网IP>:8000/app/kline-mobile.html`

## 目录

```
app/        页面、核心 JS、图标、manifest
data/       行情/消息分片与索引（legacy/ 为旧版单文件数据）
build/      build_apk.py、build_exe.py、android/、desktop/
scripts/    行情/消息抓取脚本、本地服务
docs/       spec.md、tasks.md
dist/       APK 与 exe 产物
sw.js       PWA 离线缓存（仅 Web 端）
```

## 打包

```powershell
python build/build_apk.py   # → dist/kline-camp.apk
python build/build_exe.py   # → dist/K线训练营.exe
```

## 数据

- 行情：`data/kline-index.js` + `data/kline-pack-*.js`（235 个分片）
- 消息：`data/kline-news-index.js` + `data/kline-news-pack-*.js`（227 个分片，覆盖 6,967 个代码）
- 期货：`data/kline-fut-data.js`

行情与消息均按代码懒加载，断网可用；离线消息为各标的近期公告与新闻，不是全历史。
