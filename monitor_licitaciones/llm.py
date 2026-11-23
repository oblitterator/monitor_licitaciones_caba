"""Respaldo con Claude Haiku para los actos que el parser por reglas dejó en confianza media o baja.

Flujo (dos comandos, el batch tarda de minutos a horas):
  llm-enviar [--dry-run]   arma un pedido por acto y los manda por la Message Batches API (50% más barata)
  llm-recolectar           baja los resultados, verifica cada valor contra el texto y guarda en bo.acto_llm

Principios:
  - NUNCA pisa el parseo por reglas (bo.acto / bo.acto_firma). Lo del modelo va a bo.acto_llm y la regla
    de mezcla está en SQL (sql/050_llm.sql, vista analitica.acto_consolidado).
  - Cada valor viene con una cita textual ("evidencia"). Se acepta solo si la cita aparece de verdad en el
    texto del PDF y contiene el valor (el número, el CUIT, el código o el nombre). Lo que no se verifica
    se descarta y queda listado en `rechazos`.
  - Clave idempotente: (id_norma, modelo, versión de prompt) + sha256 del PDF. Si el PDF cambia, se re-envía;
    si no, nunca se paga dos veces por el mismo texto.
  - La clave de la API sale de la variable de entorno ANTHROPIC_API_KEY (la lee el SDK). Acá no se lee ni se
    imprime nunca.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Iterable, Optional

import psycopg

from .db import Ejecucion
from .parser_actos import ETAPAS, a_numero, cuit_valido, monto_valido

log = logging.getLogger("monitor_licitaciones")

MODELO = "claude-haiku-5-5"
VERSION_PROMPT = "p1"            # subir si cambia SISTEMA, ESQUEMA o el armado del pedido
MAX_TOKENS = 4096                # el pensamiento adaptativo cuenta dentro de max_tokens
MAX_CARACTERES = 250_000         # ~80k tokens: arriba de 100k tokens Haiku cobra otra tarifa; esos no se mandan
PEDIDOS_POR_LOTE = 10_000        # la API acepta hasta 100.000 pedidos o 256 MB por batch
BYTES_POR_LOTE = 200_000_000
CONFIANZAS_DEFECTO = ("media", "baja")

ETAPAS_LLM = sorted({e for _, e in ETAPAS}) + ["otra"]
ROLES_LLM = ["adjudicada", "preadjudicada", "oferente", "desestimada", "mencionada"]
MONEDAS_LLM = ["ARS", "USD", "EUR"]

# Precios de Claude Haiku 5.5 (USD por millón de tokens, prompts de hasta 100k tokens).
PRECIO_ENTRADA = 0.10
PRECIO_SALIDA = 0.50
DESCUENTO_BATCH = 0.5
FACTOR_CACHE_ESCRITURA_1H = 2.0
FACTOR_CACHE_LECTURA = 0.1
CARACTERES_POR_TOKEN = 3.0       # castellano, a ojo y del lado conservador; count_tokens da el número exacto
TOKENS_SALIDA_ESTIMADOS = 600    # JSON + algo de pensamiento con effort=low


def _campo(tipo_valor: Any, descripcion: str) -> dict:
    return {
        "type": "object",
        "properties": {
            "valor": tipo_valor,
            "evidencia": {"type": ["string", "null"],
                          "description": "cita textual y literal del documento que contiene el valor; null si valor es null"},
        },
        "required": ["valor", "evidencia"],
        "additionalProperties": False,
        "description": descripcion,
    }


ESQUEMA: dict = {
    "type": "object",
    "properties": {
        "etapa": _campo({"type": ["string", "null"], "enum": ETAPAS_LLM + [None]},
                        "etapa del acto según el título del texto"),
        "codigo_proceso": _campo({"type": ["string", "null"]},
                                 "código BAC (p. ej. 401-0147-LPU22) o SIGAF viejo (5072/SIGAF/20)"),
        "monto_total": {
            "type": "object",
            "properties": {
                "valor": {"type": ["number", "null"]},
                "moneda": {"type": ["string", "null"], "enum": MONEDAS_LLM + [None]},
                "evidencia": {"type": ["string", "null"]},
            },
            "required": ["valor", "moneda", "evidencia"],
            "additionalProperties": False,
            "description": "total preadjudicado/adjudicado del acto",
        },
        "firmas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "nombre": {"type": "string"},
                    "rol": {"type": "string", "enum": ROLES_LLM},
                    "evidencia": {"type": "string", "description": "cita textual que contiene el nombre de la firma"},
                    "cuit": {"type": ["string", "null"], "description": "11 dígitos sin guiones; null si no figura"},
                    "cuit_evidencia": {"type": ["string", "null"]},
                    "monto": {"type": ["number", "null"]},
                    "moneda": {"type": ["string", "null"], "enum": MONEDAS_LLM + [None]},
                    "monto_evidencia": {"type": ["string", "null"]},
                },
                "required": ["nombre", "rol", "evidencia", "cuit", "cuit_evidencia", "monto", "moneda", "monto_evidencia"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["etapa", "codigo_proceso", "monto_total", "firmas"],
    "additionalProperties": False,
}

SISTEMA = """\
Sos un extractor de datos de actos de compras públicas publicados en la sección Licitaciones del \
Boletín Oficial de la Ciudad Autónoma de Buenos Aires. Te paso el título de la norma, el organismo, un \
resultado preliminar de un parser por reglas (que puede estar mal o incompleto) y el texto completo \
extraído del PDF. Devolvés un JSON que cumple el esquema pedido.

