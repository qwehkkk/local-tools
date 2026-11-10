"""
生成 PDF 测试素材。

关键设计：每页用不同尺寸（pt），这样输出文件的页面宽高序列
就能直接反推出「页序对不对」，不用靠肉眼比对。

用法：python tools/make-pdf-fixtures.py ../.dev/fixtures
"""
import os
import sys

from PIL import Image, ImageDraw

RES = 72  # PIL 写 PDF 时按这个 dpi 换算成 pt，1px = 1pt


def page(w, h, color, label):
    """造一页：白底 + 色块 + ASCII 标签（避免中文字体依赖）"""
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w - 1, h - 1], outline=color, width=6)
    d.rectangle([w // 6, h // 4, w * 5 // 6, h // 2], fill=color)
    d.text((w // 2 - 6 * len(label), h // 2 + h // 8), label, fill="black")
    d.text((12, h - 22), f"{w}x{h}pt", fill="black")
    return im


def save_pdf(path, pages):
    first, rest = pages[0], pages[1:]
    first.save(path, "PDF", resolution=RES, save_all=True, append_images=rest)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "../.dev/fixtures"
    os.makedirs(out, exist_ok=True)

    # 1) 三页，每页尺寸都不同，方便验证顺序
    save_pdf(
        os.path.join(out, "合同-扫描件.pdf"),
        [
            page(595, 842, "#c0392b", "P1-A4"),
            page(500, 500, "#2980b9", "P2-SQUARE"),
            page(400, 600, "#27ae60", "P3-TALL"),
        ],
    )

    # 2) 两页同尺寸（模拟发票）
    save_pdf(
        os.path.join(out, "发票.pdf"),
        [
            page(420, 595, "#8e44ad", "INV-1"),
            page(420, 595, "#8e44ad", "INV-2"),
        ],
    )

    # 3) 单页
    save_pdf(os.path.join(out, "单页附件.pdf"), [page(300, 300, "#e67e22", "ONE")])

    # 4) 加密 PDF：必须被明确拒绝，不能让用户以为成功
    plain = os.path.join(out, "_plain.pdf")
    save_pdf(plain, [page(300, 200, "#7f8c8d", "SECRET")])
    try:
        from pypdf import PdfReader, PdfWriter

        w = PdfWriter()
        for p in PdfReader(plain).pages:
            w.add_page(p)
        w.encrypt("1234")
        with open(os.path.join(out, "加密.pdf"), "wb") as f:
            w.write(f)
        os.remove(plain)
        encrypted = "已生成"
    except Exception as e:  # noqa: BLE001
        encrypted = f"跳过（{e}）"

    for name in sorted(os.listdir(out)):
        p = os.path.join(out, name)
        print(f"  {os.path.getsize(p) / 1024:8.1f} KB  {name}")
    print("加密样本:", encrypted)


if __name__ == "__main__":
    main()
