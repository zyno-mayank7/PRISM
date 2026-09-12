"""OBA Central Reasoning Server (FastAPI).

Endpoints
  GET  /health                — service + active model metadata
  POST /api/agent/step        — sanitized screenshot + tokenized DOM in,
                                validated JSON action out
  POST /api/verify-redaction  — judge endpoint: re-scans an outbound payload
                                for privacy compliance (PII regexes, Luhn
                                cards, token discipline, screenshot stats)

Run:
    cd server
    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8000

Providers (env):
    OBA_PROVIDER = mock | ollama | openai       (default: mock)
    OBA_MODEL    = qwen2.5vl:7b | gpt-4o-mini | ...
    OBA_OLLAMA_URL = http://127.0.0.1:11434
    OBA_API_BASE / OBA_API_KEY  (for the openai-compatible provider)
"""
from __future__ import annotations

from pathlib import Path
import base64
import io
import re
import sys
import time
from contextlib import asynccontextmanager

# Automatically add server directory and root directory to sys.path
SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent
for _d in (str(SERVER_DIR), str(ROOT_DIR)):
    if _d not in sys.path:
        sys.path.insert(0, _d)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agent.planner import create_planner, planner_identity
from models.schemas import (
    AgentAction,
    SanitizedPayload,
    VerifyRedactionResponse,
    Violation,
)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    p = get_planner()
    ident = planner_identity(p)
    print(f"[OBA] reasoning server ready — provider={ident['provider']} model={ident['model']}")
    yield


app = FastAPI(title="OBA Reasoning Server", version="1.0.0",
              description="Privacy-preserving browser agent reasoning backend.",
              lifespan=_lifespan)

# The extension calls from chrome-extension:// origins; allow all origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_START = time.time()
_PLANNER = None

