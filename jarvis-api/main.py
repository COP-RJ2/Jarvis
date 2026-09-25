"""
Ponte HTTP -> Postgres (Railway) pro pipeline Data Studio (Presto/Spark),
que não consegue conectar direto via JDBC (egress bloqueado pro proxy TCP
do Postgres). Roda como um serviço Railway próprio, na MESMA rede privada
do Postgres-merge (variáveis PG* injetadas via "Add Reference", sem passar
pelo proxy público) -- só a chamada Data Studio -> esta API que precisa
atravessar a internet, e isso já é HTTPS normal, sem bloqueio de egress.

Autenticação: mesma INGEST_API_KEY já usada pelo /api/ingest do JARVIS
(Bearer token) -- decisão do Roberto em 2026-09-24, pra não gerenciar
2 chaves separadas. O código original gerado pelo Data Studio Agent não
tinha autenticação nenhuma (qualquer um com a URL conseguia escrever nas
tabelas de produção) -- corrigido aqui antes do deploy.

Validação de colunas: bulk_insert() original colava as CHAVES do JSON
recebido direto na string SQL sem validar -- injeção de SQL via nome de
coluna malicioso no payload. Corrigido com uma lista de colunas permitidas
por tabela (schema real, conferido em produção antes de escrever este
arquivo).

ON CONFLICT: as 4 cláusulas do código original NÃO batiam com as chaves
primárias reais das tabelas export_* (conferido em produção) -- todo
merge ia falhar em runtime com "no unique or exclusion constraint
matching". Corrigido abaixo com as PKs reais:
  export_inbound_lh:  (soc_id, viagem)
  export_inbound_fm:  (soc_id, driver_id_spx, checkin_driver)
  export_asm:         (soc_id, ops_id, dt, hora)
  export_backlog:     (soc_id, dt, hora, faixa_aging, status_desc, grade_hrs)
"""
from fastapi import FastAPI, HTTPException, Header, Depends
from typing import Any, Optional
import psycopg2
import psycopg2.extras
import os
import hmac

app = FastAPI()

INGEST_API_KEY = os.environ["INGEST_API_KEY"]


def verificar_token(authorization: Optional[str] = Header(None)):
    token = (authorization or "").removeprefix("Bearer ").strip()
    # hmac.compare_digest em vez de != -- comparação de string normal vaza
    # timing (quanto mais prefixo bate, mais devagar falha), teoricamente
    # explorável pra descobrir a chave char a char (achado de revisão em
    # 2026-09-25).
    if not hmac.compare_digest(token, INGEST_API_KEY):
        raise HTTPException(status_code=401, detail="Token inválido.")


AUTENTICADO = Depends(verificar_token)


def get_conn():
    return psycopg2.connect(
        host=os.environ["PGHOST"],
        port=int(os.environ.get("PGPORT", 5432)),
        dbname=os.environ["PGDATABASE"],
        user=os.environ["PGUSER"],
        password=os.environ["PGPASSWORD"],
    )


