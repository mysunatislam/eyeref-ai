"""EyeRef AI research ML package: datasets, models, training, evaluation, export.

Depends on the reference implementation in ../backend (package ``eyeref``).
"""

import sys
from pathlib import Path

_backend = Path(__file__).resolve().parents[2] / "backend"
if _backend.exists() and str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

__version__ = "0.1.0"
