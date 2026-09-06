from pathlib import Path

import fitz


source = Path("attached_assets/Document_sans_titre_(1)_1788683710241.pdf")
output = Path(".agents/outputs/drimpay-payout-pages")
output.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
print(f"pages={document.page_count}")
for index, page in enumerate(document):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    target = output / f"page-{index + 1}.png"
    pixmap.save(target)
    print(target)