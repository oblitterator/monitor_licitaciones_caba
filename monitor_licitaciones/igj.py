"""Carga del dataset "Entidades constituidas en la IGJ" (datos.jus.gob.ar).

El zip trae, por cada corte mensual AAAAMM, cinco CSV: entidades, autoridades, domicilios,
balances y asambleas. Los cortes se cargan en orden cronológico. Cada tabla guarda el
primer y último corte en que se vio cada fila: las autoridades y socios que dejan de
aparecer quedan con ultimo_corte < corte vigente.
"""
from __future__ import annotations

import csv
import io
import logging
import re
import zipfile
from pathlib import Path
from typing import Iterator, Optional

import psycopg

from .db import Ejecucion

log = logging.getLogger(__name__)

_ARCHIVO = re.compile(r"igj-(entidades|autoridades|domicilios|balances|asambleas)-(\d{6})\.csv$")
_DOC = {"DOCUMENTO NACIONAL DE IDENTIDAD": "DNI", "LIBRETA DE ENROLAMIENTO": "LE", "LIBRETA CIVICA": "LC",
        "CEDULA DE IDENTIDAD": "CI", "PASAPORTE": "PASAPORTE"}


def _fecha(v: str) -> Optional[str]:
    v = (v or "").strip()
    if len(v) == 8 and v.isdigit() and v[:4] != "0000" and v[4:6] != "00" and v[6:] != "00":
        return f"{v[:4]}-{v[4:6]}-{v[6:]}"
    return None


def _num(v: str) -> Optional[str]:
    v = (v or "").strip().replace(".", "").replace(",", ".")
    try:
        float(v)
        return v
    except ValueError:
        return None


def _doc(v: str) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", v or "").upper()


def cortes(zip_path: Path) -> dict[int, dict[str, str]]:
    """{periodo: {tabla: nombre_en_zip}} ordenado por periodo."""
    out: dict[int, dict[str, str]] = {}
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            m = _ARCHIVO.search(n)
            if m:
                out.setdefault(int(m.group(2)), {})[m.group(1)] = n
    return dict(sorted(out.items()))


def _filas(z: zipfile.ZipFile, nombre: str) -> Iterator[dict]:
    with z.open(nombre) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


# (tabla destino, columnas staging, extractor de fila, clave, columnas a actualizar)
def _entidades(r):
    cuit = re.sub(r"\D", "", r.get("cuit") or "")
    return (r["numero_correlativo"], r.get("descripcion_tipo_societario"), (r.get("razon_social") or "").strip(),
            cuit if len(cuit) == 11 else None, bool((r.get("dada_de_baja") or "").strip()),
            (r.get("detalle_baja") or "").strip() or None)


def _autoridades(r):
    nro = _doc(r.get("numero_documento"))
    if not nro:
        return None
    tipo = _DOC.get((r.get("descripcion_tipo_documento") or "").strip().upper(), "OTROS")
    return (r["numero_correlativo"], (r.get("descripcion_tipo_administrador") or "").strip().upper(), tipo, nro,
            (r.get("apellido_nombre") or "").strip(), (r.get("genero_autoridad") or "").strip() or None)


def _domicilios(r):
    return (r["numero_correlativo"], (r.get("descripcion_tipo_domicilio") or "").strip(), (r.get("calle") or "").strip(),
            (r.get("numero") or "").strip(), (r.get("localidad") or "").strip() or None,
            (r.get("provincia") or "").strip() or None, (r.get("codigo_postal") or "").strip() or None)


def _balances(r):
    fb = _fecha(r.get("fecha_balance"))
    return (r["numero_correlativo"], fb, _fecha(r.get("fecha_presentacion")), _num(r.get("capital_informado"))) if fb else None


def _asambleas(r):
    fr = _fecha(r.get("fecha_realizacion"))
    return (r["numero_correlativo"], (r.get("descripcion_tipo_asamblea") or "").strip(), fr,
            _fecha(r.get("fecha_presentacion"))) if fr else None


