"""Monitor de Licitaciones CABA — app local de consulta (solo lectura).

Uso:  streamlit run app/monitor.py
Requiere MLC_DSN con la conexión a la base.
"""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st

from monitor_licitaciones.consultas import Base

st.set_page_config(page_title="Monitor de Licitaciones CABA", page_icon="📑", layout="wide")



# ---------------------------------------------------------------------------
# Datos
# ---------------------------------------------------------------------------
@st.cache_resource
def base() -> Base:
    return Base(timeout_s=120)


@st.cache_data(ttl=600, show_spinner="Consultando…")
def q(sql: str, params: tuple | dict = ()) -> pd.DataFrame:
    return base().df(sql, params or None)


LINK = st.column_config.LinkColumn("documento", display_text="abrir")

# Etiquetas y ayudas de columnas: se aplican a todas las tablas de la app
COLUMNAS = {
    "pct_oferta_unica": ("% con oferta única",
        "De los procesos en los que el Boletín informa cuántas ofertas hubo, porcentaje que tuvo una sola oferta."),
    "procesos_con_dato": ("procesos con dato de ofertas",
        "Procesos en los que el Boletín informa la cantidad de ofertas (base del porcentaje de oferta única)."),
    "oferta_unica": ("procesos con oferta única", None),
    "promedio_ofertas": ("ofertas promedio", "Promedio de ofertas por proceso, sobre los procesos con dato."),
    "pct_principal": ("% del monto del principal",
        "Porcentaje del monto total del organismo en el año que se llevó su proveedor principal."),
    "hhi": ("concentración (HHI)",
        "Índice Herfindahl-Hirschman, de 0 a 10.000. Más de 2.500 = mercado muy concentrado en pocos proveedores."),
    "pct_excepcion_cantidad": ("% de procesos por directa o menor",
        "Porcentaje de los procesos del organismo en el año que se hicieron por contratación directa o menor "
        "(procedimientos con menos competencia que la licitación)."),
    "pct_excepcion_monto_nominal": ("% del monto por directa o menor",
        "Porcentaje del monto del organismo en el año adjudicado por contratación directa o menor."),
    "pct_monto": ("% del monto del organismo",
        "Porcentaje del monto total del organismo (en el período elegido) que se llevó este proveedor."),
    "pct_diferencia": ("% de diferencia", "Diferencia entre la suma de montos por firma y el total declarado en el acto."),
    "max_en_90_dias": ("contrataciones en 90 días",
        "Máxima cantidad de contrataciones directas o menores al mismo proveedor, en el mismo organismo, en 90 días."),
    "supera_tope": ("supera el tope sumado", "Solo se calcula si se cargaron los topes por procedimiento."),
    "dias_desde_constitucion": ("días desde la constitución", "Días entre el contrato social y el acto en que ganó."),
    "n_ganadoras": ("firmas ganadoras del acto", None),
    "monto_asignado": ("monto", None), "monto_total": ("monto total", None), "monto": ("monto", None),
    "monto_original": ("monto publicado", "Monto tal como se leyó del acto, antes de excluirlo por dudoso."),
    "monto_revision": ("motivo de exclusión", "Por qué el monto no se suma en los totales."),
    "monto_aprox": ("monto aproximado", None), "monto_nominal_ars": ("monto (ARS)", None),
    "procesos_ganados": ("procesos ganados", None), "codigo_proceso": ("proceso", None),
    "tipo_proc": ("procedimiento", "LPU = licitación pública · CME = contratación menor · CDI = contratación directa"),
    "categoria": ("categoría", "Clasificación por reglas sobre el objeto del acto (o el rubro declarado si el objeto no alcanza)."),
    "subcategoria": ("subcategoría", None),
    "jurisdiccion": ("jurisdicción", "Ministerio o área de la que depende la unidad, según el Boletín Oficial."),
    "poder": ("poder", None), "tipo_unidad": ("tipo de unidad", None), "unidades": ("unidades", None),
    "pct_monto_total": ("% del monto", "Porcentaje del monto total del período y filtros elegidos."),
    "objeto": ("objeto", "Los nombres de pacientes, cuando el acto los publica, aparecen reemplazados por una marca."),
    "objeto_enmascarado": ("objeto (enmascarado)", None),
    "n_menciones_paciente": ("menciones de pacientes", "Cantidad de nombres de pacientes detectados en el texto publicado."),
    "url_norma": None,   # se usa LINK
}
_DINERO = {"monto_asignado", "monto_total", "monto", "monto_aprox", "monto_nominal_ars", "monto_original",
           "monto_a", "monto_b"}


def tabla(df: pd.DataFrame, **kw):
    cfg = {}
    for c in df.columns:
        if c == "url_norma":
            cfg[c] = LINK
        elif c in COLUMNAS and COLUMNAS[c]:
            etiqueta, ayuda = COLUMNAS[c]
            if c in _DINERO:
                df = df.assign(**{c: (pd.to_numeric(df[c], errors="coerce") / 1e6).round(1)})
                cfg[c] = st.column_config.NumberColumn(f"{etiqueta} (millones $)", format="localized",
                                                       help=(ayuda + " " if ayuda else "") + "En millones de pesos.")
            else:
                cfg[c] = st.column_config.Column(etiqueta, help=ayuda)
    st.dataframe(df, hide_index=True, width="stretch", column_config=cfg, **kw)

try:
    rango = q("SELECT min(anio) AS a0, max(anio) AS a1 FROM analitica.ganador")
except Exception as e:  # noqa: BLE001
    st.error(f"No se pudo conectar a la base. Revisá la variable MLC_DSN.\n\n{e}")
    st.stop()

A0 = int(rango.a0[0]) if pd.notna(rango.a0[0]) else 2019
A1 = int(rango.a1[0]) if pd.notna(rango.a1[0]) else 2024

# ---------------------------------------------------------------------------
# Barra lateral: sección y filtros globales
# ---------------------------------------------------------------------------
st.sidebar.title("📑 Monitor de Licitaciones")
seccion = st.sidebar.radio("Sección", ["Resumen", "Comparar", "Qué se compra", "Proveedores", "Organismos", "Señales",
                                       "Funcionarios", "Calidad de datos", "Operación"])
if A0 < A1:
    desde, hasta = st.sidebar.slider("Años", A0, A1, (A0, A1))
else:
    desde, hasta = A0, A1

with st.sidebar.expander("Filtros", expanded=True):
    _jer = q("""SELECT DISTINCT poder, jurisdiccion FROM analitica.ganador ORDER BY 1, 2""")
    f_poder = st.multiselect("Poder", sorted(_jer.poder.unique()), placeholder="Todos")
    _jur_opc = sorted(_jer[_jer.poder.isin(f_poder)].jurisdiccion.unique() if f_poder else _jer.jurisdiccion.unique())
    f_jur = st.multiselect("Jurisdicción", _jur_opc, placeholder="Todas",
                           help="Ministerio o área de la que depende la unidad, según el Boletín Oficial.")
    _cats = q("SELECT DISTINCT coalesce(categoria, '(sin clasificar)') AS c FROM analitica.ganador ORDER BY 1").c.tolist()
    f_cat = st.multiselect("Categoría", _cats, placeholder="Todas")
    _procs = {"LPU": "Licitación pública", "LPR": "Licitación privada", "CME": "Contratación menor",
              "CDI": "Contratación directa"}
    f_proc = st.multiselect("Procedimiento", list(_procs), format_func=lambda k: f"{k} · {_procs[k]}",
                            placeholder="Todos")
    _orgs = q("""SELECT organismo_id, max(organismo) AS organismo, max(jurisdiccion) AS jurisdiccion,
                        max(poder) AS poder
                 FROM analitica.ganador WHERE organismo_id IS NOT NULL GROUP BY 1 ORDER BY 2""")
    if f_jur:
        _orgs = _orgs[_orgs.jurisdiccion.isin(f_jur)]
    elif f_poder:
        _orgs = _orgs[_orgs.poder.isin(f_poder)]
    _org_lbl = {r.organismo_id: f"{r.jurisdiccion} › {r.organismo}" for r in _orgs.itertuples()}
    f_org = st.multiselect("Unidad (organismo que compra)", list(_org_lbl), format_func=lambda k: _org_lbl.get(k, k), placeholder="Todos")
    f_txt = st.text_input("Texto en el objeto", placeholder="p. ej. marcapasos, raciones, software")
    f_min = st.number_input("Monto mínimo por adjudicación (ARS)", min_value=0, value=0, step=1_000_000)
st.sidebar.caption("Los filtros se aplican a todo lo que sale de adjudicaciones (resumen, qué se compra, "
                   "proveedores, organismos). Las señales agregadas por organismo y año solo filtran por año.")

# La app puede quedar más nueva que la base (falta correr «Actualizar estructura»): avisar en vez de romper
ESTRUCTURA_AL_DIA = bool(base().df("""SELECT count(*) AS n FROM information_schema.columns
                                      WHERE table_schema = 'analitica' AND table_name = 'ganador'
                                        AND column_name = 'monto_revision'""").n[0])
if not ESTRUCTURA_AL_DIA and seccion != "Operación":
    st.error("**La base tiene la estructura de una versión anterior del monitor.** Andá a **Operación** (barra "
             "lateral) y apretá **«Actualizar estructura»** en el grupo Mantenimiento. Tarda 1 o 2 minutos; después, "
             "«Actualizar datos».")
    st.stop()

hay_ipc = q("SELECT count(*) AS n FROM ref.ipc").n[0] > 0
st.sidebar.caption("Montos en " + ("**pesos constantes**" if hay_ipc else "**pesos nominales** (sin IPC cargado)"))
if st.sidebar.button("Actualizar datos"):
    st.cache_data.clear()
    st.rerun()
