"""生成「天才交易员模拟器」应用图标（多尺寸 PNG）。

设计：深夜蓝渐变底 + 淡网格；三根逐级抬高的红色阳线（A 股红涨）
+ 金色上扬趋势线 + 金色四角星（“天才/灵感”），整体保持在小尺寸下可辨识。
用法：python scripts/make_icons.py
产物：app/icons/icon-512.png、icon-192.png、icon-180.png、icon-167.png
"""
import os
from PIL import Image, ImageDraw, ImageFilter

S = 2048  # 先大图绘制再降采样，边缘更干净
ICON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "icons")

BG_TOP = (14, 23, 38)
BG_BOTTOM = (6, 10, 17)
UP = (246, 70, 93)
GOLD = (245, 197, 66)


def lerp(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def vertical_gradient(size):
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        px[0, y] = lerp(BG_TOP, BG_BOTTOM, y / (size - 1))
    return img.resize((size, size), Image.BILINEAR)


def radial_glow(size, center, radius, color, alpha):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center
    steps = 26
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(alpha * (1 - i / steps) ** 1.6)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (a,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.12))


def star_points(cx, cy, outer, inner, rotate=0.0):
    import math
    pts = []
    for i in range(8):
        ang = math.pi / 4 * i - math.pi / 2 + rotate
        r = outer if i % 2 == 0 else inner
        pts.append((cx + math.cos(ang) * r, cy + math.sin(ang) * r))
    return pts


def build():
    img = vertical_gradient(S).convert("RGBA")

    # 两处环境光
    img.alpha_composite(radial_glow(S, (S * 0.18, S * 0.12), S * 0.55, (36, 92, 160), 90))
    img.alpha_composite(radial_glow(S, (S * 0.88, S * 0.92), S * 0.50, (24, 130, 110), 55))

    d = ImageDraw.Draw(img, "RGBA")

    # 淡网格
    step = S // 10
    for i in range(1, 10):
        p = i * step
        d.line([(0, p), (S, p)], fill=(27, 36, 50, 42), width=3)
        d.line([(p, 0), (p, S)], fill=(27, 36, 50, 30), width=3)

    # 主体图形画在独立图层，最后整体收进 80% 安全区（适配 Android 圆形蒙版）
    logo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(logo, "RGBA")

    # 金色趋势线（在K线后面）
    ld.line([(S * 0.235, S * 0.790), (S * 0.700, S * 0.320)], fill=(255, 205, 96, 105),
            width=int(S * 0.012))

    # 三根阳线，逐级抬高（A股红涨）
    candles = [
        (0.300, 0.640, 0.760, 0.605, 0.795),
        (0.500, 0.480, 0.610, 0.440, 0.650),
        (0.700, 0.315, 0.455, 0.275, 0.500),
    ]
    body_w = S * 0.088
    for cx, top, bottom, wick_top, wick_bottom in candles:
        x = cx * S
        ld.line([(x, wick_top * S), (x, wick_bottom * S)], fill=UP, width=int(S * 0.020))
        ld.rounded_rectangle(
            [x - body_w / 2, top * S, x + body_w / 2, bottom * S],
            radius=int(S * 0.016), fill=UP,
        )

    # 顶部金色四角星 + 小星
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.polygon(star_points(S * 0.745, S * 0.215, S * 0.100, S * 0.023), fill=GOLD + (255,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.026))
    logo.alpha_composite(glow)
    ld.polygon(star_points(S * 0.745, S * 0.215, S * 0.100, S * 0.023), fill=(255, 226, 132, 255))
    ld.polygon(star_points(S * 0.745, S * 0.215, S * 0.054, S * 0.012), fill=(255, 246, 214, 255))
    ld.polygon(star_points(S * 0.580, S * 0.135, S * 0.034, S * 0.008), fill=GOLD + (230,))

    # 收进安全区
    scale = 0.86
    small = logo.resize((int(S * scale), int(S * scale)), Image.LANCZOS)
    img.alpha_composite(small, ((S - small.width) // 2, (S - small.height) // 2))

    # 内描边：让图标在浅色背景上也有边界
    d.rounded_rectangle([2, 2, S - 3, S - 3], radius=int(S * 0.045),
                        outline=(80, 110, 150, 70), width=4)

    return img


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    img = build()
    for size in (512, 192, 180, 167):
        out = os.path.join(ICON_DIR, f"icon-{size}.png")
        img.resize((size, size), Image.LANCZOS).save(out, "PNG", optimize=True)
        print(f"  → {out}")


if __name__ == "__main__":
    main()
