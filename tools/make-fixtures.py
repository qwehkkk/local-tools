"""
生成端到端验证用的真实图片。

为什么要专门造图：颜色纯块的图会被压缩器"作弊"压到极小，
测出来的压缩率和真实照片差一个数量级，那种数据没有参考价值。
这里用「渐变 + 噪声 + 图形」模拟真实照片的熵分布。

用法：python tools/make-fixtures.py .dev/fixtures
"""
import os
import sys
import random
from PIL import Image, ImageDraw, ImageFilter, ImageFont


def gradient(w, h, c1, c2):
    """先在小图上画渐变再放大，比逐像素快几百倍。"""
    small = Image.new('RGB', (16, 16))
    p = small.load()
    for y in range(16):
        for x in range(16):
            t = (x + y) / 30.0
            p[x, y] = (
                int(c1[0] + (c2[0] - c1[0]) * t),
                int(c1[1] + (c2[1] - c1[1]) * t),
                int(c1[2] + (c2[2] - c1[2]) * t),
            )
    return small.resize((w, h), Image.BICUBIC)


def add_noise(img, sigma=26, alpha=0.14):
    noise = Image.effect_noise(img.size, sigma).convert('L')
    noise_rgb = Image.merge('RGB', (noise, noise, noise))
    return Image.blend(img, noise_rgb, alpha)


def find_font(size):
    for path in (
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\msyhbd.ttc',
        r'C:\Windows\Fonts\simhei.ttf',
        r'C:\Windows\Fonts\arial.ttf',
    ):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def photo(w, h, seed=7):
    """模拟一张有纹理的真实照片：渐变 + 噪声 + 一些形状与文字。"""
    random.seed(seed)
    img = gradient(w, h, (30, 60, 200), (240, 170, 60))
    img = add_noise(img, 30, 0.16)

    d = ImageDraw.Draw(img, 'RGBA')
    for _ in range(24):
        x = random.randint(0, w)
        y = random.randint(0, h)
        r = random.randint(int(min(w, h) * 0.03), int(min(w, h) * 0.16))
        color = (
            random.randint(0, 255),
            random.randint(0, 255),
            random.randint(0, 255),
            random.randint(40, 120),
        )
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)

    img = img.filter(ImageFilter.GaussianBlur(0.6))

    d = ImageDraw.Draw(img, 'RGBA')
    font = find_font(max(22, int(min(w, h) * 0.045)))
    d.rectangle([0, 0, w, int(h * 0.14)], fill=(0, 0, 0, 120))
    d.text((int(w * 0.04), int(h * 0.035)), 'SAMPLE PHOTO 测试图片', fill=(255, 255, 255, 235), font=font)
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else '.dev/fixtures'
    os.makedirs(out, exist_ok=True)
    made = []

    # 1. 大尺寸照片型 JPEG（主力用例：应显著变小）
    p = photo(3000, 2000, 7)
    f = os.path.join(out, 'photo-large.jpg')
    p.save(f, 'JPEG', quality=95)
    made.append(f)

    # 2. 带透明通道的 PNG（验证透明是否保留）
    w, h = 1200, 800
    png = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(png, 'RGBA')
    d.ellipse([60, 60, w - 60, h - 60], fill=(37, 99, 235, 255))
    d.rectangle([int(w * 0.3), int(h * 0.3), int(w * 0.7), int(h * 0.7)], fill=(255, 255, 255, 180))
    font = find_font(64)
    d.text((int(w * 0.33), int(h * 0.45)), '透明 PNG', fill=(20, 20, 20, 255), font=font)
    f = os.path.join(out, 'alpha.png')
    png.save(f, 'PNG')
    made.append(f)

    # 3. 已经是 WebP（验证「保持原格式」与「压不动就留原图」）
    f = os.path.join(out, 'already.webp')
    photo(900, 600, 11).save(f, 'WEBP', quality=92)
    made.append(f)

    # 4. 小尺寸 PNG（几乎压不动，用于触发「保留原图」分支）
    f = os.path.join(out, 'tiny.png')
    Image.new('RGB', (32, 32), (200, 40, 40)).save(f, 'PNG')
    made.append(f)

    # 5. 动图 GIF（验证只取第一帧、并且不崩）
    frames = []
    for i in range(4):
        fr = photo(400, 300, 20 + i)
        frames.append(fr)
    f = os.path.join(out, 'anim.gif')
    frames[0].save(f, 'GIF', save_all=True, append_images=frames[1:], duration=120, loop=0)
    made.append(f)

    # 6. 中文 + 空格文件名（验证 ZIP 内 UTF-8 文件名不乱码）
    f = os.path.join(out, '合同 扫描件.jpg')
    photo(1600, 1200, 31).save(f, 'JPEG', quality=90)
    made.append(f)

    for f in made:
        print(f'{os.path.getsize(f) / 1024:9.1f} KB  {os.path.basename(f)}')


if __name__ == '__main__':
    main()