MONTO = "coalesce(monto_constante, monto_asignado)" if hay_ipc else "monto_asignado"
MONTO_G = "coalesce(g.monto_constante, g.monto_asignado)" if hay_ipc else "g.monto_asignado"


def filtro(alias: str = "g", anio: str | None = None, monto: str | None = None,
           jerarquia: bool = True) -> tuple[str, dict]:
    """WHERE común a consultas sobre analitica.ganador (alias g) o analitica.proceso.
    jerarquia=False ignora poder, jurisdicción y unidad (para comparar entre ellas)."""
    p = f"{alias}." if alias else ""
    anio = anio or f"{p}anio"
    monto = monto or f"{p}monto_asignado"
    w = [f"{anio} BETWEEN %(desde)s AND %(hasta)s"]
    prm: dict = {"desde": desde, "hasta": hasta}
    if f_poder and jerarquia:
        w.append(f"{p}poder = ANY(%(poderes)s)"); prm["poderes"] = list(f_poder)
    if f_jur and jerarquia:
        w.append(f"{p}jurisdiccion = ANY(%(jurs)s)"); prm["jurs"] = list(f_jur)
    if f_cat:
        w.append(f"coalesce({p}categoria, '(sin clasificar)') = ANY(%(cats)s)"); prm["cats"] = list(f_cat)
    if f_proc:
        w.append(f"{p}tipo_proc = ANY(%(procs)s)"); prm["procs"] = list(f_proc)
    if f_org and jerarquia:
        w.append(f"{p}organismo_id = ANY(%(orgs)s)"); prm["orgs"] = list(f_org)
    if f_txt.strip():
        w.append(f"{p}objeto ILIKE %(txt)s"); prm["txt"] = f"%{f_txt.strip()}%"
    if f_min:
        w.append(f"{monto} >= %(minimo)s"); prm["minimo"] = f_min
    return " AND ".join(w), prm


FG, PG = filtro("g")
FP, PP = filtro("p", anio="extract(year FROM coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion))",
                monto="coalesce(p.monto_adjudicado, p.monto_preadjudicado)")


def con(extra: dict | None = None, base_: dict | None = None) -> dict:
    d = dict(base_ if base_ is not None else PG)
    d.update(extra or {})
    return d


def _num(x: float, dec: int) -> str:
    return f"{x:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def fmt_monto(x) -> str:
    """Monto en palabras, como se lee en castellano: $ 1,2 billones · $ 345,6 mil millones · $ 12,3 millones."""
    if x is None or pd.isna(x):
        return "s/d"
    a = abs(float(x))
    for div, nombre in ((1e12, "billones"), (1e9, "mil millones"), (1e6, "millones"), (1e3, "mil")):
        if a >= div:
            v = x / div
            if div == 1e12 and round(v, 2) == 1:
                nombre = "billón"
            if div == 1e6 and round(v, 1) == 1:
                nombre = "millón"
            return f"$ {_num(v, 1 if v < 100 else 0)} {nombre}"
    return f"$ {_num(x, 0)}"


def en_mm(serie):
    """Para gráficos: miles de millones de pesos."""
    return serie / 1e9


EJE_MM = "miles de millones de $"


# ---------------------------------------------------------------------------
# Resumen
# ---------------------------------------------------------------------------
def resumen():
    st.title("Resumen")
    k = q(f"""SELECT count(DISTINCT g.codigo_proceso) AS procesos, count(DISTINCT g.cuit) AS proveedores,
                     count(DISTINCT g.organismo_id) AS organismos,
                     sum({MONTO_G}) FILTER (WHERE g.moneda = 'ARS') AS monto
              FROM analitica.ganador g WHERE {FG}""", PG)
    u = q(f"""SELECT round(100.0 * count(*) FILTER (WHERE p.unica_oferta) / nullif(count(*) FILTER (WHERE p.unica_oferta IS NOT NULL), 0), 1) AS pct,
                    count(*) FILTER (WHERE p.unica_oferta IS NOT NULL) AS con_dato
             FROM analitica.proceso p WHERE {FP}""", PP)
    c = st.columns(5)
    c[0].metric("Procesos con adjudicatario", f"{int(k.procesos[0] or 0):,}".replace(",", "."))
    c[1].metric("Proveedores (CUIT)", f"{int(k.proveedores[0] or 0):,}".replace(",", "."))
    c[2].metric("Organismos", f"{int(k.organismos[0] or 0):,}".replace(",", "."))
    c[3].metric("Monto asignado", fmt_monto(k.monto[0]),
                help="Suma de lo adjudicado a ganadores, sin los montos excluidos por dudosos (ver Calidad de datos).")
    c[4].metric("Procesos con oferta única", f"{_num(u.pct[0] or 0, 1)} %",
                help=f"De los {int(u.con_dato[0] or 0)} procesos en los que el Boletín informa cuántas ofertas hubo, "
                     "porcentaje que tuvo una sola oferta. En el resto de los procesos el dato no figura.")

    evo = q(f"""SELECT g.anio, count(DISTINCT g.codigo_proceso) AS procesos,
                       sum({MONTO_G}) FILTER (WHERE g.moneda='ARS') / 1e9 AS monto_mm
                FROM analitica.ganador g WHERE {FG} GROUP BY g.anio ORDER BY g.anio""", PG)
    a, b = st.columns(2)
    a.subheader("Procesos por año"); a.bar_chart(evo, x="anio", y="procesos")
    b.subheader("Monto asignado por año"); b.caption(EJE_MM); b.bar_chart(evo, x="anio", y="monto_mm")

    st.subheader("Monto por jurisdicción")
    st.caption(f"Gráfico en {EJE_MM}; tabla en millones.")
    jur = q(f"""SELECT g.poder, g.jurisdiccion, count(DISTINCT g.organismo_id) AS unidades,
                       count(DISTINCT g.codigo_proceso) AS procesos, sum({MONTO_G}) AS monto
                FROM analitica.ganador g WHERE g.moneda = 'ARS' AND {FG}
                GROUP BY 1, 2 ORDER BY monto DESC NULLS LAST""", PG)
    if not jur.empty:
        jur["pct_monto_total"] = (100 * jur.monto / jur.monto.sum()).round(1)
        st.bar_chart(jur.head(15).assign(monto_mm=en_mm(jur.monto)), x="jurisdiccion", y="monto_mm",
                     horizontal=True, height=max(160, 32 * min(len(jur), 15)))
        tabla(jur)

    st.subheader("Proveedores con más monto asignado")
    top = q(f"""SELECT g.cuit, max(e.razon_social) AS proveedor, count(DISTINCT g.codigo_proceso) AS procesos,
                       count(DISTINCT g.organismo_id) AS organismos,
                       mode() WITHIN GROUP (ORDER BY g.categoria) AS categoria, sum({MONTO_G}) AS monto
                FROM analitica.ganador g LEFT JOIN ref.empresa e ON e.cuit = g.cuit
                WHERE g.cuit IS NOT NULL AND g.moneda = 'ARS' AND {FG}
                GROUP BY g.cuit ORDER BY monto DESC NULLS LAST LIMIT 20""", PG)
    tabla(top)


# ---------------------------------------------------------------------------
# Qué se compra
# ---------------------------------------------------------------------------
def que_se_compra():
    st.title("Qué se compra")
    st.caption("Categorías asignadas por reglas sobre el objeto de cada proceso (tabla `ref.categoria_regla`). "
               "Monto asignado a ganadores; no incluye procesos cuyo monto no se puede repartir entre varias firmas.")
    cat = q(f"""SELECT coalesce(g.categoria, '(sin clasificar)') AS categoria,
                       count(DISTINCT g.codigo_proceso) AS procesos, count(DISTINCT g.cuit) AS proveedores,
                       sum({MONTO_G}) AS monto
                FROM analitica.ganador g WHERE g.moneda = 'ARS' AND {FG}
                GROUP BY 1 ORDER BY monto DESC NULLS LAST""", PG)
    if cat.empty:
        st.info("Sin adjudicaciones con los filtros elegidos.")
        return
    cat["pct_monto_total"] = (100 * cat.monto / cat.monto.sum()).round(1)
    a, b = st.columns([3, 2])
    a.subheader("Monto por categoría"); a.caption(EJE_MM)
    a.bar_chart(cat.assign(monto_mm=en_mm(cat.monto)), x="categoria", y="monto_mm", horizontal=True)
    with b:
        st.subheader("Detalle")
        tabla(cat)

    st.divider()
    elegida = st.selectbox("Ver una categoría", cat.categoria.tolist())
    pc = con({"cat_sel": elegida})
    sub = q(f"""SELECT coalesce(nullif(g.subcategoria, ''), '(sin subcategoría)') AS subcategoria,
                       count(DISTINCT g.codigo_proceso) AS procesos, sum({MONTO_G}) AS monto
                FROM analitica.ganador g
                WHERE g.moneda = 'ARS' AND coalesce(g.categoria, '(sin clasificar)') = %(cat_sel)s AND {FG}
                GROUP BY 1 ORDER BY monto DESC NULLS LAST""", pc)
    if len(sub) > 1:
        st.subheader("Subcategorías"); st.caption(EJE_MM)
        st.bar_chart(sub.assign(monto_mm=en_mm(sub.monto)), x="subcategoria", y="monto_mm", horizontal=True)
    a, b = st.columns(2)
    with a:
        st.subheader("Proveedores principales")
        tabla(q(f"""SELECT g.cuit, max(e.razon_social) AS proveedor, count(DISTINCT g.codigo_proceso) AS procesos,
                           sum({MONTO_G}) AS monto,
                           round(100 * sum({MONTO_G}) / nullif(sum(sum({MONTO_G})) OVER (), 0), 1) AS pct_monto_total
                    FROM analitica.ganador g LEFT JOIN ref.empresa e ON e.cuit = g.cuit
                    WHERE g.cuit IS NOT NULL AND g.moneda = 'ARS'
                      AND coalesce(g.categoria, '(sin clasificar)') = %(cat_sel)s AND {FG}
                    GROUP BY g.cuit ORDER BY monto DESC NULLS LAST LIMIT 25""", pc))
    with b:
        st.subheader("Organismos que más compran")
        tabla(q(f"""SELECT max(g.jurisdiccion) AS jurisdiccion, max(g.organismo) AS organismo,
                           count(DISTINCT g.codigo_proceso) AS procesos,
                           sum({MONTO_G}) AS monto,
                           round(100 * sum({MONTO_G}) / nullif(sum(sum({MONTO_G})) OVER (), 0), 1) AS pct_monto_total
                    FROM analitica.ganador g
                    WHERE g.moneda = 'ARS' AND coalesce(g.categoria, '(sin clasificar)') = %(cat_sel)s AND {FG}
                    GROUP BY g.organismo_id ORDER BY monto DESC NULLS LAST LIMIT 25""", pc))
    st.subheader("Procesos")
    tabla(q(f"""SELECT g.fecha_publicacion AS fecha, g.codigo_proceso, g.tipo_proc, g.organismo, g.subcategoria,
                       g.objeto, coalesce(e.razon_social, g.nombre_raw) AS proveedor, g.monto_asignado, n.url_norma
                FROM analitica.ganador g JOIN bo.norma n ON n.id_norma = g.id_norma
                LEFT JOIN ref.empresa e ON e.cuit = g.cuit
                WHERE coalesce(g.categoria, '(sin clasificar)') = %(cat_sel)s AND {FG}
                ORDER BY g.monto_asignado DESC NULLS LAST LIMIT 300""", pc))


