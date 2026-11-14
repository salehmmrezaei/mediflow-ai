
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.ai.discharge_letter import (
    DischargeDraft,
    DraftSection,
    MISSING_TEXT,
    generate_discharge_draft,
)


NOTES = [
    {
        "note_id": "N001",
        "note_text": (
            "Synthetic patient presented with fever "
            "and persistent cough. Admitted for observation."
        ),
    },
    {
        "note_id": "N002",
        "note_text": "Chest imaging was requested.",
    },
]


def missing_section():
    return DraftSection(
        text=MISSING_TEXT,
        documented=False,
        supporting_note_ids=[],
    )


def valid_draft():
    return DischargeDraft(
        admission_reason=DraftSection(
            text="Fever and persistent cough.",
            documented=True,
            supporting_note_ids=["N001"],
        ),
        hospital_course=missing_section(),
        investigations=DraftSection(
            text="Chest imaging was requested.",
            documented=True,
            supporting_note_ids=["N002"],
        ),
        discharge_diagnosis=missing_section(),
        discharge_medications=missing_section(),
        discharge_date=missing_section(),
        follow_up=missing_section(),
    )


def fake_client(draft, status="completed"):
    client = MagicMock()
    client.responses.parse.return_value = SimpleNamespace(
        status=status,
        output_parsed=draft,
    )
    return client


def test_valid_discharge_draft():
    client = fake_client(valid_draft())

    result = generate_discharge_draft(
        NOTES,
        client=client,
    )

    assert result["admission_reason"]["documented"] is True
    assert result["admission_reason"]["supporting_note_ids"] == [
        "N001"
    ]

    assert result["discharge_diagnosis"]["documented"] is False
    assert "discharge_diagnosis" in result["missing_sections"]

    client.responses.parse.assert_called_once()
    assert client.responses.parse.call_args.kwargs["store"] is False


def test_unknown_note_reference_rejected():
    draft = valid_draft()

    draft.admission_reason.supporting_note_ids = ["N999"]

    with pytest.raises(RuntimeError, match="Unknown evidence"):
        generate_discharge_draft(
            NOTES,
            client=fake_client(draft),
        )


def test_documented_section_requires_citation():
    draft = valid_draft()

    draft.admission_reason.supporting_note_ids = []

    with pytest.raises(RuntimeError, match="lacks evidence"):
        generate_discharge_draft(
            NOTES,
            client=fake_client(draft),
        )


def test_undocumented_section_cannot_claim_evidence():
    draft = valid_draft()

    draft.discharge_diagnosis.supporting_note_ids = ["N001"]

    with pytest.raises(
        RuntimeError,
        match="Invalid missing-information",
    ):
        generate_discharge_draft(
            NOTES,
            client=fake_client(draft),
        )


def test_no_notes_does_not_call_openai():
    client = MagicMock()

    with pytest.raises(ValueError, match="No clinical evidence"):
        generate_discharge_draft([], client=client)

    client.responses.parse.assert_not_called()


def test_incomplete_model_response_rejected():
    client = fake_client(
        valid_draft(),
        status="incomplete",
    )

    with pytest.raises(RuntimeError, match="incomplete"):
        generate_discharge_draft(
            NOTES,
            client=client,
        )


def test_model_failure_propagates():
    client = MagicMock()
    client.responses.parse.side_effect = TimeoutError(
        "Simulated timeout"
    )

    with pytest.raises(TimeoutError):
        generate_discharge_draft(
            NOTES,
            client=client,
        )
