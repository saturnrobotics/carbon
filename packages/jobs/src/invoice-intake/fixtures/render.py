"""Render only synthetic fixture text to private test artifacts (Pillow, dev-only)."""
import json
from pathlib import Path
import shutil
import sys


def native_pdf(pages):
    objects = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for lines in pages:
        page_id, content_id = len(objects) + 1, len(objects) + 2
        kids.append(f"{page_id} 0 R")
        escaped = [line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in lines]
        text = ("BT /F1 10 Tf 40 760 Td 15 TL " + " ".join(f"({line}) Tj T*" for line in escaped) + " ET").encode("ascii")
        objects.extend([f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>".encode(),
                        b"<< /Length " + str(len(text)).encode() + b" >>\nstream\n" + text + b"\nendstream"])
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(kids)}] >>".encode()
    data, offsets = bytearray(b"%PDF-1.4\n"), [0]
    for index, content in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(f"{index} 0 obj\n".encode() + content + b"\nendobj\n")
    start = len(data)
    data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    data.extend("".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:]).encode())
    data.extend(f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode())
    return bytes(data)


def render(directory):
    from PIL import Image, ImageDraw, ImageFont
    fixtures = json.loads((directory / "fixtures.json").read_text())
    font = None
    for path in ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVuSans.ttf"]:
        try:
            font = ImageFont.truetype(path, 22); break
        except OSError:
            continue
    if font is None:
        raise ValueError("Install a local Arial or DejaVu Sans font for synthetic scan rendering")
    written = {}
    for fixture in fixtures:
        suffix = ".jpg" if fixture["format"] == "photo" and len(fixture["pages"]) == 1 else ".pdf"
        target = directory / (fixture["id"] + suffix)
        if fixture.get("duplicateOf"):
            shutil.copyfile(written[fixture["duplicateOf"]], target)
        elif fixture["format"] == "pdf":
            target.write_bytes(native_pdf(fixture["pages"]))
        else:
            pages = []
            for lines in fixture["pages"]:
                page = Image.new("RGB", (1650, 2200), "#fffdfa" if fixture["format"] == "photo" else "white")
                draw = ImageDraw.Draw(page)
                for index, line in enumerate(lines):
                    draw.text((70, 85 + index * 45), line, font=font, fill="#242424")
                if fixture["format"] == "photo":
                    page = page.rotate(1.2, resample=Image.Resampling.BICUBIC, expand=False, fillcolor="#d8d5ce")
                pages.append(page)
            if suffix == ".jpg":
                pages[0].save(target, "JPEG", quality=82)
            else:
                pages[0].save(target, "PDF", resolution=180, save_all=True, append_images=pages[1:])
        target.chmod(0o600)
        written[fixture["id"]] = target
    print(f"Rendered {len(fixtures)} synthetic documents")


if __name__ == "__main__":
    render(Path(sys.argv[1]))
