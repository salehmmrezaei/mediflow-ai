
from enum import StrEnum


class DischargeJobStatus(StrEnum):
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    PENDING_REVIEW = "PENDING_REVIEW"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"


ALLOWED_TRANSITIONS = {
    DischargeJobStatus.QUEUED: {
        DischargeJobStatus.PROCESSING,
    },
    DischargeJobStatus.PROCESSING: {
        DischargeJobStatus.PENDING_REVIEW,
        DischargeJobStatus.FAILED,
    },
    DischargeJobStatus.PENDING_REVIEW: {
        DischargeJobStatus.APPROVED,
        DischargeJobStatus.REJECTED,
    },
    DischargeJobStatus.APPROVED: set(),
    DischargeJobStatus.REJECTED: set(),
    DischargeJobStatus.FAILED: set(),
}


def transition_job_status(
    current: DischargeJobStatus,
    next_status: DischargeJobStatus,
) -> DischargeJobStatus:
    """Validate a discharge-job status transition."""

    allowed = ALLOWED_TRANSITIONS[current]

    if next_status not in allowed:
        raise ValueError(
            f"Invalid discharge-job transition: "
            f"{current} -> {next_status}"
        )

    return next_status
