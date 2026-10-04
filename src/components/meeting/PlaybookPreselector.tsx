import { Badge } from '@/components/ui/badge';

export function PlaybookPreselector({ mode, suggestedCategory }: { meetingId?: string | null; mode?: string; suggestedCategory?: string | null }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-500">
      Playbook: <Badge variant="outline" className="border-zinc-700 text-zinc-400">{suggestedCategory || (mode === 'cs' ? 'CS' : 'Vendas')}</Badge>
    </div>
  );
}
