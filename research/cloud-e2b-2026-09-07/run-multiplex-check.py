"""Run the pinned E2B output fan-out code locally, with network/toolchain download disabled."""

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(source).hexdigest() == "c8969a925e8970ae6ec5156cdb77300434437bf583107f135241687c3b1b55b4"
go = sys.argv[2] if len(sys.argv) > 2 else "go"
with tempfile.TemporaryDirectory(prefix="station-cloud-multiplex-") as directory:
    root = Path(directory)
    # Only the package declaration changes, to compile the original code beside the probe.
    (root / "multiplex.go").write_bytes(source.replace(b"package handler", b"package main", 1))
    (root / "main.go").write_bytes(Path(__file__).with_name("multiplex-check.go").read_bytes())
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(root),
        "GOTOOLCHAIN": "local",
        "GOPROXY": "off",
        "GOSUMDB": "off",
        "GOENV": "off",
        "GOCACHE": str(root / "cache"),
    }
    subprocess.run([go, "version"], env=environment, check=True)
    subprocess.run([go, "run", str(root / "multiplex.go"), str(root / "main.go")], env=environment, check=True, timeout=120)
