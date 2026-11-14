
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError


ACTIVE_STATUSES = {"QUEUED", "PROCESSING"}

CLOSED_EXECUTIONS = {
    "SUCCEEDED",
    "FAILED",
    "TIMED_OUT",
    "ABORTED",
    "NOT_FOUND",
}


def get_jobs_table():
    return boto3.resource("dynamodb").Table(
        os.environ["DISCHARGE_JOBS_TABLE"]
    )


def get_sfn_client():
    return boto3.client("stepfunctions")


def parse_timestamp(value):
    if not isinstance(value, str):
        return None

    try:
        timestamp = datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )
    except ValueError:
        return None

    if timestamp.tzinfo is None:
        return None

    return timestamp


def lambda_handler(event, context):
    """
    Detect abandoned discharge jobs.

    Never modify jobs in PENDING_REVIEW,
    APPROVED, REJECTED, or FAILED.

    Default to dry-run mode.
    """

    workflow_arn = os.environ["DISCHARGE_WORKFLOW_ARN"]

    if ":stateMachine:" not in workflow_arn:
        raise RuntimeError("Invalid workflow ARN")

    execution_prefix = workflow_arn.replace(
        ":stateMachine:",
        ":execution:",
        1,
    )

    stale_minutes = int(
        os.getenv("STALE_JOB_MINUTES", "30")
    )
    dry_run = (
        os.getenv("RECONCILER_DRY_RUN", "true").lower()
        == "true"
    )

    if stale_minutes < 15:
        raise ValueError(
            "Staleness threshold must be at least 15 minutes"
        )

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=stale_minutes)

    table = get_jobs_table()
    sfn = get_sfn_client()

    stats = {
        "dry_run": dry_run,
        "scanned_active": 0,
        "stale": 0,
        "still_running": 0,
        "eligible_for_failure": 0,
        "marked_failed": 0,
        "conflicts": 0,
        "lookup_errors": 0,
        "invalid_records": 0,
    }

    scan_args = {
        "FilterExpression": Attr("status").is_in(
            ["QUEUED", "PROCESSING"]
        ),
        "ProjectionExpression": (
            "job_id, #job_status, updated_at"
        ),
        "ExpressionAttributeNames": {
            "#job_status": "status",
        },
    }

    while True:
        page = table.scan(**scan_args)

        for job in page.get("Items", []):
            stats["scanned_active"] += 1

            job_id = job.get("job_id")
            status = job.get("status")
            updated_at = job.get("updated_at")
            updated_time = parse_timestamp(updated_at)

            try:
                valid_id = (
                    isinstance(job_id, str)
                    and str(uuid.UUID(job_id)) == job_id
                )
            except (ValueError, TypeError, AttributeError):
                valid_id = False

            if (
                not valid_id
                or status not in ACTIVE_STATUSES
                or updated_time is None
            ):
                stats["invalid_records"] += 1
                continue

            if updated_time > cutoff:
                continue

            stats["stale"] += 1

            execution_arn = (
                f"{execution_prefix}:{job_id}"
            )

            try:
                execution = sfn.describe_execution(
                    executionArn=execution_arn
                )
                execution_status = execution["status"]

            except ClientError as exc:
                code = exc.response.get(
                    "Error", {}
                ).get("Code")

                if code == "ExecutionDoesNotExist":
                    execution_status = "NOT_FOUND"
                else:
                    stats["lookup_errors"] += 1
                    continue

            # Never interrupt an active execution.
            if execution_status in (
                "RUNNING",
                "PENDING_REDRIVE",
            ):
                stats["still_running"] += 1
                continue

            if execution_status not in CLOSED_EXECUTIONS:
                continue

            stats["eligible_for_failure"] += 1

            if dry_run:
                continue

            try:
                table.update_item(
                    Key={"job_id": job_id},
                    UpdateExpression=(
                        "SET #job_status = :failed, "
                        "updated_at = :now, "
                        "failure_code = :code"
                    ),
                    ConditionExpression=(
                        "#job_status = :expected_status "
                        "AND updated_at = :expected_time"
                    ),
                    ExpressionAttributeNames={
                        "#job_status": "status",
                    },
                    ExpressionAttributeValues={
                        ":expected_status": status,
                        ":expected_time": updated_at,
                        ":failed": "FAILED",
                        ":now": now.isoformat(),
                        ":code": "STALE_WORKFLOW",
                    },
                )

                stats["marked_failed"] += 1

            except ClientError as exc:
                code = exc.response.get(
                    "Error", {}
                ).get("Code")

                if code == "ConditionalCheckFailedException":
                    stats["conflicts"] += 1
                    continue

                raise

        if (
            context is not None
            and context.get_remaining_time_in_millis() < 8000
        ):
            break

        next_key = page.get("LastEvaluatedKey")

        if not next_key:
            break

        scan_args["ExclusiveStartKey"] = next_key

    return stats
