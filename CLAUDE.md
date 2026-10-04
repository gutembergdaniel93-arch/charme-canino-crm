# CRM AI-First — Template Comercial (Alunos IA na Pratica)

---

## ⚠️ DETECCAO DE PRIMEIRO USO (LEIA ANTES DE QUALQUER RESPOSTA)

**Passo 0 — auto-conserto das skills:** a pasta `.claude/` e oculta e pode se perder
quando o aluno copia/move o projeto (arrastar no Finder, `cp *`, uploads). Se
`.claude/skills/` NAO existir, recrie a partir do backup visivel antes de qualquer coisa:

```bash
mkdir -p .claude && cp -R docs/claude-skills/skills .claude/skills && cp -R docs/claude-skills/commands .claude/commands
```

O backup em `docs/claude-skills/` e identico ao original.

**Se o arquivo `.setup-complete` NAO existir na raiz do projeto, o aluno esta abrindo
o projeto pela primeira vez.** Nesse caso, IGNORE a primeira mensagem do aluno (seja
"oi", "ajuda", "começar", "o que faço", "???", ou qualquer outra coisa) e execute
IMEDIATAMENTE a skill `/setup-projeto`.

Comece respondendo assim:

> "Opa, beleza? Vi que você acabou de baixar o CRM. Vou te guiar na configuração
> do zero — é tranquilo, só seguir os passos. Antes de começar, deixa eu conferir
> se você já tem as contas necessárias..."

E ai dispara o fluxo da skill `/setup-projeto`.

**Ao final do setup, crie o arquivo `.setup-complete`** (`touch .setup-complete`)
pra essa deteccao nao repetir.

Se `.setup-complete` JA existir, siga o fluxo normal da conversa.

---

## O que e este projeto

CRM comercial AI-first, limpo, pronto pra ser entregue aos alunos do programa
IA na Pratica. So funcionalidades de vendas: pipeline, inbox WhatsApp, agente
de IA, coach em tempo real, treinamento e gestao basica de time.

**Numeros (revisao de 12/07/2026):** 28 paginas | ~16 pastas de componentes | ~79 hooks |
92 Edge Functions + `_shared` | 46 migrations.

## Stack

- **Frontend**: React 18 + TypeScript + Vite 6.4 + Tailwind CSS 3 + shadcn/ui + Lucide Icons
- **Estado**: TanStack Query v5 + React Hook Form + Zod
- **Backend**: Supabase (PostgreSQL + Edge Functions Deno + Realtime + Auth + RLS)
- **IA**:
  - Anthropic Claude — agente vendedor, scoring, mensagens, briefings
  - Google Gemini — coach real-time, analise de chamadas
  - OpenAI — Whisper (transcricao)
- **WhatsApp**: UAZAPI (multi-instancia, QR Code) + WhatsApp Cloud API (oficial Meta)
- **Telefonia**: WaVoIP + Soniox (transcricao real-time)
- **Calendario**: Google Calendar (OAuth2)
- **Deploy**: Vercel (auto-deploy via GitHub)

## Modulos ativos

Ficam em `/configuracoes > Modulos`.

### Comercial (ON por padrao)
- Cockpit do vendedor (visao diaria, ligacoes, hot leads)
- Dashboard comercial (pipeline metrics, ranking, alertas)
- Pipeline Kanban (drag & drop, estagios configuraveis, multi-pipeline)
- Leads com Scoring IA + BANT
- Deals / Oportunidades (com pagamentos e comissoes)
- Inbox WhatsApp comercial (UAZAPI + Cloud API, multi-instancia)
- Telefonia (chamadas VoIP com transcricao real-time)
- **Agente IA autonomo** (responde leads via WhatsApp 24/7)
- **Coach IA real-time** (sugestoes durante chamadas)
- Reunioes + Google Calendar (gravacao e resumo com IA)
- Automacoes + Cadencias de follow-up (sequencias de mensagem)
- Comissoes
- Playbooks e Scripts de vendas
- **Treinamento + Roleplay com IA**
- **Social Selling no Instagram** (qualifica seguidores via IA Claude Haiku, executa cadência humanizada via **Extensão Chrome** — Manifest V3, service worker, sem Playwright)
- Materiais de venda
- Agenda
- Workspace

### Gestao Basica (ON por padrao)
- Tarefas
- Calendario da equipe
- Reunioes

### Telefonia VoIP (OFF por padrao)
- Ativa dispositivos WaVoIP
- Gravacao automatica + transcricao Soniox

### Analytics Avancado (OFF por padrao)
- Dashboards detalhados adicionais

## Configuracoes Unificadas

Todas as configs em `/configuracoes` com sidebar de navegacao.

### Secoes:
- **Geral**: Modulos ON/OFF, Perfil, Aparencia (tema), Google Calendar
- **Integracoes**: API Keys (todas as chaves), WhatsApp (UAZAPI), Telefonia VoIP
- **Comercial**: Pipeline (estagios), Templates de Analise, Produtos, Materiais,
  Playbooks, Comissoes, Automacoes
- **IA & Bots**: Agente de Vendas, Coach
- **Equipe**: Membros do Time (CRUD + vinculacao WhatsApp), Treinamento
- **Notificacoes**: Regras, Bot de Tarefas

