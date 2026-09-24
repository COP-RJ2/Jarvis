"""
Ingest direto pro JARVIS -- helper pra qualquer job Pulse (RJ2/RJ6/SC1/SC2)
mandar dado "ontime" (ASM ao vivo, Sorting Exception, Sorter, Conveyor,
Monitor Fila, Monitor Outbound Live) direto pro Postgres do JARVIS, sem
passar pela planilha do meio.

Contrato do endpoint (ver api/ingest.js no repo do JARVIS):

    POST https://jarvis-production-692b.up.railway.app/api/ingest?fonte=<nome>&soc=<SOC>
    Header: Authorization: Bearer <INGEST_API_KEY>
    Body:   { "chave": "...", "data": {...} }
            ou em lote: { "rows": [ {"chave": "...", "data": {...}}, ... ] }

    GET  https://jarvis-production-692b.up.railway.app/api/ingest?fonte=<nome>&soc=<SOC>
    -> lista o que já está gravado (uso de conferência/debug), mesmo header
       de autenticação.

- `fonte`: identificador fixo da origem (ex.: "asm", "sorting_exception",
  "sorter", "conveyor", "monitor_fila", "monitor_outbound_live") -- precisa
  ser SEMPRE o mesmo texto pra cada job, senão o JARVIS trata como uma
  fonte nova em vez de atualizar a existente.
- `soc`: "RJ2" | "RJ6" | "SC1" | "SC2" (aceita também "SOC-RJ2" etc., já
  normaliza sozinho -- mas usar o formato curto é mais direto).
- `chave`: identificador único do REGISTRO dentro daquela fonte+soc (ex.:
  "2026-09-24T14:00_zona-A" pra uma leitura de ASM por hora/zona). Repetir
  a mesma chave faz UPDATE (upsert), não duplica.
- `data`: um dict JSON qualquer com os campos que a fonte já produz hoje
  (o mesmo dict que hoje vira uma linha na planilha, por exemplo).

Cada job Pulse precisa:
  1. Ter INGEST_API_KEY configurada como variável de ambiente/segredo
     (mesmo valor que já está configurado no Railway do JARVIS -- pedir
     pra quem administra os dois projetos).
  2. Chamar `enviar_para_jarvis(...)` (ou `enviar_lote_para_jarvis(...)`)
     na cadência que já usa hoje pra escrever na planilha, com o `soc`
     correspondente a esse job específico (Pulse RJ6 sempre manda
     soc="RJ6", nunca varia).
"""

import os
import requests

JARVIS_BASE_URL = "https://jarvis-production-692b.up.railway.app"
INGEST_API_KEY = os.environ["INGEST_API_KEY"]  # mesma chave configurada no Railway do JARVIS


def _headers():
    return {
        "Authorization": f"Bearer {INGEST_API_KEY}",
        "Content-Type": "application/json",
    }


def enviar_para_jarvis(fonte: str, soc: str, chave: str, data: dict, timeout=10):
    """Grava (ou atualiza) 1 registro. Levanta exceção se a chamada falhar
    -- decida no chamador se quer logar e seguir, ou re-tentar."""
    resp = requests.post(
        f"{JARVIS_BASE_URL}/api/ingest",
        params={"fonte": fonte, "soc": soc},
        json={"chave": chave, "data": data},
        headers=_headers(),
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def enviar_lote_para_jarvis(fonte: str, soc: str, registros: list[dict], timeout=15):
    """registros = [{"chave": "...", "data": {...}}, ...] -- manda tudo
    numa chamada só (mais eficiente que 1 chamada por registro quando o
    job já produz vários registros por ciclo)."""
    resp = requests.post(
        f"{JARVIS_BASE_URL}/api/ingest",
        params={"fonte": fonte, "soc": soc},
        json={"rows": registros},
        headers=_headers(),
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


# =============================================================================
# Exemplos de uso -- 1 por fonte "ontime" conhecida. Adapte a MONTAGEM do
# `chave`/`data` pro que cada job já calcula hoje (o helper acima não muda
# entre fontes, só o "fonte=" e o conteúdo do dict). SOC é sempre o mesmo
# fixo dentro de 1 job (Pulse RJ6 só manda soc="RJ6").
# =============================================================================

SOC_DESTE_JOB = "RJ6"  # trocar por RJ2 / SC1 / SC2 conforme o job

# --- ASM ao vivo -------------------------------------------------------------
def exemplo_asm_ao_vivo(hora: str, zona: str, inducoes: int, meta: int):
    chave = f"{hora}_{zona}"  # 1 registro por hora+zona
    dados = {"hora": hora, "zona": zona, "inducoes": inducoes, "meta": meta}
    enviar_para_jarvis("asm", SOC_DESTE_JOB, chave, dados)


# --- Sorting Exception --------------------------------------------------------
def exemplo_sorting_exception(hora: str, motivo: str, quantidade: int):
    chave = f"{hora}_{motivo}"
    dados = {"hora": hora, "motivo": motivo, "quantidade": quantidade}
    enviar_para_jarvis("sorting_exception", SOC_DESTE_JOB, chave, dados)


# --- Sorter (mesas/carrinhos/chutes) -----------------------------------------
def exemplo_sorter(hora: str, chute_id: str, volumes: int, status: str):
    chave = f"{hora}_{chute_id}"
    dados = {"hora": hora, "chute_id": chute_id, "volumes": volumes, "status": status}
    enviar_para_jarvis("sorter", SOC_DESTE_JOB, chave, dados)


# --- Conveyor -----------------------------------------------------------------
def exemplo_conveyor(hora: str, esteira: str, pacotes: int):
    chave = f"{hora}_{esteira}"
    dados = {"hora": hora, "esteira": esteira, "pacotes": pacotes}
    enviar_para_jarvis("conveyor", SOC_DESTE_JOB, chave, dados)


# --- Monitor Fila (LH) --------------------------------------------------------
def exemplo_monitor_fila(hora: str, veiculo_id: str, tempo_fila_min: float):
    chave = f"{hora}_{veiculo_id}"
    dados = {"hora": hora, "veiculo_id": veiculo_id, "tempo_fila_min": tempo_fila_min}
    enviar_para_jarvis("monitor_fila", SOC_DESTE_JOB, chave, dados)


# --- Monitor Outbound Live ----------------------------------------------------
def exemplo_monitor_outbound_live(hora: str, viagem_id: str, status: str):
    chave = f"{hora}_{viagem_id}"
    dados = {"hora": hora, "viagem_id": viagem_id, "status": status}
    enviar_para_jarvis("monitor_outbound_live", SOC_DESTE_JOB, chave, dados)


# --- Exemplo de lote (varios registros de 1 vez, ex.: fim de um ciclo) -------
def exemplo_lote_conveyor(hora: str, leituras: list[tuple[str, int]]):
    registros = [
        {"chave": f"{hora}_{esteira}", "data": {"hora": hora, "esteira": esteira, "pacotes": pacotes}}
        for esteira, pacotes in leituras
    ]
    enviar_lote_para_jarvis("conveyor", SOC_DESTE_JOB, registros)
