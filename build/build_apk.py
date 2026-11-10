# -*- coding: utf-8 -*-
"""把手机版网页打包成可安装的 Android APK。

不依赖 Gradle，直接调用 Android SDK 的 aapt2 / d8 / zipalign / apksigner。
用法：python build_apk.py
产物：kline-camp.apk（工作区根目录）
"""

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
DATA = ROOT / "data"
AND = Path(__file__).resolve().parent / "android"
BUILD = AND / "build"
ASSETS = AND / "assets"
DIST = ROOT / "dist"
OUT_APK = DIST / "天才交易员模拟器.apk"
# 复用 Android 工具链自带的调试签名证书（不新建任何密钥）
KEYSTORE = Path.home() / ".android" / "debug.keystore"
KEY_ALIAS = "androiddebugkey"

PACKAGE = "com.klinecamp.app"
MIN_SDK = "24"
TARGET_SDK = "34"

MIPMAP_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def find_sdk():
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        v = os.environ.get(key)
        if v and Path(v).is_dir():
            return Path(v)
    guess = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk"
    if guess.is_dir():
        return guess
    sys.exit("找不到 Android SDK，请设置 ANDROID_HOME")


def pick_build_tools(sdk):
    bt = sdk / "build-tools"
    if not bt.is_dir():
        sys.exit(f"缺少 build-tools：{bt}")
    versions = sorted([p for p in bt.iterdir() if (p / "aapt2.exe").exists()],
                      key=lambda p: [int(x) for x in p.name.split(".") if x.isdigit()])
    if not versions:
        sys.exit("build-tools 里没有 aapt2.exe")
    return versions[-1]


def pick_platform(sdk):
    pl = sdk / "platforms"
    for name in (f"android-{TARGET_SDK}", "android-34"):
        jar = pl / name / "android.jar"
        if jar.exists():
            return jar
    jars = sorted(pl.glob("android-*/android.jar"))
    if jars:
        return jars[-1]
    sys.exit("缺少 platforms/android-34/android.jar")


def run(cmd, desc):
    print(f"  → {desc}")
    cmd = [str(c) for c in cmd]
    if cmd[0].lower().endswith(".bat"):
        cmd = ["cmd", "/c"] + cmd
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print(r.stdout[-4000:])
        print(r.stderr[-4000:])
        sys.exit(f"失败：{desc}")


def prepare_assets():
    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    (ASSETS / "app").mkdir(parents=True)
    (ASSETS / "data").mkdir(parents=True)
    for name in ("kline-mobile.html", "kline-core.js", "kline-futures.html",
                 "kline-futures-core.js", "manifest.webmanifest"):
        src = APP / name
        if not src.exists():
            sys.exit(f"缺少 app/{name}")
        shutil.copy2(src, ASSETS / "app" / name)
    for name in ("kline-index.js", "kline-fundamentals.js", "kline-news.js",
                 "kline-news-index.js", "kline-fut-data.js"):
        src = DATA / name
        if not src.exists():
            sys.exit(f"缺少 data/{name}")
        shutil.copy2(src, ASSETS / "data" / name)
    packs = sorted(DATA.glob("kline-pack-*.js"))
    if not packs:
        sys.exit("缺少 data/kline-pack-*.js 行情分片")
    total = 0
    for p in packs:
        shutil.copy2(p, ASSETS / "data" / p.name)
        total += p.stat().st_size
    news_packs = sorted(DATA.glob("kline-news-pack-*.js"))
    for p in news_packs:
        shutil.copy2(p, ASSETS / "data" / p.name)
        total += p.stat().st_size
    icons = APP / "icons"
    if icons.is_dir():
        (ASSETS / "app" / "icons").mkdir(parents=True, exist_ok=True)
        for f in icons.iterdir():
            if f.is_file():
                shutil.copy2(f, ASSETS / "app" / "icons" / f.name)
    size = total / 1048576
    print(f"  → 已打包页面与行情数据（{len(packs)} 个分片，共 {size:.1f} MB）")


