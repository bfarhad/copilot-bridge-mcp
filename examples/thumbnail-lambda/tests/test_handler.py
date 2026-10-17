import base64
import io
import json
import os
import sys

import pytest
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import handler  # noqa: E402


class FakeS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[(Bucket, Key)] = (Body, ContentType)

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"https://s3.example/{Params['Bucket']}/{Params['Key']}?exp={ExpiresIn}"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    fake = FakeS3()
    monkeypatch.setattr(handler, "_s3", fake)
    monkeypatch.setenv("BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("THUMB_SIZE", "64")
    return fake


def image_bytes(fmt="PNG", size=(400, 200), mode="RGB"):
    out = io.BytesIO()
    Image.new(mode, size, "red").save(out, format=fmt)
    return out.getvalue()


def event(data, content_type="image/png", b64=True):
    return {
        "headers": {"Content-Type": content_type},
        "isBase64Encoded": b64,
        "body": base64.b64encode(data).decode() if b64 else data.decode("latin-1"),
    }


def test_creates_thumbnail_and_stores_both_objects(env):
    res = handler.lambda_handler(event(image_bytes()), None)
    body = json.loads(res["body"])
    assert res["statusCode"] == 200
    assert (body["width"], body["height"]) == (64, 32)  # aspect ratio kept
    assert ("test-bucket", body["original_key"]) in env.objects
    thumb, ctype = env.objects[("test-bucket", body["thumbnail_key"])]
    assert ctype == "image/jpeg" and Image.open(io.BytesIO(thumb)).size == (64, 32)
    assert body["thumbnail_url"].startswith("https://s3.example/test-bucket/thumbnails/")


@pytest.mark.parametrize("fmt,ctype", [("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_other_formats(fmt, ctype):
    res = handler.lambda_handler(event(image_bytes(fmt), ctype), None)
    assert res["statusCode"] == 200


def test_rgba_png_is_flattened():
    res = handler.lambda_handler(event(image_bytes(mode="RGBA")), None)
    assert res["statusCode"] == 200


def test_unsupported_type():
    assert handler.lambda_handler(event(b"x", "image/gif"), None)["statusCode"] == 415


def test_missing_body():
    ev = {"headers": {"content-type": "image/png"}, "body": None}
    assert handler.lambda_handler(ev, None)["statusCode"] == 400


def test_not_an_image():
    assert handler.lambda_handler(event(b"definitely not an image"), None)["statusCode"] == 400


def test_too_large(monkeypatch):
    monkeypatch.setattr(handler, "MAX_BYTES", 10)
    assert handler.lambda_handler(event(image_bytes()), None)["statusCode"] == 413
