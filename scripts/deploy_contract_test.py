"""Offline release fixtures. Never dispatch workflows, contact providers or publish."""
from contextlib import contextmanager
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch
from urllib.error import URLError

from deploy_contract import current_main, metadata, seal, source, verify

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/deploy.yml'
ENV = {'GITHUB_REPOSITORY': 'evanlin23/BrainrotTCG', 'GITHUB_REF': 'refs/heads/main',
       'GITHUB_EVENT_NAME': 'push', 'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123',
       'GITHUB_RUN_ATTEMPT': '1', 'SITE_HOST': 'github',
       'SITE_URL': 'https://evanlin23.github.io/BrainrotTCG/'}


def jobs(text):
    text = text.split('jobs:\n', 1)[1]
    starts = list(re.finditer(r'^  ([a-z-]+):\n', text, re.M))
    return {match[1]: text[match.end(): starts[index + 1].start() if index + 1 < len(starts) else len(text)]
            for index, match in enumerate(starts)}


def validate_graph(text):
    graph = jobs(text)
    assert set(graph) == {'source', 'independent-verifier', 'site', 'build', 'publish'}
    assert 'needs: source' in graph['independent-verifier']
    assert 'needs: [source, independent-verifier]' in graph['site']
    assert 'needs: [source, independent-verifier, site]' in graph['build']
    publisher = graph['publish']
    assert 'needs: [source, independent-verifier, site, build]' in publisher
    assert "if: needs.build.result == 'success' && needs.independent-verifier.result == 'success'" in publisher
    assert 'always()' not in publisher.replace('# No always():', '# No unconditional execution:')
    # Scope production permissions and both credential references to the only intended jobs.
    assert not re.search(r': (?:write|write-all)\b', text.split('jobs:')[0])
    assert 'pages: write' not in text.split('jobs:')[0]
    assert 'id-token: write' not in text.split('jobs:')[0]
    assert 'concurrency:' not in text.split('jobs:')[0]
    for name in ('source', 'independent-verifier', 'build'):
        assert 'secrets.' not in graph[name]
        assert not re.search(r'^\s+[a-z-]+: write$', graph[name], re.M)
    assert 'actions/checkout' not in graph['site'] and 'npm' not in graph['site'].replace('# Read-only provider lookup: no checkout/npm or project creation in this job.', '')
    assert 'environment: github-pages' in graph['site']
    assert 'name: github-pages' in publisher
    assert 'group: production-pages' in publisher and 'cancel-in-progress: false' in publisher
    assert 'artifact-ids: ${{ needs.build.outputs.artifact_id }}' in publisher
    assert 'MANIFEST_SHA256: ${{ needs.build.outputs.manifest_sha256 }}' in publisher
    required_order = ('deploy_contract.py verify release',
             'deploy_contract.py current-main', 'Install the pinned publisher',
             'Deploy the verified Cloudflare files', 'Verify the new address',
             'Recheck source before changing the old address', 'actions/upload-pages-artifact', 'actions/deploy-pages')
    assert all(token in publisher for token in required_order)
    order = [publisher.index(token) for token in required_order]
    assert order == sorted(order)
    assert 'release/dist' in publisher and "'release/pages' || 'release/dist'" in publisher
    assert 'npm ci' not in publisher.replace('# No npm ci, build or repository package hooks in the credential-bearing step.', '')
    assert '--ignore-scripts' in publisher
    assert 'prebuild' not in publisher.lower()


