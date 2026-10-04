# Operação e publicação

## Antes de publicar

```bash
npm ci
npm run typecheck
npm test
npm run build
npm --prefix extension ci
npm --prefix extension run build
./scripts/check-edge-functions.sh
```

Confirme também:

- login do administrador e recuperação de senha;
- isolamento de dados usando dois usuários de tenants diferentes;
- recebimento e rejeição de webhook com assinatura válida e inválida;
- execução dos jobs em `cron.job_run_details`;
- envio e recebimento de WhatsApp sem expor token no navegador;
- criação de chave temporária Soniox;
- agenda pública somente com `booking_token` válido;
- backup do banco e teste de restauração.

## Observabilidade

Monitore erros de Edge Functions, falhas de cron, volume de filas pendentes, webhooks rejeitados, custo por agente e limites dos provedores. Alertas devem ser enviados para um canal operacional que não dependa do próprio CRM.

## Atualizações

Faça mudanças em ambiente de teste, aplique migrations de forma incremental e mantenha rollback lógico para alterações de dados. Nunca edite uma migration já aplicada em produção; crie outra. Fixe uma versão do pacote entregue a cada mentorado e registre data, commit e mudanças.

## Dependências

O projeto e a extensão devem rodar `npm audit` regularmente. Atualizações compatíveis são aplicadas sem `--force`; upgrades principais exigem teste funcional, principalmente do editor Maily e dos fluxos de build da extensão.