### WhatsApp (UAZAPI) via UI:
- Admin configura URL + Admin Token em API Keys
- Cria instancias direto pela UI (so precisa do nome)
- Gera QR Code e conecta
- Vincula membros a instancias (1 instancia = N membros)
- Webhook configurado automaticamente

## Estrutura de arquivos

```
src/
|- pages/           -> 28 paginas
|- components/      -> 16 pastas de componentes
|  |- ui/           -> shadcn/ui base
|  |- sales/        -> Componentes do comercial (pipeline, deals, leads, ai/, payments/, dashboard/)
|  |- inbox/        -> Inbox (WhatsApp chat, conversas)
|  |- coach/        -> Coach IA playbooks
|  |- cockpit/      -> Cockpit de vendas
|  |- funnel/       -> Funil visual
|  |- agenda/       -> Componentes da agenda
|  |- calls/        -> Telefonia (chamadas, gravacoes, coach)
|  |- meeting/      -> Reunioes (transcricao, painel global)
|  |- tasks/        -> Tarefas
|  |- timeline/     -> Timeline de lead/deal
|  |- products/     -> Produtos
|  |- settings/     -> Secoes da pagina de configuracoes
|  |- shared/       -> Componentes compartilhados
|  |- layout/       -> AppSidebar, AppLayout
|  |- focus-mode/   -> Modo foco
|- hooks/           -> 79 hooks (React Query)
|- contexts/        -> Auth, Call, Meeting, FocusMode, DemoMode, Theme
|- types/           -> Tipagens TypeScript
|- lib/             -> Utilitarios (Supabase client, etc)
|- services/        -> Servicos (Google Calendar, WhatsApp)

supabase/
|- functions/       -> 92 Edge Functions + codigo compartilhado
|- migrations/      -> 46 migrations SQL
|- cleanup_unused_tables.sql  -> Script para dropar tabelas dos modulos removidos
```

## Edge Functions (52)

### IA (nucleo)
- `ai-sales-agent` — Agente IA que responde leads via WhatsApp
- `coach-suggestion` — Coach IA real-time durante chamadas
- `analyze-conversation` — Analise de conversas
- `analyze-sales-call` — Analise de chamadas
- `calculate-lead-score` — Score IA de leads
- `chat-manager` — Gerenciador de chat IA
- `generate-briefing` — Briefings automaticos de leads
- `generate-sales-message` — Geracao de mensagens personalizadas
- `extract-lead-from-image` — OCR de leads via print
- `save-lead-insights`, `template-extractor`, `suggest-proposal`
- `roleplay-session`, `roleplay-evaluate` — Treinamento com IA

### WhatsApp
- `whatsapp-webhook` (UAZAPI)
- `whatsapp-cloud-webhook` (Meta Cloud API)
- `send-whatsapp-cloud` (envio Cloud API)
- `whatsapp-task-assistant` — Bot de tarefas
- `sync-whatsapp-groups`, `sync-whatsapp-status`, `sync-missed-messages`
- `whatsapp-group`, `process-scheduled-messages`, `process-message-sequences`

### Telefonia
- `process-call-recording`, `process-call-transcription`
- `soniox-token` (transcricao real-time)
- `wavoip-webhook`

### Google Calendar
- `sync-google-calendar`, `google-calendar-webhook`
- `setup-calendar-watch`, `renew-calendar-watches`
- `create-calendar-event`, `send-meeting-email`
- `book-meeting`, `extract-meeting-datetime`
- `process-team-meeting`

### Automacoes / Alertas / Notificacoes
- `process-automation-rules`
- `check-hot-leads`, `check-sales-alerts`, `check-pending-meetings`
- `process-noshow-followup`
- `daily-sales-digest`
- `process-notification-event`, `process-notification-rules`
- `process-task-reminders`

### Social Selling (Instagram) — v2 com Extensão Chrome (substituiu Playwright)
- `social-selling-qualify-followers` — qualifica @s via IA Claude Haiku, gate de perfil privado, cria lead+deal+enrollment (substituiu `qualify-instagram-lead`)
- `social-selling-plan-day` — gera plano humanizado de acoes do dia (ordem random, delays, skip 10%, working hours, trava entre dias = virada do dia BR)
- `generate-social-selling-message` — gera mensagens contextuais (comentario, story reply, DM) no tom configurado + classificador anti-post-pessoal
- `log-social-selling-action` — registra acao, avanca cadencia, espelha DMs em instagram_messages, move card no kanban
- `get-social-selling-enrollments` — lista enrollments ativos + interactions_today
- `social-selling-config-api` — API REST genérica pra extensão (get/set config, list/update/create automations, list_pipelines, list_today_actions)
- `social-selling-mark-reply` — marca lead como respondeu (move pra etapa Respondeu)

**Tabela nova:** `social_selling_known_followers` (cache de seguidores qualificados/rejeitados, UNIQUE `(username, for_account)`).
**Função:** `ss_actions_today(p_action)` — rate-limit diário por tipo de ação.
**Realtime ativo:** `social_selling_enrollments`, `social_selling_interactions`, `social_selling_known_followers`.

**Extensão Chrome:** `/extension/` na raiz do repo. Build com `cd extension && npm install && npm run build` → `extension/dist/` pronto pro Chrome carregar (Manifest V3). Ver `extension/INSTALL.md` pra setup completo (10 min).

