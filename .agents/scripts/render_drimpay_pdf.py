from pathlib import Path
import fitz

source = Path("attached_assets/Document_sans_titre_1788592799948.pdf")
output = Path(".agents/outputs/drimpay-pdf")
output.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
for page_number, page in enumerate(document, start=1):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    pixmap.save(output / f"page-{page_number:02d}.png")

print(f"Rendered {len(document)} pages to {output}")