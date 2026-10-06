"""Provision a clean shared workspace and nested submodules inside the container.

Source: /git (read-only). Target: /workspace/sail-all.
This is the successful shallow-repository conversion used during this session.
Run only during fresh workspace provisioning, not on a workspace with user edits.
"""
import json
import pathlib
import shutil
import subprocess


def git(path, *args, capture=False, check=True):
    return subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(path), *args],
                          check=check, text=True, capture_output=capture)


source = pathlib.Path('/git')
target = pathlib.Path('/workspace/sail-all')
paths = git(source, 'submodule', 'foreach', '--recursive', '--quiet',
            'printf "%s\\n" "$displaypath"', capture=True).stdout.splitlines()
records = []
for relative in ['.'] + paths:
    src, dst = source / relative, target / relative
    src_head = git(src, 'rev-parse', 'HEAD', capture=True).stdout.strip()
    common = pathlib.Path(git(src, 'rev-parse', '--git-common-dir', capture=True).stdout.strip())
    if not common.is_absolute():
        common = (src / common).resolve()
    if not common.is_relative_to(source):
        raise RuntimeError(f'Source object directory is outside /git: {common}')
    expected = str(common / 'objects')
    alt_file = dst / '.git/objects/info/alternates'
    if not (dst / '.git').exists():
        git(source, 'clone', '--shared', str(common), str(dst))
    if git(dst, 'rev-parse', 'HEAD', capture=True).stdout.strip() != src_head:
        git(dst, 'checkout', '--detach', src_head)
    if not alt_file.exists():
        # Git ignores --shared for shallow sources. Preserve shallow boundaries,
        # install the alternate explicitly, and verify before discarding copies.
        if git(dst, 'status', '--porcelain', capture=True).stdout:
            raise RuntimeError(f'Refusing to convert a modified repository: {dst}')
        objects = dst / '.git/objects'
        backup = dst / '.git/objects-clone-backup'
        objects.rename(backup)
        try:
            alt_file.parent.mkdir(parents=True)
            alt_file.write_text(expected + '\n')
            shallow = common / 'shallow'
            if shallow.exists():
                shutil.copyfile(shallow, dst / '.git/shallow')
            git(dst, 'fsck', '--connectivity-only')
            git(dst, 'status', '--porcelain')
        except BaseException:
            shutil.rmtree(objects)
            backup.rename(objects)
            raise
        shutil.rmtree(backup)
    for remote in git(dst, 'remote', capture=True).stdout.splitlines():
        git(dst, 'remote', 'remove', remote)
    git(dst, 'config', 'user.name', 'Workspace Agent')
    git(dst, 'config', 'user.email', 'workspace-agent@localhost')
    git(dst, 'config', 'push.default', 'nothing')
    git(dst, 'config', 'core.hooksPath', '.git/hooks')
    git(dst, 'config', 'gc.auto', '0')
    hook = dst / '.git/hooks/pre-push'
    hook.write_text('#!/bin/sh\necho "Push disabled: this workspace is for local changes and commits only." >&2\nexit 1\n')
    hook.chmod(0o755)
    if (dst / '.gitmodules').exists():
        result = git(dst, 'config', '-f', '.gitmodules', '--get-regexp',
                     r'^submodule\..*\.path$', capture=True, check=False)
        if result.returncode not in (0, 1):
            raise RuntimeError(result.stderr)
        for line in result.stdout.splitlines():
            key, path = line.split(' ', 1)
            prefix = key[:-len('.path')]
            git(dst, 'config', prefix + '.url', str(src / path))
            git(dst, 'config', prefix + '.active', 'true')
    alternate = alt_file.read_text().strip()
    if alternate != expected:
        raise RuntimeError(f'Wrong alternates: {alternate}, expected {expected}')
    records.append({'path': relative, 'head': src_head, 'alternates': alternate})
pathlib.Path('/workspace/clone-manifest.json').write_text(json.dumps(records, indent=2) + '\n')
info = pathlib.Path('/workspace/container-info.json')
metadata = json.loads(info.read_text()) if info.exists() else {}
metadata['status'] = 'ready'
metadata['repository_count'] = len(records)
info.write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({'cloned_repositories': len(records), 'repositories': records}, indent=2))
