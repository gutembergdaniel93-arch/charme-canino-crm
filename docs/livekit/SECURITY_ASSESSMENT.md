# Avaliação de segurança — CRM AI First + LiveKit

## Escopo e limites

Revisão defensiva da integração React, schema Supabase, tokens, encerramento, webhook e mídia. Nenhuma mudança em produção foi executada.

## Modelo de ameaça

- Ativos: leads, transcrições, gravações, tokens, secrets e isolamento entre tenants.
- Abusos prioritários: host sem login, término de sala alheia, policy global, webhook falso e leitura cruzada de anexos.

## Achados verificados

### Alto — corrigido localmente

- A migração original recriava a tabela meetings e usava policies abertas.
- Correção: migração incremental, tenant_id e RLS por get_tenant_id().

### Alto — corrigido localmente

- A função livekit-token aceitava host/observer sem autorização.
- Correção: papéis privilegiados exigem usuário válido e tenant igual ao recurso; convidados só entram em sala existente e aberta.

### Alto — corrigido localmente

- livekit-end-room usava service role sem confirmar acesso.
- Correção: lookup obrigatório via cliente autenticado e RLS antes de terminar a sala.

### Médio — corrigido localmente

- O webhook público valida a assinatura HMAC do LiveKit com WebhookReceiver; o teste de allowlist protege essa regra.

### Médio — bloqueado com falha segura

- O download abria mídia do chat em bucket público.
- Correção atual: bucket privado, sem policy genérica e controles de upload desabilitados.
- Próximo ativo: upload/download assinado por tenant e sessão.

### Médio — pendente

- Entrada por share_token precisa de rate limit/WAF antes de tráfego aberto.
- npm audit registra 43 achados moderados e 6 altos herdados, nenhum crítico. A atualização deve ser tratada separadamente.

## Dados pessoais e fornecedores

LiveKit processa mídia; R2 armazenará gravações; Supabase armazena metadados/transcrições; transcrição e LLM são opcionais. Antes de produção devem ser definidos consentimento, retenção, exclusão e acesso.

## Recomendação

Estado: FIX

Evidências: typecheck, 6 testes, lint sem erros, build Vite e deno check de 8 Edge Functions.

Lacunas: rate limit, teste multi-tenant real, anexos assinados e dependências vulneráveis.

Gate humano pendente: escolha do projeto Supabase e autorização antes de migrar/publicar.
