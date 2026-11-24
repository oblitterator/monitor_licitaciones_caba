-- =====================================================================
-- Clasificación de lo que se compra (categoría y subcategoría).
-- Reglas por expresión regular sobre el objeto del acto y, si no alcanza,
-- sobre el "Rubro comercial" declarado. Gana la regla de menor orden.
-- Las reglas con origen 'base' se regeneran en cada init-db; las de origen
-- 'manual' (agregadas por el usuario) se conservan y tienen prioridad si
-- se les da un orden menor.
-- =====================================================================
ALTER TABLE bo.acto ADD COLUMN IF NOT EXISTS rubro text;
ALTER TABLE bo.acto ADD COLUMN IF NOT EXISTS datos_paciente boolean NOT NULL DEFAULT false;
ALTER TABLE bo.acto ADD COLUMN IF NOT EXISTS n_menciones_paciente int NOT NULL DEFAULT 0;
ALTER TABLE bo.acto ADD COLUMN IF NOT EXISTS categoria text;
ALTER TABLE bo.acto ADD COLUMN IF NOT EXISTS subcategoria text;
ALTER TABLE bo.acto ADD COLUMN IF NOT EXISTS categoria_fuente text;   -- objeto | rubro
CREATE INDEX IF NOT EXISTS acto_categoria_idx ON bo.acto (categoria);

CREATE TABLE IF NOT EXISTS ref.categoria_regla (
  id               serial PRIMARY KEY,
  nivel            text NOT NULL CHECK (nivel IN ('categoria','subcategoria')),
  categoria_padre  text,          -- solo para subcategoría
  orden            int  NOT NULL,
  patron           text NOT NULL, -- regex POSIX, se aplica sobre texto en minúsculas
  resultado        text NOT NULL,
  origen           text NOT NULL DEFAULT 'manual' CHECK (origen IN ('base','manual'))
);

