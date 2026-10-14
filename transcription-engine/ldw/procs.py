"""Bounded subprocesses: argument arrays only, timeouts, cancellation, priority, memory caps.

On Windows each child is placed in a Job Object with KILL_ON_JOB_CLOSE, so killing
the job (cancel, timeout, or this process dying) takes the whole tree down, and an
optional per-process memory limit is enforced by the OS.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Callable, List, Optional, Sequence

IS_WINDOWS = sys.platform == "win32"

PRIORITIES = ("normal", "below_normal", "idle")


class Cancelled(Exception):
    pass


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._procs: List["BoundedProcess"] = []
        self._lock = threading.Lock()

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            for proc in list(self._procs):
                proc.kill()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self._event.is_set():
            raise Cancelled("Job was cancelled")

    def _register(self, proc: "BoundedProcess") -> None:
        with self._lock:
            self._procs.append(proc)
        if self._event.is_set():
            proc.kill()

    def _unregister(self, proc: "BoundedProcess") -> None:
        with self._lock:
            if proc in self._procs:
                self._procs.remove(proc)


if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _BASIC_LIMIT(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _EXT_LIMIT(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BASIC_LIMIT),
            ("IoInfo", _IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    _JobObjectExtendedLimitInformation = 9
    _PROCESS_SET_QUOTA = 0x0100
    _PROCESS_TERMINATE = 0x0001

    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.OpenProcess.restype = wintypes.HANDLE

    def _create_job(memory_limit: Optional[int]) -> int:
        job = _k32.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        info = _EXT_LIMIT()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if memory_limit:
            info.BasicLimitInformation.LimitFlags |= _JOB_OBJECT_LIMIT_PROCESS_MEMORY
            info.ProcessMemoryLimit = int(memory_limit)
        if not _k32.SetInformationJobObject(
            wintypes.HANDLE(job), _JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return job

    def _assign(job: int, pid: int) -> None:
        handle = _k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not _k32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(handle)):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            _k32.CloseHandle(wintypes.HANDLE(handle))

    def _peak_memory(job: int) -> Optional[int]:
        info = _EXT_LIMIT()
        if _k32.QueryInformationJobObject(
            wintypes.HANDLE(job), _JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info), None,
        ):
            return int(info.PeakProcessMemoryUsed)
        return None

    class _BASIC_ACCOUNTING(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", ctypes.c_longlong), ("TotalKernelTime", ctypes.c_longlong),
            ("ThisPeriodTotalUserTime", ctypes.c_longlong), ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
            ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
            ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD),
        ]

    def _cpu_seconds(job: int) -> Optional[float]:
        info = _BASIC_ACCOUNTING()
        if _k32.QueryInformationJobObject(wintypes.HANDLE(job), 1, ctypes.byref(info), ctypes.sizeof(info), None):
            return (info.TotalUserTime + info.TotalKernelTime) / 1e7  # 100 ns units
        return None

    def _terminate_job(job: int) -> None:
        _k32.TerminateJobObject(wintypes.HANDLE(job), 1)

    def _close(job: int) -> None:
        _k32.CloseHandle(wintypes.HANDLE(job))


def _creationflags(priority: str) -> int:
    if not IS_WINDOWS:
        return 0
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if priority == "below_normal":
        flags |= subprocess.BELOW_NORMAL_PRIORITY_CLASS
    elif priority == "idle":
        flags |= subprocess.IDLE_PRIORITY_CLASS
    return flags


def _preexec(priority: str) -> Optional[Callable[[], None]]:
    if IS_WINDOWS or priority == "normal":
        return None
    increment = 10 if priority == "below_normal" else 19
    return lambda: os.nice(increment)


class BoundedProcess:
    def __init__(self) -> None:
        self.popen: Optional[subprocess.Popen] = None
        self.job = None
        self.peak_memory_bytes: Optional[int] = None
        self.cpu_seconds: Optional[float] = None
        self.wall_seconds: Optional[float] = None

    def kill(self) -> None:
        if self.job is not None:
            _terminate_job(self.job)
        elif self.popen is not None and self.popen.poll() is None:
            self.popen.kill()


class ProcessFailed(RuntimeError):
    def __init__(self, name: str, returncode: int, tail: str, memory_limited: bool = False):
        hint = " (memory limit reached?)" if memory_limited else ""
        super().__init__(f"{name} exited with code {returncode}{hint}: {tail.strip()[-600:]}")
        self.returncode = returncode


def run(
    args: Sequence[str],
    *,
    name: str,
    timeout: Optional[float] = None,
    cancel: Optional[CancelToken] = None,
    priority: str = "normal",
    memory_limit: Optional[int] = None,
    cwd: Optional[Path] = None,
    env: Optional[dict] = None,
    on_stderr_line: Optional[Callable[[str], None]] = None,
) -> BoundedProcess:
    """Run ``args`` (never a shell string), enforcing timeout/cancel/limits.

    stdout is discarded; stderr is kept as a bounded tail for error messages and
    optionally streamed line by line (for progress parsing).
    """
    if isinstance(args, (str, bytes)):
        raise TypeError("Commands must be argument arrays, not strings")
    if priority not in PRIORITIES:
        raise ValueError(f"priority must be one of {PRIORITIES}")
    if cancel is not None:
        cancel.check()

    bp = BoundedProcess()
    tail: List[str] = []
    bp.popen = subprocess.Popen(
        [str(a) for a in args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        cwd=str(cwd) if cwd else None,
        env=env,
        creationflags=_creationflags(priority),
        preexec_fn=_preexec(priority),
        shell=False,
    )
    if IS_WINDOWS:
        bp.job = _create_job(memory_limit)
        try:
            _assign(bp.job, bp.popen.pid)
        except OSError:
            # The child may already have exited; the wait below reports the result.
            pass
    elif memory_limit:
        pass  # POSIX: limits are applied by callers through resource.setrlimit if needed.

    def pump() -> None:
        assert bp.popen and bp.popen.stderr
        for raw in iter(bp.popen.stderr.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            tail.append(line)
            if len(tail) > 200:
                del tail[:100]
            if on_stderr_line:
                try:
                    on_stderr_line(line)
                except Exception:
                    pass

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    if cancel is not None:
        cancel._register(bp)
    started = time.monotonic()
    timed_out = False
    try:
        while True:
            try:
                bp.popen.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if timeout is not None and time.monotonic() - started > timeout:
                    timed_out = True
                    bp.kill()
                    bp.popen.wait()
                    break
        reader.join(timeout=5)
        if IS_WINDOWS and bp.job is not None:
            bp.peak_memory_bytes = _peak_memory(bp.job)
            bp.cpu_seconds = _cpu_seconds(bp.job)
        bp.wall_seconds = time.monotonic() - started
    finally:
        if bp.popen.stderr is not None and not reader.is_alive():
            bp.popen.stderr.close()
        if cancel is not None:
            cancel._unregister(bp)
        if IS_WINDOWS and bp.job is not None:
            _close(bp.job)
            bp.job = None

    if cancel is not None and cancel.cancelled:
        raise Cancelled(f"{name} was cancelled")
    if timed_out:
        raise TimeoutError(f"{name} exceeded its {timeout:.0f}s timeout and was stopped")
    if bp.popen.returncode != 0:
        limited = bool(memory_limit and bp.peak_memory_bytes and bp.peak_memory_bytes >= memory_limit * 0.95)
        raise ProcessFailed(name, bp.popen.returncode, "\n".join(tail), limited)
    return bp
