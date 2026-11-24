"""Carga del Boletín Oficial: boletines+normas, PDFs y parseo de actos. Todo idempotente."""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import date, timedelta
from typing import Callable, Iterable, Optional

import psycopg
import requests

from .api_bo import BoletinAPI, ErrorAPI, RespuestaBoletin
from .db import Ejecucion
from .descarga import CONCURRENCIA_DEFECTO, INTERVALO_DEFECTO, Descargador, bajar_y_extraer, sesion_pdfs
from .parser_actos import PARSER_VERSION, parsear_acto

log = logging.getLogger("monitor_licitaciones")

# Secciones cuyas normas se bajan en PDF para extraer texto
SECCIONES_CON_PDF = ("Licitaciones",)


# ---------------------------------------------------------------------------
# Boletines y normas
# ---------------------------------------------------------------------------
def fechas_a_consultar(conn: psycopg.Connection, desde: date, hasta: date, forzar: bool) -> list[date]:
    todas = [desde + timedelta(days=i) for i in range((hasta - desde).days + 1)]
    if forzar:
        return todas
    with conn.cursor() as cur:
        cur.execute(
            "SELECT fecha FROM ctl.fecha_consultada WHERE fecha BETWEEN %s AND %s AND resultado <> 'error'",
            (desde, hasta),
        )
        hechas = {r[0] for r in cur.fetchall()}
    return [f for f in todas if f not in hechas]


def _id_norma(n: dict) -> Optional[int]:
    for k in ("id_norma", "idNorma", "id"):
        v = n.get(k)
        if v not in (None, ""):
            try:
                return int(v)
            except (TypeError, ValueError):
                return None
    return None


def guardar_respuesta(conn: psycopg.Connection, r: RespuestaBoletin) -> dict:
    """Upsert de boletín y normas. Devuelve contadores."""
    c = {"normas": 0, "pdf_pendientes": 0}
    b = r.boletin
    fecha_pub = r.fecha_publicacion or r.fecha_consultada
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO bo.boletin (numero, fecha_publicacion, es_separata, nombre, url_boletin, raw)
               VALUES (%(numero)s, %(fecha)s, %(sep)s, %(nombre)s, %(url)s, %(raw)s)
               ON CONFLICT (numero) DO UPDATE SET
                 fecha_publicacion = EXCLUDED.fecha_publicacion, es_separata = EXCLUDED.es_separata,
                 nombre = EXCLUDED.nombre, url_boletin = EXCLUDED.url_boletin, raw = EXCLUDED.raw,
                 actualizado_en = now()
               WHERE bo.boletin.raw IS DISTINCT FROM EXCLUDED.raw""",
            {"numero": int(b["numero"]), "fecha": fecha_pub,
             "sep": str(b.get("separata", "")).lower() in ("1", "true", "si", "sí"),
             "nombre": b.get("nombre"), "url": b.get("url_boletin"),
             "raw": json.dumps(b, ensure_ascii=False, default=str)},
        )
        for n in r.normas:
            idn = _id_norma(n)
            if idn is None:
                continue
            raw = {k: v for k, v in n.items() if not k.startswith("_")}
            cur.execute(
                """INSERT INTO bo.norma (id_norma, boletin_numero, fecha_publicacion, seccion, tipo, organismo,
                                         nombre, sumario, url_norma, raw, origen)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'api')
                   ON CONFLICT (id_norma) DO UPDATE SET
                     boletin_numero = EXCLUDED.boletin_numero, fecha_publicacion = EXCLUDED.fecha_publicacion,
                     seccion = EXCLUDED.seccion, tipo = EXCLUDED.tipo, organismo = EXCLUDED.organismo,
                     nombre = EXCLUDED.nombre, sumario = EXCLUDED.sumario, url_norma = EXCLUDED.url_norma,
                     raw = EXCLUDED.raw, origen = 'api', actualizado_en = now()
                   WHERE bo.norma.raw IS DISTINCT FROM EXCLUDED.raw OR bo.norma.origen <> 'api'""",
                (idn, int(b["numero"]), fecha_pub, n.get("_seccion"), n.get("_tipo"), n.get("_organismo"),
                 n.get("nombre"), n.get("sumario"), n.get("url_norma") or n.get("url"),
                 json.dumps(raw, ensure_ascii=False, default=str)),
            )
            c["normas"] += 1
            if n.get("_seccion") in SECCIONES_CON_PDF:
                cur.execute(
                    "INSERT INTO bo.documento (id_norma, estado) VALUES (%s, 'pendiente') ON CONFLICT DO NOTHING",
                    (idn,),
                )
                c["pdf_pendientes"] += cur.rowcount
    return c


def marcar_fecha(conn: psycopg.Connection, fecha: date, resultado: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO ctl.fecha_consultada (fecha, resultado) VALUES (%s, %s)
               ON CONFLICT (fecha) DO UPDATE SET resultado = EXCLUDED.resultado, consultado_en = now()""",
            (fecha, resultado),
        )


