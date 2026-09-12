"""OBA reasoning server — Pydantic contracts (mirrors extension/src/core/constants.js)."""
from typing import List, Literal, Optional
from pydantic import BaseModel, Field, model_validator


class Rect(BaseModel):
    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0


class DOMElement(BaseModel):
    """One serialized DOM element from the client.

    `value` arrives TOKENIZED for sensitive fields (e.g. "[USER_PASSWORD_1]");
    raw secrets never reach this server.
    """
    tag: str
    type: Optional[str] = None
    id: Optional[str] = None
    name: Optional[str] = None
    selector: str = ""
    text: Optional[str] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None
    ariaLabel: Optional[str] = None
    autocomplete: Optional[str] = None
    role: Optional[str] = None
    value: Optional[str] = None
    isImg: bool = False
    imgHints: Optional[str] = None
    visible: bool = True
    rect: Optional[Rect] = None


class Viewport(BaseModel):
    width: float = 1280
    height: float = 800
    dpr: float = 1.0
    scrollX: float = 0
    scrollY: float = 0


class PerceptionInfo(BaseModel):
    tier: Optional[str] = None
    domMs: Optional[float] = None
    visionMs: Optional[float] = None
    redactionMs: Optional[float] = None
    piiDetected: Optional[int] = None
    redactionVerified: Optional[bool] = None


class SanitizedPayload(BaseModel):
    task: str = Field(min_length=1, max_length=2000)
    screenshot_base64: str = ""
    dom_elements: List[DOMElement] = Field(default_factory=list)
    viewport: Viewport = Field(default_factory=Viewport)
    url: str = ""
    title: Optional[str] = None
    step_index: int = Field(default=0, ge=0)
    session_id: str = Field(min_length=1, max_length=128)
    perception: Optional[PerceptionInfo] = None

    @property
    def has_screenshot(self) -> bool:
        return len(self.screenshot_base64) > 128


class AgentAction(BaseModel):
    action: Literal["click", "type", "scroll", "finish"]
    selector: str = ""
    value: Optional[str] = None
    direction: Optional[Literal["up", "down"]] = None
    distance: Optional[int] = Field(default=None, ge=0, le=10000)
    reasoning: str = ""
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def check_required_fields(self):
        if self.action in ("click", "type") and not self.selector:
            raise ValueError(f"action '{self.action}' requires a selector")
        if self.action == "type" and self.value is None:
            raise ValueError("action 'type' requires a value")
        return self


class Violation(BaseModel):
    reason: str
    where: Optional[str] = None
    pii_type: Optional[str] = None
    hint: Optional[str] = None  # masked, never the raw value


class VerifyRedactionResponse(BaseModel):
    compliant: bool
    verdict: str
    violations: List[Violation] = Field(default_factory=list)
    checks_run: List[str] = Field(default_factory=list)
    stats: dict = Field(default_factory=dict)


class HealthResponse(BaseModel):
    status: str
    provider: str
    model: str
    version: str
    uptime_s: float
