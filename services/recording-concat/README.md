# recording-concat — Modal worker (ffmpeg concat)

Concatena segments MP4 de uma gravação LiveKit num arquivo final único. Disparado pelo `livekit-webhook` quando a sala fecha (`room_finished`) e há 2+ segments.

## Por que existe

LiveKit Egress encerra automaticamente quando a sala fica momentaneamente vazia. Em fluxos reais (mentoria, onboarding, calls) isso acontece: alguém entra, sai, volta. Cada nova entrada dispara um egress = um arquivo `.mp4` separado. Sem este worker, o usuário veria 1 vídeo de 44s e teria que abrir os outros manualmente.

Com este worker, o webhook detecta múltiplos segments e dispara concat → 1 arquivo final transparente.

## Setup (1x)

### 1. Criar secret no Modal com credenciais R2

```bash
modal secret create r2-credentials \
  R2_ACCESS_KEY=<sua_r2_access_key> \
  R2_SECRET_KEY=<sua_r2_secret_key> \
  R2_ENDPOINT=https://bbb6ad5781c90abbe0d71483f12bfab4.r2.cloudflarestorage.com \
  R2_BUCKET=meeting-recordings \
  R2_PUBLIC_URL=https://pub-9ad9609ce50e4c97b930a99bac90c285.r2.dev
```

### 2. Deploy

```bash
cd cs/recording-concat
modal deploy main.py
```

Modal vai imprimir a URL do endpoint, algo como:
`https://SEU-USUARIO-MODAL--recording-concat-concat.modal.run`

### 3. Configurar a URL no Supabase

```bash
npx supabase secrets set --project-ref SEU-PROJECT-REF-SUPABASE \
  RECORDING_CONCAT_URL=https://SEU-USUARIO-MODAL--recording-concat-concat.modal.run
```

E redeployar o `livekit-webhook` pra pegar a nova env var (ou esperar próximo deploy).

## Como funciona

1. Webhook detecta `room_finished` com 2+ segments no `metadata.recording_segments[]`
2. POST pra Modal endpoint com `{ segments, output_key, s3_public_url }`
3. Modal baixa os segments → roda `ffmpeg -f concat -c copy` (sem re-encode, instantâneo) → upload pro R2
4. Webhook atualiza `recording_url` apontando pro arquivo final
5. PAIN/CRM lê normal — vê 1 vídeo só

## Estratégia ffmpeg

- **Default:** `-c copy` (sem re-encode). 2h de vídeo concatena em ~10s.
- **Fallback:** se containers diferem (raro — LiveKit usa mesma preset), re-encoda com libx264/aac.

## Custos estimados

- Modal: ~$0.0001 por concat (alguns segundos de CPU)
- R2: arquivo extra (~10-20% storage adicional). Configurar lifecycle rule pra deletar segments individuais após 30d se quiser economizar.
