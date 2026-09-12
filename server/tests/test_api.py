"""API tests for the OBA reasoning server (mock provider, offline)."""
import copy

import pytest
from fastapi.testclient import TestClient

import main as main_mod
from agent.planner import MockPlanner


@pytest.fixture()
def client():
    main_mod._PLANNER = MockPlanner()  # force deterministic offline provider
    with TestClient(main_mod.app) as c:
        yield c
    main_mod._PLANNER = None


# ---- fixtures mirroring the benchmark demo pages (sanitized, tokenized) ---- #

LOGIN_ELEMENTS = [
    {"tag": "input", "type": "email", "selector": "#email", "label": "Email or username",
     "autocomplete": "email", "value": "[USER_EMAIL_1]", "visible": True,
     "rect": {"x": 364, "y": 150, "width": 552, "height": 30}},
    {"tag": "input", "type": "password", "selector": "#password", "label": "Password",
     "autocomplete": "current-password", "value": "[USER_PASSWORD_1]", "visible": True,
     "rect": {"x": 364, "y": 228, "width": 552, "height": 30}},
    {"tag": "input", "type": "text", "selector": "#otp", "label": "OTP code",
     "autocomplete": "one-time-code", "value": "[USER_OTP_1]", "visible": True,
     "rect": {"x": 364, "y": 306, "width": 552, "height": 30}},
    {"tag": "input", "type": "text", "selector": "#captcha", "label": "Captcha",
     "value": "", "visible": True, "rect": {"x": 364, "y": 384, "width": 552, "height": 30}},
    {"tag": "button", "selector": "#submit-btn", "text": "Sign in", "visible": True,
     "rect": {"x": 364, "y": 470, "width": 200, "height": 40}},
]


def login_payload(step=0, session="test-login", task="Sign in to the demo portal using the demo credentials."):
    return {
        "task": task,
        "screenshot_base64": "",
        "dom_elements": copy.deepcopy(LOGIN_ELEMENTS),
        "viewport": {"width": 1280, "height": 800},
        "url": "http://127.0.0.1:8080/demo-pages/login-form.html",
        "step_index": step,
        "session_id": session,
    }


# --------------------------------------------------------------------------- #

class TestService:
    def test_health(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["provider"] == "mock"
        assert body["model"]


class TestAgentStep:
    def test_returns_valid_action(self, client):
        r = client.post("/api/agent/step", json=login_payload())
        assert r.status_code == 200
        a = r.json()
        assert a["action"] in ("click", "type", "scroll", "finish")
        assert 0.0 <= a["confidence"] <= 1.0
        assert a["reasoning"]

    def test_first_action_types_the_first_field(self, client):
        r = client.post("/api/agent/step", json=login_payload(step=0))
        a = r.json()
        assert a["action"] == "type"
        assert a["selector"] == "#email"
        assert a["value"] == "[USER_EMAIL_1]"   # token round-trip, not raw

    def test_full_task_reaches_finish(self, client):
        session = "test-loop"
        seen = []
        for step in range(12):
            r = client.post("/api/agent/step", json=login_payload(step=step, session=session))
            assert r.status_code == 200
            a = r.json()
            seen.append(a["action"])
            if a["action"] == "finish":
                break
        assert "click" in seen
        assert seen[-1] == "finish"

    def test_actions_reference_real_selectors(self, client):
        session = "test-selectors"
        known = {e["selector"] for e in LOGIN_ELEMENTS}
        for step in range(10):
            r = client.post("/api/agent/step", json=login_payload(step=step, session=session))
            a = r.json()
            if a["action"] in ("click", "type"):
                assert a["selector"] in known
            if a["action"] == "finish":
                break

    def test_empty_page_finishes(self, client):
        p = login_payload(session="empty")
        p["dom_elements"] = [{"tag": "p", "selector": "p.msg", "text": "Welcome!",
                              "visible": True, "rect": {"x": 0, "y": 0, "width": 100, "height": 20}}]
        r = client.post("/api/agent/step", json=p)
        assert r.json()["action"] == "finish"

    def test_scroll_added_when_below_fold(self, client):
        p = login_payload(session="scroll")
        for e in p["dom_elements"]:
            e["rect"]["y"] = 700
        r = client.post("/api/agent/step", json=p)
        assert r.json()["action"] == "scroll"

    def test_invalid_payload_rejected(self, client):
        r = client.post("/api/agent/step", json={"task": "x"})
        assert r.status_code == 422


class TestVerifyRedaction:
    def test_compliant_payload(self, client):
        r = client.post("/api/verify-redaction", json={"payload": login_payload()})
        assert r.status_code == 200
        body = r.json()
        assert body["compliant"] is True
        assert body["stats"]["tokenized_values"] >= 3

    def test_detects_raw_card_number(self, client):
        p = login_payload(session="leak")
        p["dom_elements"].append({
            "tag": "input", "type": "text", "selector": "#cc",
            "label": "Card number", "value": "4111 1111 1111 1111",
            "visible": True, "rect": {"x": 0, "y": 0, "width": 10, "height": 10},
        })
        r = client.post("/api/verify-redaction", json={"payload": p})
        body = r.json()
        assert body["compliant"] is False
        assert any(v["pii_type"] == "credit_card" for v in body["violations"])

    def test_detects_raw_password_value(self, client):
        p = login_payload(session="leak2")
        p["dom_elements"][1]["value"] = "Sih@2026#Demo"
        r = client.post("/api/verify-redaction", json={"payload": p})
        body = r.json()
        assert body["compliant"] is False
        assert any(v["pii_type"] == "password" for v in body["violations"])

    def test_detects_luhn_invalid_number_is_not_flagged(self, client):
        p = login_payload(session="order")
        p["dom_elements"].append({
            "tag": "input", "type": "text", "selector": "#order",
            "label": "Order number", "value": "1234567812345678",
            "visible": True, "rect": {"x": 0, "y": 0, "width": 10, "height": 10},
        })
        r = client.post("/api/verify-redaction", json={"payload": p})
        assert r.json()["compliant"] is True

    def test_detects_pii_in_task_text(self, client):
        p = login_payload(session="leak3")
        p["task"] = "Log into the account of ravi.kumar@example.com please"
        r = client.post("/api/verify-redaction", json={"payload": p})
        assert r.json()["compliant"] is False
