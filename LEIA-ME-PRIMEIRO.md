# Leia primeiro

Este projeto possui um instalador único. Não aplique arquivos SQL manualmente e não altere as flags de autenticação das Edge Functions.

1. Instale Node.js 18+ e a Supabase CLI.
2. Entre na sua conta com `supabase login`.
3. Na pasta descompactada, execute `./setup.sh`.
4. Informe o e-mail, nome e uma senha forte para o administrador.
5. Ao finalizar, rode `npm run dev` e entre com esse administrador.
6. Configure as integrações na área administrativa.

O setup cria o projeto, banco, funções, tarefas automáticas e tokens públicos com segurança. O cadastro aberto fica desativado de propósito.

Antes de colocar em produção, siga [docs/OPERACAO.md](docs/OPERACAO.md) e [docs/SEGURANCA.md](docs/SEGURANCA.md).
