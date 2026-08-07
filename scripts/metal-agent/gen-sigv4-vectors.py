"""Generate SigV4 reference vectors with botocore, to pin the hand-rolled signer against."""
import hashlib
import json

from botocore.auth import S3SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

CREDS = Credentials("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
ENDPOINT = "https://mynamespace.compat.objectstorage.us-ashburn-1.oraclecloud.com"
REGION = "us-ashburn-1"
BUCKET = "shogo-workspaces-production"

CASES = [
    {
        "name": "if-match compare-and-swap",
        "key": "proj-abc/project-data.tar.gz",
        "body": b"gzip-bytes-here",
        "content_type": "application/gzip",
        "extra": {"if-match": '"d41d8cd98f00b204e9800998ecf8427e"'},
    },
    {
        "name": "if-none-match create-only",
        "key": "proj-abc/project-data.tar.gz",
        "body": b"",
        "content_type": "application/gzip",
        "extra": {"if-none-match": "*"},
    },
    {
        "name": "key needing percent-encoding",
        "key": "proj abc/weird+name (1)/data.tar.gz",
        "body": b"\x00\x01\x02binary",
        "content_type": "application/octet-stream",
        "extra": {},
    },
]

out = []
for case in CASES:
    body = case["body"]
    headers = {
        "content-length": str(len(body)),
        "content-type": case["content_type"],
        "x-amz-content-sha256": hashlib.sha256(body).hexdigest(),
        **case["extra"],
    }
    # botocore percent-encodes the path itself; give it the raw key.
    from urllib.parse import quote

    url = f"{ENDPOINT}/{BUCKET}/{quote(case['key'], safe='/')}"
    req = AWSRequest(method="PUT", url=url, data=body, headers=headers)
    S3SigV4Auth(CREDS, "s3", REGION).add_auth(req)

    out.append(
        {
            "name": case["name"],
            "key": case["key"],
            "bodyBase64": __import__("base64").b64encode(body).decode(),
            "contentType": case["content_type"],
            "extra": case["extra"],
            "amzDate": dict(req.headers)["X-Amz-Date"],
            "authorization": dict(req.headers)["Authorization"],
        }
    )

print(json.dumps({"endpoint": ENDPOINT, "region": REGION, "bucket": BUCKET,
                  "accessKeyId": CREDS.access_key, "secretAccessKey": CREDS.secret_key,
                  "cases": out}, indent=2))
