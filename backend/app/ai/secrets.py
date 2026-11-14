
import os
from functools import lru_cache

import boto3
from botocore.exceptions import BotoCoreError, ClientError


@lru_cache(maxsize=1)
def get_openai_api_key() -> str:
    """Retrieve and cache the OpenAI API key from AWS."""

    secret_id = os.getenv("OPENAI_SECRET_ID")

    if not secret_id:
        raise RuntimeError("OpenAI secret is not configured")

    try:
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(
            SecretId=secret_id,
        )
    except (ClientError, BotoCoreError):
        raise RuntimeError(
            "OpenAI credentials unavailable"
        ) from None

    api_key = response.get("SecretString")

    if not isinstance(api_key, str) or not api_key.strip():
        raise RuntimeError(
            "OpenAI credentials unavailable"
        )

    return api_key.strip()
