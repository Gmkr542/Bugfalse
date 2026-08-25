import requests
import time
import random
import logging

from config import GROQ_TOKEN, GROQ_URL, GROQ_MODEL, GROQ_VERIFY_SSL
from utils.parser import clean_json

logger = logging.getLogger(__name__)


def analyze_code(code, api_key=None, max_attempts=4, backoff_factor=1.0, mode="analyze", filename="main.py", language=None, framework=None):
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
        "model": GROQ_MODEL,
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
                    f"Requested mode: {mode}.\nFilename: {filename}\nLanguage: {language or 'unknown'}\nFramework: {framework or 'none'}\n\n"
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
        "max_tokens": 1500,
        "temperature": 0.2
    }

    session = requests.Session()
    session.trust_env = False
    session.verify = GROQ_VERIFY_SSL

    attempt = 0
    while attempt < max_attempts:
        try:
            res = session.post(GROQ_URL, headers=headers, json=payload, timeout=60)

            logger.debug("Groq status code: %s", res.status_code)

            if res.status_code in (429, 500, 502, 503, 504):
                raise requests.exceptions.RequestException(f"Server returned {res.status_code}")

            if res.status_code == 401:
                return {"error": "Groq API token is invalid. Go to https://console.groq.com/keys and create a new key."}

            if res.status_code == 400:
                return {"error": f"Bad request to Groq API: {res.text}"}

            data = res.json()
            logger.debug("Groq raw response: %s", data)

            # Extract content from OpenAI-compatible response
            text = None
            if isinstance(data, dict):
                choices = data.get("choices")
                if choices and isinstance(choices, list):
                    message = choices[0].get("message", {})
                    text = message.get("content")

                if not text:
                    text = (
                        data.get("text") or
                        data.get("output") or
                        data.get("generated_text") or
                        data.get("content")
                    )

            elif isinstance(data, list) and data:
                first = data[0]
                if isinstance(first, dict):
                    text = (
                        first.get("content") or
                        first.get("text") or
                        first.get("generated_text")
                    )

            if not text:
                logger.error("Could not extract text from Groq response: %s", data)
                return {
                    "error": "No output generated from Groq",
                    "raw_response": data
                }

            try:
                parsed = clean_json(text)
                # Ensure improvements is always a list
                if isinstance(parsed.get("improvements"), str):
                    imp = parsed["improvements"].strip()
                    parsed["improvements"] = [imp] if imp else []
                parsed.setdefault("provider", "groq")
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
