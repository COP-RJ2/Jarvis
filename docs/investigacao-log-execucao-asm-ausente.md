# Investigação — `stg_execution_log` sem entrada nova de ASM

## Contexto

O workflow `asm` (via `spark-submit`, lendo Hive direto e mandando pra `jarvis-api`) rodou com sucesso em 26/09/2026 de madrugada — confirmado do lado do Postgres:

- `export_asm`: subiu de 2.858 pra **2.904 linhas**, com `exported_at` recente.
- `stg_export_asm`: **0 linhas** (staging esvaziada corretamente após o merge).

Ou seja, o fluxo principal (Hive → API → merge → `export_asm`) funcionou de ponta a ponta.

## O problema

O log de execução (`stg_execution_log`) **não recebeu nenhuma entrada nova pra `asm`** nesse run. A entrada mais recente lá é de outro pipeline (`backlog`), datada de 22/09/2026 — antes até da migração pro `spark-submit`.

## O que o script faz (`pg_merge_asm-spark-submit.sh`)

```python
df_log = spark.table("dev_brbi_opslgc.stg_execution_log_asm")
log_rows = [row.asDict() for row in df_log.collect()]
if log_rows:
    post_batch("/ingest/log", log_rows)
    print("[asm] log enviado.")
```

O envio do log só acontece **se `stg_execution_log_asm` tiver linha** na hora em que o Spark lê. Se a tabela Hive `dev_brbi_opslgc.stg_execution_log_asm` estava vazia nesse run, o `if log_rows:` nunca entra — nada é enviado, e isso é esperado (não é bug do `pg_merge_asm`, é ausência de dado na origem).

## O que verificar (lado Data Studio)

1. **A task `spark_export_log_asm` (que grava em `stg_execution_log_asm`) rodou antes do `pg_merge_asm` nesse workflow?** Se a ordem/dependência entre as tasks não estiver garantindo isso, o merge pode rodar antes do log existir.
2. **`spark_export_log_asm` gravou alguma linha de fato?** Consultar `dev_brbi_opslgc.stg_execution_log_asm` direto no Hive logo após o run, pra confirmar se tinha dado ali ou se veio vazia.
3. Se a tabela Hive realmente veio vazia: investigar por que `spark_export_log_asm` não gravou nada nesse ciclo (pode ser um filtro de janela de tempo que não encontrou dado nova hora, por exemplo).

## Não é bloqueante

O dado principal (`export_asm`) chegou certinho — isso é só o log de auditoria da execução, não afeta o dado operacional em si. Mas vale fechar esse ponto pra manter o log confiável daqui pra frente.