Regla de oro: devolvé solo lo que dice el texto. Si un dato no figura, va null (o la lista vacía). \
No completes con conocimiento propio, no deduzcas CUIT a partir del nombre y no hagas cuentas para \
inventar un total que el texto no da.

Evidencia: cada valor lleva una cita copiada LITERALMENTE del texto, carácter por carácter, de entre \
20 y 200 caracteres, que contenga el valor tal como aparece escrito (el número con sus puntos y comas, \
el CUIT con o sin guiones como esté en el texto, el código de proceso, el nombre de la firma). No \
resumas, no corrijas errores de tipeo, no uses puntos suspensivos y no juntes fragmentos de lugares \
distintos. Si no podés citar un valor, ponelo en null. Cada cita se verifica automáticamente contra el \
texto y lo que no aparece se descarta.

Etapa: tomala del título del acto dentro del texto (por ejemplo "Preadjudicación - Licitación Pública \
N° ..."); el título de la norma es un respaldo. Valores: llamado; apertura; preadjudicacion; \
adjudicacion; prorroga; circular_con_consulta; circular_sin_consulta; circular; ampliacion; \
rectificacion (rectificación, corrección, fe de erratas); deja_sin_efecto (anulación, revocación); \
fracasada (desierta o fracasada); modificacion (postergación o modificación); otra si no encaja.

Código de proceso: el código de Buenos Aires Compras con la forma UOA-NÚMERO-TIPOAA, por ejemplo \
401-0147-LPU22 o 433-0120-CME24 (LPU licitación pública, LPR privada, CME contratación menor, CDI \
contratación directa). En actos viejos puede venir como 5072/SIGAF/20. Devolvelo sin espacios. El \
número de expediente (EX-2023-...) NO es el código de proceso.

Monto total: es el total preadjudicado o adjudicado del acto. No es el presupuesto oficial, ni el monto \
de una garantía, ni un precio unitario, ni el precio de un renglón suelto, ni el monto de una oferta \
desestimada. Si el acto adjudica a varias firmas y el texto da un total general, usá ese total. Si solo \
hay montos por firma, dejá el total en null y poné cada monto en su firma. Los números vienen en \
formato argentino: 1.234.567,89 significa un millón doscientos treinta y cuatro mil quinientos sesenta \
y siete con 89 centavos; devolvelos como número JSON (1234567.89). Moneda: ARS para pesos ($), USD para \
dólares (U$S, USD, dólares estadounidenses), EUR para euros. Si hay un monto en dólares y su \
equivalente en pesos, informá la moneda en la que se adjudica. En llamados, prórrogas y circulares \
normalmente no hay monto adjudicado: null.