def clasificar_fecha(fecha: date, r: RespuestaBoletin) -> str:
    """'con_boletin' | 'sin_boletin' | 'sin_publicar_aun'.
    Para una fecha sin edición la API devuelve el último boletín publicado. Si ese boletín es POSTERIOR
    a la fecha, la fecha no tuvo edición (definitivo). Si es ANTERIOR, la fecha es posterior a todo lo
    publicado: puede ser feriado o puede que todavía no haya salido, así que no se da por cerrada."""
    if r.boletin is None:
        return "sin_boletin"
    fp = r.fecha_publicacion
    if fp is None or fp == fecha:
        return "con_boletin"
    return "sin_boletin" if fp > fecha else "sin_publicar_aun"


def cargar_boletines(conn: psycopg.Connection, ej: Ejecucion, api: BoletinAPI,
                     desde: date, hasta: date, forzar: bool = False) -> None:
    for fecha in fechas_a_consultar(conn, desde, hasta, forzar):
        try:
            r = api.obtener_boletin(fecha)
        except ErrorAPI as e:
            ej.error("api_boletin", fecha.isoformat(), str(e))
            marcar_fecha(conn, fecha, "error")
            conn.commit()
            ej.sumar("fechas_error")
            log.warning("%s: %s", fecha, e)
            continue
        clase = clasificar_fecha(fecha, r)
        if clase in ("sin_boletin", "sin_publicar_aun"):
            # sin edición ese día: la API devuelve el ÚLTIMO boletín publicado (se guarda igual)
            if r.boletin is not None and not r.error_normas:
                guardar_respuesta(conn, r)
            if clase == "sin_boletin":
                marcar_fecha(conn, fecha, "sin_boletin")
            # 'sin_publicar_aun' no se marca: la próxima corrida vuelve a consultar esa fecha
            conn.commit()
            ej.sumar(f"fechas_{clase}")
            continue
        if r.error_normas:
            ej.error("api_boletin", fecha.isoformat(), f"normas: {r.error_normas}")
            marcar_fecha(conn, fecha, "error")
            conn.commit()
            ej.sumar("fechas_error")
            continue
        c = guardar_respuesta(conn, r)
        marcar_fecha(conn, fecha, "con_boletin")
        ej.resolver("api_boletin", fecha.isoformat())
        conn.commit()
        ej.sumar("boletines")
        ej.sumar("normas", c["normas"])
        ej.sumar("pdf_pendientes", c["pdf_pendientes"])
        log.info("%s: boletín %s, %d normas", fecha, r.boletin.get("numero"), c["normas"])
    completar_por_numero(conn, ej, api, desde, hasta)


def numeros_faltantes(conocidos: Iterable[int], consultados: Iterable[int] = ()) -> list[int]:
    """Huecos entre el menor y el mayor número conocido, sin los ya consultados."""
    conocidos = set(conocidos)
    if not conocidos:
        return []
    ya = conocidos | set(consultados)
    return [n for n in range(min(conocidos), max(conocidos) + 1) if n not in ya]