# ---------------------------------------------------------------------------
# Proveedores
# ---------------------------------------------------------------------------
SENALES_PROVEEDOR = """
  SELECT 'Posible fraccionamiento' AS senal, count(*)::text AS detalle FROM analitica.s_fraccionamiento WHERE cuit = %(c)s HAVING count(*) > 0
  UNION ALL
  SELECT 'Empresa nueva al ganar', string_agg(DISTINCT dias_desde_constitucion::text || ' días', ', ') FROM analitica.s_empresa_nueva WHERE cuit = %(c)s HAVING count(*) > 0
  UNION ALL
  SELECT 'Domicilio compartido con otro oferente', count(*)::text FROM analitica.s_domicilio_compartido WHERE %(c)s IN (cuit_1, cuit_2) HAVING count(*) > 0
  UNION ALL
  SELECT 'Principal proveedor en organismo concentrado (HHI > 2500)', string_agg(organismo || ' ' || anio, ', ')
  FROM analitica.s_concentracion WHERE cuit_principal = %(c)s AND hhi > 2500 AND proveedores >= 5 HAVING count(*) > 0
"""


def proveedores():
    st.title("Proveedores")
    texto = st.text_input("Buscar por razón social o CUIT", placeholder="p. ej. ALGIERI o 30699339810")
    if not texto.strip():
        st.caption("Ingresá parte del nombre o el CUIT completo.")
        return
    t = texto.strip()
    if t.replace("-", "").isdigit():
        res = q("""SELECT p.cuit, p.razon_social, p.procesos_ganados, p.monto_nominal_ars FROM analitica.proveedor p
                   WHERE p.cuit = %s""", (int(t.replace("-", "")),))
    else:
        res = q("""SELECT p.cuit, p.razon_social, p.procesos_ganados, p.monto_nominal_ars FROM analitica.proveedor p
                   WHERE p.razon_social ILIKE %s ORDER BY p.monto_nominal_ars DESC NULLS LAST LIMIT 50""", (f"%{t}%",))
    if res.empty:
        st.warning("Sin resultados entre proveedores con adjudicaciones. Puede figurar sin CUIT resuelto (ver Calidad de datos).")
        return
    opciones = {f"{r.razon_social} — {r.cuit} ({int(r.procesos_ganados)} procesos)": int(r.cuit) for r in res.itertuples()}
    cuit = opciones[st.selectbox("Proveedor", list(opciones))]

    f = q("SELECT * FROM analitica.proveedor WHERE cuit = %s", (cuit,))
    e = q("SELECT tipo_societario, fecha_contrato_social, dom_fiscal, fuente FROM ref.empresa WHERE cuit = %s", (cuit,))
    st.subheader(f"{f.razon_social[0]}  ·  CUIT {cuit}")
    c = st.columns(5)
    c[0].metric("Procesos ganados", int(f.procesos_ganados[0]))
    c[1].metric("Organismos", int(f.organismos[0]))
    c[2].metric("Monto nominal", fmt_monto(f.monto_nominal_ars[0]))
    c[3].metric("Ganó con oferta única", "s/d" if pd.isna(f.pct_oferta_unica[0]) else f"{f.pct_oferta_unica[0]:.0f}%",
                help="De los procesos que ganó y en los que el Boletín informa cuántas ofertas hubo, "
                     "porcentaje en que fue el único oferente.")
    c[4].metric("Ganó por directa o menor", f"{f.pct_excepcion[0]:.0f}%",
                help="Porcentaje de los procesos que ganó que fueron contrataciones directas o menores.")
    if not e.empty:
        st.caption(f"Tipo: {e.tipo_societario[0] or 's/d'} · Constitución: {e.fecha_contrato_social[0] or 's/d'} · "
                   f"Domicilio fiscal: {e.dom_fiscal[0] or 's/d'} · Fuente padrón: {e.fuente[0]}")

    s = base().df(SENALES_PROVEEDOR, {"c": cuit})
    if s.empty:
        st.success("No aparece en ninguna señal.")
    else:
        st.warning("Aparece en estas señales:")
        tabla(s)

    pc = con({"cuit": cuit})
    st.subheader("En qué gana")
    ec = q(f"""SELECT coalesce(g.categoria, '(sin clasificar)') AS categoria,
                      coalesce(nullif(g.subcategoria, ''), '') AS subcategoria,
                      count(DISTINCT g.codigo_proceso) AS procesos, sum({MONTO_G}) AS monto
               FROM analitica.ganador g WHERE g.cuit = %(cuit)s AND g.moneda = 'ARS' AND {FG}
               GROUP BY 1, 2 ORDER BY monto DESC NULLS LAST""", pc)
    if not ec.empty:
        ec["pct_monto_total"] = (100 * ec.monto / ec.monto.sum()).round(1)
        a, b = st.columns([2, 3])
        a.bar_chart(en_mm(ec.groupby("categoria").monto.sum().sort_values()), horizontal=True)
        with b:
            tabla(ec)

    autoridades_igj(cuit)

    st.subheader("Adjudicaciones")
    adj = q(f"""SELECT g.fecha_publicacion AS fecha, g.codigo_proceso, g.tipo_proc, g.organismo, g.etapa,
                      g.categoria, g.monto_asignado, g.moneda, g.n_ganadoras, g.objeto, n.url_norma
               FROM analitica.ganador g
               JOIN bo.norma n ON n.id_norma = g.id_norma
               WHERE g.cuit = %(cuit)s AND {FG} ORDER BY g.fecha_publicacion DESC""", pc)
    tabla(adj)
    if adj.empty:
        return
    st.subheader("Por organismo")
    st.bar_chart(adj.groupby("organismo").size().sort_values(ascending=False).head(15))


