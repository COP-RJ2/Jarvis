#!/bin/bash
set -e

# Le Hive direto via Spark/YARN em vez de Presto REST (Shell task nao tem
# acesso a DNS interno da Shopee pra resolver o gateway Presto -- achado em
# 2026-09-25: "Failed to resolve 'trino-gateway-useast.shopee.io'"). O YARN
# ja prova alcancar o Hive normalmente (mesma rede dos jobs SparkSQL que ja
# funcionam) e deve ter egress HTTPS pra internet externa, diferente do
# container isolado da Shell task.
#
# ${PG_API_URL}/${PG_API_KEY} continuam como texto literal -- a mesma
# substituicao de texto do Data Studio que ja confirmamos funcionando (ver
# pg_merge_asm-ajustado.sh) -- NUNCA cole o valor real da chave aqui, fica
# gravado em texto puro no historico de versao da tarefa.
cat > /tmp/pg_sender_asm.py << 'PYEOF'
from pyspark.sql import SparkSession
import requests, sys

spark = SparkSession.builder \
    .appName("pg_sender_asm") \
    .enableHiveSupport() \
    .getOrCreate()

API_BASE = "${PG_API_URL}".rstrip("/")
HEADERS  = {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${PG_API_KEY}",
}

def post_batch(endpoint, rows, batch=200):
    total = 0
    for i in range(0, len(rows), batch):
        r = requests.post(f"{API_BASE}{endpoint}", json=rows[i:i+batch], headers=HEADERS, timeout=60)
        r.raise_for_status()
        total += r.json().get("inserted", 0)
    return total

errors = []
try:
    df = spark.table("dev_brbi_opslgc.stg_asm_hourly")
    rows = [row.asDict() for row in df.collect()]
    print(f"[asm] {len(rows)} linhas lidas.")
    if rows:
        n = post_batch("/ingest/asm", rows)
        print(f"[asm] {n} linhas enviadas à API.")

    df_log = spark.table("dev_brbi_opslgc.stg_execution_log_asm")
    log_rows = [row.asDict() for row in df_log.collect()]
    if log_rows:
        post_batch("/ingest/log", log_rows)
        print("[asm] log enviado.")

    r = requests.post(f"{API_BASE}/merge/asm", headers=HEADERS, timeout=60)
    r.raise_for_status()
    print(f"[asm] merge OK → {r.json()}")
except Exception as e:
    print(f"[asm] ERRO: {e}", file=sys.stderr)
    errors.append("asm")
finally:
    spark.stop()

if errors:
    raise SystemExit(f"Falhou: {errors}")
print("pg_sender concluído com sucesso.")
PYEOF

spark-submit \
  --master yarn \
  --deploy-mode client \
  --queue brbi-dev \
  /tmp/pg_sender_asm.py
