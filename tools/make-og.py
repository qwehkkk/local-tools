#!/usr/bin/env python
"""
生成分享预览图 assets/og.png（1200x630）。

为什么需要：中文工具站的分发几乎全靠发链接 —— 微信群、V2EX、少数派、知乎。
没有 og:image 时，这些地方粘贴出来是一张纯文字卡甚至空白，点击率差一大截。

图片是**本地渲染**出来的，不依赖任何在线服务；改了文案重跑一次即可：

    python tools/make-og.py

字体用系统里的微软雅黑（本机 Windows 自带）。换机器跑不通就直接换字体路径。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "og.png")

W, H = 1200, 630
BG = (246, 247, 249)
TEXT = (26, 29, 36)
MUTED = (107, 114, 128)
ACCENT = (37, 99, 235)
ACCENT_SOFT = (239, 244, 255)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"


def font(path, size):
    if not os.path.exists(path):
        path = FONT_REG  # 没装粗体就退回常规
    return ImageFont.truetype(path, size)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 左侧一条竖色带，缩放成小图时也有辨识度
d.rectangle([0, 0, 12, H], fill=ACCENT)

# ---- 图标：和 favicon.svg 同一个锁 ----
x, y = 80, 72
d.rounded_rectangle([x, y, x + 72, y + 72], radius=16, fill=ACCENT)
d.arc([x + 22, y + 16, x + 50, y + 46], start=180, end=360, fill=(255, 255, 255), width=6)
d.rounded_rectangle([x + 18, y + 34, x + 54, y + 58], radius=6, fill=(255, 255, 255))
d.ellipse([x + 32, y + 42, x + 40, y + 50], fill=ACCENT)
d.rectangle([x + 34, y + 47, x + 38, y + 54], fill=ACCENT)

# ---- 主标题 ----
d.text((80, 196), "本地工具", font=font(FONT_BOLD, 88), fill=TEXT)
d.text((80, 310), "文件不上传，直接在浏览器里处理", font=font(FONT_REG, 38), fill=MUTED)

# ---- 三个工具 ----
labels = ["本地脱敏", "图片压缩 · 转 WebP", "PDF 合并拆分"]
cx, cy = 80, 412
f_chip = font(FONT_REG, 28)
for label in labels:
    box = d.textbbox((0, 0), label, font=f_chip)
    tw, th = box[2] - box[0], box[3] - box[1]
    pad_x, pad_y = 24, 15
    w, h = tw + pad_x * 2, th + pad_y * 2
    d.rounded_rectangle([cx, cy, cx + w, cy + h], radius=h // 2, fill=ACCENT_SOFT)
    d.text((cx + pad_x, cy + pad_y - box[1]), label, font=f_chip, fill=ACCENT)
    cx += w + 16

# ---- 底栏 ----
d.line([80, 528, 1120, 528], fill=(227, 230, 235), width=2)
d.text((80, 552), "tools.toolona.com", font=font(FONT_BOLD, 26), fill=TEXT)
d.text(
    (1120 - d.textbbox((0, 0), "上传 0 字节 · 断网可用", font=font(FONT_REG, 26))[2], 552),
    "上传 0 字节 · 断网可用",
    font=font(FONT_REG, 26),
    fill=MUTED,
)

img.save(OUT, "PNG", optimize=True)
print(f"✓ {OUT}  {img.size[0]}x{img.size[1]}  {os.path.getsize(OUT)} 字节")