Firmas: las empresas o personas que aparecen como oferentes, preadjudicadas, adjudicadas o desestimadas. \
Rol: preadjudicada o adjudicada para la ganadora según la etapa; oferente para quien presentó oferta y \
no ganó ni fue desestimada; desestimada si el texto dice que su oferta se desestima, no se ajusta o no \
cumple; mencionada si solo se la nombra. No incluyas a los funcionarios que firman el acto ni a los \
organismos públicos. El nombre va tal como figura en el texto (razón social con su forma societaria). \
El CUIT va con 11 dígitos sin guiones y solo si figura en el texto junto a esa firma; si no, null. El \
monto de la firma va solo si el texto se lo asigna a esa firma; si no, null.
"""


# ---------------------------------------------------------------------------
# Pedidos
# ---------------------------------------------------------------------------
def custom_id(id_norma: int, sha256: Optional[str]) -> str:
    """'<id_norma>-<versión>-<sha[:16]>': cumple ^[A-Za-z0-9_-]{1,64}$ y cambia si cambia el PDF."""
    return f"{int(id_norma)}-{VERSION_PROMPT}-{(sha256 or 'sinsha')[:16]}"


def id_desde_custom_id(cid: str) -> int:
    return int(cid.split("-", 1)[0])


def armar_pedido(id_norma: int, nombre: Optional[str], organismo: Optional[str], texto: str,
                 sha256: Optional[str], pista: Optional[dict] = None) -> dict:
    contenido = (
        f"Título de la norma: {nombre or '-'}\n"
        f"Organismo: {organismo or '-'}\n"
        f"Resultado preliminar del parser por reglas (puede estar mal): "
        f"{json.dumps(pista or {}, ensure_ascii=False, default=str, sort_keys=True)}\n\n"
        f"<documento>\n{texto}\n</documento>"
    )
    return {
        "custom_id": custom_id(id_norma, sha256),
        "params": {
            "model": MODELO,
            "max_tokens": MAX_TOKENS,
            # prefijo común a todos los pedidos -> se cachea (TTL de 1 h: un batch puede tardar más de 5 min)
            "system": [{"type": "text", "text": SISTEMA, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": ESQUEMA}},
            "messages": [{"role": "user", "content": contenido}],
        },
    }


def estimar_costo(pedidos: list[dict]) -> dict:
    """Estimación a ojo (caracteres / CARACTERES_POR_TOKEN). Batch = 50% del precio."""
    n = len(pedidos)
    t_sis = (len(SISTEMA) + len(json.dumps(ESQUEMA))) / CARACTERES_POR_TOKEN
    t_usr = sum(len(p["params"]["messages"][0]["content"]) for p in pedidos) / CARACTERES_POR_TOKEN
    t_sal = TOKENS_SALIDA_ESTIMADOS * n
    sin_cache = ((n * t_sis + t_usr) * PRECIO_ENTRADA + t_sal * PRECIO_SALIDA) / 1e6 * DESCUENTO_BATCH
    con_cache = (((t_sis * FACTOR_CACHE_ESCRITURA_1H + max(0, n - 1) * t_sis * FACTOR_CACHE_LECTURA) if n else 0)
                 + t_usr) * PRECIO_ENTRADA / 1e6 * DESCUENTO_BATCH + t_sal * PRECIO_SALIDA / 1e6 * DESCUENTO_BATCH
    return {"pedidos": n, "modelo": MODELO, "version_prompt": VERSION_PROMPT,
            "tokens_entrada_est": int(n * t_sis + t_usr), "tokens_salida_est": int(t_sal),
            "costo_usd_est_sin_cache": round(sin_cache, 4), "costo_usd_est_con_cache": round(con_cache, 4)}


def partir_en_lotes(pedidos: list[dict], max_pedidos: int = PEDIDOS_POR_LOTE,
                    max_bytes: int = BYTES_POR_LOTE) -> list[list[dict]]:
    lotes, actual, bytes_ = [], [], 0
    for p in pedidos:
        b = len(json.dumps(p, ensure_ascii=False).encode())
        if actual and (len(actual) >= max_pedidos or bytes_ + b > max_bytes):
            lotes.append(actual)
            actual, bytes_ = [], 0
        actual.append(p)
        bytes_ += b
    if actual:
        lotes.append(actual)
    return lotes


# ---------------------------------------------------------------------------
# Verificación de evidencias
# ---------------------------------------------------------------------------
_COMILLAS = str.maketrans({"“": '"', "”": '"', "«": '"', "»": '"', "‘": "'", "’": "'", " ": " ",
                           "–": "-", "—": "-"})


def _compacto(s: Optional[str]) -> str:
    """Sin espacios ni saltos (el PDF parte líneas y palabras donde quiere), comillas unificadas, casefold."""
    return re.sub(r"\s+", "", (s or "").translate(_COMILLAS)).casefold()


def cita_en_texto(cita: Optional[str], texto_compacto: str, minimo: int = 4) -> bool:
    c = _compacto(cita)
    return len(c) >= minimo and c in texto_compacto


def _numeros(s: str) -> list[float]:
    out = []
    for m in re.finditer(r"\d[\d.,\s]*\d|\d", s or ""):
        v = a_numero(m.group(0))
        if v is not None:
            out.append(v)
    return out


def monto_en_cita(valor: float, cita: str) -> bool:
    return any(abs(v - valor) <= max(0.01, abs(valor) * 1e-9) for v in _numeros(cita))


_FORMATO_CODIGO = re.compile(r"^(\d{2,5}-\d{4}-[A-Z]{3}\d{2}|\d{1,6}/SIGAF/\d{2,4})$")


def validar_extraccion(datos: dict, texto: str) -> tuple[dict, list[str]]:
    """Devuelve (valores verificados, rechazos). Un valor sin cita, con una cita que no está en el texto o
    con una cita que no contiene el valor se descarta (queda None) y se anota en rechazos."""
    tc = _compacto(texto)
    rech: list[str] = []
    out: dict = {"etapa": None, "etapa_evidencia": None, "codigo_proceso": None, "codigo_evidencia": None,
                 "monto_total": None, "moneda": None, "monto_evidencia": None, "firmas": []}

    e = datos.get("etapa") or {}
    if e.get("valor") is not None:
        if e["valor"] in ETAPAS_LLM and cita_en_texto(e.get("evidencia"), tc):
            out["etapa"], out["etapa_evidencia"] = e["valor"], e["evidencia"]
        else:
            rech.append("etapa")

    c = datos.get("codigo_proceso") or {}
    if c.get("valor") is not None:
        cod = re.sub(r"\s+", "", str(c["valor"])).upper()
        if (_FORMATO_CODIGO.match(cod) and cita_en_texto(c.get("evidencia"), tc)
                and cod.casefold() in _compacto(c.get("evidencia"))):
            out["codigo_proceso"], out["codigo_evidencia"] = cod, c["evidencia"]
        else:
            rech.append("codigo_proceso")

    m = datos.get("monto_total") or {}
    if m.get("valor") is not None:
        v = float(m["valor"])
        if (monto_valido(v) and m.get("moneda") in MONEDAS_LLM and cita_en_texto(m.get("evidencia"), tc)
                and monto_en_cita(v, m["evidencia"])):
            out["monto_total"], out["moneda"], out["monto_evidencia"] = v, m["moneda"], m["evidencia"]
        else:
            rech.append("monto_total")

    for i, f in enumerate(datos.get("firmas") or []):
        nombre = (f.get("nombre") or "").strip()
        if (not nombre or f.get("rol") not in ROLES_LLM or not cita_en_texto(f.get("evidencia"), tc)
                or _compacto(nombre) not in _compacto(f.get("evidencia"))):
            rech.append(f"firmas[{i}]")
            continue
        firma = {"orden": len(out["firmas"]) + 1, "nombre": nombre, "rol": f["rol"], "evidencia": f["evidencia"],
                 "cuit": None, "monto": None, "moneda": None}
        if f.get("cuit") is not None:
            cuit = re.sub(r"\D", "", str(f["cuit"]))
            if (cuit_valido(cuit) and cita_en_texto(f.get("cuit_evidencia"), tc)
                    and cuit in re.sub(r"\D", "", f.get("cuit_evidencia") or "")):
                firma["cuit"] = int(cuit)
            else:
                rech.append(f"firmas[{i}].cuit")
        if f.get("monto") is not None:
            v = float(f["monto"])
            if (monto_valido(v) and f.get("moneda") in MONEDAS_LLM and cita_en_texto(f.get("monto_evidencia"), tc)
                    and monto_en_cita(v, f["monto_evidencia"])):
                firma["monto"], firma["moneda"] = v, f["moneda"]
            else:
                rech.append(f"firmas[{i}].monto")
        out["firmas"].append(firma)
    return out, rech


def interpretar_resultado(resultado: Any, texto: Optional[str]) -> dict:
    """Un elemento de client.messages.batches.results(...) -> columnas de bo.acto_llm."""
    r = resultado.result
    fila: dict = {"estado": "error", "respuesta": None, "rechazos": [], "error": None,
                  "tokens_entrada": None, "tokens_salida": None, "tokens_cache_lectura": None,
                  "tokens_cache_escritura": None, "etapa": None, "codigo_proceso": None, "monto_total": None,
                  "moneda": None, "firmas": [], "evidencias": {}}
    if r.type != "succeeded":
        err = getattr(r, "error", None)
        fila["error"] = f"{r.type}: {getattr(getattr(err, 'error', err), 'type', '') or ''}".rstrip(": ")
        return fila
    msg = r.message
    u = getattr(msg, "usage", None)
    if u is not None:
        fila.update(tokens_entrada=getattr(u, "input_tokens", None), tokens_salida=getattr(u, "output_tokens", None),
                    tokens_cache_lectura=getattr(u, "cache_read_input_tokens", None),
                    tokens_cache_escritura=getattr(u, "cache_creation_input_tokens", None))
    if msg.stop_reason in ("refusal", "max_tokens"):
        fila["error"] = f"stop_reason={msg.stop_reason}"
        return fila
    crudo = next((b.text for b in msg.content if getattr(b, "type", None) == "text"), None)
    try:
        datos = json.loads(crudo or "")
    except ValueError:
        fila["error"] = "respuesta no es JSON"
        return fila
    fila["respuesta"] = datos
    if texto is None:
        fila["error"] = "el documento ya no tiene texto"
        return fila
    ok, rech = validar_extraccion(datos, texto)
    fila.update(etapa=ok["etapa"], codigo_proceso=ok["codigo_proceso"], monto_total=ok["monto_total"],
                moneda=ok["moneda"], firmas=ok["firmas"], rechazos=rech,
                evidencias={k: ok[k] for k in ("etapa_evidencia", "codigo_evidencia", "monto_evidencia") if ok[k]})
    aceptado = any(ok[k] is not None for k in ("etapa", "codigo_proceso", "monto_total")) or ok["firmas"]
    fila["estado"] = "ok" if not rech else ("parcial" if aceptado else "rechazado")
    return fila


# ---------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------
def _cliente():
    try:
        import anthropic
    except ImportError as e:
        raise SystemExit("falta el SDK de Anthropic: pip install -e '.[llm]'") from e
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("definí la variable de entorno ANTHROPIC_API_KEY (o usá --dry-run)")
    return anthropic.Anthropic()


def actos_a_enviar(conn: psycopg.Connection, confianzas: Iterable[str] = CONFIANZAS_DEFECTO,
                   limite: Optional[int] = None) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT a.id_norma, n.nombre, n.organismo, d.texto, d.sha256,
                      a.etapa, a.codigo_proceso, a.monto_total, a.moneda, a.faltantes, a.confianza
               FROM bo.acto a JOIN bo.documento d USING (id_norma) JOIN bo.norma n USING (id_norma)
               LEFT JOIN bo.acto_llm l ON l.id_norma = a.id_norma AND l.modelo = %(m)s AND l.prompt_version = %(v)s
               WHERE a.confianza = ANY(%(c)s) AND d.estado = 'ok' AND d.texto IS NOT NULL
                 AND (l.id_norma IS NULL OR l.estado = 'error' OR l.documento_sha256 IS DISTINCT FROM d.sha256)
               ORDER BY n.fecha_publicacion DESC, a.id_norma DESC
               LIMIT %(lim)s""",
            {"m": MODELO, "v": VERSION_PROMPT, "c": list(confianzas), "lim": limite},
        )
        return cur.fetchall()


