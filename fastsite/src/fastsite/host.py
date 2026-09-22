"""Gunicorn entry point bundled with the secure fastsite wheel."""

from .app import create_app


app = create_app()
