"""Vision providers behind one interface.

VisionProvider: name, model, available() -> (bool, reason), analyze(inspection) -> VisionAnalysisResponse.
Selection: VISION_PROVIDER=auto|openai|demo|none
(auto: demo if DEMO_MODE, else openai if an API key is set, else none).
"""

from __future__ import annotations

import base64
from typing import Any

from backend.app.core.config import Settings, get_settings
from backend.app.services.vision import (
    PROMPT,
    RESPONSE_SCHEMA,
    VisionAnalysisResponse,
    _demo_scenarios,
    normalize_scenario,
)

UNAVAILABLE_MESSAGE = "Vision analysis unavailable — manual review required."


class VisionUnavailable(RuntimeError):
    """No perception provider can run. The run is held for manual review (fail-open, never fail-accept)."""


class VisionProvider:
    name = "base"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_version = self.model

    @property
    def model(self) -> str:
        return "unknown"

    def available(self) -> tuple[bool, str]:
        return True, "ok"

    def analyze(self, inspection, scenario: str | None = None) -> VisionAnalysisResponse:  # pragma: no cover
        raise NotImplementedError


class OpenAICompatibleProvider(VisionProvider):
    """OpenAI Responses API with strict JSON schema output; any OpenAI-compatible OPENAI_BASE_URL works."""

    name = "openai"

    @property
    def model(self) -> str:
        return self.settings.ai_model

    def available(self) -> tuple[bool, str]:
        if not self.settings.api_key:
            return False, "AI analysis is not configured (AI_API_KEY / OPENAI_API_KEY unset)."
        return True, f"OpenAI-compatible model {self.settings.ai_model}"

    def analyze(self, inspection, scenario: str | None = None) -> VisionAnalysisResponse:
        settings = self.settings
        if not settings.api_key:
            raise RuntimeError("AI analysis is not configured (AI_API_KEY / OPENAI_API_KEY unset).")
        if not inspection.images:
            raise RuntimeError("No images uploaded for analysis.")
        import openai

        client = openai.OpenAI(
            api_key=settings.api_key,
            base_url=settings.openai_base_url or None,
            timeout=settings.ai_timeout_s,
            max_retries=2,
        )
        content: list[dict[str, Any]] = [{"type": "input_text", "text": PROMPT}]
        for image in inspection.images:
            with open(image.image_path, "rb") as handle:
                encoded = base64.b64encode(handle.read()).decode("ascii")
            content.append({"type": "input_text", "text": f"image_id={image.image_id} view={image.image_type}"})
            content.append({"type": "input_image", "image_url": f"data:{image.mime_type};base64,{encoded}", "detail": "high"})

        response = client.responses.create(
            model=settings.ai_model,
            input=[{"role": "user", "content": content}],
            text={"format": {"type": "json_schema", "name": "receiving_analysis", "schema": RESPONSE_SCHEMA, "strict": True}},
        )
        for item in getattr(response, "output", None) or []:
            for part in getattr(item, "content", None) or []:
                if getattr(part, "type", None) == "refusal":
                    raise RuntimeError(f"Model refused: {str(getattr(part, 'refusal', ''))[:300]}")
        if getattr(response, "status", "completed") != "completed":
            raise RuntimeError(f"Model response not completed: {getattr(response, 'incomplete_details', None)}")
        self.model_version = getattr(response, "model", None) or settings.ai_model
        return VisionAnalysisResponse.model_validate_json(response.output_text)


class DemoScenarioProvider(VisionProvider):
    """Scripted readings from the demo catalogue, attached to the real uploaded image. DEMO_MODE only."""

    name = "demo"

    @property
    def model(self) -> str:
        return "demo"

    def available(self) -> tuple[bool, str]:
        if not self.settings.demo_mode:
            return False, "Demo provider requires DEMO_MODE=true."
        return True, "Demo scenarios (simulated perception)"

    def analyze(self, inspection, scenario: str | None = None) -> VisionAnalysisResponse:
        scenarios = _demo_scenarios()
        key = normalize_scenario(scenario)
        if key == "perception_failure":
            raise RuntimeError("Simulated perception failure (demo scenario 'perception_failure').")
        if key not in scenarios:
            raise ValueError(f"Unknown demo scenario '{key}'. Known: {', '.join(sorted(scenarios))}, perception_failure.")
        observations = scenarios[key]
        if not inspection.images:
            raise RuntimeError("No images uploaded for analysis.")
        image_id = inspection.images[0].image_id
        self.model_version = "demo"
        return VisionAnalysisResponse.model_validate({
            "images": [{
                "image_id": image_id,
                "visibility": "blurred" if key == "ambiguous" else "clear",
                "observations": [
                    {"check_type": k, "observation": v, "confidence": c, "description": f"Demo scenario '{key}'."}
                    for k, v, c in observations
                ],
            }]
        })


class UnavailableProvider(VisionProvider):
    name = "none"

    def __init__(self, settings: Settings, reason: str = UNAVAILABLE_MESSAGE):
        super().__init__(settings)
        self.reason = reason

    @property
    def model(self) -> str:
        return "none"

    def available(self) -> tuple[bool, str]:
        return False, UNAVAILABLE_MESSAGE

    def analyze(self, inspection, scenario: str | None = None) -> VisionAnalysisResponse:
        raise VisionUnavailable(UNAVAILABLE_MESSAGE)


def select_provider(settings: Settings | None = None) -> VisionProvider:
    settings = settings or get_settings()
    choice = (settings.vision_provider or "auto").lower()
    if choice == "auto":
        if settings.demo_mode:
            return DemoScenarioProvider(settings)
        if settings.api_key:
            return OpenAICompatibleProvider(settings)
        return UnavailableProvider(settings)
    if choice == "openai":
        return OpenAICompatibleProvider(settings)
    if choice == "demo":
        return DemoScenarioProvider(settings) if settings.demo_mode else UnavailableProvider(settings, "DEMO_MODE is off")
    return UnavailableProvider(settings)
