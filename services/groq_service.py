import requests
import time
import random
import logging

from config import GROQ_TOKEN, GROQ_URL, GROQ_MODEL, GROQ_VERIFY_SSL
from utils.parser import clean_json

logger = logging.getLogger(__name__)

_MODEL_CACHE = {"model": None, "expires": 0}
_PREFERRED_MODELS = [
    "openai/gpt-oss-120b",
    "llama-4-maverick-17b-128e-instruct",
    "llama-4-scout-17b-16e-instruct",
    "qwen/qwen3-32b",
    "llama-3.1-8b-instant",
]


def _model_candidates(models):
    ids = []
    for item in models or []:
        if isinstance(item, dict) and item.get("id"):
            ids.append(str(item["id"]))
    ranked = []
    for preferred in _PREFERRED_MODELS:
        if preferred in ids:
            ranked.append(preferred)
    # Prefer instruction/chat models and avoid embedding/guard/whisper/speech models.
    for mid in ids:
        low = mid.lower()
        if mid in ranked or any(x in low for x in ("embed", "whisper", "guard", "tts", "speech")):
            continue
        if any(x in low for x in ("instruct", "gpt-oss", "llama", "qwen", "mixtral", "gemma")):
            ranked.append(mid)
    return ranked


def resolve_model(session, token, configured=None, force_refresh=False):
    """Return a currently available chat model. Never rely on a retired default."""
    now = time.time()
    if not force_refresh and _MODEL_CACHE["model"] and _MODEL_CACHE["expires"] > now:
        return _MODEL_CACHE["model"]
    if configured:
        # Keep the explicit environment choice as the first candidate. If Groq says
        # 404, the caller can force_refresh and discover a live model instead.
        return configured
    response = session.get(
        "https://api.groq.com/openai/v1/models",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if not response.ok:
        raise requests.exceptions.RequestException(
            f"Could not discover Groq models ({response.status_code}): {response.text[:500]}"
        )
    data = response.json()
    candidates = _model_candidates(data.get("data", []) if isinstance(data, dict) else [])
    if not candidates:
        raise requests.exceptions.RequestException("Groq returned no usable chat models.")
    _MODEL_CACHE.update(model=candidates[0], expires=now + 900)
    return candidates[0]


def invalidate_model_cache():
    _MODEL_CACHE.update(model=None, expires=0)


def analyze_code(code, api_key=None, max_attempts=4, backoff_factor=1.0, mode="analyze", filename="main.py", language=None, framework=None, instruction=None):
    token = api_key or GROQ_TOKEN
    if not token:
        return {"error": "Missing Groq API token. Set the GROQ_TOKEN environment variable or paste your key in the UI. Get one free at https://console.groq.com/keys"}

    if not GROQ_URL:
        return {"error": "GROQ_URL not configured in environment"}

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": GROQ_MODEL or "",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are BugFalse, an expert software engineer. "
                    "Return ONLY valid JSON with no markdown or code fences. "
                    "Never claim code was executed unless execution evidence is supplied. "
                    "Preserve behavior unless the requested mode explicitly calls for change."
                )
            },
            {
                "role": "user",
                "content": (
                    f"Requested mode: {mode}.\nFilename: {filename}\nLanguage: {language or 'unknown'}\nFramework: {framework or 'none'}\n" + (f"User-requested change: {instruction.strip()}\n" if instruction and instruction.strip() else "") + "\n"
                    "Analyze the code and return ONLY this JSON structure:\n\n"
                    "{\n"
                    "  \"issues\": [{\"severity\": \"error|warning|info\", \"message\": \"\", \"type\": \"\", \"line\": null, \"column\": null}],\n"
                    "  \"has_errors\": false,\n"
                    "  \"analysis\": \"\",\n"
                    "  \"fixed_code\": \"complete updated source code\",\n"
                    "  \"improvements\": [],\n"
                    "  \"score\": 80,\n"
                    "  \"summary\": {\"errors\": 0, \"warnings\": 0, \"lines\": 0},\n"
                    "  \"verification\": {\"status\": \"not_run\", \"notes\": \"\"}\n"
                    "}\n\n"
                    "For fix/improve/refactor/optimize modes, fixed_code must contain the full revised file, not a patch. "
                    f"Source code:\n\n{code}"
                )
            }
        ],
        "max_tokens": max(4000, min(12000, len(code) // 2 + 4000)),
        "temperature": 0.2,
        "response_format": {"type": "json_object"}
    }

    session = requests.Session()
    session.trust_env = False
    session.verify = GROQ_VERIFY_SSL

    try:
        payload["model"] = resolve_model(session, token, configured=GROQ_MODEL or None)
    except requests.exceptions.RequestException as exc:
        return {"error": f"Groq model discovery failed: {exc}"}

    attempt = 0
    while attempt < max_attempts:
        try:
            res = session.post(GROQ_URL, headers=headers, json=payload, timeout=60)

            logger.debug("Groq status code: %s", res.status_code)

            if res.status_code in (429, 500, 502, 503, 504):
                raise requests.exceptions.RequestException(f"Server returned {res.status_code}")

            if res.status_code == 401:
                return {"error": "Groq API token is invalid. Go to https://console.groq.com/keys and create a new key."}

            if res.status_code == 404:
                # Groq retires models periodically. If the configured model is gone,
                # discover a currently available model and retry once with it.
                invalidate_model_cache()
                try:
                    discovered = resolve_model(session, token, configured=None, force_refresh=True)
                    if discovered and discovered != payload.get("model"):
                        payload["model"] = discovered
                        res = session.post(GROQ_URL, headers=headers, json=payload, timeout=60)
                    else:
                        return {"error": f"Groq model is unavailable (404): {res.text[:1200]}", "hint": "Set GROQ_MODEL to a model currently listed by Groq, or leave GROQ_MODEL empty for automatic discovery."}
                except requests.exceptions.RequestException as exc:
                    return {"error": f"Groq model is unavailable (404): {res.text[:900]}", "hint": f"Automatic model discovery failed: {exc}"}

            if res.status_code == 400:
                # Some Groq models/endpoints may reject JSON-mode even though the
                # OpenAI-compatible endpoint itself is healthy. Retry once without
                # response_format before reporting the request as failed.
                try:
                    error_text = res.text[:1200]
                except Exception:
                    error_text = "Bad request"
                if payload.get("response_format"):
                    fallback_payload = dict(payload)
                    fallback_payload.pop("response_format", None)
                    retry = session.post(GROQ_URL, headers=headers, json=fallback_payload, timeout=60)
                    if retry.ok:
                        res = retry
                    else:
                        return {"error": f"Groq rejected the request ({retry.status_code}): {retry.text[:1200]}", "hint": "Check GROQ_MODEL and GROQ_TOKEN in Render Environment Variables."}
                else:
                    return {"error": f"Bad request to Groq API: {error_text}", "hint": "Check GROQ_MODEL and GROQ_TOKEN in Render Environment Variables."}

            if not res.ok:
                return {"error": f"Groq request failed ({res.status_code}): {res.text[:1200]}", "hint": "Check GROQ_MODEL, GROQ_TOKEN and the deployed runtime."}

            data = res.json()
            logger.debug("Groq raw response: %s", data)

            # Extract content from the OpenAI-compatible response. Groq responses
            # can contain a string, a list of content blocks, or (for some models)
            # reasoning content alongside the normal answer.
            def _content_to_text(value):
                if isinstance(value, str):
                    return value.strip()
                if isinstance(value, list):
                    parts = []
                    for block in value:
                        if isinstance(block, str):
                            parts.append(block)
                        elif isinstance(block, dict):
                            parts.append(block.get("text") or block.get("content") or "")
                    return "".join(parts).strip()
                if isinstance(value, dict):
                    return (value.get("text") or value.get("content") or "").strip()
                return ""

            text = ""
            if isinstance(data, dict):
                choices = data.get("choices") or []
                if choices and isinstance(choices, list) and isinstance(choices[0], dict):
                    message = choices[0].get("message") or {}
                    text = _content_to_text(message.get("content"))
                    if not text:
                        text = _content_to_text(message.get("reasoning_content"))
                    if not text:
                        text = _content_to_text(choices[0].get("text"))
                if not text:
                    text = (
                        _content_to_text(data.get("output_text")) or
                        _content_to_text(data.get("text")) or
                        _content_to_text(data.get("output")) or
                        _content_to_text(data.get("generated_text")) or
                        _content_to_text(data.get("content"))
                    )

            elif isinstance(data, list) and data:
                first = data[0]
                if isinstance(first, dict):
                    text = (
                        _content_to_text(first.get("content")) or
                        _content_to_text(first.get("text")) or
                        _content_to_text(first.get("generated_text"))
                    )

            if not text:
                logger.error("Groq returned no usable text. Response keys: %s", list(data.keys()) if isinstance(data, dict) else type(data).__name__)
                return {
                    "error": "Groq returned an empty response. Check the selected model and API response.",
                    "raw_response": data
                }

            try:
                parsed = clean_json(text)
                # Ensure improvements is always a list
                if isinstance(parsed.get("improvements"), str):
                    imp = parsed["improvements"].strip()
                    parsed["improvements"] = [imp] if imp else []
                parsed.setdefault("provider", "groq")
                parsed.setdefault("model", payload.get("model") or GROQ_MODEL)
                if mode in {"fix", "improve", "refactor", "optimize"} and not isinstance(parsed.get("fixed_code"), str):
                    parsed["fixed_code"] = ""
                return parsed
            except Exception as exc:
                return {
                    "error": f"Failed to parse Groq response: {exc}",
                    "raw_response": text
                }

        except requests.exceptions.RequestException as exc:
            attempt += 1
            msg = str(exc)
            if attempt >= max_attempts:
                logger.error("Groq request failed after %d attempts: %s", attempt, msg)
                if isinstance(exc, requests.exceptions.SSLError):
                    return {
                        "error": f"Groq SSL handshake failed: {msg}.",
                        "hint": "Try setting GROQ_VERIFY_SSL=false in your environment for debugging."
                    }
                return {"error": f"Groq request failed: {msg}"}

            base = backoff_factor * (2 ** (attempt - 1))
            jitter = random.uniform(0, base * 0.5)
            sleep_for = base + jitter
            logger.warning(
                "Groq attempt %d/%d failed: %s — retrying in %.1fs",
                attempt, max_attempts, msg, sleep_for
            )
            time.sleep(sleep_for)


def check_connectivity(api_key=None, timeout=10):
    session = requests.Session()
    session.trust_env = False
    session.verify = GROQ_VERIFY_SSL

    headers = {"Content-Type": "application/json"}
    token = api_key or GROQ_TOKEN
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        response = session.options(GROQ_URL, headers=headers, timeout=timeout)
        return {
            "ok": response.ok,
            "status_code": response.status_code,
            "url": GROQ_URL,
            "verify_ssl": GROQ_VERIFY_SSL,
            "message": (
                "Groq endpoint is reachable."
                if response.ok
                else "Groq endpoint responded but did not return a successful status."
            )
        }
    except requests.exceptions.SSLError as exc:
        return {"ok": False, "error": f"SSL handshake failed: {exc}"}
    except requests.exceptions.RequestException as exc:
        return {"ok": False, "error": f"Request failed: {exc}"}


def chat(message, code="", filename="", language="", framework="", history=None, api_key=None):
    """Professional code-aware chat using the same robust Groq response handling."""
    token = api_key or GROQ_TOKEN
    if not token:
        return {"error": "AI is not configured. Set GROQ_TOKEN in Render Environment Variables."}
    history = history or []
    messages = [{
        "role": "system",
        "content": (
            "You are BugFalse AI, a senior software engineer. Give direct, useful answers. "
            "Use the supplied code as context. Never claim code was executed without evidence. "
            "Use Markdown for code and structured explanations."
        )
    }]
    for item in history:
        role = "user" if item.get("role") == "user" else "assistant"
        text = item.get("text", "")
        if text:
            messages.append({"role": role, "content": text})
    context = f"Current file: {filename or 'none'}\nLanguage: {language or 'unknown'}\nFramework: {framework or 'none'}\n"
    if code:
        context += f"\nCurrent code:\n```{language or ''}\n{code[:60000]}\n```\n"
    messages.append({"role": "user", "content": context + "\nUser request:\n" + message})

    session = requests.Session()
    session.trust_env = False
    session.verify = GROQ_VERIFY_SSL
    try:
        res = session.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"model": GROQ_MODEL, "messages": messages, "temperature": 0.2, "max_tokens": 2000},
            timeout=60,
        )
        if res.status_code == 401:
            return {"error": "Groq API token is invalid. Check GROQ_TOKEN in Render."}
        if not res.ok:
            return {"error": f"Groq request failed ({res.status_code}). {res.text[:500]}"}
        data = res.json()
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                content = "".join((x.get("text", "") if isinstance(x, dict) else str(x)) for x in content)
            if content and str(content).strip():
                return {"reply": str(content).strip(), "provider": "groq"}
            reasoning = msg.get("reasoning_content")
            if reasoning:
                return {"reply": str(reasoning).strip(), "provider": "groq"}
        return {"error": "Groq returned an empty response. Check the selected model and API configuration."}
    except requests.exceptions.RequestException as exc:
        logger.exception("Groq chat request failed")
        return {"error": f"Unable to reach Groq: {exc}"}
    except Exception as exc:
        logger.exception("Groq chat parsing failed")
        return {"error": f"AI response could not be read: {exc}"}
