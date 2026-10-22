"""Tests for scripts/deploy_contract.py, run in CI as `python3 scripts/deploy_contract_test.py`.

Standard library only. The PyYAML comparison runs where PyYAML is installed and is skipped
otherwise.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_contract as dc  # noqa: E402

WORKFLOWS = dc.ROOT / '.github/workflows'
SCRIPT = dc.ROOT / 'scripts/deploy_contract.py'
ENV = {
    'GITHUB_REPOSITORY': 'evanlin23/BrainrotTCG',
    'GITHUB_SHA': 'a' * 40,
    'GITHUB_RUN_ID': '123456',
    'SITE_URL': 'https://brainrottcg.pages.dev/',
}


def step_named(workflow, job, name):
    return next(s for s in workflow['jobs'][job]['steps'] if s.get('name') == name)


class Workflows(unittest.TestCase):
    """The real workflows keep the contract, and each way of breaking it is caught."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        shutil.copytree(WORKFLOWS, self.tmp / 'workflows')

    def problems(self, file, old, new):
        path = self.tmp / 'workflows' / file
        text = path.read_text(encoding='utf-8')
        self.assertEqual(text.count(old), 1, f'{file} should contain this text exactly once:\n{old}')
        path.write_text(text.replace(old, new), encoding='utf-8')
        return dc.check_workflows(self.tmp / 'workflows')

    def assertBroken(self, file, old, new, expected):
        problems = self.problems(file, old, new)
        self.assertTrue(any(expected in p for p in problems), f'expected {expected!r} in {problems}')

    def test_real_workflows_keep_the_contract(self):
        self.assertEqual(dc.check_workflows(), [])

    def test_deploy_without_publish(self):
        self.assertBroken('deploy.yml', 'needs: [build, publish]', 'needs: build', 'job deploy must need exactly')

    def test_publish_without_site(self):
        self.assertBroken('deploy.yml', 'needs: [site, build]', 'needs: [build]', 'job publish must need exactly')

    def test_publish_without_build(self):
        self.assertBroken('deploy.yml', 'needs: [site, build]', 'needs: [site]', 'job publish must need exactly')

    def test_secret_in_pages_deploy(self):
        for key in ('with', 'env'):
            with self.subTest(key):
                self.setUp()
                self.assertBroken('deploy.yml', '        id: deployment\n',
                                  f'        id: deployment\n        {key}:\n          token: ${{{{ secrets.CLOUDFLARE_API_TOKEN }}}}\n',
                                  f'jobs/deploy/steps/1/{key}/token uses a secret outside')

    def test_github_host_path(self):
        # Without the Cloudflare secrets site answers host=github: every publish step is skipped, so
        # publish succeeds without running anything, and deploy (which needs it) uploads the game.
        jobs = dc.load(WORKFLOWS / 'deploy.yml')['jobs']
        cloudflare_only = lambda step: step.get('if') == dc.CLOUDFLARE
        self.assertNotIn('if', jobs['publish'])
        self.assertNotIn('if', jobs['deploy'])
        self.assertTrue(jobs['publish']['steps'] and all(map(cloudflare_only, jobs['publish']['steps'])))
        self.assertFalse(any('if' in step for step in jobs['deploy']['steps']))
        pages = [s for s in jobs['build']['steps'] if dc.action(s) == 'actions/upload-pages-artifact']
        self.assertEqual([s.get('if') for s in pages], [None])
        self.assertEqual(pages[0]['with']['path'], "${{ needs.site.outputs.host == 'cloudflare' && 'pages' || 'dist' }}")

    def test_github_host_path_broken(self):
        for old, new, expected in (
                ('    needs: [site, build]\n', "    needs: [site, build]\n    if: needs.site.outputs.host == 'cloudflare'\n",
                 "job publish has ['if']"),
                ('    needs: [build, publish]\n', "    needs: [build, publish]\n    if: needs.site.outputs.host == 'cloudflare'\n",
                 "job deploy has ['if']"),
                ('        id: deployment\n', "        id: deployment\n        if: needs.site.outputs.host == 'cloudflare'\n",
                 'deploy must only require the tip of main'),
                ("        if: needs.site.outputs.host == 'cloudflare'\n        with:\n          artifact-ids:",
                 '        with:\n          artifact-ids:', 'publish must'),
                ("          path: ${{ needs.site.outputs.host == 'cloudflare' && 'pages' || 'dist' }}",
                 '          path: dist', 'build must always upload one Pages artifact'),
                ('      - uses: actions/upload-pages-artifact', "      - if: needs.site.outputs.host == 'cloudflare'\n"
                 '        uses: actions/upload-pages-artifact', 'build must always upload one Pages artifact')):
            with self.subTest(new):
                self.setUp()
                self.assertBroken('deploy.yml', old, new, expected)

    def test_runs_after_failure(self):
        self.assertBroken('deploy.yml', '        id: deployment\n', '        id: deployment\n        if: always()\n',
                          'runs after a failure or cancel')

    def test_download_by_name(self):
        self.assertBroken('deploy.yml', 'artifact-ids: ${{ needs.build.outputs.artifact_id }}',
                          'name: cloudflare-site-${{ github.run_attempt }}', 'publish must')

    def test_verify_without_digest(self):
        self.assertBroken('deploy.yml', '          MANIFEST_SHA256: ${{ needs.build.outputs.manifest_sha256 }}\n', '',
                          'publish must')

    def test_verify_removed(self):
        self.assertBroken('deploy.yml', """      - name: Check the files are the ones build sealed
        if: needs.site.outputs.host == 'cloudflare'
        env:
          MANIFEST_SHA256: ${{ needs.build.outputs.manifest_sha256 }}
          SITE_URL: ${{ needs.site.outputs.url }}
        run: python3 -I scripts/deploy_contract.py verify release
""", '', 'publish must')

    def test_readiness_check_removed(self):
        self.assertBroken('deploy.yml', '| cmp -s release/dist/deployment-id.json - && exit 0', '&& exit 0',
                          'publish must')

    def test_readiness_check_needs_one_slash(self):
        self.assertBroken('deploy.yml', '"${URL%/}/deployment-id.json?run=', '"${URL}deployment-id.json?run=', 'publish must')

    def test_deploy_runs_more(self):
        self.assertBroken('deploy.yml', '          fi\n      - uses: actions/deploy-pages',
                          '          fi\n      - run: npm ci\n      - uses: actions/deploy-pages',
                          'deploy must only require the tip of main, then deploy Pages')

    def test_concurrency_removed(self):
        self.assertBroken('deploy.yml', 'concurrency:\n  group: pages-${{ github.ref }}\n  cancel-in-progress: true\n', '',
                          'concurrency must be one pages group per ref')

    def test_concurrency_weakened(self):
        # A per-run group serializes nothing; one global group lets a run from another branch cancel a
        # run of main before the site guard fails it.
        for old, new in (('cancel-in-progress: true', 'cancel-in-progress: false'), ('  cancel-in-progress: true\n', ''),
                         ('  group: pages-${{ github.ref }}\n', '  group: pages-${{ github.run_id }}\n'),
                         ('  group: pages-${{ github.ref }}\n', '  group: pages\n'),
                         ('  group: pages-${{ github.ref }}\n', '  group: pages-${{ github.workflow }}\n')):
            with self.subTest(new):
                self.setUp()
                self.assertBroken('deploy.yml', old, new, 'concurrency must be one pages group per ref')

    def test_site_url_not_normalized(self):
        self.assertBroken('deploy.yml', 'echo "url=$url/"', 'echo "url=$url"', 'site lookup must end by handing on its address')

    def test_site_url_strips_one_slash(self):
        self.assertBroken('deploy.yml', '          while [ "${url%/}" != "$url" ]; do url=${url%/}; done\n', '          url=${url%/}\n',
                          'site lookup must end by handing on its address')

    def deploy_problems(self, change):
        workflow = dc.load(WORKFLOWS / 'deploy.yml')
        change(workflow['jobs'])
        return dc.check_deploy(workflow)

    def test_tip_guard_removed(self):
        for job in ('publish', 'deploy'):
            with self.subTest(job):
                problems = self.deploy_problems(lambda jobs: jobs[job]['steps'].pop(0))
                self.assertTrue(any(f'{job} must' in p and 'tip of main' in p for p in problems), problems)

    def test_tip_guard_weakened(self):
        for job in ('publish', 'deploy'):
            with self.subTest(job):
                def weaken(jobs):
                    jobs[job]['steps'][0]['run'] = jobs[job]['steps'][0]['run'].replace('exit 1', 'exit 0')
                problems = self.deploy_problems(weaken)
                self.assertTrue(any(f'{job} must' in p and 'tip of main' in p for p in problems), problems)

    def test_tip_guard_after_publishing(self):
        problems = self.deploy_problems(lambda jobs: jobs['deploy']['steps'].append(jobs['deploy']['steps'].pop(0)))
        self.assertTrue(any('deploy must only require the tip of main' in p for p in problems), problems)

    def test_secret_in_dependency_install(self):
        self.assertBroken('deploy.yml', '        run: npm ci --prefix tools/wrangler --ignore-scripts\n',
                          '        env:\n          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n'
                          '        run: npm ci --prefix tools/wrangler --ignore-scripts\n',
                          'uses a secret outside')

    def test_secret_in_build(self):
        self.assertBroken('deploy.yml', '      - run: npm ci\n',
                          '      - run: npm ci\n        env:\n          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n',
                          'uses a secret outside')

    def test_wrangler_runs_more(self):
        self.assertBroken('deploy.yml', '--commit-dirty=true\n', '--commit-dirty=true && npm test\n', 'publish must')

    def test_pages_write_on_build(self):
        self.assertBroken('deploy.yml', '      contents: read\n      issues: read\n',
                          '      contents: read\n      issues: read\n      pages: write\n', 'job build permissions')

    def test_contents_write(self):
        self.assertBroken('deploy.yml', '    needs: [site, build]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n',
                          '    needs: [site, build]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n',
                          'job publish permissions')

    def test_top_level_permissions(self):
        self.assertBroken('deploy.yml', 'permissions: {}\n', 'permissions:\n  contents: read\n', 'grant no token scopes')

    def test_token_kept_by_checkout(self):
        self.assertBroken('deploy.yml', """    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false

      - uses: actions/setup-node""", """    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      - uses: actions/setup-node""", 'must not keep the token')

    def test_guard_removed(self):
        self.assertBroken('deploy.yml', """      - name: Require the main source ref
        env:
          SOURCE_REF: ${{ github.ref }}
        # Shell comparison is case-sensitive; Actions expression equality is not.
        run: test "$SOURCE_REF" = refs/heads/main
""", '', 'site must be the main-ref guard')

    def test_guard_weakened(self):
        self.assertBroken('deploy.yml', 'run: test "$SOURCE_REF" = refs/heads/main\n',
                          'run: test "$SOURCE_REF" = refs/heads/main || true\n', 'site must be the main-ref guard')

    def test_guard_moved(self):
        guard = """      - name: Require the main source ref
        env:
          SOURCE_REF: ${{ github.ref }}
        # Shell comparison is case-sensitive; Actions expression equality is not.
        run: test "$SOURCE_REF" = refs/heads/main
"""
        path = self.tmp / 'workflows/deploy.yml'
        text = path.read_text(encoding='utf-8')
        self.assertEqual(text.count(guard), 1)
        anchor = '      issues: read\n    outputs:\n      artifact_id: ${{ steps.handoff.outputs.artifact-id }}\n' \
                 '      manifest_sha256: ${{ steps.seal.outputs.manifest_sha256 }}\n    steps:\n'
        self.assertEqual(text.count(anchor), 1)
        path.write_text(text.replace(guard, '').replace(anchor, anchor + guard), encoding='utf-8')
        problems = dc.check_workflows(self.tmp / 'workflows')
        self.assertTrue(any('site must be the main-ref guard' in p for p in problems), problems)
        self.assertTrue(any('belongs in site only' in p for p in problems), problems)

    def test_vector_gate_narrowed(self):
        self.assertBroken('deploy.yml', 'spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json',
                          'spec/verify_pull.py --vectors spec/vectors.json', 'independent-verifier must end')

    def test_runs_on_other_branches(self):
        self.assertBroken('deploy.yml', 'branches: [main]', 'branches: [main, release]', 'only on pushes to main')

    def test_handoff_kept_longer(self):
        self.assertBroken('deploy.yml', 'retention-days: 1\n', 'retention-days: 90\n', 'kept for 1 day')

    def test_handoff_not_sealed(self):
        self.assertBroken('deploy.yml', '          python3 -I scripts/deploy_contract.py seal release >> "$GITHUB_OUTPUT"\n',
                          '', 'build must seal')

    def test_unpinned_action(self):
        self.assertBroken('ci.yml', """  workflow-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
""", """  workflow-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
""", 'not pinned to a commit')

    # browser-tests.yml uploads from the shards and from the burn-in: break each upload in turn.
    BROWSER_UPLOADS = ['playwright-test-results-shard-${{ matrix.shard }}', 'playwright-test-results-burn-in']

    def test_ci_upload_on_success(self):
        for name in self.BROWSER_UPLOADS:
            with self.subTest(name):
                self.assertBroken('browser-tests.yml', f'        if: failure()\n        with:\n          name: {name}\n',
                                  f'        if: always()\n        with:\n          name: {name}\n',
                                  'must upload only on failure() and keep it 7 days')

    def test_ci_upload_kept_longer(self):
        for name in self.BROWSER_UPLOADS:
            with self.subTest(name):
                self.assertBroken('browser-tests.yml', f'name: {name}\n          path: test-results/\n          retention-days: 7\n',
                                  f'name: {name}\n          path: test-results/\n          retention-days: 30\n',
                                  'must upload only on failure() and keep it 7 days')

    def test_ci_runs_this_test(self):
        ci = dc.load(WORKFLOWS / 'ci.yml')
        self.assertIn('pull_request', ci['on'])
        runs = [s.get('run') for s in ci['jobs']['workflow-validation']['steps']]
        self.assertIn('python3 scripts/deploy_contract_test.py', runs)


