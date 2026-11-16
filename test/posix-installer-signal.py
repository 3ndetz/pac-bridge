import os
from pathlib import Path
import shutil
import select
import signal
import subprocess
import sys
import tempfile
import time

if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
    print('Linux pidfd support is required for this isolated test.')
    raise SystemExit(77)

root = Path(tempfile.mkdtemp(prefix='pac-installer-signal-')).resolve()
child = None
handle = None
npm_handle = None
safe_cleanup = False
release = root / 'release'
try:
    repo, home, keys, fakebin, native = [root / name for name in ('repo', 'home', 'keys', 'bin', 'native')]
    for directory in (repo / 'scripts', repo / 'adapters', repo / 'src', repo / 'source-package', home, keys, fakebin, native):
        directory.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parents[1] / 'scripts' / 'install-posix.sh'
    (repo / 'scripts' / 'install-posix.sh').write_bytes(source.read_bytes().replace(b'\r\n', b'\n'))
    for name in ('package.json', 'package-lock.json'):
        (repo / 'source-package' / name).write_text('{}', encoding='utf-8')
    (repo / 'adapters' / 'pac-hapi-opencode.mjs').write_text('', encoding='utf-8')
    (repo / 'scripts' / 'pac-posix-launcher.mjs').write_text('', encoding='utf-8')
    for name in ('connection.json', 'pac-source-token.txt', 'pac-relay-ca.pem'):
        (keys / name).write_text('synthetic', encoding='utf-8')
    def executable(path, body):
        path.write_text('#!/bin/sh\n' + body + '\n', encoding='utf-8')
        path.chmod(0o700)
    executable(native / 'opencode', 'exit 0')
    executable(fakebin / 'node', 'printf "24\\n"')
    executable(fakebin / 'git', '''case "$1" in
      rev-parse) printf '%040d\\n' 0;;
      archive) tar -cf - adapters src source-package scripts/pac-posix-launcher.mjs;;
      *) exit 1;;
    esac''')
    executable(fakebin / 'npm', '''printf '%s' "$$" > "$PAC_TEST_READY.tmp"
mv "$PAC_TEST_READY.tmp" "$PAC_TEST_READY"
while [ ! -f "$PAC_TEST_RELEASE" ]; do sleep 0.1; done
printf done > "$PAC_TEST_DONE"
exit 0''')
    env = {'HOME': str(home), 'PATH': str(fakebin) + os.pathsep + os.defpath,
           'PAC_TEST_READY': str(root / 'ready'), 'PAC_TEST_RELEASE': str(release), 'PAC_TEST_DONE': str(root / 'done')}
    child = subprocess.Popen(['sh', str(repo / 'scripts' / 'install-posix.sh'), str(keys), str(native / 'opencode')],
                             cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    handle = os.pidfd_open(child.pid)
    deadline = time.monotonic() + 20
    while not (root / 'ready').exists():
        if child.poll() is not None:
            raise RuntimeError('Installer exited before the test reached its controlled wait.')
        if time.monotonic() >= deadline:
            raise RuntimeError('Controlled installer wait was not reached; cleanup remains unconfirmed.')
        time.sleep(0.05)
    npm_pid = int((root / 'ready').read_text(encoding='utf-8'))
    npm_handle = os.pidfd_open(npm_pid)
    signal.pidfd_send_signal(handle, signal.SIGTERM)
    release.touch()
    code = child.wait(timeout=20)
    if not select.select([npm_handle], [], [], 20)[0] or not (root / 'done').exists():
        raise RuntimeError('Owned dependency fixture exit is unconfirmed.')
    safe_cleanup = True
    if code == 0:
        raise AssertionError('Interrupted installer reported success.')
    base = home / '.local' / 'share' / 'pac-bridge'
    if (base / '.install-lock').exists() or (base / 'current').exists() or any((base / 'versions').iterdir()):
        raise AssertionError('Interrupted installer did not clean its own stage and lock.')
    print('Owned installer exited on SIGTERM and cleaned its stage and lock.')
finally:
    if handle is not None:
        os.close(handle)
    if npm_handle is not None:
        os.close(npm_handle)
    if child is None or safe_cleanup:
        if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('pac-installer-signal-'):
            raise RuntimeError('Refusing unexpected test cleanup path.')
        shutil.rmtree(root)
    else:
        print('Test process exit is unconfirmed; temporary state retained.', file=sys.stderr)
