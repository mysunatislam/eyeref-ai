"""The eye crop the pipeline measures.

The live app crops each eye from the camera's frame, 3.2 iris radii across, and enlarges a crop narrower than
CROP_MIN_PX to that width, so segmentation has room to work (apps/web/src/lib/protocol/live.ts). Enlarging
adds no detail: one of the camera's own pixels then spans ``factor`` pixels of the crop. Each frame records it
as ``CaptureMetadata.crop_upsample``, so the quality check judges sharpness and resolution on the camera's own
pixels (eyeref.cv.quality).
"""

from __future__ import annotations

import cv2
import numpy as np

CROP_MIN_PX = 96


def enlarge_crop(img: np.ndarray, min_px: int = CROP_MIN_PX) -> tuple[np.ndarray, float]:
    """The crop enlarged to ``min_px`` wide with bicubic interpolation, and the factor; a wide enough crop is
    returned as it is, with factor 1. Twin of scaleRgba in apps/web/src/lib/cv/draw.ts."""
    h, w = img.shape[:2]
    if w >= min_px:
        return img, 1.0
    factor = min_px / w
    size = (int(round(w * factor)), int(round(h * factor)))
    return cv2.resize(img, size, interpolation=cv2.INTER_CUBIC), factor
