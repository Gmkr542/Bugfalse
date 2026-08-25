import logging
import random
import time

import requests

from config import GROQ_TOKEN, GROQ_URL, GROQ_MODEL, GROQ_VERIFY_SSL
from utils.parser import clean_json

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60
MAX_ERROR_BODY_LENGTH = 2000


def _extract_error_message(response):
    """Extract a useful error message without exposing secrets."""
    try:
        data = response.json()
    except ValueError:
        return response.text[:MAX_ERROR_BODY_LENGTH].strip()

    if not isinstance(data, dict):
        return str(data)[:MAX_ERROR_BODY_LENGTH]

    error = data.get("error")

    if isinstance(error, dict):
        message = error.get("message")
        if message:
            return str(message)

        error_type = error.get("type")
        if error_type:
            return str(error_type)

    if isinstance(error, str):
        return error

    message = data.get("message")
    if message:
        return str(message)

    return str(data)[:MAX_ERROR_BODY_LENGTH]


def _handle_http_error(response):
    """
    Convert Groq HTTP errors into safe, useful application errors.

    Returns a dictionary for non-retryable errors.
    Raises RequestException for retryable server/rate-limit errors.
    """
    status = response.status_code
    provider_error = _extract_error_message(response)

    logger.error(
        "Groq API error: status=%s model=%s message=%s",
        status,
        GROQ_MODEL,
        provider_error,
    )

    if status == 400:
        return {
            "error": "Groq rejected the request.",
            "status_code": status,
            "provider_error": provider_error,
            "hint": "Check the request payload, model name, and token permissions.",
        }

    if status == 401:
        return {
            "error": "Groq authentication failed.",
            "status_code": status,
            "provider_error": provider_error,
            "hint": "Check that GROQ_TOKEN in Render contains a valid Groq API key.",
        }

    if status == 403:
        return {
            "error": "Groq access was denied.",
            "status_code": status,
            "provider_error": provider_error,
            "hint": "Check API-key permissions and whether the selected model is available.",
        }

    if status == 404:
        return {
            "error": "Groq endpoint or model was not found.",
            "status_code": status,
            "provider_error": provider_error,
            "hint": f"Check GROQ_URL and GROQ_MODEL. Current model: {GROQ_MODEL}",
        }

    if status == 408:
        raise requests.exceptions.RequestException(
            "Groq request timed out (HTTP 408)"
        )

    if status == 409:
        return {
            "error": "Groq rejected the request because of a conflict.",
            "status_code": status,
            "provider_error": provider_error,
        }

    if status == 413:
        return {
            "error": "The request sent to Groq is too large.",
            "status_code": status,
            "provider_error": provider_error,
            "hint": "Reduce the submitted source code size.",
        }

    if status == 429:
        raise requests.exceptions.RequestException(
            f"Groq rate limit reached (HTTP 429): {provider_error}"
        )

    if 500 <= status <= 599:
        raise requests.exceptions.RequestException(
            f"Groq server error (HTTP {status}): {provider_error}"
        )

    if status >= 400:
        return {
            "error": f"Groq API request failed with HTTP {status}.",
            "status_code": status,
            "provider_error": provider_error,
        }

    return None


def _extract_text(data):
    """Extract assistant text from Groq's OpenAI-compatible response."""
    if not isinstance(data, dict):
        return None

    choices = data.get("choices")

    if isinstance(choices, list) and choices:
        first_choice = choices[0]

        if isinstance(first_choice, dict):
            message = first_choice.get("message")

            if isinstance(message, dict):
                content = message.get("content")

                if isinstance(content, str) and content.strip():
                    return content.strip()

            # Some compatible APIs may expose text directly.
            for key in ("text", "content"):
                value = first_choice.get(key)

                if isinstance(value, str) and value.strip():
                    return value.strip()

    # Defensive fallback for compatible response formats.
    for key in ("text", "output", "generated_text", "content"):
        value = data.get(key)

        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def _parse_ai_response(text):
    """Parse the model's JSON response and normalize its structure."""
    if not isinstance(text, str) or not text.strip():
        return {
            "error": "Groq returned an empty response."
        }

    try:
        parsed = clean_json(text)
    except Exception as exc:
        logger.error(
            "Failed to parse Groq JSON response: %s",
            exc,
        )

        return {
            "error": f"Failed to parse Groq response: {exc}",
            "raw_response": text[:MAX_ERROR_BODY_LENGTH],
        }

    if not isinstance(parsed, dict):
        return {
            "error": "Groq returned JSON, but the response was not an object.",
            "raw_response": text[:MAX_ERROR_BODY_LENGTH],
        }

    improvements = parsed.get("improvements")

    if isinstance(improvements, str):
        improvements = improvements.strip()
        parsed["improvements"] = [improvements] if improvements else []

    elif improvements is None:
        parsed["improvements"] = []

    elif not isinstance(improvements, list):
        parsed["improvements"] = [str(improvements)]

    parsed.setdefault("provider", "groq")

    return parsed