def armar_pedidos(filas: list[tuple]) -> tuple[list[dict], dict[str, tuple[int, Optional[str]]], int]:
    """-> (pedidos, custom_id -> (id_norma, sha256), omitidos por largo)"""
    pedidos, claves, omitidos = [], {}, 0
    for (id_norma, nombre, organismo, texto, sha, etapa, codigo, monto, moneda, faltantes, confianza) in filas:
        if len(texto) > MAX_CARACTERES:
            omitidos += 1
            continue
        pista = {"etapa": etapa, "codigo_proceso": codigo, "monto_total": float(monto) if monto is not None else None,
                 "moneda": moneda, "faltantes": list(faltantes or []), "confianza": confianza}
        p = armar_pedido(id_norma, nombre, organismo, texto, sha, pista)
        pedidos.append(p)
        claves[p["custom_id"]] = (id_norma, sha)
    return pedidos, claves, omitidos


def enviar(conn: psycopg.Connection, ej: Ejecucion, dry_run: bool = True,
           confianzas: Iterable[str] = CONFIANZAS_DEFECTO, limite: Optional[int] = None,
           archivo: Optional[str] = None) -> dict:
    pedidos, claves, omitidos = armar_pedidos(actos_a_enviar(conn, confianzas, limite))
    est = estimar_costo(pedidos)
    est["omitidos_por_largo"] = omitidos
    lotes = partir_en_lotes(pedidos)
    est["lotes"] = len(lotes)
    if archivo:
        with open(archivo, "w", encoding="utf-8") as fh:
            for p in pedidos:
                fh.write(json.dumps(p, ensure_ascii=False) + "\n")
        est["archivo"] = archivo
    ej.sumar("llm_pedidos", len(pedidos))
    ej.sumar("llm_omitidos_por_largo", omitidos)
    if dry_run or not pedidos:
        return est
    client = _cliente()
    for lote in lotes:
        batch = client.messages.batches.create(requests=lote)
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO ctl.lote_llm (lote_id, modelo, prompt_version, pedidos, costo_usd_est, estado_api, ejecucion_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (batch.id, MODELO, VERSION_PROMPT, len(lote), estimar_costo(lote)["costo_usd_est_con_cache"],
                 batch.processing_status, ej.id),
            )
            for p in lote:
                id_norma, sha = claves[p["custom_id"]]
                cur.execute(
                    """INSERT INTO bo.acto_llm (id_norma, modelo, prompt_version, documento_sha256, lote_id, custom_id, estado)
                       VALUES (%s,%s,%s,%s,%s,%s,'enviado')
                       ON CONFLICT (id_norma, modelo, prompt_version) DO UPDATE SET
                         documento_sha256 = EXCLUDED.documento_sha256, lote_id = EXCLUDED.lote_id,
                         custom_id = EXCLUDED.custom_id, estado = 'enviado', etapa = NULL, codigo_proceso = NULL,
                         monto_total = NULL, moneda = NULL, firmas = '[]', evidencias = '{}', rechazos = '{}',
                         respuesta = NULL, error = NULL, tokens_entrada = NULL, tokens_salida = NULL,
                         tokens_cache_lectura = NULL, tokens_cache_escritura = NULL,
                         enviado_en = now(), recibido_en = NULL""",
                    (id_norma, MODELO, VERSION_PROMPT, sha, batch.id, p["custom_id"]),
                )
        conn.commit()
        ej.sumar("llm_lotes")
        log.info("lote %s enviado: %d pedidos", batch.id, len(lote))
    return est


