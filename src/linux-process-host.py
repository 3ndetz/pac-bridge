#!/usr/bin/env python3
"""Own one Linux command tree without signalling a reused process-group ID."""
import base64
import ctypes
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time


def check_support():
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('Linux process handles are unavailable')
    with open('/proc/thread-self/children', 'rb') as stream:
        stream.read()
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def own_descendants():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'Linux child ownership is unavailable')


def signal_handle(fd):
    try:
        signal.pidfd_send_signal(fd, signal.SIGKILL)
    except ProcessLookupError:
        pass


def stop_adopted_children():
    # Only this single-threaded owner's kernel child list is inspected. No
    # process-wide scan, command-line match or process-group kill is used.
    with open('/proc/thread-self/children', 'r', encoding='ascii') as stream:
        children = [int(value) for value in stream.read().split()]
    for pid in children:
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            try:
                with open('/proc/' + str(pid) + '/status', 'rb') as stream:
                    parent = next(int(line.split()[1]) for line in stream if line.startswith(b'PPid:'))
            except FileNotFoundError:
                continue
            # Check ownership after opening the process handle. If it exited
            # meanwhile, that handle cannot signal a replacement process.
            if parent != os.getpid():
                continue
            signal_handle(fd)
        finally:
            os.close(fd)


def prove_closed(nonce):
    try:
        proof = ('CLOSED ' + nonce + '\n').encode('ascii')
        while proof:
            proof = proof[os.write(3, proof):]
    except (BrokenPipeError, ConnectionResetError):
        pass  # The parent may already have exited.


def main():
    check_support()
    if len(sys.argv) == 2 and sys.argv[1] == '--check':
        own_descendants()
        print('PAC_LINUX_PROCESS_OWNER_V1')
        return 0
    if len(sys.argv) != 2:
        raise RuntimeError('Invalid process host input')
    spec = json.loads(base64.b64decode(sys.argv[1], validate=True).decode('utf-8'))
    if not isinstance(spec, dict) or not isinstance(spec.get('command'), str) or not spec['command'] or not isinstance(spec.get('args'), list) or any(not isinstance(arg, str) for arg in spec['args']):
        raise RuntimeError('Invalid process host input')
    if not isinstance(spec.get('nonce'), str) or not re.fullmatch('[a-f0-9]{32}', spec['nonce']):
        raise RuntimeError('Invalid owner nonce')
    mode = os.fstat(3).st_mode
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
        raise RuntimeError('Process owner control is unavailable')
    own_descendants()
    stopping = False

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, request_stop)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    # close_fds prevents the command and its descendants retaining the owner's
    # separate control pipe. Ordinary stdin EOF is still passed to the command.
    if stopping or select.select([3], [], [], 0)[0]:
        if not stopping:
            os.read(3, 1)
        prove_closed(spec['nonce'])
        return -signal.SIGKILL
    child = subprocess.Popen([spec['command'], *spec['args']], close_fds=True)
    # Only the command owns stdin/stdout now. Keeping another stdout writer
    # here would hide command EOF from ACP while that command is still alive.
    for stream in (sys.stdin, sys.stdout):
        try:
            if stream is not None:
                stream.close()
        except (OSError, ValueError):
            pass
    for fd in (0, 1):
        try:
            os.close(fd)
        except OSError:
            pass
    root_pid = child.pid
    root_code = None
    failed = False
    notified = False
    while True:
        try:
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    if root_code is None:
                        failed = True
                    child.returncode = root_code if root_code is not None else 78
                    prove_closed(spec['nonce'])
                    return 78 if failed else root_code
                if pid == 0:
                    break
                if pid == root_pid:
                    root_code = os.waitstatus_to_exitcode(status)
                    child.returncode = root_code
            if root_code is not None or stopping or failed:
                stop_adopted_children()
            if not stopping and not failed:
                readable, _, _ = select.select([3], [], [], 0.02)
                if readable:
                    # EOF identifies parent loss; unexpected control data
                    # is also a request to stop this owned command tree.
                    os.read(3, 1)
                    stopping = True
            else:
                time.sleep(0.02)
        except Exception:
            failed = True
            if not notified:
                try:
                    sys.stderr.write('PAC Linux child cleanup is unconfirmed; ownership retained.\n')
                    sys.stderr.flush()
                except OSError:
                    pass
                notified = True
            # Preserve the owner and retry. Never report successful exit
            # while kernel child ownership has not drained.
            time.sleep(0.05)


if __name__ == '__main__':
    try:
        code = main()
    except Exception:
        sys.stderr.write('PAC Linux process host could not establish ownership.\n')
        code = 78
    if code is not None and code < 0:
        # Signal only this still-executing owner after all children are reaped.
        signum = -code
        signal.signal(signum, signal.SIG_DFL) if signum not in (signal.SIGKILL, signal.SIGSTOP) else None
        os.kill(os.getpid(), signum)
    raise SystemExit(code)