# Colunas reais de cada staging table (schema conferido em produção em
# 2026-09-24) -- bulk_insert só aceita chaves que estejam nesta lista,
# qualquer chave fora daqui é rejeitada antes de tocar no SQL (evita a
# injeção via nome de coluna do código original).
COLUNAS_PERMITIDAS = {
    "stg_export_inbound_lh": {
        "viagem", "status_agrupado", "codigo_origem", "tipo_origem", "origem",
        "codigo_destino", "veiculo_utilizado", "numero_veiculo", "lacre",
        "data_operacao", "semana", "eta_destino_planejado", "eta_destino_ajustado",
        "eta_destino_realizado", "data_eta_ajustado", "hora_eta_ajustado",
        "data_eta_destino_realizado", "hora_eta_destino_realizado",
        "cutoff_eta_planejado", "cutoff_eta_realizado", "cutoff_descarga",
        "turno_planejado", "turno_chegada", "turno_descarga", "checkin_destino",
        "operador_checkin_destino", "abertura_bau", "inicio_descarga",
        "fim_descarga", "data_base_descarga", "hora_descarga", "total_pacotes",
        "total_tos", "pacotes_saca", "pacotes_scuttle", "pacotes_pallet",
        "pacotes_volumoso", "pacotes_outros", "tos_saca", "tos_scuttle",
        "tos_pallet", "tos_volumoso", "tos_outros", "nao_processado_spx",
        "pacotes_bulk", "pacotes_g", "pacotes_m", "pacotes_p", "pacotes_pp",
        "pacotes_nao_classificados", "solicitation_agrupado", "to_total_xd",
        "total_orders_xd", "doca_descarga", "soc_nome", "atraso_minutos",
        "classificacao_pontualidade", "exported_at", "dt", "hora", "soc_id",
    },
    "stg_export_inbound_fm": {
        "data", "data_operacional", "driver_id_spx", "trip_id_spx",
        "pickup_quantity", "trip_type", "station_name", "station_code",
        "tipo_operacao", "regional", "agency_name", "soc_id", "soc_nome",
        "ultimo_status", "checkin_driver", "hora_entrada_yms",
        "slot_hora_entrada_yms", "slot_chegada", "atribuicao_doca",
        "slot_atribuicao", "occupied_dock_name", "ocupacao_doca", "slot_doca",
        "finalizacao_jornada", "slot_fim", "turno_operacional",
        "tempo_de_fila", "tempo_de_descarga", "tempo_total_permanencia",
        "tempo_fila_minutos", "tempo_descarga_minutos", "tempo_total_minutos",
        "tempo_fila_horas", "tempo_descarga_horas", "tempo_total_horas",
        "meta_pacotes_hora", "meta_descarga_minutos", "meta_descarga_horas",
        "produtividade_real", "performance_doca", "desvio_meta_minutos",
        "classificacao_fila", "exported_at", "dt", "hora",
    },
    "stg_export_asm": {
        "soc_id", "ops_id", "cutoff", "actual_sort_time", "actual_sort_time_hour",
        "operator", "soc_nome", "zona", "nivel", "mesa", "scan_numbers",
        "classificacao_produtividade", "exported_at", "dt", "hora",
    },
    "stg_export_backlog": {
        "faixa_aging", "aging_rank", "status_desc", "soc_nome", "qtd_pacotes",
        "aging_medio_min", "criticidade", "grade_hrs", "qtd_grade",
        "ultima_atualizacao_tabela", "exported_at", "dt", "hora", "soc_id",
    },
    "stg_execution_log": {
        "pipeline", "soc_id", "soc_nome", "record_count", "window_start",
        "window_end", "executed_at", "dt", "hora",
    },
}


def bulk_insert(table: str, rows: list[dict]):
    if not rows:
        return 0
    permitidas = COLUNAS_PERMITIDAS[table]
    for r in rows:
        desconhecidas = set(r.keys()) - permitidas
        if desconhecidas:
            raise HTTPException(status_code=400, detail=f"Coluna(s) não reconhecida(s) pra {table}: {sorted(desconhecidas)}")

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                # União das chaves de TODAS as linhas, não só a primeira
                # (achado de revisão em 2026-09-25): payload vindo de
                # Presto/Hive -> JSON costuma OMITIR chave com valor null
                # em vez de mandar `"campo": null` -- se a 1ª linha do lote
                # tiver uma coluna null (omitida) e outra linha do MESMO
                # lote tiver valor nela, `cols` baseado só na 1ª linha
                # descartava essa coluna silenciosamente pra TODO o lote.
                # `.get(c)` já cobria o lado "linha sem a chave -> NULL";
                # faltava cobrir "coluna existe em alguma linha, mas não na
                # primeira".
                cols = sorted(set().union(*(r.keys() for r in rows)))
                sql = f"INSERT INTO public.{table} ({','.join(cols)}) VALUES %s"
                values = [[r.get(c) for c in cols] for r in rows]
                psycopg2.extras.execute_values(cur, sql, values, page_size=500)
        return len(rows)
    finally:
        conn.close()


@app.post("/ingest/inbound_lh", dependencies=[AUTENTICADO])
def ingest_lh(payload: list[dict[str, Any]]):
    return {"inserted": bulk_insert("stg_export_inbound_lh", payload)}


@app.post("/ingest/inbound_fm", dependencies=[AUTENTICADO])
def ingest_fm(payload: list[dict[str, Any]]):
    return {"inserted": bulk_insert("stg_export_inbound_fm", payload)}


@app.post("/ingest/asm", dependencies=[AUTENTICADO])
def ingest_asm(payload: list[dict[str, Any]]):
    return {"inserted": bulk_insert("stg_export_asm", payload)}


@app.post("/ingest/backlog", dependencies=[AUTENTICADO])
def ingest_backlog(payload: list[dict[str, Any]]):
    return {"inserted": bulk_insert("stg_export_backlog", payload)}


@app.post("/ingest/log", dependencies=[AUTENTICADO])
def ingest_log(payload: list[dict[str, Any]]):
    return {"inserted": bulk_insert("stg_execution_log", payload)}


