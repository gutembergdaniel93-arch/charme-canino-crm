---
name: setup-projeto
description: |
  Use esta skill quando o aluno (usuário) acabou de clonar/baixar o CRM e quer
  configurar tudo do zero. Frases-gatilho: "configurar projeto", "setup
  inicial", "primeira vez", "instalar", "começar do zero", "como configuro",
  "fazer funcionar", "deploy inicial", "/setup-projeto".

  Esta skill orquestra TODO o processo: criar/conectar Supabase, aplicar
  migrations, deployar edge functions, configurar API keys, criar instância
  WhatsApp, validar tudo. Foi criada porque há MUITAS armadilhas se feita na
  ordem errada (ex: criar UAZAPI antes de deployar webhook).
---

# Skill: Setup Inicial do Projeto CRM AI-First

## Quando esta skill é acionada

Sempre que o aluno pedir pra configurar o projeto pela primeira vez. Ela cobre
TUDO que aprendemos com o Frank — **nada pode ficar de fora**.

## Regras invioláveis (LEIA ANTES DE COMEÇAR)

1. **NUNCA execute nada sem autorização explícita do aluno.** Apresente o plano,
   espere "pode" / "autorizo" / "manda ver" e só então execute.
2. **Alterar local primeiro, validar, depois subir pra produção.**
3. **Nada hardcoded.** API keys ficam na tabela `config` (UI de Admin Config)
   e edge functions lêem via `getIntegrationKey()` (helper em `_shared/config.ts`).
4. **Ser direto e conciso.** Aluno geralmente não é técnico — guie passo a passo
   sem jargão.

## Pré-requisitos no computador do aluno

Verifique antes de começar:

```bash
node -v               # >= 18
npm -v
supabase --version    # >= 2.70 (instalar via brew install supabase/tap/supabase se não tiver)
```

Se algo faltar, instrua a instalar antes.

## ETAPA 1: Pegar projeto Supabase

Pergunte: o aluno **já tem um projeto Supabase criado** ou precisa criar agora?

### Se precisa criar:
1. Abra https://supabase.com/dashboard
2. Clique **New project**
3. Nome: "crm-aifirst-meu-negocio"
4. Region: **South America (São Paulo)**
5. Senha do banco: anote em local seguro
6. Aguarde ~2 min até criar
7. Vai pra **ETAPA 2** com o **project ref** (URL: `https://SEU_REF.supabase.co`)

### Se já tem:
Pegue o **project ref** (parte da URL).

## ETAPA 2: Conectar MCP do Supabase ao projeto

Se ainda não tem MCP configurado:

```bash
claude mcp add --transport http supabase https://mcp.supabase.com/mcp
```

Reinicie o Claude Code. Na próxima ferramenta `mcp__supabase__*` que chamar,
abre navegador pra OAuth.

Confirme acesso ao projeto do aluno:

```
mcp__supabase__list_projects
```

Deve aparecer o projeto na lista. Se não aparecer, pode ser conta errada.

## ETAPA 3: Criar `.env` local

```bash
cd <pasta_do_projeto>
cp .env.example .env
```

Edite `.env`:

```
VITE_SUPABASE_URL=https://SEU_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxxx...
VITE_APP_URL=http://localhost:8080
```

Use `mcp__supabase__get_project_url` e `mcp__supabase__get_publishable_keys`
para preencher.

## ETAPA 4: Instalar dependências

```bash
npm install
```

## ETAPA 5: APLICAR MIGRATIONS (ORDEM CRÍTICA)

Aplique as migrations em ordem:

1. **`000_base_schema.sql`** — schema completo (16k+ linhas, tabelas/RLS/RPCs base)
2. **`001_post_baseline_fixes.sql`** — FKs, RPCs adicionais, trigger do agente IA, tabela ai_agent_chat_events, storage buckets, realtime
3. **Demais migrations** em ordem alfabética (`20250126_*` em diante, exceto se removidas)
4. **`002_ai_agent_crons.sql`** — POR ÚLTIMO, depois que SUPABASE_PROJECT_URL estiver real

Use `mcp__supabase__apply_migration` para cada um.

**ATUALIZAR config.SUPABASE_PROJECT_URL com a URL real:**

```sql
UPDATE config SET value = 'https://SEU_PROJECT_REF.supabase.co'
WHERE key = 'SUPABASE_PROJECT_URL';
```

(O placeholder `__REPLACE_WITH_PROJECT_URL__` precisa ser trocado, senão trigger
e crons do agente IA não funcionam.)

## ETAPA 6: Desativar email confirmation no Supabase

1. Acesse https://supabase.com/dashboard/project/SEU_REF/auth/providers
2. Clique em **Email**
3. **Desmarque "Confirm email"**
4. Salve

(Senão o aluno precisa confirmar email cada vez que cria conta de teste.)

## ETAPA 7: Login do Supabase CLI

```bash
supabase login
```

Abre navegador → autoriza com a conta DONA do projeto Supabase do aluno.
Confirme:

```bash
supabase projects list | grep SEU_PROJECT_REF
```

