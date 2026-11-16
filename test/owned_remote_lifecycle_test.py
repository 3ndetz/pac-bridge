import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('lifecycle', Path(__file__).parent / 'fixtures' / 'owned_remote_lifecycle.py')
import sys
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class LifecycleTests(unittest.TestCase):
    def owner(self, events, result='OWNED_CLOSED token', status=0, error=None):
        def signal():
            events.append('signal')
            if error:
                raise error
        def read():
            events.append('read')
            return result
        def exit_status():
            events.append('wait')
            return status
        return module.OwnedRemote(signal, read, exit_status, lambda: events.append('close'), 'OWNED_CLOSED token')

    def test_success_and_repeat(self):
        events = []
        owner = self.owner(events)
        self.assertTrue(module.close_owned([owner], lambda: events.append('cleanup')))
        self.assertEqual(events, ['signal', 'read', 'wait', 'cleanup'])
        self.assertTrue(owner.stop())
        self.assertEqual(events, ['signal', 'read', 'wait', 'cleanup'])

    def test_disconnect_and_unknown_keep_staging(self):
        for result, status, error in [('', 0, None), ('OWNED_CLOSED token', 1, None), ('', 0, TimeoutError())]:
            events = []
            owner = self.owner(events, result, status, error)
            self.assertFalse(module.close_owned([owner], lambda: events.append('cleanup')))
            self.assertNotIn('cleanup', events)
            self.assertFalse(owner.confirmed)

    def test_empty_owner_set_cannot_authorize_cleanup(self):
        events = []
        self.assertFalse(module.close_owned([], lambda: events.append('cleanup')))
        self.assertEqual(events, [])

    def test_all_owners_are_stopped_even_when_one_is_unknown(self):
        events = []
        first = self.owner(events, error=EOFError())
        second = self.owner(events)
        self.assertFalse(module.close_owned([first, second], lambda: events.append('cleanup')))
        self.assertTrue(second.confirmed)
        self.assertNotIn('cleanup', events)


if __name__ == '__main__':
    unittest.main()
