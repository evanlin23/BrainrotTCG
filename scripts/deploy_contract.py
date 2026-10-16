"""What the deploy workflow promises, checked offline (docs/HOSTING.md).

  seal DIR          (build)   write DIR/dist/deployment-id.json and a manifest of every file's hash;
                              prints manifest_sha256=<hash of the manifest> for $GITHUB_OUTPUT
  verify DIR        (publish) the downloaded files are exactly the ones build sealed in this run
  check-workflows   (CI) .github/workflows do what docs/HOSTING.md says, read from the YAML

Standard library only, so the jobs that run it install nothing. Run it with `python3 -I`.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

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
    parts = urlsplit(url)
    require(not re.search(r'[\s?#]', url) and parts.scheme == 'https' and parts.hostname
            and not parts.username and not parts.password and parts.port is None and parts.path in ('', '/'),
            f'SITE_URL {url!r} must be a plain https:// address, with or without one trailing /')
    # The trailing / is optional in SITE_URL; the marker always has exactly one.
    return {'repository': repository, 'run_id': run_id, 'sha': sha, 'url': url.removesuffix('/') + '/'}


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
GUARD = {'name': 'Require the main source ref', 'env': {'SOURCE_REF': '${{ github.ref }}'},
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
PERMISSIONS = {
    'independent-verifier': {'contents': 'read'},
    'site': None,  # inherits the workflow's empty set
    'build': {'contents': 'read', 'issues': 'read'},
    'publish': {'contents': 'read'},
    'deploy': {'pages': 'write', 'id-token': 'write'},
}
NEEDS = {'site': {'independent-verifier'}, 'build': {'site'}, 'publish': {'site', 'build'}, 'deploy': {'build', 'publish'}}
SECRET_STEPS = {('site', 'site'), ('publish', 'Deploy to Cloudflare Pages')}


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


def cloudflare(spec):
    return {**spec, 'if': CLOUDFLARE}


PUBLISH = [
    cloudflare(TIP),
    cloudflare({'uses': 'actions/checkout', 'with': {'persist-credentials': False, 'sparse-checkout-cone-mode': False,
                                                    'sparse-checkout': '/scripts/deploy_contract.py\n/tools/wrangler/\n'}}),
    cloudflare({'uses': 'actions/download-artifact', 'with': {'artifact-ids': '${{ needs.build.outputs.artifact_id }}', 'path': 'release'}}),
    cloudflare({'env': {'MANIFEST_SHA256': '${{ needs.build.outputs.manifest_sha256 }}', 'SITE_URL': '${{ needs.site.outputs.url }}'},
                'run': 'python3 -I scripts/deploy_contract.py verify release'}),
    cloudflare({'uses': 'actions/setup-node', 'with': {'node-version': 22, 'package-manager-cache': False}}),
    cloudflare({'run': 'npm ci --prefix tools/wrangler --ignore-scripts'}),
    cloudflare({'env': {'CLOUDFLARE_API_TOKEN': '${{ secrets.CLOUDFLARE_API_TOKEN }}',
                        'CLOUDFLARE_ACCOUNT_ID': '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
                        'PROJECT': "${{ vars.CLOUDFLARE_PROJECT || 'brainrottcg' }}"},
                'run': 'tools/wrangler/node_modules/.bin/wrangler pages deploy release/dist --project-name="$PROJECT" '
                       '--branch=main --commit-hash="$GITHUB_SHA" --commit-dirty=true'}),
    cloudflare({'env': {'URL': '${{ needs.site.outputs.url }}'},
                'run': lambda run: isinstance(run, str) and '| cmp -s release/dist/deployment-id.json - && exit 0' in run
                and '"${URL%/}/deployment-id.json?run=' in run}),
]
DEPLOY = [TIP, {'uses': 'actions/deploy-pages'}]
# Only one deploy runs at a time, and a newer push to main cancels the older run: with GUARD and TIP,
# this is what stops an older build publishing over a newer one.
CONCURRENCY = {'group': 'pages', 'cancel-in-progress': True}
# The site lookup hands SITE_URL on ending in exactly one /, however many the variable ends in.
SITE_URL_OUTPUT = ('while [ "${url%/}" != "$url" ]; do url=${url%/}; done\n'
                   '{ echo "host=cloudflare"; echo "url=$url/"; echo "base=/"; } >> "$GITHUB_OUTPUT"\n')


def check_deploy(workflow):
    problems = []
    if set(workflow) - {'name', 'on', 'permissions', 'concurrency', 'jobs'}:
        problems.append(f'deploy.yml: unexpected top-level keys {sorted(set(workflow) - {"name", "on", "permissions", "concurrency", "jobs"})}')
    if workflow.get('on') != {'push': {'branches': ['main']}, 'workflow_dispatch': None}:
        problems.append('deploy.yml: must run only on pushes to main and manual runs')
    if workflow.get('permissions') != {}:
        problems.append('deploy.yml: the workflow must grant no token scopes (permissions: {})')
    if workflow.get('concurrency') != CONCURRENCY:
        problems.append('deploy.yml: concurrency must be the pages group with cancel-in-progress: true')
    jobs = workflow.get('jobs') or {}
    if set(jobs) != set(PERMISSIONS):
        return problems + [f'deploy.yml: jobs must be exactly {sorted(PERMISSIONS)}']
    for name, job in jobs.items():
        extra = set(job) - {'needs', 'runs-on', 'permissions', 'outputs', 'steps', 'environment'}
        if extra:
            problems.append(f'deploy.yml: job {name} has {sorted(extra)}')
        if job.get('permissions') != PERMISSIONS[name]:
            problems.append(f'deploy.yml: job {name} permissions must be {PERMISSIONS[name]}')
        needs = job.get('needs', [])
        if set([needs] if isinstance(needs, str) else needs) != NEEDS.get(name, set()):
            problems.append(f'deploy.yml: job {name} must need exactly {sorted(NEEDS.get(name, set()))}')
        for index, step in enumerate(job.get('steps') or []):
            label = step_label(name, index, step)
            if set(step) - {'name', 'id', 'if', 'uses', 'with', 'env', 'run'}:
                problems.append(f'deploy.yml: {label} has {sorted(set(step) - {"name", "id", "if", "uses", "with", "env", "run"})}')
            if 'if' in step and step['if'] != CLOUDFLARE:
                problems.append(f"deploy.yml: {label} may only be conditional on the Cloudflare host")
            if action(step) == 'actions/checkout' and (step.get('with') or {}).get('persist-credentials') is not False:
                problems.append(f'deploy.yml: {label} must not keep the token (persist-credentials: false)')
    for path, text in walk(workflow):
        if re.search(r'\b(?:always|cancelled|failure)\(\)', text):
            problems.append(f'deploy.yml: {"/".join(map(str, path))} runs after a failure or cancel')
        if re.search(r'\bsecrets\b', text):
            # Only as a value in the env of the site lookup or the Wrangler deploy: jobs/J/steps/N/env/KEY.
            in_env = len(path) == 6 and path[0] == 'jobs' and path[2] == 'steps' and path[4] == 'env'
            step = jobs[path[1]]['steps'][path[3]] if in_env else {}
            if not any(in_env and path[1] == job and label in (step.get('id'), step.get('name')) for job, label in SECRET_STEPS):
                problems.append(f'deploy.yml: {"/".join(map(str, path))} uses a secret outside the site lookup and the Wrangler deploy')

    site, build, publish, deploy = (jobs[name].get('steps') or [] for name in ('site', 'build', 'publish', 'deploy'))
    verifier = jobs['independent-verifier'].get('steps') or []
    if not verifier or verifier[-1].get('run') != VERIFIER:
        problems.append('deploy.yml: independent-verifier must end by checking both vector files')
    if len(site) != 2 or site[0] != GUARD or site[1].get('id') != 'site' or 'uses' in site[1]:
        problems.append('deploy.yml: site must be the main-ref guard, then the host lookup, and run no actions')
    elif not str(site[1].get('run', '')).endswith(SITE_URL_OUTPUT):
        problems.append(f'deploy.yml: the site lookup must end by handing on its address ending in one / ({SITE_URL_OUTPUT!r})')
    if any(step == GUARD for job in ('build', 'publish', 'deploy', 'independent-verifier') for step in jobs[job].get('steps') or []):
        problems.append('deploy.yml: the main-ref guard belongs in site only')
    if jobs['site'].get('outputs') != {key: f'${{{{ steps.site.outputs.{key} }}}}' for key in ('host', 'url', 'base')}:
        problems.append('deploy.yml: site outputs must be host, url and base from the lookup')
    for run in ('npm run check', 'npm run build'):
        if not any(step.get('run') == run and 'if' not in step for step in build):
            problems.append(f'deploy.yml: build must always run {run}')
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
    if len(publish) != len(PUBLISH) or not all(match(step, spec) for step, spec in zip(publish, PUBLISH)):
        problems.append('deploy.yml: publish must require the tip of main, check out its two files, download by artifact ID, verify the seal, '
                        'set up Node, install Wrangler without scripts, deploy release/dist, then wait for deployment-id.json')
    if len(deploy) != len(DEPLOY) or not all(match(step, spec) for step, spec in zip(deploy, DEPLOY)):
        problems.append('deploy.yml: deploy must only require the tip of main, then deploy Pages')
    if jobs['deploy'].get('environment') != {'name': 'github-pages', 'url': '${{ steps.deployment.outputs.page_url }}'}:
        problems.append('deploy.yml: deploy must publish to the github-pages environment')
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
    elif command == 'check-workflows' and len(args) <= 1:
        problems = check_workflows(*map(Path, args))
        require(not problems, '\n  '.join(['the workflows break the deploy contract:'] + problems))
        print('Workflows keep the deploy contract.')
    else:
        raise Rejected('usage: deploy_contract.py seal DIR | verify DIR | check-workflows [DIR]')


if __name__ == '__main__':
    try:
        main(sys.argv[1:], os.environ)
    except (Rejected, OSError, KeyError, ValueError) as error:
        print(f'Deployment rejected: {error}', file=sys.stderr)
        sys.exit(1)
