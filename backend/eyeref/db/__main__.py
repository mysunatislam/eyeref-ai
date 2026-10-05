"""Database migrations without the alembic command line, for example inside the API's image:

    python -m eyeref.db upgrade    apply pending migrations to EYEREF_DATABASE_URL
    python -m eyeref.db current    print the database's revision

The API also applies pending migrations itself when it starts.
"""

import sys

from .session import connect, current_revision, upgrade


def main(argv: list[str]) -> int:
    if argv not in (["upgrade"], ["current"]):
        print(__doc__, file=sys.stderr)
        return 2
    engine = connect()
    try:
        if argv == ["upgrade"]:
            upgrade(engine)
        print(current_revision(engine) or "no schema yet")
    finally:
        engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
