"""Helpers de lectura para notebooks: SQL -> DataFrame, siempre en modo solo lectura."""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from .db import conectar


class Base:
    """Uso: db = Base(); db.df("SELECT * FROM analitica.proceso LIMIT 10")"""

    def __init__(self, dsn: Optional[str] = None, timeout_s: Optional[int] = None):
        self.conn = conectar(dsn)
        if timeout_s:
            # corta consultas que se van de mambo en vez de dejar colgada la app (y la base) indefinidamente
            with self.conn.cursor() as cur:
                cur.execute(f"SET statement_timeout = '{int(timeout_s)}s'")
            self.conn.commit()
        self.conn.read_only = True   # los notebooks nunca escriben en la base

    def df(self, sql: str, params: Any = None):
        import pandas as pd
        try:
            with self.conn.cursor() as cur:
                cur.execute(sql, params)
                cols = [d.name for d in cur.description]
                df = pd.DataFrame(cur.fetchall(), columns=cols)
        finally:
            self.conn.rollback()        # cierra la transacción de solo lectura
        # numeric de Postgres llega como Decimal: a float para poder operar y graficar
        for c in df.columns:
            no_nulos = df[c].dropna()
            if len(no_nulos) and isinstance(no_nulos.iloc[0], Decimal):
                df[c] = df[c].astype(float)
        return df

    def valor(self, sql: str, params: Any = None):
        try:
            with self.conn.cursor() as cur:
                cur.execute(sql, params)
                return cur.fetchone()[0]
        finally:
            self.conn.rollback()