# A stand-in for git on PATH: answers only the tip guard's ls-remote, as STUB_TIP says. Every answer also
# lists a suffix match carrying this run's commit, which the guard must not take for main.
GIT_STUB = '''#!/bin/sh
if [ "$*" != "ls-remote $GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git refs/heads/main" ]; then
  echo "unexpected git $*" >&2
  exit 2
fi
if [ "$STUB_TIP" = fail ]; then
  echo "fatal: unable to access '$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git/'" >&2
  exit 128
fi
[ -z "$STUB_TIP" ] || printf '%s\\trefs/heads/main\\n' "$STUB_TIP"
printf '%s\\trefs/remotes/fork/refs/heads/main\\n' "$GITHUB_SHA"
'''


class TipGuardShells(unittest.TestCase):
    """The tip guard refuses or passes with its own message under every shell a step can run in: the
    default (bash -e), shell: bash (bash -eo pipefail) and shell: sh (sh -e). It never exits silently."""

    SHELLS = (('bash', '-e'), ('bash', '--noprofile', '--norc', '-eo', 'pipefail'), ('sh', '-e'))
    SHA = 'a' * 40
    NEWER = 'b' * 40

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'bin').mkdir()
        git = self.tmp / 'bin/git'
        git.write_text(GIT_STUB, encoding='utf-8')
        git.chmod(0o755)
        workflow = dc.load(WORKFLOWS / 'deploy.yml')
        self.steps = {}
        for job in ('publish', 'deploy'):
            self.steps[job] = self.tmp / f'{job}.sh'
            self.steps[job].write_text(step_named(workflow, job, 'Require the tip of main')['run'], encoding='utf-8')

    def run_guard(self, job, shell, tip):
        env = {'PATH': f"{self.tmp / 'bin'}{os.pathsep}{os.environ['PATH']}", 'GITHUB_SERVER_URL': 'https://github.com',
               'GITHUB_REPOSITORY': ENV['GITHUB_REPOSITORY'], 'GITHUB_SHA': self.SHA, 'STUB_TIP': tip}
        return subprocess.run([shutil.which(shell[0]), *shell[1:], str(self.steps[job])], env=env, capture_output=True,
                              text=True)

    def test_refuses_or_passes_with_its_own_message(self):
        sha, newer = self.SHA, self.NEWER
        cases = (
            ('fail', 1, f'Could not read the tip of main, so not publishing {sha}.'),
            (newer, 1, f'Not publishing {sha}: main is now at {newer}.'),
            ('', 1, f'Not publishing {sha}: main is now at a commit this job could not read.'),
            (sha, 0, None),
        )
        for job in self.steps:
            for shell in self.SHELLS:
                for tip, code, message in cases:
                    with self.subTest(job=job, shell=' '.join(shell), tip=tip):
                        result = self.run_guard(job, shell, tip)
                        self.assertEqual(result.returncode, code, result)
                        errors = [line for line in result.stdout.splitlines() if line.startswith('::error::')]
                        if message is None:
                            self.assertEqual(errors, [], result)
                        else:
                            self.assertEqual(len(errors), 1, result)
                            self.assertIn(message, errors[0])


