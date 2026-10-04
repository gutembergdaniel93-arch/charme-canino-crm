# CRM AI-First

CRM comercial multi-tenant com pipeline, WhatsApp, telefonia, agenda, campanhas e agentes de IA.

## Instalação recomendada

Pré-requisitos: Node.js 18+, npm, Supabase CLI, `curl`, `jq` e `openssl`.

```bash
supabase login
./setup.sh
```

O instalador cria um projeto Supabase novo, aplica todas as migrations, configura o cofre, publica as Edge Functions, desativa cadastro público e cria o primeiro administrador. Não crie usuário manualmente pela tela de login.

Depois:

```bash
npm run dev
```

Acesse `http://localhost:8080` e entre com o administrador informado durante o setup. Cadastre as chaves das integrações em **Configurações → Integrações**.

## WACLI local

A página **Agentes IA** oferece pareamento WACLI local por QR Code e controle de sincronização. O painel chama `wacli` somente pelo servidor local, vinculado a `127.0.0.1`; o QR e o armazenamento/sessão do WACLI não são enviados ao Supabase. O painel não envia mensagens.

Instale o WACLI oficial conforme [as instruções upstream](https://github.com/openclaw/wacli#install) e deixe o executável no `PATH` ou defina `WACLI_BIN` com o caminho completo. Os binários oficiais para macOS requerem macOS 15 ou superior. Em versões anteriores, a instalação a partir do código-fonte exige Go 1.27+ e as Xcode Command Line Tools.

O WACLI pareia como aparelho vinculado e usa o protocolo WhatsApp Web via `whatsmeow`; não é uma API oficial Meta. Revise as implicações para a conta antes de parear. O QR é temporário e deve ser escaneado somente pelo aparelho autorizado.

## Validação

```bash
npm run typecheck
npm test
npm run build
npm --prefix extension run build
./scripts/check-edge-functions.sh
```

## Segurança

- Nunca coloque `service_role`, senha do banco ou chaves de provedores em variáveis `VITE_*`.
- O cadastro público vem desativado; novos membros devem ser convidados por um administrador.
- Webhooks usam assinatura ou segredo dedicado. Configure os segredos indicados em [docs/SEGURANCA.md](docs/SEGURANCA.md).
- Cada mentorado deve receber um projeto Supabase próprio ou um tenant criado pelo fluxo administrativo.
- Leia [docs/OPERACAO.md](docs/OPERACAO.md) antes de publicar em produção.

## Comandos úteis

| Comando | Finalidade |
|---|---|
| `npm run dev` | ambiente local |
| `npm run typecheck` | valida TypeScript do frontend |
| `npm test` | testes automatizados |
| `npm run build` | build de produção |
| `./scripts/check-edge-functions.sh` | valida as funções críticas de servidor |
| `bash scripts/health-check.sh` | verifica uma instalação configurada |

O ZIP original não deve ser alterado. Distribua somente o pacote revisado e versionado.