def completar_por_numero(conn: psycopg.Connection, ej: Ejecucion, api: BoletinAPI, desde: date, hasta: date,
                         margen_dias: int = 7) -> None:
    """La API devuelve un solo boletín por fecha aunque ese día salgan dos (7494 y 7495 el 17/11/2026).
    Se piden por número los huecos entre los boletines conocidos de la ventana (más unos días antes,
    para agarrar el hueco con la corrida anterior). Los números que no existen quedan en
    ctl.numero_consultado y no se vuelven a pedir."""
    with conn.cursor() as cur:
        cur.execute("SELECT numero FROM bo.boletin WHERE fecha_publicacion BETWEEN %s AND %s",
                    (desde - timedelta(days=margen_dias), hasta))
        conocidos = [r[0] for r in cur.fetchall()]
        if not conocidos:
            return
        cur.execute("SELECT numero FROM ctl.numero_consultado WHERE numero BETWEEN %s AND %s AND resultado <> 'error'",
                    (min(conocidos), max(conocidos)))
        consultados = [r[0] for r in cur.fetchall()]
    for numero in numeros_faltantes(conocidos, consultados):
        clave = f"numero:{numero}"
        try:
            r = api.obtener_boletin_numero(numero)
        except ErrorAPI as e:
            ej.error("api_boletin", clave, str(e))
            marcar_numero(conn, numero, "error")
            conn.commit()
            ej.sumar("numeros_error")
            continue
        if r.boletin is None:
            marcar_numero(conn, numero, "inexistente")
            conn.commit()
            ej.sumar("numeros_inexistentes")
            continue
        if r.error_normas:
            ej.error("api_boletin", clave, f"normas: {r.error_normas}")
            marcar_numero(conn, numero, "error")
            conn.commit()
            ej.sumar("numeros_error")
            continue
        c = guardar_respuesta(conn, r)
        marcar_numero(conn, numero, "con_boletin")
        ej.resolver("api_boletin", clave)
        conn.commit()
        ej.sumar("boletines")
        ej.sumar("boletines_por_numero")
        ej.sumar("normas", c["normas"])
        ej.sumar("pdf_pendientes", c["pdf_pendientes"])
        log.info("número %s: boletín del %s, %d normas", numero, r.fecha_publicacion, c["normas"])