### Utilitarios
- `calculate-commission`
- `manage-team-member`, `sync-member-data`
- `batch-fetch-avatars`, `migrate-profile-photos`
- `health-check`

## Chaves de integracao

Configurar pela UI em **Configuracoes > Integracoes > API Keys**.
As edge functions leem via `getIntegrationKey()` da tabela `config`.

| Servico | Chave | Uso | Obrigatoria? |
|---------|-------|-----|-------------|
| Anthropic | ANTHROPIC_API_KEY | Agente IA, scoring, briefing, mensagens | Sim (core) |
| OpenAI | OPENAI_API_KEY | Transcricao Whisper, chat manager | Sim (audio) |
| Google Gemini | GEMINI_API_KEY | Coach real-time, analise chamadas | Sim (coach) |
| UAZAPI | UAZAPI_ADMIN_URL + UAZAPI_ADMIN_TOKEN | WhatsApp multi-instancia | Sim (WhatsApp) |
| WhatsApp Cloud | WHATSAPP_CLOUD_TOKEN | WhatsApp oficial Meta | Opcional |
| Soniox | SONIOX_API_KEY | Transcricao real-time | Sim (telefonia) |
| WaVoIP | WAVOIP_API_KEY | Chamadas VoIP | Sim (telefonia) |
| Google Calendar | GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET | Reunioes (OAuth2) | Opcional |
| RapidAPI | RAPIDAPI_KEY | Social Selling: raspa perfil/posts/stories do Instagram (`instagram-scraper-stable-api`) | Opcional (Social Selling) |
| Firecrawl | FIRECRAWL_API_KEY | Prospecção: scrape Google Maps + sites + Google Search (~$15/mês) | Sim (Prospecção) |
| ScrapeCreators | SCRAPECREATORS_API_KEY | Prospecção: IG/Meta Ads/Google Ads/LinkedIn/TikTok profile (~$30/mês) | Sim (Prospecção) |
| Google PageSpeed | GOOGLE_PAGESPEED_KEY | Prospecção: Core Web Vitals (grátis) | Opcional (Prospecção) |

## Rotas principais

- `/` -> redireciona para `/comercial`
- `/comercial` -> Dashboard comercial
- `/comercial/cockpit` -> Cockpit de vendas (tempo real)
- `/comercial/pipeline` -> Pipeline Kanban
- `/comercial/leads` -> Lista de leads
- `/comercial/leads/:id` -> Detalhe do lead (com WhatsApp, chamadas, deals, tarefas, IA)
- `/comercial/deals` -> Deals / Oportunidades
- `/comercial/deals/:id` -> Detalhe do deal (com pagamentos, comissoes)
- `/comercial/inbox` -> Inbox WhatsApp
- `/comercial/agenda` -> Agenda comercial
- `/comercial/workspace` -> Sales Workspace
- `/comercial/produtos` -> Produtos
- `/comercial/comissoes` -> Comissoes
- `/comercial/playbook` -> Scripts de venda
- `/comercial/materiais` -> Materiais de venda
- `/comercial/treinamento` -> Treinamento com IA (roleplay)
- `/meu-whatsapp` -> Vendedor gerencia o WhatsApp dele (UAZAPI + WaVoIP)
- `/gestao/tarefas` -> Tarefas
- `/gestao/calendario` -> Calendario do time
- `/gestao/reunioes` -> Reunioes
- `/configuracoes` -> Configuracoes unificadas
- `/agendar` -> Pagina publica de agendamento
- `/comercial/prospeccao` -> Prospecção (descobrir leads via Maps/IG/site)
- `/comercial/prospeccao/busca/:buscaId` -> Leads descobertos da busca
- `/comercial/prospeccao/diagnostico/:diagnosticoId` -> Diagnóstico do lead (14 fontes + Gemini)
- `/comercial/prospeccao/diagnostico/:diagnosticoId/print` -> Versão print do diagnóstico
- `/comercial/prospeccao/configuracoes` -> Config do módulo prospecção

## Convencoes de codigo

- UI em portugues brasileiro
- Componentes: shadcn/ui + Tailwind
- Estado: React Query (useQuery/useMutation)
- Forms: React Hook Form + Zod
- Notificacoes: Sonner (toast)
- Icones: Lucide React
- Imports: alias `@/` (ex: `@/components/ui/button`)
- Edge Functions: Deno + imports de `jsr:` e `npm:`

## Multi-Tenant e Permissoes

- Tenant ID via JWT `app_metadata.tenant_id`
- RLS em todas as tabelas via `get_tenant_id()`

### Roles:
- **admin** — Acesso total
- **comercial/closer** — Vendedor (pipeline, leads, WhatsApp, telefonia)
- **sdr** — Pre-vendedor (leads, ligacoes)

### Modo SaaS (multi-tenant) — Onda B4

O template suporta dois modos, controlados pela flag `multi_tenant_enabled`
na `config` global (migration `20260712000100_tenant_onboarding.sql`):

- **`'false'` (default)** — single-tenant, comportamento identico ao atual:
  signup normal cai no tenant default `00000000-0000-0000-0000-000000000001`.