## ETAPA 8: DEPLOY EDGE FUNCTIONS

ORDEM IMPORTANTE — algumas funções dependem de outras estarem deployadas.

**Webhooks e funções chamadas do browser (--no-verify-jwt):**
```bash
supabase functions deploy whatsapp-webhook --project-ref SEU_REF --no-verify-jwt
supabase functions deploy whatsapp-cloud-webhook --project-ref SEU_REF --no-verify-jwt
supabase functions deploy ai-sales-agent --project-ref SEU_REF --no-verify-jwt
supabase functions deploy wavoip-webhook --project-ref SEU_REF --no-verify-jwt
supabase functions deploy soniox-token --project-ref SEU_REF --no-verify-jwt
supabase functions deploy google-calendar-webhook --project-ref SEU_REF --no-verify-jwt
```

⚠️ **`soniox-token` PRECISA de `--no-verify-jwt`**. É chamada do browser e o gateway do Supabase rejeita antes da função rodar se o JWT do user não for detectado. A própria função valida o `apikey` header.

**Demais funções (verify_jwt=true por padrão) — 46 funções:**
```bash
for fn in sync-whatsapp-status sync-whatsapp-groups sync-missed-messages send-whatsapp-cloud whatsapp-task-assistant whatsapp-group generate-sales-message calculate-lead-score chat-manager generate-briefing extract-lead-from-image suggest-proposal template-extractor analyze-conversation analyze-sales-call coach-suggestion save-lead-insights process-call-recording process-call-transcription process-team-meeting process-automation-rules process-message-sequences process-scheduled-messages process-noshow-followup process-notification-event process-notification-rules process-task-reminders check-hot-leads check-pending-meetings check-sales-alerts daily-sales-digest calculate-commission manage-team-member sync-member-data batch-fetch-avatars migrate-profile-photos health-check sync-google-calendar setup-calendar-watch renew-calendar-watches create-calendar-event send-meeting-email book-meeting extract-meeting-datetime roleplay-session roleplay-evaluate; do
  supabase functions deploy $fn --project-ref SEU_REF
done
```

**Atalho pra deployar TUDO de uma vez** (ignora flag por função — todas vão pra `verify_jwt=true` default EXCETO as que têm config em `supabase/functions/<nome>/deno.json` ou `--no-verify-jwt` acima):
```bash
# Deploy tudo em paralelo — mais rápido, mas logs misturados
ls supabase/functions | grep -v _shared | xargs -I {} -P 4 supabase functions deploy {} --project-ref SEU_REF
```

(O conjunto exato depende de quais módulos foram mantidos no template do aluno. Se faltar alguma, a UI vai dar 404 na primeira chamada e você deploya só ela.)

## ETAPA 9: Login no CRM

```bash
npm run dev
```

Abre http://localhost:8080 (ou a porta que o Vite escolher) e:

1. Clique **Criar conta** com seu email
2. Loga
3. Vai pra **Configurações** (canto inferior esquerdo)

## ETAPA 10: Cadastrar API Keys (CRÍTICO)

**REGRA INVIOLÁVEL**: TUDO fica em `Configurações → Integrações`. Nenhuma
chave é hardcoded no código. As edge functions lêem via `getIntegrationKey()`
da tabela `config`.

### Obrigatórias (core funcionar):

| Chave | Pra que serve | Onde pegar |
|---|---|---|
| `ANTHROPIC_API_KEY` | Agente IA, briefings, scoring, coach, bot de tarefas | https://console.anthropic.com/settings/keys |
| `GEMINI_API_KEY` | Transcrição áudio + descrição imagem + extração data reunião | https://aistudio.google.com/app/apikey |
| `UAZAPI_ADMIN_URL` | URL da instância UAZAPI | painel UAZAPI |
| `UAZAPI_ADMIN_TOKEN` | Admin token UAZAPI | painel UAZAPI |

### Opcionais (só se o aluno usar esses módulos):

| Chave | Quando precisa | Onde pegar |
|---|---|---|
| `OPENAI_API_KEY` | Whisper (alternativa ao Gemini pra áudio) | https://platform.openai.com/api-keys |
| `SONIOX_API_KEY` | Transcrição real-time em ligações VoIP | https://soniox.com |
| `WHATSAPP_CLOUD_TOKEN` | WhatsApp Cloud API oficial Meta (alternativa à UAZAPI) | https://developers.facebook.com/docs/whatsapp/cloud-api |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID do WhatsApp Business (par com `WHATSAPP_CLOUD_TOKEN`) | Meta Dashboard > WhatsApp > API Setup |
| `GOOGLE_CLIENT_ID` | OAuth do Google Calendar | https://console.cloud.google.com/apis/credentials |
| `GOOGLE_CLIENT_SECRET` | OAuth do Google Calendar | https://console.cloud.google.com/apis/credentials |
| `ASAAS_API_KEY` | Gateway de pagamento (cobranças, boletos, PIX) | https://docs.asaas.com |
| `RESEND_API_KEY` | Emails transacionais (convites de reunião, alerts) | https://resend.com/api-keys |

