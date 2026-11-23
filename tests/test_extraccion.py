"""Contrato de extraer_texto_pdf con pypdfium2: (texto, páginas), guiones normalizados."""
from monitor_licitaciones.ingesta import _GUIONES_PDFIUM, extraer_texto_pdf


def pdf_minimo(paginas: list[str]) -> bytes:
    """PDF válido con una línea de texto por página (Helvetica), armado a mano."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for t in paginas:
        flujo = f"BT /F1 12 Tf 72 720 Td ({t}) Tj ET".encode("latin-1")
        objs.append(f"<< /Length {len(flujo)} >>\nstream\n{flujo.decode('latin-1')}\nendstream")
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>")
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offs).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def test_extrae_texto_y_paginas():
    texto, paginas = extraer_texto_pdf(pdf_minimo(["Llamado - Licitacion Publica N 401-0001-LPU25", "EX- 2026-1-GCABA"]))
    assert paginas == 2
    assert "401-0001-LPU25" in texto and "EX- 2026-1-GCABA" in texto
    assert "\r" not in texto


def test_guiones_de_pdfium_se_normalizan():
    assert "EX­ 2026 ad￾\njudica\u0002".translate(_GUIONES_PDFIUM) == "EX- 2026 ad-\njudica-"
