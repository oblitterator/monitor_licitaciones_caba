// Etiquetas y textos fijos: etapas, procedimientos y la metodología de cada señal.

export const ETAPAS: Record<string, string> = {
  llamado: "Llamado",
  apertura: "Apertura",
  preadjudicacion: "Preadjudicación",
  adjudicacion: "Adjudicación",
  prorroga: "Prórroga",
  ampliacion: "Ampliación",
  modificacion: "Modificación",
  rectificacion: "Rectificación",
  circular: "Circular",
  circular_con_consulta: "Circular con consulta",
  circular_sin_consulta: "Circular sin consulta",
  deja_sin_efecto: "Deja sin efecto",
  fracasada: "Fracasada",
  otra: "Otra publicación",
};

export function etapa(e: string | null | undefined): string {
  if (!e) return "Sin etapa identificada";
  return ETAPAS[e] ?? e;
}

/** Grupos de etapa del filtro del buscador */
export const GRUPOS_ETAPA = [
  { id: "llamado", label: "Llamado", etapas: ["llamado"] },
  { id: "preadjudicacion", label: "Preadjudicación", etapas: ["preadjudicacion"] },
  { id: "adjudicacion", label: "Adjudicación", etapas: ["adjudicacion"] },
  { id: "modificacion", label: "Prórroga o ampliación", etapas: ["prorroga", "ampliacion", "modificacion", "rectificacion"] },
  { id: "otras", label: "Otras (aperturas, circulares…)", etapas: ["apertura", "circular", "circular_con_consulta", "circular_sin_consulta", "deja_sin_efecto", "fracasada", "otra"] },
] as const;

export const PROCEDIMIENTOS: Record<string, string> = {
  LPU: "Licitación pública",
  LPA: "Licitación pública abreviada",
  LPR: "Licitación privada",
  CME: "Contratación menor",
  CDI: "Contratación directa",
  CPU: "Concurso público",
  OCA: "Otro procedimiento (OCA)",
};

export function procedimiento(t: string | null | undefined): string {
  if (!t) return "Procedimiento no identificado";
  return PROCEDIMIENTOS[t] ?? t;
}

export const GRUPOS_PROC = [
  { id: "LPU", label: "Licitación pública", tipos: ["LPU", "LPA"] },
  { id: "LPR", label: "Licitación privada", tipos: ["LPR"] },
  { id: "CME", label: "Contratación menor", tipos: ["CME"] },
  { id: "CDI", label: "Contratación directa", tipos: ["CDI"] },
] as const;

export const FALTANTES: Record<string, string> = {
  codigo_proceso: "código de proceso",
  monto_total: "monto total",
  firma: "firmas adjudicatarias",
  etapa: "etapa del acto",
};

export function faltante(f: string): string {
  return FALTANTES[f] ?? f.replace(/_/g, " ");
}

export type TipoSenal =
  | "oferta-unica"
  | "concentracion"
  | "excepcion"
  | "fraccionamiento"
  | "empresa-nueva"
  | "domicilio-compartido"
  | "modificaciones";

export type SenalMeta = {
  id: TipoSenal;
  nombre: string;
  corto: string;
  mide: string;
  calc: string;
  leg: string;
  vista: string;
  /** true si se calcula por proceso (aparece en fichas y en el buscador) */
  porProceso: boolean;
};

