import json
from pathlib import Path

import pytest

from monitor_licitaciones.parser_actos import parsear_acto, clave_firma, a_numero, cuit_valido

_FIX = Path(__file__).parent / "fixtures"
# actos.json: casos con los que se diseñaron las reglas.
# actos_holdout*.json: muestras aleatorias posteriores (miden generalización; luego quedan como regresión).
CASOS = [c for f in ("actos.json", "actos_holdout.json", "actos_holdout2.json", "actos_reales_v2.json")
         for c in json.loads((_FIX / f).read_text(encoding="utf-8"))]


@pytest.mark.parametrize("caso", CASOS, ids=[str(c["id_norma"]) for c in CASOS])
def test_acto(caso):
    a = parsear_acto(caso["nombre"], caso["texto"])
    esp = caso["esperado"]

    for campo in ("codigo_proceso", "tipo_proc", "etapa", "n_ofertas", "unica_oferta", "etapa_conflicto", "fracasada", "moneda"):
        if campo in esp:
            assert getattr(a, campo) == esp[campo], f"{campo}: {getattr(a, campo)!r} != {esp[campo]!r}"
    if esp["monto_total"] is None:
        assert a.monto_total is None, f"monto_total {a.monto_total}"
    else:
        assert a.monto_total == pytest.approx(esp["monto_total"]), f"monto_total {a.monto_total}"

    obtenidas = {clave_firma(f.nombre): f for f in a.firmas}
    for fe in esp["firmas"]:
        k = clave_firma(fe["nombre"])
        assert k in obtenidas, f"falta firma {fe['nombre']!r}; obtenidas={[f.nombre for f in a.firmas]}"
        f = obtenidas[k]
        assert f.rol == fe["rol"], f"{fe['nombre']}: rol {f.rol} != {fe['rol']}"
        if "cuit" in fe:
            assert f.cuit_texto == fe["cuit"]
        if "monto" in fe:
            assert f.monto == pytest.approx(fe["monto"])
    # no debe haber firmas de más
    esperadas = {clave_firma(fe["nombre"]) for fe in esp["firmas"]}
    sobrantes = [f.nombre for f in a.firmas if clave_firma(f.nombre) not in esperadas]
    assert not sobrantes, f"firmas sobrantes: {sobrantes}"


@pytest.mark.parametrize("txt,val", [
    ("5.426.800.-", 5426800), ("4.228.180 ,00", 4228180.0), ("2967,16", 2967.16),
    ("13.500-", 13500), ("6.006.000.", 6006000), ("1110", 1110), ("27.982.960,00", 27982960.0),
])
def test_a_numero(txt, val):
    assert a_numero(txt) == pytest.approx(val)


def test_cuit_valido():
    assert cuit_valido("30563006664")
    assert not cuit_valido("30563006665")


# --- 2.4.0: datos de pacientes, rubro y objeto largo -------------------------
from monitor_licitaciones.parser_actos import (  # noqa: E402
    MARCA_PACIENTE, enmascarar_pacientes, extraer_objeto, extraer_rubro, parsear_acto,
)


@pytest.mark.parametrize("texto,n", [
    ("Adquisición de Marcapasos DDDR - Pte Chaia Mariano", 1),
    ("Respirador - Ptes. Flores Rivero Ángela, Saavedra Eduardo y Gómez Ana", 1),
    ("Prótesis de cadera paciente Gómez Ana María.", 1),
    ("Desfibrilador (Pac. Nadini)", 1),
    ("Stent Biliar - Paciente: Rodriguez C", 1),
    ("con destino al paciente Del Valle Vargas Willian", 1),
    ("silla con destino al paciente Benega Càceres Florencia", 1),
    ("Radioterapia 3D - Pte Figueroa Adriana Noemi.-", 1),
    ("Radioterapia IMRT - Pte Luis Marquez. Servicio", 1),
    ("Adquisición de Rituximab- Pte Robledo Servicio: Farmacia.- Número de Orden", 1),
    ("medicamentos para paciente Recalde (judicializado)", 1),
    ("Servicio Externo de Radioterapia 3D. Paciente Troche", 1),
])
def test_enmascara_pacientes(texto, n):
    t, k = enmascarar_pacientes(texto)
    assert k == n and MARCA_PACIENTE in t
    for apellido in ("Rodriguez", "Valle", "Càceres", "Figueroa", "Marquez", "Robledo", "Recalde", "Troche"):
        assert apellido not in t
    assert "Chaia" not in t and "Saavedra" not in t and "Gómez" not in t and "Nadini" not in t


