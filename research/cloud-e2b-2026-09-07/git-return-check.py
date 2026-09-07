"""Exercise candidate result return with synthetic Git repositories and no network."""

import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import tarfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


with tempfile.TemporaryDirectory(prefix="station-cloud-git-") as directory:
    root = Path(directory)
    home = root / "home"
    home.mkdir()
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_AUTHOR_NAME": "Synthetic Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Synthetic Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        "GIT_AUTHOR_DATE": "2026-09-07T12:00:00Z",
        "GIT_COMMITTER_DATE": "2026-09-07T12:00:00Z",
    }

    def git(repo, *arguments, check=True):
        return subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", str(repo), *arguments],
            env=environment, capture_output=True, check=check,
        )

    def value(repo, *arguments):
        return git(repo, *arguments).stdout.decode().strip()

    source = root / "source"
    source.mkdir()
    git(source, "init", "-b", "main")
    (source / "former.secret").write_text("SYNTHETIC_DELETED_HISTORY_VALUE\n")
    git(source, "add", "former.secret")
    git(source, "commit", "-m", "Synthetic history")
    history = value(source, "rev-parse", "HEAD")
    git(source, "rm", "former.secret")
    (source / "text.txt").write_text("initial\n")
    (source / "remove.txt").write_text("remove me\n")
    (source / "binary.bin").write_bytes(bytes(range(256)))
    (source / "version.txt").write_text("$Format:%H$\n")
    (source / ".gitignore").write_text("ignored.secret\n")
    (source / ".gitattributes").write_text("remove.txt export-ignore\nversion.txt export-subst\n")
    git(source, "add", ".")
    git(source, "commit", "-m", "Synthetic base")
    base = value(source, "rev-parse", "HEAD")

    archive = git(source, "archive", "--format=tar", base).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as archived:
        assert "remove.txt" not in archived.getnames()
        assert archived.extractfile("version.txt").read().decode().strip() == base
    assert value(source, "show", base + ":remove.txt") == "remove me"
    assert value(source, "show", base + ":version.txt") == "$Format:%H$"
    # The override belongs only to this disposable fixture, never the user's repository.
    (source / ".git/info/attributes").write_text("* -export-ignore -export-subst\n")
    exact_archive = git(source, "archive", "--format=tar", base).stdout
    with tarfile.open(fileobj=io.BytesIO(exact_archive)) as archived:
        assert archived.extractfile("remove.txt").read() == b"remove me\n"
        assert archived.extractfile("version.txt").read() == b"$Format:%H$\n"
    seed_bundle = root / "seed.bundle"
    git(source, "bundle", "create", str(seed_bundle), "HEAD")
    seed_receiver = root / "seed-receiver"
    git(root, "clone", str(seed_bundle), str(seed_receiver))
    assert not (seed_receiver / "former.secret").exists()
    assert value(seed_receiver, "show", history + ":former.secret") == "SYNTHETIC_DELETED_HISTORY_VALUE"

    remote = root / "remote"
    receiver = root / "receiver"
    for destination in [remote, receiver]:
        git(root, "clone", "--no-hardlinks", str(source), str(destination))
    git(remote, "checkout", "-b", "result")
    git(remote, "mv", "text.txt", "renamed.txt")
    (remote / "renamed.txt").write_text("remote result\n")
    git(remote, "rm", "remove.txt")
    (remote / "binary.bin").write_bytes(bytes(reversed(range(256))))
    (remote / "added.txt").write_text("new tracked result\n")
    (remote / "ignored.secret").write_text("SYNTHETIC_IGNORED_VALUE\n")
    (remote / "untracked.txt").write_text("must not be silently lost\n")
    git(remote, "add", "renamed.txt", "binary.bin", "added.txt")
    git(remote, "commit", "-m", "Synthetic result")
    head = value(remote, "rev-parse", "HEAD")
    status = git(remote, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
    assert b"untracked.txt" in status
    assert b"ignored.secret" not in status

    # A commit artifact has no representation for untracked or ignored work.
    bundle = root / "result.bundle"
    git(remote, "bundle", "create", str(bundle), "refs/heads/result", "^" + base)
    assert b"SYNTHETIC_IGNORED_VALUE" not in bundle.read_bytes()
    bundle_digest = digest(bundle)
    assert bundle.stat().st_size < 1024 * 1024
    git(receiver, "bundle", "verify", str(bundle))
    assert value(receiver, "bundle", "list-heads", str(bundle)) == head + " refs/heads/result"

    # Fetch objects into an inspection ref. Preserve unrelated local working bytes.
    (receiver / "text.txt").write_text("concurrent local edit\n")
    local_digest = digest(receiver / "text.txt")
    local_head = value(receiver, "rev-parse", "HEAD")
    git(receiver, "fetch", str(bundle), "refs/heads/result:refs/research/result")
    assert value(receiver, "rev-parse", "HEAD") == local_head == base
    assert digest(receiver / "text.txt") == local_digest
    assert value(receiver, "rev-parse", "refs/research/result") == head
    git(receiver, "merge-base", "--is-ancestor", base, head)
    git(receiver, "fsck", "--strict", "--no-reflogs")
    inspect = root / "inspect"
    git(receiver, "worktree", "add", "--detach", str(inspect), "refs/research/result")
    assert value(inspect, "rev-parse", "HEAD^{tree}") == value(remote, "rev-parse", "HEAD^{tree}")
    assert (inspect / "binary.bin").read_bytes() == (remote / "binary.bin").read_bytes()
    assert not (inspect / "remove.txt").exists()
    assert not (inspect / "untracked.txt").exists()
    assert not (inspect / "ignored.secret").exists()

    missing = root / "missing-base"
    missing.mkdir()
    git(missing, "init", "-b", "main")
    assert git(missing, "bundle", "verify", str(bundle), check=False).returncode != 0
    corrupt = root / "corrupt.bundle"
    corrupt.write_bytes(bundle.read_bytes()[:-24])
    assert digest(corrupt) != bundle_digest
    # Git can skip the pack when the destination already has the advertised objects.
    assert git(receiver, "fetch", str(corrupt), "refs/heads/result:refs/research/corrupt", check=False).returncode == 0
    fresh = root / "fresh"
    git(root, "clone", "--no-hardlinks", str(source), str(fresh))
    assert git(fresh, "fetch", str(corrupt), "refs/heads/result:refs/research/corrupt", check=False).returncode != 0

    patch = root / "result.patch"
    patch.write_bytes(git(remote, "diff", "--binary", "--full-index", base, head).stdout)
    patch_receiver = root / "patch-receiver"
    git(root, "clone", "--no-hardlinks", str(source), str(patch_receiver))
    git(patch_receiver, "apply", "--check", "--index", str(patch))
    git(patch_receiver, "apply", "--index", str(patch))
    assert value(patch_receiver, "write-tree") == value(remote, "rev-parse", "HEAD^{tree}")
    assert git(receiver, "apply", "--check", "--index", str(patch), check=False).returncode != 0
    assert digest(receiver / "text.txt") == local_digest

    print(json.dumps({
        "evidence": "local synthetic Git repositories only; not an E2B transfer or private repository proof",
        "git": subprocess.check_output(["git", "--version"], env=environment, text=True).strip(),
        "checks": [
            "bundle preserves exact commit, tree, binary modification, addition, rename and deletion",
            "inspection ref and separate worktree preserve concurrent local edits and HEAD",
            "bundle requires the declared base commit",
            "independent digest rejects truncation even when Git fetch skips already-present objects",
            "a fresh receiver rejects the truncated Git pack",
            "binary full-index patch reproduces the exact result tree in a clean receiver",
            "patch application refuses the dirty receiver without changing local bytes",
            "commit artifacts exclude untracked and ignored files; dirty inventory must be explicit",
            "git archive honors export-ignore and can omit files from the exact committed tree",
            "git archive honors export-subst and can change committed file content",
            "disposable repository info/attributes overrides preserve both fixture files exactly",
            "a full HEAD source bundle includes deleted historical files outside the current tree",
        ],
        "bundleBytes": bundle.stat().st_size,
        "patchBytes": patch.stat().st_size,
        "temporaryResources": "removed on exit",
    }, indent=2))
