"""
recording-concat — Modal worker que concatena segments MP4 de uma gravação.

Disparado pelo livekit-webhook quando `room_finished` chega e há 2+ segments.
Roda ffmpeg em modo `-c copy` (sem re-encoding — junta containers em segundos,
mantém qualidade exata do original).

Deploy:
    modal deploy main.py

Secrets esperados no Modal:
    R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT, R2_BUCKET

Endpoint: o webhook chama via POST {url}/concat com:
    { "segments": ["https://pub-...mp4", ...], "output_key": "room-FINAL.mp4" }

Retorno: { "ok": true, "url": "https://pub-.../room-FINAL.mp4", "duration_sec": N }
"""
import modal

app = modal.App("recording-concat")

# Image com ffmpeg + boto3
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("boto3==1.34.131", "fastapi==0.115.0")
)

R2_SECRETS = modal.Secret.from_name("r2-credentials")  # Frank cria 1x via Modal dashboard


@app.function(
    image=image,
    secrets=[R2_SECRETS],
    timeout=600,  # 10min — concat de ~2h cabe folga
    cpu=2,
    memory=2048,
)
@modal.fastapi_endpoint(method="POST")
def concat(payload: dict):
    """
    Concatena lista de segments MP4 num arquivo único.

    Body:
      segments: List[str] — URLs públicas R2 dos segments (na ordem)
      output_key: str — nome do arquivo final no bucket R2

    Estratégia: `ffmpeg -f concat` mode (sem re-encode).
    Pré-requisito dos containers: mesma resolução/codec (LiveKit Egress sempre
    usa mesma preset → ok). Se diverge, ffmpeg cai pra re-encode automático.
    """
    import os
    import subprocess
    import tempfile
    import urllib.request
    import urllib.parse
    import boto3

    segments = payload.get("segments") or []
    output_key = payload.get("output_key") or "concat-output.mp4"
    if not segments or len(segments) < 2:
        return {"ok": False, "error": "need 2+ segments"}

    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY"],
        aws_secret_access_key=os.environ["R2_SECRET_KEY"],
        region_name="auto",
    )
    bucket = os.environ.get("R2_BUCKET", "meeting-recordings")

    with tempfile.TemporaryDirectory() as tmp:
        local_files = []
        for i, url in enumerate(segments):
            local = os.path.join(tmp, f"seg_{i:03d}.mp4")
            urllib.request.urlretrieve(url, local)
            local_files.append(local)

        # ffconcat list file
        list_file = os.path.join(tmp, "list.txt")
        with open(list_file, "w") as f:
            for lf in local_files:
                # escape single quotes (paths são tmp dirs sem espaço, ok)
                f.write(f"file '{lf}'\n")

        out_path = os.path.join(tmp, "out.mp4")
        # -c copy: sem re-encode (rápido + qualidade preservada)
        # +faststart: move moov atom pro início (streaming-friendly)
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", list_file,
            "-c", "copy",
            "-movflags", "+faststart",
            out_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            # Fallback: re-encode (caso containers incompatíveis)
            cmd_fallback = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", list_file,
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                out_path,
            ]
            proc2 = subprocess.run(cmd_fallback, capture_output=True, text=True)
            if proc2.returncode != 0:
                return {"ok": False, "error": "ffmpeg failed", "stderr": proc2.stderr[-2000:]}

        # Probe duração final
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", out_path],
            capture_output=True, text=True,
        )
        try:
            duration_sec = int(float(probe.stdout.strip()))
        except Exception:
            duration_sec = 0

        # Upload pro R2
        with open(out_path, "rb") as f:
            s3.put_object(
                Bucket=bucket,
                Key=output_key,
                Body=f,
                ContentType="video/mp4",
            )

    public_base = payload.get("s3_public_url") or os.environ.get("R2_PUBLIC_URL", "")
    final_url = f"{public_base}/{output_key}" if public_base else None
    return {
        "ok": True,
        "url": final_url,
        "key": output_key,
        "duration_sec": duration_sec,
        "segments_count": len(segments),
    }
