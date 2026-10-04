import { Bot } from 'lucide-react';

export function CoachChat({ role }: { role: 'host' | 'observer' }) {
  if (role === 'observer') {
    return <div className="h-full bg-zinc-950 p-5 text-sm text-zinc-400"><Bot className="mb-3 h-5 w-5 text-orange-500" />Acompanhe a conversa e use o painel do coach para registrar orientações.</div>;
  }
  return null;
}