**Cobertura de mídia:**
- Áudio precisa de `GEMINI_API_KEY` OU `OPENAI_API_KEY`
- Imagem (visão) precisa de `GEMINI_API_KEY` (Claude vision não usado pela edge function ainda)

**IMPORTANTE pra WhatsApp Cloud API**: precisa de DUAS chaves (`WHATSAPP_CLOUD_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`). Se só preencher uma, a edge function `send-whatsapp-cloud` falha com erro "Integração não configurada".

## ETAPA 11: Criar instância WhatsApp UAZAPI

**SOMENTE depois das edge functions estarem deployadas!**
(Senão o webhook URL não responde quando a UAZAPI tenta entregar msgs.)

1. Em **Configurações → Integrações → WhatsApp**
2. Clique **Criar Instância** → dá um nome
3. O sistema cria via UAZAPI, configura webhook automaticamente
4. Clique **Gerar QR Code**
5. Escaneie no celular (WhatsApp → Aparelhos conectados → Conectar aparelho)
6. Status muda pra **Conectado** automaticamente (realtime + polling)

## ETAPA 12: Vincular instância WhatsApp ao usuário

Em **Configurações → Equipe → Membros do Time**, edite seu próprio usuário e
vincule à instância criada.

## ETAPA 13: Criar Agente IA

Use a skill **`/criar-agente-ia`** (já incluída no projeto). Ela vai te
entrevistar sobre o seu negócio e configurar tudo (system prompt, tools,
horário, etc).

## ETAPA 14: Validação final

Teste enviando uma msg do seu celular pessoal pro WhatsApp do CRM:

1. Mensagem entra no `whatsapp_messages` (banco)
2. Trigger `trg_enqueue_for_ai_agent` dispara
3. `ai-sales-agent` processa
4. Sandra (ou seu agente) responde via UAZAPI

Se algum passo falhar, verifique:
- `mcp__supabase__execute_sql` → `SELECT * FROM ai_agent_chat_events ORDER BY created_at DESC LIMIT 10;` (eventos recentes)
- `mcp__supabase__get_logs(service:'edge-function')` (logs das funções)

## Anti-patterns (não fazer)

- ❌ Criar instância UAZAPI ANTES de deployar webhooks
- ❌ Pular `001_post_baseline_fixes.sql` (perde 18 FKs + 16 RPCs)
- ❌ Aplicar `002_ai_agent_crons.sql` antes de atualizar `SUPABASE_PROJECT_URL`
- ❌ Hardcodar API keys em código (use sempre `getIntegrationKey()` em edge function; UI salva em `config` via Upsert)
- ❌ Esquecer de rodar `supabase login` (deploy retorna 403)
- ❌ Esquecer de desativar Email Confirm no Supabase Auth
- ❌ Pular a migration `20260415_call_recordings_bucket.sql` (bucket de gravações → upload de call-recordings falha com 400)
- ❌ Cadastrar SÓ `WHATSAPP_CLOUD_TOKEN` sem `WHATSAPP_PHONE_NUMBER_ID` (ou vice-versa) — Cloud API precisa dos DOIS

## Finalizacao (OBRIGATORIO)

Ao terminar TODAS as etapas com sucesso, crie o arquivo de controle:

```bash
touch .setup-complete
```

Isso impede que o Claude Code reinicie o setup na proxima vez que o aluno abrir
o projeto.

## Checklist final (entregue ao aluno)

- [ ] Schema base aplicado (000)
- [ ] Patch fixes aplicado (001)
- [ ] config.SUPABASE_PROJECT_URL com URL real
- [ ] Migrations `20250126_*` a `20260415_*` aplicadas (inclui bucket `call-recordings`)
- [ ] Crons aplicados (002)
- [ ] Email confirmation desativado
- [ ] CLI Supabase logado na conta certa
- [ ] Edge functions deployadas (52 no total)
- [ ] API keys OBRIGATÓRIAS cadastradas (Anthropic + Gemini + UAZAPI URL + UAZAPI Token)
- [ ] API keys OPCIONAIS (só se usar o módulo): Soniox (telefonia), WhatsApp Cloud Token+Phone ID, Google Client ID+Secret (calendar), Asaas (pagamento), Resend (email)
- [ ] Instância WhatsApp criada e conectada (QR escaneado)
- [ ] Membro do time vinculado à instância
- [ ] Agente IA criado (via /criar-agente-ia)
- [ ] Teste E2E: msg WhatsApp → agente responde

## Aprendizados desta versão (changelog do skill)

- **v2 (2026-04-15)**: Adicionado `WHATSAPP_PHONE_NUMBER_ID` (era hardcoded na edge function, agora em Configurações). Todas 4 edge functions `send-whatsapp-cloud`, `whatsapp-task-assistant`, `extract-meeting-datetime`, `sync-google-calendar` agora lêem 100% via `getIntegrationKey()`. Nenhuma chave/ID hardcoded em código. Bucket `call-recordings` criado automaticamente pela migration `20260415_call_recordings_bucket.sql`. WaVoIP com 3 patches no `src/lib/wavoip-init.ts` (já no código, sem ação do aluno).