DELETE FROM ref.categoria_regla WHERE origen = 'base';
INSERT INTO ref.categoria_regla (nivel, categoria_padre, orden, patron, resultado, origen) VALUES
 ('categoria',NULL,10,'seguridad privada|vigilancia|custodia|alarmas?\M|detectores? de metales|control de acceso','Seguridad y vigilancia','base'),
 ('categoria',NULL,20,'\mseguros?\M|p[oó]liza|coberturas? de riesgo','Seguros','base'),
 ('categoria',NULL,30,'salud|m[eé]dic|hospital|quir[uú]rg|farmac|medicament|f[aá]rmaco|droga|laborator|reactiv|odontol|hemoterap|enfermer|sanitari|paciente|pr[oó]tesis|marcapas|implant|cl[ií]nic|sangre|oncol|diagn[oó]stic|enteral|parenteral|ox[ií]geno|vacuna|insulina|cat[eé]ter|c[aá]nula|sutura|descartable|jeringa|desfibril|respirador|anestes|radiolog|tomograf|ec[oó]graf|endoscop|stent|cardio|ortop|oftalm|di[aá]lisis|hemodi|kinesio|ambulancia|internaci|maxilofac|traumatol|neuro|uti\M|serolog|hemostasia|bioqu[ií]m|titanio|\mclips?\M|fexofenad|aparatolog|lentes? intraocular|\mlio\M|mano asistida|neonatolog|nutroter|suplementos? nutri|leche humana|fortificador|rt-pcr|bacterias|hemograma|\mfresas?\M|frontoluz|bengala|ginecolog|obstetr|bioingenier|porta ?suero|cirug|mab\M|multiparam|instrumental|hilo encerado|lupolino|oligoelement|postural|fuente de luz','Salud','base'),
 ('categoria',NULL,40,'aliment|v[ií]veres|raciones|comida|catering|refrigerio|gastronom|desayuno|almuerzo|merienda|panader|carnes?\M|frutas|verduras|l[aá]cteo|cafeter','Alimentación','base'),
 ('categoria',NULL,50,'inform[aá]tic|software|licencias?\M|hardware|comput|servidor|notebook|tablet|aplicativo|\mnube\M|cloud|telecomunic|telefon|internet|conectividad|redes? de datos|digitaliz|tecnolog|sistema de gesti|data ?center|fibra [oó]ptica|radiocomunic|celular|firewall|\mweb\M|ciberseg|\msap\M|evolutivo|soluciones (inform|tecnol)|desarrollo de (software|sistemas)|aplicaciones|veeam|vmware|correo institucional|patch ?cord|impresoras|plotters?|biom[eé]tric|videograb|radios? port[aá]til|torres? de transmisi|comunicaci[oó]n y transmisi|datos personales|equipos de red|materiales de red|redes? (de datos|inform|wi-?fi|lan|inal[aá]mbric)|switch|hosting|almacenamiento de (datos|informaci)|hitachi|netapp|backup|servidores|c[oó]mputo|\mnodos?\M|vulnerab|infraestructura (tecnol|de datos|de nodos|inform)|varnish|zoom|office 365|microsoft|mulesoft|red hat|elastic stack|adobe|acrobat|autodesk|oracle|plataforma (digital|online)','Informática y telecomunicaciones','base'),
 ('categoria',NULL,60,'\mobras?\M|construcci|edilici|carpinter|herrer|pintura|remodelaci|refacci|alba[ñn]il|impermeabiliz|puesta en valor|\mparques?\M|\mplazas?\M|pavimento|veredas?\M|bacheo|demolici|pasarela|techado|urbaniz|vivienda|andamio|calle verde|casco hist|reformas?\M|readecuaci|refuncionaliz|restauraci|conservaci[oó]n integr|rehabilitaci|\mpuentes?\M|\mvial\M|mirador|fuentes? ornamental|juegos de agua|\mhierros? y afines|materiales de hierro|\mestructuras? (de|met)|vidrios|marquesina|toldo|cerrajer|trabajos de ampliaci|ampliaci[oó]n edilic|fundici[oó]n','Obras y construcción','base'),
 ('categoria',NULL,70,'limpieza|higiene urbana|perfumer|residuos|fumigaci|desinfecci|desratiz|control de plagas|lavander|contenedores|piscinas?','Limpieza e higiene','base'),
 ('categoria',NULL,80,'textil|confecci|calzado|uniforme|indumentaria|\mropa\M|roper[ií]a|ropa de cama|colchon|frazada|s[aá]bana|\mtelas?\M','Textil e indumentaria','base'),
 ('categoria',NULL,90,'veh[ií]cul|automotor|autom[oó]vil|camioneta|cami[oó]n|transporte|traslado|combustible|neum[aá]tic|flota|gr[uú]a|\mmotos?\M|bicicleta|lubricante','Vehículos y transporte','base'),
 ('categoria',NULL,100,'bibliogr|suscripci[oó]n (de|a) (la ley|las publicaciones)|la ley y abeledo|rubinzal|el ?dial|errepar|erreius|abeledo|el derecho|publicaciones jur|biblioteca jur|\mlibros?\M|did[aá]ctic|escolar|educativ|juguete|juegos|deport','Educación, deporte y recreación','base'),
 ('categoria',NULL,110,'mueble|mobiliario|librer[ií]a|papeler|art[ií]culos de oficina|impresi[oó]n|t[oó]ner|cartucho|imprenta|gr[aá]fic|ensobrado|postal|formularios|sill[oó]n|sillones|\msillas?\M|escritorio|engrapadora|abrochadora|libretas','Mobiliario, librería e impresión','base'),
 ('categoria',NULL,120,'publicidad|difusi[oó]n|eventos?\M|espect[aá]culo|cultural|audiovisual|sonido|escenario|museo|art[ií]stic|clipping|pauta publicitaria|espacio publicitario|multimedia|banderas|instrumentos musicales|consolas? de mezcla|ediciones','Comunicación, cultura y eventos','base'),
 ('categoria',NULL,130,'consultor|asesoramiento|servicios profesionales|auditor|capacitaci|atenci[oó]n ciudadana|call center|centro de contacto|encuesta|dictado de contenido|\mformaci[oó]n|concesi[oó]n de uso|atenci[oó]n al ciudadano|b[uú]squeda integral','Servicios profesionales y de gestión','base'),
 ('categoria',NULL,140,'mantenimiento|reparaci|instalaci[oó]n|ascensor|aire acondicionado|climatizaci|electricidad|el[eé]ctric|gas natural|calefacci|\mbombas?\M|grupos? electr|generador|matafuego|incendio|extintor|carga de fuego|termotanque|monitoreo atmosf','Mantenimiento, instalaciones y energía','base'),
 ('categoria',NULL,150,'electrodom|equipamiento|maquinaria|herramient|ferreter|materiales|insumos|elementos|tornos?\M|repuestos','Equipamiento e insumos generales','base'),
 -- Subcategorías de Salud (el rubro más grande, ~60% de los actos)
 ('subcategoria','Salud',10,'mantenimiento|reparaci|\mservice\M|calibraci','Mantenimiento de equipos médicos','base'),
 ('subcategoria','Salud',20,'pr[oó]tesis|implant|marcapas|stent|v[aá]lvula|osteos[ií]ntesis|clavos?\M|tornillos?\M|cardiodesfibril|lente intraocular|endopr[oó]tesis|placas?\M|maxilofac','Prótesis e implantes','base'),
 ('subcategoria','Salud',30,'reactiv|determinaci|quimioluminisc|hemograma|proteinograma|\mkits?\M|serolog|inmunolog|anatom[ií]a patol|hemostasia|bioqu[ií]m|laborator','Reactivos y laboratorio','base'),
 ('subcategoria','Salud',40,'medicament|f[aá]rmaco|droga|antibi[oó]t|ampolla|comprimid|vacuna|insulina|oncol[oó]g|psicof[aá]rmac|antirretrovir|farmac','Medicamentos','base'),
 ('subcategoria','Salud',50,'nutrici|enteral|parenteral|f[oó]rmula|\mleches?\M','Nutrición','base'),
 ('subcategoria','Salud',60,'ox[ií]geno|\mgas(es)?\M|di[oó]xido|carb[oó]nico|nitr[oó]geno','Oxígeno y gases medicinales','base'),
 ('subcategoria','Salud',70,'equipos?\M|equipamiento|aparat|monitor|respirador|ec[oó]graf|tom[oó]graf|angi[oó]graf|\mcamas?\M|camilla|desfibril|electrocardi|endoscop|instrumental|videolaringo','Equipamiento médico','base'),
 ('subcategoria','Salud',80,'insumo|descartable|material sanitario|sutura|jeringa|guantes?\M|cat[eé]ter|c[aá]nula|sonda|gasa|ap[oó]sito|\mfilms?\M|radiogr|tubos?\M|\mclips?\M|agujas?\M|bolsas?\M|circuito','Insumos y descartables','base'),
 ('subcategoria','Salud',90,'prestaci|internaci|traslado|ambulancia|hemodi[aá]lisis|di[aá]lisis|estudios?\M|servicio','Servicios de salud','base');