# PKs reais conferidas em produção em 2026-09-24 (ver comentário no topo
# do arquivo) -- diferentes do que o código original tinha.
#
# DELETE...RETURNING numa CTE alimentando o INSERT (achado de revisão em
# 2026-09-25, substituindo o INSERT...SELECT + TRUNCATE separados de antes):
# a versão anterior tinha uma janela de corrida real -- se uma chamada
# concorrente a /ingest/* commitasse uma linha nova na staging DEPOIS do
# SELECT do INSERT mas ANTES do TRUNCATE, essa linha sumia sem erro nem log
# (o TRUNCATE apagava sem nunca ter sido lida). Uma única statement (DELETE
# FROM stg RETURNING * como fonte do INSERT) elimina essa janela -- é tudo
# atômico, não tem "entre as duas statements" pra correr.
MERGE_SQL = {
    # DISTINCT ON (pedido descoberto ao testar em 2026-09-24 -- a staging já
    # tinha 4992 linhas acumuladas em stg_export_asm com chave duplicada,
    # vindas de execuções anteriores nunca mergeadas; ON CONFLICT DO UPDATE
    # não tolera 2 linhas da MESMA chave dentro do mesmo INSERT, dá
    # CardinalityViolation. DISTINCT ON + ORDER BY ..., exported_at DESC
    # mantém só a linha mais recente por chave antes do INSERT.
    "inbound_lh": """
        WITH moved AS (
            DELETE FROM public.stg_export_inbound_lh RETURNING *
        )
        INSERT INTO public.export_inbound_lh
        SELECT DISTINCT ON (soc_id, viagem) * FROM moved
        ORDER BY soc_id, viagem, exported_at DESC
        ON CONFLICT (soc_id, viagem)
        DO UPDATE SET status_agrupado=EXCLUDED.status_agrupado, atraso_minutos=EXCLUDED.atraso_minutos,
                      classificacao_pontualidade=EXCLUDED.classificacao_pontualidade, exported_at=EXCLUDED.exported_at;
    """,
    "inbound_fm": """
        WITH moved AS (
            DELETE FROM public.stg_export_inbound_fm RETURNING *
        )
        INSERT INTO public.export_inbound_fm
        SELECT DISTINCT ON (soc_id, driver_id_spx, checkin_driver) * FROM moved
        ORDER BY soc_id, driver_id_spx, checkin_driver, exported_at DESC
        ON CONFLICT (soc_id, driver_id_spx, checkin_driver)
        DO UPDATE SET ultimo_status=EXCLUDED.ultimo_status, tempo_de_fila=EXCLUDED.tempo_de_fila,
                      tempo_de_descarga=EXCLUDED.tempo_de_descarga, exported_at=EXCLUDED.exported_at;
    """,
    "asm": """
        WITH moved AS (
            DELETE FROM public.stg_export_asm RETURNING *
        )
        INSERT INTO public.export_asm
        SELECT DISTINCT ON (soc_id, ops_id, dt, hora) * FROM moved
        ORDER BY soc_id, ops_id, dt, hora, exported_at DESC
        ON CONFLICT (soc_id, ops_id, dt, hora)
        DO UPDATE SET scan_numbers=EXCLUDED.scan_numbers,
                      classificacao_produtividade=EXCLUDED.classificacao_produtividade, exported_at=EXCLUDED.exported_at;
    """,
    "backlog": """
        WITH moved AS (
            DELETE FROM public.stg_export_backlog RETURNING *
        )
        INSERT INTO public.export_backlog
        SELECT DISTINCT ON (soc_id, dt, hora, faixa_aging, status_desc, grade_hrs) * FROM moved
        ORDER BY soc_id, dt, hora, faixa_aging, status_desc, grade_hrs, exported_at DESC
        ON CONFLICT (soc_id, dt, hora, faixa_aging, status_desc, grade_hrs)
        DO UPDATE SET qtd_pacotes=EXCLUDED.qtd_pacotes, aging_medio_min=EXCLUDED.aging_medio_min,
                      exported_at=EXCLUDED.exported_at;
    """,
}


@app.post("/merge/{dataset}", dependencies=[AUTENTICADO])
def merge(dataset: str):
    if dataset not in MERGE_SQL:
        raise HTTPException(status_code=404, detail="dataset not found")
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(MERGE_SQL[dataset])
        return {"status": "ok", "dataset": dataset}
    finally:
        conn.close()


@app.get("/health")
def health():
    return {"status": "ok"}
