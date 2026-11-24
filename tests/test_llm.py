"""Respaldo con LLM: esquema, verificación de citas y armado de pedidos (sin API ni base)."""
import json
import re
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from monitor_licitaciones import llm

_FIX = Path(__file__).parent / "fixtures"
CASO = next(c for c in json.loads((_FIX / "actos.json").read_text(encoding="utf-8")) if c["id_norma"] == 753702)
TEXTO = CASO["texto"]

BUENO = {
    "etapa": {"valor": "adjudicacion", "evidencia": "Adjudicación - Contratación Directa N° 101-1426-CDI23"},
    "codigo_proceso": {"valor": "101-1426-CDI23", "evidencia": "Contratación Directa N° 101-1426-CDI23 \nObjeto"},
    "monto_total": {"valor": 5000000.0, "moneda": "ARS",
                    "evidencia": "Total adjudicado: pesos cinco millones con 00/100 ($5.000.000,00.)"},
    "firmas": [{"nombre": "Cefeidas Group S.A.", "rol": "adjudicada",
                "evidencia": "Razón Social de la Empresa: Cefeidas Group S.A.",
                "cuit": "33712483089", "cuit_evidencia": "Cefeidas Group S.A. (CUIT N° 33-71248308-9)",
                "monto": None, "moneda": None, "monto_evidencia": None}],
}


def _copia(**cambios):
    d = json.loads(json.dumps(BUENO))
    for k, v in cambios.items():
        d[k] = v
    return d


# --- esquema ---------------------------------------------------------------
def _objetos(s):
    if isinstance(s, dict):
        if s.get("type") == "object":
            yield s
        for v in s.values():
            yield from _objetos(v)
    elif isinstance(s, list):
        for v in s:
            yield from _objetos(v)


def test_esquema_apto_para_structured_outputs():
    objs = list(_objetos(llm.ESQUEMA))
    assert len(objs) >= 5
    for o in objs:
        assert o["additionalProperties"] is False
        assert set(o["required"]) == set(o["properties"])
    texto = json.dumps(llm.ESQUEMA)
    for prohibido in ("minimum", "maximum", "minLength", "maxLength", "pattern"):
        assert f'"{prohibido}"' not in texto
    props = llm.ESQUEMA["properties"]
    assert set(props) == {"etapa", "codigo_proceso", "monto_total", "firmas"}
    firma = props["firmas"]["items"]["properties"]
    assert {"rol", "cuit", "monto", "evidencia"} <= set(firma)
    assert "adjudicacion" in props["etapa"]["properties"]["valor"]["enum"]


# --- verificación de citas -------------------------------------------------
def test_todo_verificado():
    ok, rech = llm.validar_extraccion(BUENO, TEXTO)
    assert rech == []
    assert ok["etapa"] == "adjudicacion" and ok["codigo_proceso"] == "101-1426-CDI23"
    assert ok["monto_total"] == 5000000.0 and ok["moneda"] == "ARS"
    assert ok["firmas"][0]["cuit"] == 33712483089 and ok["firmas"][0]["rol"] == "adjudicada"


def test_cita_que_cruza_un_salto_de_linea():
    # en el texto: 'Objeto  de  la  contratación:  "Servicio  de  asesoramiento  técnico  para  el  diseño  y \nelaboración'
    assert llm.cita_en_texto('Servicio de asesoramiento técnico para el diseño y elaboración', llm._compacto(TEXTO))
    assert llm.cita_en_texto("“Servicio de asesoramiento”".replace("“", '"').replace("”", ""), llm._compacto(TEXTO))


def test_cita_inventada_se_rechaza():
    d = _copia(monto_total={"valor": 5000000.0, "moneda": "ARS", "evidencia": "Monto adjudicado: $5.000.000,00"})
    ok, rech = llm.validar_extraccion(d, TEXTO)
    assert ok["monto_total"] is None and rech == ["monto_total"]


