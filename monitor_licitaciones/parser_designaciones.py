"""Extracción de funcionarios de normas de designación, renuncia y cese.

De cada mención de una persona con documento se obtiene: nombre, DNI, CUIL, movimiento
(designa | renuncia | cese | antecedente), cargo y fecha de vigencia si figura.

- Los considerandos ("Que por Decreto N° 466/19 fue designado...") se marcan como
  'antecedente': confirman identidad y cargo previo pero no son el acto de esta norma.
- Las designaciones que vienen en un anexo (tabla aparte del PDF principal) no se ven:
  el texto descargado es solo el de la norma.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Optional

PARSER_DESIGNACIONES_VERSION = "1.1.0"

_MESES = {m: i for i, m in enumerate(
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split(), 1)}
_MESES["setiembre"] = 9

_LETRA = "A-Za-zÁÉÍÓÚÑÀÈÌÒÙÜáéíóúñàèìòùü'´"
_PALABRA = rf"[A-ZÁÉÍÓÚÑ][{_LETRA}]+"
_NOMBRE_ANTES = re.compile(
    rf"((?:{_PALABRA}|[A-ZÁÉÍÓÚÑ]\.)(?:\s+(?:de\s+la|de\s+los|del|de|y)\s+(?:{_PALABRA})|\s+(?:{_PALABRA}|[A-ZÁÉÍÓÚÑ]\.)){{1,7}})"
    r"\s*,?\s*\(?\s*$")
_TITULOS = re.compile(r"^(?:(?:Sr|Sra|Srta|Dr|Dra|Lic|Cdor|Cdora|Cr|Cra|Ing|Arq|Prof|Mg|Abog|Esc)\.?\s+)+", re.I)
_NO_NOMBRE = {"Decreto", "Resolución", "Resolucion", "Disposición", "Ley", "Artículo", "Articulo", "Que",
              "Ciudad", "Gobierno", "Autónoma", "Buenos", "Aires", "Ministerio", "Dirección", "General"}

_DOC = re.compile(r"\b(?:D\.?\s?N\.?\s?I\.?|L\.?\s?E\.?|L\.?\s?C\.?|documento(?:\s+nacional\s+de\s+identidad)?)"
                  r"\s*(?:N\s*[°ºo°]\.?|Nro\.?|n[uú]mero)?\s*:?\s*(\d{1,2}\.?\d{3}\.?\d{3})\b", re.I)
_CUIL = re.compile(r"\bC\.?\s?U\.?\s?I\.?\s?[LT]\.?\s*(?:N\s*[°ºo]\.?|Nro\.?)?\s*:?\s*(\d{2})\s?[-‐–.]?\s?(\d{8})\s?[-‐–.]?\s?(\d)\b",
                   re.I)
_RESOLUTIVA = re.compile(r"\b(?:DECRETA|RESUELVE|RESUELVEN|DISPONE|DISPONEN|ORDENA)\s*:", re.I)
_DESIGNA = re.compile(r"des[ií]gn(?:a|ase|ese|ar|an|ó)|nombr(?:a|ase|ar)|encom[ie][eé]?nd|asígnase|asignar las funciones|"
                     r"enc[aá]rg(?:a|ase|ar)", re.I)
_RENUNCIA = re.compile(r"renuncia", re.I)
_CESE = re.compile(r"\bces(?:a|e|ase|ar)\b|lim[ií]ta(?:se)?|d[ée]jase sin efecto|dejar sin efecto|desafect|"
                   r"dar(?:se)? por (?:finalizad|conclu)|finaliz", re.I)
_CARGO = re.compile(r"\b(?:como|en el cargo de|al cargo de|en la funci[oó]n de|a cargo de)\s+(.{5,220}?)(?=[.;]\s|,\s*(?:a partir|con|de la Ciudad|en el [aá]mbito|reteniendo|quien)|\s+a partir|$)",
                    re.I | re.S)
_FECHA = re.compile(r"a partir del?\s+(?:d[ií]a\s+)?(\d{1,2})\s*(?:°|º)?\s+de\s+(\w+)\s+de\s+(\d{4})|a partir del?\s+(\d{1,2})/(\d{1,2})/(\d{2,4})",
                    re.I)

# El nivel se decide por el PUESTO (las primeras palabras del cargo), no por cualquier palabra del texto:
# "Gerente Operativo de la Gerencia X de la Subsecretaría Y" es gerente, no subsecretario.
_PREFIJO_CARGO = re.compile(r"^(?:(?:el|la|los|las)\s+)?(?:cargo\s+de\s+)?(?:titular\s+(?:de\s+la|del)\s+)?", re.I)
NIVELES = [  # (nivel, regex anclada al comienzo del cargo)
    (1, r"ministr[oa]\b(?! p[uú]blico)|jef[ea] de gabinete|vicejef[ea]|jef[ea] de gobierno"),
    (2, r"secretari[oa]\b(?! (?:letrad|de juzgado|privad|administrativ))|administrador[a]? gubernamental|"
        r"president[ea]|vicepresident|director[a]?\s+(?:titular|suplente)|s[ií]ndic|procurador|"
        r"(?:titular|director[a]? ejecutiv[oa]) de(?:l| la) (?:ente|organismo|agencia|instituto|unidad|administraci)"),
    (3, r"subsecretari[oa]"),
    (4, r"director[a]? general|director[a]? ejecutiv|subdirector[a]? general"),
    (5, r"gerente\b"),
]
_NIVELES = [(n, re.compile(rx, re.I)) for n, rx in NIVELES]
_CARGO_EN_SUMARIO = re.compile(r"\bcomo\s+(.{5,200}?)(?:\s+(?:a|al|a la)\s+[A-ZÁÉÍÓÚÑ]|\s+presentada|\s+(?:a\s+)?partir|[,;.]\s|$)")


def nivel_de(cargo: Optional[str]) -> Optional[int]:
    if not cargo:
        return None
    c = _PREFIJO_CARGO.sub("", cargo.strip())
    for n, rx in _NIVELES:
        if rx.match(c):
            return n
    return None


def _en_sumario(nombre: str, sumario: Optional[str]) -> bool:
    """El sumario nombra a esta persona (por su último apellido)."""
    import unicodedata
    def norm(x: str) -> str:
        return unicodedata.normalize("NFKD", x).encode("ascii", "ignore").decode().lower()
    ultimo = norm(nombre.split()[-1]) if nombre.split() else ""
    return len(ultimo) > 2 and ultimo in norm(sumario or "")


def _cargo_valido(cargo: Optional[str]) -> bool:
    return bool(cargo) and nivel_de(cargo) is not None


@dataclass
class Mencion:
    apellido_nombre: str
    numero_documento: Optional[str]
    cuil: Optional[str]
    movimiento: str                    # designa | renuncia | cese | antecedente | otro
    parte: str                         # resolutiva | considerandos
    cargo: Optional[str] = None
    nivel: Optional[int] = None
    vigencia_desde: Optional[date] = None


@dataclass
class Resultado:
    menciones: list[Mencion] = field(default_factory=list)
    parser_version: str = PARSER_DESIGNACIONES_VERSION

    def como_dict(self):
        return asdict(self)


def _plano(texto: str) -> str:
    t = re.sub(r"[ \t]+", " ", texto or "")
    t = re.sub(r"-\n(?=[a-záéíóúñ])", "", t)
    return re.sub(r"\s*\n\s*", " ", t)


def _nombre_antes(plano: str, pos: int) -> Optional[str]:  # noqa: C901
    previo = plano[max(0, pos - 160):pos]
    previo = re.sub(r"\s*(?:,|\(|–|-)\s*$", "", previo)
    m = _NOMBRE_ANTES.search(previo)
    if not m:
        return None
    nombre = _TITULOS.sub("", m.group(1).strip())
    palabras = nombre.split()
    # recortar palabras institucionales que quedaron pegadas adelante ("Decreto Juan Pérez")
    while palabras and palabras[0].strip(",.") in _NO_NOMBRE:
        palabras.pop(0)
    if len([p for p in palabras if len(p) > 2]) < 2:
        return None
    return " ".join(palabras)


def _fecha(fragmento: str) -> Optional[date]:
    m = _FECHA.search(fragmento)
    if not m:
        return None
    try:
        if m.group(1):
            mes = _MESES.get(m.group(2).lower())
            return date(int(m.group(3)), mes, int(m.group(1))) if mes else None
        anio = int(m.group(6))
        return date(anio + 2000 if anio < 100 else anio, int(m.group(5)), int(m.group(4)))
    except ValueError:
        return None


def _movimiento(oracion: str) -> str:
    if _RENUNCIA.search(oracion):
        return "renuncia"
    if _CESE.search(oracion) and not _DESIGNA.search(oracion[:60]):
        return "cese"
    if _DESIGNA.search(oracion):
        return "designa"
    if _CESE.search(oracion):
        return "cese"
    return "otro"


def parsear_designacion(texto: str, sumario: Optional[str] = None) -> Resultado:
    plano = _plano(texto)
    # cargo del sumario: limpio y sin encabezados de página; se usa cuando el del texto no es un puesto reconocible
    ms = _CARGO_EN_SUMARIO.search(sumario or "")
    cargo_sumario = ms.group(1).strip(" ,.") if ms and _cargo_valido(ms.group(1)) else None
    m_res = _RESOLUTIVA.search(plano)
    corte = m_res.end() if m_res else 0
    res = Resultado()
    vistos: dict[tuple, Mencion] = {}
    anclas = [(m.start(), m.end(), re.sub(r"\D", "", m.group(1)), None) for m in _DOC.finditer(plano)]
    for m in _CUIL.finditer(plano):
        cuil = "".join(m.groups())
        anclas.append((m.start(), m.end(), cuil[2:10].lstrip("0"), cuil))
    anclas.sort()
    for ini, fin, dni, cuil in anclas:
        dni = dni.lstrip("0")
        if not dni or len(dni) < 6:
            continue
        # el nombre está antes del primer documento de la mención (DNI y CUIL suelen ir juntos)
        previo_doc = [a for a in anclas if a[1] <= ini and ini - a[1] < 30 and a[2].lstrip("0") == dni]
        pos_nombre = previo_doc[0][0] if previo_doc else ini
        nombre = _nombre_antes(plano, pos_nombre)
        clave = (dni,)
        parte = "resolutiva" if ini >= corte and corte else "considerandos"
        # oración: desde el último "Artículo"/punto antes de la mención hasta el siguiente punto
        a0 = max(plano.rfind("Artículo", 0, ini), plano.rfind("ARTÍCULO", 0, ini), plano.rfind("Art.", 0, ini),
                 plano.rfind("Art ", 0, ini))
        if a0 < 0 or ini - a0 > 800:
            a0 = max(0, ini - 300)
        a1 = plano.find(". ", fin)
        a1 = len(plano) if a1 < 0 else a1
        oracion = plano[a0:a1 + 1]
        mov = _movimiento(oracion) if parte == "resolutiva" else "antecedente"
        mc = _CARGO.search(plano, fin, min(len(plano), fin + 400))
        cargo = re.sub(r"\s+", " ", mc.group(1)).strip(" ,.") if mc else None
        if not _cargo_valido(cargo) and cargo_sumario and nombre and _en_sumario(nombre, sumario):
            cargo = cargo_sumario
        if clave in vistos:
            prev = vistos[clave]
            if cuil and not prev.cuil:
                prev.cuil = cuil
            if parte == "resolutiva" and prev.parte == "considerandos":   # la resolutiva manda
                prev.parte, prev.movimiento = parte, mov
                prev.cargo = cargo or prev.cargo
                prev.nivel = nivel_de(prev.cargo)
                prev.vigencia_desde = _fecha(oracion) or prev.vigencia_desde
            if nombre and not prev.apellido_nombre:
                prev.apellido_nombre = nombre
            continue
        men = Mencion(apellido_nombre=nombre or "", numero_documento=dni, cuil=cuil, movimiento=mov, parte=parte,
                      cargo=cargo, nivel=nivel_de(cargo), vigencia_desde=_fecha(oracion))
        vistos[clave] = men
        res.menciones.append(men)
    return res
