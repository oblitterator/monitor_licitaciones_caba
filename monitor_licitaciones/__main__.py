from .cli import main

if __name__ == "__main__":   # necesario en Windows: los procesos de descarga en paralelo re-importan este módulo
    raise SystemExit(main())
