"""Integración contra un Postgres real. Requiere MLC_TEST_DSN apuntando a una base DESCARTABLE
(el test borra y recrea los esquemas). Ej.: MLC_TEST_DSN=postgresql://postgres@localhost/mlc_test"""
import csv
import json
import os
from datetime import date
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
DSN = os.environ.get("MLC_TEST_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="definir MLC_TEST_DSN para correr integración")

from monitor_licitaciones import bac as bac_mod, ingesta  # noqa: E402
from monitor_licitaciones.api_bo import interpretar_respuesta  # noqa: E402
from monitor_licitaciones.db import conectar, ejecucion, init_db  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
CASOS = [c for f in ("actos.json", "actos_holdout.json", "actos_holdout2.json", "actos_reales_v2.json")
         for c in json.loads((FIX / f).read_text(encoding="utf-8"))]


@pytest.fixture(scope="module")
def conn():
    c = conectar(DSN)
    with c.cursor() as cur:
        for s in ("analitica", "bac", "bo", "ref", "ctl"):
            cur.execute(f"DROP SCHEMA IF EXISTS {s} CASCADE")
        cur.execute("DROP TABLE IF EXISTS public.normas, public.licitaciones, public.registro_empresas CASCADE")
        # esquema v1 (mismas columnas que la base real)
        cur.execute("""
          CREATE TABLE public.normas (id_norma int PRIMARY KEY, boletin_id int, categoria varchar, desc_emisor varchar,
             emisor varchar, entidad varchar, fecha_publicacion date, nombre varchar, sumario varchar, tipo varchar,
             url_norma varchar, anexos text);
          CREATE TABLE public.licitaciones (id_licitacion serial PRIMARY KEY, estado varchar, id_norma int UNIQUE,
             numero_licitacion varchar, texto text, url_norma "char");
          CREATE TABLE public.registro_empresas (cuit bigint PRIMARY KEY, razon_social varchar, tipo_societario varchar,
             fecha_hora_contrato_social timestamp, fecha_hora_actualizacion timestamp, numero_inscripcion bigint,
             dom_fiscal_calle varchar, dom_fiscal_numero int, dom_fiscal_piso varchar, dom_fiscal_departamento varchar,
             dom_fiscal_localidad varchar, dom_fiscal_provincia varchar, dom_fiscal_cp int, dom_fiscal_estado_domicilio varchar,
             dom_legal_calle varchar, dom_legal_numero int, dom_legal_piso varchar, dom_legal_departamento varchar,
             dom_legal_localidad varchar, dom_legal_provincia varchar, dom_legal_cp int, dom_legal_estado_domicilio varchar);
        """)
        for i, cso in enumerate(CASOS):
            tipo = cso["nombre"].split("/")[0].strip()
            cur.execute("INSERT INTO public.normas VALUES (%s,1,'Licitaciones','ORG','ORG',NULL,%s,%s,NULL,%s,NULL,NULL)",
                        (cso["id_norma"], date(2023, 1, 1 + i % 28), cso["nombre"], tipo))
            cur.execute("INSERT INTO public.licitaciones (estado,id_norma,texto) VALUES ('ADJU',%s,%s)",
                        (cso["id_norma"], cso["texto"]))
        # una descarga fallida en v1: debe quedar pendiente, no como dato
        cur.execute("INSERT INTO public.normas VALUES (999,1,'Licitaciones','ORG','ORG',NULL,'2023-02-01','x / Llamado N° 1/X/23',NULL,'Licitación Pública',NULL,NULL)")
        cur.execute("INSERT INTO public.licitaciones (estado,id_norma,texto) VALUES ('Timeout',999,NULL)")
        # padrón: Uniser sin CUIT en el texto -> debe resolverse por padrón exacto;
        # dos firmas con el mismo domicilio -> señal de domicilio compartido
        cur.executemany(
            "INSERT INTO public.registro_empresas (cuit, razon_social, tipo_societario, fecha_hora_contrato_social, dom_fiscal_calle, dom_fiscal_numero) VALUES (%s,%s,'SA',%s,%s,%s)",
            [(30111111118, "UNISER S.A.", "2022-12-01", "AV SIEMPRE VIVA", 742),
             (33652830809, "AIRSEC SA", "2010-01-01", "CALLE FALSA", 123),
             (33709217009, "MCM SECURITY SRL", "2015-01-01", "CALLE FALSA", 123)])
    c.commit()
    init_db(c)
    init_db(c)   # idempotente
    yield c
    c.close()


def test_migracion_parseo_resolucion_y_vistas(conn):
    with ejecucion(conn, "test") as ej:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM ctl.migrar_v1()")
            pasos = dict(cur.fetchall())
        conn.commit()
        assert pasos["normas"] == len(CASOS) + 1
        assert pasos["documentos_ok"] == len(CASOS)
        assert pasos["documentos_a_reintentar"] == 1

        ingesta.parsear_documentos(conn, ej)
        assert ej.resumen["parseados"] == len(CASOS)
        assert "parser_error" not in ej.resumen

        # re-parsear sin cambios de versión no hace nada
        ingesta.parsear_documentos(conn, ej)
        assert ej.resumen["parseados"] == len(CASOS)

        with conn.cursor() as cur:
            cur.execute("SELECT * FROM ref.resolver_cuit()")
            res = dict(cur.fetchall())
            assert res.get("cuit_en_texto", 0) >= 10
            cur.execute("""SELECT af.cuit, af.resolucion FROM bo.acto_firma af WHERE af.id_norma = 534015""")
            assert cur.fetchone() == (30111111118, "padron_exacto")

            # la v1 'Timeout' quedó pendiente, no como texto
            cur.execute("SELECT estado FROM bo.documento WHERE id_norma = 999")
            assert cur.fetchone()[0] == "pendiente"

            # todas las vistas responden
            cur.execute("SELECT table_name FROM information_schema.views WHERE table_schema='analitica'")
            for (v,) in cur.fetchall():
                cur.execute(f"SELECT count(*) FROM analitica.{v}")

            # monto: nunca se duplica entre ganadoras. La única excepción es 420-0825-LPU20, donde el
            # propio Boletín es inconsistente (firmas suman 4.388.016,25; total declarado 4.338.016,25)
            cur.execute("""SELECT codigo_proceso FROM analitica.ganador GROUP BY 1
                           HAVING sum(monto_asignado) > max(monto_total) * 1.0001""")
            assert [r[0] for r in cur.fetchall()] == ["420-0825-LPU20"]
            cur.execute("SELECT codigo_proceso FROM analitica.control_montos")
            assert [r[0] for r in cur.fetchall()] == ["420-0825-LPU20"]

            # 710000: tres adjudicatarias con monto propio -> suman el total
            cur.execute("SELECT sum(monto_asignado) FROM analitica.ganador WHERE codigo_proceso='412-0116-CME23'")
            assert float(cur.fetchone()[0]) == pytest.approx(945690)

            # empresa nueva: UNISER constituida 2022-12-01, gana en 2023
            cur.execute("SELECT count(*) FROM analitica.s_empresa_nueva WHERE cuit = 30111111118")
            assert cur.fetchone()[0] == 1

            # domicilio compartido entre AIRSEC y MCM (mismo acto 772935)
            cur.execute("SELECT count(*) FROM analitica.s_domicilio_compartido WHERE cuit_1=33652830809 AND cuit_2=33709217009")
            assert cur.fetchone()[0] == 1

            # oferta única
            cur.execute("SELECT unica_oferta, n_ofertas FROM analitica.proceso WHERE codigo_proceso='541-1185-CDI23'")
            assert cur.fetchone() == (True, 1)


def test_ingesta_api_idempotente(conn):
    respuesta = {
        "boletin": {"numero": 7001, "fecha_publicacion": "02/01/2025", "nombre": "BO 7001", "separata": "0"},
        "normas": {"normas": {"Licitaciones": {"Licitación Pública": {"Ministerio X": [
            {"id_norma": 900001, "nombre": "Licitación Pública / Llamado N° 1/X/25", "url_norma": "http://x/1.pdf"}]}},
            "Poder Ejecutivo": {"Resolución": {"Ministerio X": [
                {"id_norma": 900002, "nombre": "Resolución N° 1/X/25", "url_norma": "http://x/2.pdf"}]}}}},
    }

    class APIFalsa:
        llamadas = 0

        def obtener_boletin(self, fecha):
            APIFalsa.llamadas += 1
            if fecha == date(2025, 1, 2):
                return interpretar_respuesta(fecha, respuesta)
            return interpretar_respuesta(fecha, {})

    with ejecucion(conn, "test_api") as ej:
        ingesta.cargar_boletines(conn, ej, APIFalsa(), date(2025, 1, 1), date(2025, 1, 3))
        ingesta.cargar_boletines(conn, ej, APIFalsa(), date(2025, 1, 1), date(2025, 1, 3))  # no re-consulta
        assert APIFalsa.llamadas == 3
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM bo.norma WHERE boletin_numero = 7001")
            assert cur.fetchone()[0] == 2
            cur.execute("SELECT id_norma, estado FROM bo.documento WHERE id_norma IN (900001, 900002)")
            assert cur.fetchall() == [(900001, "pendiente")]   # solo Licitaciones baja PDF

        # PDF: primero falla, después anda; el error queda resuelto y no se mezcla con el texto
        def falla(url):
            raise TimeoutError("timeout simulado")
        ingesta.procesar_pdfs(conn, ej, descargar=falla)
        orig = ingesta.extraer_texto_pdf
        ingesta.extraer_texto_pdf = lambda b: ("Llamado - Licitación Pública N° 401-0001-LPU25\n", 1)
        try:
            ingesta.procesar_pdfs(conn, ej, descargar=lambda url: b"%PDF-fake")
        finally:
            ingesta.extraer_texto_pdf = orig
        with conn.cursor() as cur:
            cur.execute("SELECT estado, intentos, ultimo_error FROM bo.documento WHERE id_norma = 900001")
            assert cur.fetchone() == ("ok", 2, None)
            cur.execute("SELECT count(*) FROM ctl.error WHERE etapa='pdf' AND clave='900001' AND resuelto_en IS NULL")
            assert cur.fetchone()[0] == 0


def test_bac_snapshot(conn, tmp_path):
    f = tmp_path / "bac.csv"
    cols = ["ocid", "date", "tender/procurementMethod", "tender/procurementMethodDetails", "tender/status",
            "tender/procuringEntity/name", "tender/title", "awards/0/id", "awards/0/suppliers/0/id",
            "awards/0/suppliers/0/name", "awards/0/value/amount", "awards/0/value/currency"]
    with f.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        w.writerow(["ocds-bulbcf-412-0116-CME23-1-0", "2023-03-20T10:00:00-03:00", "direct", "CONTRATACION MENOR",
                    "complete", "HTAL ARGERICH", "insumos", "A1", "AR-CUIT-30-71111111-1-supplier", "Proveedor X SA",
                    "1000.5", "ARS"])
    with ejecucion(conn, "test_bac") as ej:
        assert bac_mod.cargar_snapshot(conn, ej, f) is not None
        assert bac_mod.cargar_snapshot(conn, ej, f) is None        # mismo archivo: no duplica
        with conn.cursor() as cur:
            cur.execute("SELECT codigo_proceso FROM bac.release")
            assert cur.fetchone()[0] == "412-0116-CME23"
            cur.execute("SELECT cuit, monto FROM bac.adjudicacion")
            assert cur.fetchone() == (30711111111, 1000.5)


def test_pdfs_concurrentes_escriben_en_el_hilo_principal(conn):
    import threading
    import time
    ids = list(range(910001, 910013))
    with conn.cursor() as cur:
        cur.execute("INSERT INTO bo.boletin (numero, fecha_publicacion) VALUES (7101, '2025-03-03') ON CONFLICT DO NOTHING")
        for i in ids:
            cur.execute("""INSERT INTO bo.norma (id_norma, boletin_numero, fecha_publicacion, seccion, nombre, url_norma)
                           VALUES (%s, 7101, '2025-03-03', 'Licitaciones', 'x', %s)""", (i, f"http://h/{i}.pdf"))
            cur.execute("INSERT INTO bo.documento (id_norma, estado) VALUES (%s, 'pendiente')", (i,))
    conn.commit()
    vistos, hilos = [], set()

    def bajar(url):
        hilos.add(threading.current_thread().name)
        vistos.append(url)
        time.sleep(0.02)
        if url.endswith("910003.pdf"):
            raise TimeoutError("timeout simulado")
        return b"%PDF-" + url.encode()

    orig = ingesta.extraer_texto_pdf
    ingesta.extraer_texto_pdf = lambda b: ("" if b.endswith(b"910004.pdf") else "Llamado N° 1\n", 1)
    try:
        with ejecucion(conn, "test_pdfs") as ej:
            ingesta.procesar_pdfs(conn, ej, descargar=bajar, concurrencia=4, limite=100)
    finally:
        ingesta.extraer_texto_pdf = orig
    assert all(u.startswith("https://") for u in vistos) and all(h.startswith("pdf") for h in hilos)
    with conn.cursor() as cur:
        cur.execute("SELECT estado, count(*) FROM bo.documento WHERE id_norma BETWEEN 910001 AND 910012 GROUP BY 1")
        assert dict(cur.fetchall()) == {"ok": 10, "vacio": 1, "error": 1}
        cur.execute("SELECT intentos, ultimo_error FROM bo.documento WHERE id_norma = 910003")
        assert cur.fetchone() == (1, "TimeoutError: timeout simulado")
        cur.execute("SELECT count(*) FROM ctl.error WHERE etapa='pdf' AND clave='910003' AND resuelto_en IS NULL")
        assert cur.fetchone()[0] == 1


def test_boletines_dos_el_mismo_dia_y_dia_sin_publicar(conn):
    def resp(numero, fecha_pub, id_norma):
        return {"boletin": {"numero": numero, "fecha_publicacion": fecha_pub},
                "normas": {"normas": {"Licitaciones": {"Licitación Pública": {"Org": [
                    {"id_norma": id_norma, "nombre": "Licitación Pública / Llamado N° 1/X/26", "url_norma": "http://x/a.pdf"}]}}}}}

    por_fecha = {date(2026, 11, 17): resp(7494, "17/11/2026", 920001),
                 date(2026, 11, 18): resp(7496, "18/11/2026", 920003)}
    ultimo = resp(7496, "18/11/2026", 920003)

    class APIFalsa:
        numeros = []

        def obtener_boletin(self, fecha):
            return interpretar_respuesta(fecha, por_fecha.get(fecha, ultimo))

        def obtener_boletin_numero(self, numero):
            APIFalsa.numeros.append(numero)
            if numero == 7495:
                return interpretar_respuesta(None, resp(7495, "17/11/2026", 920002))
            return interpretar_respuesta(None, {})

    with ejecucion(conn, "test_numeros") as ej:
        ingesta.cargar_boletines(conn, ej, APIFalsa(), date(2026, 11, 17), date(2026, 11, 19))
        assert APIFalsa.numeros == [7495]
        assert ej.resumen["fechas_sin_publicar_aun"] == 1       # 19/11 devolvió el boletín del 18
        ingesta.cargar_boletines(conn, ej, APIFalsa(), date(2026, 11, 17), date(2026, 11, 19))
        assert APIFalsa.numeros == [7495]                         # no se vuelve a pedir
    with conn.cursor() as cur:
        cur.execute("SELECT numero, fecha_publicacion FROM bo.boletin WHERE numero BETWEEN 7494 AND 7496 ORDER BY 1")
        assert [r[0] for r in cur.fetchall()] == [7494, 7495, 7496]
        cur.execute("SELECT boletin_numero FROM bo.norma WHERE id_norma = 920002")
        assert cur.fetchone()[0] == 7495
        cur.execute("SELECT estado FROM bo.documento WHERE id_norma = 920002")
        assert cur.fetchone()[0] == "pendiente"
        cur.execute("SELECT fecha, resultado FROM ctl.fecha_consultada WHERE fecha BETWEEN '2026-11-17' AND '2026-11-19' ORDER BY 1")
        assert cur.fetchall() == [(date(2026, 11, 17), "con_boletin"), (date(2026, 11, 18), "con_boletin")]


def test_llm_no_pisa_reglas_y_consolida(conn):
    from types import SimpleNamespace as NS
    from monitor_licitaciones import llm
    texto = ("Preadjudicación - Licitación Pública\nObjeto: insumos\n"
             "Proceso de compra 401-0147-LPU22. Firma preadjudicada: Acme S.A. por $ 1.234.567,89\n")
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO bo.norma (id_norma, fecha_publicacion, seccion, nombre)
                       VALUES (930001, '2025-04-01', 'Licitaciones', 'Licitación Pública / Preadjudicación N° 1/X/22')""")
        cur.execute("INSERT INTO bo.documento (id_norma, estado, sha256, texto) VALUES (930001, 'ok', %s, %s)",
                    ("f" * 64, texto))
        cur.execute("""INSERT INTO bo.acto (id_norma, etapa, confianza, faltantes, parser_version, monto_total, moneda)
                       VALUES (930001, 'preadjudicacion', 'baja', '{codigo_proceso,firma}', 'test', 1000, 'ARS')""")
    conn.commit()
    filas = llm.actos_a_enviar(conn)
    assert [f[0] for f in filas if f[0] == 930001] == [930001]
    datos = {"etapa": {"valor": "preadjudicacion", "evidencia": "Preadjudicación - Licitación Pública"},
             "codigo_proceso": {"valor": "401-0147-LPU22", "evidencia": "Proceso de compra 401-0147-LPU22."},
             "monto_total": {"valor": 1234567.89, "moneda": "ARS", "evidencia": "Acme S.A. por $ 1.234.567,89"},
             "firmas": [{"nombre": "Acme S.A.", "rol": "preadjudicada", "evidencia": "Firma preadjudicada: Acme S.A.",
                         "cuit": None, "cuit_evidencia": None, "monto": 1234567.89, "moneda": "ARS",
                         "monto_evidencia": "Acme S.A. por $ 1.234.567,89"}]}
    cid = llm.custom_id(930001, "f" * 64)
    res = NS(custom_id=cid, result=NS(type="succeeded", message=NS(
        content=[NS(type="text", text=json.dumps(datos))], stop_reason="end_turn", usage=None)))
    fila = llm.interpretar_resultado(res, texto)
    assert fila["estado"] == "ok"
    with conn.cursor() as cur:
        cur.execute("INSERT INTO ctl.lote_llm (lote_id, modelo, prompt_version, pedidos) VALUES ('msgbatch_test', %s, %s, 1)",
                    (llm.MODELO, llm.VERSION_PROMPT))
        llm.guardar_resultado(cur, "msgbatch_test", llm.MODELO, llm.VERSION_PROMPT, cid, fila, "f" * 64)
        conn.commit()
        # las reglas no se tocan
        cur.execute("SELECT codigo_proceso, monto_total FROM bo.acto WHERE id_norma = 930001")
        assert cur.fetchone() == (None, 1000)
        # consolidado: el código lo completa el LLM; el monto de las reglas manda
        cur.execute("""SELECT codigo_proceso, codigo_fuente, monto_total, monto_fuente, usa_llm
                       FROM analitica.acto_consolidado WHERE id_norma = 930001""")
        assert cur.fetchone() == ("401-0147-LPU22", "llm", 1000, "reglas", True)
        # y como los montos difieren, va a control
        cur.execute("SELECT monto_reglas, monto_llm FROM analitica.control_llm WHERE id_norma = 930001")
        assert [float(x) for x in cur.fetchone()] == [1000.0, pytest.approx(1234567.89)]
        cur.execute("SELECT nombre_raw, rol, monto FROM analitica.acto_llm_firma WHERE id_norma = 930001")
        assert cur.fetchone()[:2] == ("Acme S.A.", "preadjudicada")
        # ya enviado y vigente: no se vuelve a mandar
        assert 930001 not in [f[0] for f in llm.actos_a_enviar(conn)]
        # si cambia el PDF, la extracción deja de valer y el acto vuelve a la cola
        cur.execute("UPDATE bo.documento SET sha256 = %s WHERE id_norma = 930001", ("e" * 64,))
        conn.commit()
        cur.execute("SELECT count(*) FROM analitica.acto_llm_v WHERE id_norma = 930001")
        assert cur.fetchone()[0] == 0
        assert 930001 in [f[0] for f in llm.actos_a_enviar(conn)]
