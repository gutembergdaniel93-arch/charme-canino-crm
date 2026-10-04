# Manifesto de implementação — CRM AI First + LiveKit

Estado: SHIP frontend, banco e autenticação / BLOCK ativação da sala

## SHIP local

- Fontes originais preservadas em diretórios separados.
- Dependências LiveKit fixadas em versões compatíveis com Node 22.19.
- Rotas de reunião, mentoria e entrada pública integradas ao React Router.
- Arquivos ausentes do pacote recompostos para permitir build e operação básica.
- Migração incremental multi-tenant criada sem sobrescrever `meetings`.
- Rewrite SPA da Vercel criado.

## BLOCK externo

- Criar/selecionar projeto Supabase e aplicar migrations/functions.
- Criar projeto LiveKit Cloud e registrar secrets server-side.
- Configurar Vercel e publicar o frontend.
- Ativar gravação/agente somente depois do teste de sala básica.

## QA pendente

- Typecheck, testes e build após integração.
- Auditoria final de autorização das Edge Functions.
- Smoke test host + convidado + webhook.
- Anexos do chat de mentoria estão deliberadamente bloqueados até existir upload assinado por sessão; o download original abriria o bucket entre tenants.

## Evidências concluídas

- npm run check: typecheck + 6 testes + build aprovados.
- npm run lint: aprovado sem erros.
- deno check: 8 Edge Functions aprovadas.
- Relatórios em docs/livekit/SECURITY_ASSESSMENT.md e docs/livekit/GO_NO_GO.md.
- Supabase novo: projeto assyma-crm-ai-first, migrations completas e 8 Edge Functions publicadas.
- LiveKit: credenciais registradas somente no cofre de secrets do Supabase.
- Vercel produção: https://assyma-crm-ai-first.vercel.app
- Smoke remoto: raiz, login e rota profunda retornaram HTTP 200; endpoints recusaram recursos fictícios com HTTP 404.
- Primeiro administrador criado, confirmado e vinculado ao tenant padrão como superadministrador.
- Cadastro público desativado no Supabase; URL de recuperação apontada para a produção da Vercel.
- E-mail de definição de senha solicitado para o administrador em 2026-09-14.

## Próximos gates

- LiveKit Cloud → Settings → Webhooks: cadastrar o endpoint da função livekit-webhook.
- Criar uma reunião fictícia e testar host + convidado.
- R2/Egress, transcrição e agente continuam desligados até o teste básico da sala.
