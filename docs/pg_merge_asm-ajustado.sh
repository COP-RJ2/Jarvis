#!/bin/bash
set -e

python3 << 'PYEOF'
import subprocess, sys, os, time

for pkg in ["requests"]:
    try:
        __import__(pkg)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "--quiet"])

import requests

API_BASE = os.environ["PG_API_URL"].rstrip("/")
HEADERS  = {"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["PG_API_KEY"]}

DATASETS = [
    {
        "name":       "asm",
        "hive_table": "dev_brbi_opslgc.stg_asm_hourly",
        "log_table":  "dev_brbi_opslgc.stg_execution_log_asm",
    },
]

PRESTO_HOST = os.environ.get("PRESTO_HOST", "https://trino-gateway-useast.shopee.io")
PRESTO_USER = os.environ.get("PRESTO_USER", "roberto.barboza")

def presto_fetch(sql):
    hdrs = {
        "X-Presto-User":    PRESTO_USER,
        "X-Presto-Catalog": "hive",
        "X-Presto-Schema":  "dev_brbi_opslgc",
    }
    resp = requests.post(f"{PRESTO_HOST}/v1/statement", data=sql, headers=hdrs, timeout=30)
    resp.raise_for_status()
    state = resp.json()
    rows, cols = [], None
    while True:
        if "columns" in state and cols is None:
            cols = [c["name"] for c in state["columns"]]
        if "data" in state:
            rows.extend(state["data"])
        next_uri = state.get("nextUri")
        if not next_uri:
            break
        time.sleep(0.5)
        state = requests.get(next_uri, headers=hdrs, timeout=30).json()
    return [dict(zip(cols, r)) for r in rows] if cols else []

def post_batch(endpoint, rows, batch=200):
    total = 0
    for i in range(0, len(rows), batch):
        r = requests.post(f"{API_BASE}{endpoint}", json=rows[i:i+batch], headers=HEADERS, timeout=60)
        r.raise_for_status()
        total += r.json().get("inserted", 0)
    return total

errors = []
for ds in DATASETS:
    print(f"[{ds['name']}] Lendo {ds['hive_table']} via Presto...")
    try:
        rows = presto_fetch(f"SELECT * FROM {ds['hive_table']}")
        print(f"[{ds['name']}] {len(rows)} linhas lidas.")
        if rows:
            n = post_batch(f"/ingest/{ds['name']}", rows)
            print(f"[{ds['name']}] {n} linhas enviadas à API.")
        log_rows = presto_fetch(f"SELECT * FROM {ds['log_table']}")
        if log_rows:
            post_batch("/ingest/log", log_rows)
            print(f"[{ds['name']}] log enviado.")
        r = requests.post(f"{API_BASE}/merge/{ds['name']}", headers=HEADERS, timeout=60)
        r.raise_for_status()
        print(f"[{ds['name']}] merge OK → {r.json()}")
    except Exception as e:
        print(f"[{ds['name']}] ERRO: {e}", file=sys.stderr)
        errors.append(ds["name"])

if errors:
    raise SystemExit(f"Falhou: {errors}")
print("pg_sender concluído com sucesso.")
PYEOF