export const SENALES: SenalMeta[] = [
  {
    id: "oferta-unica",
    nombre: "Oferta única",
    corto: "Una sola oferta",
    mide: "Procesos que se adjudicaron o preadjudicaron habiendo recibido una sola oferta.",
    calc: "El texto del acta o del dictamen dice que hubo una única oferta, o lista un solo oferente. Solo se puede evaluar en los procesos donde el Boletín informa la cantidad de ofertas, que son una minoría.",
    leg: "Rubros con pocos proveedores habilitados, pliegos técnicos exigentes, plazos cortos, montos chicos que no atraen competencia.",
    vista: "analitica.s_competencia",
    porProceso: true,
  },
  {
    id: "concentracion",
    nombre: "Concentración",
    corto: "Pocos se llevan casi todo",
    mide: "Organismos donde pocos proveedores se llevan la mayor parte del monto adjudicado.",
    calc: "Índice Herfindahl-Hirschman (HHI) por organismo y año: suma de las participaciones al cuadrado, de 0 a 10.000. Solo montos en pesos asignables a una firma con CUIT. Se marca a partir de 2.500.",
    leg: "Contratos plurianuales grandes, mercados chicos, compras centralizadas de un insumo específico, organismos con pocas compras en el año.",
    vista: "analitica.s_concentracion",
    porProceso: false,
  },
  {
    id: "excepcion",
    nombre: "Procedimientos de excepción",
    corto: "Contratación menor y directa",
    mide: "El uso de contratación menor y contratación directa en lugar de licitación.",
    calc: "Porcentaje de procesos (y de monto nominal) con procedimiento CME o CDI, por organismo y año, comparado con el total de la Ciudad.",
    leg: "Emergencias, proveedor único o exclusivo, montos bajos, licitaciones previas desiertas o fracasadas.",
    vista: "analitica.s_procedimiento",
    porProceso: false,
  },
  {
    id: "fraccionamiento",
    nombre: "Posible fraccionamiento",
    corto: "3+ menores en 90 días",
    mide: "Compras que podrían haberse dividido para quedar debajo del tope de un procedimiento más exigente.",
    calc: "3 o más contrataciones menores o directas al mismo proveedor (con CUIT) y organismo dentro de 90 días. Se marca cuando la suma supera el tope del procedimiento y cada una por separado no.",
    leg: "Necesidades que surgen en momentos distintos, partidas presupuestarias separadas, urgencias sucesivas.",
    vista: "analitica.s_fraccionamiento",
    porProceso: true,
  },
  {
    id: "empresa-nueva",
    nombre: "Empresa nueva",
    corto: "Menos de 1 año al ganar",
    mide: "Empresas que ganan con menos de un año desde su constitución.",
    calc: "Fecha del contrato social en el padrón de sociedades contra la fecha de publicación de la adjudicación. Las personas humanas no figuran en el padrón.",
    leg: "Empresas creadas por equipos con trayectoria, escisiones, cambios de razón social o de tipo societario.",
    vista: "analitica.s_empresa_nueva",
    porProceso: true,
  },
  {
    id: "domicilio-compartido",
    nombre: "Domicilio compartido",
    corto: "Mismo domicilio, mismo acto",
    mide: "Firmas distintas con el mismo domicilio fiscal que aparecen en el mismo acto.",
    calc: "Domicilio fiscal normalizado del padrón; coincidencia exacta entre dos firmas con CUIT resuelto que figuran en la misma publicación.",
    leg: "Estudios contables que domicilian empresas, edificios de oficinas, grupos empresarios declarados.",
    vista: "analitica.s_domicilio_compartido",
    porProceso: true,
  },
  {
    id: "modificaciones",
    nombre: "Modificaciones",
    corto: "Prórrogas y ampliaciones",
    mide: "Procesos con prórrogas, ampliaciones o modificaciones publicadas.",
    calc: "Actos de prórroga, ampliación, modificación o rectificación publicados en la sección Licitaciones con el mismo código de proceso.",
    leg: "Mayor demanda, nuevas sedes, opciones de prórroga previstas en el pliego, redeterminación de precios.",
    vista: "analitica.s_modificaciones",
    porProceso: true,
  },
];

export function senalMeta(id: string): SenalMeta | undefined {
  return SENALES.find((s) => s.id === id);
}

export function nombreSenal(id: string): string {
  return senalMeta(id)?.nombre ?? id;
}

/** Umbrales HHI de referencia (práctica de defensa de la competencia) */
export const HHI_MODERADO = 1500;
export const HHI_ALTO = 2500;

/** El Boletín a veces publica "No se encontró la descripción" como organismo. */
export function nombreOrganismo(nombre: string | null | undefined, id: string): string {
  if (!nombre || /no se encontr/i.test(nombre)) return /^\d+$/.test(id) ? `Unidad de compras ${id} (sin descripción en el Boletín)` : "Organismo sin descripción en el Boletín";
  return nombre;
}
