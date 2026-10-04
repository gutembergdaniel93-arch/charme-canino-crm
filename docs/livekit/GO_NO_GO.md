# Go/No-Go — CRM AI First + LiveKit

## Escopo e critérios

- React compila com rotas de reunião, mentoria, entrada pública e detalhe protegido.
- Schema integra LiveKit sem substituir a tabela meetings.
- Edge Functions compilam e papéis privilegiados respeitam autenticação e recurso.
- Build inclui rewrite SPA para Vercel.

## Verificações

- npx tsc --noEmit --incremental false: passou.
- npm test: 2 arquivos, 6 testes, todos passaram.
- npm run lint: passou sem erros.
- npm run build: passou.
- deno check nas 8 funções adicionadas: passou.
- npm audit: 49 achados herdados; 43 moderados, 6 altos, 0 críticos.

## Não coberto

- Migração real, host + convidado, webhook, R2, transcrição e análise dependem de contas/secrets.
- Upload de anexos fica bloqueado até URLs assinadas.
- Coach IA e playbook flutuante não vieram completos no download; fallbacks preservam a sala, mas essas camadas avançadas ainda não estão completas.

## Ativação e rollback

1. Vincular Supabase e aplicar somente a migração nova.
2. Publicar funções e secrets; testar token sem gravação.
3. Testar host + convidado fictícios no LiveKit.
4. Publicar preview na Vercel.
5. Só depois ativar webhook/Egress/R2, transcrição e agente.
6. Rollback: remover rotas, despublicar funções e desligar webhook; tabelas novas ficam isoladas.

## Decisão

Estado: SHIP técnico em produção com administrador ativo; BLOCK para uso operacional até concluir o webhook e o smoke de sala.

Evidências: código compilado e dist gerado.

Lacunas: cadastro do webhook LiveKit e smoke test real de host + convidado.

Gate humano pendente: cadastro do webhook no painel LiveKit Cloud e confirmação de recebimento do e-mail de senha.
