"""OBA reasoning engine.

Three interchangeable providers behind one interface:

  * MockPlanner      — deterministic, offline, zero-dependency. Plans a full
                       task from the sanitized DOM context and serves one
                       validated action per step. Default provider.
  * OllamaPlanner    — local open-weights VLM/LLM via Ollama
                       (e.g. qwen2.5vl, llama3.2-vision, llava).
  * OpenAIPlanner    — any OpenAI-compatible cloud endpoint
                       (OpenAI, Gemini OpenAI-compat, vLLM serving, ...).

All providers receive the SAME redaction-scheme-aware system prompt: the
model is told that tokens like [USER_PASSWORD_1] must be echoed back as
`type` values and never resolved, because the client holds the secrets.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Dict, List, Optional

import httpx

from models.schemas import AgentAction, DOMElement, SanitizedPayload

SYSTEM_PROMPT = """You are the reasoning module of a privacy-preserving browser agent.

The client sends you: (1) a REDACTED screenshot in which sensitive regions
are irreversibly blacked out (text PII) or pixel-destroyed/blur-smoothed
(faces, photos), and (2) a DOM summary in which sensitive field values are
replaced by opaque tokens such as [USER_PASSWORD_1], [USER_EMAIL_1],
[CARD_NUMBER_1], [USER_OTP_1].

Operating rules:
- The redaction is intentional and permanent. Never ask for, guess, or try
  to reconstruct the raw values behind redactions or tokens.
- To fill a sensitive field, return a "type" action whose value is the
  TOKEN string itself (e.g. "[USER_PASSWORD_1]"). The client resolves the
  token locally on the user's machine; the secret never travels.
- Only interact with elements that appear in the DOM summary. Use the
  exact `selector` strings provided.
- Choose ONE action per step. Prefer completing visible form fields in
  visual order, then activate the primary submit button.
- When the task is complete or cannot proceed, return "finish".

