
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.ai.discharge_letter import DischargeDraft


class EditDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_updated_at: str = Field(
        min_length=10,
        max_length=64,
    )
    draft: DischargeDraft


class ReviewDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["APPROVE", "REJECT"]
    expected_updated_at: str = Field(
        min_length=10,
        max_length=64,
    )
    note: str = Field(default="", max_length=1000)
    acknowledge_missing_sections: bool = False
