import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AlertCircle, CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone, Square, Wifi } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type WacliPhase = "idle" | "pairing" | "connected" | "syncing" | "error";
interface WacliStatus {
  available: boolean;
  authenticated: boolean;
  phase: WacliPhase;
  qr: string | null;
  message: string | null;
  running: boolean;
}

const statusEndpoint = "/api/wacli/status";

async function requestWacli(path: string, method = "GET"): Promise<WacliStatus> {
  const response = await fetch(`/api/wacli${path}`, { method, cache: "no-store" });
  const result = await response.json() as WacliStatus & { error?: string };
  if (!response.ok) throw new Error(result.error || "Não foi possível comunicar com o WACLI local.");
  return result;
}

export function WacliConnectionCard() {
  const [status, setStatus] = useState<WacliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await requestWacli("/status");
      setStatus(current);
      if (current.message) setError(current.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao consultar o WACLI local.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runAction = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await requestWacli(path, "POST");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível iniciar o WACLI.");
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.authenticated || status?.phase === "connected" || status?.phase === "syncing";
  const title = status?.phase === "pairing"
    ? "Aguardando leitura do QR Code"
    : status?.phase === "syncing"
      ? "WhatsApp conectado e sincronizando"
      : connected
        ? "WhatsApp conectado"
        : "WhatsApp desconectado";

  return (
    <Card className="mb-5 border-emerald-500/20">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">WACLI · WhatsApp local</CardTitle>
              <CardDescription className="mt-1">
                Pareie seu WhatsApp pela tela de Agentes IA. A sessão e as mensagens ficam nesta máquina.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className={connected ? "border-emerald-500/30 text-emerald-600" : "text-muted-foreground"}>
            {connected ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <Wifi className="mr-1 h-3 w-3" />}
            {title}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm text-muted-foreground">
            No celular, abra WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e escaneie o QR.
          </p>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {!status?.available && (
            <p className="text-sm text-muted-foreground">
              Instale o WACLI nesta máquina para habilitar o pareamento. No macOS 13, use a instalação a partir do código-fonte; os binários oficiais recentes exigem macOS 15 ou superior.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!connected && (
              <Button
                size="sm"
                onClick={() => void runAction("/auth")}
                disabled={busy || !status?.available || status?.phase === "pairing"}
              >
                {busy || status?.phase === "pairing"
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <QrCode className="mr-2 h-4 w-4" />}
                Gerar QR Code
              </Button>
            )}
            {connected && !status?.running && (
              <Button size="sm" variant="outline" onClick={() => void runAction("/sync")} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Iniciar sincronização
              </Button>
            )}
            {status?.running && (
              <Button size="sm" variant="outline" onClick={() => void runAction("/stop")} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                Parar processo local
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Esta conexão não envia mensagens automaticamente. O QR e a sessão não são enviados ao Supabase.
          </p>
        </div>
        {status?.qr && (
          <div className="flex shrink-0 flex-col items-center gap-2 rounded-xl border bg-white p-4">
            <QRCodeSVG value={status.qr} size={224} level="M" includeMargin />
            <span className="text-xs text-slate-600">QR temporário — escaneie agora</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
