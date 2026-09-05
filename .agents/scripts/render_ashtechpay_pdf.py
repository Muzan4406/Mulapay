from pathlib import Path

import fitz


source = Path("attached_assets/AshtechPay_API_Direct_v1_1788630038610.pdf")
output = Path(".agents/outputs/ashtechpay-pages")
output.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
for index, page in enumerate(document):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    pixmap.save(output / f"page-{index + 1:02d}.png")

print(f"rendered {len(document)} pages to {output}")