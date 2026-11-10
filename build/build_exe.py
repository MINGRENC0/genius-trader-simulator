# -*- coding: utf-8 -*-
"""把桌面版网页打包成 Windows 单文件程序（天才交易员模拟器.exe）。

不依赖第三方库，直接用系统自带的 .NET Framework csc.exe 编译，
页面与 33MB 行情数据作为资源嵌入 exe，运行时从内存读取。
用法：python build_exe.py
产物：天才交易员模拟器.exe（工作区根目录）
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
DATA = ROOT / "data"
DESK = Path(__file__).resolve().parent / "desktop"
BUILD = DESK / "build"
DIST = ROOT / "dist"
EXE_NAME = "天才交易员模拟器.exe"

CSC = Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe")

# 嵌入 exe 的资源：源文件 → 资源名（资源名即网页里的相对路径）
RESOURCES = [
    ("app/kline-training.html", "app/kline-training.html"),
    ("app/kline-mobile.html", "app/kline-mobile.html"),
    ("app/kline-core.js", "app/kline-core.js"),
    ("app/kline-futures.html", "app/kline-futures.html"),
    ("app/kline-futures-core.js", "app/kline-futures-core.js"),
    ("app/manifest.webmanifest", "app/manifest.webmanifest"),
    ("data/kline-index.js", "data/kline-index.js"),
    ("data/kline-fundamentals.js", "data/kline-fundamentals.js"),
    ("data/kline-news.js", "data/kline-news.js"),
    ("data/kline-news-index.js", "data/kline-news-index.js"),
    ("data/kline-fut-data.js", "data/kline-fut-data.js"),
    ("app/icons/icon-192.png", "app/icons/icon-192.png"),
    ("app/icons/icon-512.png", "app/icons/icon-512.png"),
]
# 全市场行情按分片嵌入
for _p in sorted(DATA.glob("kline-pack-*.js")):
    RESOURCES.append(("data/" + _p.name, "data/" + _p.name))
# 全市场离线公告/新闻按分片嵌入
for _p in sorted(DATA.glob("kline-news-pack-*.js")):
    RESOURCES.append(("data/" + _p.name, "data/" + _p.name))


def find_csc():
    if CSC.exists():
        return CSC
    for p in Path(os.environ.get("WINDIR", r"C:\Windows")).rglob("csc.exe"):
        return p
    sys.exit("找不到 csc.exe（需要 .NET Framework 4.x）")


def make_icon(out_ico):
    from PIL import Image
    src = APP / "icons" / "icon-512.png"
    if not src.exists():
        sys.exit("缺少 app/icons/icon-512.png")
    im = Image.open(src).convert("RGBA")
    im.save(out_ico, format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"  → 已生成程序图标 {out_ico.name}")


def compile_exe(csc, target, out_file, icon=None):
    args = [str(csc), "/nologo", "/codepage:65001", "/optimize+",
            "/platform:anycpu", "/target:" + target,
            "/r:System.dll", "/r:System.Core.dll",
            "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll"]
    if icon is not None:
        args.append("/win32icon:" + str(icon))
    for src, name in RESOURCES:
        path = ROOT / src
        if not path.exists():
            sys.exit(f"缺少 {src}")
        args.append("/resource:" + str(path) + "," + name)
    args += ["/out:" + str(out_file), str(DESK / "KlineCamp.cs")]

    print(f"  → 编译 {out_file.name}")
    # 资源分片较多，命令行会超过 Windows 上限，改用 csc 响应文件
    rsp = BUILD / (out_file.stem + ".rsp")
    lines = []
    for a in args[1:]:
        lines.append('"' + a + '"' if ' ' in a else a)
    rsp.write_text("\n".join(lines), encoding="ascii", errors="ignore")
    r = subprocess.run([str(csc), "@" + str(rsp)], capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print(r.stdout[-4000:])
        print(r.stderr[-4000:])
        sys.exit("编译失败")
    for line in (r.stdout or "").splitlines():
        if "error" in line.lower():
            print("   ", line)


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    csc = find_csc()
    print(f"csc: {csc}")

    ico = BUILD / "app.ico"
    make_icon(ico)

    # 1) 便于自动测试的控制台版本
    compile_exe(csc, "exe", BUILD / "KlineCampTest.exe")

    # 2) 交付用的无控制台窗口版本
    final = BUILD / "KlineCamp.exe"
    compile_exe(csc, "winexe", final, icon=ico)

    out = DIST / EXE_NAME
    DIST.mkdir(parents=True, exist_ok=True)
    shutil.copy2(final, out)
    size = out.stat().st_size / 1048576
    print(f"\n完成：{out}  ({size:.1f} MB)")
    print("双击即可运行；数据已内置，无需联网、无需命令行。")


if __name__ == "__main__":
    main()
