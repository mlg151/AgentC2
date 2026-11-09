"""Local worker dependencies; never launches a provider or contacts a service."""
import io
import os
import struct

from chat_protocol import CONTRACT


def capabilities(provider):
    return dict(provider=provider, version="worker-boundary-fixture", status="supported", reason=None,
                **{key: True for key in CONTRACT["capabilities"]})


class Adapter:
    def __init__(self, session, journal, state="idle", start_error=None, stop_error=None):
        self.session, self.journal = session, journal
        self.state, self.start_error, self.stop_error = state, start_error, stop_error
        self.calls = []

    def start(self):
        self.calls.append(("start",))
        if self.start_error is not None:
            raise self.start_error
        self.journal.append(self.session["id"], "session.updated", dict(state=self.state, detail="Local fixture ready"))
        return {}

    def stop(self):
        self.calls.append(("stop",))
        if self.stop_error is not None:
            raise self.stop_error
        return {}

    def set_model(self, model):
        self.calls.append(("model", model))
        return dict(model=model)

    def steer(self, text, turn):
        self.calls.append(("steer", text, turn))
        return dict(turnId=turn)


class TranscriptSocket:
    def __init__(self, incoming, uid=None, lost=False):
        self.incoming, self.uid, self.lost = io.BytesIO(incoming), os.getuid() if uid is None else uid, lost
        self.sent, self.timeouts, self.credentials = [], [], 0

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def getsockopt(self, level, option, size):
        self.credentials += 1
        return struct.pack("3i", os.getpid(), self.uid, os.getgid())

    def makefile(self, mode, size):
        return self.incoming

    def sendall(self, data):
        if self.lost:
            raise BrokenPipeError("Fixture client disconnected")
        self.sent.append(bytes(data))
