"""Small in-process job manager for long-running backend work.

The backend is single-user and local-first. This manager provides a stable
contract without adding Celery/Redis or another external service.
"""

from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import CancelledError
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

JobTarget = Callable[["JobRecord", threading.Event, Callable[[float, str], None]], dict]


@dataclass
class JobRecord:
    id: str
    kind: str
    status: str = "queued"
    progress: float = 0.0
    message: str = "等待执行"
    result: Optional[dict] = None
    error: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    output_path: Optional[Path] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(max(0.0, min(1.0, self.progress)), 4),
            "message": self.message,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class JobManager:
    def __init__(self, output_dir: Path, max_records: int = 80):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._max_records = max_records
        self._jobs: dict[str, JobRecord] = {}
        self._lock = threading.RLock()

    def submit(self, kind: str, target: JobTarget, *, suffix: str = ".bin") -> JobRecord:
        job = JobRecord(id=uuid.uuid4().hex, kind=kind)
        job.output_path = self.output_dir / f"{job.id}{suffix}"
        with self._lock:
            self._jobs[job.id] = job
            self._prune_locked()

        thread = threading.Thread(
            target=self._run,
            args=(job, target),
            name=f"job-{kind}-{job.id[:8]}",
            daemon=True,
        )
        thread.start()
        return self.get(job.id)

    def get(self, job_id: str) -> JobRecord:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return self._snapshot(job)

    def list(self) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda item: item.created_at, reverse=True)
            return [self._snapshot(job).to_dict() for job in jobs]

    def cancel(self, job_id: str) -> JobRecord:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.status in ("succeeded", "failed", "cancelled"):
                return self._snapshot(job)
            job.cancel_event.set()
            job.message = "已请求取消"
            return self._snapshot(job)

    def _run(self, job: JobRecord, target: JobTarget) -> None:
        with self._lock:
            if job.cancel_event.is_set():
                self._mark_cancelled_locked(job)
                return
            job.status = "running"
            job.started_at = time.time()
            job.message = "任务开始"

        def progress(value: float, message: str = "") -> None:
            with self._lock:
                if job.cancel_event.is_set():
                    raise CancelledError()
                job.progress = max(0.0, min(1.0, float(value)))
                if message:
                    job.message = message

        try:
            result = target(job, job.cancel_event, progress)
            if job.cancel_event.is_set():
                raise CancelledError()
            with self._lock:
                job.status = "succeeded"
                job.progress = 1.0
                job.message = "任务完成"
                job.result = result or {}
                job.finished_at = time.time()
        except CancelledError:
            with self._lock:
                self._mark_cancelled_locked(job)
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                job.status = "failed"
                job.message = "任务失败"
                job.error = f"{type(exc).__name__}: {exc}"
                job.finished_at = time.time()

    def _mark_cancelled_locked(self, job: JobRecord) -> None:
        job.status = "cancelled"
        job.message = "任务已取消"
        job.finished_at = time.time()
        if job.output_path and job.output_path.exists():
            try:
                job.output_path.unlink()
            except OSError:
                pass

    def _snapshot(self, job: JobRecord) -> JobRecord:
        return JobRecord(
            id=job.id,
            kind=job.kind,
            status=job.status,
            progress=job.progress,
            message=job.message,
            result=dict(job.result) if job.result else None,
            error=job.error,
            created_at=job.created_at,
            started_at=job.started_at,
            finished_at=job.finished_at,
            output_path=job.output_path,
            cancel_event=job.cancel_event,
        )

    def _prune_locked(self) -> None:
        if len(self._jobs) <= self._max_records:
            return
        finished = [
            job for job in self._jobs.values()
            if job.status in ("succeeded", "failed", "cancelled")
        ]
        finished.sort(key=lambda item: item.finished_at or item.created_at)
        for job in finished[: max(0, len(self._jobs) - self._max_records)]:
            self._jobs.pop(job.id, None)
            if job.output_path and job.output_path.exists():
                try:
                    job.output_path.unlink()
                except OSError:
                    pass
