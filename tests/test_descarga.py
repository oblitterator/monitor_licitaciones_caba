"""Descarga educada de PDFs con la capa HTTP simulada (sin red ni base)."""
import threading
import time
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone

import pytest
import requests

from monitor_licitaciones.api_bo import a_https
from monitor_licitaciones.descarga import (Cortesia, Descargador, ErrorDescarga, bajar_y_extraer,
                                           segundos_retry_after)

PDF = b"%PDF-1.7 falso"


class Resp:
    def __init__(self, status=200, content=PDF, headers=None):
        self.status_code, self.content, self.headers = status, content, headers or {}


class SesionFalsa:
    """get() devuelve, por URL, las respuestas (o excepciones) de la lista en orden."""

    def __init__(self, guion=None, demora=0.0, defecto=None):
        self.guion = {k: list(v) for k, v in (guion or {}).items()}
        self.demora, self.defecto = demora, defecto or Resp()
        self.urls, self.inicios = [], []
        self._lock = threading.Lock()
        self.en_vuelo = self.max_en_vuelo = 0

    def get(self, url, timeout=None):
        with self._lock:
            self.urls.append(url)
            self.inicios.append(time.monotonic())
            self.en_vuelo += 1
            self.max_en_vuelo = max(self.max_en_vuelo, self.en_vuelo)
            pasos = self.guion.get(url)
            paso = pasos.pop(0) if pasos else self.defecto
        try:
            if self.demora:
                time.sleep(self.demora)
            if isinstance(paso, Exception):
                raise paso
            return paso
        finally:
            with self._lock:
                self.en_vuelo -= 1


def sin_dormir():
    esperas = []
    return esperas, esperas.append


# --- http -> https ---------------------------------------------------------
@pytest.mark.parametrize("url,esperada", [
    ("http://documentosboletinoficial.buenosaires.gob.ar/x.pdf", "https://documentosboletinoficial.buenosaires.gob.ar/x.pdf"),
    ("HTTP://host/x.pdf", "https://host/x.pdf"),
    ("https://host/x.pdf", "https://host/x.pdf"),
    ("  http://host/x.pdf ", "https://host/x.pdf"),
    ("", ""),
])
def test_a_https(url, esperada):
    assert a_https(url) == esperada


def test_descargador_pide_https():
    s = SesionFalsa()
    Descargador(s, intervalo=0).bajar("http://host/1.pdf")
    assert s.urls == ["https://host/1.pdf"]


# --- reintentos ------------------------------------------------------------
def test_reintenta_5xx_y_luego_anda():
    s = SesionFalsa({"https://h/1.pdf": [Resp(503, b""), Resp(502, b""), Resp()]})
    esperas, dormir = sin_dormir()
    d = Descargador(s, intervalo=0, reintentos=4, dormir=dormir)
    assert d.bajar("https://h/1.pdf") == PDF
    assert d.pedidos == 3 and d.reintentos_hechos == 2
    # backoff exponencial con jitter: 2**intento * [0.5, 1.5)
    assert 0.5 <= esperas[0] < 1.5 and 1.0 <= esperas[1] < 3.0


def test_respeta_retry_after_en_segundos():
    s = SesionFalsa({"https://h/1.pdf": [Resp(429, b"", {"Retry-After": "7"}), Resp()]})
    esperas, dormir = sin_dormir()
    assert Descargador(s, intervalo=0, dormir=dormir).bajar("https://h/1.pdf") == PDF
    assert esperas == [7.0]


def test_retry_after_tiene_tope():
    s = SesionFalsa({"https://h/1.pdf": [Resp(503, b"", {"Retry-After": "3600"}), Resp()]})
    esperas, dormir = sin_dormir()
    Descargador(s, intervalo=0, espera_max=120, dormir=dormir).bajar("https://h/1.pdf")
    assert esperas == [120]