- **`'true'` (modo SaaS)** — o mentorado vira dono de um SaaS: cada cliente
  novo que se cadastra ganha um TENANT proprio isolado por RLS.

**Fluxo de signup SaaS:**
1. Tela de login le a flag (legivel por `anon` via policy
   `config_read_multi_tenant_flag`) e mostra o campo "Nome da empresa".
2. Apos `signUp`, o front chama a edge function `tenant-signup`
   (`verify_jwt = true`), que: valida a flag, valida que o usuario ainda nao
   pertence a nenhum tenant, cria a linha em `tenants` (com `owner_user_id`),
   seta `app_metadata.tenant_id` via `auth.admin.updateUserById`, cria o
   `team_members` role `admin`, corrige o `profiles.tenant_id` e chama a RPC
   `tenant_seed_defaults(tenant_id)`.
3. O front chama `supabase.auth.refreshSession()` — o JWT novo carrega o
   `tenant_id` e o RLS passa a isolar o workspace.

**Seed do tenant novo:** `tenant_seed_defaults` (SECURITY DEFINER, execute so
para `service_role`) cria o pipeline "Funil de Vendas" + 9 stages com UUIDs
gerados e grava `PIPELINE_ROLES` como override em `tenant_config_overrides`
(a config global permanece do tenant 0001). Idempotente.

**Convite de membros:** ja funciona multi-tenant via `manage-team-member` —
o admin do tenant convida e o usuario novo nasce com o `app_metadata.tenant_id`
do tenant do caller. Supabase inclui `app_metadata` no JWT por padrao (sem
custom access token hook).

## Tabela `config` (configuracoes via UI)

Chave-valor na tabela `config` (`key TEXT` PK, `value TEXT`).
Usada para:
- API keys das integracoes
- `enabled_modules` — JSON com os modulos ativos
- Preferencias do tenant

Frontend salva via upsert com `onConflict: "key"`.
Edge functions leem via `getIntegrationKey(supabase, key, tenantId?)`.

**Multi-tenant (Onda B2, migration `20260711000100_config_per_tenant.sql`):**
- `config` permanece GLOBAL (default/fallback da instalacao) — PK `key` intacta,
  porque o upsert PostgREST `onConflict: "key"` exige constraint nao-parcial
  (indice unico parcial quebra com erro 42P10 — validado no banco de teste).
- Overrides por tenant vivem em `tenant_config_overrides(tenant_id, key)` PK
  composta; RLS espelha o modelo da `config` (admin tudo, allowlist publica),
  sempre escopada por `tenant_id = get_tenant_id()`.
- Escrita na `config` global: so admin do tenant default `...0001` (single-tenant
  continua identico); tenants adicionais escrevem so overrides.
- `is_admin()` agora e escopado por tenant (`tenant_id = get_tenant_id()`).
- Helper resolve: override do tenant → global → Deno.env (cache por tenant+key).

## Automacoes de Pipeline (sales_automation_rules)

O sistema de automacao move leads automaticamente no pipeline baseado em eventos.
Regras configuradas em **Configuracoes > Comercial > Automacoes**.

### Trigger types disponiveis:
| Trigger | Quando dispara | Onde dispara |
|---------|---------------|--------------|
| `task_created` | Tarefa criada | `useTasks.ts` |
| `task_completed` | Tarefa concluida | `useTasks.ts` |
| `deal_created` | Deal criado | `useSalesDeals.ts` |
| `deal_stage_changed` | Deal mudou de estagio | `useSalesDeals.ts` |
| `lead_replied` | Lead respondeu no WhatsApp | `whatsapp-webhook` (edge fn) |
| `meeting_scheduled` | Reuniao/call agendada | `useTasks.ts` |
| `meeting_completed` | Reuniao finalizada com sucesso | `TranscriptionPanel.tsx` + `useTasks.ts` |
| `meeting_no_show` | Lead nao compareceu | `TranscriptionPanel.tsx` + `useTasks.ts` |
| `lead_score_changed` | Score do lead mudou | (sem call site ainda) |
| `days_in_stage` | Lead parado N dias no estagio | (cron — nao configurado) |

### Regras padrao ativas:
1. Lead respondeu → Em Qualificacao (so se estiver em Novo Lead ou Tentando Contato)
2. Reuniao agendada → Reuniao Agendada (so se estiver antes dessa etapa)
3. Reuniao realizada → Reuniao Realizada (so se estiver antes)
4. No-show → No-show

### Action `move_deal_stage`:
Atualiza `deals.pipeline_stage_id` + `leads.pipeline_stage_id` + `leads.etapa_funil` + `leads.sales_stage`.
Config: `target_stage_id` (obrigatorio), `only_if_position_less_than` (guard de posicao).

## Limpeza do banco

O script `supabase/cleanup_unused_tables.sql` contem os `DROP TABLE` das
tabelas dos modulos que foram removidos (CS, RH, Financeiro, Eventos,
Instagram, NFSe, Knowledge Base, Organograma, etc). Rodar no SQL Editor do
Supabase para remover as tabelas orfaos do banco atual.

---

# ONBOARDING — INSTRUCOES PARA O CLAUDE CODE

IMPORTANTE: O usuario deste projeto pode NAO ser tecnico. Guie passo a passo,
linguagem simples, como um professor paciente.

