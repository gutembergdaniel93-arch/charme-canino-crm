import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type WacliPhase = "idle" | "pairing" | "connected" | "syncing" | "error";
type WacliProcessKind = "auth" | "sync";

interface WacliState {
  phase: WacliPhase;
  qr: string | null;
  message: string | null;
  processKind: WacliProcessKind | null;
  running: boolean;
}

const initialState = (): WacliState => ({
  phase: "idle",
  qr: null,
  message: null,
  processKind: null,
  running: false,
});

function findWacliBinary(): string | null {
  const candidates = [
    process.env.WACLI_BIN,
    path.join(homedir(), ".local", "bin", "wacli"),
    "/opt/homebrew/bin/wacli",
    "/usr/local/bin/wacli",
    ...((process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, "wacli"))),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readAuthStatus(binary: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["auth", "status", "--json"], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const status = JSON.parse(stdout) as { authenticated?: boolean };
        resolve(status.authenticated === true);
      } catch {
        reject(new Error("WACLI retornou um status inválido."));
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isTrustedOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  return origin === undefined
    || origin === `http://127.0.0.1:${port}`
    || origin === `http://localhost:${port}`;
}

export function localWacliPlugin(): Plugin {
  let state = initialState();
  let child: ChildProcess | null = null;
  let stderrBuffer = "";
  let stopping = false;

  const updateState = (patch: Partial<WacliState>) => {
    state = { ...state, ...patch };
  };

  const run = (binary: string, processKind: WacliProcessKind) => {
    stderrBuffer = "";
    stopping = false;
    updateState({
      phase: processKind === "auth" ? "pairing" : "syncing",
      qr: null,
      message: null,
      processKind,
      running: true,
    });

    const args = processKind === "auth"
      ? ["auth", "--events", "--qr-format", "text", "--follow"]
      : ["sync", "--events", "--follow"];
    const processHandle = spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    child = processHandle;

    processHandle.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      if (stderrBuffer.length > 256_000) stderrBuffer = stderrBuffer.slice(-128_000);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {
            event?: string;
            data?: { code?: string };
          };
          if (event.event === "qr_code" && typeof event.data?.code === "string") {
            updateState({ phase: "pairing", qr: event.data.code, message: null });
          } else if (event.event === "connected") {
            updateState({
              phase: processKind === "sync" ? "syncing" : "connected",
              qr: null,
              message: null,
            });
          } else if (event.event === "auth_starting") {
            updateState({ phase: "pairing" });
          }
        } catch {
          // WACLI also writes human-readable diagnostics to stderr.
        }
      }
    });

    processHandle.on("error", () => {
      if (child === processHandle) child = null;
      updateState({
        phase: "error",
        qr: null,
        message: "Não foi possível iniciar o WACLI nesta máquina.",
        processKind: null,
        running: false,
      });
    });

    processHandle.on("close", (code) => {
      if (child === processHandle) child = null;
      if (state.phase === "error") return;
      if (stopping) {
        stopping = false;
        updateState({
          phase: processKind === "sync" ? "connected" : "idle",
          qr: null,
          message: null,
          processKind: null,
          running: false,
        });
        return;
      }
      if (code !== 0) {
        updateState({
          phase: "error",
          qr: null,
          message: "O WACLI encerrou a conexão. Verifique a instalação e tente novamente.",
          processKind: null,
          running: false,
        });
        return;
      }
      updateState({ processKind: null, running: false });
      void readAuthStatus(binary).then((authenticated) => {
        updateState({
          phase: authenticated ? "connected" : "idle",
          qr: null,
          message: null,
        });
      }).catch(() => {
        updateState({ phase: "idle", qr: null });
      });
    });
  };

  const stop = () => {
    if (!child) return false;
    stopping = true;
    return child.kill("SIGTERM");
  };

  return {
    name: "local-wacli",
    configureServer(server) {
      server.middlewares.use("/api/wacli", (req, res) => {
        if (!isLoopback(req) || !isTrustedOrigin(req, server.config.server.port || 8080)) {
          sendJson(res, 403, { error: "Este serviço só aceita conexões do aplicativo local." });
          return;
        }

        const route = (req.url || "/").split("?")[0];
        if (req.method === "GET" && route === "/status") {
          const binary = findWacliBinary();
          if (!binary) {
            sendJson(res, 200, { ...state, available: false, authenticated: false });
            return;
          }

          const currentState = state;
          if (child) {
            sendJson(res, 200, { ...currentState, available: true, authenticated: currentState.phase === "connected" || currentState.phase === "syncing" });
            return;
          }

          void readAuthStatus(binary).then((authenticated) => {
            if (!authenticated && state.phase === "connected") {
              updateState({ phase: "idle", qr: null, message: null });
            } else if (authenticated && state.phase === "idle") {
              updateState({ phase: "connected", qr: null, message: null });
            }
            sendJson(res, 200, { ...state, available: true, authenticated });
          }).catch(() => {
            sendJson(res, 200, {
              ...state,
              available: true,
              authenticated: false,
              message: state.message || "Não foi possível consultar a sessão local do WACLI.",
            });
          });
          return;
        }

        if (req.method === "POST" && (route === "/auth" || route === "/sync")) {
          const binary = findWacliBinary();
          if (!binary) {
            sendJson(res, 503, { error: "WACLI não está instalado ou não foi encontrado no PATH." });
            return;
          }
          if (child) {
            sendJson(res, 409, { error: "Já existe uma sessão WACLI em execução." });
            return;
          }
          const processKind: WacliProcessKind = route === "/auth" ? "auth" : "sync";
          if (processKind === "sync") {
            void readAuthStatus(binary).then((authenticated) => {
              if (!authenticated) {
                sendJson(res, 409, { error: "Conecte o WhatsApp com o QR Code antes de iniciar a sincronização." });
                return;
              }
              run(binary, processKind);
              sendJson(res, 202, state);
            }).catch(() => {
              sendJson(res, 409, { error: "Não foi possível verificar a sessão WACLI local." });
            });
            return;
          }
          run(binary, processKind);
          sendJson(res, 202, state);
          return;
        }

        if (req.method === "POST" && route === "/stop") {
          const stopped = stop();
          sendJson(res, stopped ? 200 : 409, stopped ? state : { error: "Não há processo WACLI em execução." });
          return;
        }

        sendJson(res, 404, { error: "Rota WACLI local não encontrada." });
      });
    },
  };
}
