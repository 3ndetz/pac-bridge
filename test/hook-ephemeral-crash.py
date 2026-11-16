import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile

if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
    print('Linux pidfd support is required for this isolated test.')
    raise SystemExit(77)

root = Path(tempfile.mkdtemp(prefix='pac-hook-crash-')).resolve()
child = None
handle = None
confirmed_exit = False
try:
    module = (Path(__file__).resolve().parents[1] / 'src' / 'hook-transcript.mjs').as_uri()
    script = f'''import {{ withEphemeralHookTranscript }} from {module!r};
await withEphemeralHookTranscript(Buffer.from('synthetic').toString('base64'), async path => {{
  process.stdout.write(path + '\\n'); setInterval(() => {{}}, 1000); await new Promise(() => {{}});
}});'''
    env = {'PATH': '/usr/local/bin' + os.pathsep + os.defpath, 'TMPDIR': str(root)}
    child = subprocess.Popen(['node', '--input-type=module', '-e', script], env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    handle = os.pidfd_open(child.pid)
    if not select.select([child.stdout], [], [], 20)[0]:
        raise RuntimeError('Owned transcript process did not become ready.')
    path = child.stdout.readline().strip()
    if not path.startswith('/proc/') or Path(path).read_text(encoding='utf-8') != 'synthetic':
        raise AssertionError('Synthetic transcript was not available through the owned process.')
    signal.pidfd_send_signal(handle, signal.SIGKILL)
    code = child.wait(timeout=20)
    confirmed_exit = True
    if code != -signal.SIGKILL or Path(path).exists() or list(root.iterdir()):
        raise AssertionError('Transcript remained available after the owned process exited.')
    print('Owned process exited and its unlinked transcript was unavailable.')
finally:
    if handle is not None:
        os.close(handle)
    if child is None or confirmed_exit:
        if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('pac-hook-crash-'):
            raise RuntimeError('Refusing unexpected test cleanup path.')
        shutil.rmtree(root)
    else:
        print('Test process exit is unconfirmed; temporary state retained.', file=sys.stderr)
