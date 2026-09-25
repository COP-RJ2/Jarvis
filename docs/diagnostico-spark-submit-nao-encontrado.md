# Diagnóstico — `spark-submit: command not found`

## O que aconteceu

Uma execução manual (adhoc) do workflow `asm` falhou com:

```
spark-submit: command not found
```

(exit code 127). Isso é um erro de **ambiente**, não do script — o container onde essa execução rodou não tem o programa `spark-submit` instalado, ou ele está instalado num caminho que não está no `PATH` do shell.

**Importante**: o agendamento normal (cron automático) continua funcionando — o erro foi só nessa tentativa manual/adhoc, que aparentemente roda num container diferente do worker que executa o agendamento de verdade.

## O que fazer

Crie uma **tarefa Shell temporária** (só pra esse teste, pode apagar depois) com o conteúdo abaixo, e rode ela:

```bash
#!/bin/bash
echo "=== which spark-submit ==="
which spark-submit 2>&1 || echo "NAO ENCONTRADO no PATH"

echo ""
echo "=== PATH atual ==="
echo $PATH

echo ""
echo "=== Locais comuns ==="
ls /opt/spark/bin/spark-submit 2>&1 || echo "/opt/spark/bin: NAO EXISTE"
ls /usr/lib/spark/bin/spark-submit 2>&1 || echo "/usr/lib/spark/bin: NAO EXISTE"
ls /usr/local/bin/spark-submit 2>&1 || echo "/usr/local/bin: NAO EXISTE"
ls /usr/bin/spark-submit 2>&1 || echo "/usr/bin: NAO EXISTE"

echo ""
echo "=== find geral (pode demorar) ==="
find /opt /usr /home -name "spark-submit" -type f 2>/dev/null | head -10 || echo "Nada encontrado"
```

Esse script é **só leitura** — não muda nada, não grava nada, seguro de rodar.

## Depois de rodar

Copia o resultado (tudo que apareceu na tela) e manda de volta — com isso dá pra saber o caminho certo do `spark-submit` (ou confirmar que ele realmente não está instalado nesse container específico) e corrigir os scripts que usam `spark-submit` de uma vez.
