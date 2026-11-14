
import pytest

from app.models.discharge_job import (
    DischargeJobStatus as Status,
    transition_job_status,
)


@pytest.mark.parametrize(
    "current,next_status",
    [
        (Status.QUEUED, Status.PROCESSING),
        (Status.PROCESSING, Status.PENDING_REVIEW),
        (Status.PROCESSING, Status.FAILED),
        (Status.PENDING_REVIEW, Status.APPROVED),
        (Status.PENDING_REVIEW, Status.REJECTED),
    ],
)
def test_valid_transitions(current, next_status):
    result = transition_job_status(
        current,
        next_status,
    )
    assert result == next_status


@pytest.mark.parametrize(
    "current,next_status",
    [
        (Status.QUEUED, Status.APPROVED),
        (Status.QUEUED, Status.PENDING_REVIEW),
        (Status.PROCESSING, Status.APPROVED),
        (Status.APPROVED, Status.PROCESSING),
        (Status.FAILED, Status.QUEUED),
        (Status.REJECTED, Status.APPROVED),
    ],
)
def test_invalid_transitions(current, next_status):
    with pytest.raises(
        ValueError,
        match="Invalid discharge-job transition",
    ):
        transition_job_status(
            current,
            next_status,
        )
