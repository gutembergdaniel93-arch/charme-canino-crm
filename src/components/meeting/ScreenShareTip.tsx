/**
 * ScreenShareTip — callout one-time ensinando a compartilhar "Janela do navegador"
 * em vez de "Aba", pra o vendedor trocar de aba sem interromper o share.
 * Prática adotada por Zoom/Meet/Teams — getDisplayMedia não permite swap de fonte.
 */
import { useEffect, useState } from 'react';
import { Lightbulb, X } from 'lucide-react';

const STORAGE_KEY = 'screen_share_tip_seen';

export function ScreenShareTip() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === 'true') return;
    } catch {}

    const showTimer = setTimeout(() => setVisible(true), 2000);
    const hideTimer = setTimeout(() => dismiss(), 17000);

    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="absolute bottom-24 left-4 z-50 max-w-sm rounded-xl bg-amber-50 border border-amber-200 shadow-xl p-3 animate-in slide-in-from-left-4 fade-in duration-300">
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 mt-0.5">
          <div className="w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center">
            <Lightbulb className="h-4 w-4 text-amber-700" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-amber-900 mb-1">
            Dica pro compartilhamento
          </div>
          <p className="text-[12px] text-amber-800 leading-relaxed">
            Ao clicar em <strong>Compartilhar tela</strong>, escolha{' '}
            <strong>"Janela"</strong> do navegador em vez de <strong>"Aba"</strong>.
            Você troca entre abas sem precisar parar o share.
          </p>
          <button
            onClick={dismiss}
            className="mt-2 text-[11px] font-semibold text-amber-900 hover:text-amber-700 underline underline-offset-2"
          >
            Entendi
          </button>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-amber-600 hover:text-amber-900 transition-colors"
          title="Fechar"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
