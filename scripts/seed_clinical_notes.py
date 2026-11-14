
import boto3
from botocore.exceptions import ClientError

REGION = "eu-south-1"
PROFILE = "mediflow-dev"
STACK_NAME = "mediflow-ai-dev"

session = boto3.Session(
    profile_name=PROFILE,
    region_name=REGION,
)

cloudformation = session.client("cloudformation")
dynamodb = session.resource("dynamodb")

# Retrieve AWS table names from CloudFormation
stack = cloudformation.describe_stacks(
    StackName=STACK_NAME
)["Stacks"][0]

outputs = {
    output["OutputKey"]: output["OutputValue"]
    for output in stack["Outputs"]
}

notes_table = dynamodb.Table(
    outputs["ClinicalNotesTableName"]
)

patients_table_name = cloudformation.describe_stack_resource(
    StackName=STACK_NAME,
    LogicalResourceId="PatientsTable",
)["StackResourceDetail"]["PhysicalResourceId"]

patients_table = dynamodb.Table(patients_table_name)

# Completely fictional medical notes
NOTES = [
    {
        "patient_id": "TEST-A-0940b91ac8",
        "note_id": "N001",
        "note_type": "admission",
        "note_text": (
            "Synthetic patient presented with fever "
            "and persistent cough. Admission was "
            "documented for observation and assessment."
        ),
    },
    {
        "patient_id": "TEST-A-0940b91ac8",
        "note_id": "N002",
        "note_type": "observation",
        "note_text": (
            "Chest imaging was requested. "
            "No imaging result is included in "
            "this synthetic clinical note."
        ),
    },
    {
        "patient_id": "TEST-B-0940b91ac8",
        "note_id": "N001",
        "note_type": "admission",
        "note_text": (
            "Synthetic patient admitted for "
            "observation following reports of "
            "dizziness and fatigue."
        ),
    },
]


def seed_notes():
    for note in NOTES:
        # Verify the synthetic patient exists
        patient_response = patients_table.get_item(
            Key={"patient_id": note["patient_id"]}
        )
        patient = patient_response.get("Item")

        if not patient or not patient.get("doctor_sub"):
            print(
                "SKIPPED: Missing patient or owner:",
                note["patient_id"],
            )
            continue

        try:
            notes_table.put_item(
                Item=note,
                ConditionExpression=(
                    "attribute_not_exists(patient_id)"
                ),
            )
            print(
                "CREATED:",
                note["patient_id"],
                note["note_id"],
            )

        except ClientError as error:
            if (
                error.response["Error"]["Code"]
                == "ConditionalCheckFailedException"
            ):
                print(
                    "ALREADY EXISTS:",
                    note["patient_id"],
                    note["note_id"],
                )
            else:
                raise


if __name__ == "__main__":
    seed_notes()
