import sys
sys.stdout.reconfigure(encoding="utf-8")

import logging
import os
import json
from logging.handlers import RotatingFileHandler

from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from routes.debug import router as debug_router
from routes.chatbot import router as chatbot_router
from routes.execute import router as execute_router

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

base_dir = os.path.dirname(__file__)
log_dir = os.path.join(base_dir, "logs")
os.makedirs(log_dir, exist_ok=True)

file_handler = RotatingFileHandler(
    os.path.join(log_dir, "bugfalse.log"),
    maxBytes=5 * 1024 * 1024,
    backupCount=3,
)
file_handler.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)s %(name)s: %(message)s"
))
logging.getLogger().addHandler(file_handler)

class JSONFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)

json_handler = RotatingFileHandler(
    os.path.join(log_dir, "bugfalse.json.log"),
    maxBytes=5 * 1024 * 1024,
    backupCount=3,
)
json_handler.setFormatter(JSONFormatter())
logging.getLogger().addHandler(json_handler)

app = FastAPI(
    title="BugFalse AI Debugger",
    description="AI-powered Python code debugger using Groq LLM",
    version="2.1.0",
)

templates = Jinja2Templates(directory=os.path.join(base_dir, "templates"))
app.mount(
    "/static",
    StaticFiles(directory=os.path.join(base_dir, "static")),
    name="static",
)

app.include_router(debug_router, prefix="/debug", tags=["Debug"])
app.include_router(chatbot_router, prefix="/chatbot", tags=["Chatbot"])
app.include_router(execute_router, prefix="/execute", tags=["Execution"])

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")

@app.get("/chat", response_class=HTMLResponse)
async def chat_page(request: Request):
    from chat_history import load_history
    return templates.TemplateResponse(
        request=request,
        name="chat.html",
        context={"history": load_history()},
    )

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "BugFalse AI Debugger"}

@app.head("/status")
async def status():
    return Response(status_code=200)

@app.get("/status")
async def status_get():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 5000))
    reload = os.environ.get("DEV", "false").strip().lower() in ("1", "true", "yes")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=reload, log_level="info")