class Parser(unittest.TestCase):
    def refuse(self, text):
        with self.assertRaises(dc.Rejected):
            dc.Yaml(text, 'test.yml').document()

    def test_refuses_what_it_does_not_read(self):
        self.refuse('a: 1\na: 2\n')
        self.refuse('a:\n\tb: 1\n')
        self.refuse('a: >\n  folded\n')
        self.refuse('a: &x 1\nb: *x\n')
        self.refuse('a: {b: 1}\n')
        self.refuse("a: [x, 'y']\n")
        self.refuse('a: "x\\ny"\n')
        self.refuse('a: 1\n  b: 2\n')
        self.refuse('a:\n  - 1\n   - 2\n')

    def test_reads_the_shapes_workflows_use(self):
        text = "a: [x, y]\nb: {}\nc:\n  - d: 1\n    e: |\n      one\n      two\n  - f\n  - g: |-\n      h\nk: 'it''s' # c\n"
        self.assertEqual(dc.Yaml(text, 't').document(),
                         {'a': ['x', 'y'], 'b': {}, 'c': [{'d': 1, 'e': 'one\ntwo\n'}, 'f', {'g': 'h'}], 'k': "it's"})

    def test_matches_pyyaml(self):
        try:
            import yaml
        except ImportError:
            self.skipTest('PyYAML is not installed')

        def normal(node):  # YAML 1.1 reads the key `on` as true.
            if isinstance(node, dict):
                return {('on' if k is True else k): normal(v) for k, v in node.items()}
            return [normal(v) for v in node] if isinstance(node, list) else node

        for path in sorted(WORKFLOWS.glob('*.y*ml')):
            with self.subTest(path.name):
                self.assertEqual(dc.load(path), normal(yaml.safe_load(path.read_text(encoding='utf-8'))))


