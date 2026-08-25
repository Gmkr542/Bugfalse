import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

MAX_CODE_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
TIMEOUT_SECONDS = 4


class ExecuteRequest(BaseModel):
    code: str = Field(..., max_length=MAX_CODE_BYTES)
    filename: str = "main.py"


def _run_python(code: str, filename: str):
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise HTTPException(status_code=413, detail="Code exceeds the 256 KB execution limit.")

    safe_name = Path(filename).name or "main.py"
    if not safe_name.endswith(".py"):
        safe_name = "main.py"

    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="bugfalse-run-") as tmp:
        script = Path(tmp) / safe_name
        script.write_text(code, encoding="utf-8")

        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
        }

        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-B", str(script)],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=TIMEOUT_SECONDS,
            )
            stdout = proc.stdout[:MAX_OUTPUT_BYTES]
            stderr = proc.stderr[:MAX_OUTPUT_BYTES]
            return {
                "ok": proc.returncode == 0,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": proc.returncode,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "timed_out": False,
            }
        except subprocess.TimeoutExpired as exc:
            stdout = (exc.stdout or "")[:MAX_OUTPUT_BYTES]
            stderr = (exc.stderr or "")[:MAX_OUTPUT_BYTES]
            return {
                "ok": False,
                "stdout": stdout,
                "stderr": stderr + f"\nExecution timed out after {TIMEOUT_SECONDS}s.",
                "exit_code": None,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "timed_out": True,
            }


@router.post("/")
async def execute(payload: ExecuteRequest):
    return _run_python(payload.code, payload.filename)