# ---------------------------------------------------------------------------
# Organismos
# ---------------------------------------------------------------------------
def organismos():
    st.title("Organismos")
    with st.expander("Estructura: poder › jurisdicción › unidades que compran", expanded=False):
        jer = q(f"""SELECT g.poder, g.jurisdiccion, g.tipo_unidad, max(g.organismo) AS organismo,
                           count(DISTINCT g.codigo_proceso) AS procesos, sum({MONTO_G}) AS monto
                    FROM analitica.ganador g WHERE g.moneda = 'ARS' AND {FG}
                    GROUP BY g.poder, g.jurisdiccion, g.tipo_unidad, g.organismo_id
                    ORDER BY g.poder, g.jurisdiccion, monto DESC NULLS LAST""", PG)
        tabla(jer)
        st.caption("Jurisdicción según el campo «entidad» que publica el Boletín. Para corregir una unidad: "
                   "editar `ref.unidad` y poner `origen = 'manual'`; los renombres de ministerios van en "
                   "`ref.jurisdiccion_alias`.")

    lista = q(f"""SELECT p.organismo_id, max(p.organismo) AS organismo, max(p.jurisdiccion) AS jurisdiccion,
                         count(*) AS procesos
                  FROM analitica.proceso p WHERE p.organismo_id IS NOT NULL AND {FP}
                  GROUP BY 1 ORDER BY jurisdiccion, procesos DESC""", PP)
    if lista.empty:
        st.info("Sin procesos con los filtros elegidos.")
        return
    etiquetas = {f"{r.jurisdiccion} › {r.organismo} — {int(r.procesos)} procesos": r.organismo_id
                 for r in lista.itertuples()}
    oid = etiquetas[st.selectbox("Unidad", list(etiquetas))]

    conc = q("""SELECT c.anio, c.hhi, c.pct_principal, c.proveedores, e.razon_social AS principal
                FROM analitica.s_concentracion c LEFT JOIN ref.empresa e ON e.cuit = c.cuit_principal
                WHERE c.organismo_id = %s AND c.anio BETWEEN %s AND %s ORDER BY c.anio""", (oid, desde, hasta))
    comp = q("""SELECT anio, procesos, procesos_con_dato, pct_oferta_unica FROM analitica.s_competencia
                WHERE organismo_id = %s AND anio BETWEEN %s AND %s ORDER BY anio""", (oid, desde, hasta))
    proc = q("""SELECT anio, procesos, directas, menores, pct_excepcion_cantidad FROM analitica.s_procedimiento
                WHERE organismo_id = %s AND anio BETWEEN %s AND %s ORDER BY anio""", (oid, desde, hasta))
    a, b = st.columns(2)
    a.subheader("Concentración (HHI)"); a.line_chart(conc, x="anio", y="hhi")
    b.subheader("% de procesos por contratación directa o menor"); b.line_chart(proc, x="anio", y="pct_excepcion_cantidad")
    anual = (conc.merge(comp, on="anio", how="outer")
                 .merge(proc.drop(columns="procesos"), on="anio", how="outer").sort_values("anio"))
    tabla(anual)

    po = con({"oid": oid})
    st.subheader("En qué gasta")
    eg = q(f"""SELECT coalesce(g.categoria, '(sin clasificar)') AS categoria,
                      coalesce(nullif(g.subcategoria, ''), '') AS subcategoria,
                      count(DISTINCT g.codigo_proceso) AS procesos, sum({MONTO_G}) AS monto
               FROM analitica.ganador g WHERE g.organismo_id = %(oid)s AND g.moneda = 'ARS' AND {FG}
               GROUP BY 1, 2 ORDER BY monto DESC NULLS LAST""", po)
    if not eg.empty:
        eg["pct_monto_total"] = (100 * eg.monto / eg.monto.sum()).round(1)
        a, b = st.columns([2, 3])
        a.bar_chart(en_mm(eg.groupby("categoria").monto.sum().sort_values()), horizontal=True)
        with b:
            tabla(eg)

    st.subheader("Principales proveedores del organismo")
    top = q(f"""SELECT g.cuit, max(e.razon_social) AS proveedor, count(DISTINCT g.codigo_proceso) AS procesos,
                       mode() WITHIN GROUP (ORDER BY g.categoria) AS categoria, sum({MONTO_G}) AS monto,
                       round(100 * sum({MONTO_G}) / nullif(sum(sum({MONTO_G})) OVER (), 0), 1) AS pct_monto
                FROM analitica.ganador g LEFT JOIN ref.empresa e ON e.cuit = g.cuit
                WHERE g.organismo_id = %(oid)s AND g.moneda = 'ARS' AND {FG}
                GROUP BY g.cuit ORDER BY monto DESC NULLS LAST LIMIT 25""", po)
    tabla(top)


# ---------------------------------------------------------------------------
# Señales
# ---------------------------------------------------------------------------
def senales():
    st.title("Señales")
    t = st.tabs(["Oferta única", "Concentración", "Procedimientos de excepción", "Fraccionamiento",
                 "Empresas nuevas", "Domicilio compartido", "Modificaciones", "Autoridades compartidas"])
    with t[0]:
        minimo = st.number_input("Mínimo de procesos con dato", 1, 500, 20, key="min_comp")
        tabla(q("""SELECT organismo, anio, procesos, procesos_con_dato, oferta_unica, pct_oferta_unica, promedio_ofertas
                          FROM analitica.s_competencia WHERE procesos_con_dato >= %s AND anio BETWEEN %s AND %s
                          ORDER BY pct_oferta_unica DESC NULLS LAST""", (minimo, desde, hasta)))
    with t[1]:
        st.caption("HHI > 2.500 = alta concentración. Se excluyen organismo-año con menos de 5 proveedores.")
        tabla(q("""SELECT c.organismo, c.anio, c.hhi, c.pct_principal, c.proveedores, e.razon_social AS principal,
                                 c.cuit_principal, c.monto_total
                          FROM analitica.s_concentracion c LEFT JOIN ref.empresa e ON e.cuit = c.cuit_principal
                          WHERE c.proveedores >= 5 AND c.anio BETWEEN %s AND %s ORDER BY c.hhi DESC""", (desde, hasta)))
    with t[2]:
        tabla(q("""SELECT organismo, anio, procesos, directas, menores, pct_excepcion_cantidad, pct_excepcion_monto_nominal
                          FROM analitica.s_procedimiento WHERE procesos >= 20 AND anio BETWEEN %s AND %s
                          ORDER BY pct_excepcion_cantidad DESC""", (desde, hasta)))
    with t[3]:
        st.caption("3+ contrataciones menores/directas al mismo proveedor, mismo organismo, en 90 días.")
        tabla(q("""SELECT f.organismo, f.cuit, e.razon_social, max(f.n_90d) AS max_en_90_dias,
                                 sum(f.monto_asignado) AS monto, bool_or(f.supera_tope_acumulado) AS supera_tope,
                                 min(f.fecha) AS desde, max(f.fecha) AS hasta
                          FROM analitica.s_fraccionamiento f LEFT JOIN ref.empresa e ON e.cuit = f.cuit
                          WHERE extract(year FROM f.fecha) BETWEEN %s AND %s
                          GROUP BY 1, 2, 3 ORDER BY max_en_90_dias DESC, monto DESC NULLS LAST""", (desde, hasta)))
    with t[4]:
        tabla(q("""SELECT * FROM analitica.s_empresa_nueva WHERE extract(year FROM fecha_publicacion) BETWEEN %s AND %s
                          ORDER BY dias_desde_constitucion""", (desde, hasta)))
    with t[5]:
        tabla(q("""SELECT * FROM analitica.s_domicilio_compartido WHERE extract(year FROM fecha_publicacion) BETWEEN %s AND %s
                          ORDER BY fecha_publicacion DESC""", (desde, hasta)))
    with t[6]:
        tabla(q("""SELECT * FROM analitica.s_modificaciones
                          WHERE extract(year FROM fecha_adjudicacion) BETWEEN %s AND %s OR fecha_adjudicacion IS NULL
                          ORDER BY n_prorrogas + n_ampliaciones + n_modificaciones DESC LIMIT 200""", (desde, hasta)))
    with t[7]:
        st.caption("Dos firmas del mismo proceso que comparten una persona (mismo documento) entre sus autoridades o "
                   "socios en IGJ. Si compiten entre sí, puede no haber competencia real. IGJ es histórico: el vínculo "
                   "puede ser anterior al proceso; «ambos en último corte» indica que la persona sigue figurando en las dos.")
        solo = st.toggle("Solo personas que figuran en ambas en el último corte", value=True)
        tabla(q("""SELECT fecha_publicacion AS fecha, codigo_proceso, organismo, persona, numero_documento,
                          firma_1, rol_acto_1, rol_igj_1, firma_2, rol_acto_2, rol_igj_2, ambos_en_ultimo_corte, url_norma
                   FROM analitica.s_autoridad_compartida
                   WHERE extract(year FROM fecha_publicacion) BETWEEN %s AND %s AND (ambos_en_ultimo_corte OR NOT %s)
                   ORDER BY fecha_publicacion DESC""", (desde, hasta, solo)))


# ---------------------------------------------------------------------------
# Comparar: dos jurisdicciones o unidades, o una contra toda la Ciudad
# ---------------------------------------------------------------------------
FGC, PGC = filtro("g", jerarquia=False)
FPC, PPC = filtro("p", anio="extract(year FROM coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion))",
                  monto="coalesce(p.monto_adjudicado, p.monto_preadjudicado)", jerarquia=False)
TODA = "Toda la Ciudad"

# (clave, etiqueta, formato, ayuda). Formato: monto | n | pct | dec
INDICADORES = [
    ("monto", "Monto adjudicado", "monto", "Suma de lo adjudicado a ganadores en el período, sin montos dudosos."),
    ("procesos", "Procesos adjudicados", "n", None),
    ("mediana", "Monto típico por proceso", "monto", "Mediana: la mitad de los procesos está por debajo de este monto."),
    ("proveedores", "Proveedores distintos", "n", "Firmas con CUIT identificado que ganaron al menos un proceso."),
    ("pct_monto_exc", "% del monto por directa o menor", "pct",
     "Parte del monto adjudicada por contratación directa o menor, procedimientos con menos competencia."),
    ("pct_proc_exc", "% de procesos por directa o menor", "pct", None),
    ("pct_unica", "% de procesos con oferta única", "pct",
     "Sobre los procesos en los que el Boletín informa cuántas ofertas hubo."),
    ("prom_ofertas", "Ofertas promedio por proceso", "dec", "Sobre los procesos con dato de ofertas."),
    ("pct_top5", "% del monto en los 5 principales proveedores", "pct",
     "Concentración: cuánto del monto se llevaron los 5 proveedores que más ganaron."),
    ("hhi", "Concentración (HHI)", "n",
     "Índice Herfindahl-Hirschman de 0 a 10.000 sobre los proveedores. Más de 2.500 = muy concentrado."),
    ("pct_nuevas", "% del monto a empresas de menos de 1 año", "pct",
     "Monto ganado por sociedades que tenían menos de un año de constituidas al ganar."),
    ("pct_modif", "% de procesos con prórrogas o ampliaciones", "pct", None),
    ("pct_sin_cuit", "% del monto sin CUIT identificado", "pct",
     "Calidad del dato: monto de ganadores que no se pudieron identificar en el padrón."),
    ("pacientes", "Procesos que publican nombres de pacientes", "n", None),
]


def _fmt_ind(v, tipo: str) -> str:
    if v is None or pd.isna(v):
        return "s/d"
    if tipo == "monto":
        return fmt_monto(v)
    if tipo == "pct":
        return f"{_num(v, 1)} %"
    if tipo == "dec":
        return _num(v, 1)
    return _num(v, 0)