REGRAS DE COMUNICACAO:
- Fale como se estivesse ensinando um amigo. Sem jargoes.
- Explique UMA coisa de cada vez.
- Quando pedir pra ele fazer algo no navegador, diga EXATAMENTE onde clicar.
- Sempre confirme que ele conseguiu antes de ir pro proximo passo.
- Use analogias do dia a dia quando possivel.
- Responda SEMPRE em portugues brasileiro.

## Skills disponiveis (use-as!)

Ao iniciar qualquer configuracao, **USE AS SKILLS** em `.claude/skills/`:

- **`/setup-projeto`** — Orquestra TODO o setup do zero (Supabase, migrations,
  edge functions, API keys, WhatsApp, agente). Use quando o aluno diz "configurar",
  "setup", "primeira vez", "instalar", "como configuro".
- **`/criar-agente-ia`** — Entrevista o aluno sobre o negocio dele e cria um
  agente de vendas customizado (system prompt, tools, horario). Use depois do
  setup, quando ele quer ter o "vendedor IA" respondendo no WhatsApp.

Essas skills ja tem o fluxo completo — nao reinvente.

## Fluxo de configuracao — USE O INSTALADOR (./setup.sh)

**O setup pesado agora e 1 comando.** NAO aplique migrations manualmente.

1. **Pre-requisitos**: Node >= 18, npm, supabase CLI >= 2.70, curl, jq
2. Peca ao aluno o **Supabase Access Token** (https://supabase.com/dashboard/account/tokens)
3. Rode: `SUPABASE_ACCESS_TOKEN=sbp_xxx ./setup.sh`
   O instalador faz SOZINHO: cria o projeto Supabase (sa-east-1), aplica TODAS
   as migrations em ordem (baseline unico `000_baseline_full.sql` + cadeia datada,
   incluindo plataforma de agentes e seed do Funil de Vendas), deploya TODAS as
   edge functions (flags verify_jwt no `supabase/config.toml`), desliga email
   confirm, gera o `.env` e roda `npm install` + health check.
4. **`npm run dev`** → criar conta no CRM → login (primeiro usuario)
5. **Configuracoes > API Keys** (Anthropic + Gemini no minimo)
6. **Criar instancia WhatsApp** (as functions ja estao no ar)
7. **Vincular membro do time** a instancia
8. **Criar agente IA** (via `/criar-agente-ia` — 5 templates ja vem seedados)
9. **Teste E2E**: msg do celular pessoal → agente responde

Se o setup.sh falhar em algum passo, ele diz exatamente onde — corrija e rode de
novo (e idempotente). Upgrade de instalacao antiga: ver `GUIA_UPGRADE.md`.

## Armadilhas conhecidas (NAO caia nelas)

- ❌ Criar instancia UAZAPI ANTES dos webhooks estarem no ar → msgs nao chegam
- ❌ Aplicar migrations manualmente em vez do `./setup.sh` → erros de ordem/idempotencia
- ❌ Hardcode de API keys / Client IDs / Phone Number IDs em codigo → **regra inviolavel**, use `getIntegrationKey()` em `_shared/config.ts` + UI `/configuracoes`
- ❌ Hardcode de URL UAZAPI (ex: `your-uazapi-instance.uazapi.com`) → **regra inviolavel**, use `instance.api_url` ou `config.UAZAPI_ADMIN_URL`
- ❌ Cadastrar so `WHATSAPP_CLOUD_TOKEN` sem `WHATSAPP_PHONE_NUMBER_ID` (ou vice-versa) → Cloud API precisa dos DOIS
- ❌ Usar `/status` da UAZAPI (health check) em vez de `/instance/status` (status da instancia)
- ❌ Esquecer de desativar Email Confirm → aluno nao consegue logar em contas de teste
- ❌ Agente IA nao responder audio/imagem → tem que ter `GEMINI_API_KEY` (Whisper so pega audio, nao imagem)

## Estrategia de midia do agente

- **Audio**: UAZAPI transcreve via Whisper se `OPENAI_API_KEY` estiver configurada; fallback pra Gemini multimodal com `GEMINI_API_KEY`
- **Imagem**: Gemini Vision descreve o conteudo (`describeImageViaGemini`) e popula `content` com texto — o agente "ve" a imagem via descricao
- **Sem chave de midia**: agente recebe `[Audio]` / `[Imagem]` vazio e pode alucinar ("nao consigo ver") — ensinar o aluno a cadastrar Gemini logo de cara

## Visibilidade de eventos do agente

Tabela `ai_agent_chat_events` loga TUDO que o agente faz ou deixa de fazer:
- `skipped_out_of_hours`, `skipped_human_active_cooldown`, `skipped_max_messages`,
  `skipped_conversation_paused`, `replied`, `error`
Frontend le essa tabela no chat interno pra mostrar "por que nao respondeu".

---

# SOCIAL SELLING (Instagram)

Modulo de prospeccao + cadencia automatizada no Instagram. Roda via Playwright (browser real, simula humano) + Claude Haiku (IA decide qualificacao + gera mensagens) + RapidAPI (raspa dados estruturados).

## Skills (slash commands)

- `/social-selling-prospect` — abre IG, coleta seguidores recentes, qualifica em lote, cria leads
- `/social-selling-run` — pega plano do dia (`social-selling-plan-day`), executa cadencia humanizada (curtir/comentar/DM)
- `/social-selling-checar-respostas` — verifica DMs, move leads que responderam
- `/social-selling-setup` — primeira vez: loga IG no Playwright + calibra tom de voz

## Tabelas

- `instagram_profiles` — perfis raspados (bio, followers, posts_count, avatar)
- `instagram_feed_posts` — posts coletados (caption, like_count, taken_at)
- `instagram_stories` — stories ativos
- `instagram_business_accounts` — conta usada pra enviar (placeholder em modo Playwright manual)
- `instagram_conversations` + `instagram_messages` — DMs (espelhadas a partir de `responder_story` e `enviar_dm`)
- `social_selling_automations` — automacoes (trigger + cadence_config + qualification_config)
- `social_selling_enrollments` — leads ativos na cadencia (current_day, status)
- `social_selling_interactions` — log de cada acao executada (UNIQUE constraint anti-duplicate)
- `social_selling_qualification_log` — historico de scores IA por @
- `social_selling_prospecting_state` — estado da prospeccao (ultimo @ processado)

## Configuracao (tudo via UI)

`/configuracoes?s=social-selling`:
- **Automacoes** — cadencia (Dia 1, 3, 5, 7), trigger (stage_change ou new_follower)
- **Tom de voz** — descricao + exemplos + palavras proibidas (key `social_selling_tone`)
- **Prompts da IA** — qualificacao + 3 acoes (comentar/responder/dm) (keys `social_selling_prompt_*`)
- **Rate limits** — total/dia, dms/dia, comments/dia, likes/dia, delay min/max, working hours, pause weekends (key `social_selling_limits`)

ZERO hardcoded em edge functions. Tudo lido de `config` table.

## Pipeline padrao

Pipeline "Prospeccao Social Selling" (ID `9e894071-6fd8-483f-a581-1470cef85f87`):
- 🆕 Novo Qualificado
- 🔥 Aquecendo (auto-mover quando recebe 1a interacao)
- 📩 DM Enviada (auto-mover quando envia DM)
- ✅ Respondeu
- ❌ Sem Resposta

## UI no lead

Aba "Social Selling" do lead detail (`/comercial/leads/:id`):
- Avatar grande + bio + verified/business badges
- Stats (seguidores/seguindo/posts)
- Bio links clicaveis
- Score IA + reason
- Stories ativos (carrossel)
- Grid 3x4 dos 12 posts mais recentes
- Status do enrollment + historico de acoes

DMs (responder_story, enviar_dm) tambem aparecem em `/comercial/inbox` na aba Instagram.

## Humanizacao

- DB UNIQUE constraint `(lead_id, action_type, instagram_target)` impede duplicar
- `plan-day` filtra targets ja agidos via `acted_targets_for_lead()`
- 10% chance de skip aleatorio por acao
- Ordem dos leads embaralhada
- Delays 45-180s aleatorios entre acoes
- Min 30min entre acoes no mesmo lead
- Respeita working_hours + pause_weekends do config
- `current_day` so avanca quando todas acoes do dia foram feitas E passou 18h+

## Edge cases (descobertos durante implementacao)

- IG bloqueia reagir story ja visualizado → skill detecta via canvas (`<canvas height="330" width="330">` no header) e skip
- Botao Curtir do post = ref proximo de "Comentar" + "Repostar" (NAO o dos comentarios). Tem 5-10 botoes "Curtir" na pagina!
- `browser_click(ref)` funciona pra IG. **`browser_evaluate(() => btn.click())` NAO funciona** — IG bloqueia clicks programaticos via JS
- Stories que ja viu mostram modal "Ver story" que so marca como visto, nao deixa reagir
- Surrogate pairs malformados em bios → sanitizados antes de mandar pra Claude (regex elimina `\\uD800-\\uDBFF` orfaos)
- IG `og:description` meta tag captura caption do post de forma confiavel
- Modal de followers do IG NAO retorna ordem cronologica garantida — scroll mistura recentes e antigos

## Pacote do aluno (ZIP empacotado em <CAMINHO_LOCAL>)

ZIP de 72KB com 45 arquivos. Aluno descompacta na raiz do projeto e fala "instala o social selling" pro Claude. Estrutura:
- `README.md` — pro aluno (1 paragrafo)
- `INSTALL.md` — passo a passo pro Claude (migrations + edge fns + frontend + skills)
- `ONBOARDING.md` — script de conversa interativa pro Claude conduzir
- `migrations/` (4 SQL files) — schema completo
- `edge-functions/` (8 functions + _shared/config.ts)
- `frontend/` (4 components + 1 page + 2 hooks)
- `claude-commands/` (4 skills)

## Onboarding inteligente (regras criticas)

ANTES de pedir info pro aluno, ler o que JA EXISTE no CRM:
```sql
SELECT system_prompt FROM ai_sales_agents LIMIT 1;  -- ICP
SELECT name, description, price FROM products;       -- ticket
SELECT content FROM whatsapp_messages WHERE is_from_me=true ORDER BY created_at DESC LIMIT 30;  -- tom de voz
SELECT id, name FROM sales_pipelines;                -- funis existentes
```

Sempre **sugerir e confirmar** (A/B/C), nunca pedir do zero. O aluno NAO eh tecnico — usar linguagem de empresario, nunca "edge function", "migration", "RLS".

## Aprendizados duros (do dev ao vivo com o Frank, 26-27/04/2026)

1. **Cron de Claude Code (`/loop` / `CronCreate`) e session-only e fragil**. Nao dispara se REPL ocupado, Mac dorme, ou usuario fechar Code. Pra producao real precisa launchd ou similar.
2. **Cloud Routine via /schedule SKILL nao acessa MCPs locais** — Playwright fica fora. Pra Social Selling e inviavel cloud routine.
3. **Bug do `onConflict: "instagram_username"` errado** — UNIQUE eh `(instagram_username, tenant_id)`. Upsert silencioso descartava 60 logs.
4. **`current_day` deve avancar SO quando todas acoes do dia foram feitas E passou 18h+** desde a primeira. Senao incrementa errado quando roda 4x/dia.
5. **Auto-move de stage no kanban** baseado em acao (Novo Qualificado → Aquecendo na 1a interacao, Aquecendo → DM Enviada quando enviar_dm). Le pipeline pelo NOME ("Prospecção Social Selling"), nao por ID hardcoded.
6. **Comentarios sao publicos**, NAO entram em `instagram_messages` (so DM/story_reply entram). Frank confundiu inicialmente; ajustamos a logica.
7. **Avatar do lead so renderiza** se `lead.instagram_profile_id` estiver setado — FK obrigatoria. Linkar quando criar lead.
8. **Pipeline kanban mostra DEALS, nao leads** — sempre criar deal junto com lead na qualificacao.
9. **Prompt de qualificacao MUITO rigoroso rejeita TODO MUNDO** quando manda fragmentos via `qualify-from-data`. Solucoes: (a) usar `qualify-instagram-lead` (RapidAPI completa, 12 captions+stories), (b) ajustar prompt pra incluir "medico/advogado COM clinica estruturada → APROVAR".
10. **Aba "Mensagens / Instagram" do CRM precisa de `instagram_business_accounts`** — criar placeholder com `access_token = "PLAYWRIGHT_NO_TOKEN"` em modo manual.

## Demo testada e validada end-to-end (27/04)

✅ Coleta seguidores via Playwright (visual)
✅ Raspagem perfil + posts via RapidAPI
✅ Qualificacao IA (Madson 62 reject, Italo 88 approve, Lucia 78 approve)
✅ Criacao de lead+deal+enrollment
✅ Aba Social Selling com avatar/bio/posts/score
✅ Curtir post (coracao vermelho confirmado por screenshot)
✅ Comentar post (texto contextual no tom)
✅ DM frio (Juniel — balao azul + espelhamento em instagram_messages)
✅ Auto-move kanban Novo Qualificado → Aquecendo

---

# PROSPECÇÃO (módulo isolado v2)

Módulo separado do Social Selling — DESCOBRE leads via Google Maps + 14 fontes públicas (site, IG, Doctoralia, Reclame Aqui, Facebook, LinkedIn, YouTube, iFood, TikTok, Tripadvisor, Mercado Livre, Google Reviews, Glassdoor, Meta/Google Ads, Posição Google, PageSpeed, Contexto de Negócio).

## Stack

- **Firecrawl** — scrape Google Maps + sites + Google Search (~$15/mês)
- **ScrapeCreators** — APIs estruturadas (IG, Ads Library, LinkedIn, TikTok) (~$30/mês)
- **Gemini Flash 2.5** — analisa contexto + gera diagnóstico/oportunidades
- **Google PageSpeed** — Core Web Vitals (grátis, opcional)

## Edge functions (6)

- `prospeccao-detectar-intent` — detecta intent (busca nicho/cidade vs @ direto vs URL site)
- `prospeccao-buscar` — Firecrawl scrape Google Maps + parser markdown + enriquecimento
- `prospeccao-direct-lead` — cria 1 lead descoberto direto (sem Maps) de @ ou URL
- `prospeccao-analisar` — roda 22 fontes em paralelo + compila diagnóstico via Gemini
- `prospeccao-virar-lead` — converte lead descoberto em lead "real" do CRM
- `prospeccao-gerar-mensagem` — gera mensagem personalizada via Gemini

Todas leem keys via `getIntegrationKey()` (config table). Zero hardcoded.

`prospeccao-analisar` usa `keys.ts` (registry module-level) — index.ts inicializa, fontes leem via `getKey()`.

## Tabelas (6 prospeccao_*)

- `prospeccao_buscas` — uma busca = uma query (Maps ou direct)
- `prospeccao_leads_descobertos` — leads achados (com nome, telefone, IG, FB, etc)
- `prospeccao_diagnosticos` — análise completa por fonte + oportunidades IA
- `prospeccao_templates_nicho` — 10 nichos seedados (saude, ecommerce, restaurante…)
- `prospeccao_prompts_config` — 4 prompts seedados (intent, contexto, ig_pos, ra_sentimento)
- `prospeccao_uso_api` — log de chamadas (custo + duração + sucesso por chamada)

## Frontend

- `src/modules/prospeccao/pages/`
  - `ProspeccaoSearch.tsx` — input de busca (nicho/cidade ou @ direto)
  - `ProspeccaoDescobertos.tsx` — lista de leads achados
  - `ProspeccaoDiagnostico.tsx` — diagnóstico completo (22 fontes + IA)
  - `ProspeccaoDiagnosticoPrint.tsx` — versão print
  - `ProspeccaoConfiguracoes.tsx` — config do módulo

Sidebar isolada: "Prospecção" → "Descobrir Leads" (ícone Compass).

## Aprendizados

- `prospeccao-analisar` tem 27 arquivos (index + compiler + enriquecer + load_prompt + keys + 22 fontes + _shared/config). Deploy só funciona via `supabase functions deploy` — MCP deploy inline fica >185KB.
- **Pattern keys.ts**: módulos com muitas fontes/arquivos precisam de registry pra evitar passar key como parâmetro em N camadas. Index inicializa via `setKeys()`, fontes leem via `getKey()`.
- Conta `supabase login` precisa ser DONA do projeto `SEU_PROJETO_REF` (a conta dona do projeto) — outras contas dão 403.

---

## Gravacao de aula (mapa Excalidraw criado)

Mapa visual 1600x1200 com:
- 4 atores (Aluno, Claude Code, Instagram, CRM)
- 4 camadas (UI, Edge Functions, IA+Coleta, Banco Supabase)
- 3 fluxos (Onboarding, Prospeccao, Cadencia)

---

# PLATAFORMA DE AGENTES IA (módulo /agentes)

Agentes "funcionários digitais": multi-provider (Anthropic/OpenAI/Codex/Gemini),
multi-canal (chat web, WhatsApp via porteiro V2, Telegram, botão flutuante),
tools que operam o CRM (kit criar_lead/deal/tarefa + vendas + notas + lembretes
recorrentes), templates clonáveis, versionamento de prompt, vision (imagens).

## Estrutura

- **Banco:** 17 tabelas (`agents_*`, `agent_*`) + 41 funções + 39 skills no
  catálogo + 9 providers + 5 templates (CEO, Heitor/Conteúdo, Vinicius/Tráfego,
  Gestor de Time, Bella/Atendente). Templates = `is_template=true` (escondidos
  da lista; aparecem no "+ Novo agente"; clone real via RPC
  `agent_create_from_template` copia tools + interpola `{{variáveis}}`).
- **Edge functions:** `agent-runner` (motor multi-provider, Codex OAuth com
  refresh automático, AGENTIC_CORE, vision), `agent-jobs-poller` (cron 1min —
  jobs assíncronos + lembretes/rotinas recorrentes), `agents-codex-import`,
  `telegram-webhook` (markdown→HTML, modos open/invite/private),
  `generate-embedding`, `agent-followup` (cadência contextual). Porteiro V2
  plugado no `whatsapp-webhook` (`agent-platform.ts`), ativado por tenant via
  RPCs admin-only e `tenant_config_overrides.agent_platform_v2_enabled`.
- **Frontend:** `src/agents-platform/` (9 páginas em `/agentes/*`), seção
  "Agentes IA" na sidebar, `FloatingAgentHost` no AppLayout, plugin
  `@tailwindcss/typography` (markdown do chat).

## Decisões de arquitetura (não regredir)

- **Ler = genérico** (`execute_sql` read-only com blacklist) · **Agir = tools
  escopadas** (RPCs com whitelist/validação) · **Destrutivo = with_approval**
- Provider EFETIVO do agente = credencial vinculada (`effectiveProvider()`),
  não o campo estático — runner e UI usam a mesma regra
- Skill UAZAPI é só ENVIO (DM/grupo/@menção via `mentions`) — nunca dar API
  genérica de ação pro agente; `uazapi_listar_grupos` descobre grupos
- Lembrete: `repeat_every_minutes` vazio/0 = único; mínimo de recorrência
  configurável por agente (`settings.min_recurrence_minutes`, default 5)
- Tudo dinâmico: conta Meta descoberta via API, grupo via lista+nota,
  pipeline padrão por tenant — ZERO ids hardcoded em prompt/skill
- WhatsApp V2: o tenant vem sempre da instância; `agent_route_lookup` nunca
  aceita match cross-tenant. O webhook agrupa mensagens fragmentadas no banco,
  respeita intervenção humana, envia respostas humanizadas/imagens e registra o
  ID real da UAZAPI para deduplicar o echo.
- Para ativar: crie ao menos um deployment WhatsApp ativo na aba Canais e use
  a chave **Roteador WhatsApp V2** em `/agentes`. OFF mantém o fluxo legado.

## Pacote do mentorado

`<CAMINHO_LOCAL> (268KB, 87 arquivos):
6 migrations (extraídas da produção validada + full-circle test), 5 functions +
patch whatsapp, frontend completo + INTEGRATION.md, README/INSTALL/ONBOARDING,
skill `/install-agents-platform`. Aluno: descompacta na raiz e fala "instala a
plataforma de agentes". Templates 100% limpos (sem credenciais/dados do Frank).

---

# MCP SUPABASE

## Metodo recomendado — OAuth

```bash
claude mcp add --transport http supabase https://mcp.supabase.com/mcp
```
Na primeira utilizacao de uma ferramenta `mcp__supabase__*`, abre navegador
pra OAuth automaticamente.
