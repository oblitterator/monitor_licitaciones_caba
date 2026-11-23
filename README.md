# Monitor de Licitaciones CABA

Pipeline de extracción, procesamiento y análisis de las contrataciones publicadas en el Boletín Oficial de la Ciudad
Autónoma de Buenos Aires, orientado a la detección de señales de riesgo en la relación entre organismos y proveedores.

**Autor:** Juan Nieve

---

# 📘 Introducción

El Boletín Oficial de la Ciudad Autónoma de Buenos Aires es la publicación oficial del Gobierno porteño en la que se
dan a conocer, con validez jurídica, las normas y actos administrativos de la Ciudad. Entre ellos se encuentran los
actos de los procesos de compra y contratación: llamados, preadjudicaciones, adjudicaciones, prórrogas, circulares y
ampliaciones.

La Ciudad ofrece una API pública para acceder a esta información:
🔗 https://api-restboletinoficial.buenosaires.gob.ar/

Mediante esta API se puede:
- Obtener el boletín oficial correspondiente a una fecha.
- Consultar las normas publicadas, agrupadas por sección, tipo y organismo emisor.
- Acceder al documento PDF de cada norma.

De manera complementaria, el portal de datos abiertos de la Ciudad publica el padrón de procesos de **Buenos Aires
Compras (BAC)** en formato OCDS (Open Contracting Data Standard).

Este proyecto es la segunda versión de un trabajo previo
(disponible en el tag `v1-delta-lake` de este repositorio), rediseñado para persistir en PostgreSQL y para
producir indicadores trazables hasta el documento de origen.

---

# 🎯 Objetivo

Construir una base de datos que permita responder, para cada proceso de contratación de la Ciudad:

- **quién** resultó adjudicatario (con su CUIT),
- **por qué monto**,
- **contra cuántos oferentes**,
- **mediante qué procedimiento**,

y, a partir de ello, calcular **señales que orienten la revisión** de proveedores y organismos: oferta única,
concentración de adjudicaciones, uso de procedimientos de excepción, posible fraccionamiento, empresas de reciente
constitución, domicilios fiscales compartidos entre oferentes y modificaciones posteriores a la adjudicación.

> Las señales constituyen **indicadores para priorizar la revisión**. No acreditan por sí mismas la existencia de
> irregularidades: existen razones legítimas para una oferta única, una contratación directa o un proveedor dominante.

---

# 🔄 Cambios respecto de la versión anterior

| Aspecto | Versión 1 | Versión 2 |
|---|---|---|
| Almacenamiento | Delta Lake (archivos locales) | PostgreSQL con esquemas por capa |
| Identificación de empresas | Coincidencia difusa sobre bloques de texto | Parser por reglas (etiquetas, CUIT en texto, formato tabular, listas de oferentes) y resolución contra padrón |
| Montos | Mayor importe del texto, replicado para cada empresa | Monto total por etiqueta; monto por firma solo cuando el texto lo asigna; sin duplicación |
| Errores de descarga | Registrados como dato en la tabla de licitaciones | Tabla de control independiente y estados explícitos por documento |
| Reprocesamiento | Inserción sin actualización: lo fallido permanecía vacío | Cargas idempotentes con actualización y reintentos acotados |
| Calidad | Sin medición | Vistas de control, casos de prueba con textos reales y muestra para revisión manual |
| Descarga de PDFs | Secuencial | En paralelo y educada (6 a la vez, 0,15 s entre pedidos, reintentos con Retry-After) |
| Actos dudosos | Sin respaldo | Respaldo opcional con Claude Haiku, con cada valor verificado contra el texto y sin pisar las reglas |

---

# 📂 Estructura del Proyecto

