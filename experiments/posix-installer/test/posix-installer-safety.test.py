import fcntl
import hashlib
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
REVISION = 'a' * 40


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix='pac-posix-fixture-'))
        self.repo = self.work / 'repo'
        self.home = self.work / 'home'
        self.keys = self.work / 'keys'
        self.bin = self.work / 'fake-bin'
        for directory in (self.repo / 'scripts', self.repo / 'adapters', self.repo / 'src',
                          self.repo / 'source-package', self.home, self.keys, self.bin):
            directory.mkdir(parents=True)
        for name in ('install-posix.sh', 'install-posix-locked.sh', 'posix-install-safety.py'):
            (self.repo / 'scripts' / name).write_text((ROOT / 'scripts' / name).read_text())
        helper = self.repo / 'scripts' / 'posix-install-safety.py'
        source = helper.read_text()
        marker = '                link_anonymous(stream.fileno(), directory, os.path.basename(destination))'
        pause = "                if os.environ.get('PAC_TEST_WAIT_NAME') == os.path.basename(destination):\n                    import time\n                    print('READY', file=sys.stderr, flush=True)\n                    gate = os.environ.get('PAC_TEST_GATE')\n                    if gate:\n                        while os.path.exists(gate): time.sleep(0.02)\n                    else:\n                        time.sleep(300)\n"
        if marker not in source:
            raise AssertionError('Missing publication boundary')
        source = source.replace(marker, pause + marker)
        stage_marker = "        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)"
        stage_pause = "        if os.environ.get('PAC_TEST_STAGE_GATE'):\n            import time\n            print('READY', file=sys.stderr, flush=True)\n            while os.path.exists(os.environ['PAC_TEST_STAGE_GATE']): time.sleep(0.02)\n"
        if stage_marker not in source:
            raise AssertionError('Missing stage boundary')
        helper.write_text(source.replace(stage_marker, stage_pause + stage_marker))
        for name in ('connection.json', 'pac-source-token.txt', 'pac-relay-ca.pem'):
            (self.keys / name).write_text('synthetic')
        (self.repo / 'adapters' / 'pac-hapi-opencode.mjs').write_text('synthetic')
        (self.repo / 'src' / 'fixture.mjs').write_text('synthetic')
        (self.repo / 'source-package' / 'package.json').write_text('{}')
        (self.repo / 'source-package' / 'package-lock.json').write_text('{}')
        (self.repo / 'scripts' / 'pac-posix-launcher.mjs').write_text('synthetic launcher')
        (self.repo / 'scripts' / 'pac-posix-bootstrap.mjs').write_text('synthetic bootstrap')
        self.write_exec('node', '#!/bin/sh\nprintf "24\\n"\n')
        self.write_exec('npm', '#!/bin/sh\nif [ "${PAC_TEST_WAIT_NPM:-}" = 1 ]; then printf "READY\\n"; sleep 300; fi\nmkdir -p node_modules/synthetic\nprintf synthetic > node_modules/synthetic/index.js\n')
        self.write_exec('git', '#!/bin/sh\ncase "$1" in rev-parse) printf "%s\\n" "${PAC_TEST_REVISION:-' + REVISION + '}";; archive) tar -cf - adapters src source-package scripts/pac-posix-launcher.mjs scripts/pac-posix-bootstrap.mjs;; *) exit 1;; esac\n')
        python = "#!/bin/sh\nexec '" + sys.executable + "' \"$@\"\n"
        self.write_exec('python3', python)
        self.open_code = self.bin / 'opencode'
        self.write_exec('opencode', '#!/bin/sh\nexit 0\n')
        self.base = self.home / '.local' / 'share' / 'pac-bridge-v2'
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(self.bin) + os.pathsep + os.environ['PATH'])

    def write_exec(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    def existing_base(self):
        self.base.mkdir(parents=True)
        (self.base / '.pac-bridge-install').write_text('existing')

    def run_installer(self, env=None):
        return subprocess.run(['sh', str(self.repo / 'scripts' / 'install-posix.sh'), str(self.keys), str(self.open_code)],
                              cwd=self.repo, env=env or self.env, capture_output=True, text=True, timeout=30)

    def paused_installer(self, name, value='1', extra=None):
        env = dict(self.env, **{name: value})
        env.update(extra or {})
        proc = subprocess.Popen(['sh', str(self.repo / 'scripts' / 'install-posix.sh'), str(self.keys), str(self.open_code)],
                                cwd=self.repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
        ready = select.select([proc.stdout, proc.stderr], [], [], 15)[0]
        if not ready:
            self.stop(proc)
            self.fail('Timed out waiting for synthetic boundary ' + value)
        self.assertEqual(ready[0].readline().strip(), 'READY')
        return proc

    def stop(self, proc):
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate(timeout=10)

    def test_fixed_temporary_hardlinks_are_never_written(self):
        self.existing_base()
        (self.base / 'bin').mkdir()
        for index, name in enumerate(('current.tmp', 'connection-directory.tmp', 'opencode-path.tmp',
                                      'bin/opencode.tmp', 'bin/pac-posix-launcher.mjs.tmp')):
            sentinel = self.work / ('sentinel-' + str(index))
            sentinel.write_text('preserve')
            os.link(sentinel, self.base / name)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        for sentinel in self.work.glob('sentinel-*'):
            self.assertEqual(sentinel.read_text(), 'preserve')
        before = sorted(str(path) for path in self.base.rglob('.pac-publish-*'))
        self.assertEqual(before, [])
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertEqual(before, sorted(str(path) for path in self.base.rglob('.pac-publish-*')))

    def test_crash_during_staging_releases_lock_and_retry_succeeds(self):
        proc = self.paused_installer('PAC_TEST_WAIT_NPM')
        self.stop(proc)
        self.assertTrue((self.base / '.install-flock').is_file())
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / 'current').read_text().strip(), REVISION)

    def test_crash_during_publication_retries_without_clobbering(self):
        proc = self.paused_installer('PAC_TEST_WAIT_NAME', 'current')
        self.stop(proc)
        original = (self.base / 'bin' / 'opencode').read_bytes()
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / 'bin' / 'opencode').read_bytes(), original)

    def test_concurrent_installer_fails_without_removing_lock(self):
        proc = self.paused_installer('PAC_TEST_WAIT_NPM')
        try:
            lock = self.base / '.install-flock'
            before = lock.stat()
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Another installation is in progress', result.stderr)
            self.assertEqual((before.st_dev, before.st_ino), (lock.stat().st_dev, lock.stat().st_ino))
        finally:
            self.stop(proc)
        self.assertEqual(self.run_installer().returncode, 0)

    def test_replacing_lock_file_does_not_allow_another_installer(self):
        proc = self.paused_installer('PAC_TEST_WAIT_NPM')
        try:
            lock = self.base / '.install-flock'
            lock.rename(self.base / 'foreign-saved-lock')
            lock.write_text('independent replacement')
            lock.chmod(0o600)
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Another installation is in progress', result.stderr)
            self.assertEqual(lock.read_text(), 'independent replacement')
        finally:
            self.stop(proc)

    def test_child_holds_lock_if_parent_is_killed(self):
        proc = self.paused_installer('PAC_TEST_WAIT_NPM')
        try:
            os.kill(proc.pid, signal.SIGKILL)
            proc.wait(timeout=10)
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Another installation is in progress', result.stderr)
        finally:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate(timeout=10)
        self.assertEqual(self.run_installer().returncode, 0)

    def test_foreign_legacy_lock_is_preserved(self):
        self.existing_base()
        lock = self.base / '.install-lock'
        lock.mkdir()
        (lock / 'foreign').write_text('preserve')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('legacy installation lock', result.stderr)
        self.assertEqual((lock / 'foreign').read_text(), 'preserve')
        self.assertFalse((self.base / '.install-flock').exists())

    def test_existing_flock_is_never_removed_or_modified(self):
        self.existing_base()
        path = self.base / '.install-flock'
        path.write_text('foreign data')
        path.chmod(0o600)
        with path.open('r') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Another installation is in progress', result.stderr)
        self.assertEqual(path.read_text(), 'foreign data')

    def test_hardlinked_or_symlinked_flock_is_refused(self):
        self.existing_base()
        sentinel = self.work / 'foreign-lock'
        sentinel.write_text('preserve')
        sentinel.chmod(0o600)
        os.link(sentinel, self.base / '.install-flock')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_symlinked_flock_is_refused(self):
        self.existing_base()
        sentinel = self.work / 'foreign-lock'
        sentinel.write_text('preserve')
        (self.base / '.install-flock').symlink_to(sentinel)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_crash_before_each_publish_can_be_retried(self):
        for name in ('.complete', 'pac-posix-launcher.mjs', 'opencode', 'connection-directory', 'opencode-path', 'current', '0000000000000001'):
            with self.subTest(name=name):
                fixture = InstallerTests('runTest')
                fixture.setUp()
                proc = fixture.paused_installer('PAC_TEST_WAIT_NAME', name)
                fixture.stop(proc)
                result = fixture.run_installer()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((fixture.base / 'current').read_text().strip(), REVISION)

    def test_crash_before_initial_marker_fails_closed(self):
        proc = self.paused_installer('PAC_TEST_WAIT_NAME', '.pac-bridge-install')
        self.stop(proc)
        sentinel = self.base / 'independent'
        sentinel.write_text('preserve')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires review', result.stderr)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_missing_tmpfile_capability_fails_before_profile_changes(self):
        self.existing_base()
        sentinel = self.base / 'independent'
        sentinel.write_text('preserve')
        helper = self.repo / 'scripts' / 'posix-install-safety.py'
        source = helper.read_text()
        marker = "if sys.platform != 'linux' or not all("
        self.assertIn(marker, source)
        helper.write_text(source.replace(marker, "if os.environ.get('PAC_TEST_UNSUPPORTED') == '1' or sys.platform != 'linux' or not all("))
        result = self.run_installer(dict(self.env, PAC_TEST_UNSUPPORTED='1'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')
        self.assertFalse((self.base / '.install-flock').exists())

    def test_filesystem_without_tmpfile_fails_closed(self):
        self.existing_base()
        sentinel = self.base / 'independent'
        sentinel.write_text('preserve')
        helper = self.repo / 'scripts' / 'posix-install-safety.py'
        source = helper.read_text()
        marker = "        fd = os.open('.', os.O_TMPFILE | os.O_WRONLY, 0o600, dir_fd=directory)"
        self.assertIn(marker, source)
        injection = "        if os.environ.get('PAC_TEST_TMPFILE_FAILURE') == '1': raise OSError(errno.EOPNOTSUPP, 'synthetic')\n"
        helper.write_text(source.replace(marker, injection + marker))
        result = self.run_installer(dict(self.env, PAC_TEST_TMPFILE_FAILURE='1'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')
        self.assertFalse((self.base / 'current').exists())

    def test_directory_fsync_failure_preserves_state_and_retry_succeeds(self):
        helper = self.repo / 'scripts' / 'posix-install-safety.py'
        source = helper.read_text()
        marker = '        os.fsync(directory)\n    finally:\n        os.close(directory)'
        self.assertIn(marker, source)
        injection = "        if os.environ.get('PAC_TEST_FSYNC_FAILURE') == '1' and destination.endswith('/current'): raise OSError(errno.EIO, 'synthetic')\n"
        helper.write_text(source.replace(marker, injection + marker, 1))
        result = self.run_installer(dict(self.env, PAC_TEST_FSYNC_FAILURE='1'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / 'current').read_text().strip(), REVISION)
        self.assertFalse((self.base / 'generations' / '0000000000000001').exists())
        retry = self.run_installer()
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertTrue((self.base / 'generations' / '0000000000000001').exists())

    def test_competing_creation_at_publish_does_not_clobber(self):
        helper = self.repo / 'scripts' / 'posix-install-safety.py'
        source = helper.read_text()
        marker = '                link_anonymous(stream.fileno(), directory, os.path.basename(destination))'
        self.assertIn(marker, source)
        pause = "                if destination.endswith('/current'):\n                    import time\n                    print('READY', flush=True)\n                    while not os.path.exists(os.environ['PAC_TEST_RESUME']): time.sleep(0.01)\n"
        helper.write_text(source.replace(marker, pause + marker))
        resume = self.work / 'resume'
        env = dict(self.env, PAC_TEST_RESUME=str(resume))
        proc = subprocess.Popen(['sh', str(self.repo / 'scripts' / 'install-posix.sh'), str(self.keys), str(self.open_code)],
                                cwd=self.repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertEqual(proc.stdout.readline().strip(), 'READY')
            (self.base / 'current').write_text('independent change')
            resume.write_text('go')
            _, error = proc.communicate(timeout=15)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn('differs', error)
            self.assertEqual((self.base / 'current').read_text(), 'independent change')
        finally:
            if proc.poll() is None:
                self.stop(proc)

    def test_symlinked_version_is_not_followed(self):
        self.existing_base()
        versions = self.base / 'versions'
        versions.mkdir()
        outside = self.work / 'outside'
        outside.mkdir()
        (outside / 'sentinel').write_text('preserve')
        (versions / REVISION).symlink_to(outside, target_is_directory=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((outside / 'sentinel').read_text(), 'preserve')

    def test_shell_entrypoints_are_lf_only(self):
        for name in ('install-posix.sh', 'install-posix-locked.sh'):
            self.assertNotIn(b'\r\n', (ROOT / 'scripts' / name).read_bytes())

    def test_conflicting_current_is_preserved(self):
        self.existing_base()
        current = self.base / 'current'
        current.write_text('independent change')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(current.read_text(), 'independent change')

    def test_symlinked_current_is_preserved(self):
        self.existing_base()
        sentinel = self.work / 'independent'
        sentinel.write_text('preserve')
        (self.base / 'current').symlink_to(sentinel)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_hardlinked_current_is_preserved(self):
        self.existing_base()
        sentinel = self.work / 'independent'
        sentinel.write_text('preserve')
        os.link(sentinel, self.base / 'current')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_upgrade_appends_generation_without_overwriting_prior_files(self):
        self.assertEqual(self.run_installer().returncode, 0)
        current = self.base / 'current'
        wrapper = self.base / 'bin' / 'opencode'
        bootstrap = self.base / 'bin' / 'pac-posix-launcher.mjs'
        previous = (current.read_bytes(), wrapper.read_bytes(), bootstrap.read_bytes())
        next_revision = 'b' * 40
        (self.repo / 'scripts' / 'pac-posix-launcher.mjs').write_text('updated synthetic launcher')
        result = self.run_installer(dict(self.env, PAC_TEST_REVISION=next_revision))
        self.assertEqual(result.returncode, 0, result.stderr)
        generations = self.base / 'generations'
        self.assertEqual((generations / '0000000000000001').read_text().split()[0], REVISION)
        self.assertEqual((generations / '0000000000000002').read_text().split()[0], next_revision)
        self.assertEqual((current.read_bytes(), wrapper.read_bytes(), bootstrap.read_bytes()), previous)
        self.assertEqual((self.base / 'versions' / next_revision / 'scripts' / 'pac-posix-launcher.mjs').read_text(), 'updated synthetic launcher')
        self.assertEqual(self.run_installer(dict(self.env, PAC_TEST_REVISION=next_revision)).returncode, 0)
        self.assertEqual(len(list(generations.iterdir())), 2)

    def test_interrupted_upgrade_keeps_old_generation_and_can_retry(self):
        self.assertEqual(self.run_installer().returncode, 0)
        next_revision = 'b' * 40
        proc = self.paused_installer('PAC_TEST_WAIT_NAME', '0000000000000002', {'PAC_TEST_REVISION': next_revision})
        self.stop(proc)
        generations = self.base / 'generations'
        self.assertEqual([path.name for path in generations.iterdir()], ['0000000000000001'])
        self.assertEqual((generations / '0000000000000001').read_text().split()[0], REVISION)
        result = self.run_installer(dict(self.env, PAC_TEST_REVISION=next_revision))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((generations / '0000000000000002').read_text().split()[0], next_revision)

    def test_changed_ready_adapter_is_refused_and_preserved(self):
        self.assertEqual(self.run_installer().returncode, 0)
        stage = (self.base / 'versions' / REVISION).resolve()
        adapter = stage / 'adapters' / 'pac-hapi-opencode.mjs'
        adapter.write_text('independent change')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(adapter.read_text(), 'independent change')

    def test_changed_adapter_and_rewritten_marker_conflict_with_generation(self):
        self.assertEqual(self.run_installer().returncode, 0)
        stage = (self.base / 'versions' / REVISION).resolve()
        adapter = stage / 'adapters' / 'pac-hapi-opencode.mjs'
        adapter.write_text('independent change')
        files = []
        for root in ('adapters', 'src', 'scripts', 'node_modules'):
            files.extend(path.relative_to(stage).as_posix() for path in (stage / root).rglob('*') if path.is_file())
        files.extend(('package.json', 'package-lock.json'))
        digest = hashlib.sha256()
        for name in sorted(files):
            content = hashlib.sha256((stage / name).read_bytes()).hexdigest()
            digest.update(name.encode('ascii') + b'\0' + content.encode('ascii') + b'\n')
        (stage / '.complete').write_text(digest.hexdigest() + '\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(adapter.read_text(), 'independent change')

    def test_unknown_bootstrap_is_preserved_and_upgrade_refused(self):
        self.assertEqual(self.run_installer().returncode, 0)
        bootstrap = self.base / 'bin' / 'pac-posix-launcher.mjs'
        bootstrap.write_text('independent change')
        result = self.run_installer(dict(self.env, PAC_TEST_REVISION='b' * 40))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(bootstrap.read_text(), 'independent change')
        self.assertFalse((self.base / 'generations' / '0000000000000002').exists())

    @unittest.skipUnless(os.environ.get('PAC_BASELINE_GIT'), 'baseline Git objects were not supplied')
    def test_legacy_baseline_refuses_without_second_profile_or_session_changes(self):
        baseline = '1977ab8f48a555c40bea27817130cccd64645b8e'
        def show(path):
            result = subprocess.run(['git', '--git-dir', os.environ['PAC_BASELINE_GIT'], 'show', baseline + ':' + path],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, 'Could not read the synthetic baseline fixture')
            return result.stdout
        installer = self.repo / 'scripts' / 'install-posix.sh'
        launcher = self.repo / 'scripts' / 'pac-posix-launcher.mjs'
        candidate_installer, candidate_launcher = installer.read_text(), launcher.read_text()
        installer.write_text(show('scripts/install-posix.sh'))
        launcher.write_text(show('scripts/pac-posix-launcher.mjs'))
        self.assertEqual(self.run_installer().returncode, 0)
        installer.write_text(candidate_installer)
        launcher.write_text(candidate_launcher)
        legacy = self.home / '.local' / 'share' / 'pac-bridge'
        session = self.home / '.hapi-servermall' / 'sessions' / 'fixture.json'
        session.parent.mkdir(parents=True)
        session.write_text('synthetic existing conversation')
        bindings = legacy / 'bindings' / 'synthetic-session.json'
        bindings.parent.mkdir(parents=True, exist_ok=True)
        bindings.write_text('synthetic binding')
        baseline_paths = [legacy / 'current', legacy / 'bin' / 'opencode',
                          legacy / 'bin' / 'pac-posix-launcher.mjs',
                          legacy / 'versions' / REVISION / 'adapters' / 'pac-hapi-opencode.mjs', session, bindings]
        before = [path.read_bytes() for path in baseline_paths]
        old_path = str(legacy / 'bin') + os.pathsep + self.env['PATH']
        self.assertEqual(shutil.which('opencode', path=old_path), str(legacy / 'bin' / 'opencode'))
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'], start_new_session=True)
        try:
            result = self.run_installer(dict(self.env, PAC_TEST_REVISION='b' * 40))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual([path.read_bytes() for path in baseline_paths], before)
            self.assertIsNone(process.poll())
            self.assertFalse(self.base.exists())
            self.assertEqual(shutil.which('opencode', path=old_path), str(legacy / 'bin' / 'opencode'))
            for selected_path in (old_path,):
                selected = subprocess.run(['sh', '-c', 'opencode --version'], env=dict(self.env, PATH=selected_path),
                                          capture_output=True, text=True, timeout=10)
                self.assertEqual(selected.returncode, 0)
                self.assertEqual(selected.stdout.strip(), '24')
        finally:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)

    def test_legacy_symlink_fails_without_creating_profile(self):
        legacy = self.home / '.local' / 'share' / 'pac-bridge'
        legacy.parent.mkdir(parents=True)
        legacy.symlink_to(self.work / 'missing')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(legacy.is_symlink())
        self.assertFalse(self.base.exists())

    def test_changed_runtime_dependency_is_refused_and_preserved(self):
        self.assertEqual(self.run_installer().returncode, 0)
        dependency = (self.base / 'versions' / REVISION).resolve() / 'node_modules' / 'synthetic' / 'index.js'
        dependency.write_text('independent dependency change')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(dependency.read_text(), 'independent dependency change')

    def test_publish_rejects_symlink_ancestor(self):
        victim = self.work / 'victim'
        victim.mkdir()
        (victim / 'sentinel').write_text('preserve')
        alias = self.work / 'alias'
        alias.symlink_to(victim, target_is_directory=True)
        result = subprocess.run([sys.executable, str(self.repo / 'scripts' / 'posix-install-safety.py'),
                                 'publish', str(alias / 'new')], input='data', capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((victim / 'sentinel').read_text(), 'preserve')
        self.assertFalse((victim / 'new').exists())

    def test_publish_parent_rename_and_symlink_never_redirects_write(self):
        parent = self.work / 'parent'
        original = parent / 'destination'
        original.mkdir(parents=True)
        victim = self.work / 'victim'
        victim.mkdir()
        (victim / 'new').write_text('foreign data')
        gate = self.work / 'gate'
        gate.write_text('wait')
        source = self.work / 'input'
        source.write_text('candidate')
        env = dict(self.env, PAC_TEST_WAIT_NAME='new', PAC_TEST_GATE=str(gate))
        with source.open('rb') as stream:
            proc = subprocess.Popen([sys.executable, str(self.repo / 'scripts' / 'posix-install-safety.py'),
                                     'publish', str(original / 'new')], stdin=stream,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
            ready = select.select([proc.stderr], [], [], 15)[0]
            self.assertTrue(ready)
            self.assertEqual(proc.stderr.readline().strip(), 'READY')
            moved = self.work / 'moved'
            parent.rename(moved)
            parent.symlink_to(victim, target_is_directory=True)
            gate.unlink()
            _, error = proc.communicate(timeout=15)
        self.assertNotEqual(proc.returncode, 0, error)
        self.assertEqual((victim / 'new').read_text(), 'foreign data')
        self.assertEqual((moved / 'destination' / 'new').read_text(), 'candidate')

    def test_stage_inspection_rejects_renamed_root(self):
        self.assertEqual(self.run_installer().returncode, 0)
        stage = (self.base / 'versions' / REVISION).resolve()
        moved = stage.with_name(stage.name + '-moved')
        victim = self.work / 'victim-stage'
        victim.mkdir()
        (victim / 'sentinel').write_text('preserve')
        gate = self.work / 'stage-gate'
        gate.write_text('wait')
        proc = subprocess.Popen([sys.executable, str(self.repo / 'scripts' / 'posix-install-safety.py'),
                                 'verify-stage', str(stage)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(self.env, PAC_TEST_STAGE_GATE=str(gate)), text=True)
        ready = select.select([proc.stderr], [], [], 15)[0]
        self.assertTrue(ready)
        self.assertEqual(proc.stderr.readline().strip(), 'READY')
        stage.rename(moved)
        stage.symlink_to(victim, target_is_directory=True)
        gate.unlink()
        _, error = proc.communicate(timeout=15)
        self.assertNotEqual(proc.returncode, 0, error)
        self.assertEqual((victim / 'sentinel').read_text(), 'preserve')

    def test_existing_launcher_with_hardlink_is_refused_and_preserved(self):
        self.assertEqual(self.run_installer().returncode, 0)
        launcher = self.base / 'bin' / 'pac-posix-launcher.mjs'
        alias = self.work / 'independent-alias'
        os.link(launcher, alias)
        before = launcher.read_bytes()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(launcher.read_bytes(), before)
        self.assertEqual(alias.read_bytes(), before)

    def test_existing_launcher_with_public_mode_is_refused(self):
        self.assertEqual(self.run_installer().returncode, 0)
        launcher = self.base / 'bin' / 'pac-posix-launcher.mjs'
        before = launcher.read_bytes()
        launcher.chmod(0o644)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(launcher.read_bytes(), before)
        self.assertEqual(launcher.stat().st_mode & 0o777, 0o644)

    def test_modified_launcher_via_alias_is_not_overwritten(self):
        self.assertEqual(self.run_installer().returncode, 0)
        launcher = self.base / 'bin' / 'pac-posix-launcher.mjs'
        alias = self.work / 'independent-alias'
        os.link(launcher, alias)
        alias.write_text('independent change')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(launcher.read_text(), 'independent change')
        self.assertEqual(alias.read_text(), 'independent change')

    def test_foreign_temporary_name_is_preserved(self):
        self.existing_base()
        sentinel = self.work / 'independent'
        sentinel.write_text('preserve')
        foreign = self.base / '.pac-publish-foreign'
        os.link(sentinel, foreign)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(foreign.read_text(), 'preserve')
        self.assertEqual(sentinel.read_text(), 'preserve')

    @unittest.skipUnless(os.geteuid() == 0, 'requires a synthetic different owner')
    def test_existing_launcher_with_different_owner_is_refused(self):
        self.assertEqual(self.run_installer().returncode, 0)
        launcher = self.base / 'bin' / 'pac-posix-launcher.mjs'
        before = launcher.read_bytes()
        os.chown(launcher, 65534, 65534)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(launcher.read_bytes(), before)
        self.assertEqual(launcher.stat().st_uid, 65534)


if __name__ == '__main__':
    unittest.main()
