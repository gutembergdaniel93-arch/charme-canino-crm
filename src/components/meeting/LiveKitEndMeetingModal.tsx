import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { Loader2 } from 'lucide-react';

type MeetingOutcome = 'completed' | 'no_show' | 'rescheduled';

interface EndMeetingProps {
  open: boolean;
  meetingId?: string;
  activityId?: string;
  leadId?: string | null;
  organizationId?: string | null;
  meetingType?: string;
  transcriptions?: unknown[];
  onConfirmed: (status: MeetingOutcome, data?: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
}

export function LiveKitEndMeetingModal(props: EndMeetingProps) {
  const [saving, setSaving] = useState<MeetingOutcome | null>(null);

  const finish = async (outcome: MeetingOutcome) => {
    setSaving(outcome);
    try {
      if (props.meetingId) {
        const dbStatus = outcome === 'rescheduled' ? 'cancelled' : outcome;
        const { error } = await supabase.from('meetings').update({
          status: dbStatus,
          ended_at: new Date().toISOString(),
          transcriptions: props.transcriptions || [],
        }).eq('id', props.meetingId);
        if (error) throw error;
      }
      await props.onConfirmed(outcome, {
        callId: props.meetingId,
        activityId: props.activityId,
        leadId: props.leadId,
        organizationId: props.organizationId,
        meetingType: props.meetingType,
        transcriptions: props.transcriptions || [],
      });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !saving) props.onCancel(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Como terminou a reunião?</DialogTitle><DialogDescription>Essa informação atualiza o CRM e define o próximo processamento.</DialogDescription></DialogHeader>
        <div className="grid gap-2 sm:grid-cols-3">
          {([['completed', 'Concluída'], ['no_show', 'Não compareceu'], ['rescheduled', 'Reagendada']] as const).map(([value, label]) => (
            <Button key={value} variant={value === 'completed' ? 'default' : 'outline'} disabled={Boolean(saving)} onClick={() => finish(value)}>
              {saving === value && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{label}
            </Button>
          ))}
        </div>
        <DialogFooter><Button variant="ghost" disabled={Boolean(saving)} onClick={props.onCancel}>Fechar sem processar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
