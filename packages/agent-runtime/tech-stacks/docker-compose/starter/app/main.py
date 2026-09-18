import os

from fastapi import FastAPI
from sqlalchemy import create_engine, text

app = FastAPI()

DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://postgres:postgres@db:5432/app")
engine = create_engine(DATABASE_URL)


@app.get("/")
def root():
    return {"status": "ok", "service": "app"}


@app.get("/health")
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "ok", "db": "ok"}
    except Exception as exc:  # noqa: BLE001 - surface any DB failure as-is
        return {"status": "degraded", "db": str(exc)}