def analyze_code(
    code,
    api_key=None,
    max_attempts=4,
    backoff_factor=1.0,
    mode="analyze",
):
    """
    Send Python source code to Groq and return structured analysis.

    The function intentionally accepts an optional api_key because the
    frontend can supply a key. In production, GROQ_TOKEN from the environment
    is preferred.
    """

    if not isinstance(code, str):
        return {
            "error": "Code must be provided as text."
        }

    if not code.strip():
        return {
            "error": "Code must not be empty."
        }

    token = api_key or GROQ_TOKEN

    if not token:
        return {
            "error": (
                "Missing Groq API token. Set the GROQ_TOKEN environment "
                "variable or provide a key through the UI."
            )
        }

    if not GROQ_URL:
        return {
            "error": "GROQ_URL is not configured."
        }

    if not GROQ_MODEL:
        return {
            "error": "GROQ_MODEL is not configured."
        }

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are BugFalse, an expert software engineer. "
                    "Return ONLY valid JSON. Do not use Markdown fences. "
                    "Never claim code was executed unless execution evidence "
                    "is supplied. Preserve behavior unless the requested "
                    "mode explicitly calls for a change."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Requested mode: {mode}.\n\n"
                    "Analyze the Python code and return ONLY this JSON "
                    "structure:\n\n"
                    "{\n"
                    '  "issues": ['
                    '{"severity": "error|warning|info", '
                    '"message": "", '
                    '"type": "", '
                    '"line": null, '
                    '"column": null'
                    "}],\n"
                    '  "has_errors": false,\n'
                    '  "analysis": "",\n'
                    '  "fixed_code": "complete updated source code",\n'
                    '  "improvements": [],\n'
                    '  "score": 80,\n'
                    '  "summary": {'
                    '"errors": 0, '
                    '"warnings": 0, '
                    '"lines": 0'
                    "},\n"
                    '  "verification": {'
                    '"status": "not_run", '
                    '"notes": ""'
                    "}\n"
                    "}\n\n"
                    "For fix, improve, refactor, or optimize modes, "
                    "fixed_code must contain the complete revised source "
                    "file, not a patch.\n\n"
                    f"Source code:\n\n{code}"
                ),
            },
        ],
        "max_tokens": 1500,
        "temperature": 0.2,
    }

    session = requests.Session()

    # Prevent accidental proxy/environment interference in hosted
    # environments. SSL verification remains configurable.
    session.trust_env = False
    session.verify = GROQ_VERIFY_SSL

    attempt = 0

    while attempt < max_attempts:
        try:
            logger.info(
                "Sending Groq request: model=%s mode=%s attempt=%d/%d",
                GROQ_MODEL,
                mode,
                attempt + 1,
                max_attempts,
            )

            response = session.post(
                GROQ_URL,
                headers=headers,
                json=payload,
                timeout=DEFAULT_TIMEOUT,
            )

            logger.info(
                "Groq response received: status=%s model=%s",
                response.status_code,
                GROQ_MODEL,
            )

            if response.status_code >= 400:
                result = _handle_http_error(response)

                if result is not None:
                    return result

                # _handle_http_error raises for retryable failures.
                return {
                    "error": (
                        f"Groq request failed with HTTP "
                        f"{response.status_code}."
                    ),
                    "status_code": response.status_code,
                }

            try:
                data = response.json()
            except ValueError:
                logger.error(
                    "Groq returned non-JSON response: %s",
                    response.text[:MAX_ERROR_BODY_LENGTH],
                )

                return {
                    "error": "Groq returned an invalid JSON response.",
                    "status_code": response.status_code,
                    "raw_response": response.text[
                        :MAX_ERROR_BODY_LENGTH
                    ],
                }

            text = _extract_text(data)

            if not text:
                logger.error(
                    "Groq returned HTTP %s but no assistant content. "
                    "Response keys=%s",
                    response.status_code,
                    list(data.keys()) if isinstance(data, dict) else type(data),
                )

                return {
                    "error": "Groq returned a successful response but no output content.",
                    "status_code": response.status_code,
                    "response_structure": (
                        list(data.keys())
                        if isinstance(data, dict)
                        else str(type(data))
                    ),
                }

            return _parse_ai_response(text)

        except requests.exceptions.SSLError as exc:
            attempt += 1

            logger.error(
                "Groq SSL error on attempt %d/%d: %s",
                attempt,
                max_attempts,
                exc,
            )

            if attempt >= max_attempts:
                return {
                    "error": f"Groq SSL handshake failed: {exc}",
                    "hint": (
                        "Verify the Render network configuration and "
                        "GROQ_VERIFY_SSL setting."
                    ),
                }

            _sleep_before_retry(
                attempt,
                backoff_factor,
            )

        except requests.exceptions.Timeout as exc:
            attempt += 1

            logger.warning(
                "Groq request timeout on attempt %d/%d: %s",
                attempt,
                max_attempts,
                exc,
            )

            if attempt >= max_attempts:
                return {
                    "error": "Groq request timed out.",
                    "hint": (
                        "The Groq service did not respond within "
                        f"{DEFAULT_TIMEOUT} seconds."
                    ),
                }

            _sleep_before_retry(
                attempt,
                backoff_factor,
            )

        except requests.exceptions.RequestException as exc:
            attempt += 1

            logger.warning(
                "Groq request failed on attempt %d/%d: %s",
                attempt,
                max_attempts,
                exc,
            )

            if attempt >= max_attempts:
                return {
                    "error": f"Groq request failed: {exc}"
                }

            _sleep_before_retry(
                attempt,
                backoff_factor,
            )

        except Exception as exc:
            logger.exception(
                "Unexpected error while processing Groq response."
            )

            return {
                "error": f"Unexpected Groq integration error: {exc}"
            }

    return {
        "error": "Groq request failed after all retry attempts."
    }