```bash
📁 monitor_licitaciones_caba
│
├── 📂 monitor_licitaciones          # Paquete Python
│   ├── api_bo.py                    # 📌 Cliente de la API del Boletín Oficial
│   ├── ingesta.py                   # 📌 Carga de boletines y normas, PDFs → texto, parseo
│   ├── descarga.py                  # 📌 Descarga educada de PDFs (concurrencia, reintentos, https)
│   ├── llm.py                       # 📌 Respaldo con Claude Haiku para actos de confianza media/baja
│   ├── parser_actos.py              # 📌 Extracción por reglas de los actos de licitación
│   ├── bac.py                       # 📌 Snapshots del OCDS de Buenos Aires Compras
│   ├── db.py                        # 📌 Conexión y registro de ejecuciones y errores
│   ├── consultas.py                 # 📌 Lectura de la base para los notebooks (solo lectura)
│   └── cli.py                       # 📌 Línea de comandos
│
├── 📂 sql
│   ├── 001_esquema.sql              # Tablas y normalización de razones sociales
│   ├── 020_funciones.sql            # Migración desde v1 y resolución de CUIT
│   ├── 040_analitica.sql            # Vistas de procesos, señales y controles de calidad
│   └── 050_llm.sql                  # Extracciones con LLM y su mezcla con las reglas
│
├── 📂 notebooks
│   ├── 01_calidad.ipynb             # Cobertura, calidad del parser y revisión manual
│   ├── 02_senales.ipynb             # Señales de contratación
│   └── _construir.py                # Generación de los notebooks desde código
│
├── 📂 tests                         # Casos con textos reales del Boletín + integración
├── pyproject.toml
└── README.md
```

## Modelo de datos

| Esquema | Contenido |
|---|---|
| `bo` | Boletines, normas, texto de los PDFs (`documento`), actos parseados (`acto`), firmas por acto (`acto_firma`) y extracciones con LLM (`acto_llm`) |
| `ref` | Padrón de empresas (Registro Nacional de Sociedades + BO + BAC), alias nombre → CUIT, IPC y topes por procedimiento |
| `bac` | Snapshots del OCDS de Buenos Aires Compras: releases y adjudicaciones |
| `ctl` | Registro de ejecuciones, errores, fechas y números de boletín consultados a la API y lotes enviados al LLM |
| `analitica` | Vistas de procesos, ganadores, proveedores, señales y controles de calidad |

---

# 🚀 Flujo de Trabajo

## 🏗️ Ingesta

### Boletines y normas
- Consulta incremental día a día a la API, con tiempos de espera, reintentos y pausa entre pedidos.
- Se registra cada fecha consultada, de modo que no se vuelven a consultar días sin edición.
- Se utiliza la fecha informada por el propio boletín, no la consultada: para una fecha sin edición la API no
  devuelve 404 sino el **último** boletín publicado. Si ese boletín es posterior a la fecha, la fecha queda como
  `sin_boletin`; si es anterior (la fecha es posterior a todo lo publicado: puede que ese día todavía no haya salido),
  la fecha no se marca y se vuelve a consultar en la corrida siguiente.
- La API devuelve **un solo boletín por fecha** aunque ese día se publiquen dos (p. ej. 7494 y 7495 el 17/11/2026).
  Después de recorrer las fechas se piden por número los huecos de numeración (`/obtenerBoletin/{numero}/true`).
  Un número inexistente también devuelve el último boletín, así que se compara el número devuelto con el pedido; los
  inexistentes quedan en `ctl.numero_consultado` y no se vuelven a pedir.
- Boletines y normas se guardan junto con su JSON original (`raw`).

### Documentos
- Para las normas de la sección **Licitaciones** se descarga el PDF y se extrae el texto.
- La descarga es en paralelo y educada: 6 pedidos a la vez como máximo (`--concurrencia`, hasta 8), al menos 0,15 s
  entre el inicio de dos pedidos (`--intervalo`), reintentos con backoff exponencial y jitter ante cortes, timeouts,
  429 y 5xx, respetando `Retry-After`. Los `url_norma` vienen en `http://` y se piden directo en `https://` (así se
  evita el salto 302 del balanceador). El primer pedido de un PDF tarda varios segundos (el servidor lo genera) y los
  siguientes unos 0,2 s, así que el paralelismo es lo que más acelera.