def prepare_icons():
    from PIL import Image
    src = APP / "icons" / "icon-512.png"
    if not src.exists():
        sys.exit("缺少 app/icons/icon-512.png")
    im = Image.open(src).convert("RGBA")
    for dpi, px in MIPMAP_SIZES.items():
        d = AND / "res" / f"mipmap-{dpi}"
        d.mkdir(parents=True, exist_ok=True)
        im.resize((px, px), Image.LANCZOS).save(d / "ic_launcher.png")
    print("  → 已生成各密度启动图标")


def build():
    sdk = find_sdk()
    bt = pick_build_tools(sdk)
    android_jar = pick_platform(sdk)
    java_home = os.environ.get("JAVA_HOME", "")
    javac = str(Path(java_home) / "bin" / "javac.exe") if java_home else "javac"

    print(f"SDK      : {sdk}")
    print(f"build-tools: {bt.name}")
    print(f"android.jar: {android_jar}")

    (BUILD / "classes").mkdir(parents=True, exist_ok=True)
    (BUILD / "dex").mkdir(parents=True, exist_ok=True)
    (BUILD / "gen").mkdir(parents=True, exist_ok=True)

    prepare_assets()
    prepare_icons()

    aapt2 = bt / "aapt2.exe"
    res_zip = BUILD / "res.zip"
    run([aapt2, "compile", "--dir", AND / "res", "-o", res_zip], "编译资源")
    run([aapt2, "link", "-o", BUILD / "base.apk",
         "-I", android_jar,
         "--manifest", AND / "AndroidManifest.xml",
         "-A", ASSETS,
         "--java", BUILD / "gen",
         "--min-sdk-version", MIN_SDK,
         "--target-sdk-version", TARGET_SDK,
         res_zip], "链接资源与 assets")

    java_files = [BUILD / "gen" / PACKAGE.replace(".", os.sep) / "R.java",
                  AND / "java" / PACKAGE.replace(".", os.sep) / "MainActivity.java"]
    run([javac, "-encoding", "UTF-8", "-source", "8", "-target", "8",
         "-nowarn", "-cp", android_jar, "-d", BUILD / "classes"] + java_files, "编译 Java")

    class_files = [str(p) for p in (BUILD / "classes").rglob("*.class")]
    run([str(bt / "d8.bat"), "--release", "--min-api", MIN_SDK,
         "--lib", android_jar, "--output", BUILD / "dex"] + class_files, "转换为 dex")

    unsigned = BUILD / "app-unsigned.apk"
    shutil.copy2(BUILD / "base.apk", unsigned)
    with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        z.write(BUILD / "dex" / "classes.dex", "classes.dex", compress_type=zipfile.ZIP_STORED)

    aligned = BUILD / "app-aligned.apk"
    run([bt / "zipalign.exe", "-f", "-p", "4", unsigned, aligned], "对齐 APK")

    if not KEYSTORE.exists():
        sys.exit(f"找不到调试签名证书 {KEYSTORE}")

    DIST.mkdir(parents=True, exist_ok=True)

    run([str(bt / "apksigner.bat"), "sign",
         "--ks", KEYSTORE, "--ks-key-alias", KEY_ALIAS,
         "--ks-pass", "pass:android", "--key-pass", "pass:android",
         "--min-sdk-version", MIN_SDK,
         "--out", OUT_APK, aligned], "使用调试证书签名")
    run([str(bt / "apksigner.bat"), "verify", "--min-sdk-version", MIN_SDK, OUT_APK], "校验签名")

    print(f"\n完成：{OUT_APK}  ({OUT_APK.stat().st_size / 1048576:.1f} MB)")
    print("安装：把 APK 传到手机，允许“安装未知应用”后点开安装即可。")


if __name__ == "__main__":
    build()