-- ---------------------------------------------------------------------
-- Asigna categoría/subcategoría a los actos. p_todo=false solo toca los
-- que no tienen categoría (útil después de parsear). Devuelve filas tocadas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ref.clasificar_actos(p_todo boolean DEFAULT true) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  WITH c AS (
    SELECT a.id_norma, lower(coalesce(a.objeto, '')) AS obj, lower(coalesce(a.rubro, '')) AS rub
    FROM bo.acto a
    WHERE p_todo OR a.categoria IS NULL
  ), cat AS (
    SELECT c.id_norma, c.obj, c.rub,
           (SELECT r.resultado FROM ref.categoria_regla r
             WHERE r.nivel = 'categoria' AND c.obj <> '' AND c.obj ~ r.patron ORDER BY r.orden, r.id LIMIT 1) AS cat_obj,
           (SELECT r.resultado FROM ref.categoria_regla r
             WHERE r.nivel = 'categoria' AND c.rub <> '' AND c.rub ~ r.patron ORDER BY r.orden, r.id LIMIT 1) AS cat_rub
    FROM c
  ), fin AS (
    SELECT id_norma, obj, rub,
           CASE WHEN usa_rubro THEN cat_rub ELSE cat_obj END AS categoria,
           CASE WHEN usa_rubro THEN 'rubro' WHEN cat_obj IS NOT NULL THEN 'objeto' END AS fuente
    FROM (SELECT cat.*,
                 -- el rubro manda si el objeto no clasifica o solo cae en la categoría genérica
                 cat_rub IS NOT NULL AND (cat_obj IS NULL OR cat_obj = 'Equipamiento e insumos generales') AS usa_rubro
          FROM cat) x
  )
  UPDATE bo.acto a
     SET categoria = f.categoria,
         categoria_fuente = f.fuente,
         subcategoria = (SELECT r.resultado FROM ref.categoria_regla r
                          WHERE r.nivel = 'subcategoria' AND r.categoria_padre = f.categoria
                            AND (f.obj || ' ' || f.rub) ~ r.patron ORDER BY r.orden, r.id LIMIT 1)
    FROM fin f
   WHERE a.id_norma = f.id_norma;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