def indicadores(cond_g: str, cond_p: str, prm: dict) -> dict:
    pg = {**PGC, **prm}
    pp = {**PPC, **prm}
    g = q(f"""
      WITH g AS (SELECT g.*, {MONTO_G} AS m FROM analitica.ganador g
                 WHERE g.moneda = 'ARS' AND {FGC} AND {cond_g}),
      proc AS (SELECT codigo_proceso, sum(m) AS m, max(tipo_proc) AS tp FROM g GROUP BY 1),
      prov AS (SELECT cuit, sum(m) AS m FROM g WHERE cuit IS NOT NULL AND m IS NOT NULL GROUP BY 1),
      tot AS (SELECT nullif(sum(m), 0) AS t FROM prov)
      SELECT (SELECT sum(m) FROM g) AS monto,
             (SELECT count(*) FROM proc) AS procesos,
             (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY m) FROM proc WHERE m > 0) AS mediana,
             (SELECT count(*) FROM prov) AS proveedores,
             (SELECT 100 * sum(m) FILTER (WHERE tp IN ('CDI','CME')) / nullif(sum(m), 0) FROM proc) AS pct_monto_exc,
             (SELECT 100.0 * count(*) FILTER (WHERE tp IN ('CDI','CME')) / nullif(count(*), 0) FROM proc) AS pct_proc_exc,
             (SELECT 100 * sum(m) / (SELECT t FROM tot) FROM (SELECT m FROM prov ORDER BY m DESC LIMIT 5) x) AS pct_top5,
             (SELECT sum(power(100 * m / (SELECT t FROM tot), 2)) FROM prov) AS hhi,
             (SELECT 100 * sum(g.m) / nullif((SELECT sum(m) FROM g), 0) FROM g JOIN ref.empresa e ON e.cuit = g.cuit
               WHERE g.fecha_publicacion::date - e.fecha_contrato_social::date BETWEEN 0 AND 364) AS pct_nuevas,
             (SELECT 100 * sum(m) FILTER (WHERE cuit IS NULL) / nullif(sum(m), 0) FROM g) AS pct_sin_cuit
    """, pg).iloc[0].to_dict()
    p = q(f"""SELECT 100.0 * count(*) FILTER (WHERE p.unica_oferta)
                       / nullif(count(*) FILTER (WHERE p.unica_oferta IS NOT NULL), 0) AS pct_unica,
                     avg(p.n_ofertas) AS prom_ofertas,
                     100.0 * count(*) FILTER (WHERE p.n_prorrogas + p.n_ampliaciones > 0) / nullif(count(*), 0) AS pct_modif,
                     count(*) FILTER (WHERE p.datos_paciente) AS pacientes
              FROM analitica.proceso p WHERE {FPC} AND {cond_p}""", pp).iloc[0].to_dict()
    return {**g, **p}


def comparar():
    st.title("Comparar")
    st.caption("Indicadores lado a lado. Se aplican los años y los filtros de categoría, procedimiento, texto y "
               "monto de la barra lateral; poder, jurisdicción y unidad se eligen acá.")
    nivel = st.radio("Comparar", ["Jurisdicciones", "Unidades"], horizontal=True)
    if nivel == "Jurisdicciones":
        opc = q("SELECT DISTINCT jurisdiccion FROM analitica.ganador ORDER BY 1").jurisdiccion.tolist()
        etiqueta = {o: o for o in opc}
        col_g, col_p = "g.jurisdiccion", "p.jurisdiccion"
    else:
        u = q("""SELECT organismo_id, max(jurisdiccion) AS jurisdiccion, max(organismo) AS organismo
                 FROM analitica.ganador WHERE organismo_id IS NOT NULL GROUP BY 1 ORDER BY 2, 3""")
        opc = u.organismo_id.tolist()
        etiqueta = {r.organismo_id: f"{r.jurisdiccion} › {r.organismo}" for r in u.itertuples()}
        col_g, col_p = "g.organismo_id", "p.organismo_id"
    opciones = [TODA] + opc
    nombre = lambda k: k if k == TODA else etiqueta.get(k, k)  # noqa: E731
    a_col, b_col = st.columns(2)
    sel_a = a_col.selectbox("A", opciones, index=1 if len(opciones) > 1 else 0, format_func=nombre)
    sel_b = b_col.selectbox("B", opciones, index=0, format_func=nombre)

    def cond(sel, col, k):
        return ("true", {}) if sel == TODA else (f"{col} = %({k})s", {k: sel})

    ga, pa = cond(sel_a, col_g, "sel_a"), cond(sel_a, col_p, "sel_a")
    gb, pb = cond(sel_b, col_g, "sel_b"), cond(sel_b, col_p, "sel_b")
    ia = indicadores(ga[0], pa[0], ga[1])
    ib = indicadores(gb[0], pb[0], gb[1])
    na, nb = nombre(sel_a), nombre(sel_b)

    filas = []
    for k, etiq, tipo, ayuda in INDICADORES:
        va, vb = ia.get(k), ib.get(k)
        dif = ""
        if va is not None and vb is not None and not pd.isna(va) and not pd.isna(vb):
            if tipo == "pct":
                dif = f"{'+' if va - vb >= 0 else ''}{_num(va - vb, 1)} pp"
            elif vb:
                r = va / vb
                dif = (f"{_num(r, 1)} veces B" if r >= 1 else f"{_num(100 * r, 1)} % de B")
        filas.append({"indicador": etiq, "A": _fmt_ind(va, tipo), "B": _fmt_ind(vb, tipo), "A frente a B": dif,
                      "qué mide": ayuda or ""})
    st.dataframe(pd.DataFrame(filas), hide_index=True, width="stretch",
                 column_config={"A": st.column_config.Column(na[:40]), "B": st.column_config.Column(nb[:40]),
                                "A frente a B": st.column_config.Column(
                                    "A frente a B", help="En porcentajes, diferencia en puntos (pp); en montos y "
                                                         "cantidades, cuántas veces B es A, o qué porcentaje de B representa.")})
    if sel_b == TODA and sel_a != TODA and ia.get("monto") and ib.get("monto"):
        st.caption(f"{na} explica el {_num(100 * ia['monto'] / ib['monto'], 1)} % del monto de toda la Ciudad "
                   "con estos filtros.")

    st.subheader("Monto por año")
    st.caption(EJE_MM)
    evo = []
    for sel, (cg, prm), nom in ((sel_a, ga, "A"), (sel_b, gb, "B")):
        d = q(f"""SELECT g.anio, sum({MONTO_G}) / 1e9 AS monto FROM analitica.ganador g
                  WHERE g.moneda = 'ARS' AND {FGC} AND {cg} GROUP BY 1""", {**PGC, **prm})
        evo.append(d.set_index("anio").monto.rename(f"{nom}: {nombre(sel)[:30]}"))
    st.line_chart(pd.concat(evo, axis=1).sort_index())

    st.subheader("En qué gasta cada uno")
    st.caption("Porcentaje del monto de cada lado que va a cada categoría (así se comparan tamaños distintos).")
    mix = []
    for sel, (cg, prm), nom in ((sel_a, ga, "A"), (sel_b, gb, "B")):
        d = q(f"""SELECT coalesce(g.categoria, '(sin clasificar)') AS categoria, sum({MONTO_G}) AS monto
                  FROM analitica.ganador g WHERE g.moneda = 'ARS' AND {FGC} AND {cg} GROUP BY 1""", {**PGC, **prm})
        if not d.empty:
            mix.append((100 * d.set_index("categoria").monto / d.monto.sum()).rename(f"{nom}: {nombre(sel)[:30]}"))
    if mix:
        m = pd.concat(mix, axis=1).fillna(0).round(1)
        m = m.loc[m.max(axis=1).sort_values(ascending=False).index]
        st.bar_chart(m, horizontal=True, stack=False, height=max(240, 34 * len(m)))


