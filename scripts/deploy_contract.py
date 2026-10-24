"""What the deploy workflow promises, checked offline (docs/HOSTING.md).

  seal DIR          (build)   write DIR/dist/deployment-id.json and a manifest of every file's hash;
                              prints manifest_sha256=<hash of the manifest> for $GITHUB_OUTPUT
  verify DIR        (publish) the downloaded files are exactly the ones build sealed in this run
  served DIR URL    (stage, publish) verify, then check URL serves every sealed file with its sealed
                              hash; prints the release's identity as Markdown for $GITHUB_STEP_SUMMARY
  deployed DIR URL [--once]  (stage, staging-checks) wait until URL serves this run's
                              DIR/dist/deployment-id.json (--once: check once, before the browser checks)
  check-workflows   (CI) .github/workflows do what docs/HOSTING.md says, read from the YAML

Standard library only, so the jobs that run it install nothing. Run it with `python3 -I`.
"""
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')


class Rejected(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


# --- Sealed handoff between build and publish -------------------------------------------------

def marker(env):
    """What dist/deployment-id.json says: which commit, run and address this build is for."""
    repository, sha, run_id, url = (env.get(k, '') for k in ('GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'SITE_URL'))
    require(re.fullmatch(r'[\w.-]+/[\w.-]+', repository), 'GITHUB_REPOSITORY is missing or malformed')
    require(SHA.fullmatch(sha), 'GITHUB_SHA is not a full commit hash')
    require(re.fullmatch(r'[1-9][0-9]*', run_id), 'GITHUB_RUN_ID is not a run number')
    # The trailing / is optional in SITE_URL; the marker always has exactly one.
    return {'repository': repository, 'run_id': run_id, 'sha': sha, 'url': address(url, 'SITE_URL')}


def address(url, what):
    """url ending in exactly one /, if it is a plain https:// address with or without one."""
    parts = urlsplit(url)
    require(not re.search(r'[\s?#]', url) and parts.scheme == 'https' and parts.hostname
            and not parts.username and not parts.password and parts.port is None and parts.path in ('', '/'),
            f'{what} {url!r} must be a plain https:// address, with or without one trailing /')
    return url.removesuffix('/') + '/'


def canonical(value, **options):
    return json.dumps(value, sort_keys=True, **options) + '\n'


def hashes(dist):
    files = {}
    for path in sorted(dist.rglob('*')):
        name = path.relative_to(dist).as_posix()
        require(not path.is_symlink(), f'{name} is a symlink')
        if path.is_dir():
            continue
        require(path.is_file(), f'{name} is not a regular file')
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    require('index.html' in files, 'dist/index.html is missing')
    # Wrangler would run these as server code; this site is static files only.
    for name in ('_worker.js', '_routes.json'):
        require(not (dist / name).exists(), f'dist/{name} would turn on server code')
    return files


def seal(release, env):
    dist = release / 'dist'
    require(dist.is_dir() and not dist.is_symlink(), f'{dist} is not a directory')
    require(set(release.iterdir()) == {dist}, f'{release} must hold only dist/')
    stamp = dist / 'deployment-id.json'
    require(not stamp.exists(), 'dist/deployment-id.json already exists')
    expected = marker(env)
    hashes(dist)  # refuse before writing anything
    stamp.write_text(canonical(expected), encoding='utf-8')
    manifest = release / 'manifest.json'
    manifest.write_text(canonical({'marker': expected, 'files': hashes(dist)}, separators=(',', ':')), encoding='utf-8')
    return hashlib.sha256(manifest.read_bytes()).hexdigest()


def verify(release, env, digest):
    require(DIGEST.fullmatch(digest or ''), 'MANIFEST_SHA256 is missing or malformed')
    dist, manifest = release / 'dist', release / 'manifest.json'
    require(set(release.iterdir()) == {dist, manifest}, f'{release} must hold only dist/ and manifest.json')
    require(manifest.is_file() and not manifest.is_symlink(), 'manifest.json is not a regular file')
    require(hashlib.sha256(manifest.read_bytes()).hexdigest() == digest, "manifest.json isn't the one build sealed")
    sealed = json.loads(manifest.read_text(encoding='utf-8'))
    expected = marker(env)
    require(sealed.get('marker') == expected, 'the sealed build is for another commit, run or address')
    require(sealed.get('files') == hashes(dist), "the files don't match the sealed hashes")
    require((dist / 'deployment-id.json').read_text(encoding='utf-8') == canonical(expected),
            "dist/deployment-id.json doesn't name this run")
    return sealed


# --- What an address serves ----------------------------------------------------------------------
# Staging and then production are checked the same way: each file build sealed, fetched where
# Cloudflare Pages serves it, has its sealed hash. Pages serves a.html at /a and dir/index.html at
# /dir/, and answers an unknown path with index.html, so a missing file fails too.

UNSERVED = {'_headers', '_redirects'}  # Pages reads these as settings and doesn't serve them

# Cloudflare Pages' automatic Web Analytics setup (docs/HOSTING.md#web-analytics) adds this tag, byte
# for byte as Pages serves it, just before each page's </body>. Our build never writes it.
BEACON_TAG = re.compile(
    rb"<!-- Cloudflare Pages Analytics --><script defer src='https://static\.cloudflareinsights\.com/beacon\.min\.js' "
    rb"data-cf-beacon='\{\"token\": \"([0-9a-f]{32})\"\}'></script><!-- Cloudflare Pages Analytics --></body>")


def without_beacon(name, body):
    """body with the one Web Analytics tag Pages adds to a page taken out, and that tag's token, or
    (body, None) when it has none. Only that exact tag, once, right before </body>, in an .html file: a
    second tag, a tag elsewhere or changed, or one in any other file stays in, so the file then differs
    from its sealed copy. Not an HTML normaliser."""
    tag = BEACON_TAG.search(body) if name.endswith('.html') else None
    if not tag:
        return body, None
    return body[:tag.start()] + b'</body>' + body[tag.end():], tag.group(1).decode()


def served_path(name):
    """Where Cloudflare Pages serves dist/<name>, relative to the site's root."""
    if name == 'index.html' or name.endswith('/index.html'):
        name = name.removesuffix('index.html')
    elif name.endswith('.html'):
        name = name.removesuffix('.html')
    return quote(name)


class SameOrigin(urllib.request.HTTPRedirectHandler):
    """Follows redirects only within the address being checked."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl)[:2] != urlsplit(req.full_url)[:2]:
            raise HTTPError(newurl, code, f'redirects to another origin: {newurl}', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, headers=None):
    """The body url serves, uncompressed (the bytes as sealed), or raises. headers go to url's origin
    only: SameOrigin refuses a redirect anywhere else before following it."""
    request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'brainrottcg-deploy-check',
                                                   **(headers or {})})
    with urllib.request.build_opener(SameOrigin).open(request, timeout=30) as response:
        return response.read()


# --- Cloudflare Access on staging ----------------------------------------------------------------
# The project's Access app covers its preview deployments, staging included (docs/HOSTING.md#staging).
# The steps that fetch staging name the repository secrets CF_ACCESS_CLIENT_ID and
# CF_ACCESS_CLIENT_SECRET in their env (empty when unset), and only those send the service token, to
# the address they check. Access in strict mode returns no CF_Authorization cookie, so every request
# sends the headers (https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).

ACCESS_HELP = 'docs/HOSTING.md#staging'
REDIRECTS = {301, 302, 303, 307, 308}


class AccessRefused(Rejected):
    pass


def access_headers(env):
    """The service token's headers; {} with both secrets empty; None in a step that doesn't name them."""
    if 'CF_ACCESS_CLIENT_ID' not in env and 'CF_ACCESS_CLIENT_SECRET' not in env:
        return None
    client_id, secret = env.get('CF_ACCESS_CLIENT_ID', ''), env.get('CF_ACCESS_CLIENT_SECRET', '')
    if not client_id and not secret:
        return {}
    if not (client_id and secret):
        raise AccessRefused(f"Only {'CF_ACCESS_CLIENT_ID' if client_id else 'CF_ACCESS_CLIENT_SECRET'} is set: the Access service "
                            f'token needs both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET ({ACCESS_HELP}).')
    return {'CF-Access-Client-Id': client_id, 'CF-Access-Client-Secret': secret}


def access_refusal(error):
    """Why Access refused a fetch, from its HTTPError: a 401, a 403 or a redirect to its login. None if not."""
    if error.code in (401, 403):
        return f'HTTP {error.code}'
    target = urlsplit(error.filename or '')
    if error.code in REDIRECTS and ((target.hostname or '').endswith('.cloudflareaccess.com') or target.path.startswith('/cdn-cgi/access/')):
        return f'HTTP {error.code} to the Access login at {target.scheme}://{target.netloc}'
    return None


def check_access(error, base, token):
    """Fails closed, naming the token, when error is Access refusing a step that may meet it."""
    why = access_refusal(error) if token is not None else None
    if why and token:
        raise AccessRefused(f'Cloudflare Access rejected the service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET at {base} '
                            f"({why}). Check the token hasn't expired or been revoked, and that the project's Access app has a "
                            f'Service Auth policy that includes it ({ACCESS_HELP}).')
    if why:
        raise AccessRefused(f'{base} is behind Cloudflare Access ({why}) and no Access service token is set. Add the repository '
                            'secrets CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET for a token with a Service Auth policy on '
                            f"the project's Access app ({ACCESS_HELP}).")


def deployed(release, env, url, once=False, get=None, tries=30, pause=10.0):
    """Waits until url serves this run's dist/deployment-id.json (once: checks it once)."""
    base = address(url, 'The address to check')
    token = access_headers(env)
    get = get or partial(fetch, headers=token)
    want = (Path(release) / 'dist/deployment-id.json').read_bytes()
    target = f"{base}deployment-id.json?run={env.get('GITHUB_RUN_ID', '')}-{env.get('GITHUB_RUN_ATTEMPT', '')}"
    for attempt in range(1 if once else tries):
        if attempt:
            time.sleep(pause)  # a new deployment can take a while to reach every edge
        try:
            if get(target) == want:
                return
        except HTTPError as error:
            check_access(error, base, token)
        except OSError:
            pass
    require(False, f'{base} no longer serves this build, so its checks would test other files. Start a new deploy on main '
                   'instead of re-running this one.' if once else f"{base} isn't serving this build")


def served(release, env, digest, url, get=None, tries=3, pause=5.0):
    """verify, then check url serves every sealed file with its sealed hash. Returns the release's
    identity as Markdown, for the step summary."""
    sealed = verify(release, env, digest)
    base = address(url, 'The address to check')
    token = access_headers(env)
    get = get or partial(fetch, headers=token)
    files = sealed['files']

    tokens = {}  # page -> the Web Analytics token Pages added to it

    def problem(name):
        why = ''
        for attempt in range(tries):
            if attempt:
                time.sleep(pause)  # a new deployment can take a moment to reach every edge
            try:
                body, beacon_token = without_beacon(name, get(base + served_path(name)))
                if hashlib.sha256(body).hexdigest() == files[name]:
                    if beacon_token:
                        tokens[name] = beacon_token
                    return None
                why = 'different content'
            except HTTPError as error:
                check_access(error, base, token)
                why = f'HTTP {error.code}'
            except OSError as error:
                why = str(error) or type(error).__name__
        return f'/{served_path(name)}: {why}'

    names = [name for name in files if name not in UNSERVED]
    with ThreadPoolExecutor(max_workers=32) as pool:
        problems = [p for p in pool.map(problem, names) if p]
    require(not problems, '\n  '.join(
        [f"{base} doesn't serve {len(problems)} of the {len(names)} sealed files as sealed, with Web Analytics' one tag "
         'taken out of each page. If only pages differ, turn off any other Cloudflare setting that edits pages, and '
         "keep Web Analytics on automatic setup (docs/HOSTING.md#web-analytics):"]
        + problems[:20] + ([f'and {len(problems) - 20} more'] if len(problems) > 20 else [])))
    require(len(set(tokens.values())) <= 1, f'{base} adds Web Analytics tags with different tokens to its pages')
    pages = sum(name.endswith('.html') for name in names)
    beacon = f'tag seen on {len(tokens)} of {pages} pages and taken out before comparing' if tokens else 'no tag seen'
    print(f'Cloudflare Web Analytics: {beacon}.', file=sys.stderr)
    marker_ = sealed['marker']
    return '\n'.join([
        f'### Release served at {base}', '',
        '| | |', '|---|---|',
        f"| Commit | `{marker_['sha']}` |",
        f"| Run | {marker_['run_id']} |",
        f"| Built for | {marker_['url']} (base path /) |",
        f'| Manifest sha256 | `{digest}` |',
        f'| Files | {len(names)}, each served with its sealed hash |',
        f"| hall-of-fame.json sha256 | `{files.get('hall-of-fame.json', 'none')}` |",
        f'| Cloudflare Web Analytics | {beacon} |', ''])


# --- Workflow files ------------------------------------------------------------------------------
# A reader for the YAML these workflows use: block mappings and sequences, | block scalars, flow
# [a, b] lists and {}, quoted and plain scalars, comments. Anything else is refused rather than
# guessed at, and the test compares it with PyYAML where that is installed.

KEY = re.compile(r'([A-Za-z0-9_.-]+):(?: +(.*))?$')


class Yaml:
    def __init__(self, text, name):
        require('\t' not in text, f'{name}: tabs')
        self.lines, self.i, self.name = text.split('\n'), 0, name

    def fail(self, message):
        raise Rejected(f'{self.name}:{self.i + 1}: {message}')

    def peek(self):
        while self.i < len(self.lines):
            line = self.lines[self.i]
            if line.strip() and not line.lstrip().startswith('#'):
                return len(line) - len(line.lstrip(' ')), line.strip()
            self.i += 1
        return None

    def document(self):
        start = self.peek()
        value = self.block(start[0]) if start else None
        if self.peek():
            self.fail('unexpected indentation')
        return value

    def block(self, indent):
        line = self.peek()
        return self.sequence(indent) if line[1] == '-' or line[1].startswith('- ') else self.mapping(indent)

    def mapping(self, indent):
        result = {}
        while (line := self.peek()) and line[0] >= indent:
            if line[0] > indent:
                self.fail('unexpected indentation')
            if line[1] == '-' or line[1].startswith('- '):
                break
            match = KEY.match(line[1]) or self.fail(f'not a key: {line[1]}')
            key, rest = match[1], match[2]
            if key in result:
                self.fail(f'duplicate key {key}')
            if rest is None or rest.startswith('#'):
                self.i += 1
                after = self.peek()
                if after and (after[0] > indent or (after[0] == indent and (after[1] == '-' or after[1].startswith('- ')))):
                    result[key] = self.block(after[0])
                else:
                    result[key] = None
            else:
                result[key] = self.value(rest, indent)
        return result

    def sequence(self, indent):
        items = []
        while (line := self.peek()) and line[0] == indent and (line[1] == '-' or line[1].startswith('- ')):
            rest = line[1][1:].lstrip(' ')
            if not rest or rest.startswith('#'):
                self.i += 1
                after = self.peek()
                items.append(self.block(after[0]) if after and after[0] > indent else None)
            elif KEY.match(rest):
                raw = self.lines[self.i]
                self.lines[self.i] = raw[:indent] + ' ' + raw[indent + 1:]
                # The item's keys line up with the first one, just after the dash.
                items.append(self.mapping(len(raw) - len(raw[indent + 1:].lstrip(' '))))
            else:
                items.append(self.value(rest, indent))
        if (line := self.peek()) and line[0] > indent:
            self.fail('unexpected indentation')
        return items

    def value(self, text, indent):
        if text in ('|', '|-'):
            return self.literal(indent, text == '|')
        self.i += 1
        if text[0] in '\'"':
            quote = text[0]
            end = text.find(quote, 1)
            while quote == "'" and end != -1 and text[end + 1:end + 2] == "'":
                end = text.find(quote, end + 2)
            if end == -1 or (quote == '"' and '\\' in text[:end]):
                self.fail('unsupported quoted scalar')
            tail = text[end + 1:].strip()
            if tail and not tail.startswith('#'):
                self.fail('text after a quoted scalar')
            return text[1:end].replace("''", "'") if quote == "'" else text[1:end]
        text = re.split(r'\s+#', text, maxsplit=1)[0].rstrip()
        if text[0] in '[{':
            if text == '{}':
                return {}
            if text[0] == '{' or not text.endswith(']') or re.search(r'[\[\]{}"\']', text[1:-1]):
                self.fail('unsupported flow collection')
            return [self.scalar(item.strip()) for item in text[1:-1].split(',') if item.strip()]
        if text[0] in '>&*!%@`|?':
            self.fail(f'unsupported scalar {text}')
        return self.scalar(text)

    def scalar(self, text):
        if text in ('true', 'false'):
            return text == 'true'
        if text in ('null', '~'):
            return None
        return int(text) if re.fullmatch(r'-?[0-9]+', text) else text

    def literal(self, indent, keep_newline):
        self.i += 1
        lines, inner = [], None
        while self.i < len(self.lines):
            line = self.lines[self.i]
            depth = len(line) - len(line.lstrip(' '))
            if line.strip():
                if depth <= indent or (inner is not None and depth < inner):
                    break
                inner = inner if inner is not None else depth
                lines.append(line[inner:])
            else:
                lines.append('')
            self.i += 1
        while lines and not lines[-1]:
            lines.pop()
        return '\n'.join(lines) + ('\n' if keep_newline and lines else '')


def load(path):
    return Yaml(path.read_text(encoding='utf-8'), path.name).document()


def walk(node, path=()):
    """Every (path, key or string) in a parsed workflow."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield path + (key,), key
            yield from walk(value, path + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk(value, path + (index,))
    elif isinstance(node, str):
        yield path, node


CLOUDFLARE = "needs.site.outputs.host == 'cloudflare'"
# Staging is on: Cloudflare is ready and CLOUDFLARE_STAGING_BRANCH names a valid branch (site checks both).
STAGING = "needs.site.outputs.staging_url != ''"
GUARD ={'name': 'Require the main source ref', 'env': {'SOURCE_REF': '${{ github.ref }}'},
         'run': 'test "$SOURCE_REF" = refs/heads/main'}
# publish and deploy each start by checking this run's commit is still main's tip, so re-running a run
# whose commit main has moved past (or only its publish or deploy job) fails instead of publishing an
# older build. It compares commits, not runs: a re-run of an earlier run on main's current commit (an
# older Hall of Fame refresh) still passes. A failed lookup refuses with its own error. The step names
# no shell, so on ubuntu-latest it runs as `bash -e {0}`: -e without pipefail (only `shell: bash` adds
# pipefail, and `shell: sh` is `sh -e {0}`). The snippet relies on neither: the lookup runs outside any
# pipe, and an if catches its failure before -e would end the step silently (deploy_contract_test.py
# runs it under bash -e, bash -eo pipefail and sh -e). ls-remote matches ref names by suffix, so awk
# keeps only refs/heads/main itself; no such line leaves tip empty and refuses.
TIP = {'name': 'Require the tip of main', 'run': (
    'if ! refs=$(git ls-remote "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" refs/heads/main); then\n'
    '  echo "::error::Could not read the tip of main, so not publishing $GITHUB_SHA. '
    'git ls-remote failed; re-run this job once GitHub is reachable."\n'
    '  exit 1\n'
    'fi\n'
    'tip=$(printf \'%s\\n\' "$refs" | awk \'$2 == "refs/heads/main" {print $1}\')\n'
    'if [ "$tip" != "$GITHUB_SHA" ]; then\n'
    '  echo "::error::Not publishing $GITHUB_SHA: main is now at ${tip:-a commit this job could not read}. '
    'Re-running a deploy whose commit is no longer main\'s tip would put an older build over a newer one. '
    'If no newer deploy run is in progress, start this workflow on main by hand '
    '(Actions > Deploy to GitHub Pages > Run workflow)."\n'
    '  exit 1\n'
    'fi\n')}
VERIFIER = 'python -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json'
# Old vectors and set locks stay (scripts/check-history.ts), compared with main before the push.
HISTORY = {'env': {'BEFORE': '${{ github.event.before }}'}, 'run': (
    'if [ -z "$BEFORE" ] || [ "$BEFORE" = 0000000000000000000000000000000000000000 ]; then\n'
    '  git fetch --no-tags --depth=2 origin "$GITHUB_SHA"\n'
    '  base=$(git rev-parse "$GITHUB_SHA^1")\n'
    'else\n'
    '  git fetch --no-tags --depth=1 origin "$BEFORE"\n'
    '  base=$BEFORE\n'
    'fi\n'
    'npm run check:history -- --base "$base"\n')}
PERMISSIONS = {
    'independent-verifier': {'contents': 'read'},
    'site': None,  # inherits the workflow's empty set
    'build': {'contents': 'read', 'issues': 'read'},
    'stage': {'contents': 'read'},
    'staging-checks': {'contents': 'read'},
    'release-gate': {'contents': 'read'},
    'publish': {'contents': 'read'},
    'deploy': {'pages': 'write', 'id-token': 'write'},
    'smoke': {'contents': 'read', 'actions': 'read'},  # actions: read to name the last passing deploy
}
NEEDS = {'site': {'independent-verifier'}, 'build': {'site'}, 'stage': {'site', 'build'},
         'staging-checks': {'site', 'build', 'stage'}, 'release-gate': {'site'},
         'publish': {'site', 'build', 'stage', 'staging-checks', 'release-gate'},
         'deploy': {'build', 'publish'}, 'smoke': {'site', 'deploy'}}
# The production smoke checks are bounded: no other job sets a timeout.
TIMEOUTS = {'smoke': 15}
SECRET_STEPS = {('site', 'site'), ('stage', 'Deploy to Cloudflare Pages staging'), ('publish', 'Deploy to Cloudflare Pages')}
# The Access service token (docs/HOSTING.md#staging), and the steps that fetch staging, the only ones
# that may hold it: never a production step, never another secret.
ACCESS_ENV = {'CF_ACCESS_CLIENT_ID': '${{ secrets.CF_ACCESS_CLIENT_ID }}',
              'CF_ACCESS_CLIENT_SECRET': '${{ secrets.CF_ACCESS_CLIENT_SECRET }}'}
ACCESS_STEPS = {('stage', 'Check staging serves this build'), ('stage', 'Check staging serves every sealed file'),
                ('staging-checks', 'Check staging still serves this build'), ('staging-checks', 'Browser checks on staging')}
# The jobs that hold the Cloudflare secrets run in this environment, so its secrets and branch rule
# (docs/HOSTING.md) cover them. No other job names an environment but deploy (github-pages).
CLOUDFLARE_ENVIRONMENT = 'cloudflare-production'
ENVIRONMENTS = {'site': CLOUDFLARE_ENVIRONMENT, 'stage': CLOUDFLARE_ENVIRONMENT, 'publish': CLOUDFLARE_ENVIRONMENT,
                'deploy': {'name': 'github-pages', 'url': '${{ steps.deployment.outputs.page_url }}'}}
# Where a step may be conditional on staging rather than on the Cloudflare host.
STAGING_JOBS = {'stage', 'staging-checks'}


def action(step):
    return str(step.get('uses', '')).split('@', 1)[0]


def step_label(job, index, step):
    return f"{job} step {index + 1} ({step.get('name') or step.get('id') or step.get('uses') or step.get('run', '')[:40]})"


def match(step, spec):
    """Each key in spec equals the step's (a callable spec checks it); the step has no other keys
    beyond name and id."""
    if set(step) - set(spec) - {'name', 'id'}:
        return False
    for key, want in spec.items():
        have = action(step) if key == 'uses' else step.get(key)
        if not (want(have) if callable(want) else have == want):
            return False
    return True


def smoke_status(name, index, step, jobs):
    """Whether step is exactly one of smoke's two closing steps, the only steps that run after a
    failure: the trace upload second to last, on failure, then the status step last, always."""
    last = len(jobs['smoke'].get('steps') or []) - 1 if name == 'smoke' else -1
    return (index == last and match(step, SMOKE_STATUS)) or (index == last - 1 and match(step, SMOKE_TRACES))


def cloudflare(spec):
    return {**spec, 'if': CLOUDFLARE}


def staging(spec):
    return {**spec, 'if': STAGING}


# The steps that take build's sealed files and deploy them with Wrangler, in stage and in publish.
SEALED = [
    {'uses': 'actions/checkout', 'with': {'persist-credentials': False, 'sparse-checkout-cone-mode': False,
                                          'sparse-checkout': '/scripts/deploy_contract.py\n/tools/wrangler/\n'}},
    {'uses': 'actions/download-artifact', 'with': {'artifact-ids': '${{ needs.build.outputs.artifact_id }}', 'path': 'release'}},
    {'env': {'MANIFEST_SHA256': '${{ needs.build.outputs.manifest_sha256 }}', 'SITE_URL': '${{ needs.site.outputs.url }}'},
     'run': 'python3 -I scripts/deploy_contract.py verify release'},
    {'uses': 'actions/setup-node', 'with': {'node-version': 22, 'package-manager-cache': False}},
    {'run': 'npm ci --prefix tools/wrangler --ignore-scripts'},
]
WRANGLER_ENV = {'CLOUDFLARE_API_TOKEN': '${{ secrets.CLOUDFLARE_API_TOKEN }}',
                'CLOUDFLARE_ACCOUNT_ID': '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
                'PROJECT': "${{ vars.CLOUDFLARE_PROJECT || 'brainrottcg' }}"}


def wrangler(branch):
    return ('tools/wrangler/node_modules/.bin/wrangler pages deploy release/dist --project-name="$PROJECT" '
            f'--branch={branch} --commit-hash="$GITHUB_SHA" --commit-dirty=true')


def deployed_run(*flags):
    """Waits until (--once: checks once that) the address serves this run's dist/deployment-id.json."""
    return ' '.join(['python3 -I scripts/deploy_contract.py deployed release "$URL"', *flags])


def waits(run):
    """Polls until the address serves this run's dist/deployment-id.json."""
    return isinstance(run, str) and '| cmp -s release/dist/deployment-id.json - && exit 0' in run and '"${URL%/}/deployment-id.json?run=' in run


def served_step(url, **env):
    return {'env': {'MANIFEST_SHA256': '${{ needs.build.outputs.manifest_sha256 }}', 'SITE_URL': '${{ needs.site.outputs.url }}',
                    'URL': url, **env},
            'run': 'python3 -I scripts/deploy_contract.py served release "$URL" >> "$GITHUB_STEP_SUMMARY"'}


PUBLISH = [
    cloudflare(TIP),
    *map(cloudflare, SEALED),
    cloudflare({'env': WRANGLER_ENV, 'run': wrangler('main')}),
    cloudflare({'env': {'URL': '${{ needs.site.outputs.url }}'}, 'run': waits}),
    # With staging on, production must serve exactly what staging served and was tested on.
    staging(served_step('${{ needs.site.outputs.url }}')),
]
# The same sealed files, deployed first to the staging branch's own address, and checked there.
STAGE = [
    staging(TIP),
    *map(staging, SEALED),
    staging({'env': {**WRANGLER_ENV, 'BRANCH': '${{ needs.site.outputs.staging_branch }}'}, 'run': wrangler('"$BRANCH"')}),
    staging({'env': {'URL': '${{ needs.site.outputs.staging_url }}', **ACCESS_ENV}, 'run': deployed_run()}),
    staging(served_step('${{ needs.site.outputs.staging_url }}', **ACCESS_ENV)),
]
# The browser checks run the app's dependencies, so they get no secret but the Access token (which
# only reads previews), against the staging address.
# The specs that read ./dist get the sealed files (checked here too), not a new build.
STAGING_CHECKS = [
    staging({'uses': 'actions/checkout', 'with': {'persist-credentials': False}}),
    staging({'uses': 'actions/setup-node', 'with': {'node-version': 22, 'cache': 'npm'}}),
    staging({'run': 'npm ci'}),
    staging({'run': 'npx playwright install --with-deps chromium'}),
    staging(SEALED[1]),
    staging(SEALED[2]),
    staging({'run': 'cp -R release/dist dist'}),
    # stage saw these files on staging, but a later run on the same commit may have replaced them.
    staging({'env': {'URL': '${{ needs.site.outputs.staging_url }}', **ACCESS_ENV}, 'run': deployed_run('--once')}),
    staging({'env': {'STAGING_URL': '${{ needs.site.outputs.staging_url }}', **ACCESS_ENV},
             'run': 'npx playwright test -c playwright.staging.config.ts'}),
]
# The release-blocker decision (scripts/release-blockers.ts, #706) for this exact commit, against
# main's tip fetched in the step itself, refusing a commit that isn't on main. Full history, so a
# resolved blocker's fix commit can be found. publish needs it, and deploy needs publish.
RELEASE_GATE = [
    {'uses': 'actions/checkout', 'with': {'persist-credentials': False, 'fetch-depth': 0}},
    {'uses': 'actions/setup-node', 'with': {'node-version': 22, 'cache': 'npm'}},
    {'run': 'npm ci'},
    {'run': ('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main\n'
             'npx tsx scripts/release-blockers.ts --candidate "$GITHUB_SHA" --base origin/main --require-on-base\n')},
]
DEPLOY = [TIP, {'uses': 'actions/deploy-pages'}]
# Read-only checks of production once publish and deploy are done (scripts/production-smoke.ts): no
# secrets, and every check's failure fails the run. Only the last two steps are conditional: on a
# failure, the browser checks' traces are uploaded for 7 days (production gets no Access token, so
# they hold no secret header; staging-checks, which sends one, uploads nothing); then, always, the
# last reads both checks' outcomes and says whether the release is known-good, or what to go back to.
SMOKE_ENV = {'SITE_URL': '${{ needs.site.outputs.url }}', 'HOST': '${{ needs.site.outputs.host }}',
             'OLD_URL': 'https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/'}
SMOKE_STATUS = {'if': 'always()', 'env': {**SMOKE_ENV, 'GH_TOKEN': '${{ github.token }}',
                                          'HTTP_OUTCOME': '${{ steps.http.outcome }}', 'BROWSER_OUTCOME': '${{ steps.browser.outcome }}'},
                'run': 'npx tsx scripts/production-smoke.ts --status >> "$GITHUB_STEP_SUMMARY"'}
SMOKE_TRACES = {'if': 'failure()', 'uses': 'actions/upload-artifact',
                'with': {'name': 'playwright-production-smoke', 'path': 'test-results/production/', 'retention-days': 7}}
SMOKE = [
    {'uses': 'actions/checkout', 'with': {'persist-credentials': False}},
    {'uses': 'actions/setup-node', 'with': {'node-version': 22, 'cache': 'npm'}},
    {'run': 'npm ci'},
    {'id': 'http', 'env': SMOKE_ENV, 'run': 'npx tsx scripts/production-smoke.ts >> "$GITHUB_STEP_SUMMARY"'},
    {'run': 'npx playwright install --with-deps chromium'},
    {'id': 'browser', 'env': {'PRODUCTION_URL': '${{ needs.site.outputs.url }}'},
     'run': 'npx playwright test -c playwright.production.config.ts'},
    SMOKE_TRACES,
    SMOKE_STATUS,
]
# Only one deploy of main runs at a time, and a newer push to main cancels the older run: with GUARD
# and TIP, this is what stops an older build publishing over a newer one. One group per ref, so a run
# from another branch (which GUARD fails) can't cancel a run of main.
CONCURRENCY = {'group': 'pages-${{ github.ref }}', 'cancel-in-progress': True}
# On GitHub Pages every publish step is skipped and this upload (never conditional) is the game; on
# Cloudflare it is the redirect pages.
PAGES_PATH = "${{ needs.site.outputs.host == 'cloudflare' && 'pages' || 'dist' }}"
# The site lookup hands SITE_URL on ending in exactly one /, however many the variable ends in, and
# the staging address once it has checked it (deploy_contract_test.py runs the lookup).
SITE_URL_OUTPUT = ('while [ "${url%/}" != "$url" ]; do url=${url%/}; done\n'
                   '{ echo "host=cloudflare"; echo "url=$url/"; echo "base=/"; echo "pages=$pages"; '
                   'echo "staging_branch=$STAGING_BRANCH"; echo "staging_url=$staging_url"; } >> "$GITHUB_OUTPUT"\n')
SITE_OUTPUTS = ('host', 'url', 'base', 'pages', 'staging_branch', 'staging_url')


def check_deploy(workflow):
    problems = []
    if set(workflow) - {'name', 'on', 'permissions', 'concurrency', 'jobs'}:
        problems.append(f'deploy.yml: unexpected top-level keys {sorted(set(workflow) - {"name", "on", "permissions", "concurrency", "jobs"})}')
    if workflow.get('on') != {'push': {'branches': ['main']}, 'workflow_dispatch': None}:
        problems.append('deploy.yml: must run only on pushes to main and manual runs')
    if workflow.get('permissions') != {}:
        problems.append('deploy.yml: the workflow must grant no token scopes (permissions: {})')
    if workflow.get('concurrency') != CONCURRENCY:
        problems.append(f"deploy.yml: concurrency must be one pages group per ref ({CONCURRENCY['group']}) with cancel-in-progress: true")
    jobs = workflow.get('jobs') or {}
    if set(jobs) != set(PERMISSIONS):
        return problems + [f'deploy.yml: jobs must be exactly {sorted(PERMISSIONS)}']
    for name, job in jobs.items():
        extra = set(job) - {'needs', 'runs-on', 'permissions', 'outputs', 'steps', 'environment', 'timeout-minutes'}
        if extra:
            problems.append(f'deploy.yml: job {name} has {sorted(extra)}')
        if job.get('timeout-minutes') != TIMEOUTS.get(name):
            problems.append(f"deploy.yml: job {name} timeout-minutes must be {TIMEOUTS.get(name, 'unset')}")
        if job.get('environment') != ENVIRONMENTS.get(name):
            problems.append(f'deploy.yml: job {name} must run in environment {ENVIRONMENTS.get(name)}')
        if job.get('permissions') != PERMISSIONS[name]:
            problems.append(f'deploy.yml: job {name} permissions must be {PERMISSIONS[name]}')
        needs = job.get('needs', [])
        if set([needs] if isinstance(needs, str) else needs) != NEEDS.get(name, set()):
            problems.append(f'deploy.yml: job {name} must need exactly {sorted(NEEDS.get(name, set()))}')
        for index, step in enumerate(job.get('steps') or []):
            label = step_label(name, index, step)
            if set(step) - {'name', 'id', 'if', 'uses', 'with', 'env', 'run'}:
                problems.append(f'deploy.yml: {label} has {sorted(set(step) - {"name", "id", "if", "uses", "with", "env", "run"})}')
            if 'if' in step and step['if'] != CLOUDFLARE and not (step['if'] == STAGING and name in STAGING_JOBS | {'publish'}) \
                    and not smoke_status(name, index, step, jobs):
                problems.append(f'deploy.yml: {label} may only be conditional on the Cloudflare host, '
                                'or on staging in stage, staging-checks and publish')
            if action(step) == 'actions/checkout' and (step.get('with') or {}).get('persist-credentials') is not False:
                problems.append(f'deploy.yml: {label} must not keep the token (persist-credentials: false)')
    for path, text in walk(workflow):
        status = len(path) == 5 and path[0] == 'jobs' and path[2] == 'steps' and path[4] == 'if' \
            and smoke_status(path[1], path[3], jobs[path[1]]['steps'][path[3]], jobs)
        if re.search(r'\b(?:always|cancelled|failure)\(\)', text) and not status:
            problems.append(f'deploy.yml: {"/".join(map(str, path))} runs after a failure or cancel')
        if re.search(r'\bsecrets\b', text):
            # Only as a value in the env of the site lookup or a Wrangler deploy: jobs/J/steps/N/env/KEY;
            # or the Access token, as itself, in a step that fetches staging.
            in_env = len(path) == 6 and path[0] == 'jobs' and path[2] == 'steps' and path[4] == 'env'
            step = jobs[path[1]]['steps'][path[3]] if in_env else {}
            labels = {(path[1], step.get('id')), (path[1], step.get('name'))} if in_env else set()
            if not (labels & SECRET_STEPS or (labels & ACCESS_STEPS and ACCESS_ENV.get(path[5]) == text)):
                problems.append(f'deploy.yml: {"/".join(map(str, path))} uses a secret outside the site lookup, the Wrangler deploys '
                                'and the staging fetches (the Access token)')

    site, build, publish, deploy = (jobs[name].get('steps') or [] for name in ('site', 'build', 'publish', 'deploy'))
    verifier = jobs['independent-verifier'].get('steps') or []
    if not verifier or verifier[-1].get('run') != VERIFIER:
        problems.append('deploy.yml: independent-verifier must end by checking both vector files')
    if len(site) != 2 or site[0] != GUARD or site[1].get('id') != 'site' or 'uses' in site[1]:
        problems.append('deploy.yml: site must be the main-ref guard, then the host lookup, and run no actions')
    elif not str(site[1].get('run', '')).endswith(SITE_URL_OUTPUT):
        problems.append(f'deploy.yml: the site lookup must end by handing on its address ending in one / ({SITE_URL_OUTPUT!r})')
    if any(step == GUARD for job in set(jobs) - {'site'} for step in jobs[job].get('steps') or []):
        problems.append('deploy.yml: the main-ref guard belongs in site only')
    if jobs['site'].get('outputs') != {key: f'${{{{ steps.site.outputs.{key} }}}}' for key in SITE_OUTPUTS}:
        problems.append(f"deploy.yml: site outputs must be {', '.join(SITE_OUTPUTS)} from the lookup")
    for run in ('npm run check', 'npm run build'):
        if not any(step.get('run') == run and 'if' not in step for step in build):
            problems.append(f'deploy.yml: build must always run {run}')
    if sum(match(step, HISTORY) for step in build) != 1:
        problems.append('deploy.yml: build must always run npm run check:history once, against main before the push')
    seal = [s for s in build if s.get('id') == 'seal']
    handoff = [s for s in build if s.get('id') == 'handoff']
    if len(seal) != 1 or not match(seal[0], cloudflare({'env': {'SITE_URL': '${{ needs.site.outputs.url }}'},
                                                        'run': lambda run: isinstance(run, str) and run.rstrip('\n').endswith(
                                                            'python3 -I scripts/deploy_contract.py seal release >> "$GITHUB_OUTPUT"')})):
        problems.append('deploy.yml: build must seal release/ for Cloudflare (id: seal)')
    if len(handoff) != 1 or not match(handoff[0], cloudflare({
            'uses': 'actions/upload-artifact',
            'with': lambda w: isinstance(w, dict) and w.get('path') == 'release/' and w.get('retention-days') == 1
            and w.get('if-no-files-found') == 'error' and set(w) <= {'name', 'path', 'retention-days', 'if-no-files-found', 'include-hidden-files'}})):
        problems.append('deploy.yml: build must hand release/ to publish once (id: handoff), kept for 1 day')
    if jobs['build'].get('outputs') != {'artifact_id': '${{ steps.handoff.outputs.artifact-id }}',
                                        'manifest_sha256': '${{ steps.seal.outputs.manifest_sha256 }}'}:
        problems.append('deploy.yml: build outputs must be the handoff artifact ID and the sealed manifest hash')
    pages = [s for s in build if action(s) == 'actions/upload-pages-artifact']
    if len(pages) != 1 or not match(pages[0], {'uses': 'actions/upload-pages-artifact', 'with': {'path': PAGES_PATH}}):
        problems.append(f'deploy.yml: build must always upload one Pages artifact from {PAGES_PATH}')
    if len(publish) != len(PUBLISH) or not all(match(step, spec) for step, spec in zip(publish, PUBLISH)):
        problems.append('deploy.yml: publish must require the tip of main, check out its two files, download by artifact ID, verify the seal, '
                        'set up Node, install Wrangler without scripts, deploy release/dist, wait for deployment-id.json, '
                        'then (with staging on) check production serves every sealed file')
    stage, checks = (jobs[name].get('steps') or [] for name in ('stage', 'staging-checks'))
    if len(stage) != len(STAGE) or not all(match(step, spec) for step, spec in zip(stage, STAGE)):
        problems.append('deploy.yml: stage must, with staging on, do what publish does but deploy to the staging branch, '
                        'then check staging serves every sealed file, sending staging alone the Access token')
    if len(checks) != len(STAGING_CHECKS) or not all(match(step, spec) for step, spec in zip(checks, STAGING_CHECKS)):
        problems.append('deploy.yml: staging-checks must, with staging on, check staging still serves this build, then run '
                        'playwright.staging.config.ts against staging with the sealed files as ./dist, each with the Access token')
    gate = jobs['release-gate'].get('steps') or []
    if len(gate) != len(RELEASE_GATE) or not all(match(step, spec) for step, spec in zip(gate, RELEASE_GATE)):
        problems.append('deploy.yml: release-gate must check out full history without the token, install, fetch main, '
                        'then run scripts/release-blockers.ts on this commit against main with --require-on-base')
    if len(deploy) != len(DEPLOY) or not all(match(step, spec) for step, spec in zip(deploy, DEPLOY)):
        problems.append('deploy.yml: deploy must only require the tip of main, then deploy Pages')
    smoke = jobs['smoke'].get('steps') or []
    if len(smoke) != len(SMOKE) or not all(match(step, spec) for step, spec in zip(smoke, SMOKE)):
        problems.append('deploy.yml: smoke must check out without the token, install, run scripts/production-smoke.ts '
                        'against the site address, then run playwright.production.config.ts there, upload its traces only '
                        'on failure for 7 days, then always record the release status from both outcomes (production-smoke.ts --status)')
    return problems


def check_workflows(directory=ROOT / '.github/workflows'):
    """Problems with the workflows, or [] when they keep the promises in docs/HOSTING.md."""
    problems = []
    paths = sorted(Path(directory).glob('*.yml')) + sorted(Path(directory).glob('*.yaml'))
    require(any(p.name == 'deploy.yml' for p in paths), f'{directory} has no deploy.yml')
    for path in paths:
        workflow = load(path)
        require(isinstance(workflow, dict) and isinstance(workflow.get('jobs'), dict), f'{path.name}: no jobs')
        for job_name, job in workflow['jobs'].items():
            for index, step in enumerate([job] + list(job.get('steps') or [])):
                uses = step.get('uses')
                if uses is None or uses.startswith('./'):
                    continue
                label = f'job {job_name}' if index == 0 else step_label(job_name, index - 1, step)
                if not re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', uses):
                    problems.append(f'{path.name}: {label} uses {uses}, not pinned to a commit')
                if action(step) == 'actions/upload-artifact' and not (path.name == 'deploy.yml' and step.get('id') == 'handoff'):
                    triggers = workflow.get('on') or {}
                    triggers = {triggers} if isinstance(triggers, str) else set(triggers)
                    if triggers & {'push', 'pull_request', 'pull_request_target'} and (
                            step.get('if') != 'failure()' or (step.get('with') or {}).get('retention-days') != 7):
                        problems.append(f'{path.name}: {label} must upload only on failure() and keep it 7 days')
        if path.name == 'deploy.yml':
            problems += check_deploy(workflow)
    return problems


def main(argv, env):
    command, *args = argv or ['']
    if command == 'seal' and len(args) == 1:
        print(f'manifest_sha256={seal(Path(args[0]), env)}')
    elif command == 'verify' and len(args) == 1:
        verify(Path(args[0]), env, env.get('MANIFEST_SHA256', ''))
    elif command == 'served' and len(args) == 2:
        print(served(Path(args[0]), env, env.get('MANIFEST_SHA256', ''), args[1]))
    elif command == 'deployed' and len(args) in (2, 3) and args[2:] in ([], ['--once']):
        deployed(Path(args[0]), env, args[1], once=args[2:] == ['--once'])
    elif command == 'check-workflows' and len(args) <= 1:
        problems = check_workflows(*map(Path, args))
        require(not problems, '\n  '.join(['the workflows break the deploy contract:'] + problems))
        print('Workflows keep the deploy contract.')
    else:
        raise Rejected('usage: deploy_contract.py seal DIR | verify DIR | served DIR URL | deployed DIR URL [--once] | check-workflows [DIR]')


if __name__ == '__main__':
    try:
        main(sys.argv[1:], os.environ)
    except (Rejected, OSError, KeyError, ValueError) as error:
        # An error annotation on the run, whichever step this is.
        print(f'::error::Deployment rejected: {error}', file=sys.stderr)
        sys.exit(1)
