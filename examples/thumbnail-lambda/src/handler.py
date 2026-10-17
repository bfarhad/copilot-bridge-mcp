"""POST /thumbnails — store an uploaded image and return a presigned thumbnail URL.

Request:  raw image bytes (image/jpeg | image/png | image/webp), API key in `x-api-key`.
Response: 200 {"id", "thumbnail_url", "original_key", "thumbnail_key", "width", "height"}
"""

import base64
import io
import json
import os
import uuid

import boto3
from PIL import Image, ImageOps

ALLOWED_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_BYTES = 4 * 1024 * 1024  # API Gateway/Lambda cap payloads at ~6 MB; base64 adds ~33%

_s3 = None


def _client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


def _response(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def make_thumbnail(data: bytes, size: int) -> tuple[bytes, tuple[int, int]]:
    """Return JPEG bytes of the image scaled to fit in size x size, and its dimensions."""
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)
        img.thumbnail((size, size), Image.LANCZOS)
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.getchannel("A"))
            img = flat
        else:
            img = img.convert("RGB")
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=85, optimize=True)
        return out.getvalue(), img.size


def lambda_handler(event, context):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    content_type = headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_TYPES:
        return _response(415, {"error": f"Unsupported Content-Type; use one of {sorted(ALLOWED_TYPES)}"})

    body = event.get("body")
    if not body:
        return _response(400, {"error": "Empty body"})
    data = base64.b64decode(body) if event.get("isBase64Encoded") else body.encode("latin-1")
    if len(data) > MAX_BYTES:
        return _response(413, {"error": f"Image too large (max {MAX_BYTES} bytes)"})

    try:
        thumb, (width, height) = make_thumbnail(data, int(os.environ.get("THUMB_SIZE", "256")))
    except Exception:  # unreadable/corrupt image, decompression bomb, ...
        return _response(400, {"error": "Body is not a valid image"})

    bucket = os.environ["BUCKET_NAME"]
    image_id = uuid.uuid4().hex
    original_key = f"originals/{image_id}.{ALLOWED_TYPES[content_type]}"
    thumbnail_key = f"thumbnails/{image_id}.jpg"

    s3 = _client()
    s3.put_object(Bucket=bucket, Key=original_key, Body=data, ContentType=content_type)
    s3.put_object(Bucket=bucket, Key=thumbnail_key, Body=thumb, ContentType="image/jpeg")
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": thumbnail_key},
        ExpiresIn=int(os.environ.get("URL_EXPIRY_SECONDS", "3600")),
    )

    return _response(200, {
        "id": image_id,
        "thumbnail_url": url,
        "original_key": original_key,
        "thumbnail_key": thumbnail_key,
        "width": width,
        "height": height,
    })