def test_cita_real_que_no_contiene_el_valor_se_rechaza():
    d = _copia(monto_total={"valor": 6000000.0, "moneda": "ARS",
                            "evidencia": "Total adjudicado: pesos cinco millones con 00/100 ($5.000.000,00.)"})
    ok, rech = llm.validar_extraccion(d, TEXTO)
    assert ok["monto_total"] is None and "monto_total" in rech
    # el código tiene que estar dentro de la cita
    d = _copia(codigo_proceso={"valor": "101-1427-CDI23", "evidencia": "Contratación Directa N° 101-1426-CDI23"})
    assert llm.validar_extraccion(d, TEXTO)[1] == ["codigo_proceso"]
    # y con formato de código BAC o SIGAF
    d = _copia(codigo_proceso={"valor": "EX-2023-30328981", "evidencia": "EX-2023- 30328981-GCABA-DGTEA"})
    assert llm.validar_extraccion(d, TEXTO)[1] == ["codigo_proceso"]


def test_cuit_con_digito_verificador_mal_se_descarta_pero_la_firma_queda():
    d = _copia()
    d["firmas"][0]["cuit"] = "33712483088"
    ok, rech = llm.validar_extraccion(d, TEXTO)
    assert rech == ["firmas[0].cuit"]
    assert ok["firmas"][0]["nombre"] == "Cefeidas Group S.A." and ok["firmas"][0]["cuit"] is None


def test_firma_sin_su_nombre_en_la_cita_se_descarta():
    d = _copia()
    d["firmas"].append({"nombre": "Otra Empresa S.R.L.", "rol": "oferente", "evidencia": "Razón Social de la Empresa",
                        "cuit": None, "cuit_evidencia": None, "monto": None, "moneda": None, "monto_evidencia": None})
    ok, rech = llm.validar_extraccion(d, TEXTO)
    assert rech == ["firmas[1]"] and [f["nombre"] for f in ok["firmas"]] == ["Cefeidas Group S.A."]


def test_valores_nulos_no_son_rechazos():
    d = {"etapa": {"valor": None, "evidencia": None}, "codigo_proceso": {"valor": None, "evidencia": None},
         "monto_total": {"valor": None, "moneda": None, "evidencia": None}, "firmas": []}
    assert llm.validar_extraccion(d, TEXTO) == (
        {"etapa": None, "etapa_evidencia": None, "codigo_proceso": None, "codigo_evidencia": None,
         "monto_total": None, "moneda": None, "monto_evidencia": None, "firmas": []}, [])


# --- resultados del batch --------------------------------------------------
def _ok(datos, stop="end_turn", previo=()):
    contenido = list(previo) + [NS(type="text", text=json.dumps(datos, ensure_ascii=False))]
    usage = NS(input_tokens=1200, output_tokens=300, cache_read_input_tokens=900, cache_creation_input_tokens=0)
    return NS(custom_id="753702-p1-abc", result=NS(type="succeeded",
                                                   message=NS(content=contenido, stop_reason=stop, usage=usage)))


def test_interpretar_resultado_ok_con_pensamiento_previo():
    f = llm.interpretar_resultado(_ok(BUENO, previo=[NS(type="thinking", thinking="")]), TEXTO)
    assert f["estado"] == "ok" and f["error"] is None and f["monto_total"] == 5000000.0
    assert f["tokens_cache_lectura"] == 900 and f["respuesta"] == BUENO


def test_interpretar_resultado_parcial_y_rechazado():
    d = _copia(monto_total={"valor": 1.0, "moneda": "ARS", "evidencia": "no está"})
    assert llm.interpretar_resultado(_ok(d), TEXTO)["estado"] == "parcial"
    nada = {"etapa": {"valor": "llamado", "evidencia": "inventado"}, "codigo_proceso": {"valor": None, "evidencia": None},
            "monto_total": {"valor": None, "moneda": None, "evidencia": None}, "firmas": []}
    assert llm.interpretar_resultado(_ok(nada), TEXTO)["estado"] == "rechazado"


@pytest.mark.parametrize("res,err", [
    (_ok(BUENO, stop="refusal"), "stop_reason=refusal"),
    (_ok(BUENO, stop="max_tokens"), "stop_reason=max_tokens"),
    (NS(custom_id="1-p1-x", result=NS(type="errored", error=NS(error=NS(type="overloaded_error")))), "errored: overloaded_error"),
    (NS(custom_id="1-p1-x", result=NS(type="expired")), "expired"),
])
def test_interpretar_resultado_errores(res, err):
    f = llm.interpretar_resultado(res, TEXTO)
    assert f["estado"] == "error" and f["error"] == err