- La descarga y la extracción corren en hilos; todas las escrituras a la base se hacen en el hilo principal.
- El texto se extrae con **pypdfium2** (unas 14 veces más rápido que pdfplumber; en una muestra de 80 PDFs el parser
  dio exactamente lo mismo con ambos textos).
- Cada documento tiene un estado explícito: `pendiente`, `ok`, `vacio` (probablemente escaneado) o `error`.
  Si la respuesta no es un PDF (p. ej. una página de mantenimiento) queda como `error`, no como texto vacío.
- Los errores se registran en `ctl.error` y se reintentan hasta un máximo configurable.

### Buenos Aires Compras
- Se descarga el CSV OCDS publicado en datos abiertos y se registra cada descarga como snapshot.
- Dado que el archivo publicado cubre solo una ventana temporal, el histórico se construye acumulando snapshots.

## 🧠 Procesamiento

### 1. Parseo de actos
De cada acto se extraen:
- **Código de proceso** BAC (p. ej. `401-0147-LPU22`) o SIGAF (p. ej. `5072/SIGAF/20`).
- **Etapa**, a partir del título del acto; el nombre de la norma se usa como respaldo y las discrepancias se marcan.
- **Monto total** y **moneda**, a partir de etiquetas explícitas.
- **Cantidad de ofertas** y condición de **oferta única**, cuando el texto lo consigna.
- **Firmas** con su rol (`adjudicada`, `preadjudicada`, `oferente`, `desestimada`), su CUIT si figura en el texto y su
  monto cuando el texto lo asigna o puede reconstruirse a partir de los renglones.

Cada acto lleva un nivel de confianza (`alta`, `media`, `baja`) y la lista de campos faltantes. Ante cambios en las
reglas se incrementa `PARSER_VERSION`, lo que permite reprocesar únicamente lo afectado.

### 2. Resolución de CUIT
Se asigna el CUIT a cada firma en el siguiente orden de confianza:
1. CUIT consignado en el propio texto.
2. Alias manual.
3. Alias aprendido (nombres que aparecieron con CUIT en otros actos o en BAC).
4. Padrón: nombre normalizado exacto.
5. Padrón: nombre sin forma societaria.
6. Padrón: similitud por trigramas.

La asignación se realiza **solo si el candidato es único**; ante homónimos la firma queda sin resolver.

### 3. Vistas analíticas
- `analitica.proceso`: un registro por proceso, con fechas por etapa, montos, ofertas y modificaciones.
- `analitica.ganador`: adjudicatarios del acto final de cada proceso. El monto se asigna a una firma únicamente
  cuando es inequívoco, de modo que nunca se duplica.
- `analitica.proveedor`: resumen por CUIT.

### 4. Señales

| Vista | Indicador | Consideraciones |
|---|---|---|
| `s_competencia` | Proporción de procesos con oferta única por organismo y año | La cantidad de ofertas figura en una minoría de los textos |
| `s_concentracion` | Índice Herfindahl-Hirschman (HHI) y participación del principal proveedor | Solo montos en pesos asignables a una firma |
| `s_procedimiento` | Peso de contrataciones directas y menores | Montos nominales |
| `s_fraccionamiento` | Tres o más contrataciones menores o directas al mismo proveedor en 90 días | La comparación con topes requiere cargar `ref.umbral_procedimiento` |
| `s_empresa_nueva` | Sociedades adjudicatarias con menos de un año de constitución | Las personas humanas no figuran en el padrón |
| `s_domicilio_compartido` | Firmas distintas con igual domicilio fiscal en un mismo acto | Requiere CUIT resuelto para ambas |
| `s_modificaciones` | Procesos con prórrogas, ampliaciones o modificaciones | Solo lo publicado en la sección Licitaciones |

