"""Limits on what clients may send: request bodies, and eye-crop images.

Eye crops are small (a few hundred pixels across), so the image limits are generous for real
use and stop oversized or decompression-bomb uploads before any decoding happens.
"""

from __future__ import annotations

import json
import os
import struct
from typing import Optional

from fastapi import HTTPException, UploadFile

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 4096 * 4096
DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# JPEG start-of-frame markers, which carry the image size (not DHT 0xC4, JPG 0xC8, DAC 0xCC)
_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def image_header(data: bytes) -> Optional[tuple[str, int, int]]:
    """Format, width and height read from a PNG or JPEG header, without decoding pixels."""
    if data.startswith(PNG_SIGNATURE) and len(data) >= 24 and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        return "png", width, height
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i + 9 <= len(data):
            if data[i] != 0xFF:
                return None
            marker = data[i + 1]
            if marker == 0xFF:  # fill byte before a marker
                i += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD9:  # markers without a length
                i += 2
                continue
            if marker in _JPEG_SOF:
                height, width = struct.unpack(">HH", data[i + 5 : i + 9])
                return "jpeg", width, height
            i += 2 + int.from_bytes(data[i + 2 : i + 4], "big")
    return None


async def read_image(upload: UploadFile, formats: tuple[str, ...] = ("png", "jpeg")) -> bytes:
    """The uploaded image's bytes, refused (413/415) when too big or not an allowed format."""
    data = await upload.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
    header = image_header(data)
    if header is None or header[0] not in formats:
        raise HTTPException(415, f"image must be {' or '.join(f.upper() for f in formats)}")
    _, width, height = header
    if not 0 < width * height <= MAX_IMAGE_PIXELS:
        raise HTTPException(413, "image dimensions are out of range")
    return data


class BodySizeLimitMiddleware:
    """Refuses request bodies over the limit with 413, whether declared or streamed (pure ASGI).

    Sits inside the app's own middleware, so a refusal still carries CORS headers.
    """

    def __init__(self, app, max_bytes: Optional[int] = None):
        self.app = app
        self.max_bytes = max_bytes or int(os.environ.get("EYEREF_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES))
        self.detail = f"request body is larger than {self.max_bytes} bytes"

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.max_bytes:
            body = json.dumps({"detail": self.detail}).encode()
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            return await send({"type": "http.response.body", "body": body})

        received = 0

        async def counted_receive():
            # A body without a length is counted as it streams; the route's exception handling
            # turns the HTTPException into a 413 response.
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise HTTPException(413, self.detail)
            return message

        await self.app(scope, counted_receive, send)
