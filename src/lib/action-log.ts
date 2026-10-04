import { supabase } from '@/lib/supabase';

interface ActionLogInput {
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logAction(input: ActionLogInput) {
  const { error } = await supabase.from('config_audit_log').insert({
    table_name: input.resourceType,
    record_id: input.resourceId || null,
    action: input.action,
    changed_by_user_id: input.userId || null,
    new_data: { ...input.metadata, lead_id: input.leadId || undefined },
  });
  if (error) console.warn('[action-log] auditoria não persistida:', error.message);
}