Respond with STRICT JSON only — no prose, no markdown fences:
{"action":"click|type|scroll|finish","selector":"","value":"","direction":"down","distance":600,"reasoning":"","confidence":0.85}"""

# --------------------------------------------------------------------------- #
# shared helpers
# --------------------------------------------------------------------------- #

SENSITIVE_FIELD_RX = [
    (re.compile(r"passwo?r?d|passwd|pwd|passphrase", re.I), "password"),
    (re.compile(r"\botp\b|one[\s-]?time[\s-]?(code|password)|verification\s+code|passcode", re.I), "otp"),
    (re.compile(r"\bcvv\b|\bcvc\b|\bcsc\b|security\s*code", re.I), "cvv"),
    (re.compile(r"\bssn\b|social\s*security", re.I), "ssn"),
    (re.compile(r"account\s*(no|number|#)?|bank\s*account|\bacc(t|\.|\s*no|\s*num|\s*#)?\b", re.I), "account_number"),
    (re.compile(r"aadhaa?r|uidai|\bpan\b|passport|driver'?s?\s*licen[cs]e", re.I), "national_id"),
    (re.compile(r"date\s*of\s*birth|\bdob\b|born\s*on", re.I), "dob"),
]
EMAIL_RX = re.compile(r"e[\s-]?mail", re.I)
PHONE_RX = re.compile(r"phone|mobile|contact|whatsapp", re.I)
NAME_RX = re.compile(r"full\s*name|^name\b|first\s*name|last\s*name|surname", re.I)
ADDR_RX = re.compile(r"address|street|locality|postal|\bzip\b|city|town|\bstate\b", re.I)
CITY_RX = re.compile(r"city|town", re.I)
ZIP_RX = re.compile(r"\bzip\b|postal\s*code|pin\s*code", re.I)
STATE_RX = re.compile(r"\bstate\b|province", re.I)
COUNTRY_RX = re.compile(r"country|nation", re.I)
CAPTCHA_RX = re.compile(r"captcha|security\s*check", re.I)
IDTYPE_RX = re.compile(r"id\s*type|document\s*type|id\s*document", re.I)
CC_AC_RX = re.compile(r"^cc-(number|csc|exp|exp-month|exp-year)$", re.I)
SUBMIT_RX = re.compile(
    r"submit|sign\s*in|log\s*in|continue|verify|pay|place\s*order|complete|register|next|confirm", re.I)

TEXTUAL_TYPES = {"", "text", "search", "email", "tel", "url", "number", "password", "date"}


def _ctx(el: DOMElement) -> str:
    return " ".join(
        x for x in [
            el.id, el.name, (el.label or ""), (el.placeholder or ""),
            (el.ariaLabel or ""), (el.autocomplete or ""), (el.role or ""),
            el.selector, (el.text or ""), (el.imgHints or ""),
        ] if x
    )


def field_kind(el: DOMElement) -> Optional[str]:
    """Server-side classification of a sanitized DOM element (mirrors the
    client rules — this is the 'server understands the redaction scheme' bit:
    it infers semantics from type/autocomplete/label even when the value is
    an opaque token)."""
    t = (el.type or "").lower()
    ac = (el.autocomplete or "").lower()
    ctx = _ctx(el)

    if el.tag in ("input", "textarea"):
        if t == "password":
            return "password"
        if t == "email" or ac == "email":
            return "email"
        if t == "tel" or ac in ("tel", "mobile"):
            return "phone"
    if CC_AC_RX.match(ac):
        return {"cc-number": "credit_card", "cc-csc": "cvv",
                "cc-exp": "expiry", "cc-exp-month": "expiry",
                "cc-exp-year": "expiry"}.get(ac, "credit_card")
    if ac == "one-time-code":
        return "otp"
    for rx, kind in SENSITIVE_FIELD_RX:
        if rx.search(ctx):
            return kind
    if EMAIL_RX.search(ctx):
        return "email"
    if PHONE_RX.search(ctx):
        return "phone"
    if NAME_RX.search(ctx) and el.tag in ("input", "textarea"):
        return "name"
    if ADDR_RX.search(ctx):
        return "address"
    return None


def value_for(el: DOMElement, kind: Optional[str]) -> str:
    """The value the server commands. Sensitive kinds -> TOKENS (resolved
    locally by the client vault); neutral demo content -> plain literals."""
    ctx = _ctx(el)
    if CAPTCHA_RX.search(ctx):
        return "A7X3"          # demo captcha shown in the sanitized image
    if COUNTRY_RX.search(ctx):
        return "India"
    if IDTYPE_RX.search(ctx):
        return "Aadhaar"
    if kind == "address":
        if CITY_RX.search(ctx):
            return "Mumbai"
        if ZIP_RX.search(ctx):
            return "400001"
        if STATE_RX.search(ctx):
            return "Maharashtra"
        return "[ADDRESS_1]"
    table = {
        "password": "[USER_PASSWORD_1]", "email": "[USER_EMAIL_1]",
        "phone": "[USER_PHONE_1]", "credit_card": "[CARD_NUMBER_1]",
        "account_number": "[ACCOUNT_NUMBER_1]",
        "cvv": "[CVV_1]", "expiry": "[EXPIRY_1]", "otp": "[USER_OTP_1]",
        "ssn": "[NATIONAL_ID_1]", "national_id": "[NATIONAL_ID_1]",
        "dob": "[DOB_1]", "name": "[USER_NAME_1]",
    }
    if kind in table:
        return table[kind]
    return "demo_value"


def is_textual_input(el: DOMElement) -> bool:
    if el.tag == "textarea":
        return True
    if el.tag != "input":
        return False
    return (el.type or "").lower() in TEXTUAL_TYPES


def find_submit(els: List[DOMElement]) -> Optional[DOMElement]:
    cands = [
        e for e in els
        if e.visible and (
            e.tag == "button"
            or (e.tag == "input" and (e.type or "").lower() in ("submit", "button"))
            or (e.role or "") == "button"
        )
    ]
    for e in cands:
        if SUBMIT_RX.search(e.text or "") or SUBMIT_RX.search(e.type or "") or SUBMIT_RX.search(e.label or ""):
            return e
    return cands[-1] if cands else None


def dom_summary(payload: SanitizedPayload, limit: int = 60) -> str:
    """Compact textual rendering of the sanitized DOM for prompts."""
    lines = []
    for e in payload.dom_elements[:limit]:
        bits = [f"{e.tag}", e.selector]
        if e.type:
            bits.append(f"type={e.type}")
        if e.label:
            bits.append(f"label={e.label[:40]}")
        if e.autocomplete:
            bits.append(f"ac={e.autocomplete}")
        if e.value:
            bits.append(f"value={str(e.value)[:24]}")
        if e.rect:
            bits.append(f"at=({int(e.rect.x)},{int(e.rect.y)})")
        lines.append("  " + " ".join(bits))
    return "\n".join(lines) if lines else "  (no interactive elements)"


def extract_action_json(text: str) -> AgentAction:
    """Robust JSON extraction from an LLM response."""
    if not text:
        raise ValueError("empty model response")
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError(f"model response contained no JSON: {text[:120]!r}")
        obj = json.loads(text[start:end + 1])
    if not isinstance(obj, dict):
        raise ValueError("model response JSON is not an object")
    obj.setdefault("action", "finish")
    if obj.get("action") not in ("click", "type", "scroll", "finish"):
        obj["action"] = "finish"
    if obj.get("action") == "type" and obj.get("value") is None:
        obj["value"] = ""
    if not obj.get("selector"):
        obj["selector"] = ""
    return AgentAction(**obj)


# --------------------------------------------------------------------------- #
# MockPlanner — deterministic offline reasoner
# --------------------------------------------------------------------------- #

class MockPlanner:
    name = "mock"
    model = "deterministic-dom-planner"

    SESSION_TTL_S = 1800

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, dict] = {}

    def _gc(self) -> None:
        now = time.time()
        stale = [k for k, v in self._sessions.items() if now - v["ts"] > self.SESSION_TTL_S]
        for k in stale:
            self._sessions.pop(k, None)

    def _build_plan(self, payload: SanitizedPayload) -> List[AgentAction]:
        els = [e for e in payload.dom_elements if e.visible]
        inputs = [e for e in els if is_textual_input(e) and field_kind(e) is not None
                  or (is_textual_input(e) and _ctx(e) and CAPTCHA_RX.search(_ctx(e)))]
        # unique by selector, visual order
        seen, ordered = set(), []
        for e in sorted(inputs, key=lambda e: (e.rect.y if e.rect else 0, e.rect.x if e.rect else 0)):
            if e.selector in seen:
                continue
            seen.add(e.selector)
            ordered.append(e)

        plan: List[AgentAction] = []
        vh = payload.viewport.height or 800
        below_fold = any(
            e.rect and (e.rect.y + e.rect.height) > vh * 0.85 for e in ordered
        ) or (lambda s: s and (s.rect.y + s.rect.height) > vh * 0.85)(find_submit(els))
        if below_fold:
            plan.append(AgentAction(action="scroll", direction="down", distance=int(vh * 0.6),
                                    reasoning="Target fields are below the fold; scrolling first.",
                                    confidence=0.9))

        for e in ordered:
            kind = field_kind(e)
            plan.append(AgentAction(
                action="type", selector=e.selector, value=value_for(e, kind),
                reasoning=(f"Filling {kind or 'field'} '{(e.label or e.selector)[:32]}' "
                           + ("(token resolved client-side)." if (value_for(e, kind) or "").startswith("[") else ".")),
                confidence=0.92,
            ))

        submit = find_submit(els)
        if submit is not None:
            plan.append(AgentAction(
                action="click", selector=submit.selector,
                reasoning=f"Activating primary control '{(submit.text or submit.label or submit.selector)[:32]}'.",
                confidence=0.9,
            ))

        plan.append(AgentAction(
            action="finish",
            reasoning=f"Task '{payload.task[:60]}' plan executed "
                      f"({len(ordered)} fields, submit={'yes' if submit else 'no'}).",
            confidence=0.95,
        ))
        return plan

    def step(self, payload: SanitizedPayload) -> AgentAction:
        with self._lock:
            self._gc()
            sess = self._sessions.get(payload.session_id)
            if sess is None or payload.step_index == 0:
                sess = {"plan": self._build_plan(payload), "cursor": 0, "ts": time.time()}
                self._sessions[payload.session_id] = sess
            sess["ts"] = time.time()

            if sess["cursor"] < len(sess["plan"]):
                action = sess["plan"][sess["cursor"]]
                sess["cursor"] += 1
                return action

            # plan exhausted: is there still unfinished work on the page?
            empty_fields = [
                e for e in payload.dom_elements
                if e.visible and is_textual_input(e) and not (e.value or "").strip()
            ]
            if empty_fields and payload.step_index > 0:
                sess["plan"] = self._build_plan(payload)
                sess["cursor"] = 0
                action = sess["plan"][0]
                sess["cursor"] = 1
                return action

            return AgentAction(
                action="finish",
                reasoning="No remaining actionable fields; page state indicates completion.",
                confidence=0.9,
            )


# --------------------------------------------------------------------------- #
# OllamaPlanner — local open-weights (Qwen2-VL / LLaVA / llama3.2-vision)
# --------------------------------------------------------------------------- #

class OllamaPlanner:
    name = "ollama"

    def __init__(self, base_url: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = httpx.Client(timeout=120.0)

    def _user_prompt(self, payload: SanitizedPayload) -> str:
        return (
            f"TASK: {payload.task}\n"
            f"URL: {payload.url or '(unknown)'}\n"
            f"STEP: {payload.step_index}\n"
            f"VIEWPORT: {int(payload.viewport.width)}x{int(payload.viewport.height)}\n"
            f"DOM SUMMARY (sanitized, values are tokens):\n{dom_summary(payload)}\n\n"
            f"Decide the single next action. Respond with the JSON object only."
        )

    def step(self, payload: SanitizedPayload) -> AgentAction:
        body: dict = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": self._user_prompt(payload)},
            ],
            "options": {"temperature": 0.1},
        }
        if payload.has_screenshot:
            body["images"] = [payload.screenshot_base64]
        r = self._client.post(f"{self.base_url}/api/chat", json=body)
        r.raise_for_status()
        content = r.json().get("message", {}).get("content", "")
        return extract_action_json(content)

    @property
    def model_id(self) -> str:
        return self.model


# --------------------------------------------------------------------------- #
# OpenAIPlanner — any OpenAI-compatible endpoint (cloud or vLLM)
# --------------------------------------------------------------------------- #

class OpenAIPlanner:
    name = "openai-compatible"

    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        if not self.base_url.endswith("/v1"):
            self.base_url += "/v1"
        self.model = model
        self._client = httpx.Client(
            timeout=120.0,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
        )

    def step(self, payload: SanitizedPayload) -> AgentAction:
        parts = [{"type": "text", "text": self._user_prompt(payload)}]
        if payload.has_screenshot:
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{payload.screenshot_base64}"},
            })
        body = {
            "model": self.model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": parts},
            ],
        }
        r = self._client.post(f"{self.base_url}/chat/completions", json=body)
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        return extract_action_json(content)

    def _user_prompt(self, payload: SanitizedPayload) -> str:
        return (
            f"TASK: {payload.task}\nURL: {payload.url or '(unknown)'}\n"
            f"STEP: {payload.step_index}\nVIEWPORT: "
            f"{int(payload.viewport.width)}x{int(payload.viewport.height)}\n"
            f"DOM SUMMARY (sanitized, values are tokens):\n{dom_summary(payload)}\n\n"
            f"Decide the single next action. Respond with the JSON object only."
        )

    @property
    def model_id(self) -> str:
        return self.model


# --------------------------------------------------------------------------- #
# factory
# --------------------------------------------------------------------------- #

def create_planner():
    provider = os.environ.get("OBA_PROVIDER", "mock").strip().lower()
    if provider == "ollama":
        base = os.environ.get("OBA_OLLAMA_URL", "http://127.0.0.1:11434")
        model = os.environ.get("OBA_MODEL", "qwen2.5vl:7b")
        return OllamaPlanner(base, model)
    if provider in ("openai", "openai-compatible", "cloud"):
        base = os.environ.get("OBA_API_BASE", "https://api.openai.com")
        model = os.environ.get("OBA_MODEL", "gpt-4o-mini")
        key = os.environ.get("OBA_API_KEY", "")
        return OpenAIPlanner(base, model, key)
    return MockPlanner()


def planner_identity(planner) -> dict:
    return {
        "provider": getattr(planner, "name", "unknown"),
        "model": getattr(planner, "model_id", None) or getattr(planner, "model", "unknown"),
    }
