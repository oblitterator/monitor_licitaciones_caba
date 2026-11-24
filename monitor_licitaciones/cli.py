"""Línea de comandos: python -m monitor_licitaciones <comando> ...

Comandos (todos idempotentes; se pueden re-ejecutar sin duplicar):
  init-db                       crea/actualiza esquemas, tablas, funciones y vistas
  migrar-v1                     copia normas, textos y padrón de empresas desde public (v1)
  boletines --desde --hasta     baja boletines y normas de la API
  pdfs [--limite N]             baja PDFs pendientes y extrae texto
  parsear [--todo]              parsea actos de licitación (solo nuevos o de versión vieja)
  descargar FUENTE [--url]      baja una fuente externa (igj_autoridades, rns) a datos/ y la registra
  registrar-archivo FUENTE RUTA registra un archivo bajado a mano (lo mueve a datos/FUENTE/)
  funcionarios                  baja y parsea designaciones desde gerente (DNI, cargo, fechas) y cruza con IGJ
  igj [--archivo ZIP]           carga entidades, autoridades y socios de IGJ (con historia por corte)
  fuentes                       lista fuentes externas y archivos registrados (url, fecha, sha256)
  clasificar                    asigna categoría y subcategoría a los actos (reglas en ref.categoria_regla)
  resolver                      resuelve CUIT de las firmas (texto, alias, padrón)
  bac [--archivo f.csv]         guarda un snapshot del OCDS de BAC
  ipc --csv f.csv               carga serie IPC (columnas: mes=AAAA-MM, indice)
  actualizar                    corrida diaria: boletines desde la última fecha + pdfs + parsear + resolver
  calidad                       muestra cobertura y calidad de la extracción
"""
from __future__ import annotations

import argparse
import csv
import logging
import sys
import time
from datetime import date, timedelta
from pathlib import Path

from . import bac as bac_mod
from .api_bo import BoletinAPI
from .db import conectar, ejecucion, init_db
from .fuentes import FUENTES, descargar, registrar_local
from . import igj as igj_mod
from .ingesta import (FALLAS_SEGUIDAS_MAX, ServidorCaido, cargar_boletines, clasificar, encolar_designaciones, parsear_designaciones,
                      parsear_documentos, procesar_pdfs)

log = logging.getLogger("monitor_licitaciones")


def _fecha(s: str) -> date:
    return date.fromisoformat(s)


def _imprimir(cur) -> None:
    filas = cur.fetchall()
    cols = [d.name for d in cur.description]
    anchos = [max(len(str(c)), *(len(str(f[i])) for f in filas)) if filas else len(c) for i, c in enumerate(cols)]
    print("  ".join(c.ljust(a) for c, a in zip(cols, anchos)))
    for f in filas:
        print("  ".join(str(v).ljust(a) for v, a in zip(f, anchos)))
    print()


