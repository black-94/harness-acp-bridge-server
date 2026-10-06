"""Verify a newly provisioned clean workspace; uses temporary local branches/commits.

Do not run after user edits or commits. The temporary test branch is removed,
tracked files and HEAD are restored, and the read-only source is never written.
"""
import errno
import hashlib
import json
import os
import pathlib
import subprocess
import uuid

source = pathlib.Path('/git')
target = pathlib.Path('/workspace/sail-all')
records = json.loads(pathlib.Path('/workspace/clone-manifest.json').read_text())
env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')


def git(path, *args, check=True):
    return subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(path), *args],
                          text=True, capture_output=True, check=check, env=env)


def snapshot(path):
    gitdir = pathlib.Path(git(path, 'rev-parse', '--absolute-git-dir').stdout.strip())
    return {'head': git(path, 'rev-parse', 'HEAD').stdout.strip(),
            'refs': git(path, 'show-ref').stdout,
            'status': git(path, 'status', '--porcelain').stdout,
            'config_sha256': hashlib.sha256((gitdir / 'config').read_bytes()).hexdigest()}


results = []
for record in reversed(records):
    relative = record['path']
    src, dst = source / relative, target / relative
    before = snapshot(src)
    assert before['head'] == record['head']
    assert not before['status'], (relative, before['status'])
    assert git(dst, 'rev-parse', 'HEAD').stdout.strip() == record['head']
    assert not git(dst, 'status', '--porcelain').stdout
    assert not git(dst, 'remote').stdout
    alternate = (dst / '.git/objects/info/alternates').read_text().strip()
    assert alternate == record['alternates'] and alternate.startswith('/git/')
    source_gitdir = pathlib.Path(git(src, 'rev-parse', '--absolute-git-dir').stdout.strip())
    try:
        fd = os.open(source_gitdir / 'config', os.O_WRONLY)  # no truncate/write
    except OSError as error:
        assert error.errno == errno.EROFS, (relative, str(error))
    else:
        os.close(fd)
        raise AssertionError(f'Source is writable: {relative}')
    original_ref = git(dst, 'symbolic-ref', '-q', '--short', 'HEAD', check=False).stdout.strip()
    branch = '__isolation_verify_' + uuid.uuid4().hex
    marker = dst / ('.isolation-verify-' + uuid.uuid4().hex)
    git(dst, 'switch', '-c', branch)
    try:
        marker.write_text('Temporary local-only isolation verification.\n')
        git(dst, 'add', '--', marker.name)
        git(dst, 'commit', '-m', 'test: verify local-only workspace commit')
        commit = git(dst, 'rev-parse', 'HEAD').stdout.strip()
        assert commit != before['head']
        assert (dst / '.git/objects' / commit[:2] / commit[2:]).exists()
        forbidden = git(dst, 'push', str(src), 'HEAD:refs/heads/' + branch, check=False)
        assert forbidden.returncode != 0
        assert 'Push disabled' in forbidden.stderr, forbidden.stderr
        assert snapshot(src) == before
    finally:
        if original_ref:
            git(dst, 'switch', original_ref)
        else:
            git(dst, 'switch', '--detach', record['head'])
        git(dst, 'branch', '-D', branch)
        if marker.exists():
            marker.unlink()
    assert git(dst, 'rev-parse', 'HEAD').stdout.strip() == record['head']
    assert not git(dst, 'status', '--porcelain').stdout
    git(dst, 'fsck', '--connectivity-only', '--no-dangling')
    results.append({'repository': relative, 'source_readonly': True,
                    'private_write_and_commit': True, 'push_rejected': True,
                    'source_unchanged': True, 'clean_copy': True,
                    'shared_connectivity': True})
status = git(target, 'submodule', 'status', '--recursive').stdout
assert len(status.splitlines()) == len(records) - 1
assert all(line.startswith(' ') for line in status.splitlines()), status
report = {'passed_repositories': len(results), 'checks': results, 'submodule_status': status}
pathlib.Path('/workspace/verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
