"""Mañas de la API del Boletín (sin red ni base)."""
from datetime import date

from monitor_licitaciones.api_bo import BoletinAPI, interpretar_respuesta
from monitor_licitaciones.ingesta import clasificar_fecha, numeros_faltantes


def _resp(numero, fecha_pub):
    return {"boletin": {"numero": numero, "fecha_publicacion": fecha_pub},
            "normas": {"normas": {"Licitaciones": {"Licitación Pública": {"Org": [{"id_norma": numero * 10}]}}}}}


class Resp:
    def __init__(self, data, status=200):
        self.status_code, self._data = status, data

    def json(self):
        return self._data


class SesionFalsa:
    def __init__(self, por_parametro, ultimo):
        self.por_parametro, self.ultimo, self.urls = por_parametro, ultimo, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        param = url.split("/obtenerBoletin/")[1].split("/")[0]
        # como la API real: lo que no existe devuelve el ÚLTIMO boletín, no un 404
        return Resp(self.por_parametro.get(param, self.ultimo))


def test_fecha_sin_edicion_devuelve_el_ultimo_boletin():
    # domingo 22/11/2026: la API devuelve el 7498 del viernes 20/11
    r = interpretar_respuesta(date(2026, 11, 22), _resp(7498, "20/11/2026"))
    assert clasificar_fecha(date(2026, 11, 22), r) == "sin_publicar_aun"   # puede salir más tarde: no se cierra
    # sábado viejo: la API devuelve un boletín POSTERIOR -> sin edición seguro
    r = interpretar_respuesta(date(2024, 8, 3), _resp(7498, "20/11/2026"))
    assert clasificar_fecha(date(2024, 8, 3), r) == "sin_boletin"
    r = interpretar_respuesta(date(2026, 11, 17), _resp(7494, "17/11/2026"))
    assert clasificar_fecha(date(2026, 11, 17), r) == "con_boletin"
    assert clasificar_fecha(date(2026, 11, 17), interpretar_respuesta(date(2026, 11, 17), {})) == "sin_boletin"


def test_consulta_por_numero_compara_el_numero():
    s = SesionFalsa({"7495": _resp(7495, "17/11/2026")}, ultimo=_resp(7498, "20/11/2026"))
    api = BoletinAPI(session=s, pausa=0)
    r = api.obtener_boletin_numero(7495)
    assert r.boletin["numero"] == 7495 and r.fecha_publicacion == date(2026, 11, 17) and len(r.normas) == 1
    assert s.urls[-1].endswith("/obtenerBoletin/7495/true")
    # 7503 no existe: la API devuelve el 7498 -> se informa como inexistente
    r = api.obtener_boletin_numero(7503)
    assert r.boletin is None and r.normas == []


def test_dos_boletines_el_mismo_dia_se_completan_por_numero():
    # 17/11/2026 salieron 7494 y 7495; la consulta por fecha solo trae uno
    assert numeros_faltantes({7493, 7494, 7496, 7497}) == [7495]
    assert numeros_faltantes({7493, 7494, 7496, 7497}, consultados={7495}) == []
    assert numeros_faltantes({7491, 7495}, consultados={7493}) == [7492, 7494]
    assert numeros_faltantes(set()) == []
