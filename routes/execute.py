import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

router = APIRouter()
MAX_CODE_BYTES = 128 * 1024
MAX_OUTPUT_BYTES = 32 * 1024
TIMEOUT_SECONDS = max(1, min(int(os.getenv("EXECUTION_TIMEOUT_SECONDS", "5")), 10))
EXECUTION_ENABLED = os.getenv("BUGFALSE_ENABLE_LOCAL_EXECUTION", "false").lower() == "true"

class ExecuteRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=MAX_CODE_BYTES)
    filename: str = Field(default="main.py", max_length=120)

    @field_validator("filename")
    @classmethod
    def basename_only(cls, value: str) -> str:
        cleaned = Path(value.replace("\\", "/")).name
        if not cleaned or cleaned in {".", ".."}:
            raise ValueError("filename must be a simple file name")
        return cleaned

def detect_lang(filename: str):
    return {".py": "python"}.get(Path(filename).suffix.lower())

@router.post("/")
async def execute(payload: ExecuteRequest):
    if len(payload.code.encode("utf-8")) > MAX_CODE_BYTES:
        raise HTTPException(status_code=413, detail="Code exceeds the 128 KB limit.")
    if not EXECUTION_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Code execution is disabled on this deployment. Enable it only in a trusted local environment or connect a properly isolated container-per-job sandbox.",
        )
    lang = detect_lang(payload.filename)
    if lang is None:
        return {"ok": False, "stdout": "", "stderr": "Only Python execution is enabled in this hardened starter.", "exit_code": None, "duration_ms": 0, "timed_out": False, "runtime_available": False}
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="bugfalse-") as tmp:
        script = Path(tmp) / payload.filename
        script.write_text(payload.code, encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-B", str(script)],
                cwd=tmp, env=env, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=TIMEOUT_SECONDS,
                check=False,
            )
            return {
                "ok": proc.returncode == 0,
                "stdout": (proc.stdout or "")[:MAX_OUTPUT_BYTES],
                "stderr": (proc.stderr or "")[:MAX_OUTPUT_BYTES],
                "exit_code": proc.returncode,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "timed_out": False,
                "runtime_available": True,
            }
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False, "stdout": str(exc.stdout or "")[:MAX_OUTPUT_BYTES],
                "stderr": (str(exc.stderr or "") + f"\nExecution timed out after {TIMEOUT_SECONDS}s.")[:MAX_OUTPUT_BYTES],
                "exit_code": None, "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "timed_out": True, "runtime_available": True,
            }
        except OSError:
            return {"ok": False, "stdout": "", "stderr": "Execution runtime failed to start.", "exit_code": None,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1), "timed_out": False, "runtime_available": False}
