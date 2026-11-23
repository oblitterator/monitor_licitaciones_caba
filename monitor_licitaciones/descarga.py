"""Descarga educada de PDFs del Boletín: concurrencia acotada, intervalo mínimo entre pedidos,
reintentos con backoff + jitter que respetan Retry-After, y http -> https.

Medido contra la API real (nov. 2026): el primer pedido de un PDF tarda 8-11 s (el servidor lo
genera) y los siguientes ~0,2 s. Bajar de a uno es casi todo espera; con 6 en paralelo y 0,15 s
entre inicios, 7 días pasaron de ~21 min a 137 s sin fallas.

Este módulo NO toca la base: devuelve resultados y quien llama escribe (una conexión de psycopg
no se comparte entre hilos).
"""
from __future__ import annotations

import email.utils
import random
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, Optional

import requests
from requests.adapters import HTTPAdapter

from .api_bo import UA, a_https

CONCURRENCIA_DEFECTO = 6
CONCURRENCIA_MAXIMA = 8          # más que esto ya no es educado con un servidor público
INTERVALO_DEFECTO = 0.15         # segundos mínimos entre inicios de pedidos (entre todos los hilos)
ESTADOS_REINTENTABLES = frozenset({408, 425, 429, 500, 502, 503, 504})
# errores de red que vale la pena reintentar (cortes, timeouts, respuesta truncada)
ERRORES_REINTENTABLES = (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError)


class ErrorDescarga(Exception):
    pass


class Cortesia:
    """Separa los inicios de pedidos al menos `intervalo` segundos, entre todos los hilos.
    El tope de concurrencia lo pone el tamaño del pool de hilos."""

    def __init__(self, intervalo: float, reloj: Callable[[], float] = time.monotonic,
                 dormir: Callable[[float], None] = time.sleep):
        self.intervalo = max(0.0, intervalo)
        self._reloj, self._dormir = reloj, dormir
        self._lock = threading.Lock()
        self._proximo = 0.0

    def esperar_turno(self) -> None:
        with self._lock:
            ahora = self._reloj()
            espera = self._proximo - ahora
            self._proximo = max(ahora, self._proximo) + self.intervalo
        if espera > 0:
            self._dormir(espera)


def segundos_retry_after(valor: Optional[str], ahora: Optional[float] = None) -> Optional[float]:
    """Retry-After en segundos ('120') o fecha HTTP ('Wed, 21 Oct 2026 07:28:00 GMT')."""
    if not valor:
        return None
    valor = valor.strip()
    if valor.isdigit():
        return float(valor)
    try:
        dt = email.utils.parsedate_to_datetime(valor)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    return max(0.0, dt.timestamp() - (time.time() if ahora is None else ahora))


def sesion_pdfs(concurrencia: int = CONCURRENCIA_DEFECTO) -> requests.Session:
    """Session con pool del tamaño de la concurrencia y SIN reintentos de urllib3 (los maneja
    Descargador, para que respeten la cortesía y Retry-After)."""
    s = requests.Session()
    ad = HTTPAdapter(pool_connections=concurrencia, pool_maxsize=concurrencia, max_retries=0)
    s.mount("https://", ad)
    s.mount("http://", ad)
    s.headers["User-Agent"] = UA
    return s