CANDADO = 4_715_301   # pg_advisory_lock compartido con app/monitor.py
COMANDOS_QUE_ESCRIBEN = {"init-db", "migrar-v1", "boletines", "pdfs", "parsear", "descargar", "registrar-archivo",
                         "funcionarios", "igj", "clasificar", "resolver", "bac", "ipc", "actualizar"}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="monitor-licitaciones", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # --dsn y -v valen antes o después del comando (p.ej. "parsear -v" o "-v parsear")
    comunes = argparse.ArgumentParser(add_help=False)
    comunes.add_argument("--dsn", default=argparse.SUPPRESS, help="cadena de conexión (por defecto MLC_DSN)")
    comunes.add_argument("-v", "--verbose", action="store_true", default=argparse.SUPPRESS)
    p.add_argument("--dsn", help="cadena de conexión (por defecto MLC_DSN)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    _add = sub.add_parser
    sub.add_parser = lambda *x, **k: _add(*x, parents=[comunes], **k)
    sub.add_parser("init-db")
    sub.add_parser("migrar-v1")
    b = sub.add_parser("boletines")
    b.add_argument("--desde", type=_fecha, required=True)
    b.add_argument("--hasta", type=_fecha, default=date.today())
    b.add_argument("--forzar", action="store_true", help="re-consultar fechas ya consultadas")
    b.add_argument("--pausa", type=float, default=0.5, help="segundos entre pedidos a la API")
    d = sub.add_parser("pdfs")
    d.add_argument("--limite", type=int, default=500)
    d.add_argument("--max-intentos", type=int, default=3)
    d.add_argument("--hilos", type=int, default=1, help="descargas en paralelo (3 es razonable; más puede saturar el Boletín)")
    d.add_argument("--todos", action="store_true",
                   help="seguir por tandas de --limite hasta que no queden pendientes (se puede cortar con Ctrl+C y retomar)")
    pa = sub.add_parser("parsear")
    pa.add_argument("--todo", action="store_true", help="re-parsear todo, aunque la versión coincida")
    sub.add_parser("resolver")
    sub.add_parser("clasificar")
    bc = sub.add_parser("bac")
    bc.add_argument("--archivo", type=Path, help="CSV ya descargado (si no, se baja de datos abiertos)")
    ip = sub.add_parser("ipc")
    ip.add_argument("--csv", type=Path, required=True)
    ac = sub.add_parser("actualizar")
    ac.add_argument("--limite-pdfs", type=int, default=2000)
    sub.add_parser("calidad")
    de = sub.add_parser("descargar", help="baja una fuente externa a datos/ y la registra (url, fecha, sha256)")
    de.add_argument("fuente", choices=sorted(FUENTES))
    de.add_argument("--url", help="URL alternativa (las de datos.jus.gob.ar cambian con cada publicación)")
    ra = sub.add_parser("registrar-archivo", help="registra un archivo bajado a mano y lo mueve a datos/<fuente>/")
    ra.add_argument("fuente", choices=sorted(FUENTES))
    ra.add_argument("archivo", type=Path)
    ra.add_argument("--url", help="URL de origen, si se conoce")
    sub.add_parser("fuentes", help="lista las fuentes externas y los archivos registrados")
    fu = sub.add_parser("funcionarios", help="baja y parsea designaciones desde gerente hacia arriba (DNI, cargo, fechas)")
    fu.add_argument("--limite", type=int, default=500, help="PDF por tanda")
    fu.add_argument("--solo-parsear", action="store_true", help="no bajar PDF, solo re-parsear lo descargado")
    fu.add_argument("--todo", action="store_true", help="re-parsear todas las designaciones")
    ig = sub.add_parser("igj", help="carga el zip de entidades de IGJ (por defecto, el último descargado)")
    ig.add_argument("--archivo", type=Path, help="zip de IGJ (si no, el último registrado con 'descargar igj')")
    ig.add_argument("--forzar", action="store_true", help="recargar cortes ya cargados")
    ig.add_argument("--descargar", action="store_true", help="bajar antes el zip vigente de IGJ")
    ig.add_argument("--url", help="URL del zip si cambió la publicación (con --descargar)")
    a = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(message)s")
    conn = conectar(a.dsn)

    # Candado: un solo comando que escribe a la vez (la app usa el mismo candado para habilitar botones).
    if a.cmd in COMANDOS_QUE_ESCRIBEN:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (CANDADO,))
            libre = cur.fetchone()[0]
        conn.commit()
        if not libre:
            print("Hay otra actualización en curso; reintentar cuando termine.", file=sys.stderr)
            return 3

    if a.cmd == "init-db":
        for f in init_db(conn):
            print("aplicado", f)
        return 0

    with ejecucion(conn, a.cmd, {k: v for k, v in vars(a).items() if k not in ("dsn", "cmd")}) as ej:
        if a.cmd == "migrar-v1":
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ctl.migrar_v1()")
                _imprimir(cur)
            conn.commit()

        elif a.cmd == "boletines":
            cargar_boletines(conn, ej, BoletinAPI(pausa=a.pausa), a.desde, a.hasta, a.forzar)

        elif a.cmd == "pdfs":
            ej.fase("pdf_licitacion")
            caidas = 0
            while True:
                with conn.cursor() as cur:
                    cur.execute("SELECT count(*) FROM bo.documento WHERE estado IN ('pendiente','error') AND intentos < %s",
                                (a.max_intentos,))
                    quedan = cur.fetchone()[0]
                print(f"pendientes: {quedan}", flush=True)
                if not quedan:
                    break
                try:
                    hechos = procesar_pdfs(conn, ej, limite=a.limite, max_intentos=a.max_intentos, hilos=a.hilos)
                    caidas = 0
                except ServidorCaido as e:
                    caidas += 1
                    ej.sumar("pausas_por_caida")
                    if caidas > 6:
                        print(f"El Boletín sigue caído después de 30 minutos ({e}); se corta. Retomar más tarde.", flush=True)
                        break
                    print(f"  {FALLAS_SEGUIDAS_MAX} errores seguidos ({e}): el Boletín parece caído; espero 5 minutos "
                          f"(pausa {caidas} de 6)", flush=True)
                    time.sleep(300)
                    continue
                print(f"  tanda: {hechos} | acumulado ok={ej.resumen.get('pdf_ok', 0)} "
                      f"vacio={ej.resumen.get('pdf_vacio', 0)} error={ej.resumen.get('pdf_error', 0)}", flush=True)
                if not a.todos or hechos == 0:
                    break
            # lo bajado no sirve hasta parsearlo: actos, montos, firmas, CUIT y categorías
            ej.fase("parseo")
            parsear_documentos(conn, ej)
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ref.resolver_cuit()")
            conn.commit()
            ej.resumen.pop("fase", None)

        elif a.cmd == "parsear":
            ej.fase("parseo")
            parsear_documentos(conn, ej, todo=a.todo)
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ref.resolver_cuit()")
            conn.commit()
            ej.resumen.pop("fase", None)

        elif a.cmd == "descargar":
            archivo_id, ruta, nuevo = descargar(conn, ej, a.fuente, a.url)
            print(f"{'nuevo' if nuevo else 'sin cambios (mismo sha256 que una descarga anterior)'}: "
                  f"archivo_id={archivo_id} {ruta}")
        elif a.cmd == "registrar-archivo":
            archivo_id, ruta, nuevo = registrar_local(conn, ej, a.fuente, a.archivo, a.url)
            print(f"{'registrado' if nuevo else 'ya estaba registrado'}: archivo_id={archivo_id} {ruta}")
        elif a.cmd == "funcionarios":
            if not a.solo_parsear:
                print(f"encoladas: {encolar_designaciones(conn)} normas nuevas", flush=True)
                while True:
                    with conn.cursor() as cur:
                        cur.execute("""SELECT count(*) FROM bo.documento WHERE proposito = 'designacion'
                                       AND estado IN ('pendiente','error') AND intentos < 3""")
                        quedan = cur.fetchone()[0]
                    print(f"PDF pendientes: {quedan}", flush=True)
                    if not quedan or procesar_pdfs(conn, ej, limite=a.limite, proposito="designacion") == 0:
                        break
            print(f"parseadas: {parsear_designaciones(conn, ej, todo=a.todo)}", flush=True)
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM analitica.calidad_funcionarios")
                _imprimir(cur)
        elif a.cmd == "igj":
            archivo_id = None
            if a.descargar and not a.archivo:
                archivo_id, ruta, nuevo = descargar(conn, ej, "igj", a.url)
                print(f"{'zip nuevo' if nuevo else 'zip sin cambios'}: {ruta}", flush=True)
            elif a.archivo:
                archivo_id, ruta, _ = registrar_local(conn, ej, "igj", a.archivo, mover=False)
            else:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, ruta FROM ctl.archivo_fuente WHERE fuente = 'igj' ORDER BY descargado_en DESC LIMIT 1")
                    fila = cur.fetchone()
                if not fila:
                    print("No hay archivos de IGJ registrados: correr primero 'descargar igj'.")
                    return 1
                archivo_id, ruta = fila[0], Path(fila[1])
            res = igj_mod.cargar(conn, ej, ruta, archivo_id, a.forzar)
            for periodo, filas in res.items():
                print(periodo, " ".join(f"{k}={v:,}".replace(",", ".") for k, v in filas.items()))
            if not res:
                print("sin cortes nuevos (usar --forzar para recargar)")
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM analitica.calidad_igj")
                _imprimir(cur)
        elif a.cmd == "fuentes":
            for k, f in FUENTES.items():
                print(f"{k}: {f.descripcion}\n  {f.pagina}")
            print()
            with conn.cursor() as cur:
                cur.execute("""SELECT id, fuente, descargado_en::timestamp(0), pg_size_pretty(bytes) AS tam,
                                      left(sha256, 12) AS sha, filas_cargadas, ruta
                               FROM ctl.archivo_fuente ORDER BY fuente, descargado_en""")
                _imprimir(cur)
        elif a.cmd == "clasificar":
            ej.sumar("clasificados", clasificar(conn, todo=True))
            with conn.cursor() as cur:
                cur.execute("""SELECT coalesce(categoria,'(sin clasificar)') AS categoria, count(*) AS actos
                               FROM bo.acto WHERE etapa IN ('adjudicacion','preadjudicacion')
                               GROUP BY 1 ORDER BY 2 DESC""")
                _imprimir(cur)
        elif a.cmd == "resolver":
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ref.resolver_cuit()")
                _imprimir(cur)
            conn.commit()

        elif a.cmd == "bac":
            if a.archivo:
                path, lm = a.archivo, None
            else:
                path, lm = bac_mod.descargar()
            bac_mod.cargar_snapshot(conn, ej, path, last_modified=lm)

        elif a.cmd == "ipc":
            with a.csv.open(encoding="utf-8-sig") as f, conn.cursor() as cur:
                for row in csv.DictReader(f):
                    mes = date.fromisoformat(row["mes"][:7] + "-01")
                    cur.execute("""INSERT INTO ref.ipc (mes, indice) VALUES (%s, %s)
                                   ON CONFLICT (mes) DO UPDATE SET indice = EXCLUDED.indice""",
                                (mes, float(row["indice"].replace(",", "."))))
                    ej.sumar("meses")
            conn.commit()

        elif a.cmd == "actualizar":
            with conn.cursor() as cur:
                # desde el último boletín cargado (por API o por migración), no solo lo registrado en fecha_consultada
                cur.execute("""SELECT greatest(
                                   (SELECT max(fecha) FROM ctl.fecha_consultada WHERE resultado = 'con_boletin'),
                                   (SELECT max(fecha_publicacion) FROM bo.boletin),
                                   date '2019-12-01')""")
                desde = cur.fetchone()[0] + timedelta(days=1)
            ej.fase("boletines")
            cargar_boletines(conn, ej, BoletinAPI(), desde, date.today())
            ej.fase("pdf_licitacion")
            try:
                procesar_pdfs(conn, ej, limite=a.limite_pdfs, proposito="licitacion")
            except ServidorCaido as e:
                print(f"El Boletín parece caído ({e}); los PDF que faltan quedan para la próxima.", flush=True)
                ej.sumar("pdf_cortado_por_caida")
            ej.fase("parseo")
            parsear_documentos(conn, ej)
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ref.resolver_cuit()")
            conn.commit()
            # funcionarios: designaciones nuevas desde gerente hacia arriba
            ej.fase("pdf_designacion")
            encolar_designaciones(conn)
            try:
                procesar_pdfs(conn, ej, limite=a.limite_pdfs, proposito="designacion")
            except ServidorCaido as e:
                print(f"El Boletín parece caído ({e}); los PDF que faltan quedan para la próxima.", flush=True)
                ej.sumar("pdf_cortado_por_caida")
            ej.fase("parseo_designaciones")
            parsear_designaciones(conn, ej)
            ej.resumen.pop("fase", None)

        elif a.cmd == "calidad":
            with conn.cursor() as cur:
                for titulo, q in [
                    ("Documentos (texto de PDFs)", "SELECT estado, sum(documentos) documentos, sum(agotaron_reintentos) agotados FROM analitica.calidad_documentos GROUP BY 1 ORDER BY 2 DESC"),
                    ("Parser por etapa (todas las fechas)", "SELECT etapa, sum(actos) actos, round(sum(actos*pct_alta)/sum(actos),1) pct_alta, round(sum(actos*pct_con_monto)/sum(actos),1) pct_con_monto, round(sum(actos*pct_con_codigo)/sum(actos),1) pct_con_codigo FROM analitica.calidad_parser GROUP BY 1 ORDER BY 2 DESC"),
                    ("Resolución de CUIT por rol", "SELECT * FROM analitica.calidad_resolucion ORDER BY rol, firmas DESC"),
                    ("Errores abiertos", "SELECT etapa, count(*) FROM ctl.error WHERE resuelto_en IS NULL GROUP BY 1"),
                ]:
                    print(f"== {titulo}")
                    cur.execute(q)
                    _imprimir(cur)

    print({k: v for k, v in ej.resumen.items()} or "ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