def guardar_resultado(cur: psycopg.Cursor, lote_id: str, modelo: str, version: str, cid: str, fila: dict,
                      sha: Optional[str]) -> None:
    cur.execute(
        """INSERT INTO bo.acto_llm (id_norma, modelo, prompt_version, documento_sha256, lote_id, custom_id, estado,
                                    etapa, codigo_proceso, monto_total, moneda, firmas, evidencias, rechazos, respuesta,
                                    error, tokens_entrada, tokens_salida, tokens_cache_lectura, tokens_cache_escritura,
                                    recibido_en)
           VALUES (%(id)s,%(m)s,%(v)s,%(sha)s,%(lote)s,%(cid)s,%(estado)s,%(etapa)s,%(cod)s,%(monto)s,%(moneda)s,
                   %(firmas)s,%(evid)s,%(rech)s,%(resp)s,%(err)s,%(te)s,%(ts)s,%(tcl)s,%(tce)s, now())
           ON CONFLICT (id_norma, modelo, prompt_version) DO UPDATE SET
             estado = EXCLUDED.estado, etapa = EXCLUDED.etapa, codigo_proceso = EXCLUDED.codigo_proceso,
             monto_total = EXCLUDED.monto_total, moneda = EXCLUDED.moneda, firmas = EXCLUDED.firmas,
             evidencias = EXCLUDED.evidencias, rechazos = EXCLUDED.rechazos, respuesta = EXCLUDED.respuesta,
             error = EXCLUDED.error, tokens_entrada = EXCLUDED.tokens_entrada, tokens_salida = EXCLUDED.tokens_salida,
             tokens_cache_lectura = EXCLUDED.tokens_cache_lectura,
             tokens_cache_escritura = EXCLUDED.tokens_cache_escritura, recibido_en = now()
           WHERE bo.acto_llm.custom_id = EXCLUDED.custom_id""",   # un resultado viejo no pisa un envío nuevo
        {"id": id_desde_custom_id(cid), "m": modelo, "v": version, "sha": sha, "lote": lote_id, "cid": cid,
         "estado": fila["estado"], "etapa": fila["etapa"], "cod": fila["codigo_proceso"], "monto": fila["monto_total"],
         "moneda": fila["moneda"], "firmas": json.dumps(fila["firmas"], ensure_ascii=False),
         "evid": json.dumps(fila["evidencias"], ensure_ascii=False), "rech": fila["rechazos"],
         "resp": json.dumps(fila["respuesta"], ensure_ascii=False) if fila["respuesta"] is not None else None,
         "err": fila["error"], "te": fila["tokens_entrada"], "ts": fila["tokens_salida"],
         "tcl": fila["tokens_cache_lectura"], "tce": fila["tokens_cache_escritura"]},
    )