# ---------------------------------------------------------------------------
# Calidad
# ---------------------------------------------------------------------------
def calidad():
    st.title("Calidad de datos")
    datos_personales()
    a, b = st.columns(2)
    with a:
        st.subheader("Documentos")
        tabla(q("SELECT estado, sum(documentos) AS documentos FROM analitica.calidad_documentos GROUP BY 1 ORDER BY 2 DESC"))
    with b:
        st.subheader("Resolución de CUIT (ganadoras)")
        tabla(q("""SELECT resolucion, sum(firmas) AS firmas FROM analitica.calidad_resolucion
                   WHERE rol IN ('adjudicada','preadjudicada') GROUP BY 1 ORDER BY 2 DESC"""))
    st.subheader("Parser por año (adjudicación y preadjudicación)")
    cp = q("""SELECT anio, etapa, actos, pct_alta, pct_con_monto, pct_con_codigo FROM analitica.calidad_parser
              WHERE etapa IN ('adjudicacion','preadjudicacion') ORDER BY anio, etapa""")
    tabla(cp)

    st.subheader("Clasificación de compras")
    cc = q("""SELECT categoria, sum(actos) AS actos, sum(por_rubro) AS por_rubro, sum(con_subcategoria) AS con_subcategoria
              FROM analitica.calidad_clasificacion WHERE anio BETWEEN %s AND %s GROUP BY 1 ORDER BY 2 DESC""", (desde, hasta))
    if not cc.empty:
        sin = cc.loc[cc.categoria == "(sin clasificar)", "actos"].sum()
        st.caption(f"{100 * (1 - sin / cc.actos.sum()):.1f}% de los actos de adjudicación/preadjudicación clasificados. "
                   "Para mejorar: agregar reglas con origen 'manual' en `ref.categoria_regla` y correr `clasificar`.")
        tabla(cc)

    a, b = st.columns(2)
    with a:
        st.subheader("IGJ")
        ci = q("SELECT * FROM analitica.calidad_igj")
        cortes = q("SELECT max(periodo) AS ultimo, count(*) AS cortes FROM igj.corte")
        if ci.empty or not int(ci.proveedores[0] or 0) or not int(cortes.cortes[0]):
            st.caption("Sin datos de IGJ cargados.")
        else:
            r = ci.iloc[0]
            st.metric("Proveedores encontrados en IGJ", f"{int(r.en_igj)} de {int(r.proveedores)}",
                      help="Proveedores con CUIT que figuran como entidad en IGJ. Los que no están suelen ser "
                           "personas humanas, extranjeras o inscriptas en otra jurisdicción.")
            st.caption(f"Con autoridades cargadas: {int(r.con_autoridades)} · personas humanas: {int(r.personas_humanas)} · "
                       f"último corte: {cortes.ultimo[0]} ({int(cortes.cortes[0])} cortes)")
    with b:
        st.subheader("Funcionarios")
        cf = q("SELECT * FROM analitica.calidad_funcionarios")
        if cf.empty or not int(cf.normas_encoladas[0] or 0):
            st.caption("Sin designaciones cargadas.")
        else:
            r = cf.iloc[0]
            st.metric("Normas parseadas", f"{int(r.normas_parseadas)} de {int(r.normas_encoladas)}",
                      help="Decretos y resoluciones de designación/cese de gerente para arriba.")
            st.caption(f"Sin documento descargado: {int(r.normas_sin_documento)} · personas: {int(r.personas)} · "
                       f"en IGJ: {int(r.personas_en_igj)} · menciones sin nivel identificado: {int(r.menciones_sin_nivel)}")

    with st.expander("Jurisdicciones que cambiaron de nombre (se muestran unificadas)"):
        st.caption("Solo renombres: la misma estructura con otro nombre. Las divisiones no se unifican (Justicia y "
                   "Seguridad hasta 2023 → Justicia + Seguridad; Ambiente y Espacio Público hasta 2020 → Espacio "
                   "Público e Higiene Urbana + Secretaría de Ambiente). Para agregar uno: "
                   "`INSERT INTO ref.jurisdiccion_alias (nombre_publicado, jurisdiccion) VALUES ('<viejo>', '<actual>');` "
                   "y luego «Actualizar estructura».")
        st.dataframe(q("""SELECT nombre_publicado AS "nombre publicado", jurisdiccion AS "se muestra como", origen
                          FROM ref.jurisdiccion_alias ORDER BY 2, 1"""), hide_index=True, width="stretch")

    st.subheader("Montos excluidos por dudosos")
    ex = q("""SELECT g.monto_revision, count(*) AS adjudicaciones, sum(g.monto_original) AS monto_original
              FROM analitica.ganador g WHERE g.monto_revision IS NOT NULL AND g.anio BETWEEN %s AND %s
              GROUP BY 1 ORDER BY 2 DESC""", (desde, hasta))
    tot = q("""SELECT count(*) AS n, sum(monto_original) FILTER (WHERE monto_revision IS NULL) AS incluido
               FROM analitica.ganador WHERE moneda = 'ARS' AND anio BETWEEN %s AND %s""", (desde, hasta))
    if ex.empty:
        st.caption("No hay montos excluidos en el período.")
    else:
        st.caption(f"{int(ex.adjudicaciones.sum())} de {int(tot.n[0])} adjudicaciones tienen un monto que no se suma en "
                   f"ningún total ({fmt_monto(ex.monto_original.sum())} publicados, contra {fmt_monto(tot.incluido[0])} "
                   "que sí se suman). Se descartan cuando el acto se contradice a sí mismo o el monto es imposible "
                   "para el procedimiento. Los ceros de más que se pueden corregir con el monto en letras o con la "
                   "suma de renglones ya vienen corregidos desde el parser.")
        tabla(ex)
        with st.expander("Ver las adjudicaciones excluidas"):
            tabla(q("""SELECT g.fecha_publicacion AS fecha, g.codigo_proceso, g.tipo_proc, g.organismo,
                              coalesce(e.razon_social, g.nombre_raw) AS proveedor, g.monto_original, g.monto_total,
                              g.monto_revision, g.objeto, n.url_norma
                       FROM analitica.ganador g JOIN bo.norma n ON n.id_norma = g.id_norma
                       LEFT JOIN ref.empresa e ON e.cuit = g.cuit
                       WHERE g.monto_revision IS NOT NULL AND g.anio BETWEEN %s AND %s
                       ORDER BY g.monto_original DESC NULLS LAST LIMIT 500""", (desde, hasta)))

    st.subheader("Montos que no cierran")
    tabla(q("SELECT * FROM analitica.control_montos ORDER BY abs(pct_diferencia) DESC LIMIT 200"))

    st.subheader("Firmas ganadoras sin CUIT (por impacto)")
    n = st.slider("Cantidad", 10, 100, 30)
    pend = q("SELECT * FROM analitica.pendientes_cuit ORDER BY actos DESC LIMIT %s", (n,))
    tabla(pend)
    if st.button("Buscar candidatos en el padrón para estas filas"):
        cand = q("""SELECT p.nombre_norm, p.actos, ref.candidatos_cuit(p.ejemplo) AS candidatos
                    FROM (SELECT * FROM analitica.pendientes_cuit ORDER BY actos DESC LIMIT %s) p
                    ORDER BY p.actos DESC""", (n,))
        tabla(cand)
        st.caption("Para fijar un CUIT: `INSERT INTO ref.empresa_alias (nombre_norm, cuit, fuente) "
                   "VALUES ('<nombre_norm>', <cuit>, 'manual');` y luego `python -m monitor_licitaciones resolver`.")


# ---------------------------------------------------------------------------
# Datos personales publicados
# ---------------------------------------------------------------------------
def datos_personales():
    dp = q("""SELECT count(*) AS actos, sum(n_menciones_paciente) AS menciones, count(DISTINCT organismo) AS organismos,
                     min(fecha_publicacion) AS desde, max(fecha_publicacion) AS hasta
              FROM analitica.control_datos_personales""")
    n = int(dp.actos[0] or 0)
    if not n:
        return
    st.error(
        f"**Infracción a la protección de datos personales.** {n} actos publicados en el Boletín Oficial "
        f"({dp.desde[0]} a {dp.hasta[0]}, {int(dp.organismos[0])} organismos) identifican por nombre a pacientes "
        "junto con el insumo o la prestación que se les compra (prótesis, marcapasos, medicamentos). Es información "
        "de salud, que la Ley 1845 de la Ciudad trata como dato sensible y la Ley 26.529 obliga a mantener "
        "confidencial. En este monitor los nombres están enmascarados; el texto original del Boletín los conserva.")
    with st.expander("Ver actos afectados (sin nombres)"):
        tabla(q("""SELECT fecha_publicacion AS fecha, organismo, codigo_proceso, etapa, subcategoria,
                          objeto_enmascarado, n_menciones_paciente, url_norma
                   FROM analitica.control_datos_personales ORDER BY fecha_publicacion DESC"""))
        st.caption("Órgano de control para el sector público de la Ciudad: Centro de Protección de Datos Personales "
                   "de la Defensoría del Pueblo de la CABA.")


# ---------------------------------------------------------------------------
# IGJ por proveedor
# ---------------------------------------------------------------------------
def autoridades_igj(cuit: int):
    st.subheader("Autoridades y socios (IGJ)")
    au = q("""SELECT p.apellido_nombre, p.rol, p.tipo_documento, p.numero_documento, p.primer_corte, p.ultimo_corte,
                     p.en_ultimo_corte, f.cargo_max AS cargo_en_la_ciudad, f.hasta AS cargo_hasta
              FROM analitica.proveedor_igj p
              LEFT JOIN analitica.funcionario f ON f.numero_documento = p.numero_documento
              WHERE p.cuit = %s AND p.numero_documento IS NOT NULL
              ORDER BY p.en_ultimo_corte DESC, p.ultimo_corte DESC, p.apellido_nombre""", (cuit,))
    if au.empty:
        st.caption("No figura en IGJ o no tiene autoridades cargadas (personas humanas, sociedades de otra "
                   "jurisdicción o inscriptas antes de la digitalización).")
        return
    fun = au.cargo_en_la_ciudad.notna()
    if fun.any():
        st.error(f"{au[fun].numero_documento.nunique()} persona(s) de esta sociedad figuran designadas como "
                 "funcionarios de la Ciudad (mismo documento). Ver detalle en «Funcionarios».")
    tabla(au)
    st.caption("IGJ es histórico: la persona figuró en esos cortes, no necesariamente hoy. «En último corte» = sigue "
               "apareciendo en la publicación más reciente.")


# ---------------------------------------------------------------------------
# Funcionarios
# ---------------------------------------------------------------------------
NIVELES = {1: "Ministro / Jefe de Gabinete", 2: "Secretario y equivalentes", 3: "Subsecretario",
           4: "Director general", 5: "Gerente"}