TABLAS = {
    "entidades": ("igj.entidad", ["numero_correlativo bigint", "tipo_societario text", "razon_social text", "cuit bigint",
                                  "dada_de_baja boolean", "detalle_baja text"], _entidades,
                  ["numero_correlativo"], ["tipo_societario", "razon_social", "cuit", "dada_de_baja", "detalle_baja"]),
    "autoridades": ("igj.autoridad", ["numero_correlativo bigint", "rol text", "tipo_documento text",
                                      "numero_documento text", "apellido_nombre text", "genero text"], _autoridades,
                    ["numero_correlativo", "rol", "tipo_documento", "numero_documento"], ["apellido_nombre", "genero"]),
    "domicilios": ("igj.domicilio", ["numero_correlativo bigint", "tipo_domicilio text", "calle text", "numero text",
                                     "localidad text", "provincia text", "codigo_postal text"], _domicilios,
                   ["numero_correlativo", "tipo_domicilio", "calle", "numero"], ["localidad", "provincia", "codigo_postal"]),
    "balances": ("igj.balance", ["numero_correlativo bigint", "fecha_balance date", "fecha_presentacion date",
                                 "capital_informado numeric"], _balances,
                 ["numero_correlativo", "fecha_balance"], ["fecha_presentacion", "capital_informado"]),
    "asambleas": ("igj.asamblea", ["numero_correlativo bigint", "tipo_asamblea text", "fecha_realizacion date",
                                   "fecha_presentacion date"], _asambleas,
                  ["numero_correlativo", "tipo_asamblea", "fecha_realizacion"], ["fecha_presentacion"]),
}


def _cargar_tabla(conn: psycopg.Connection, z: zipfile.ZipFile, tabla: str, nombre: str, periodo: int) -> int:
    destino, cols, extraer, clave, actualizar = TABLAS[tabla]
    nombres = [c.split()[0] for c in cols]
    with conn.cursor() as cur:
        cur.execute(f"CREATE TEMP TABLE stg ({', '.join(cols)}) ON COMMIT DROP")
        n = 0
        with cur.copy(f"COPY stg ({', '.join(nombres)}) FROM STDIN") as cp:
            for r in _filas(z, nombre):
                fila = extraer(r)
                if fila is not None:
                    cp.write_row(fila)
                    n += 1
        k = ", ".join(clave)
        extra = ""
        if tabla == "autoridades":
            # variantes de nombre de la misma persona en la misma entidad y rol
            cur.execute(f"""CREATE TEMP TABLE stg2 ON COMMIT DROP AS
                            SELECT {k}, max(apellido_nombre) AS apellido_nombre, max(genero) AS genero,
                                   count(DISTINCT apellido_nombre) AS nombres_variantes
                            FROM stg GROUP BY {k}""")
            fuente, extra_cols, extra_vals = "stg2", ", nombres_variantes", ", s.nombres_variantes"
            extra = ", nombres_variantes = EXCLUDED.nombres_variantes"
        else:
            fuente, extra_cols, extra_vals = (f"(SELECT DISTINCT ON ({k}) * FROM stg ORDER BY {k})", "", "")
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in actualizar)
        cur.execute(f"""INSERT INTO {destino} ({', '.join(nombres)}{extra_cols}, primer_corte, ultimo_corte)
                        SELECT {', '.join('s.' + c for c in nombres)}{extra_vals}, %(p)s, %(p)s FROM {fuente} s
                        ON CONFLICT ({k}) DO UPDATE SET {sets}{extra},
                           primer_corte = least({destino}.primer_corte, EXCLUDED.primer_corte),
                           ultimo_corte = greatest({destino}.ultimo_corte, EXCLUDED.ultimo_corte)""",
                    {"p": periodo})
    return n


def cargar(conn: psycopg.Connection, ej: Optional[Ejecucion], zip_path: Path, archivo_id: Optional[int] = None,
           forzar: bool = False) -> dict[int, dict[str, int]]:
    """Carga todos los cortes del zip que no estén cargados (o todos si forzar)."""
    resumen: dict[int, dict[str, int]] = {}
    with conn.cursor() as cur:
        cur.execute("SELECT periodo FROM igj.corte")
        ya = {r[0] for r in cur.fetchall()}
    with zipfile.ZipFile(zip_path) as z:
        for periodo, archivos in cortes(zip_path).items():
            if periodo in ya and not forzar:
                log.info("corte %s ya cargado", periodo)
                continue
            filas = {}
            for tabla in TABLAS:
                if tabla in archivos:
                    log.info("corte %s: %s", periodo, tabla)
                    filas[tabla] = _cargar_tabla(conn, z, tabla, archivos[tabla], periodo)
                    conn.commit()
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO igj.corte (periodo, archivo_id, filas) VALUES (%s, %s, %s)
                               ON CONFLICT (periodo) DO UPDATE SET archivo_id = EXCLUDED.archivo_id,
                                 filas = EXCLUDED.filas, cargado_en = now()""",
                            (periodo, archivo_id, psycopg.types.json.Jsonb(filas)))
            conn.commit()
            resumen[periodo] = filas
            if ej:
                ej.sumar("igj_cortes")
    if archivo_id and resumen:
        with conn.cursor() as cur:
            cur.execute("UPDATE ctl.archivo_fuente SET filas_cargadas = %s, cargado_en = now() WHERE id = %s",
                        (sum(sum(f.values()) for f in resumen.values()), archivo_id))
        conn.commit()
    return resumen
