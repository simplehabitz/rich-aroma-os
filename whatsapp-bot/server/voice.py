"""
Voice notes for the WhatsApp bot (voice build, 2026-10-26).

VOICE-IN — a customer's voice note arrives at the webhook as an
audio message carrying a media id. transcribe_media() downloads
the bytes through the Graph API (same token resolution as
webhook._deliver_message: the Secure Vault surrogate when present,
else the WHATSAPP_API_TOKEN env var), transcribes them with Gemini
and returns the transcript; the webhook then runs it through the
existing engines EXACTLY as if it had been typed. Every failure —
download, Gemini, empty/garbled transcript — returns None and the
webhook replies ONCE with RETRY_TEXT and takes no other action. A
transcript is never invented.

VOICE-OUT — the mirror rule. Only a voice-originated turn whose
reply is a PLAIN TEXT string may be spoken, and only when
speakable() passes: no URLs, no bank details, <= 400 chars; any
doubt stays text. Interactive replies never reach this module —
the webhook speaks strings only. The voice is the owner's pick
from the audition: Algenib on gemini-2.5-flash-preview-tts, with
the audition's exact mood directions chosen by Tegucigalpa time:
before 09:00 despertando, 09:00 -> close mediodia, after close
fiesta (close: Mon-Sat 19:00, Sun 18:00 — the shop's listing
hours, same constants the prep-time slots use). Path: Gemini PCM
(L16, 24 kHz, mono) -> ffmpeg -> OGG/Opus -> Graph media upload ->
the webhook sends it as an audio message with voice:true. ANY
failure raises to the webhook, which sends the text instead — a
reply is never lost to a voice failure. Every gate logs a
[Voice] line: silent gates are how the notify bug hid for a day.

Gemini access mirrors the tree's existing pattern
(hybrid_parse.py): plain urllib + the GEMINI_API_KEY env var in
the x-goog-api-key header. If that env var is missing on the
host, both directions fail safe (retry line in, text out) and the
logs say why — see voice-note.md for the owner's env step.

ffmpeg resolution (_resolve_ffmpeg): PATH first, then the
imageio-ffmpeg package's bundled binary — Render's native Python
ships no ffmpeg at all (live log, 2026-10-26: "ffmpeg NOT FOUND
on this host"), so the package in requirements.txt is how the
deployed bot converts. Absent both: the loud NOT FOUND log and
the text fallback, exactly as before.

/order-notify does NOT come through here: ready/cancelled
notifications stay text in v1, exactly as before.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

GRAPH_HOST = "graph.facebook.com"   # mirrors webhook.py
GRAPH_VERSION = "v21.0"             # mirrors webhook.py

TRANSCRIBE_MODEL = "gemini-2.5-flash-lite"
TTS_MODEL = "gemini-2.5-flash-preview-tts"
TTS_VOICE = "Algenib"               # owner-picked at the audition

RETRY_TEXT = "No te escuché bien 😅 ¿Me lo repetís o me lo escribís?"

MAX_SPOKEN_CHARS = 400
MAX_AUDIO_BYTES = 20 * 1024 * 1024  # a voice note is seconds long;
# anything near this is not one — refuse it before base64 inflation

# Mood directions — the EXACT phrasings from the voice audition
# (voice-audition/make_audition.py), so what the owner approved by
# ear is what ships.
MOODS = {
    "despertando": ("Say it warm and a little sleepy, unhurried, "
                    "like you just woke up and are opening the shop: "),
    "mediodia": ("Say it bright, upbeat and quick, full midday "
                 "energy, ready for anything: "),
    "fiesta": ("Say it playful and cheeky, festive after-hours "
               "energy, like you are out on the town having fun: "),
}

TRANSCRIBE_INSTRUCTION = (
    "Transcribe this audio exactly, word for word, in the "
    "language the speaker is using. Output ONLY the transcription "
    "itself — no translation, no commentary, no quotation marks, "
    "no speaker labels.")

# Vault transport (same guard as webhook.py): on the deployed
# host there is no vault, and the env token rules. Both helper
# names are DEFINED on the no-vault path too — the surrogate as
# None (never called: every use is HAS_VAULT-gated, and a request
# here already carries its env-token credentials) and the JSON
# reader as a plain body parse — so no vault helper can raise
# NameError where the import didn't provide it.
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
try:
    from dynamic_credentials import (add_surrogate_to_request,
                                     read_json_response)
    HAS_VAULT = True
except ImportError:
    HAS_VAULT = False
    add_surrogate_to_request = None

    def read_json_response(resp):
        return json.loads(resp.read().decode("utf-8") or "{}")

_synth_cache = {}   # sha256(mood + text) -> ogg bytes, per process


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify endpoint")


def _authorize(req):
    """Attach the bot's WhatsApp token to a Graph request —
    webhook._deliver_message's resolution order, verbatim."""
    if HAS_VAULT:
        add_surrogate_to_request(
            req, "custom.whatsapp-business", allowed_hosts=[GRAPH_HOST])
    else:
        token = os.environ.get("WHATSAPP_API_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "No WhatsApp API token: set WHATSAPP_API_TOKEN env var")
        req.add_header("Authorization", f"Bearer {token}")


def _read_json(resp):
    # read_json_response is always defined: the vault's helper
    # when imported, the module-level plain-JSON fallback above
    # when it wasn't (the deployed host).
    return read_json_response(resp)


def _gemini_call(model: str, body: dict) -> dict:
    """One Gemini generateContent call, hybrid_parse.py's shape."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY not configured on this host")
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


# ------------------------------------------------------------- voice-in

def fetch_media(media_id: str):
    """Download one WhatsApp media object. Returns (bytes, mime).

    Two authed GETs: the media object (for its URL + mime), then
    the binary itself. The binary URL is a signed lookaside URL —
    it is fetched with the default opener (no redirect refusal):
    Meta may hand back a CDN redirect and the signature, not the
    bearer header, is what authorizes that hop.
    """
    req = urllib.request.Request(
        f"https://{GRAPH_HOST}/{GRAPH_VERSION}/{media_id}",
        method="GET")
    _authorize(req)
    with urllib.request.build_opener(_NoRedirect()).open(
            req, timeout=30) as resp:
        meta = _read_json(resp)
    url = (meta or {}).get("url")
    mime = ((meta or {}).get("mime_type") or "audio/ogg")
    mime = mime.split(";")[0].strip() or "audio/ogg"
    if not url:
        raise RuntimeError(f"media {media_id}: Graph returned no URL")
    req2 = urllib.request.Request(url, method="GET")
    _authorize(req2)
    with urllib.request.urlopen(req2, timeout=60) as resp:
        data = resp.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise RuntimeError(
            f"media {media_id}: {len(data)} bytes — not a voice note")
    return data, mime


def transcribe(audio_bytes: bytes, mime_type: str):
    """Gemini transcription. Returns the transcript, or None when
    the audio produced nothing usable (empty / garbled) — the
    caller then asks for a repeat instead of guessing."""
    if not audio_bytes:
        print("[Voice] transcribe: empty audio — no transcript",
              flush=True)
        return None
    body = {
        "contents": [{"role": "user", "parts": [
            {"text": TRANSCRIBE_INSTRUCTION},
            {"inlineData": {
                "mimeType": mime_type,
                "data": base64.b64encode(audio_bytes).decode()}},
        ]}],
        "generationConfig": {"temperature": 0},
    }
    try:
        data = _gemini_call(TRANSCRIBE_MODEL, body)
    except Exception as e:
        print(f"[Voice] transcribe: Gemini call failed: {e}",
              flush=True)
        return None
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as e:
        print(f"[Voice] transcribe: unusable Gemini response ({e})",
              flush=True)
        return None
    text = (text or "").strip()
    if len(text) < 2 or not any(ch.isalnum() for ch in text):
        print(f"[Voice] transcribe: garbled/empty transcript "
              f"({text[:40]!r}) — no transcript", flush=True)
        return None
    return text


def transcribe_media(media_id: str):
    """media id -> transcript | None. Never raises: None is the
    webhook's cue to send the retry line once and stop."""
    try:
        audio, mime = fetch_media(media_id)
    except Exception as e:
        print(f"[Voice] media download failed ({media_id}): {e}",
              flush=True)
        return None
    print(f"[Voice] media {media_id} downloaded "
          f"({len(audio)} bytes, {mime})", flush=True)
    text = transcribe(audio, mime)
    if text:
        print(f"[Voice] transcript ok ({len(text)} chars) — "
              f"entering the engines as typed text", flush=True)
    return text


# ------------------------------------------------------------ voice-out

def _now_tegucigalpa():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Tegucigalpa"))
    except Exception:
        # Honduras is UTC-6 year-round (no DST) — a fixed offset
        # is exact when the tz database is unavailable.
        return datetime.now(timezone(timedelta(hours=-6)))


def mood_for(now) -> str:
    """Mood by shop time: before 09:00 despertando; 09:00 -> close
    mediodia; after close fiesta. Close: Mon-Sat 19:00, Sun 18:00."""
    close_hour = 18 if now.weekday() == 6 else 19
    if now.hour < 9:
        return "despertando"
    if now.hour < close_hour:
        return "mediodia"
    return "fiesta"


_URL_MARKERS = ("http://", "https://", "wa.me")
_BANK_MARKERS = ("banco:", "cuenta:", "titular:", "a nombre de",
                 "\U0001F4B3")  # 💳 — heads the accounts block
_ACCOUNT_NUMBER = re.compile(r"cuenta\s+\d{5,}", re.IGNORECASE)


def speakable(text):
    """May this reply be spoken? (True, '') or (False, reason).
    Hard exclusions, doubt -> text: URLs (incl. the account link
    and wa.me buttons), bank-detail content, > MAX_SPOKEN_CHARS."""
    if not isinstance(text, str) or not text.strip():
        return False, "not a plain text reply"
    if len(text) > MAX_SPOKEN_CHARS:
        return False, f"{len(text)} chars > {MAX_SPOKEN_CHARS}"
    low = text.lower()
    if any(m in low for m in _URL_MARKERS):
        return False, "contains a URL"
    if any(m in low for m in _BANK_MARKERS) \
            or _ACCOUNT_NUMBER.search(text):
        return False, "bank details"
    return True, ""


_ffmpeg = False   # False = unresolved; None = looked, not found


def _resolve_ffmpeg():
    """Locate an ffmpeg binary, once per process. Order: PATH
    (shutil.which), then the imageio-ffmpeg package's bundled
    binary (requirements.txt — Render's native Python ships no
    ffmpeg, so the package is the deployed bot's converter). The
    resolved path — or the NOT FOUND line — is logged at first
    use, so the Render log names the converter in play."""
    global _ffmpeg
    if _ffmpeg is not False:
        return _ffmpeg
    path = shutil.which("ffmpeg")
    if not path:
        try:
            import imageio_ffmpeg
            path = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            path = None
    if path:
        print(f"[Voice] ffmpeg: {path}", flush=True)
    else:
        print("[Voice] ffmpeg NOT FOUND on this host — voice "
              "replies fall back to text", flush=True)
    _ffmpeg = path
    return path


def _pcm_to_ogg(pcm: bytes) -> bytes:
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg missing")
    with tempfile.TemporaryDirectory(prefix="voice-") as td:
        src = os.path.join(td, "in.pcm")
        dst = os.path.join(td, "out.ogg")
        with open(src, "wb") as f:
            f.write(pcm)
        subprocess.run(
            [ffmpeg, "-y", "-f", "s16le", "-ar", "24000", "-ac", "1",
             "-i", src, "-c:a", "libopus", "-b:a", "32k", dst],
            check=True, capture_output=True, timeout=60)
        with open(dst, "rb") as f:
            return f.read()


def synthesize_ogg(text: str, mood: str = None) -> bytes:
    """Text -> OGG/Opus bytes in Capitán Rico's voice. Cached per
    process by (mood, text): fixed lines are synthesized once.
    Raises on ANY failure — the webhook falls back to text."""
    mood = mood or mood_for(_now_tegucigalpa())
    key = hashlib.sha256(
        (mood + "\x00" + text).encode("utf-8")).hexdigest()
    if key in _synth_cache:
        print(f"[Voice] synth cache hit (mood={mood})", flush=True)
        return _synth_cache[key]
    body = {
        "contents": [{"role": "user",
                      "parts": [{"text": MOODS[mood] + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {
                "prebuiltVoiceConfig": {"voiceName": TTS_VOICE}}},
        },
    }
    data = _gemini_call(TTS_MODEL, body)
    part = data["candidates"][0]["content"]["parts"][0]
    pcm = base64.b64decode(part["inlineData"]["data"])
    ogg = _pcm_to_ogg(pcm)
    if len(_synth_cache) >= 128:
        _synth_cache.clear()
    _synth_cache[key] = ogg
    print(f"[Voice] synthesized {len(text)} chars "
          f"(mood={mood}, {len(ogg)} bytes ogg)", flush=True)
    return ogg


def upload_media(phone_number_id: str, ogg: bytes) -> str:
    """Upload OGG bytes to the Graph media endpoint; returns the
    media id. Multipart, same token resolution as every send."""
    boundary = "voice" + uuid.uuid4().hex
    crlf = b"\r\n"
    body = b""
    for name, value in (("messaging_product", "whatsapp"),
                        ("type", "audio/ogg")):
        body += (f"--{boundary}".encode() + crlf
                 + f'Content-Disposition: form-data; '
                   f'name="{name}"'.encode() + crlf + crlf
                 + value.encode() + crlf)
    body += (f"--{boundary}".encode() + crlf
             + b'Content-Disposition: form-data; name="file"; '
               b'filename="voice.ogg"' + crlf
             + b"Content-Type: audio/ogg" + crlf + crlf
             + ogg + crlf
             + f"--{boundary}--".encode() + crlf)
    req = urllib.request.Request(
        f"https://{GRAPH_HOST}/{GRAPH_VERSION}/"
        f"{phone_number_id}/media",
        data=body, method="POST",
        headers={"Content-Type":
                 f"multipart/form-data; boundary={boundary}"})
    _authorize(req)
    with urllib.request.build_opener(_NoRedirect()).open(
            req, timeout=60) as resp:
        data = _read_json(resp)
    media_id = (data or {}).get("id")
    if not media_id:
        raise RuntimeError(f"media upload returned no id: {data}")
    return media_id


def speak(phone_number_id: str, text: str) -> str:
    """Text -> uploaded voice note; returns the media id for the
    webhook's audio send. Raises on any failure (text fallback)."""
    ogg = synthesize_ogg(text)
    media_id = upload_media(phone_number_id, ogg)
    print(f"[Voice] voice note uploaded (media {media_id})",
          flush=True)
    return media_id