### 5. Respaldo con LLM (opcional)
Los actos que el parser deja en confianza `media` o `baja` pueden mandarse a **Claude Haiku** (`claude-haiku-5-5`)
por la Message Batches API (mitad de precio), con salida estructurada (JSON schema) y el prompt de sistema en caché.
- Cada valor (etapa, código de proceso, monto total y moneda, firmas con rol, CUIT y monto) viene con una cita
  textual. Se acepta solo si la cita aparece en el texto del PDF **y** contiene el valor; además el CUIT tiene que
  tener dígito verificador válido y el código el formato BAC o SIGAF. Lo que no se verifica se descarta y queda en
  `rechazos`.
- Los resultados van a `bo.acto_llm`, con clave `(id_norma, modelo, versión de prompt)` y el sha256 del PDF. **Nunca
  se pisa `bo.acto`.** Si el PDF cambia, la extracción deja de valer y el acto vuelve a la cola.
- Regla de mezcla (`analitica.acto_consolidado`): las reglas mandan; el LLM solo completa campos vacíos de actos de
  confianza media o baja. Cada valor indica su fuente (`*_fuente` = `reglas` | `llm`). Cuando las dos fuentes tienen
  valor y no coinciden, el acto aparece en `analitica.control_llm` para revisión manual.
- `analitica.calidad_llm` resume cuántos actos completó el LLM y qué campos.
- Las vistas `proceso`, `ganador` y las señales siguen usando solo las reglas.

### 6. Controles de calidad
- `calidad_documentos`, `calidad_parser`, `calidad_resolucion`: cobertura de cada etapa.
- `control_montos`: actos en los que la suma de los montos por firma no coincide con el total declarado.
- `pendientes_cuit`: firmas sin CUIT ordenadas por impacto, con candidatos del padrón.

---

# ⚙️ Instalación

Requisitos: Python 3.10 o superior y PostgreSQL 14 o superior con la extensión `pg_trgm`.

```powershell
git clone https://github.com/oblitterator/monitor_licitaciones_caba.git
cd monitor_licitaciones_caba
python -m venv .venv
.venv\Scripts\activate
python -m pip install -e ".[test,notebooks]"   # agregar ",llm" para usar llm-enviar / llm-recolectar
$env:MLC_DSN = "postgresql://usuario:clave@127.0.0.1:5432/boletin_oficial_caba"
```

La cadena de conexión se toma de la variable de entorno `MLC_DSN` y no debe incluirse en el repositorio.

---

# ▶️ Uso

## Primera carga

```powershell
python -m monitor_licitaciones init-db        # crea esquemas, tablas, funciones y vistas
python -m monitor_licitaciones migrar-v1      # reutiliza normas, textos y padrón de la versión 1
python -m monitor_licitaciones parsear -v
python -m monitor_licitaciones resolver
python -m monitor_licitaciones calidad
```

## Actualización periódica

```powershell
python -m monitor_licitaciones actualizar     # boletines nuevos, PDFs, parseo y resolución de CUIT
python -m monitor_licitaciones bac            # nuevo snapshot de BAC (solo si el archivo cambió)
```

Todos los comandos son idempotentes. Cada ejecución queda registrada en `ctl.ejecucion` y cada error en `ctl.error`.

## Comandos disponibles