@pytest.mark.parametrize("texto", [
    "sita en Av. Pte. Julio A. Roca 538",
    "Av. Pte. Roque Sáenz Peña 832",
    "insumos para pacientes Oncológicos del Hospital",
    "Máscara para Pte \nFirma preadjudicada",
    "reparación de montacarga del Teatro Pte. Alvear",
    "Medicamentos para Pacientes Oncológicos Mediante NO",
    "insumos para pacientes Del Hospital Durand",
    "insumos para paciente Oncológico ambulatorio",
])
def test_no_enmascara_falsos_positivos(texto):
    assert enmascarar_pacientes(texto) == (texto, 0)


def test_acto_con_paciente_queda_marcado():
    a = parsear_acto("Preadjudicación - Contratación Menor",
                     "Contratación Menor N° 412-1808-CME23 Objeto: adquisición de Cardiodesfibrilador Pac Pérez Juan "
                     "Firmas preadjudicadas: ACME S.A. Total preadjudicado: $ 1.000.000,00")
    assert a.datos_paciente and a.n_menciones_paciente == 1
    assert "Pérez" not in a.objeto and MARCA_PACIENTE in a.objeto


def test_objeto_largo_y_titulo_y_rubro():
    largo = "Objeto de la contratación: Servicio de entrega de raciones " + "y módulos alimentarios, " * 20
    assert extraer_objeto(largo).startswith("Servicio de entrega de raciones")
    assert extraer_objeto("Adjudicación - Servicio de Seguridad Privada - Licitación Pública N° 1") == "Servicio de Seguridad Privada"
    assert extraer_objeto("Objeto: Servicio por un periodo de 24 meses Fecha de apertura: 1/1") == "Servicio por un periodo de 24 meses"
    assert extraer_rubro("Rubro comercial: Salud Objeto de la contratación: X") == "Salud"


@pytest.mark.parametrize("texto,esperado", [
    ("Licitación Pública Nº 426-1354-LPU22 EX-2022-31385750-GCABA-HGAPP Licitación Pública Nº 426-1354-LPU22 "
     "Insumos Anatomía Patológica con aparatología en préstamo Rubro: Salud Observaciones: x",
     "Insumos Anatomía Patológica con aparatología en préstamo"),
    ("Licitación Pública Nº 422-1044-LPU23 Rubro: Salud Descripción: Adquisición de Material Sanitario Firmas Preadjudicadas: Q",
     "Adquisición de Material Sanitario"),
    ("Licitación Pública Nacional Nº 4866-SIGAF/2019 - Adquisición de materiales para el subprograma manos a la obra "
     "Aviso de Adjudicación", "Adquisición de materiales para el subprograma manos a la obra"),
])
def test_objeto_respaldos(texto, esperado):
    assert extraer_objeto(texto) == esperado


def test_corta_el_nombre_en_la_etiqueta_siguiente():
    t, n = enmascarar_pacientes("Stent Biliar- Pte Parodi Servicio: Cirugia.-")
    assert n == 1 and t == f"Stent Biliar- Pte {MARCA_PACIENTE} Servicio: Cirugia.-"


# --- designaciones -----------------------------------------------------------
from monitor_licitaciones.parser_designaciones import nivel_de, parsear_designacion  # noqa: E402

