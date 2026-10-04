import { Sparkles } from 'lucide-react';

export function BackgroundBlurToggle() {
  return (
    <button
      type="button"
      disabled
      title="Desfoque de fundo será habilitado quando o processador de vídeo estiver configurado"
      className="absolute bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-zinc-900/75 px-3 py-1.5 text-xs text-zinc-400 opacity-70 backdrop-blur"
    >
      <Sparkles className="h-3.5 w-3.5" /> Fundo virtual
    </button>
  );
}