class Handoff(unittest.TestCase):
    """seal in build, verify in publish."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.release = self.tmp / 'release'
        self.dist = self.release / 'dist'
        (self.dist / 'assets').mkdir(parents=True)
        (self.dist / 'index.html').write_text('<!doctype html>')
        (self.dist / 'assets/app.js').write_text('console.log(1)')
        (self.dist / '.nojekyll').write_text('')

    def sealed(self):
        return dc.seal(self.release, ENV)

    def refused(self, digest, env=ENV, message=''):
        with self.assertRaisesRegex(dc.Rejected, message):
            dc.verify(self.release, env, digest)

    def test_round_trip(self):
        digest = self.sealed()
        self.assertRegex(digest, r'^[0-9a-f]{64}$')
        dc.verify(self.release, ENV, digest)
        stamp = json.loads((self.dist / 'deployment-id.json').read_text())
        self.assertEqual(stamp, {'repository': ENV['GITHUB_REPOSITORY'], 'run_id': ENV['GITHUB_RUN_ID'],
                                 'sha': ENV['GITHUB_SHA'], 'url': ENV['SITE_URL']})
        files = json.loads((self.release / 'manifest.json').read_text())['files']
        self.assertEqual(sorted(files), ['.nojekyll', 'assets/app.js', 'deployment-id.json', 'index.html'])
        self.assertEqual(files['index.html'], hashlib.sha256(b'<!doctype html>').hexdigest())

    def test_changed_file(self):
        digest = self.sealed()
        (self.dist / 'assets/app.js').write_text('console.log(2)')
        self.refused(digest, message="don't match")

    def test_added_file(self):
        digest = self.sealed()
        (self.dist / 'assets/extra.js').write_text('')
        self.refused(digest, message="don't match")

    def test_removed_file(self):
        digest = self.sealed()
        (self.dist / 'assets/app.js').unlink()
        self.refused(digest, message="don't match")

    def test_symlink(self):
        digest = self.sealed()
        (self.dist / 'link.js').symlink_to(self.dist / 'assets/app.js')
        self.refused(digest, message='symlink')

    def test_symlink_before_seal(self):
        (self.dist / 'link.js').symlink_to(self.dist / 'assets/app.js')
        with self.assertRaisesRegex(dc.Rejected, 'symlink'):
            self.sealed()

    def test_server_code(self):
        for name in ('_worker.js', '_routes.json'):
            with self.subTest(name):
                (self.dist / name).write_text('{}')
                with self.assertRaisesRegex(dc.Rejected, 'server code'):
                    self.sealed()
                (self.dist / name).unlink()
        digest = self.sealed()
        (self.dist / '_worker.js').write_text('export default {}')
        self.refused(digest, message='server code')

    def test_extra_top_level_file(self):
        digest = self.sealed()
        (self.release / 'extra.txt').write_text('')
        self.refused(digest, message='must hold only')

    def test_extra_file_before_seal(self):
        (self.release / 'extra.txt').write_text('')
        with self.assertRaisesRegex(dc.Rejected, 'must hold only'):
            self.sealed()

    def test_existing_marker(self):
        (self.dist / 'deployment-id.json').write_text('{}')
        with self.assertRaisesRegex(dc.Rejected, 'already exists'):
            self.sealed()

    def test_marker_edited(self):
        digest = self.sealed()
        (self.dist / 'deployment-id.json').write_text('{}\n')
        self.refused(digest, message="don't match")

    def test_wrong_digest(self):
        digest = self.sealed()
        self.refused('0' * 64, message="isn't the one build sealed")
        self.refused('', message='missing or malformed')
        self.refused(digest.upper(), message='missing or malformed')

    def test_other_run(self):
        digest = self.sealed()
        for key, value in (('GITHUB_SHA', 'b' * 40), ('GITHUB_RUN_ID', '123457'),
                           ('SITE_URL', 'https://brainrottcg.com/'), ('GITHUB_REPOSITORY', 'someone/BrainrotTCG')):
            with self.subTest(key):
                self.refused(digest, {**ENV, key: value}, 'another commit, run or address')

    def test_site_url_shape(self):
        for url in ('http://brainrottcg.pages.dev/', 'https://brainrottcg.pages.dev/app/', 'https://brainrottcg.pages.dev/app',
                    'https://brainrottcg.pages.dev//', 'https://u:p@brainrottcg.pages.dev/', 'https://brainrottcg.pages.dev:8443/',
                    'https://brainrottcg.pages.dev/?a', 'https://brainrottcg.pages.dev?', 'https://brainrottcg.pages.dev/#a',
                    'https://brainrottcg.pages.dev#', 'https://brainrottcg.pages.dev/ ', 'https:///', 'https://', ''):
            with self.subTest(url):
                with self.assertRaisesRegex(dc.Rejected, 'SITE_URL'):
                    dc.marker({**ENV, 'SITE_URL': url})

    def test_site_url_trailing_slash_optional(self):
        """https://x and https://x/ are the same address: the same marker, and either one verifies the other's seal."""
        bare = {**ENV, 'SITE_URL': ENV['SITE_URL'].rstrip('/')}
        self.assertEqual(dc.marker(bare), dc.marker(ENV))
        self.assertEqual(dc.marker(bare)['url'], 'https://brainrottcg.pages.dev/')
        digest = dc.seal(self.release, bare)
        dc.verify(self.release, ENV, digest)
        dc.verify(self.release, bare, digest)
        self.assertEqual(json.loads((self.dist / 'deployment-id.json').read_text())['url'], 'https://brainrottcg.pages.dev/')

    def test_cli(self):
        run = subprocess.run([sys.executable, '-I', str(SCRIPT), 'seal', str(self.release)],
                             env={**os.environ, **ENV}, capture_output=True, text=True, check=True)
        self.assertRegex(run.stdout, r'^manifest_sha256=[0-9a-f]{64}\n$')
        digest = run.stdout.strip().split('=', 1)[1]
        verify = [sys.executable, '-I', str(SCRIPT), 'verify', str(self.release)]
        subprocess.run(verify, env={**os.environ, **ENV, 'MANIFEST_SHA256': digest}, check=True, capture_output=True)
        (self.dist / 'index.html').write_text('changed')
        failed = subprocess.run(verify, env={**os.environ, **ENV, 'MANIFEST_SHA256': digest}, capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1)
        self.assertIn('Deployment rejected:', failed.stderr)
        usage = subprocess.run([sys.executable, '-I', str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(usage.returncode, 1)
        self.assertIn('usage:', usage.stderr)

    def test_readiness_check(self):
        """The publish step's loop, with curl and sleep stubbed: it passes only on the exact marker."""
        script = step_named(dc.load(WORKFLOWS / 'deploy.yml'), 'publish', 'Check the new address serves this build')['run']
        self.sealed()
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        served = self.tmp / 'served.json'
        (bin_dir / 'curl').write_text(f'#!/bin/sh\necho "$@" >> "{self.tmp}/curl.log"\ncat "{served}"\n')
        (bin_dir / 'sleep').write_text('#!/bin/sh\n')
        for stub in ('curl', 'sleep'):
            (bin_dir / stub).chmod(0o755)
        marker = (self.dist / 'deployment-id.json').read_bytes()
        for url in (ENV['SITE_URL'], ENV['SITE_URL'].rstrip('/')):
            with self.subTest(url):
                env = {'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'URL': url,
                       'GITHUB_RUN_ID': ENV['GITHUB_RUN_ID'], 'GITHUB_RUN_ATTEMPT': '2'}
                log = self.tmp / 'curl.log'
                log.write_text('')

                def check(content):
                    served.write_bytes(content)
                    return subprocess.run(['bash', '-e', '-c', script], cwd=self.tmp, env=env, capture_output=True).returncode

                self.assertEqual(check(marker), 0)
                self.assertIn('https://brainrottcg.pages.dev/deployment-id.json?run=123456-2', log.read_text())
                self.assertNotIn('.dev//', log.read_text())
                self.assertNotEqual(check(marker.replace(b'123456', b'123455')), 0)
                self.assertNotEqual(check(marker.rstrip(b'\n')), 0)


class Guard(unittest.TestCase):
    """The site job's first step, run as the workflow has it."""

    def test_only_main(self):
        guard = dc.load(WORKFLOWS / 'deploy.yml')['jobs']['site']['steps'][0]
        self.assertEqual(guard, dc.GUARD)
        for ref, passes in (('refs/heads/main', True), ('refs/heads/Main', False), ('refs/heads/main-x', False),
                            ('refs/tags/main', False), ('refs/heads/feature', False), ('', False)):
            with self.subTest(ref):
                code = subprocess.run(['bash', '-e', '-c', guard['run']], env={'SOURCE_REF': ref}).returncode
                self.assertEqual(code == 0, passes)


class TipGuard(unittest.TestCase):
    """publish's and deploy's first step, run as the workflow has it with git stubbed."""

    def test_only_the_tip_of_main(self):
        jobs = dc.load(WORKFLOWS / 'deploy.yml')['jobs']
        self.assertEqual(jobs['publish']['steps'][0], dc.cloudflare(dc.TIP))
        self.assertEqual(jobs['deploy']['steps'][0], dc.TIP)
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / 'git').write_text(f'#!/bin/sh\necho "$@" >> "{tmp}/git.log"\nprintf "$STUB_OUT"\nexit "$STUB_EXIT"\n')
        (tmp / 'git').chmod(0o755)
        sha, newer = 'a' * 40, 'b' * 40
        main, decoy = 'refs/heads/main', 'refs/heads/x/refs/heads/main'
        unread, failed = 'a commit this job could not read', 'lookup failed'
        # A push run, or a re-run of main's latest commit, sees its own commit at the tip; a re-run of
        # a superseded commit sees a newer one; and a failed lookup refuses rather than publishes, and
        # says so. ls-remote matches by suffix, so a branch ending in refs/heads/main also answers: only
        # main itself counts, and a decoy alone reads as no tip.
        for lines, code, shown in (([(sha, main)], 0, None), ([(newer, main)], 0, newer), ([], 128, failed), ([], 2, failed),
                                   ([(sha, main)], 128, failed),
                                   ([(newer, decoy), (sha, main)], 0, None), ([(sha, decoy), (newer, main)], 0, newer),
                                   ([(sha, decoy)], 0, unread)):
            out = ''.join(f'{commit}\\t{ref}\\n' for commit, ref in lines)
            with self.subTest(out=out, code=code):
                env = {'PATH': f'{tmp}:{os.environ["PATH"]}', 'STUB_OUT': out, 'STUB_EXIT': str(code), 'GITHUB_SHA': sha,
                       'GITHUB_SERVER_URL': 'https://github.com', 'GITHUB_REPOSITORY': ENV['GITHUB_REPOSITORY']}
                # The shell GitHub runs a step's script with, pipefail included.
                result = subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', dc.TIP['run']],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, shown is None, result.stdout)
                if shown == failed:
                    self.assertIn(f'::error::Could not read the tip of main, so not publishing {sha}.', result.stdout)
                    self.assertNotIn('main is now at', result.stdout)
                elif shown is not None:
                    self.assertIn(f'::error::Not publishing {sha}: main is now at {shown}.', result.stdout)
                    self.assertIn('start this workflow on main by hand', result.stdout)
        self.assertEqual(set((tmp / 'git.log').read_text().splitlines()),
                         {'ls-remote https://github.com/evanlin23/BrainrotTCG.git refs/heads/main'})


@unittest.skipUnless(shutil.which('jq'), 'the site lookup needs jq, as on the runner')
class SiteLookup(unittest.TestCase):
    """The site job's lookup, run as the workflow has it with Cloudflare's API stubbed: SITE_URL may end in / or not."""

    def outputs(self, custom_url):
        script = dc.load(WORKFLOWS / 'deploy.yml')['jobs']['site']['steps'][1]['run']
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / 'curl').write_text('#!/bin/sh\necho \'{"success":true,"result":{"subdomain":"brainrottcg.pages.dev"}}\'\n')
        (tmp / 'curl').chmod(0o755)
        env = {'PATH': f'{tmp}:{os.environ["PATH"]}', 'GITHUB_OUTPUT': str(tmp / 'out'), 'CLOUDFLARE_API_TOKEN': 'token',
               'CLOUDFLARE_ACCOUNT_ID': 'account', 'PROJECT': 'brainrottcg', 'CUSTOM_URL': custom_url,
               'OWNER': 'evanlin23', 'REPO': 'BrainrotTCG'}
        subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script], env=env, check=True, capture_output=True)
        return dict(line.split('=', 1) for line in (tmp / 'out').read_text().splitlines())

    def test_address_ends_in_one_slash(self):
        for custom_url, url in (('', 'https://brainrottcg.pages.dev/'), ('https://brainrottcg.com', 'https://brainrottcg.com/'),
                                ('https://brainrottcg.com/', 'https://brainrottcg.com/'),
                                ('https://brainrottcg.com//', 'https://brainrottcg.com/'),
                                ('https://brainrottcg.com///', 'https://brainrottcg.com/')):
            with self.subTest(custom_url):
                self.assertEqual(self.outputs(custom_url), {'host': 'cloudflare', 'url': url, 'base': '/'})
                self.assertEqual(dc.marker({**ENV, 'SITE_URL': url})['url'], url)


if __name__ == '__main__':
    unittest.main()
