"""One-time setup: 2 GiB /swapfile, fstab persistence, swappiness=10.

Run on the host, not inside Docker. Refuses to overwrite existing files.
A failure may leave partial setup; inspect before retrying, never blindly delete
or reformat an existing swap file.
"""
import datetime
import os
import pathlib
import shutil
import subprocess


def run(*args):
    return subprocess.run(args, check=True, text=True)


swap = pathlib.Path('/swapfile')
config = pathlib.Path('/etc/sysctl.d/99-sail-build-swap.conf')
if swap.exists() or swap.is_symlink():
    raise RuntimeError('Refusing to overwrite existing /swapfile')
if config.exists() or config.is_symlink():
    raise RuntimeError('Refusing to overwrite existing swap tuning file')
if shutil.disk_usage('/').free < 4 * 1024**3:
    raise RuntimeError('Insufficient disk headroom')
old_umask = os.umask(0o077)
try:
    fd = os.open(swap, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    run('fallocate', '-l', str(2 * 1024**3), str(swap))
    run('chmod', '600', str(swap))
    run('mkswap', str(swap))
    run('swapon', str(swap))
    active = pathlib.Path('/proc/swaps').read_text()
    if not any(line.split()[0] == str(swap) for line in active.splitlines()[1:]):
        raise RuntimeError('Swap activation verification failed')
    fstab = pathlib.Path('/etc/fstab')
    backup = pathlib.Path('/etc/fstab.sail-swap-backup-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    shutil.copy2(fstab, backup)
    before = fstab.read_text()
    for line in before.splitlines():
        fields = line.split()
        if fields and not fields[0].startswith('#') and fields[0] == str(swap):
            raise RuntimeError('Unexpected existing fstab entry; swap active but persistence not changed')
    with fstab.open('a') as handle:
        if before and not before.endswith('\n'):
            handle.write('\n')
        handle.write('# Local build memory headroom (sail-all)\n/swapfile none swap sw 0 0\n')
    with config.open('x') as handle:
        handle.write('# Give local C++ builds conservative anonymous-memory swap headroom.\nvm.swappiness = 10\n')
    config.chmod(0o644)
    run('sysctl', '-w', 'vm.swappiness=10')
    print('FSTAB_BACKUP=' + str(backup))
    run('swapon', '--show', '--bytes')
    run('free', '-h')
    run('sysctl', 'vm.swappiness')
finally:
    os.umask(old_umask)
