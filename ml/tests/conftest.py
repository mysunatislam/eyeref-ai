import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import eyeref_ml  # noqa: E402,F401  (adds ../backend to sys.path)
