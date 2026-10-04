# Guia de Upgrade — CRM AI-First (versão antiga → v3)

> **Pra quem é:** mentorado que já tem o CRM rodando numa versão anterior.
> **Como usar:** descompacte o zip novo numa pasta e diga ao Claude Code:
> *"faz o upgrade do meu CRM seguindo o GUIA_UPGRADE.md"*.
> O Claude executa os passos — você só acompanha e valida.

---

## O que chega de novo nesta versão

- **Marketing completo**: Formulários, Canais de Entrada, Lead Ads (Meta), Importação de leads (CSV/RD/Brevo)
- **WhatsApp Cloud API oficial** multi-número (coexiste com UAZAPI) + janela 24h/72h + templates
- **Coexistência Meta** (Embedded Signup — conectar o número que você já usa no app)
- **Plataforma de Agentes IA** (funcionários digitais multi-canal)
- **Segurança**: API keys legíveis só por admin; UAZAPI via proxy (chave nunca vai pro browser); acesso público escopado
- **Zero hardcode**: pipelines/pessoas/branding via tabela `config` (`PIPELINE_ROLES` etc.)

---

## INSTRUÇÕES PARA O CLAUDE CODE (execute na ordem)

### 0. Backup (obrigatório)
1. `cp -r` do projeto atual pra uma pasta `backup-pre-upgrade/`.
2. No Supabase Dashboard → Database → Backups: confirme que existe backup recente (ou exporte via `supabase db dump`).
3. **NÃO prossiga sem backup.**

### 1. Atualizar o código
1. Preserve os arquivos locais do aluno: `.env` (NÃO sobrescrever!).
2. Copie o conteúdo do zip novo por cima do projeto (substituindo `src/`, `supabase/functions/`, `supabase/migrations/`, `.claude/`, configs de build).
3. `npm install` (dependências mudaram — BlockNote não utilizado foi removido, Vite foi atualizado e os lockfiles precisam ser respeitados).
4. `npx tsc --noEmit` deve passar.

### 2. Migrations — SÓ o delta (não reaplique baselines!)
O banco do aluno JÁ tem o schema base. **Nunca rode `000_base_schema.sql` ou `000_baseline_full.sql` de novo.**
1. Liste as migrations aplicadas: `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version` (ou compare o schema real).
2. Aplique **em ordem alfabética** apenas as migrations do zip que ainda não existem no banco — na dúvida sobre uma migration, verifique antes se as tabelas/colunas que ela cria já existem (todas as recentes são idempotentes com `IF NOT EXISTS`).
3. Atenção às críticas: `20260707_drift_whatsapp_cloud_multi_numero.sql`, `20260708_config_secrets_admin_only.sql`, `20260708_agents_credentials_admin_or_owner.sql`.

### 3. Redeploy de TODAS as edge functions
```bash
supabase login   # conta dona do projeto
# webhooks com --no-verify-jwt: whatsapp-webhook, whatsapp-cloud-webhook,
# meta-lead-webhook, brevo-webhook, google-ads-webhook, receive-lead, wavoip-webhook,
# telegram-webhook, google-calendar-webhook, unsubscribe, prospeccao-diagnostico-publico
# demais: deploy normal (uazapi-proxy com verify_jwt padrão/true)
```
Deploy **todas** — várias antigas mudaram (leem config em vez de valores fixos).

### 4. Configurar as chaves novas (Configurações → Integrações)
O CRM agora lê tudo da tabela `config`. Confirme/preencha com o aluno:
- `PIPELINE_ROLES` — JSON mapeando os pipelines/etapas DELE (pergunte quais são os funis dele e monte: `{"closer":"<uuid>","stages":{"call_agendada":"<uuid>",...}}`). Sem essa key os automatismos de pipeline ficam desligados (não quebra nada).
- `COMPANY_NAME`, `COMPANY_DOMAIN`, `EMAIL_FROM_MEETINGS` (se usa emails de reunião)
- `NOTIFICATIONS_INSTANCE_ID` + `NOTIFICATIONS_GROUP_JID` (se usa avisos do time no WhatsApp)
- `DEFAULT_MEETING_OWNER_ID` (dono padrão de reuniões agendadas pela página pública)
- WhatsApp Cloud (opcional): seguir o passo a passo na tela **WhatsApp Oficial (Cloud)**

### 5. Teste de fumaça (com o aluno)
1. Login → Pipeline abre e move cards
2. Inbox → enviar mensagem UAZAPI (agora via proxy — deve funcionar igual)
3. Configurações → Integrações abre (como admin)
4. Se usa agente IA: mandar "oi" do celular e ver a resposta
5. `curl POST {PROJECT_URL}/functions/v1/health-check` → "healthy"

### Problemas comuns
- **"Instância não aparece no seletor"** → status da instância ≠ connected; reconectar QR (UAZAPI) ou re-testar conexão (Cloud).
- **Vendedor não vê uma config** → esperado: keys sensíveis agora são só-admin.
- **Automação de pipeline parou** → falta `PIPELINE_ROLES` na config (passo 4).
