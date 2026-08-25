from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import services.groq_service as groq_service

router = APIRouter()

class DebugRequest(BaseModel):
    code: str = Field(..., max_length=300_000)
    filename: str = "main.py"
    language: Optional[str] = None
    framework: Optional[str] = None
    apiKey: Optional[str] = None
    api_key: Optional[str] = None
    key: Optional[str] = None
    mode: str = "analyze"



def local_python_hint(code: str, filename: str):
    """Small deterministic fallback so the workspace remains useful without AI."""
    if not filename.lower().endswith('.py'):
        return None
    try:
        compile(code, filename, 'exec')
    except SyntaxError as exc:
        return {"severity":"error","message":exc.msg,"type":"SyntaxError","line":exc.lineno,"column":exc.offset}
    try:
        import ast
        tree=ast.parse(code)
        defined=set()
        hints=[]
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name)
            elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Param)):
                defined.add(node.id)
        # Catch the common return of an undefined local/global name.
        for node in ast.walk(tree):
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Name) and node.value.id not in defined and node.value.id not in {'True','False','None'}:
                hints.append({"severity":"error","message":f"`{node.value.id}` is not defined; this may cause a NameError.","type":"NameError","line":node.value.lineno,"column":node.value.col_offset+1})
        return hints[0] if hints else None
    except Exception:
        return None

def safe_json_text(value):
    return str(value or "").encode("ascii", errors="backslashreplace").decode("ascii")

@router.post("/")
async def debug(payload: DebugRequest):
    if not payload.code.strip():
        raise HTTPException(status_code=422, detail="Field 'code' must not be empty.")
    api_key = payload.apiKey or payload.api_key or payload.key
    mode = payload.mode if payload.mode in {"analyze","fix","improve","refactor","optimize","security","tests"} else "analyze"
    try:
        if mode == "analyze" and payload.filename == "main.py" and not payload.language and not payload.framework:
            result = groq_service.analyze_code(payload.code, api_key)
        else:
            result = groq_service.analyze_code(
                payload.code, api_key, mode=mode, filename=payload.filename,
                language=payload.language, framework=payload.framework,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=safe_json_text(f"Server error: {exc}"))
    if isinstance(result, dict) and result.get("error"):
        hint = local_python_hint(payload.code, payload.filename)
        if hint:
            result.setdefault("issues", [hint])
            result.setdefault("analysis", "AI is currently unavailable, so BugFalse added a local deterministic diagnostic.")
            result.setdefault("score", 40)
    if isinstance(result, dict):
        result.setdefault("provider", "groq")
        if "errors" in result and "issues" not in result: result["issues"] = result.pop("errors")
        if "explanation" in result and "analysis" not in result: result["analysis"] = result.pop("explanation")
        result.setdefault("mode", mode)
    return result

@router.get("/status")
async def status():
    return groq_service.check_connectivity()
