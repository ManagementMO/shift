"""Replay export. Local zip bundle always; Cloudflare R2 upload only when all R2 credentials are present.
The response `mode` says which one happened. No public URL is ever fabricated."""

from __future__ import annotations

import os
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from cityshift.api.service import get_service
from cityshift.contracts import RunStatus
from cityshift.domain.runs import RUN_ROOT
from cityshift.providers import r2_configured

router = APIRouter(prefix="/api", tags=["share"])
EXPORT_ROOT = RUN_ROOT.parent / "exports"
REPLAY_FILES = ("manifest.json", "metrics.json", "tracks.json", "events.json", "occupancy.json", "stop_queue.json", "cohort.json", "compile.json", "validation.json", "population.json", "native.json")


def build_export(rid: str) -> Path:
    run_dir = RUN_ROOT / rid
    EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
    out = EXPORT_ROOT / f"{rid}.replay.zip"
    if out.exists():
        return out
    tmp = out.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in REPLAY_FILES:
            p = run_dir / name
            if p.exists():
                zf.write(p, arcname=name)
    tmp.rename(out)
    return out


def upload_r2(path: Path, key: str) -> str:
    import boto3

    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    s3 = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
    s3.upload_file(str(path), os.environ["R2_BUCKET"], key, ExtraArgs={"ContentType": "application/zip"})
    public = os.environ.get("R2_PUBLIC_BASE_URL")
    return f"{public.rstrip('/')}/{key}" if public else f"r2://{os.environ['R2_BUCKET']}/{key}"


@router.post("/runs/{rid}/export")
def export_run(rid: str) -> dict:
    svc = get_service()
    try:
        run = svc.run(rid)
    except KeyError:
        raise HTTPException(404, f"run {rid} not found")
    if run.status != RunStatus.completed:
        raise HTTPException(409, f"run {rid} is {run.status.value}; only completed runs export")
    path = build_export(rid)
    if r2_configured():
        try:
            url = upload_r2(path, f"replays/{rid}.replay.zip")
            return {"mode": "cloudflare-r2", "path": str(path), "url": url, "bytes": path.stat().st_size}
        except Exception as exc:  # noqa: BLE001
            return {"mode": "local-export", "path": str(path), "url": None, "bytes": path.stat().st_size, "r2_error": str(exc)[:200]}
    return {"mode": "local-export", "path": str(path), "url": None, "bytes": path.stat().st_size,
            "note": "R2 credentials absent; download via /api/exports/{rid}.zip"}


@router.get("/exports/{rid}.zip")
def download_export(rid: str) -> FileResponse:
    path = EXPORT_ROOT / f"{rid}.replay.zip"
    if not path.exists():
        raise HTTPException(404, "export not built; POST /export first")
    return FileResponse(path, media_type="application/zip", filename=path.name)