def funcionarios():
    st.title("Funcionarios")
    cf = q("SELECT * FROM analitica.calidad_funcionarios")
    if cf.empty or not int(cf.normas_encoladas[0] or 0):
        st.info("No hay designaciones cargadas. Correr «Funcionarios» desde Operación.")
        return
    r = cf.iloc[0]
    c = st.columns(4)
    c[0].metric("Personas designadas", int(r.personas), help="De gerente para arriba, identificadas por documento.")
    c[1].metric("Figuran en IGJ", int(r.personas_en_igj), help="Como autoridad o socio de alguna entidad, en cualquier corte.")
    c[2].metric("Con sociedad que contrata", int(r.personas_con_sociedad_que_contrata),
                help="Sociedades comerciales (excluye estatales y sin fines de lucro) que aparecen en actos de compra.")
    c[3].metric("Normas parseadas", f"{int(r.normas_parseadas)} / {int(r.normas_encoladas)}")
    st.caption("El cruce es por número de documento, nunca por nombre. IGJ es histórico: que una persona figure en una "
               "sociedad no prueba que lo estuviera mientras ejercía el cargo. Antes de concluir nada, verificar fechas "
               "de designación y renuncia en el Boletín Oficial de la Nación (edictos).")

    t = st.tabs(["Vínculos con proveedores", "Buscar funcionario"])
    with t[0]:
        a, b, c2 = st.columns(3)
        todas = a.toggle("Incluir estatales y sin fines de lucro", value=False)
        durante = b.toggle("Solo actos durante el cargo", value=False)
        misma = c2.toggle("Solo misma jurisdicción", value=False)
        v = q("""SELECT funcionario, numero_documento, cargo_max, primera_designacion, hasta, razon_social, cuit, rol_igj,
                        en_ultimo_corte, relevante, count(DISTINCT id_norma) AS actos,
                        count(DISTINCT id_norma) FILTER (WHERE durante_funcion) AS actos_durante,
                        count(DISTINCT id_norma) FILTER (WHERE misma_jurisdiccion) AS actos_misma_jurisdiccion,
                        sum(monto_total) AS monto
                 FROM analitica.s_funcionario_proveedor
                 WHERE (relevante OR %(todas)s) AND (durante_funcion OR NOT %(durante)s)
                   AND (misma_jurisdiccion OR NOT %(misma)s)
                 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
                 ORDER BY actos_durante DESC, actos_misma_jurisdiccion DESC, monto DESC NULLS LAST""",
              {"todas": todas, "durante": durante, "misma": misma})
        if v.empty:
            st.success("Sin vínculos con estos criterios.")
        else:
            tabla(v)
            opc = {f"{x.funcionario} — {x.razon_social}": (x.numero_documento, int(x.cuit)) for x in v.itertuples()}
            sel = st.selectbox("Ver actos del vínculo", list(opc), index=None, placeholder="Elegir…")
            if sel:
                dni, cuit = opc[sel]
                tabla(q("""SELECT fecha_publicacion AS fecha, codigo_proceso, etapa, rol_en_acto, organismo,
                                  jurisdiccion_acto, categoria, objeto, monto_total, durante_funcion, misma_jurisdiccion,
                                  url_norma
                           FROM analitica.s_funcionario_proveedor WHERE numero_documento = %s AND cuit = %s
                           ORDER BY fecha_publicacion DESC""", (dni, cuit)))

    with t[1]:
        a, b = st.columns([1, 2])
        niveles = a.multiselect("Nivel", list(NIVELES), format_func=NIVELES.get, placeholder="Todos")
        texto = b.text_input("Apellido, nombre o documento", placeholder="p. ej. BALLOTTA o 22345678")
        cond, prm = ["true"], {}
        if niveles:
            cond.append("nivel_max = ANY(%(niv)s)")
            prm["niv"] = niveles
        if texto.strip():
            t_ = texto.strip().replace(".", "")
            if t_.isdigit():
                cond.append("numero_documento = %(doc)s")
                prm["doc"] = t_
            else:
                cond.append("apellido_nombre ILIKE %(nom)s")
                prm["nom"] = f"%{t_}%"
        lista = q(f"""SELECT f.apellido_nombre, f.numero_documento, f.nivel_max, f.cargo_max, f.jurisdicciones,
                             f.primera_designacion, f.hasta, f.normas,
                             (SELECT count(DISTINCT numero_correlativo) FROM analitica.funcionario_igj i
                              WHERE i.numero_documento = f.numero_documento) AS entidades_igj
                      FROM analitica.funcionario f WHERE {' AND '.join(cond)}
                      ORDER BY nivel_max NULLS LAST, apellido_nombre LIMIT 500""", prm)
        st.caption(f"{len(lista)} personas" + (" (se muestran las primeras 500)" if len(lista) == 500 else ""))
        tabla(lista)
        if lista.empty:
            return
        opc = {f"{x.apellido_nombre} — DNI {x.numero_documento}": x.numero_documento for x in lista.itertuples()}
        sel = st.selectbox("Detalle", list(opc), index=None, placeholder="Elegir una persona…")
        if not sel:
            return
        dni = opc[sel]
        st.subheader(sel)
        st.markdown("**Designaciones y ceses publicados**")
        tabla(q("""SELECT n.fecha_publicacion AS fecha, d.movimiento, d.parte, d.cargo, d.nivel, d.vigencia_desde,
                          n.organismo, n.url_norma
                   FROM fun.designacion d JOIN bo.norma n USING (id_norma)
                   WHERE d.numero_documento = %s ORDER BY n.fecha_publicacion DESC""", (dni,)))
        st.markdown("**Entidades en IGJ**")
        ent = q("""SELECT razon_social, cuit, tipo_societario, rol_igj, nombre_en_igj, en_ultimo_corte, dada_de_baja,
                          es_estatal, sin_fines_de_lucro, actos_con_la_ciudad, actos_ganados
                   FROM analitica.funcionario_igj WHERE numero_documento = %s
                   ORDER BY actos_con_la_ciudad DESC NULLS LAST, en_ultimo_corte DESC""", (dni,))
        if ent.empty:
            st.caption("No figura en IGJ con este documento.")
        else:
            tabla(ent)


# ---------------------------------------------------------------------------
# Operación: lanzar actualizaciones
# ---------------------------------------------------------------------------
from monitor_licitaciones.cli import CANDADO  # noqa: E402

RAIZ = Path(__file__).resolve().parents[1]
LOGS = RAIZ / "logs"
# Grupos de botones, de lo cotidiano a lo excepcional: (título, explicación, [(botón, comando, qué hace, cuándo · cuánto)])
GRUPOS = [
    ("1 · Rutina", "Lo que hay que correr seguido para tener la base al día.", [
        ("Boletín Oficial", ["actualizar"],
         "Trae los boletines nuevos, baja hasta 2.000 PDF (los más recientes), parsea y clasifica las compras y suma "
         "las designaciones nuevas de funcionarios.", "Todos los días · minutos (más si hay atraso)", "primary"),
        ("Compras (BAC)", ["bac"],
         "Baja el listado de Buenos Aires Compras de datos abiertos y lo carga como foto del día.",
         "Todos los días · minutos", "secondary"),
    ]),
    ("2 · Cargas pesadas", "Llevan horas. Lanzarlas de noche o cuando no se necesite la base para otra cosa.", [
        ("PDF atrasados", ["pdfs", "--todos", "--hilos", "3"],
         "Baja todos los PDF pendientes, de los más nuevos a los más viejos, con 3 descargas en paralelo, y al "
         "final los parsea. Si el Boletín se cae, espera y retoma. Se puede cortar y volver a lanzar: sigue donde quedó.",
         "Hasta ponerse al día · horas", "secondary"),
        ("IGJ", ["igj", "--descargar"],
         "Baja la publicación vigente de sociedades y autoridades de IGJ y carga los cortes nuevos. Si el archivo no "
         "cambió, no hace nada.", "Una vez por mes · 10 a 20 minutos", "secondary"),
    ]),
    ("3 · Mantenimiento", "Solo después de cambiar reglas o parsers, o si algo quedó a medias.", [
        ("Actualizar estructura", ["init-db"],
         "Aplica a la base los cambios de una versión nueva del monitor (tablas, vistas, reglas). No borra datos.",
         "Al instalar una versión nueva · 1 a 2 minutos", "secondary"),
        ("Parsear PDF bajados", ["parsear"],
         "Lee los PDF ya descargados que todavía no se parsearon: arma actos, montos y firmas, resuelve CUIT y "
         "clasifica. «Boletín Oficial» y «PDF atrasados» ya lo hacen al terminar.",
         "Si faltan datos con PDF bajados · minutos", "secondary"),
        ("Clasificar compras", ["clasificar"],
         "Aplica las reglas de categoría a los actos sin clasificar (por ejemplo, después de agregar reglas manuales).",
         "Cuando se cambian reglas · segundos", "secondary"),
        ("Bajar designaciones", ["funcionarios"],
         "Busca normas de designación que falten, baja sus PDF y las parsea. «Boletín Oficial» ya lo hace con lo "
         "nuevo: esto es para completar huecos.", "Ocasional · minutos a horas", "secondary"),
        ("Re-parsear funcionarios", ["funcionarios", "--solo-parsear", "--todo"],
         "Vuelve a leer todas las designaciones ya bajadas, sin descargar nada.",
         "Tras cambiar el parser · minutos", "secondary"),
    ]),
]


def ocupado() -> bool:
    d = base().df("""SELECT count(*) AS n FROM pg_locks
                     WHERE locktype = 'advisory' AND classid = 0 AND objid = %s AND granted""", (CANDADO,))
    return int(d.n[0]) > 0


def lanzar(nombre: str, args: list[str]) -> Path:
    LOGS.mkdir(exist_ok=True)
    log = LOGS / f"{datetime.now():%Y%m%d_%H%M%S}_{args[0]}.log"
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    with open(log, "w", encoding="utf-8") as f:
        f.write(f"# {nombre}: python -m monitor_licitaciones {' '.join(args)}\n")
        f.flush()
        subprocess.Popen([sys.executable, "-m", "monitor_licitaciones", args[0], "-v", *args[1:]],
                         cwd=RAIZ, env=env, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kw)
    return log


