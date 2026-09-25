# Replicar o `spark-submit` pra Inbound LH, Inbound FM e Backlog

## Contexto

O padrão `spark-submit` já validado e funcionando pra `asm` (26/09/2026 — `export_asm` recebendo dado real de hora em hora) precisa ser replicado pros outros 3 workflows: `inbound_lh`, `inbound_fm`, `backlog`. A lógica é idêntica, só muda:

1. O nome da tabela Hive de staging (equivalente a `dev_brbi_opslgc.stg_asm_hourly`).
2. O nome da tabela Hive de log (equivalente a `dev_brbi_opslgc.stg_execution_log_asm`).
3. O endpoint de ingest/merge na API (já existem os 4, só trocar o nome no path).

## Antes de rodar: confirme os nomes das tabelas Hive

**Não presuma o nome** — cada workflow já tem uma task `spark_export_<dataset>` que grava numa tabela de staging própria no Hive. Abra essa task (a que já roda hoje, antes do merge) e confirme:

- Qual tabela ela grava (`dev_brbi_opslgc.stg_???`)?
- Qual tabela o `spark_export_log_<dataset>` correspondente grava?

Preencha na tabela abaixo antes de gerar os scripts (os nomes que coloquei são um CHUTE seguindo o padrão do `asm`, **confirme antes de usar**):

| Dataset | Hive staging (confirmar) | Hive log (confirmar) | Endpoint API | Task Data Studio |
|---|---|---|---|---|
| `inbound_lh` | `dev_brbi_opslgc.stg_inbound_lh_hourly` | `dev_brbi_opslgc.stg_execution_log_inbound_lh` | `/ingest/inbound_lh` + `/merge/inbound_lh` | `pg_merge_inbound_lh` |
| `inbound_fm` | `dev_brbi_opslgc.stg_inbound_fm_hourly` | `dev_brbi_opslgc.stg_execution_log_inbound_fm` | `/ingest/inbound_fm` + `/merge/inbound_fm` | `pg_merge_inbound_fm` |
| `backlog` | `dev_brbi_opslgc.stg_backlog_hourly` | `dev_brbi_opslgc.stg_execution_log_backlog` | `/ingest/backlog` + `/merge/backlog` | `pg_merge_backlog` |

Os 4 endpoints (`/ingest/inbound_lh`, `/ingest/inbound_fm`, `/ingest/backlog`, `/merge/inbound_lh`, `/merge/inbound_fm`, `/merge/backlog`) **já existem** na API (`jarvis-api`), não precisa mudar nada do lado do Railway — só apontar o script certo pra eles.

## Template do script (troque `<DATASET>` pelos valores confirmados)

Use o mesmo `PG_API_URL`/`PG_API_KEY` já configurados no Workflow (substituição de texto, mesma lógica do `asm`).

```bash
#!/bin/bash
set -e

cat > /tmp/pg_sender_<DATASET>.py << 'PYEOF'
from pyspark.sql import SparkSession
import requests, sys

spark = SparkSession.builder \
    .appName("pg_sender_<DATASET>") \
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
    df = spark.table("dev_brbi_opslgc.stg_<DATASET>_hourly")  # <-- confirme o nome real
    rows = [row.asDict() for row in df.collect()]
    print(f"[<DATASET>] {len(rows)} linhas lidas.")
    if rows:
        n = post_batch("/ingest/<DATASET>", rows)
        print(f"[<DATASET>] {n} linhas enviadas à API.")

    df_log = spark.table("dev_brbi_opslgc.stg_execution_log_<DATASET>")  # <-- confirme o nome real
    log_rows = [row.asDict() for row in df_log.collect()]
    if log_rows:
        post_batch("/ingest/log", log_rows)
        print("[<DATASET>] log enviado.")

    r = requests.post(f"{API_BASE}/merge/<DATASET>", headers=HEADERS, timeout=60)
    r.raise_for_status()
    print(f"[<DATASET>] merge OK → {r.json()}")
except Exception as e:
    print(f"[<DATASET>] ERRO: {e}", file=sys.stderr)
    errors.append("<DATASET>")
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
  /tmp/pg_sender_<DATASET>.py
```

**Atenção**: `/ingest/log` é o MESMO endpoint pros 4 datasets (a tabela `stg_execution_log` no Postgres é única, coluna `pipeline` distingue a origem — confira se a tabela Hive de log já traz essa coluna preenchida certo). Não precisa (nem deve) trocar esse endpoint por dataset.

## Como aplicar

Pra cada um dos 3 (`inbound_lh`, `inbound_fm`, `backlog`):
1. Confirme os 2 nomes de tabela Hive (staging + log) na task `spark_export_<dataset>`/`spark_export_log_<dataset>` que já existe e já funciona.
2. Copie o template acima, substitua todo `<DATASET>` pelo nome certo (ex.: `inbound_lh`).
3. Cole na tarefa `pg_merge_<dataset>` correspondente (mesmo lugar onde colou o do `asm`).
4. Salve a tarefa + o workflow inteiro.
5. Rode o workflow manualmente uma vez pra testar.

## Como eu valido depois

Me avisa quando rodar cada um — eu confirmo do lado do Postgres se o dado chegou certo em `export_inbound_lh`/`export_inbound_fm`/`export_backlog` e se a staging esvaziou (mesmo processo que usei pra confirmar o `asm`).
