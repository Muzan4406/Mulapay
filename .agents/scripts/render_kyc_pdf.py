from pathlib import Path

import fitz


pdf_path = Path("attached_assets/Document_sans_titre_(2)_1788781660031.pdf")
output_dir = Path(".agents/outputs/kyc-pdf")
output_dir.mkdir(parents=True, exist_ok=True)

document = fitz.open(pdf_path)
print(f"pages={document.page_count}")
for index, page in enumerate(document):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    output_path = output_dir / f"page-{index + 1}.png"
    pixmap.save(output_path)
    print(output_path)