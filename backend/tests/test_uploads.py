import json
import struct

import cv2
import numpy as np
import pytest
from databases import fresh_database
from eyeref.api.main import create_app
from eyeref.api.uploads import MAX_IMAGE_BYTES, image_header
from eyeref.simulation.renderer import SyntheticEyeParams, render_eye
from fastapi.testclient import TestClient

ORIGIN = "http://localhost:3000"
META = {"metadata": json.dumps({"eye": "OD", "working_distance_m": 1.0, "illumination": "flash",
                                "simulated": True})}


def _encode(ext: str, height: int = 8, width: int = 8) -> bytes:
    ok, buf = cv2.imencode(ext, np.zeros((height, width, 3), np.uint8))
    assert ok
    return buf.tobytes()


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(fresh_database(tmp_path), data_dir=str(tmp_path), max_body_bytes=2 * MAX_IMAGE_BYTES))


def _analyze(client, data: bytes, name="eye.png", ctype="image/png"):
    return client.post("/api/analyze/frame", files={"image": (name, data, ctype)}, data=META)


def test_image_header_reads_sizes_without_decoding():
    assert image_header(_encode(".png", 20, 30)) == ("png", 30, 20)
    assert image_header(_encode(".jpg", 20, 30)) == ("jpeg", 30, 20)
    assert image_header(b"GIF89a" + b"\0" * 32) is None
    assert image_header(b"") is None


def test_frame_analysis_accepts_jpeg_crops(client):
    img, _ = render_eye(SyntheticEyeParams(source_angle_image_deg=270, seed=1))
    ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
    r = _analyze(client, jpg.tobytes(), "eye.jpg", "image/jpeg")
    assert r.status_code == 200, r.text


def test_frame_analysis_refuses_what_it_cannot_safely_decode(client):
    assert _analyze(client, b"not an image").status_code == 415
    assert _analyze(client, b"GIF89a" + b"\0" * 64, "e.gif", "image/gif").status_code == 415
    # a tiny PNG that claims 100,000 x 100,000 pixels is refused before decoding
    bomb = (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR"
            + struct.pack(">II", 100_000, 100_000) + b"\x08\x02\x00\x00\x00")
    assert _analyze(client, bomb).status_code == 413
    oversized = _encode(".png") + b"\0" * MAX_IMAGE_BYTES
    assert _analyze(client, oversized).status_code == 413


def test_stored_eye_crops_must_be_png(client):
    sub = client.post("/api/subjects", json={"code": "IMG-2", "consent_research": True,
                                             "consent_image_storage": True}).json()
    ses = client.post("/api/sessions", json={"subject_id": sub["id"], "device_id": "generic-phone-rear"}).json()
    url = f"/api/sessions/{ses['id']}/captures"
    meta = {"metadata": json.dumps({"eye": "OD", "working_distance_m": 1.0})}
    r = client.post(url, data=meta, files={"image": ("e.jpg", _encode(".jpg"), "image/jpeg")})
    assert r.status_code == 415
    r = client.post(url, data=meta, files={"image": ("e.png", _encode(".png"), "image/png")})
    assert r.status_code == 200 and r.json()["image_stored"] is True


def test_request_bodies_over_the_limit_are_refused(client):
    pad = "x" * (2 * MAX_IMAGE_BYTES)
    r = client.post("/api/estimate", json={"frames": [], "device_id": "x", "pad": pad}, headers={"origin": ORIGIN})
    assert r.status_code == 413
    assert r.headers["access-control-allow-origin"] == ORIGIN  # the browser can read the refusal

    def stream():  # no declared length: counted as it arrives
        for _ in range(3):
            yield b" " * MAX_IMAGE_BYTES

    r = client.post("/api/estimate", content=stream(), headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert client.get("/health").status_code == 200
