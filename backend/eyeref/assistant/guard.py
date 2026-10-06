"""Output guard for third-party language-model text.

A language model must never be the source of refraction values.  Every
dioptre-like or axis-like number in assistant text that is not already present
in the pipeline's own report is redacted, and prescription-style phrasing
("your prescription is", "SPH -2.00") is neutralised.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

DIOPTRE = re.compile(r"(?<![\w.])([+\-−]?\d{1,2}(?:[.,]\d{1,2})?)\s*(?:D\b|dioptres?|diopters?|dpt)", re.I)
RX_FIELD = re.compile(r"\b(SPH|CYL|AXIS|sphere|cylinder|axis)\s*[:=]?\s*([+\-−]?\d{1,3}(?:[.,]\d{1,2})?)\s*(°|deg)?", re.I)
# small local models often drop the unit: "-2.75", "+1.50", "minus 3.25"
SIGNED_POWER = re.compile(r"(?<![\w.\[])([+\-−]\d{1,2}[.,]\d{2})(?![\d%])")
SPELLED_POWER = re.compile(r"\b(?:minus|plus)\s+(\d{1,2}(?:[.,]\d{1,2})?)\b", re.I)
AXIS_DEG = re.compile(r"(?<![\w.])(\d{1,3})\s*(?:°|degrees?)", re.I)
PRESCRIPTION_CLAIM = re.compile(r"\b(your|the)\s+(eyeglass\s+|glasses\s+)?prescription\s+(is|would be|should be)\b", re.I)

REDACTED = "[value removed: only the measurement pipeline may report refraction values]"


def _norm(v: str) -> float:
    return round(float(v.replace("−", "-").replace(",", ".")), 2)


def numbers_in(text: str) -> list[float]:
    """The dioptre values a piece of the pipeline's own text states, such as an eye's range."""
    return [_norm(v) for v in DIOPTRE.findall(text)]


def allowed_values(report_numbers: Iterable[float]) -> set[float]:
    out = set()
    for v in report_numbers:
        if v is None:
            continue
        out.add(round(float(v), 2))
        out.add(round(abs(float(v)), 2))
    return out


def guard_text(text: str, allowed: set[float]) -> tuple[str, int]:
    """Return (sanitised text, number of redactions)."""
    count = 0

    def sub_num(m: re.Match) -> str:
        nonlocal count
        try:
            val = _norm(m.group(1) if m.lastindex and m.re is not RX_FIELD else m.group(2))
        except ValueError:
            return m.group(0)
        if val in allowed or abs(val) in allowed:
            return m.group(0)
        count += 1
        return REDACTED

    text = RX_FIELD.sub(sub_num, text)
    text = DIOPTRE.sub(sub_num, text)
    text = AXIS_DEG.sub(sub_num, text)
    text = SIGNED_POWER.sub(sub_num, text)
    text = SPELLED_POWER.sub(sub_num, text)
    if PRESCRIPTION_CLAIM.search(text):
        count += 1
        text = PRESCRIPTION_CLAIM.sub("a clinical refraction would determine the prescription; this screening", text)
    return text, count