| Comando | Descripción |
|---|---|
| `init-db` | Crea o actualiza la estructura de la base |
| `migrar-v1` | Copia normas, textos y padrón de empresas desde el esquema `public` de la versión 1 |
| `boletines --desde --hasta` | Descarga boletines y normas de la API |
| `pdfs [--limite N] [--concurrencia 6] [--intervalo 0.15]` | Descarga PDFs pendientes en paralelo y extrae su texto |
| `parsear [--todo]` | Parsea actos nuevos o procesados con una versión anterior del parser |
| `resolver` | Resuelve el CUIT de las firmas |
| `bac [--archivo]` | Registra un snapshot del OCDS de BAC |
| `ipc --csv` | Carga la serie de IPC para expresar montos en pesos constantes |
| `actualizar [--concurrencia 6]` | Ejecuta la actualización completa |
| `calidad` | Informa cobertura y calidad de la extracción |
| `llm-enviar [--dry-run] [--limite N] [--confianza media,baja] [--archivo f.jsonl]` | Manda los actos dudosos a Claude Haiku por la Batches API; con `--dry-run` solo cuenta los pedidos y estima el costo |
| `llm-recolectar [--lote ID]` | Baja los resultados de los lotes terminados, verifica cada valor y los guarda en `bo.acto_llm` |

## Respaldo con LLM

```powershell
python -m pip install -e ".[llm]"
python -m monitor_licitaciones llm-enviar --dry-run     # cuántos pedidos y costo estimado; no manda nada
$env:ANTHROPIC_API_KEY = "..."                          # la clave se toma solo de esta variable de entorno
python -m monitor_licitaciones llm-enviar
python -m monitor_licitaciones llm-recolectar           # repetir hasta que los lotes terminen (minutos a horas)
```

El costo del dry-run es una estimación a ojo (caracteres / 3); para un número exacto se puede usar `count_tokens`.

## Notebooks

```powershell
nbstripout --install      # una vez, dentro del repositorio: evita versionar salidas
jupyter lab notebooks
```

Los notebooks solo leen las vistas del esquema `analitica` mediante una conexión de solo lectura. La lógica de
procesamiento reside en el paquete Python.

- **01_calidad**: cobertura, calidad del parser, CUIT pendientes, inconsistencias de montos y generación de una
  muestra aleatoria reproducible para **revisión manual**, con cálculo de precisión e intervalo de confianza.
- **02_senales**: panorama general y cada una de las señales, con tablas y gráficos.

---

# 📊 Calidad de la extracción

Sobre 19.011 actos del período 2019–2024 (versión 2.3 del parser):

| Indicador | Valor |
|---|---|
| Adjudicaciones y preadjudicaciones con código de proceso | ~91% |
| Adjudicaciones y preadjudicaciones con monto | ~79% |
| Filas de adjudicatarios con CUIT resuelto | ~83% |
| Filas de adjudicatarios con monto no asignable | 21% |

Estas cifras describen **cobertura**, no precisión. La precisión se estima mediante la revisión manual prevista en
`01_calidad`.

---

# ⚠️ Limitaciones

- **Oferentes:** la mayoría de los actos solo nombra a la firma ganadora; `n_ofertas` se informa únicamente cuando el
  texto lo consigna o enumera a los oferentes.
- **CUIT:** el padrón de sociedades no incluye personas humanas y contiene homónimos; ambos casos requieren alias
  manuales o información de BAC.
- **Moneda:** se registra la moneda de cada monto; las señales en pesos excluyen los importes en dólares.
- **Documentos escaneados:** quedan en estado `vacio`; no se aplica OCR.
- **LLM:** solo se mandan actos de hasta ~250.000 caracteres (arriba de 100.000 tokens Haiku cobra otra tarifa).
- **BAC:** el archivo publicado no incluye oferentes y cubre solo el período vigente.
- **Cobertura:** procesos sin código BAC o SIGAF no se integran a `analitica.proceso`.

---

# 🧪 Pruebas

```powershell
python -m pytest tests/test_parser.py tests/test_descarga.py tests/test_boletines.py tests/test_llm.py tests/test_extraccion.py   # no requieren base ni red
$env:MLC_TEST_DSN = "postgresql://usuario:clave@127.0.0.1:5432/mlc_test"   # base descartable
python -m pytest
```

Los casos de prueba del parser son textos reales del Boletín Oficial, incluidas muestras aleatorias utilizadas para
medir la generalización de las reglas.