def recolectar(conn: psycopg.Connection, ej: Ejecucion, lote_id: Optional[str] = None) -> None:
    with conn.cursor() as cur:
        cur.execute("""SELECT lote_id, modelo, prompt_version FROM ctl.lote_llm
                       WHERE recolectado_en IS NULL AND (%(l)s::text IS NULL OR lote_id = %(l)s) ORDER BY enviado_en""",
                    {"l": lote_id})
        lotes = cur.fetchall()
    if not lotes:
        log.info("no hay lotes pendientes de recolectar")
        return
    client = _cliente()
    for lid, modelo, version in lotes:
        b = client.messages.batches.retrieve(lid)
        with conn.cursor() as cur:
            cur.execute("UPDATE ctl.lote_llm SET estado_api = %s WHERE lote_id = %s", (b.processing_status, lid))
        conn.commit()
        if b.processing_status != "ended":
            ej.sumar("llm_lotes_en_proceso")
            log.info("lote %s: %s", lid, b.processing_status)
            continue
        for res in client.messages.batches.results(lid):
            cid = res.custom_id
            try:
                id_norma = id_desde_custom_id(cid)
                with conn.cursor() as cur:
                    cur.execute("SELECT texto, sha256 FROM bo.documento WHERE id_norma = %s", (id_norma,))
                    doc = cur.fetchone()
                texto, sha = (doc or (None, None))
                if sha is not None and custom_id(id_norma, sha) != cid:
                    texto = None   # el PDF cambió desde el envío: no se verifica contra otro texto
                fila = interpretar_resultado(res, texto)
                if fila["error"] == "el documento ya no tiene texto" and doc is not None:
                    fila["error"] = "el PDF cambió desde el envío"
                with conn.transaction(), conn.cursor() as cur:
                    guardar_resultado(cur, lid, modelo, version, cid, fila, sha)
                if fila["error"]:
                    ej.error("llm", id_norma, fila["error"])
                else:
                    ej.resolver("llm", id_norma)
                ej.sumar(f"llm_{fila['estado']}")
            except Exception as e:  # noqa: BLE001 - se registra y se sigue
                ej.error("llm", cid, f"{type(e).__name__}: {e}")
                ej.sumar("llm_error_guardando")
        with conn.cursor() as cur:
            cur.execute("UPDATE ctl.lote_llm SET recolectado_en = now() WHERE lote_id = %s", (lid,))
        conn.commit()
        log.info("lote %s recolectado", lid)