class Descargador:
    def __init__(self, session: Optional[requests.Session] = None, concurrencia: int = CONCURRENCIA_DEFECTO,
                 intervalo: float = INTERVALO_DEFECTO, reintentos: int = 4, timeout: float = 60,
                 espera_max: float = 120, dormir: Callable[[float], None] = time.sleep):
        self.s = session or sesion_pdfs(concurrencia)
        self.cortesia = Cortesia(intervalo, dormir=dormir)
        self.reintentos, self.timeout, self.espera_max = reintentos, timeout, espera_max
        self._dormir = dormir
        self._lock = threading.Lock()
        self.pedidos = 0
        self.reintentos_hechos = 0
        self.latencias: list[float] = []

    def _espera(self, intento: int, r: Optional[requests.Response]) -> float:
        ra = segundos_retry_after(r.headers.get("Retry-After")) if r is not None else None
        if ra is not None:
            return min(ra, self.espera_max)
        return min(30.0, 2.0 ** intento) * (0.5 + random.random())   # backoff exponencial con jitter

    def bajar(self, url: str) -> bytes:
        url = a_https(url)
        ultimo: Exception = ErrorDescarga("sin intentos")
        for intento in range(self.reintentos + 1):
            self.cortesia.esperar_turno()
            t0 = time.monotonic()
            r: Optional[requests.Response] = None
            try:
                r = self.s.get(url, timeout=(10, self.timeout))
            except ERRORES_REINTENTABLES as e:
                ultimo = e
            with self._lock:
                self.pedidos += 1
                if r is not None:
                    self.latencias.append(time.monotonic() - t0)
            if r is not None:
                if r.status_code < 400:
                    contenido = r.content
                    if not contenido.startswith(b"%PDF"):
                        raise ErrorDescarga(f"no es PDF ({r.headers.get('Content-Type')}, {len(contenido)} B)")
                    return contenido
                if r.status_code not in ESTADOS_REINTENTABLES:
                    raise ErrorDescarga(f"HTTP {r.status_code}")
                ultimo = ErrorDescarga(f"HTTP {r.status_code}")
            if intento == self.reintentos:
                break
            with self._lock:
                self.reintentos_hechos += 1
            self._dormir(self._espera(intento, r))
        raise ultimo

    def resumen_latencias(self) -> dict:
        lat = sorted(self.latencias)
        if not lat:
            return {"pedidos": self.pedidos, "reintentos": self.reintentos_hechos}
        return {"pedidos": self.pedidos, "reintentos": self.reintentos_hechos,
                "p50_s": round(lat[len(lat) // 2], 2), "p95_s": round(lat[min(len(lat) - 1, int(len(lat) * .95))], 2),
                "min_s": round(lat[0], 2), "max_s": round(lat[-1], 2)}


@dataclass
class ResultadoPDF:
    clave: object                 # id_norma (o lo que pase quien llama)
    url: str
    contenido: Optional[bytes] = None
    texto: Optional[str] = None
    paginas: Optional[int] = None
    error: Optional[str] = None
    segundos: float = 0.0


def bajar_y_extraer(pendientes: Iterable[tuple[object, str]], descargar: Callable[[str], bytes],
                    extraer: Callable[[bytes], tuple[str, int]], concurrencia: int = CONCURRENCIA_DEFECTO
                    ) -> Iterator[ResultadoPDF]:
    """Baja y extrae en hilos; va devolviendo resultados a medida que terminan (en el hilo que llama).
    Mantiene a lo sumo 2x concurrencia trabajos en vuelo para no acumular textos en memoria."""

    def trabajo(clave: object, url: str) -> ResultadoPDF:
        t0 = time.monotonic()
        res = ResultadoPDF(clave, url)
        try:
            res.contenido = descargar(a_https(url))
            res.texto, res.paginas = extraer(res.contenido)
        except Exception as e:  # noqa: BLE001 - el error viaja como dato al hilo principal
            res.error = f"{type(e).__name__}: {e}"
        res.segundos = time.monotonic() - t0
        return res

    it = iter(pendientes)
    en_vuelo: set[Future] = set()
    with ThreadPoolExecutor(max_workers=max(1, concurrencia), thread_name_prefix="pdf") as pool:
        for clave, url in it:
            en_vuelo.add(pool.submit(trabajo, clave, url))
            if len(en_vuelo) >= 2 * concurrencia:
                listos, en_vuelo = wait(en_vuelo, return_when=FIRST_COMPLETED)
                for f in listos:
                    yield f.result()
        while en_vuelo:
            listos, en_vuelo = wait(en_vuelo, return_when=FIRST_COMPLETED)
            for f in listos:
                yield f.result()
