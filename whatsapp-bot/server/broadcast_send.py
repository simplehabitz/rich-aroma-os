"""
Broadcast sending: OS -> bot -> customers (Difusión del Capitán +
Especial del Día VIP push, 2026-10-30).

The OS computes the audience and the segments (it owns the opt-outs,
the 24h windows and the monthly ceiling); this module only delivers:

  window_phones   -> free-form text (open 24h service window, no
                     Meta per-message cost)
  template_phones -> the approved marketing template named in the
                     payload. If no template name arrives, those
                     recipients are SKIPPED and counted as
                     skipped_template — nothing silently degrades
                     into a free-form send outside a window.

Authenticated with the shared WHATSAPP_SIGNUP_SECRET as a Bearer
token, constant-time, fail-closed — identical to notify.py. Per-
recipient failures are counted, never raised: a broadcast reports
{sent_window, sent_template, failed, skipped_template}.
"""

import hmac
import os
import re
import time

MAX_RECIPIENTS = 2000
PACE_SECONDS = 0.05  # ~20 msgs/sec, well under Meta's pair-rate limits


def _secret() -> str:
    return os.environ.get("WHATSAPP_SIGNUP_SECRET", "").strip()


def authorized(auth_header: str) -> bool:
    """Constant-time Bearer check. Fail-closed: no secret configured
    on the bot -> nobody is authorized."""
    secret = _secret()
    if not secret:
        return False
    token = ""
    if auth_header and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    return bool(token) and hmac.compare_digest(token, secret)


def _clean_phones(raw) -> list:
    out = []
    seen = set()
    for value in raw or []:
        phone = re.sub(r"\D", "", str(value or ""))
        if len(phone) >= 8 and phone not in seen:
            seen.add(phone)
            out.append(phone)
    return out[:MAX_RECIPIENTS]


def process(payload, auth_header: str, send_text_fn, send_template_fn):
    """Deliver one broadcast job. Returns (http_status, dict);
    raises nothing."""
    if not authorized(auth_header):
        return 403, {"ok": False, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "bad payload"}
    message = str(payload.get("message") or "").strip()
    window_phones = _clean_phones(payload.get("window_phones"))
    template_phones = _clean_phones(payload.get("template_phones"))
    template_name = str(payload.get("template_name") or "").strip()
    if window_phones and not message:
        return 400, {"ok": False, "error": "missing message"}
    if not window_phones and not template_phones:
        return 400, {"ok": False, "error": "no recipients"}

    sent_window = 0
    sent_template = 0
    failed = 0
    skipped_template = 0

    for phone in window_phones:
        try:
            send_text_fn(phone, message)
            sent_window += 1
        except Exception:
            failed += 1
        time.sleep(PACE_SECONDS)

    if template_phones and not template_name:
        skipped_template = len(template_phones)
    else:
        for phone in template_phones:
            try:
                send_template_fn(phone, template_name)
                sent_template += 1
            except Exception:
                failed += 1
            time.sleep(PACE_SECONDS)

    return 200, {
        "ok": True,
        "sent_window": sent_window,
        "sent_template": sent_template,
        "failed": failed,
        "skipped_template": skipped_template,
    }