def marcar_numero(conn: psycopg.Connection, numero: int, resultado: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO ctl.numero_consultado (numero, resultado) VALUES (%s, %s)
               ON CONFLICT (numero) DO UPDATE SET resultado = EXCLUDED.resultado, consultado_en = now()""",
            (numero, resultado),
        )


# ---------------------------------------------------------------------------
# PDFs -> texto
# ---------------------------------------------------------------------------
# PDFium no es thread-safe: la extracción se serializa (son ~2-4 ms por PDF; la espera es la red).
_LOCK_PDFIUM = threading.Lock()
# PDFium devuelve los guiones como U+00AD (guion blando) o U+FFFE / U+0002 (guion de fin de línea);
# pdfplumber los da como "-" y el parser espera "-" (p. ej. "EX- 2026-...").
_GUIONES_PDFIUM = str.maketrans({"\u00ad": "-", "\ufffe": "-", "\u0002": "-"})


def extraer_texto_pdf(contenido: bytes) -> tuple[str, int]:
    """(texto, páginas) con pypdfium2. Unas 10 veces más rápido que pdfplumber con el mismo texto útil."""
    import pypdfium2 as pdfium  # import diferido
    with _LOCK_PDFIUM:
        doc = pdfium.PdfDocument(contenido)
        try:
            paginas = []
            for i in range(len(doc)):
                pagina = doc[i]
                tp = pagina.get_textpage()
                try:
                    paginas.append(tp.get_text_range())
                finally:
                    tp.close()
                    pagina.close()
        finally:
            doc.close()
    texto = "\n".join(paginas).replace("\r\n", "\n").replace("\r", "\n").translate(_GUIONES_PDFIUM)
    return texto, len(paginas)


FALLAS_SEGUIDAS_MAX = 15   # con tantos errores consecutivos se asume que el Boletín está caído


class ServidorCaido(RuntimeError):
    """El Boletín devolvió errores en serie: se frena para no gastar los reintentos de cada PDF."""


def procesar_pdfs(conn: psycopg.Connection, ej: Ejecucion, limite: int = 500, max_intentos: int = 3,
                  session: Optional[requests.Session] = None, timeout: float = 60,
                  descargar: Optional[Callable[[str], bytes]] = None,
                  concurrencia: int = CONCURRENCIA_DEFECTO, intervalo: float = INTERVALO_DEFECTO,
                  proposito: Optional[str] = None) -> int:
    """Baja hasta `limite` PDFs pendientes (o con error y menos de `max_intentos`), de a `concurrencia`
    en paralelo y con `intervalo` segundos mínimos entre pedidos. `proposito` filtra por tipo de
    documento ('licitacion' | 'designacion'; None = todos). Devuelve cuántos intentó.

    La descarga y la extracción corren en hilos; TODAS las escrituras a la base se hacen acá, en el
    hilo que llama (la conexión no es thread-safe). Con FALLAS_SEGUIDAS_MAX errores consecutivos se
    corta con ServidorCaido: lo que no llegó a procesarse queda como estaba, sin gastar intentos."""
    des = None
    if descargar is None:
        des = Descargador(session or sesion_pdfs(concurrencia), concurrencia=concurrencia,
                          intervalo=intervalo, timeout=timeout)
        descargar = des.bajar
    with conn.cursor() as cur:
        cur.execute(
            """SELECT d.id_norma, n.url_norma FROM bo.documento d JOIN bo.norma n USING (id_norma)
               WHERE d.estado IN ('pendiente','error') AND d.intentos < %s AND n.url_norma IS NOT NULL
                 AND (%s::text IS NULL OR d.proposito = %s::text)
               ORDER BY n.fecha_publicacion DESC LIMIT %s""",
            (max_intentos, proposito, proposito, limite),
        )
        pendientes = cur.fetchall()
    seguidas = 0
    try:
        # extraer_texto_pdf se busca en el módulo en cada llamada (los tests lo reemplazan)
        for res in bajar_y_extraer(pendientes, descargar, lambda b: extraer_texto_pdf(b), concurrencia):
            id_norma = res.clave
            if res.error is None:
                estado = "ok" if res.texto.strip() else "vacio"   # vacío = probablemente escaneado
                with conn.cursor() as cur:
                    cur.execute(
                        """UPDATE bo.documento SET estado=%s, intentos=intentos+1, ultimo_error=NULL, sha256=%s,
                           paginas=%s, texto=%s, extraido_en=now(), actualizado_en=now() WHERE id_norma=%s""",
                        (estado, hashlib.sha256(res.contenido).hexdigest(), res.paginas, res.texto, id_norma),
                    )
                ej.resolver("pdf", id_norma)
                ej.sumar(f"pdf_{estado}")
                seguidas = 0
            else:
                with conn.cursor() as cur:
                    cur.execute(
                        """UPDATE bo.documento SET estado='error', intentos=intentos+1, ultimo_error=%s,
                           actualizado_en=now() WHERE id_norma=%s""",
                        (res.error[:1000], id_norma),
                    )
                ej.error("pdf", id_norma, res.error)
                ej.sumar("pdf_error")
                seguidas += 1
            conn.commit()
            if seguidas >= FALLAS_SEGUIDAS_MAX:
                raise ServidorCaido(res.error)
    finally:
        if des is not None:
            lat = des.resumen_latencias()
            ej.sumar("pdf_pedidos_http", lat["pedidos"])
            ej.sumar("pdf_reintentos_http", lat["reintentos"])
            if pendientes:
                log.info("pdfs: %d documentos, latencias %s", len(pendientes), lat)
    return len(pendientes)


# ---------------------------------------------------------------------------
# Parseo de actos
# ---------------------------------------------------------------------------
def guardar_acto(cur: psycopg.Cursor, id_norma: int, nombre: Optional[str], texto: str) -> str:
    a = parsear_acto(nombre, texto)
    cur.execute(
        """INSERT INTO bo.acto (id_norma, codigo_proceso, uoa, tipo_proc, anio_proc, tipo_licitacion, etapa,
              etapa_conflicto, expediente, objeto, monto_total, monto_origen, moneda, n_ofertas, n_firmas_identificadas,
              unica_oferta, fracasada, confianza, faltantes, parser_version, rubro, datos_paciente,
              n_menciones_paciente, parseado_en)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
           ON CONFLICT (id_norma) DO UPDATE SET
              codigo_proceso=EXCLUDED.codigo_proceso, uoa=EXCLUDED.uoa, tipo_proc=EXCLUDED.tipo_proc,
              anio_proc=EXCLUDED.anio_proc, tipo_licitacion=EXCLUDED.tipo_licitacion, etapa=EXCLUDED.etapa,
              etapa_conflicto=EXCLUDED.etapa_conflicto, expediente=EXCLUDED.expediente, objeto=EXCLUDED.objeto,
              monto_total=EXCLUDED.monto_total, monto_origen=EXCLUDED.monto_origen, moneda=EXCLUDED.moneda, n_ofertas=EXCLUDED.n_ofertas,
              n_firmas_identificadas=EXCLUDED.n_firmas_identificadas, unica_oferta=EXCLUDED.unica_oferta,
              fracasada=EXCLUDED.fracasada, confianza=EXCLUDED.confianza, faltantes=EXCLUDED.faltantes,
              parser_version=EXCLUDED.parser_version, rubro=EXCLUDED.rubro,
              datos_paciente=EXCLUDED.datos_paciente, n_menciones_paciente=EXCLUDED.n_menciones_paciente,
              categoria=NULL, subcategoria=NULL, categoria_fuente=NULL,   -- se recalcula en clasificar
              parseado_en=now()""",
        (id_norma, a.codigo_proceso, a.uoa, a.tipo_proc, a.anio_proc, a.tipo_licitacion, a.etapa,
         a.etapa_conflicto, a.expediente, a.objeto, a.monto_total, a.monto_origen, a.moneda, a.n_ofertas,
         a.n_firmas_identificadas, a.unica_oferta, a.fracasada, a.confianza, a.faltantes, a.parser_version,
         a.rubro, a.datos_paciente, a.n_menciones_paciente),
    )
    # Al re-parsear se conserva el CUIT ya resuelto de las firmas cuyo nombre no cambió
    # (si no, cada re-parseo obliga a correr resolver de nuevo).
    cur.execute("SELECT nombre_raw, cuit, resolucion, score FROM bo.acto_firma WHERE id_norma = %s AND resolucion IS NOT NULL",
                (id_norma,))
    previas = {r[0]: r[1:] for r in cur.fetchall()}
    cur.execute("DELETE FROM bo.acto_firma WHERE id_norma = %s", (id_norma,))
    for i, f in enumerate(a.firmas, 1):
        nombre = f.nombre[:300]
        cuit, resolucion, score = previas.get(nombre, (None, None, None))
        if f.cuit_texto and resolucion != "cuit_en_texto":   # el texto manda
            cuit, resolucion, score = None, None, None
        cur.execute(
            """INSERT INTO bo.acto_firma (id_norma, orden, nombre_raw, rol, monto, cuit_texto, cuit, resolucion, score)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (id_norma, i, nombre, f.rol, f.monto, f.cuit_texto, cuit, resolucion, score),
        )
    return a.confianza


