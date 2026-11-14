
import os
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError


def get_jobs_table():
    return boto3.resource("dynamodb").Table(
        os.environ["DISCHARGE_JOBS_TABLE"]
    )


def lambda_handler(event, context):
    """Move an existing discharge job into PROCESSING."""

    job_id = event.get("job_id") if isinstance(event, dict) else None

    try:
        if (
            not isinstance(job_id, str)
            or str(uuid.UUID(job_id)) != job_id
        ):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Invalid job ID") from None

    table = get_jobs_table()
    now = datetime.now(timezone.utc).isoformat()

    try:
        response = table.update_item(
            Key={"job_id": job_id},
            UpdateExpression=(
                "SET #status = :processing, updated_at = :now"
            ),
            ConditionExpression=(
                "attribute_exists(job_id) "
                "AND attribute_exists(patient_id) "
                "AND attribute_exists(doctor_sub) "
                "AND #status = :queued"
            ),
            ExpressionAttributeNames={
                "#status": "status",
            },
            ExpressionAttributeValues={
                ":queued": "QUEUED",
                ":processing": "PROCESSING",
                ":now": now,
            },
            ReturnValues="ALL_NEW",
        )

        return {
            "job_id": job_id,
            "status": response["Attributes"]["status"],
            "transitioned": True,
        }

    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")

        if code != "ConditionalCheckFailedException":
            raise

    # Allow a repeated invocation to recognize a job
    # that has already entered PROCESSING.
    existing = table.get_item(
        Key={"job_id": job_id},
        ConsistentRead=True,
    ).get("Item")

    if existing and existing.get("status") == "PROCESSING":
        return {
            "job_id": job_id,
            "status": "PROCESSING",
            "transitioned": False,
        }

    raise ValueError(
        "Job does not exist or is not eligible for processing"
    )


def mark_failed_handler(event, context):
    """Mark a PROCESSING job as FAILED after workflow failure."""

    job_id = event.get("job_id") if isinstance(event, dict) else None

    try:
        if (
            not isinstance(job_id, str)
            or str(uuid.UUID(job_id)) != job_id
        ):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Invalid job ID") from None

    table = get_jobs_table()
    now = datetime.now(timezone.utc).isoformat()

    try:
        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression=(
                "SET #status = :failed, "
                "updated_at = :now, "
                "failure_code = :code"
            ),
            ConditionExpression="#status = :processing",
            ExpressionAttributeNames={
                "#status": "status",
            },
            ExpressionAttributeValues={
                ":processing": "PROCESSING",
                ":failed": "FAILED",
                ":code": "DRAFT_GENERATION_FAILED",
                ":now": now,
            },
        )

        return {
            "job_id": job_id,
            "status": "FAILED",
        }

    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")

        if code != "ConditionalCheckFailedException":
            raise

    # Never overwrite an already completed or approved job.
    existing = table.get_item(
        Key={"job_id": job_id},
        ConsistentRead=True,
    ).get("Item")

    return {
        "job_id": job_id,
        "status": existing.get("status") if existing else "NOT_FOUND",
        "transitioned": False,
    }
