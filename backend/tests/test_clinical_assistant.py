
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.ai.clinical_assistant import (
    ClinicalAnswer,
    answer_question,
)


NOTES = [
    {
        "note_id": "N001",
        "note_type": "admission",
        "note_text": (
            "Synthetic patient admitted with "
            "fever and persistent cough."
        ),
    },
    {
        "note_id": "N002",
        "note_type": "observation",
        "note_text": "Chest imaging was requested.",
    },
]


def mock_openai_response(
    answer,
    note_ids,
    insufficient=False,
    status="completed",
):
    client = MagicMock()

    result = ClinicalAnswer(
        answer=answer,
        supporting_note_ids=note_ids,
        insufficient_evidence=insufficient,
    )

    client.responses.parse.return_value = SimpleNamespace(
        status=status,
        output_parsed=result,
    )

    return client


def test_no_evidence():
    client = MagicMock()

    result = answer_question(
        "Why was the patient admitted?",
        notes=[],
        client=client,
    )

    assert result["insufficient_evidence"] is True
    assert result["supporting_note_ids"] == []

    client.responses.parse.assert_not_called()


def test_valid_grounded_answer():
    client = mock_openai_response(
        answer="The patient had fever and cough.",
        note_ids=["N001"],
    )

    result = answer_question(
        "Why was the patient admitted?",
        NOTES,
        client=client,
    )

    assert result["insufficient_evidence"] is False
    assert result["supporting_note_ids"] == ["N001"]
    assert "fever" in result["answer"]

    client.responses.parse.assert_called_once()


def test_unknown_note_id_rejected():
    client = mock_openai_response(
        answer="Unsupported answer.",
        note_ids=["N999"],
    )

    with pytest.raises(
        RuntimeError,
        match="unknown note ID",
    ):
        answer_question(
            "Why was the patient admitted?",
            NOTES,
            client=client,
        )


def test_answer_without_citations_rejected():
    client = mock_openai_response(
        answer="The patient had fever.",
        note_ids=[],
    )

    with pytest.raises(
        RuntimeError,
        match="no supporting records",
    ):
        answer_question(
            "Why was the patient admitted?",
            NOTES,
            client=client,
        )


def test_insufficient_evidence():
    client = mock_openai_response(
        answer="The notes do not establish this.",
        note_ids=[],
        insufficient=True,
    )

    result = answer_question(
        "What was the patient's blood pressure?",
        NOTES,
        client=client,
    )

    assert result["insufficient_evidence"] is True
    assert result["supporting_note_ids"] == []


@pytest.mark.parametrize(
    "question",
    ["", "   ", "x" * 501],
)
def test_invalid_question(question):
    client = MagicMock()

    with pytest.raises(ValueError):
        answer_question(
            question,
            NOTES,
            client=client,
        )

    client.responses.parse.assert_not_called()


def test_incomplete_model_response():
    client = mock_openai_response(
        answer="Partial answer",
        note_ids=["N001"],
        status="incomplete",
    )

    with pytest.raises(
        RuntimeError,
        match="AI response was incomplete",
    ):
        answer_question(
            "Why was the patient admitted?",
            NOTES,
            client=client,
        )


def test_model_timeout_propagates():
    client = MagicMock()
    client.responses.parse.side_effect = TimeoutError(
        "Simulated model timeout"
    )

    with pytest.raises(TimeoutError):
        answer_question(
            "Why was the patient admitted?",
            NOTES,
            client=client,
        )