def parsear_documentos(conn: psycopg.Connection, ej: Ejecucion, todo: bool = False, lote: int = 1000) -> None:
    """Parsea los documentos OK sin acto, o con versión de parser vieja (o todos si todo=True).
    Un error en un documento se registra en ctl.error y no frena el resto."""
    filtro = "" if todo else "AND (a.id_norma IS NULL OR a.parser_version <> %(v)s)"
    ultimo = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT d.id_norma, n.nombre, d.texto FROM bo.documento d
                    JOIN bo.norma n USING (id_norma) LEFT JOIN bo.acto a USING (id_norma)
                    WHERE d.estado = 'ok' AND d.proposito = 'licitacion' AND d.id_norma > %(ultimo)s {filtro}
                    ORDER BY d.id_norma LIMIT %(lote)s""",
                {"v": PARSER_VERSION, "lote": lote, "ultimo": ultimo},
            )
            filas = cur.fetchall()
        if not filas:
            break
        for id_norma, nombre, texto in filas:
            try:
                with conn.transaction():          # savepoint por documento
                    with conn.cursor() as cur:
                        conf = guardar_acto(cur, id_norma, nombre, texto or "")
                ej.sumar(f"confianza_{conf}")
            except Exception as e:  # noqa: BLE001
                ej.error("parser", id_norma, f"{type(e).__name__}: {e}")
                ej.sumar("parser_error")
        ultimo = filas[-1][0]
        conn.commit()
        ej.sumar("parseados", len(filas))
        log.info("parseados %d", ej.resumen["parseados"])
    ej.sumar("clasificados", clasificar(conn, todo=False))
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM bo.acto_firma WHERE resolucion IS NULL")
        sin = cur.fetchone()[0]
    if sin:
        ej.sumar("firmas_sin_resolver", sin)
        log.warning("%d firmas sin CUIT resuelto: correr 'resolver'", sin)


def clasificar(conn: psycopg.Connection, todo: bool = True) -> int:
    """Asigna categoría/subcategoría (ref.categoria_regla). todo=False: solo actos sin categoría."""
    with conn.cursor() as cur:
        cur.execute("SELECT ref.clasificar_actos(%s)", (todo,))
        n = cur.fetchone()[0]
        cur.execute("SELECT ref.actualizar_unidades()")   # jerarquía de organismos (poder > jurisdicción > unidad)
    conn.commit()
    log.info("clasificados %d", n)
    return n


# ---------------------------------------------------------------------------
# Funcionarios (normas de designación, renuncia y cese)
# ---------------------------------------------------------------------------
def encolar_designaciones(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT fun.encolar_designaciones()")
        n = cur.fetchone()[0]
    conn.commit()
    return n


def parsear_designaciones(conn: psycopg.Connection, ej: Ejecucion, todo: bool = False) -> int:
    from .parser_designaciones import PARSER_DESIGNACIONES_VERSION, parsear_designacion
    filtro = "" if todo else "AND (p.id_norma IS NULL OR p.parser_version <> %(v)s)"
    with conn.cursor() as cur:
        cur.execute(f"""SELECT d.id_norma, d.texto, n.sumario FROM bo.documento d JOIN bo.norma n USING (id_norma)
                        LEFT JOIN fun.norma_parseada p USING (id_norma)
                        WHERE d.proposito = 'designacion' AND d.estado = 'ok' {filtro}""",
                    {"v": PARSER_DESIGNACIONES_VERSION})
        filas = cur.fetchall()
    n = 0
    for id_norma, texto, sumario in filas:
        try:
            with conn.transaction():
                r = parsear_designacion(texto or "", sumario)
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM fun.designacion WHERE id_norma = %s", (id_norma,))
                    for i, m in enumerate(r.menciones, 1):
                        cur.execute(
                            """INSERT INTO fun.designacion (id_norma, orden, apellido_nombre, numero_documento, cuil,
                                   movimiento, parte, cargo, nivel, vigencia_desde)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (id_norma, i, m.apellido_nombre, m.numero_documento, m.cuil, m.movimiento, m.parte,
                             (m.cargo or "")[:300] or None, m.nivel, m.vigencia_desde))
                    cur.execute("""INSERT INTO fun.norma_parseada (id_norma, menciones, parser_version) VALUES (%s,%s,%s)
                                   ON CONFLICT (id_norma) DO UPDATE SET menciones = EXCLUDED.menciones,
                                     parser_version = EXCLUDED.parser_version, parseado_en = now()""",
                                (id_norma, len(r.menciones), r.parser_version))
            n += 1
            ej.sumar("designaciones_parseadas")
        except Exception as e:  # noqa: BLE001
            ej.error("parser_designacion", id_norma, f"{type(e).__name__}: {e}")
    conn.commit()
    return n
