"""Native Windows / cross-platform wrapper around PatrikHolopainen/local-diarization.

The upstream pipeline (MIT, Copyright (c) 2026 Patrik Holopainen) lives unmodified in
``upstream/``. This package adds Windows setup, bounded subprocesses, cancellation,
model management, a versioned transcript contract, audio capture and a JSON-RPC
tool interface. Upstream functions are imported rather than copied where possible.
"""

__version__ = "0.1.0-exp"
