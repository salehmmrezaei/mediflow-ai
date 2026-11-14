
import json
import os
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

API = "https://5cnblr150k.execute-api.eu-south-1.amazonaws.com"
PATIENT = "TEST-A-0940b91ac8"
DOCTOR_A = os.environ.get("DOCTOR_A_TOKEN")
DOCTOR_B = os.environ.get("DOCTOR_B_TOKEN")

if not DOCTOR_A:
    raise SystemExit("Export a fresh DOCTOR_A_TOKEN first.")


def request(method, path, payload=None, token=DOCTOR_A, key=None):
    headers = {"Accept": "application/json"}
    body = None

    if token:
        headers["Authorization"] = f"Bearer {token}"

    if key:
        headers["Idempotency-Key"] = key

    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    elif method == "POST":
        body = b""
        headers["Content-Type"] = "application/json"

    req = Request(
        API + path,
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urlopen(req, timeout=40) as response:
            return response.status, json.load(response)
    except HTTPError as exc:
        raw = exc.read().decode()
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"error": raw}
        return exc.code, data


def check(actual, expected, description):
    if actual != expected:
        raise AssertionError(
            f"{description}: expected {expected}, got {actual}"
        )
    print(f"PASS: {description}")


def create_and_wait(patient_id):
    status, job = request(
        "POST",
        f"/patients/{patient_id}/discharge-letters",
        key=str(uuid.uuid4()),
    )

    check(status, 202, "New discharge job accepted")
    job_id = job["job_id"]
    print("Job ID:", job_id)

    deadline = time.monotonic() + 150

    while time.monotonic() < deadline:
        status, result = request(
            "GET", f"/discharge-jobs/{job_id}"
        )
        check(status, 200, "Job is readable")

        if result["status"] in ("PENDING_REVIEW", "FAILED"):
            return job_id, result["status"]

        time.sleep(3)

    raise TimeoutError(f"Job did not finish: {job_id}")


print("\n=== APPROVAL TEST ===")

approve_job, state = create_and_wait(PATIENT)
check(state, "PENDING_REVIEW", "Draft generated")

path = f"/discharge-jobs/{approve_job}/draft"
status, view = request("GET", path)

check(status, 200, "Doctor A retrieves draft")

assert len(view["draft"]) == 7
assert "missing_sections" not in view["draft"]
print("PASS: Seven-section draft structure")

# Check that missing sections cannot be approved silently.
status, _ = request(
    "POST",
    f"/discharge-jobs/{approve_job}/review",
    {
        "action": "APPROVE",
        "expected_updated_at": view["updated_at"],
        "acknowledge_missing_sections": False,
    },
)
check(status, 422, "Missing-section acknowledgement required")

# Test the edit endpoint without adding unsupported facts.
status, edited = request(
    "PUT",
    path,
    {
        "expected_updated_at": view["updated_at"],
        "draft": view["draft"],
    },
)
check(status, 200, "Draft edit saved")

check(
    edited["status"],
    "PENDING_REVIEW",
    "Editing preserves review status",
)

# Attempt approval using the old version.
status, _ = request(
    "POST",
    f"/discharge-jobs/{approve_job}/review",
    {
        "action": "APPROVE",
        "expected_updated_at": view["updated_at"],
        "acknowledge_missing_sections": True,
    },
)
check(status, 409, "Stale-version approval blocked")

# Approve the current version.
status, approved = request(
    "POST",
    f"/discharge-jobs/{approve_job}/review",
    {
        "action": "APPROVE",
        "expected_updated_at": edited["updated_at"],
        "acknowledge_missing_sections": True,
        "note": "Synthetic test draft reviewed.",
    },
)

check(status, 200, "Approval accepted")
check(approved["status"], "APPROVED", "Approved status stored")
check(
    approved["document_state"],
    "REVIEW_APPROVED_UNSIGNED",
    "Document remains unsigned",
)

# Repeated review must fail.
status, _ = request(
    "POST",
    f"/discharge-jobs/{approve_job}/review",
    {
        "action": "APPROVE",
        "expected_updated_at": edited["updated_at"],
        "acknowledge_missing_sections": True,
    },
)
check(status, 409, "Second approval blocked")


print("\n=== REJECTION TEST ===")

reject_job, state = create_and_wait(PATIENT)
check(state, "PENDING_REVIEW", "Second draft generated")

status, reject_view = request(
    "GET", f"/discharge-jobs/{reject_job}/draft"
)
check(status, 200, "Rejection draft retrieved")

review_path = f"/discharge-jobs/{reject_job}/review"

status, _ = request(
    "POST",
    review_path,
    {
        "action": "REJECT",
        "expected_updated_at": reject_view["updated_at"],
        "note": "",
    },
)
check(status, 422, "Rejection reason required")

status, rejected = request(
    "POST",
    review_path,
    {
        "action": "REJECT",
        "expected_updated_at": reject_view["updated_at"],
        "note": "Additional synthetic evidence required.",
    },
)

check(status, 200, "Rejection accepted")
check(rejected["status"], "REJECTED", "Rejected status stored")


print("\n=== AUTHORIZATION TEST ===")

status, _ = request(
    "GET",
    f"/discharge-jobs/{approve_job}/draft",
    token=None,
)
check(status, 401, "Unauthenticated access blocked")

if DOCTOR_B:
    status, _ = request(
        "GET",
        f"/discharge-jobs/{approve_job}/draft",
        token=DOCTOR_B,
    )
    check(status, 404, "Cross-doctor access blocked")
else:
    print("SKIP: Live Doctor B ownership test (no token)")


print("\nREVIEW TESTS COMPLETE ")
print("Approved job:", approve_job)
print("Rejected job:", reject_job)
