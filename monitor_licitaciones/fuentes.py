"""Descarga y registro trazable de fuentes externas.

Cada archivo queda en datos/<fuente>/<AAAAMMDD-HHMMSS>_<nombre> y se registra en
ctl.archivo_fuente con URL, sha256, tamaño y fecha. Si el contenido ya se había bajado
(mismo sha256) no se duplica: se borra la copia nueva y se devuelve el registro existente.

Las URLs de datos.jus.gob.ar cambian con cada publicación (el nombre del archivo lleva la
fecha): si una deja de funcionar, buscar la vigente en la página del dataset y pasarla con --url.
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import psycopg
import requests

from .db import Ejecucion

log = logging.getLogger(__name__)

DIR_DATOS = Path(os.environ.get("MLC_DATOS", "datos"))


@dataclass(frozen=True)
class Fuente:
    url: str
    pagina: str
    descripcion: str
    licencia: str = "CC BY 4.0"


FUENTES: dict[str, Fuente] = {
    "igj_autoridades": Fuente(
        url=("https://datos.jus.gob.ar/dataset/30f36834-49f0-4d9e-91d9-33621fb52b6d/resource/"
             "30558188-9c77-41cb-8c83-06f3bb84b0bf/download/igj-autoridades-genero-202603.csv"),
        pagina="https://datos.jus.gob.ar/dataset/igj-autoridades-genero",
        descripcion="IGJ. Autoridades de entidades constituidas en la IGJ (con género asignado por nombre). Trimestral.",
    ),
    "igj": Fuente(
        url=("https://datos.jus.gob.ar/dataset/da045e06-35cb-4bdd-9b5e-ddee6712c86c/resource/"
             "508d3b3a-cd5b-4208-a27f-68846fb5fc86/download/igj-2026-semestre-2.zip"),
        pagina="https://datos.jus.gob.ar/dataset/entidades-constituidas-en-la-inspeccion-general-de-justicia-igj",
        descripcion="IGJ. Entidades constituidas: entidades, domicilios, autoridades, balances y asambleas. Mensual.",
    ),
    "rns": Fuente(
        url=("https://datos.jus.gob.ar/dataset/ee83de85-4305-4c53-9a9f-fd3d15e42c36/resource/"
             "13a1a66f-9f49-4d2d-9582-7b4540ef1b83/download/registro-nacional-sociedades-2026.zip"),
        pagina="https://datos.jus.gob.ar/dataset/registro-nacional-de-sociedades",
        descripcion="Registro Nacional de Sociedades (incluye actividad AFIP desde dic-2024). Mensual.",
    ),
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def _registrar(conn: psycopg.Connection, ej: Optional[Ejecucion], fuente: str, url: Optional[str], ruta: Path,
               last_modified: Optional[str] = None) -> tuple[int, bool]:
    """Inserta el archivo en ctl.archivo_fuente. Devuelve (id, es_nuevo)."""
    sha, tam = _sha256(ruta), ruta.stat().st_size
    with conn.cursor() as cur:
        cur.execute("SELECT id, ruta FROM ctl.archivo_fuente WHERE fuente = %s AND sha256 = %s", (fuente, sha))
        previo = cur.fetchone()
        if previo:
            return previo[0], False
        cur.execute(
            """INSERT INTO ctl.archivo_fuente (fuente, url, ruta, sha256, bytes, http_last_modified, ejecucion_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (fuente, url, ruta.as_posix(), sha, tam, last_modified, ej.id if ej else None),
        )
        nuevo = cur.fetchone()[0]
    conn.commit()
    return nuevo, True


def descargar(conn: psycopg.Connection, ej: Optional[Ejecucion], fuente: str, url: Optional[str] = None,
              timeout: float = 600) -> tuple[int, Path, bool]:
    """Baja la fuente a datos/<fuente>/ y la registra. Devuelve (archivo_id, ruta, es_nuevo)."""
    if fuente not in FUENTES:
        raise ValueError(f"fuente desconocida: {fuente}. Disponibles: {', '.join(FUENTES)}")
    url = url or FUENTES[fuente].url
    destino_dir = DIR_DATOS / fuente
    destino_dir.mkdir(parents=True, exist_ok=True)
    nombre = url.rstrip("/").rsplit("/", 1)[-1] or f"{fuente}.bin"
    destino = destino_dir / f"{datetime.now():%Y%m%d-%H%M%S}_{nombre}"
    log.info("bajando %s", url)
    with requests.get(url, stream=True, timeout=(15, timeout),
                      headers={"User-Agent": "monitor-licitaciones-caba/2"}) as r:
        r.raise_for_status()
        tmp = destino.with_suffix(destino.suffix + ".parcial")
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        tmp.replace(destino)
        last_mod = r.headers.get("Last-Modified")
    archivo_id, nuevo = _registrar(conn, ej, fuente, url, destino, last_mod)
    if not nuevo:
        destino.unlink()          # mismo contenido que una descarga anterior
        with conn.cursor() as cur:
            cur.execute("SELECT ruta FROM ctl.archivo_fuente WHERE id = %s", (archivo_id,))
            destino = Path(cur.fetchone()[0])
    return archivo_id, destino, nuevo


def registrar_local(conn: psycopg.Connection, ej: Optional[Ejecucion], fuente: str, archivo: Path,
                    url: Optional[str] = None, mover: bool = True) -> tuple[int, Path, bool]:
    """Registra un archivo bajado a mano (p. ej. con el navegador). Por defecto lo mueve a datos/<fuente>/."""
    if not archivo.exists():
        raise FileNotFoundError(archivo)
    with conn.cursor() as cur:   # mismo contenido ya registrado: no se mueve ni se duplica
        cur.execute("SELECT id, ruta FROM ctl.archivo_fuente WHERE fuente = %s AND sha256 = %s",
                    (fuente, _sha256(archivo)))
        previo = cur.fetchone()
    if previo:
        return previo[0], Path(previo[1]), False
    destino = archivo
    if mover:
        destino_dir = DIR_DATOS / fuente
        destino_dir.mkdir(parents=True, exist_ok=True)
        destino = destino_dir / f"{datetime.fromtimestamp(archivo.stat().st_mtime):%Y%m%d-%H%M%S}_{archivo.name}"
        if destino.resolve() != archivo.resolve():
            shutil.move(str(archivo), destino)
    archivo_id, nuevo = _registrar(conn, ej, fuente, url, destino)
    return archivo_id, destino, nuevo
