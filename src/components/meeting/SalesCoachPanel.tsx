import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Brain, Radio } from 'lucide-react';

interface SalesCoachPanelProps {
  leadId?: string | null;
  meetingId?: string | null;
  liveTranscription?: unknown[] | string;
  mode?: string;
  organizationId?: string | null;
}

export function SalesCoachPanel({ liveTranscription, mode }: SalesCoachPanelProps) {
  const segments = Array.isArray(liveTranscription) ? liveTranscription : [];
  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 p-4">
        <div className="flex items-center gap-2 font-semibold"><Brain className="h-4 w-4 text-orange-500" /> Coach da reunião</div>
        <Badge variant="outline" className="mt-2 border-zinc-700 text-zinc-400">{mode === 'cs' ? 'Sucesso do cliente' : 'Comercial'}</Badge>
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500"><Radio className="h-3.5 w-3.5 text-red-500" /> Transcrição ao vivo</div>
        {segments.length ? segments.slice(-30).map((segment: any, index) => (
          <p key={`${segment?.id || index}`} className="mb-3 text-sm leading-relaxed text-zinc-300">
            <span className="font-medium text-orange-400">{segment?.speaker || segment?.participant_name || 'Participante'}:</span>{' '}
            {segment?.text || segment?.transcript || String(segment)}
          </p>
        )) : <p className="text-sm text-zinc-500">As falas aparecerão aqui quando a transcrição estiver ativa.</p>}
      </ScrollArea>
    </div>
  );
}
