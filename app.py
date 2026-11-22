import logging
import os
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from routes.chatbot import router as chatbot_router
from routes.debug import router as debug_router
from routes.execute import router as execute_router
from routes.github_import import router as github_router
from routes.runtime import router as runtime_router

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("bugfalse")

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(
    title="BugFalse",
    description="Full-screen AI coding workspace with GitHub import, AI terminal, and auto-fix.",
    version="7.1.0",
    docs_url="/docs" if os.getenv("ENABLE_API_DOCS", "true").lower() == "true" else None,
    redoc_url=None,
)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
app.include_router(chatbot_router, prefix="/chatbot", tags=["AI Chatbot"])
app.include_router(debug_router, prefix="/debug", tags=["AI Debugging"])
app.include_router(execute_router, prefix="/execute", tags=["Code Execution"])
app.include_router(runtime_router, prefix="/runtime", tags=["Runtime"])
app.include_router(github_router, prefix="/github", tags=["GitHub Import"])

_RATE_BUCKETS = defaultdict(deque)
RATE_LIMIT = max(10, int(os.getenv("RATE_LIMIT_PER_MINUTE", "60")))
RATE_WINDOW = 60


@app.middleware("http")
async def security_and_request_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id", str(uuid.uuid4()))[:100]
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    bucket = _RATE_BUCKETS[client_ip]
    while bucket and now - bucket[0] > RATE_WINDOW:
        bucket.popleft()
    if len(bucket) >= RATE_LIMIT and request.url.path not in ("/health", "/status"):
        response = JSONResponse({"detail": "Rate limit exceeded. Retry shortly.", "request_id": request_id}, status_code=429)
    else:
        bucket.append(now)
        try:
            response = await call_next(request)
        except Exception:
            logger.exception("Unhandled request error request_id=%s", request_id)
            response = JSONResponse({"detail": "Internal server error", "request_id": request_id}, status_code=500)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith(("/debug", "/execute", "/github", "/chatbot")) else "no-cache"
    return response


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"asset_v": app.version},
    )


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "BugFalse", "version": app.version}


@app.get("/status")
async def status():
    return {"status": "ok", "execution_enabled": os.getenv("BUGFALSE_ENABLE_LOCAL_EXECUTION", "false").lower() == "true"}


@app.get("/ready")
async def ready():
    return {
        "ready": True,
        "ai_configured": bool(os.getenv("GROQ_API_KEY") or os.getenv("GROQ_TOKEN") or os.getenv("GEMINI_API_KEY")),
    }
