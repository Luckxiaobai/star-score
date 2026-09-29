"""Pure-stdlib checks for the in-process job manager."""

import sys
import tempfile
import time
from concurrent.futures import CancelledError
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from job_manager import JobManager  # noqa: E402


def wait_for(manager, job_id, statuses, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = manager.get(job_id)
        if job.status in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach {statuses}")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        manager = JobManager(Path(tmp))

        def succeed(job, cancel_event, progress):
            progress(0.5, "half")
            job.output_path.write_bytes(b"ok")
            return {"wav_size": 2}

        done = manager.submit("test-success", succeed, suffix=".wav")
        done = wait_for(manager, done.id, {"succeeded", "failed"})
        assert done.status == "succeeded", done.error
        assert done.progress == 1.0
        assert done.output_path.read_bytes() == b"ok"

        def cancellable(job, cancel_event, progress):
            for index in range(100):
                if cancel_event.is_set():
                    raise CancelledError()
                progress(index / 100, "running")
                time.sleep(0.01)
            return {"wav_size": 0}

        running = manager.submit("test-cancel", cancellable, suffix=".wav")
        manager.cancel(running.id)
        cancelled = wait_for(manager, running.id, {"cancelled", "failed"})
        assert cancelled.status == "cancelled", cancelled.error

    print("job manager checks passed")


if __name__ == "__main__":
    main()