def test_interpretar_resultado_no_json():
    r = _ok(BUENO)
    r.result.message.content[-1].text = "no es json"
    assert llm.interpretar_resultado(r, TEXTO)["error"] == "respuesta no es JSON"


# --- pedidos y dry-run -----------------------------------------------------
def test_armar_pedido():
    p = llm.armar_pedido(753702, CASO["nombre"], "SSRIN", TEXTO, "a" * 64, {"monto_total": None})
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", p["custom_id"]) and p["custom_id"] == "753702-p1-" + "a" * 16
    assert llm.id_desde_custom_id(p["custom_id"]) == 753702
    q = p["params"]
    assert q["model"] == "claude-haiku-5-5"
    assert q["system"][0]["text"] == llm.SISTEMA and q["system"][0]["cache_control"]["type"] == "ephemeral"
    assert q["output_config"]["format"] == {"type": "json_schema", "schema": llm.ESQUEMA}
    assert not {"temperature", "top_p", "top_k", "thinking"} & set(q)
    assert TEXTO in q["messages"][0]["content"]          # el texto va completo, sin recortar
    # el prefijo cacheado es idéntico entre pedidos (nada variable en system)
    p2 = llm.armar_pedido(1, "x", "y", "otro texto", None)
    assert p2["params"]["system"] == q["system"] and p2["custom_id"] == "1-p1-sinsha"


def test_sistema_supera_el_minimo_cacheable():
    assert len(llm.SISTEMA) / 4 > 512        # incluso contando 4 caracteres por token


def _fila(i, texto=TEXTO, conf="media"):
    return (i, CASO["nombre"], "SSRIN", texto, f"{i:064d}", "adjudicacion", None, None, None, ["codigo_proceso"], conf)


def test_armar_pedidos_omite_textos_enormes():
    pedidos, claves, omitidos = llm.armar_pedidos([_fila(1), _fila(2, "x" * (llm.MAX_CARACTERES + 1))])
    assert len(pedidos) == 1 and omitidos == 1 and claves[pedidos[0]["custom_id"]] == (1, f"{1:064d}")
    assert '"faltantes": ["codigo_proceso"]' in pedidos[0]["params"]["messages"][0]["content"]


def test_estimar_costo():
    pedidos, _, _ = llm.armar_pedidos([_fila(i) for i in range(1, 101)])
    e = llm.estimar_costo(pedidos)
    assert e["pedidos"] == 100 and e["tokens_entrada_est"] > 0
    assert 0 < e["costo_usd_est_con_cache"] < e["costo_usd_est_sin_cache"] < 1
    assert llm.estimar_costo([])["costo_usd_est_sin_cache"] == 0


def test_partir_en_lotes():
    pedidos, _, _ = llm.armar_pedidos([_fila(i) for i in range(1, 8)])
    assert [len(x) for x in llm.partir_en_lotes(pedidos, max_pedidos=3)] == [3, 3, 1]
    un = len(json.dumps(pedidos[0], ensure_ascii=False).encode())
    assert [len(x) for x in llm.partir_en_lotes(pedidos, max_bytes=2 * un + 10)] == [2, 2, 2, 1]


class EjFalsa:
    id = 1

    def __init__(self):
        self.resumen = {}

    def sumar(self, k, n=1):
        self.resumen[k] = self.resumen.get(k, 0) + n


def test_dry_run_no_llama_a_la_api(monkeypatch, tmp_path):
    monkeypatch.setattr(llm, "actos_a_enviar", lambda conn, confianzas, limite: [_fila(1), _fila(2, conf="baja")])

    def prohibido():
        raise AssertionError("dry-run no debe crear el cliente")
    monkeypatch.setattr(llm, "_cliente", prohibido)
    ej = EjFalsa()
    archivo = tmp_path / "pedidos.jsonl"
    est = llm.enviar(None, ej, dry_run=True, archivo=str(archivo))
    assert est["pedidos"] == 2 and est["lotes"] == 1 and est["costo_usd_est_con_cache"] > 0
    assert ej.resumen["llm_pedidos"] == 2
    lineas = archivo.read_text(encoding="utf-8").splitlines()
    assert [json.loads(x)["custom_id"].split("-")[0] for x in lineas] == ["1", "2"]
