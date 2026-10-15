"""Fail-closed source/artifact checks for deploy.yml; no publishing APIs or credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

REPOSITORY = "evanlin23/BrainrotTCG"


def source(env):
    expected = {"GITHUB_REPOSITORY": REPOSITORY, "GITHUB_REF": "refs/heads/main"}
    if any(env.get(key) != value for key, value in expected.items()):
        raise ValueError("Only this repository's exact main ref may publish")
    if env.get("GITHUB_EVENT_NAME") not in {"push", "workflow_dispatch"}:
        raise ValueError("Unsupported deployment event")
    if not re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")):
        raise ValueError("Invalid source revision")
    for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        if not re.fullmatch(r"[1-9][0-9]*", env.get(key, "")):
            raise ValueError("Invalid run identity")


def metadata(env):
    source(env)
    host, url = env.get("SITE_HOST"), env.get("SITE_URL", "")
    parsed = urlsplit(url)
    if (any(char.isspace() for char in url) or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.port is not None or parsed.query or parsed.fragment):
        raise ValueError("Site URL must be a plain HTTPS address")
    if host == "github":
        if url != "https://evanlin23.github.io/BrainrotTCG/":
            raise ValueError("Unexpected GitHub Pages address")
        base = "/BrainrotTCG/"
    elif host == "cloudflare":
        if parsed.path != "/" or not re.fullmatch(r"[a-z0-9.-]+", parsed.hostname):
            raise ValueError("Cloudflare site must have a root HTTPS URL")
        base = "/"
    else:
        raise ValueError("Unknown deployment host")
    return {"repository": REPOSITORY, "sha": env["GITHUB_SHA"],
            "run_id": env["GITHUB_RUN_ID"], "run_attempt": env["GITHUB_RUN_ATTEMPT"],
            "host": host, "url": url, "base": base}


def files(root):
    entries = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Deployment artifacts cannot contain symlinks")
        if path.is_dir():
            continue
        name = path.relative_to(root).as_posix()
        if name == "deployment.json":
            continue
        if not path.is_file() or name.split("/", 1)[0] not in {"dist", "pages"}:
            raise ValueError("Unexpected deployment artifact entry")
        entries[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return entries


def contract(root, env):
    meta = metadata(env)
    entries = files(root)
    required = {"dist/index.html", "dist/deployment-id.json"}
    if meta["host"] == "cloudflare":
        required.update({"pages/index.html", "pages/404.html"})
    elif any(name.startswith("pages/") for name in entries):
        raise ValueError("Unexpected forwarding artifact for GitHub hosting")
    if not required.issubset(entries) or not any(name.startswith("dist/assets/") and name.endswith(".js") for name in entries):
        raise ValueError("Deployment artifact is incomplete")
    return {**meta, "files": entries}


def seal(root, env):
    manifest = root / "deployment.json"
    (root / "dist/deployment-id.json").write_text(json.dumps(metadata(env), sort_keys=True) + "\n")
    manifest.write_text(json.dumps(contract(root, env), sort_keys=True, separators=(",", ":")) + "\n")
    return hashlib.sha256(manifest.read_bytes()).hexdigest()


def verify(root, env, digest):
    manifest = root / "deployment.json"
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or hashlib.sha256(manifest.read_bytes()).hexdigest() != digest:
        raise ValueError("Deployment manifest does not match the verified build")
    if json.loads(manifest.read_text()) != contract(root, env):
        raise ValueError("Deployment source, run, host or file hashes do not match")


def current_main(env):
    source(env)
    request = Request(f"https://api.github.com/repos/{REPOSITORY}/git/ref/heads/main", headers={
        "Authorization": f"Bearer {env['GITHUB_TOKEN']}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"})
    with urlopen(request, timeout=30) as response:
        revision = json.load(response)["object"]["sha"]
    if revision != env["GITHUB_SHA"]:
        raise ValueError("This build is stale: main has advanced")


if __name__ == "__main__":
    try:
        command = sys.argv[1]
        if command == "source":
            source(os.environ)
        elif command == "current-main":
            current_main(os.environ)
        elif command == "seal":
            digest = seal(Path(sys.argv[2]), os.environ)
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                output.write(f"manifest_sha256={digest}\n")
        elif command == "verify":
            verify(Path(sys.argv[2]), os.environ, os.environ["MANIFEST_SHA256"])
        else:
            raise ValueError("Unknown deployment check")
    except (ValueError, KeyError, OSError, IndexError) as error:
        print(f"Deployment rejected: {error}", file=sys.stderr)
        sys.exit(1)
