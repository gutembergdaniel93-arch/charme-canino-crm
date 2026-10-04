# Ponte wacli -> CRM (somente leitura do WhatsApp)

Lê `~/.wacli/wacli.db` e `~/.wacli/session.db` (sqlite em modo read-only). Não chama o binário
`wacli`, não envia nada e não escreve em grupo. Grupos, newsletters e status ficam de fora.

## Rodar
    /usr/bin/python3 wacli_import.py                     # DRY-RUN: só gera prévia em ./out/
    SUPABASE_URL=https://<ref>.supabase.co \
    SUPABASE_SECRET_KEY=<service_role ou sb_secret_...> \
    /usr/bin/python3 wacli_import.py --apply             # grava (idempotente, sem DELETE)
    opções: --since 2026-09-01  --wacli-dir ~/.wacli  --config config.json

Rodar de novo é seguro: as mensagens usam UNIQUE(instance_id, message_id) com ignore-duplicates; os leads são
casados por DDI+DDD+últimos 8 dígitos; as notas usam metadata.dedupe.

## O que grava
| wacli | CRM |
|---|---|
| (uma linha fixa) | whatsapp_instances: provider=wacli, sem api_url/api_key (não dá pra enviar por ela) |
| contacts/chats (DM; @lid via whatsmeow_lid_map) | leads: name, phone (só dígitos), source=whatsapp, original_source, utm_source, tags[], etapa_funil, is_internal_contact, contadores e datas, metadata.wacli + metadata.charme |
| messages (DM, sem reações) | whatsapp_messages: message_id=msg_id, remote_jid=chat_jid, is_from_me, content, message_type, sent_at, is_edited, is_deleted, status=imported |
| regras da operação (config.json) | lead_interactions (interaction_type=nota_importacao_charme) |

Origem (`tags origem:*` e `metadata.charme.origem`):
- anuncio: a 1ª mensagem do chat é "Anúncio do Instagram/Facebook ... banho com ozônio" (ou outro texto de anúncio),
  ou o cliente abriu com "Olá! Posso ter mais informações sobre isso?"
- anuncio_curso: anúncio do curso de Banho e Tosa (fora da promo)
- existente: o marcador de anúncio veio depois de uma conversa anterior, OU o chat já existia nos primeiros 7 dias do histórico
- outros: o resto que teve conversa; sem_conversa: contato da agenda sem mensagens

Exclusões (`excluir_campanhas`): equipe (Daniel, Duda, Assyma), "NÃO ATENDER", empresas. O número da loja não é importado.
As tags por nome (reclamacao, ja_avaliou, pendente) só valem quando a regra casa com exatamente 1 contato.
Os casos ambíguos ficam em out/revisar-tags-por-nome.json. Pra resolver, acrescente "phones" na regra do config.json.

## Pré-checagem do --apply (aborta sem gravar se falhar)
- as tabelas existem (migrations aplicadas) e o tenant existe
- nenhum ai_sales_agents ativo: o trigger trg_enqueue_for_ai_agent chamaria o ai-sales-agent pra cada mensagem recebida importada
- nenhuma email_automations ativa: o trigger trg_email_automation_leads dispara em lead_created
- pipeline_stage_id NÃO é definido: o UPDATE dispara trg_enroll_lead_in_cadence
- não são criadas tarefas (company_activities), porque o process-task-reminders manda WhatsApp pra equipe