# ------------------------------------------------------------------ #
# PII scanning utilities (mirror of the client's leak assertion — the
# judge endpoint re-verifies what the client claims)
# ------------------------------------------------------------------ #

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"(?:\+91[ -]?)?\b[6-9]\d{9}\b|\b\d{3}[ -]\d{3}[ -]\d{4}\b")
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
AADHAAR_RE = re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")
DOB_RE = re.compile(r"\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
TOKEN_RE = re.compile(r"^\[[A-Z_]+_\d+\]$")


def _luhn_ok(s: str) -> bool:
    s = re.sub(r"[ -]", "", s)
    if not s.isdigit() or not (12 <= len(s) <= 19):
        return False
    total, alt = 0, False
    for ch in reversed(s):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def scan_payload_for_pii(payload: SanitizedPayload) -> list[Violation]:
    violations: list[Violation] = []

    def scan(text: str, where: str):
        if not text:
            return
        for m in EMAIL_RE.finditer(text):
            violations.append(Violation(reason="Raw email in payload", where=where,
                                        pii_type="email", hint=m.group(0)[:3] + "***"))
        for m in PHONE_RE.finditer(text):
            violations.append(Violation(reason="Raw phone number in payload", where=where,
                                        pii_type="phone", hint=m.group(0)[:3] + "***"))
        for m in SSN_RE.finditer(text):
            violations.append(Violation(reason="Raw SSN in payload", where=where,
                                        pii_type="ssn", hint="***"))
        for m in AADHAAR_RE.finditer(text):
            violations.append(Violation(reason="Raw national ID pattern in payload", where=where,
                                        pii_type="national_id", hint=m.group(0)[:2] + "***"))
        for m in DOB_RE.finditer(text):
            violations.append(Violation(reason="Raw date-of-birth in payload", where=where,
                                        pii_type="dob", hint="***"))
        for m in CARD_RE.finditer(text):
            if _luhn_ok(m.group(0)):
                violations.append(Violation(reason="Luhn-valid card number in payload", where=where,
                                            pii_type="credit_card", hint=m.group(0)[:4] + "****"))

    for e in payload.dom_elements:
        where = f"dom_elements[{e.selector or e.tag}].value"
        if e.value is not None and not TOKEN_RE.match(e.value):
            if (e.type or "").lower() == "password":
                violations.append(Violation(
                    reason="Password field carries a non-token value",
                    where=where, pii_type="password", hint=e.value[:2] + "***"))
            scan(e.value, where)
        scan(e.text, f"dom_elements[{e.selector or e.tag}].text")
    scan(payload.task, "task")

    return violations


def screenshot_stats(payload: SanitizedPayload) -> dict:
    stats: dict = {"present": payload.has_screenshot,
                   "kb": round(len(payload.screenshot_base64) / 1024, 1)}
    if not payload.has_screenshot:
        return stats
    try:
        from PIL import Image  # optional dependency
        raw = base64.b64decode(payload.screenshot_base64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        small = img.resize((img.width // 8, img.height // 8))
        px = list(small.getdata())
        black = sum(1 for p in px if p[0] < 12 and p[1] < 12 and p[2] < 12)
        stats["black_pixel_ratio"] = round(black / max(1, len(px)), 4)
        stats["dimensions"] = f"{img.width}x{img.height}"
    except Exception as exc:  # noqa: BLE001 — stats are best-effort
        stats["image_analysis"] = f"unavailable ({type(exc).__name__})"
    return stats


# ------------------------------------------------------------------ #
# routes
# ------------------------------------------------------------------ #

def get_planner():
    global _PLANNER
    if _PLANNER is None:
        _PLANNER = create_planner()
    return _PLANNER


class VerifyRequest(BaseModel):
    payload: SanitizedPayload


@app.get("/health", tags=["service"])
def health() -> dict:
    p = get_planner()
    ident = planner_identity(p)
    return {
        "status": "ok",
        "provider": ident["provider"],
        "model": ident["model"],
        "version": app.version,
        "uptime_s": round(time.time() - _START, 1),
    }


LOG_DIR = Path(__file__).parent / "received_logs"
LOG_DIR.mkdir(exist_ok=True)


@app.post("/api/agent/step", response_model=AgentAction, tags=["agent"])
def agent_step(payload: SanitizedPayload) -> AgentAction:
    """One perception→reasoning cycle: sanitized context in, one action out."""
    p = get_planner()
    try:
        action = p.step(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502,
            detail=f"reasoning provider failed: {type(exc).__name__}: {exc}") from exc

    # Save received payload and screenshot to disk for inspection
    try:
        sess_id = re.sub(r"[^\w-]", "_", payload.session_id or "session")
        step_filename = f"{sess_id}_step_{payload.step_index}"
        
        # Save JSON payload
        json_path = LOG_DIR / f"{step_filename}.json"
        json_path.write_text(payload.model_dump_json(indent=2), encoding="utf-8")
        
        # Save sanitized JPEG screenshot if present
        img_info = "no"
        if payload.screenshot_base64:
            img_bytes = base64.b64decode(payload.screenshot_base64)
            img_path = LOG_DIR / f"{step_filename}.jpg"
            img_path.write_bytes(img_bytes)
            img_info = f"saved to {img_path.name} ({round(len(img_bytes)/1024, 1)} KB)"
            
        print(f"\n[OBA SERVER LOG] Incoming step from extension:")
        print(f"  Session    : {payload.session_id}")
        print(f"  Task       : {payload.task}")
        print(f"  URL        : {payload.url}")
        print(f"  DOM Elements: {len(payload.dom_elements)}")
        print(f"  Screenshot : {img_info}")
        print(f"  Saved JSON : {json_path}")
        print(f"  Action Out : {action.action} -> {action.selector}\n")
    except Exception as log_exc:
        print(f"[OBA] Log error: {log_exc}")

    return action


@app.post("/api/verify-redaction", response_model=VerifyRedactionResponse, tags=["privacy"])
def verify_redaction(req: VerifyRequest) -> VerifyRedactionResponse:
    """Judge endpoint: independently re-scans a payload the client is about
    to (or claims to have) transmitted, and reports compliance."""
    payload = req.payload
    violations = scan_payload_for_pii(payload)
    tokens = sum(1 for e in payload.dom_elements
                 if e.value is not None and TOKEN_RE.match(e.value))
    sensitiveish = sum(1 for e in payload.dom_elements
                       if (e.type or "").lower() == "password"
                       or (e.autocomplete or "").startswith("cc-")
                       or (e.autocomplete or "") == "one-time-code")
    stats = screenshot_stats(payload)
    stats.update({
        "dom_elements": len(payload.dom_elements),
        "sensitive_fields": sensitiveish,
        "tokenized_values": tokens,
    })

    checks = [
        "password fields carry tokens or are empty",
        "values scanned: email / phone / SSN / Aadhaar / DOB / Luhn cards",
        "button and label text scanned for embedded PII",
        "task text scanned for embedded PII",
        "screenshot base64 decoded and black-pixel ratio estimated",
    ]
    compliant = not violations
    verdict = ("COMPLIANT — no personally identifiable data found in the payload; "
               "sensitive values are tokenized.") if compliant else \
              ("NON-COMPLIANT — raw PII detected. The client-side leak assertion "
               "would have blocked transmission of this payload.")
    return VerifyRedactionResponse(
        compliant=compliant, verdict=verdict, violations=violations,
        checks_run=checks, stats=stats)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
