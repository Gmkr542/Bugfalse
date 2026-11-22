import requests
import time
import random
import logging
from config import GEMINI_API_KEY, GEMINI_URL
from utils.parser import clean_json

logger = logging.getLogger(__name__)


def analyze_code(code, api_key=None, max_attempts=4, backoff_factor=1.0):
    key = api_key or GEMINI_API_KEY
    if not key:
        return {"error": "Missing Gemini API key. Get one free at https://aistudio.google.com/app/apikey and add it to GEMINI_API_KEY in your environment."}

    prompt = (
        "You are an expert code debugger.\n\n"
        "Return ONLY valid JSON with no explanation, no markdown, no code fences.\n\n"
        "Use this exact structure:\n"
        "{\n"
        "  \"issues\": [{\"line\": null, \"severity\": \"error\", \"type\": \"\", \"message\": \"\"}],\n"
        "  \"has_errors\": false,\n"
        "  \"analysis\": \"\",\n"
        "  \"fixed_code\": \"\",\n"
        "  \"improvements\": [],\n"
        "  \"score\": 80,\n"
        "  \"summary\": {\"errors\": 0, \"warnings\": 0, \"lines\": 0}\n"
        "}\n\n"
        f"Code to analyze:\n\n{code}"
    )

    session = requests.Session()

    attempt = 0
    while attempt < max_attempts:
        try:
            res = session.post(
                f"{GEMINI_URL}?key={key}",
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=60
            )

            if res.status_code in (429, 500, 502, 503, 504):
                raise requests.exceptions.RequestException(f"Server returned {res.status_code}")

            if res.status_code == 400:
                return {"error": f"Bad Gemini request: {res.text}"}

            if res.status_code == 403:
                return {"error": "Gemini API key is invalid. Check GEMINI_API_KEY in your environment."}

            data = res.json()
            logger.debug("Gemini raw response: %s", data)

            try:
                raw = data["candidates"][0]["content"]["parts"][0]["text"]
                parsed = clean_json(raw)
                # Normalise field names to match the shared schema
                if "errors" in parsed and "issues" not in parsed:
                    parsed["issues"] = parsed.pop("errors")
                if "explanation" in parsed and "analysis" not in parsed:
                    parsed["analysis"] = parsed.pop("explanation")
                # Ensure improvements is always a list
                if isinstance(parsed.get("improvements"), str):
                    imp = parsed["improvements"].strip()
                    parsed["improvements"] = [imp] if imp else []
                parsed.setdefault("provider", "gemini")
                return parsed
            except (KeyError, IndexError):
                return {"error": "Failed to parse Gemini response", "raw_response": data}

        except requests.exceptions.RequestException as exc:
            attempt += 1
            msg = str(exc)
            if attempt >= max_attempts:
                logger.error("Gemini request failed after %d attempts: %s", attempt, msg)
                return {"error": f"Gemini request failed: {msg}"}

            base = backoff_factor * (2 ** (attempt - 1))
            jitter = random.uniform(0, base * 0.5)
            sleep_for = base + jitter
            logger.warning("Gemini attempt %d/%d failed: %s — retrying in %.1fs", attempt, max_attempts, msg, sleep_for)
            time.sleep(sleep_for)
