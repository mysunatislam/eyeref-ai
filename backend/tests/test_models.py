import warnings

from databases import fresh_database
from eyeref.db import models as m
from eyeref.db.session import make_engine
from sqlalchemy import func, select
from sqlalchemy.exc import SAWarning
from sqlalchemy.orm import Session


def test_deleting_a_subject_deletes_each_reference_before_the_visit_it_belongs_to(tmp_path):
    # Otherwise the visit goes first, the database's cascade removes the reference under the ORM, and the
    # ORM's own delete of it matches nothing.
    engine = make_engine(fresh_database(tmp_path))
    with Session(engine) as s:
        subj = m.Subject(code="SITE1-0001", consent_research=True)
        s.add_all([subj, m.Device(id="d1", manufacturer="lab", model="phone", camera="rear", profile={})])
        s.flush()
        visit = m.CaptureSession(subject_id=subj.id, device_id="d1")
        s.add(visit)
        s.flush()
        s.add(m.GroundTruth(subject_id=subj.id, session_id=visit.id, eye="OD", method="autorefractor", sphere=-1,
                            cylinder=0, spherical_equivalent=-1))
        s.commit()
        subject_id = subj.id

    with Session(engine) as s, warnings.catch_warnings():
        warnings.simplefilter("error", SAWarning)
        s.delete(s.get(m.Subject, subject_id))
        s.commit()
        assert [s.scalar(select(func.count()).select_from(t)) for t in (m.CaptureSession, m.GroundTruth)] == [0, 0]
