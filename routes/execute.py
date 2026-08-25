import os
import shutil
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
TIMEOUT_SECONDS = 8

class ExecuteRequest(BaseModel):
    code: str = Field(..., max_length=MAX_CODE_BYTES)
    filename: str = "main.py"


def _result(proc, started):
    return {
        "ok": proc.returncode == 0,
        "stdout": (proc.stdout or "")[:MAX_OUTPUT_BYTES],
        "stderr": (proc.stderr or "")[:MAX_OUTPUT_BYTES],
        "exit_code": proc.returncode,
        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        "timed_out": False,
    }


def _python(cmd, script):
    return [cmd, "-I", "-B", str(script)]


def _command_for(lang, script, tmp):
    name = script.name
    if lang == "python":
        return [sys.executable, "-I", "-B", str(script)]
    if lang == "javascript":
        return ["node", str(script)]
    if lang == "typescript":
        return ["tsx", str(script)]
    if lang == "php":
        return ["php", str(script)]
    if lang == "ruby":
        return ["ruby", str(script)]
    if lang == "swift":
        return ["swift", str(script)]
    if lang == "go":
        return ["go", "run", str(script)]
    if lang == "rust":
        out = Path(tmp) / "bugfalse_bin"
        subprocess.run(["rustc", str(script), "-o", str(out)], cwd=tmp, capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        return [str(out)]
    if lang in ("c", "cpp"):
        compiler = "gcc" if lang == "c" else "g++"
        out = Path(tmp) / "bugfalse_bin"
        compile_proc = subprocess.run([compiler, str(script), "-O0", "-o", str(out)], cwd=tmp, capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        if compile_proc.returncode != 0:
            return None, compile_proc
        return [str(out)]
    if lang == "java":
        # Java source execution is supported on modern JDKs; fallback to javac/java.
        return ["java", str(script)]
    return None


def detect_lang(filename):
    ext = Path(filename).suffix.lower()
    return {
        ".py":"python", ".js":"javascript", ".mjs":"javascript", ".cjs":"javascript",
        ".ts":"typescript", ".tsx":"typescript", ".php":"php", ".rb":"ruby",
        ".swift":"swift", ".go":"go", ".rs":"rust", ".c":"c", ".cc":"cpp", ".cpp":"cpp", ".cxx":"cpp",
        ".java":"java"
    }.get(ext)


@router.post("/")
async def execute(payload: ExecuteRequest):
    if len(payload.code.encode("utf-8")) > MAX_CODE_BYTES:
        raise HTTPException(status_code=413, detail="Code exceeds the 256 KB execution limit.")
    safe_name = Path(payload.filename).name or "main.py"
    lang = detect_lang(safe_name)
    if not lang:
        return {"ok": False, "stdout": "", "stderr": "Live execution is not available for this file type yet.", "exit_code": None, "duration_ms": 0, "timed_out": False, "runtime_available": False}

    commands = {"python": sys.executable, "javascript":"node", "typescript":"tsx", "php":"php", "ruby":"ruby", "swift":"swift", "go":"go", "rust":"rustc", "c":"gcc", "cpp":"g++", "java":"java"}
    executable = commands[lang]
    if lang == "python": available = True
    else: available = bool(shutil.which(executable))
    if not available:
        return {"ok": False, "stdout": "", "stderr": f"{lang.title()} runtime is not installed on this server. The editor supports this language, but execution requires the runtime in the deployment image.", "exit_code": None, "duration_ms": 0, "timed_out": False, "runtime_available": False}

    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="bugfalse-run-") as tmp:
        script = Path(tmp) / safe_name
        script.write_text(payload.code, encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONIOENCODING":"utf-8", "PYTHONDONTWRITEBYTECODE":"1", "PYTHONUNBUFFERED":"1"}
        try:
            if lang in ("c", "cpp"):
                compiler = executable
                out = Path(tmp) / "bugfalse_bin"
                cp = subprocess.run([compiler, str(script), "-O0", "-o", str(out)], cwd=tmp, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, env=env)
                if cp.returncode != 0:
                    return {"ok":False,"stdout":cp.stdout[:MAX_OUTPUT_BYTES],"stderr":cp.stderr[:MAX_OUTPUT_BYTES],"exit_code":cp.returncode,"duration_ms":round((time.perf_counter()-started)*1000,1),"timed_out":False,"runtime_available":True}
                command=[str(out)]
            elif lang == "rust":
                out=Path(tmp)/"bugfalse_bin"
                cp=subprocess.run(["rustc",str(script),"-O","-o",str(out)],cwd=tmp,capture_output=True,text=True,timeout=TIMEOUT_SECONDS,env=env)
                if cp.returncode != 0:
                    return {"ok":False,"stdout":cp.stdout[:MAX_OUTPUT_BYTES],"stderr":cp.stderr[:MAX_OUTPUT_BYTES],"exit_code":cp.returncode,"duration_ms":round((time.perf_counter()-started)*1000,1),"timed_out":False,"runtime_available":True}
                command=[str(out)]
            elif lang == "go": command=["go","run",str(script)]
            elif lang == "typescript": command=["tsx",str(script)]
            elif lang == "java": command=["java",str(script)]
            else: command=[executable,str(script)] if lang != "python" else [sys.executable,"-I","-B",str(script)]
            proc=subprocess.run(command,cwd=tmp,env=env,capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=TIMEOUT_SECONDS)
            result=_result(proc,started)
            result["runtime_available"]=True
            return result
        except subprocess.TimeoutExpired as exc:
            return {"ok":False,"stdout":str(exc.stdout or "")[:MAX_OUTPUT_BYTES],"stderr":str(exc.stderr or "")[:MAX_OUTPUT_BYTES]+f"\nExecution timed out after {TIMEOUT_SECONDS}s.","exit_code":None,"duration_ms":round((time.perf_counter()-started)*1000,1),"timed_out":True,"runtime_available":True}
        except Exception as exc:
            return {"ok":False,"stdout":"","stderr":str(exc),"exit_code":None,"duration_ms":round((time.perf_counter()-started)*1000,1),"timed_out":False,"runtime_available":True}