DECRETO = """DECRETO N.° 438/23
CONSIDERANDO:
Que por el Decreto N° 466/19 fue designado el Cdor. Andrés Gustavo Ballotta, DNI
23.328.774, CUIL 20-23328774-2, como Administrador Gubernamental de Ingresos Públicos;
Por ello,
DECRETA:
Artículo 1°.- Acéptase, a partir del 19 de diciembre de 2023, la renuncia presentada por el Cdor. Andrés Gustavo Ballotta, DNI N° 23.328.774, CUIL N° 20-23328774-2, como Administrador Gubernamental de Ingresos Públicos (AGIP).
Artículo 2°.- Desígnase, a partir del 20 de diciembre de 2023, al Dr. José María Donati, D.N.I. N° 21.555.666, como Administrador Gubernamental de Ingresos Públicos (AGIP).
Artículo 3°.- Dese al Registro."""


def test_decreto_renuncia_y_designacion():
    ms = {m.numero_documento: m for m in parsear_designacion(DECRETO).menciones}
    b, d = ms["23328774"], ms["21555666"]
    assert b.apellido_nombre == "Andrés Gustavo Ballotta" and b.movimiento == "renuncia" and b.parte == "resolutiva"
    assert b.cuil == "20233287742" and b.nivel == 2 and str(b.vigencia_desde) == "2023-12-19"
    assert d.apellido_nombre == "José María Donati" and d.movimiento == "designa" and str(d.vigencia_desde) == "2023-12-20"


def test_solo_cuil_y_cese():
    t = ("RESUELVE: Artículo 1°.- Desígnase a la Lic. María Belén Rey, CUIL 27-30111222-4, como Gerente Operativa de la "
         "Gerencia Operativa Mapa del Delito, a partir del 1/3/2022. Artículo 2.- Limítase a partir del 28 de febrero "
         "de 2022 la designación de Juan Pérez de la Vega, D.N.I. 18.222.333 como Gerente Operativo de Compras.")
    ms = {m.numero_documento: m for m in parsear_designacion(t).menciones}
    assert ms["30111222"].movimiento == "designa" and ms["30111222"].apellido_nombre == "María Belén Rey"
    assert ms["18222333"].movimiento == "cese" and ms["18222333"].apellido_nombre == "Juan Pérez de la Vega"


def test_considerando_es_antecedente():
    t = "CONSIDERANDO: Que por Resolución N° 1/20 se designó a Ana Gómez, DNI 30.000.111, como Directora General de X;"
    m = parsear_designacion(t).menciones[0]
    assert m.movimiento == "antecedente" and m.nivel == 4


def test_cargo_del_sumario_solo_para_quien_nombra():
    t = ("RESUELVE: Artículo 1°.- Acéptase la renuncia presentada por la Sra. Verónica Yanina Ramos, DNI 30.111.222, "
         "como Gobierno de la Ciudad Autónoma de Buenos Aires “2022 - Año del 40° Aniversario”. "
         "Artículo 2.- Encomiéndase a Juan Pérez, DNI 20.333.444, la atención de los asuntos.")
    ms = {m.numero_documento: m for m in parsear_designacion(
        t, "Se acepta la renuncia presentada por la Sra. Verónica Yanina Ramos, como Gerente Operativa de Compras").menciones}
    assert ms["30111222"].cargo == "Gerente Operativa de Compras" and ms["30111222"].nivel == 5
    assert ms["20333444"].movimiento == "designa" and ms["20333444"].cargo is None


def test_niveles():
    assert nivel_de("Ministro de Salud") == 1 and nivel_de("Subsecretario de Gestión") == 3
    assert nivel_de("Gerente Operativo de Compras") == 5 and nivel_de("Subgerente Operativo") is None
    assert nivel_de("Director Titular 1° de FACOEP SE") == 2
    assert nivel_de("Gerente Operativo de la Gerencia X de la Subsecretaría Y") == 5
    assert nivel_de("Directora General de la DG Z dependiente de la Subsecretaría W") == 4
    assert nivel_de("Gobierno de la Ciudad Autónoma de Buenos Aires") is None


