#!/usr/bin/env python3
import errno
import ctypes
import fcntl
import hashlib
import os
import re
import stat
import sys


def require_platform():
    if sys.platform != 'linux' or not all(hasattr(os, flag) for flag in ('O_TMPFILE', 'O_DIRECTORY', 'O_NOFOLLOW')):
        fail('This installer candidate requires verified Linux anonymous temporary files.')


def link_anonymous(fd, directory, name):
    libc = ctypes.CDLL(None, use_errno=True)
    linkat = libc.linkat
    linkat.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
    linkat.restype = ctypes.c_int
    if linkat(fd, b'', directory, os.fsencode(name), 0x1000) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def open_directory(path):
    if not os.path.isabs(path):
        fail('Installation directory must be absolute.')
    components = path.split('/')
    if any(part in ('.', '..') for part in components):
        fail('Installation directory contains unsafe components.')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in filter(None, components):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_directory_identity(path, descriptor):
    current = open_directory(path)
    try:
        first = os.fstat(descriptor)
        second = os.fstat(current)
        if (first.st_dev, first.st_ino) != (second.st_dev, second.st_ino):
            fail('Installation directory changed; preserve all objects for review.')
    finally:
        os.close(current)


def lock(base, script, args):
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        fail('Required safe filesystem flags are unavailable.')
    directory = open_directory(base)
    info = os.fstat(directory)
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        fail('Installation directory ownership or permissions require review.')
    try:
        fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail('Another installation is in progress.')
    try:
        os.stat('.install-lock', dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        fail('A legacy installation lock exists; preserve it and review before retrying.')
    try:
        handle = os.open('.install-flock', os.O_RDONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    except FileExistsError:
        handle = os.open('.install-flock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    info = os.fstat(handle)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        fail('Installation lock is not a private regular file; preserve it for review.')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail('Another installation is in progress.')
    current = os.stat('.install-flock', dir_fd=directory, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
        fail('Installation lock identity changed; preserve it for review.')
    try:
        os.stat('.install-lock', dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        fail('A legacy installation lock exists; preserve it and review before retrying.')
    os.set_inheritable(handle, True)
    os.set_inheritable(directory, True)
    os.execv('/bin/sh', ['sh', script, *args])


def existing_matches_at(directory, name, data, executable):
    try:
        existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return False
    except OSError:
        fail('Existing installation file is unsafe; preserve it for review.')
    with os.fdopen(existing, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or
                info.st_mode & 0o077 or (executable and not info.st_mode & 0o100) or stream.read() != data):
            fail('Existing installation file differs; preserve it for review.')
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            fail('Existing installation file changed; preserve it for review.')
    return True


def existing_matches(destination, data, executable):
    parent = os.path.dirname(destination)
    directory = open_directory(parent)
    try:
        result = existing_matches_at(directory, os.path.basename(destination), data, executable)
        require_directory_identity(parent, directory)
        return result
    finally:
        os.close(directory)


def publish_data(destination, data, executable=False):
    require_platform()
    parent = os.path.dirname(destination)
    directory = open_directory(parent)
    name = os.path.basename(destination)
    try:
        if existing_matches_at(directory, name, data, executable):
            require_directory_identity(parent, directory)
            os.fsync(directory)
            return
        fd = os.open('.', os.O_TMPFILE | os.O_WRONLY, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o700 if executable else 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            created = os.fstat(stream.fileno())
            try:
                require_directory_identity(parent, directory)
                link_anonymous(stream.fileno(), directory, os.path.basename(destination))
            except FileExistsError:
                if not existing_matches_at(directory, name, data, executable):
                    fail('Existing installation file changed; preserve it for review.')
                os.fsync(directory)
                return
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != (created.st_dev, created.st_ino) or info.st_nlink != 1:
            fail('Published file identity changed; preserve it for review.')
        require_directory_identity(parent, directory)
        os.fsync(directory)
    finally:
        os.close(directory)


def sync_directory(path):
    descriptor = open_directory(path)
    try:
        require_directory_identity(path, descriptor)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_record(path, generation=False):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        fail('Installation generation is unsafe; preserve it for review.')
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            fail('Installation generation is unsafe; preserve it for review.')
        data = stream.read(256)
    pattern = b'[0-9a-f]{40} [0-9a-f]{64}\n' if generation else b'[0-9a-f]{40}\n'
    if not re.fullmatch(pattern, data):
        fail('Installation generation is invalid; preserve it for review.')
    return data


def generations(base, revision, digest=None, write=False):
    if not re.fullmatch('[0-9a-f]{40}', revision):
        fail('Installation revision is invalid.')
    folder = os.path.join(base, 'generations')
    try:
        info = os.stat(folder, follow_symlinks=False)
    except FileNotFoundError:
        records = []
    else:
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            fail('Installation generation directory is unsafe; preserve it for review.')
        names = sorted(os.listdir(folder))
        if any(not re.fullmatch('[0-9]{16}', name) for name in names):
            fail('Installation generation directory is invalid; preserve it for review.')
        if names != [str(index).zfill(16) for index in range(1, len(names) + 1)]:
            fail('Installation generation sequence is incomplete; preserve it for review.')
        records = [read_record(os.path.join(folder, name), True) for name in names]
    current = os.path.join(base, 'current')
    old = read_record(current) if os.path.lexists(current) else None
    desired = (revision + '\n').encode('ascii')
    if records and (old is None or old.strip() != records[0].split(b' ')[0]):
        fail('Legacy revision marker differs; preserve it for review.')
    if not records and old is not None and old != desired:
        fail('Existing revision needs reviewed migration.')
    if not write:
        return
    if old is None:
        publish_data(current, desired)
    else:
        publish_data(current, old)
    if not os.path.exists(folder):
        try:
            os.mkdir(folder, 0o700)
        except FileExistsError:
            fail('Installation generation directory appeared concurrently.')
    sync_directory(base)
    sync_directory(folder)
    if not re.fullmatch('[0-9a-f]{64}', digest or ''):
        fail('Installation stage digest is invalid.')
    for record in records:
        recorded_revision, recorded_digest = record.strip().split(b' ')
        if recorded_revision == revision.encode('ascii') and recorded_digest != digest.encode('ascii'):
            fail('Installed version changed; preserve it for review.')
    if records and records[-1].split(b' ')[0] == revision.encode('ascii'):
        return
    if len(records) >= 9999999999999999:
        fail('Installation generation limit reached.')
    name = str(len(records) + 1).zfill(16)
    publish_data(os.path.join(folder, name), (revision + ' ' + digest + '\n').encode('ascii'))


def stage_digest(stage):
    entries = {}

    def read_file(directory, name, relative):
        if not re.fullmatch('[A-Za-z0-9._/@+-]+', relative):
            fail('Installed version contains an unsupported path.')
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                fail('Installed version file is unsafe; preserve it for review.')
            content = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                content.update(chunk)
            after = os.fstat(stream.fileno())
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if ((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) !=
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or
                    (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
                fail('Installed version changed during inspection.')
        entries[relative] = content.hexdigest()

    def walk(directory, relative):
        info = os.fstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            fail('Installed version directory is unsafe; preserve it for review.')
        for name in sorted(os.listdir(directory)):
            child = relative + '/' + name
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                handle = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    walk(handle, child)
                    current = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    held = os.fstat(handle)
                    if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
                        fail('Installed version directory changed during inspection.')
                finally:
                    os.close(handle)
            else:
                read_file(directory, name, child)

    root = open_directory(stage)
    try:
        for name in ('adapters', 'src', 'scripts', 'node_modules'):
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            try:
                walk(descriptor, name)
                current = os.stat(name, dir_fd=root, follow_symlinks=False)
                held = os.fstat(descriptor)
                if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
                    fail('Installed version directory changed during inspection.')
            finally:
                os.close(descriptor)
        for name in ('package.json', 'package-lock.json'):
            read_file(root, name, name)
        require_directory_identity(stage, root)
    finally:
        os.close(root)
    digest = hashlib.sha256()
    for name in sorted(entries):
        digest.update(name.encode('ascii') + b'\0' + entries[name].encode('ascii') + b'\n')
    return digest.hexdigest()


def stage_seal(stage, create):
    digest = stage_digest(stage)
    marker = os.path.join(stage, '.complete')
    data = (digest + '\n').encode('ascii')
    if create:
        publish_data(marker, data)
    elif not existing_matches(marker, data, False):
        fail('Installed version marker is missing.')
    return digest


def version(stage, destination):
    parent = os.path.dirname(destination)
    if os.path.dirname(stage) != parent:
        fail('Provider stage and version have different parents.')
    directory = open_directory(parent)
    try:
        stage_fd = os.open(os.path.basename(stage), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            require_directory_identity(parent, directory)
            try:
                os.symlink(os.path.basename(stage), os.path.basename(destination), dir_fd=directory)
            except FileExistsError:
                fail('Provider revision appeared concurrently; preserve it for review.')
            selected = os.stat(os.path.basename(stage), dir_fd=directory, follow_symlinks=False)
            held = os.fstat(stage_fd)
            if (selected.st_dev, selected.st_ino) != (held.st_dev, held.st_ino):
                fail('Provider stage changed; preserve all objects for review.')
            require_directory_identity(parent, directory)
            os.fsync(directory)
        finally:
            os.close(stage_fd)
    finally:
        os.close(directory)


try:
    if len(sys.argv) == 2 and sys.argv[1] == 'check':
        require_platform()
    elif len(sys.argv) >= 4 and sys.argv[1] == 'lock':
        lock(sys.argv[2], sys.argv[3], sys.argv[4:])
    elif len(sys.argv) in (3, 4) and sys.argv[1] == 'publish' and (len(sys.argv) == 3 or sys.argv[3] == '--executable'):
        publish_data(sys.argv[2], sys.stdin.buffer.read(), len(sys.argv) == 4)
    elif len(sys.argv) == 3 and sys.argv[1] == 'compare-if-exists':
        existing_matches(sys.argv[2], sys.stdin.buffer.read(), False)
    elif len(sys.argv) == 3 and sys.argv[1] == 'sync-dir':
        sync_directory(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == 'check-generation':
        generations(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 5 and sys.argv[1] == 'generation':
        generations(sys.argv[2], sys.argv[3], sys.argv[4], True)
    elif len(sys.argv) == 3 and sys.argv[1] in ('seal-stage', 'verify-stage'):
        print(stage_seal(sys.argv[2], sys.argv[1] == 'seal-stage'))
    elif len(sys.argv) == 4 and sys.argv[1] == 'version':
        version(sys.argv[2], sys.argv[3])
    else:
        fail('Invalid installer safety operation.')
except OSError as error:
    if error.errno in (errno.ELOOP, errno.ENOTDIR):
        fail('Installation path is unsafe; preserve it for review.')
    fail('Installation filesystem operation failed; preserve existing objects for review.')
