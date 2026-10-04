# Dados necessários para publicação

Não registrar secrets neste arquivo ou em arquivos versionados.

## Etapa 1 — Supabase, agora

Padrão assumido:

- projeto: assyma-crm-ai-first
- região: São Paulo / South America
- ambiente: projeto novo

Enviar somente um Personal Access Token temporário do Supabase, criado em:

https://supabase.com/dashboard/account/tokens

O token será usado apenas na sessão para:

1. listar a organização disponível;
2. criar o projeto novo;
3. vincular o repositório;
4. aplicar a migração;
5. publicar as Edge Functions;
6. registrar os secrets server-side.

Não será salvo em .env, Git ou Obsidian. Depois da configuração, revogar o token no painel.

Estado: concluído. Projeto novo instalado, migrations aplicadas e funções publicadas.

## Etapa 2 — LiveKit Cloud

Depois do Supabase:

- LIVEKIT_URL
- LIVEKIT_WS_URL
- LIVEKIT_API_KEY
- LIVEKIT_API_SECRET

Esses valores serão armazenados como secrets do Supabase, nunca no frontend.

Estado: credenciais instaladas. Pendente cadastrar em Settings → Webhooks:

https://sdmncjxyxjghqsughxvr.supabase.co/functions/v1/livekit-webhook

## Etapa 3 — Vercel

- autenticação Vercel ou token temporário;
- confirmação do nome do projeto e domínio;
- variáveis públicas VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY e VITE_CRM_URL.

Estado: concluído. Produção em https://assyma-crm-ai-first.vercel.app

## Etapa 4 — gravação e inteligência, após a sala funcionar

- Cloudflare R2: endpoint, bucket, access key, secret e URL de entrega;
- provedor de transcrição: Deepgram e/ou AssemblyAI;
- provedor de análise: Gemini ou Anthropic;
- opcional: webhook do sistema externo e serviço de concatenação.

## Etapa 3.1 — administrador inicial

Estado: concluído em 2026-09-14.

- usuário confirmado no Supabase Auth;
- perfil vinculado ao tenant padrão com papel `admin` e `is_superadmin = true`;
- cadastro público desativado;
- recuperação de senha configurada para `https://assyma-crm-ai-first.vercel.app/reset-password`;
- e-mail de definição de senha solicitado sem registrar senha em arquivo ou chat.

## Ordem segura

Supabase → sala LiveKit sem gravação → preview Vercel → smoke test → R2/Egress → transcrição → análise IA.
