# Synthetic coordinator only; OS process ownership requires separate proof.
﻿from dataclasses import dataclass


@dataclass
class OwnedRemote:
    signal: object
    read_line: object
    exit_status: object
    close_channel: object
    expected: str
    confirmed: bool = False

    def stop(self):
        if self.confirmed:
            return True
        try:
            self.signal()
            if self.read_line().strip() != self.expected:
                return False
            if self.exit_status() != 0:
                return False
            self.confirmed = True
            return True
        except (OSError, EOFError, TimeoutError):
            return False


def close_owned(owners, cleanup):
    owners = list(owners)
    if not owners:
        return False
    results = [owner.stop() for owner in owners]
    if all(results):
        cleanup()
        return True
    return False
