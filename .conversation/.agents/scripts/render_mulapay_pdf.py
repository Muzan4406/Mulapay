from pathlib import Path
import fitz

pdf_path = Path("attached_assets/Mulapay_Cahier_des_charges_V1_1788536324871.pdf")
output_dir = Path(".agents/outputs/mulapay_pdf")
output_dir.mkdir(parents=True, exist_ok=True)

doc = fitz.open(pdf_path)
print(f"pages={doc.page_count}")
for index, page in enumerate(doc):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    output_path = output_dir / f"page-{index + 1:02d}.png"
    pixmap.save(output_path)
    print(output_path)