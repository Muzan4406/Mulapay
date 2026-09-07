import fitz
from pathlib import Path

pdf = fitz.open('attached_assets/AshtechPay_API_Direct_v1_1788630038610.pdf')
out = Path('.agents/outputs/ashtechpay-webhook-pages')
out.mkdir(parents=True, exist_ok=True)
for page_number in (11, 12):
    page = pdf[page_number - 1]
    pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    pix.save(out / f'page-{page_number}.png')
print(f'rendered {len((11, 12))} pages to {out}')