def _sleep_before_retry(attempt, backoff_factor):
    """Sleep using exponential backoff with small randomized jitter."""
    base = backoff_factor * (2 ** (attempt - 1))
    jitter = random.uniform(0, base * 0.5)
    delay = base + jitter

    logger.info(
        "Retrying Groq request in %.1f seconds.",
        delay,
    )

    time.sleep(delay)


def check_connectivity(api_key=None, timeout=10):
    """
    Check whether the configured Groq endpoint is reachable.

    This endpoint check does NOT prove that a chat-completion POST will
    authenticate successfully. It is only a network/connectivity check.
    """

    session = requests.Session()
    session.trust_env = False
    session.verify = GROQ_VERIFY_SSL

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    token = api_key or GROQ_TOKEN

    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        response = session.options(
            GROQ_URL,
            headers=headers,
            timeout=timeout,
        )

        return {
            "ok": response.ok,
            "status_code": response.status_code,
            "url": GROQ_URL,
            "model": GROQ_MODEL,
            "verify_ssl": GROQ_VERIFY_SSL,
            "message": (
                "Groq endpoint is reachable."
                if response.ok
                else (
                    "Groq endpoint responded but did not return "
                    "a successful status."
                )
            ),
        }

    except requests.exceptions.SSLError as exc:
        return {
            "ok": False,
            "error": f"SSL handshake failed: {exc}",
        }

    except requests.exceptions.Timeout:
        return {
            "ok": False,
            "error": "Groq connectivity check timed out.",
        }

    except requests.exceptions.RequestException as exc:
        return {
            "ok": False,
            "error": f"Request failed: {exc}",
        }
