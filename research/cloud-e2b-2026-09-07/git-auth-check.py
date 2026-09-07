"""Exercise Git credential delivery against a loopback-only synthetic repository."""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
from urllib.parse import urlsplit


HELPER = r'''
import json
from pathlib import Path
import sys

if sys.argv[1:] != ["get"]:
    sys.exit(0)
fields = {}
raw = sys.stdin.read(8193)
assert len(raw) <= 8192
for line in raw.splitlines():
    if not line:
        break
    key, separator, value = line.partition("=")
    if key in {"capability[]", "wwwauth[]"} and separator:
        continue
    if not separator or key in fields:
        sys.exit(1)
    fields[key] = value
scope = json.loads(Path(__file__).with_name("scope.json").read_text())
expected = {key: scope[key] for key in ["protocol", "host", "path"]}
if (
    {key: fields.get(key) for key in expected} != expected
    or set(fields) - {"protocol", "host", "path", "username"}
    or fields.get("username", "fixture") != "fixture"
):
    print("quit=true\n")
    sys.exit(0)
token = Path(__file__).with_name("token").read_text().strip()
assert token.startswith("SYNTHETIC_") and "\n" not in token
print(f"username=fixture\npassword={token}\n")
'''

with tempfile.TemporaryDirectory(prefix="station-cloud-git-auth-") as directory:
    root = Path(directory)
    home = root / "home"
    home.mkdir()
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ALLOW_PROTOCOL": "file:http",
        "GIT_AUTHOR_NAME": "Synthetic Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Synthetic Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        "GIT_AUTHOR_DATE": "2026-09-07T12:00:00Z",
        "GIT_COMMITTER_DATE": "2026-09-07T12:00:00Z",
    }
    tokens = ["SYNTHETIC_FIRST_TOKEN", "SYNTHETIC_REFRESHED_TOKEN"]
    accepted_token = tokens[0]
    process_arguments = []
    calls = []
    server_errors = []
    drop_response = False

    def git(repo, *arguments, check=True, input=None):
        argv = [
            "/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
            "-c", "credential.helper=", "-c", "credential.useHttpPath=true",
            "-c", "http.followRedirects=false", "-C", str(repo), *arguments,
        ]
        process_arguments.append(argv)
        result = subprocess.run(argv, input=input, env=environment, capture_output=True, timeout=10)
        if check and result.returncode != 0:
            diagnostic = result.stderr.decode()
            for token in tokens:
                diagnostic = diagnostic.replace(token, "[synthetic token]")
            raise AssertionError(f"fixture Git command failed: {diagnostic}; server errors: {server_errors}")
        return result

    source = root / "source"
    source.mkdir()
    git(source, "init", "-b", "main")
    (source / "fixture.txt").write_text("synthetic source\n")
    git(source, "add", ".")
    git(source, "commit", "-m", "Synthetic source")
    expected_head = git(source, "rev-parse", "HEAD").stdout.strip()
    repositories = root / "repositories"
    repositories.mkdir()
    git(root, "clone", "--bare", str(source), str(repositories / "repo.git"))
    backend = Path(git(root, "--exec-path").stdout.decode().strip()) / "git-http-backend"

    class Server(BaseHTTPRequestHandler):
        def log_message(self, *_arguments):
            pass

        def do_GET(self):
            self.handle_git()

        def do_POST(self):
            self.handle_git()

        def handle_git(self):
            try:
                assert self.client_address[0] == "127.0.0.1"
                parts = urlsplit(self.path)
                assert parts.path in [
                    "/repo.git/info/refs", "/repo.git/git-upload-pack", "/other.git/info/refs"
                ]
                header = "Basic " + base64.b64encode(f"fixture:{accepted_token}".encode()).decode()
                authorized = self.headers.get("Authorization") == header
                calls.append({"method": self.command, "path": parts.path, "authorized": authorized,
                              "credentialProvided": self.headers.get("Authorization") is not None})
                if not authorized:
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="synthetic-fixture"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                assert parts.path.startswith("/repo.git/")
                if drop_response:
                    self.close_connection = True
                    return
                length = int(self.headers.get("Content-Length", "0"))
                assert 0 <= length <= 1_048_576
                payload = self.rfile.read(length)
                cgi_environment = {
                    **environment,
                    "GIT_PROJECT_ROOT": str(repositories),
                    "GIT_HTTP_EXPORT_ALL": "1",
                    "PATH_INFO": parts.path,
                    "QUERY_STRING": parts.query,
                    "REQUEST_METHOD": self.command,
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": str(length),
                    "REMOTE_USER": "fixture",
                    "REMOTE_ADDR": "127.0.0.1",
                }
                result = subprocess.run([str(backend)], input=payload, env=cgi_environment,
                                        capture_output=True, check=True, timeout=5)
                raw_headers, separator, body = result.stdout.partition(b"\r\n\r\n")
                assert separator
                headers = [line.decode().split(": ", 1) for line in raw_headers.split(b"\r\n")]
                status = next((int(value.split()[0]) for key, value in headers if key == "Status"), 200)
                self.send_response(status)
                for key, value in headers:
                    if key != "Status":
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:
                server_errors.append(str(error))
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Server)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host = f"127.0.0.1:{server.server_port}"
        origin = f"http://{host}"
        helper = root / "helper"
        helper.write_text(f"#!{sys.executable}\n" + HELPER)
        helper.chmod(0o700)
        (root / "scope.json").write_text(json.dumps({"protocol": "http", "host": host, "path": "repo.git"}))
        token_file = root / "token"
        token_file.write_text(tokens[0])
        token_file.chmod(0o600)
        helper_option = ["-c", f"credential.helper={helper}"]
        receiver = root / "receiver"
        git(root, *helper_option, "clone", origin + "/repo.git", str(receiver))
        assert git(receiver, "rev-parse", "HEAD").stdout.strip() == expected_head
        assert git(receiver, "remote", "get-url", "origin").stdout.decode().strip() == origin + "/repo.git"
        config_before = (receiver / ".git/config").read_bytes()

        before_other = len(calls)
        denied = git(root, *helper_option, "ls-remote", origin + "/other.git", check=False)
        assert denied.returncode != 0
        assert len(calls) > before_other
        assert all(not call["credentialProvided"] for call in calls[before_other:])

        for scope in [
            f"protocol=https\nhost={host}\npath=repo.git\n\n",
            "protocol=http\nhost=example.invalid\npath=repo.git\n\n",
        ]:
            rejected = subprocess.run([str(helper), "get"], input=scope.encode(), env=environment,
                                      capture_output=True, check=True, timeout=5)
            assert rejected.stdout == b"quit=true\n\n"

        accepted_token = tokens[1]
        assert git(receiver, *helper_option, "fetch", "origin", check=False).returncode != 0
        token_file.write_text(tokens[1])
        git(receiver, *helper_option, "fetch", "origin")
        assert (receiver / ".git/config").read_bytes() == config_before

        drop_response = True
        assert git(receiver, *helper_option, "fetch", "origin", check=False).returncode != 0
        assert (receiver / ".git/config").read_bytes() == config_before
        assert all(token not in json.dumps(process_arguments) for token in tokens)
        assert all(token.encode() not in config_before for token in tokens)
        assert not (home / ".git-credentials").exists()
        assert not (home / ".gitconfig").exists()
        assert server_errors == []
        results = {
            "evidence": "synthetic credentials and repositories over loopback HTTP only; not GitHub or E2B",
            "git": git(root, "--version").stdout.decode().strip(),
            "requests": len(calls),
            "checks": [
                "scoped temporary helper completes a real smart-HTTP Git clone with exact HEAD",
                "a different repository path receives no credential and access fails",
                "helper refuses different protocol and host without a network request",
                "stale credential fails and replacing its secret reference enables the next fetch",
                "lost fetch response fails without rewriting repository configuration",
                "tokens remain absent from invoked argv and origin/config; no persistent credential store",
            ],
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()

assert not root.exists()
results["temporaryResources"] = "server closed and repositories, helper, synthetic token removed"
print(json.dumps(results, indent=2))