# --- montos con ceros de más (casos reales del BO) -------------------------------------------
from monitor_licitaciones.parser_actos import letras_a_numero  # noqa: E402


def test_letras_a_numero():
    assert letras_a_numero("un millon cuatrocientos dieciseis mil") == 1_416_000
    assert letras_a_numero("doce millones doscientos sesenta y siete mil quinientos catorce") == 12_267_514
    assert letras_a_numero("noventa y seis mil novecientos ochenta y cuatro millones setecientos ochenta y ocho mil "
                           "setecientos ochenta con 00/100") == 96_984_788_780
    assert letras_a_numero("mil quinientos") == 1500
    assert letras_a_numero("Renglón uno") is None


SANTA_LUCIA = """MINISTERIO DE SALUD
HOSPITAL OFTALMOLÓGICO SANTA LUCÍA
Adjudicación - Contratación Menor N° 433-3742-CME25
Contratación Menor N° 433-3742-CME25
Etapa única
Rubro Comercial: Salud
Adquisición de UPS e Intercomunicador
1. Se comunica que según Disposición firma conjunta Nº 86/HSL/2025, ha resultado la adjudicación de la contratación de referencia de la siguiente manera:
Ofertas Adjudicadas
Mariano Aslan Joaquín
Renglón 1: 7 Unidad Precio Unitario: $ 1.701.502,00.- Precio Total $ 11.910.514,00
Baff S.R.L.
Renglón 2: 5 Unidad Precio Unitario: $ 71.400,00.- Precio Total $ 357.000,00
Total, de la adjudicación $ 12.267.514.000.- (pesos doce millones doscientos sesenta y siete mil quinientos catorce)
Marta Inés Starcenbaum Bouchez
Directora"""

RAMOS_MEJIA = """MINISTERIO DE SALUD
HOSPITAL GENERAL DE AGUDOS "DR. JOSÉ M. RAMOS MEJIA"
Preadjudicación - Contratación Menor BAC Nº 430-1064-CME24
Rubro Comercial: Salud
Objeto de la Contratación: Provision Nitrogeno Liquido – Dermatologia
Firma preadjudicada: Gases Comprimidos S.A
RENGLON CANTIDAD P. UNITARIO P. TOTAL
1 120 U $ 11.800,00 $ 1.416.000,00
Total Preadjudicado: pesos un millon cuatrocientos dieciseis mil ($ 1.416.000.000)
Legal: Ley 2095 art.103
Hugo Pandullo
Director"""

PENITENCIARIO = """MINISTERIO DE INFRAESTRUCTURA
Preadjudicación - Licitación Pública N° 381-0001-LPU24
Objeto de la contratación: Completamiento y finalización del Complejo Penitenciario Federal VII
Firma preadjudicada: CRIBA SA.
Renglón: 1 - cantidad: 1 - precio unitario: $ 96.984.788.780,00- precio total: $96.984.788.780,00.
Total preadjudicado: pesos noventa y seis mil novecientos ochenta y cuatro millones setecientos ochenta y ocho mil setecientos ochenta con 00/100 ($96.984.788.780,00.).
Pablo Bereciartua
Ministro"""


def test_monto_con_ceros_de_mas_se_corrige_por_letras():
    a = parsear_acto("Contratación Menor / Adjudicación N° 3742/HSL/25", SANTA_LUCIA)
    assert a.monto_total == 12_267_514
    assert a.monto_origen == "letras"
    ganadoras = {f.nombre: f.monto for f in a.firmas if f.rol == "adjudicada"}
    assert all(m is None or m <= a.monto_total for m in ganadoras.values())

    b = parsear_acto("Contratación Menor / Preadjudicación N° 1064/HGARM/24", RAMOS_MEJIA)
    assert b.monto_total == 1_416_000
    assert b.monto_origen == "letras"


def test_monto_grande_correcto_no_se_toca():
    a = parsear_acto("Licitación Pública / Preadjudicación N° 1/MIGC/24", PENITENCIARIO)
    assert a.monto_total == 96_984_788_780
    assert a.monto_origen == "texto"