class ArtifactTests(unittest.TestCase):
    @contextmanager
    def bundle(self, host='github'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'dist/assets').mkdir(parents=True)
            (root / 'dist/index.html').write_text('<script src="assets/index-abc.js"></script>')
            (root / 'dist/assets/index-abc.js').write_text('console.log("verified")')
            env = deepcopy(ENV)
            if host == 'cloudflare':
                env.update(SITE_HOST=host, SITE_URL='https://brainrottcg.pages.dev/')
                (root / 'pages').mkdir()
                for name in ('index.html', '404.html'):
                    (root / 'pages' / name).write_text('save-compatible forwarding')
            yield root, env

    def test_both_hosts_and_main_dispatch(self):
        for host in ('github', 'cloudflare'):
            with self.subTest(host=host), self.bundle(host) as (root, env):
                env['GITHUB_EVENT_NAME'] = 'workflow_dispatch'
                digest = seal(root, env)
                verify(root, env, digest)
                self.assertEqual(json.loads((root / 'deployment.json').read_text())['base'], '/' if host == 'cloudflare' else '/BrainrotTCG/')

    def test_wrong_source_event_or_identity_rejected(self):
        for key, value in [('GITHUB_REF', 'refs/heads/MAIN'), ('GITHUB_REF', 'refs/heads/feature'),
                           ('GITHUB_REPOSITORY', 'fork/BrainrotTCG'), ('GITHUB_EVENT_NAME', 'pull_request'),
                           ('GITHUB_SHA', 'HEAD'), ('GITHUB_RUN_ID', ''), ('GITHUB_RUN_ATTEMPT', '0')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                source({**ENV, key: value})

    def test_other_run_attempt_revision_or_host_rejected(self):
        for key, value in [('GITHUB_SHA', 'b' * 40), ('GITHUB_RUN_ID', '124'),
                           ('GITHUB_RUN_ATTEMPT', '2'), ('SITE_HOST', 'cloudflare'),
                           ('SITE_URL', 'https://evil.example/')]:
            with self.subTest(key=key), self.bundle() as (root, env):
                digest = seal(root, env)
                with self.assertRaises(ValueError):
                    verify(root, {**env, key: value}, digest)

    def test_modified_missing_extra_file_or_manifest_rejected(self):
        for mutation in ('modify', 'remove', 'extra', 'manifest'):
            with self.subTest(mutation=mutation), self.bundle() as (root, env):
                digest = seal(root, env)
                if mutation == 'modify':
                    (root / 'dist/assets/index-abc.js').write_text('tampered')
                elif mutation == 'remove':
                    (root / 'dist/index.html').unlink()
                elif mutation == 'extra':
                    (root / 'dist/injected.js').write_text('unexpected')
                else:
                    (root / 'deployment.json').write_text('{}')
                with self.assertRaises(ValueError):
                    verify(root, env, digest)

    def test_missing_forwarding_or_symlink_rejected(self):
        with self.bundle('cloudflare') as (root, env):
            (root / 'pages/404.html').unlink()
            with self.assertRaises(ValueError):
                seal(root, env)
        with self.bundle() as (root, env):
            (root / 'dist/leak').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                seal(root, env)

    def test_invalid_urls_rejected(self):
        for url in ('http://host/', 'https://user:pass@host/', 'https://host/?x=1',
                    'https://host/#fragment', 'https://host:443/', 'https://host/path/',
                    'https://host/\nbase=evil', 'https://host/ '):
            with self.subTest(url=url), self.assertRaises(ValueError):
                metadata({**ENV, 'SITE_HOST': 'cloudflare', 'SITE_URL': url})

    def test_current_main_stale_and_failed_api_fail_closed(self):
        with patch('deploy_contract.urlopen', return_value=io.StringIO(json.dumps({'object': {'sha': ENV['GITHUB_SHA']}}))):
            current_main({**ENV, 'GITHUB_TOKEN': 'fixture-token'})
        with patch('deploy_contract.urlopen', return_value=io.StringIO(json.dumps({'object': {'sha': 'b' * 40}}))):
            with self.assertRaises(ValueError):
                current_main({**ENV, 'GITHUB_TOKEN': 'fixture-token'})
        with patch('deploy_contract.urlopen', side_effect=URLError('offline fixture')):
            with self.assertRaises(URLError):
                current_main({**ENV, 'GITHUB_TOKEN': 'fixture-token'})


class WorkflowTests(unittest.TestCase):
    def test_real_source_shell_is_case_sensitive(self):
        guard = jobs(WORKFLOW.read_text())['source'].split('        run: |\n', 1)[1]
        guard = textwrap.dedent(guard)
        base = {**os.environ, 'SOURCE_REPOSITORY': ENV['GITHUB_REPOSITORY'],
                'SOURCE_REF': ENV['GITHUB_REF'], 'SOURCE_EVENT': ENV['GITHUB_EVENT_NAME']}
        for overrides in ({}, {'SOURCE_EVENT': 'workflow_dispatch'}, {'SOURCE_REF': 'refs/heads/MAIN'},
                          {'SOURCE_REF': 'refs/heads/feature'}, {'SOURCE_REPOSITORY': 'evanlin23/brainrottcg'},
                          {'SOURCE_EVENT': 'pull_request_target'}):
            result = subprocess.run(['bash', '-e', '-c', guard], env={**base, **overrides}, capture_output=True, check=False)
            self.assertEqual(result.returncode == 0, not overrides or overrides == {'SOURCE_EVENT': 'workflow_dispatch'})

    def test_real_workflow_graph_and_mutations(self):
        text = WORKFLOW.read_text()
        validate_graph(text)
        mutations = [
            ('needs: [source, independent-verifier, site, build]', 'needs: [site, build]'),
            ("if: needs.build.result == 'success' && needs.independent-verifier.result == 'success'", 'if: always()'),
            ('artifact-ids: ${{ needs.build.outputs.artifact_id }}', 'name: stale-site'),
            ('MANIFEST_SHA256: ${{ needs.build.outputs.manifest_sha256 }}', 'MANIFEST_SHA256: ignored'),
            ('      - run: npm ci', '      - run: npm ci\n        env:\n          LEAK: ${{ secrets.CLOUDFLARE_API_TOKEN }}'),
            ('      issues: read', '      issues: read\n      pages: write'),
            ('      issues: read', '      issues: write'),
            ('  contents: read', '  contents: write'),
            ('cancel-in-progress: false', 'cancel-in-progress: true'),
            ('deploy_contract.py verify release', 'echo skip verification'),
        ]
        for old, new in mutations:
            with self.subTest(mutation=old), self.assertRaises(AssertionError):
                validate_graph(text.replace(old, new))

    def test_actual_host_discovery_uses_only_get_and_falls_back(self):
        job = jobs(WORKFLOW.read_text())['site']
        code = textwrap.dedent(job.split("          python3 - <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
        for mode in ('cloudflare', 'missing', 'offline', 'no-token'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'output'
                env = {'CLOUDFLARE_API_TOKEN': '' if mode == 'no-token' else 'fixture-token',
                       'CLOUDFLARE_ACCOUNT_ID': 'a' * 32, 'PROJECT': 'brainrottcg',
                       'CUSTOM_URL': '', 'GITHUB_OUTPUT': str(output)}
                response = {'success': True, 'result': {'subdomain': 'brainrottcg.pages.dev'}} if mode == 'cloudflare' else {'success': False}
                with patch.dict(os.environ, env), patch('urllib.request.urlopen') as provider:
                    if mode == 'offline':
                        provider.side_effect = URLError('offline fixture')
                    else:
                        provider.return_value = io.StringIO(json.dumps(response))
                    exec(compile(code, str(WORKFLOW), 'exec'), {})
                    if mode == 'no-token':
                        provider.assert_not_called()
                    else:
                        request = provider.call_args.args[0]
                        self.assertEqual(request.get_method(), 'GET')
                        self.assertEqual(request.full_url, 'https://api.cloudflare.com/client/v4/accounts/' + 'a' * 32 + '/pages/projects/brainrottcg')
                fields = dict(line.split('=', 1) for line in output.read_text().splitlines())
                self.assertEqual(fields['host'], 'cloudflare' if mode == 'cloudflare' else 'github')
                self.assertNotIn('fixture-token', output.read_text())


if __name__ == '__main__':
    unittest.main()