def test_retry_after_fecha_http():
    ahora = datetime(2026, 11, 23, 12, 0, 0, tzinfo=timezone.utc)
    valor = format_datetime(ahora + timedelta(seconds=30), usegmt=True)
    assert segundos_retry_after(valor, ahora=ahora.timestamp()) == pytest.approx(30)
    assert segundos_retry_after("cualquier cosa") is None
    assert segundos_retry_after(None) is None


def test_reintenta_errores_de_red():
    s = SesionFalsa({"https://h/1.pdf": [requests.ConnectionError("reset"), requests.Timeout("lento"), Resp()]})
    esperas, dormir = sin_dormir()
    assert Descargador(s, intervalo=0, dormir=dormir).bajar("https://h/1.pdf") == PDF
    assert len(esperas) == 2


def test_no_reintenta_404():
    s = SesionFalsa({"https://h/1.pdf": [Resp(404, b"")]})
    esperas, dormir = sin_dormir()
    with pytest.raises(ErrorDescarga, match="HTTP 404"):
        Descargador(s, intervalo=0, dormir=dormir).bajar("https://h/1.pdf")
    assert len(s.urls) == 1 and esperas == []


def test_agota_reintentos():
    s = SesionFalsa(defecto=Resp(503, b""))
    esperas, dormir = sin_dormir()
    with pytest.raises(ErrorDescarga, match="HTTP 503"):
        Descargador(s, intervalo=0, reintentos=3, dormir=dormir).bajar("https://h/1.pdf")
    assert len(s.urls) == 4 and len(esperas) == 3


def test_contenido_que_no_es_pdf_es_error():
    s = SesionFalsa(defecto=Resp(200, b"<html>mantenimiento</html>", {"Content-Type": "text/html"}))
    with pytest.raises(ErrorDescarga, match="no es PDF"):
        Descargador(s, intervalo=0).bajar("https://h/1.pdf")


# --- cortesía y concurrencia -----------------------------------------------
def test_cortesia_separa_inicios():
    reloj = [0.0]
    esperas = []
    c = Cortesia(0.15, reloj=lambda: reloj[0], dormir=esperas.append)
    for _ in range(4):
        c.esperar_turno()
    assert esperas == pytest.approx([0.15, 0.30, 0.45])


def test_concurrencia_acotada_e_intervalo_minimo():
    s = SesionFalsa(demora=0.05)
    d = Descargador(s, concurrencia=3, intervalo=0.01)
    pendientes = [(i, f"http://h/{i}.pdf") for i in range(15)]
    hilos_que_bajan = set()

    def bajar(url):
        hilos_que_bajan.add(threading.current_thread().name)
        return d.bajar(url)

    hilo_principal = threading.current_thread().name
    vistos = []
    for res in bajar_y_extraer(pendientes, bajar, lambda b: ("texto", 1), concurrencia=3):
        assert threading.current_thread().name == hilo_principal   # los resultados se consumen acá
        vistos.append(res.clave)
    assert sorted(vistos) == list(range(15))
    assert 1 < s.max_en_vuelo <= 3
    assert all(n.startswith("pdf") for n in hilos_que_bajan)
    # 15 inicios separados por >= 0.01 s ocupan >= 0.14 s (el espaciado exacto lo prueba test_cortesia_separa_inicios)
    ini = sorted(s.inicios)
    assert ini[-1] - ini[0] >= 14 * 0.01 * 0.9
    assert all(u.startswith("https://") for u in s.urls)


def test_errores_viajan_como_dato():
    def bajar(url):
        if url.endswith("/2.pdf"):
            raise TimeoutError("timeout simulado")
        return PDF

    def extraer(b):
        return ("", 0) if b == PDF else ("x", 1)

    res = {r.clave: r for r in bajar_y_extraer([(1, "http://h/1.pdf"), (2, "http://h/2.pdf")], bajar, extraer, 2)}
    assert res[1].error is None and res[1].texto == "" and res[1].contenido == PDF
    assert res[2].error == "TimeoutError: timeout simulado" and res[2].contenido is None
