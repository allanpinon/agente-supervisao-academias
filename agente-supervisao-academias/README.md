# Agente de Supervisão — Greco Forma & Fit.com

Serviço que acompanha os atendimentos feitos pela central (GymBot), avalia
cada conversa com a Claude (qualidade do atendimento) e envia relatórios
diário, semanal e mensal por WhatsApp, separados por marca.

Este README é o guia de referência da Fase 4 (deploy). Vamos executar esses
passos juntos, um de cada vez — este documento fica aqui só como consulta.

## O que este serviço faz

1. Recebe eventos do GymBot em tempo real via webhook (`POST /webhook/gymbot`).
2. Grava leads, atendimentos e avaliações qualitativas (feitas pela Claude)
   nas 5 planilhas do Google Sheets.
3. Antes de cada relatório, roda uma "varredura de reconciliação": reconfere
   na API do GymBot quais atendimentos pendentes já foram classificados como
   concluídos com sucesso (porque essa classificação é feita manualmente
   pela equipe e com atraso).
4. Calcula os números exatos do período (leads, atendidos, fechados,
   conversão, tempo médio até conversão) e pede pra Claude uma síntese
   qualitativa por atendente.
5. Envia o relatório formatado pro grupo de WhatsApp da marca (via
   Evolution API), nos horários combinados:
   - Diário — todos os dias às 22h.
   - Semanal — toda segunda-feira às 8h.
   - Mensal — no último dia do mês, junto do relatório diário.

## Variáveis de ambiente necessárias

Ver `.env.example` para a lista completa com comentários. As mais sensíveis
(token do GymBot, chave da Evolution API, JSON da conta de serviço do
Google) **não devem ser coladas em nenhum chat** — vamos preenchê-las
diretamente como "Variáveis"/"Secrets" no Railway, na Fase 4.

## Rodando localmente (opcional, só para testes)

```
npm install
cp .env.example .env
# preencher o .env com os valores reais
npm start
```

## Importador histórico (execução única)

Depois que o serviço estiver publicado e testado, rodamos uma vez:

```
npm run import-history
```

Por padrão importa os últimos 30 dias (o mesmo escopo combinado, custo
estimado ~US$ 22 em uso da API da Claude). Para importar outro número de
dias: `node scripts/import-history.js 15` (15 dias, por exemplo).

## Pontos de calibração pendentes (só resolvem com dado real de produção)

Estes pontos estão sinalizados no próprio código com comentários
"CALIBRACAO PENDENTE" / "a confirmar":

- `CLASSIFICATION_SUCCESS_CATEGORY` (`src/config.js`): valor real do enum
  que representa "Objetivo atingido" — hoje está com um valor placeholder.
- `src/utils/transcript.js`: nomes de campo da resposta de
  `GET /session/{id}/message` (mensagem por mensagem) — hoje é uma suposição
  razoável, ajustar assim que virmos uma resposta real.
- Se existe um campo de data mais preciso para "quando a classificação foi
  feita" do que `session.updatedAt`.
- Se `classification.amount` vem sempre preenchido nas vendas.
- Autenticação/segurança do webhook do GymBot (checar se ele assina as
  chamadas, e validar isso no handler se sim).

## Estrutura de pastas

```
src/
  clients/       # GymBot, Google Sheets, Evolution API, Claude
  pipeline/      # processa eventos do webhook (contato, sessão, pagamento)
  webhook/       # rota HTTP do webhook
  reconciliation/# varredura pré-relatório
  reports/       # cálculo, síntese, formatação e envio dos relatórios
  jobs/          # agendamento (node-cron)
  utils/         # datas, tags, transcript, logger
scripts/
  import-history.js  # importador histórico (execução única)
```