FASES = {"boletines": "1/5 · Consultando boletines en la API", "pdf_licitacion": "2/5 · Bajando PDF de licitaciones",
         "parseo": "3/5 · Parseando y clasificando actos", "pdf_designacion": "4/5 · Bajando PDF de designaciones",
         "parseo_designaciones": "5/5 · Parseando designaciones"}


def _hhmm(seg: float) -> str:
    seg = int(max(seg, 0))
    return f"{seg // 3600} h {seg % 3600 // 60:02d} min" if seg >= 3600 else f"{seg // 60} min {seg % 60:02d} s"


@st.fragment(run_every="15s")
def progreso():
    """Progreso de la corrida abierta, leído de la base (sirve también para corridas lanzadas por consola)."""
    if not ocupado():
        st.success("No hay ninguna actualización corriendo.")
        return
    r = base().df("""SELECT id, comando, inicio, parametros, resumen, extract(epoch FROM now() - inicio) AS seg
                     FROM ctl.ejecucion WHERE fin IS NULL ORDER BY id DESC LIMIT 1""")
    if r.empty:
        st.info("Hay un proceso con el candado tomado, pero no figura su corrida.")
        return
    r = r.iloc[0]
    par = r.parametros if isinstance(r.parametros, dict) else {}
    res = r.resumen if isinstance(r.resumen, dict) else {}
    st.markdown(f"**⏳ `{r.comando}`** · corrida {int(r.id)} · empezó {pd.Timestamp(r.inicio):%d/%m %H:%M} · "
                f"lleva {_hhmm(r.seg)}")

    api = base().df("""SELECT count(*) AS dias, min(fecha) AS desde, max(fecha) AS hasta,
                              count(*) FILTER (WHERE resultado = 'error') AS errores
                       FROM ctl.fecha_consultada WHERE consultado_en >= %s""", (r.inicio,)).iloc[0]
    pdf = base().df("""SELECT proposito, count(*) FILTER (WHERE estado <> 'pendiente') AS hechos,
                              count(*) FILTER (WHERE estado = 'error') AS errores,
                              extract(epoch FROM max(actualizado_en) FILTER (WHERE estado <> 'pendiente')
                                                 - min(actualizado_en) FILTER (WHERE estado <> 'pendiente')) AS seg
                       FROM bo.documento WHERE actualizado_en >= %s GROUP BY 1""", (r.inicio,))
    pend = base().df("""SELECT proposito, count(*) AS n FROM bo.documento
                        WHERE estado IN ('pendiente','error') AND intentos < 3 GROUP BY 1""")
    hechos = dict(zip(pdf.proposito, pdf.hechos))
    pendientes = dict(zip(pend.proposito, pend.n))

    fase = res.get("fase")
    if not fase and r.comando == "actualizar":   # corridas lanzadas con la versión anterior, sin marca de fase
        fase = ("pdf_designacion" if hechos.get("designacion") else "pdf_licitacion" if hechos.get("licitacion")
                else "boletines")
    if r.comando == "funcionarios":
        fase = "pdf_designacion"
    if r.comando == "pdfs" and fase != "parseo":
        fase = "pdf_licitacion"
    if fase:
        st.markdown(f"**{FASES.get(fase, fase)}**")

    if fase == "boletines" and api.dias:
        hoy = pd.Timestamp.today().normalize()
        total = max((hoy - pd.Timestamp(api.desde)).days, 1)
        hecho = (pd.Timestamp(api.hasta) - pd.Timestamp(api.desde)).days
        frac = min(hecho / total, 1)
        eta = r.seg * (1 - frac) / frac if frac > 0.02 else None
        st.progress(frac, text=f"Fechas consultadas: {int(api.dias)} · va por {pd.Timestamp(api.hasta):%d/%m/%Y}"
                               + (f" · faltan ~{_hhmm(eta)}" if eta else ""))
    elif fase in ("pdf_licitacion", "pdf_designacion"):
        prop = "licitacion" if fase == "pdf_licitacion" else "designacion"
        h = int(hechos.get(prop, 0))
        p_ = int(pendientes.get(prop, 0))
        tope = par.get("limite_pdfs") if r.comando == "actualizar" else None
        total = min(h + p_, int(tope)) if tope else h + p_
        fila = pdf[pdf.proposito == prop]
        seg = float(fila.seg.iloc[0]) if not fila.empty and pd.notna(fila.seg.iloc[0]) else 0
        ritmo = h / seg if seg > 0 else 0
        eta = (total - h) / ritmo if ritmo else None
        err = int(fila.errores.iloc[0]) if not fila.empty else 0
        st.progress(min(h / total, 1) if total else 0,
                    text=f"{h:,} de {total:,} PDF".replace(",", ".")
                         + (f" · {ritmo * 60:.0f}/min · faltan ~{_hhmm(eta)}" if eta else "")
                         + (f" · {err} con error" if err else ""))
        if tope and h + p_ > int(tope):
            st.caption(f"Tope de {int(tope):,} PDF por corrida: quedan {h + p_ - int(tope):,} pendientes para las "
                       "próximas.".replace(",", "."))
    elif fase:
        st.progress(0.0, text="Esta etapa no informa avance parcial; ver la salida del comando.")
    extra = {k: v for k, v in res.items() if k != "fase"}
    if extra:
        st.caption("Hasta ahora: " + " · ".join(f"{k} {v}" for k, v in extra.items()))

    logs = sorted(LOGS.glob("*.log"), reverse=True) if LOGS.exists() else []
    if logs and logs[0].stat().st_mtime >= pd.Timestamp(r.inicio).timestamp() - 5:
        ult = [x for x in logs[0].read_text(encoding="utf-8", errors="replace").splitlines() if x.strip()][-3:]
        st.code("\n".join(ult), language=None)


def operacion():
    st.title("Operación")
    if not ESTRUCTURA_AL_DIA:
        st.warning("Falta aplicar la estructura nueva: apretá **«Actualizar estructura»** (grupo 3 · Mantenimiento).")
    corriendo = ocupado()
    progreso()
    if corriendo:
        st.caption("Los botones se habilitan cuando termine. El progreso se actualiza solo cada 15 segundos.")
    else:
        st.caption("Cada botón lanza el comando en segundo plano: podés seguir usando la app o cerrarla. "
                   "Al terminar, «Actualizar datos» (barra lateral) refresca las consultas.")
    for titulo, explicacion, tareas in GRUPOS:
        with st.container(border=True):
            st.markdown(f"**{titulo}** — {explicacion}")
            cols = st.columns(len(tareas))
            for col, (nombre, args, que_hace, cuando, tipo) in zip(cols, tareas):
                with col:
                    if st.button(nombre, type=tipo, disabled=corriendo, width="stretch", key=f"op_{args}"):
                        st.session_state["ultimo_log"] = str(lanzar(nombre, args))
                        st.toast(f"Lanzado: {nombre}")
                        st.rerun()
                    st.caption(f"{que_hace}  \n**{cuando}**")
    if st.button("Refrescar estado"):
        st.rerun()

    st.subheader("Últimas corridas")
    ej = base().df("""SELECT id, comando, inicio, fin, ok, fin - inicio AS duracion, resumen
                      FROM ctl.ejecucion ORDER BY id DESC LIMIT 25""")
    if not ej.empty:
        ultima_abierta = ej[ej.fin.isna()].id.max() if ej.fin.isna().any() else None

        def estado(r):
            if r.ok is True:
                return "✅ ok"
            if r.ok is False:
                return "❌ error"
            return "⏳ en curso" if corriendo and r.id == ultima_abierta else "⚠️ interrumpida"

        ej.insert(2, "estado", ej.apply(estado, axis=1))
        ej["duracion"] = ej.duracion.astype(str).str.replace("0 days ", "").str.split(".").str[0]
        ej["resumen"] = ej.resumen.astype(str)
        st.dataframe(ej.drop(columns="ok"), hide_index=True, width="stretch")
        err = base().df("""SELECT ejecucion_id, etapa, clave, mensaje, ocurrido_en FROM ctl.error
                           WHERE ejecucion_id = ANY(%s) ORDER BY id DESC LIMIT 200""", (ej.id.tolist(),))
        if not err.empty:
            with st.expander(f"Errores registrados en estas corridas ({len(err)})"):
                st.dataframe(err, hide_index=True, width="stretch")

    st.subheader("Archivos de fuentes externas")
    tabla(base().df("""SELECT fuente, descargado_en, round(bytes / 1048576.0, 1) AS mb, filas_cargadas, cargado_en,
                              ruta, url FROM ctl.archivo_fuente ORDER BY descargado_en DESC LIMIT 30"""))

    st.subheader("Salida de los comandos")
    logs = sorted(LOGS.glob("*.log"), reverse=True) if LOGS.exists() else []
    if not logs:
        st.caption("Todavía no se lanzó nada desde la app.")
        return
    nombres = [p.name for p in logs[:30]]
    pre = Path(st.session_state.get("ultimo_log", "")).name
    elegido = st.selectbox("Archivo", nombres, index=nombres.index(pre) if pre in nombres else 0)
    lineas = (LOGS / elegido).read_text(encoding="utf-8", errors="replace").splitlines()
    st.code("\n".join(lineas[-80:]) or "(vacío)", language=None)


{"Resumen": resumen, "Comparar": comparar, "Qué se compra": que_se_compra, "Proveedores": proveedores, "Organismos": organismos,
 "Señales": senales, "Funcionarios": funcionarios, "Calidad de datos": calidad, "Operación": operacion}[seccion]()
