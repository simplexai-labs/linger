import importlib.util
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

PYTHON_BIN = os.path.realpath(sys.executable)
LD_PRELOAD_NOISE = "ERROR: ld.so: object '/usr/local/lib/syslog.so' from /etc/ld.so.preload cannot be preloaded (cannot open shared object file): ignored."


class FakeJournaldServer:
    """In-process AF_UNIX stream server speaking systemd's journald stdout protocol."""

    def __init__(self, sock_path, store_path):
        self.sock_path = Path(sock_path)
        self.store_path = Path(store_path)
        self.headers = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.bind(str(self.sock_path))
        self._sock.listen(16)
        self._sock.settimeout(0.05)
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()

    def _accept_loop(self):
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle_conn, args=(conn,), daemon=True).start()

    def _handle_conn(self, conn):
        try:
            reader = conn.makefile("rb")
            header = [reader.readline().decode("utf-8", errors="replace").rstrip("\n") for _ in range(7)]
            tag = header[0]
            with self._lock:
                self.headers[tag] = header
            for raw in reader:
                line = raw.decode("utf-8", errors="replace").rstrip("\n")
                with self._lock:
                    with self.store_path.open("a", encoding="utf-8") as f:
                        f.write(json.dumps({"tag": tag, "line": line}) + "\n")
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self._stop.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(timeout=1.0)


def load_local_linux():
    path = Path(__file__).with_name("local_linux.py")
    spec = importlib.util.spec_from_file_location("local_linux", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_executable(path, content):
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


class LocalLinuxLaunchTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_local_linux()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.spawned_pids = []

    def tearDown(self):
        self.mod._close_last_launch()
        for pid in self.spawned_pids:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        self.tmpdir.cleanup()

    def test_systemd_scope_command_uses_transient_scope_in_app_slice(self):
        cmd = self.mod._systemd_scope_command(["xdg-open", "https://example.com"])
        self.assertEqual(cmd[:6], ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--slice=app.slice"])
        self.assertRegex(cmd[6], r"^--unit=app-linger-[0-9a-f]{32}\.scope$")
        self.assertEqual(cmd[7:], ["--", "xdg-open", "https://example.com"])
        self.assertNotIn("--service-type=exec", cmd)
        self.assertFalse(any(part.endswith(".service") for part in cmd))

    def test_launch_env_populates_dbus_address_from_runtime_bus_socket(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as short_dir:
            sock_path = Path(short_dir) / "bus"
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                srv.bind(str(sock_path))
                with mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": short_dir}, clear=True):
                    env = self.mod.launch_env()
                self.assertEqual(env["XDG_RUNTIME_DIR"], short_dir)
                self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], "unix:path=" + str(sock_path))
            finally:
                srv.close()

    def test_launch_via_systemd_scope_fast_exit_zero_and_env(self):
        recorded = self.root / "argv.txt"
        make_executable(
            self.root / "systemd-run",
            f"""#!/bin/sh
{{
  printf 'DISPLAY=%s\\n' "$DISPLAY"
  printf 'DBUS=%s\\n' "$DBUS_SESSION_BUS_ADDRESS"
  for arg in "$@"; do
    printf 'ARG=%s\\n' "$arg"
  done
}} > {shlex.quote(str(recorded))}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
exec "$@"
""",
        )
        fake_xdg = make_executable(
            self.root / "xdg-open",
            "#!/bin/sh\nexit 0\n",
        )
        env = {
            "PATH": str(self.root) + os.pathsep + os.environ.get("PATH", ""),
            "DISPLAY": ":99",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1010/bus",
        }
        started = time.monotonic()
        with mock.patch.dict(os.environ, env, clear=False), \
             mock.patch.object(self.mod, "_systemd_user_reachable", return_value=True):
            self.mod.launch([str(fake_xdg), "https://example.com"], settle_seconds=3.0)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0, "fast exit-0 launcher should not wait the full settle window")
        lines = recorded.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "DISPLAY=:99")
        self.assertEqual(lines[1], "DBUS=unix:path=/run/user/1010/bus")
        argv = [line[4:] for line in lines[2:] if line.startswith("ARG=")]
        self.assertEqual(argv[:5], ["--user", "--scope", "--quiet", "--collect", "--slice=app.slice"])
        self.assertRegex(argv[5], r"^--unit=app-linger-[0-9a-f]{32}\.scope$")
        self.assertEqual(argv[6:], ["--", str(fake_xdg), "https://example.com"])
        self.assertEqual(self.mod.launch_error("open"), "")

    def test_launch_immediate_nonzero_snap_cgroup_error_fails_fast(self):
        make_executable(
            self.root / "systemd-run",
            """#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
exec "$@"
""",
        )
        snap_err = "/user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-f67530ce.service is not a snap cgroup for tag snap.firefox.firefox"
        fake_xdg = make_executable(
            self.root / "xdg-open",
            f"#!/bin/sh\nsleep 0.05\nprintf '%s\\n' {shlex.quote(snap_err)} >&2\nexit 4\n",
        )
        env = {"PATH": str(self.root) + os.pathsep + os.environ.get("PATH", "")}
        started = time.monotonic()
        with mock.patch.dict(os.environ, env, clear=False), \
             mock.patch.object(self.mod, "_systemd_user_reachable", return_value=True):
            with self.assertRaises(self.mod.LaunchError) as ctx:
                self.mod.launch([str(fake_xdg), "https://example.com"], settle_seconds=3.0)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0, "immediate non-zero exit must fail fast before settle deadline")
        self.assertIn("exited with status 4", str(ctx.exception))
        self.assertIn("is not a snap cgroup for tag snap.firefox.firefox", str(ctx.exception))

    def test_launch_long_lived_app_detaches_without_sigpipe_or_blocking(self):
        pid_file = self.root / "app.pid"
        alive_file = self.root / "app.alive"
        fake_app = make_executable(
            self.root / "fake-gedit",
            f"""#!{PYTHON_BIN}
import os, signal, sys, time
# Explicitly restore SIG_DFL for SIGPIPE (matching C/GTK apps) to prove
# writing warnings to stderr after parent closes its handle never kills the app.
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
with open({str(pid_file)!r}, "w") as f:
    f.write(f"{{os.getpid()}} {{os.getpgid(0)}}")
for i in range(40):
    sys.stderr.write(f"Gtk-WARNING: warning {{i}}\\n")
    sys.stderr.flush()
    if i == 10:
        with open({str(alive_file)!r}, "w") as f:
            f.write("still-alive")
    time.sleep(0.05)
""",
        )
        env = {"PATH": str(self.root)}
        started = time.monotonic()
        with mock.patch.dict(os.environ, env, clear=False):
            self.mod.launch([str(fake_app)], settle_seconds=0.2)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 0.8, "long-lived foreground app must detach after settle window")

        # Close parent's stderr handle (simulating next launch or driver exit)
        # and confirm the detached child keeps running and writing to stderr.
        self.mod._close_last_launch()
        deadline = time.monotonic() + 2.0
        while not alive_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(alive_file.exists(), "detached app should survive stderr writes without SIGPIPE")

        pid, pgid = map(int, pid_file.read_text(encoding="utf-8").split())
        self.spawned_pids.append(pid)
        self.assertEqual(pid, pgid, "detached app must lead its own process group")
        self.assertNotEqual(pgid, os.getpgid(0), "detached app must not share driver process group")
        os.kill(pid, 0)  # still alive

    def test_launch_skips_systemd_when_user_manager_unreachable_and_never_retries_on_stderr_prose(self):
        # 1. When private socket exists but org.freedesktop.systemd1 has no bus
        # owner (broken user bus), _systemd_user_reachable returns False and
        # launch() runs the app directly without touching systemd-run.
        with tempfile.TemporaryDirectory(dir="/tmp") as short_dir:
            sd_dir = Path(short_dir) / "systemd"
            sd_dir.mkdir()
            priv_sock = sd_dir / "private"
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                srv.bind(str(priv_sock))
                systemd_called = self.root / "systemd-called.txt"
                make_executable(
                    self.root / "systemd-run",
                    f"#!/bin/sh\necho called > {shlex.quote(str(systemd_called))}\nexit 99\n",
                )
                marker = self.root / "ran.txt"
                fake_app = make_executable(
                    self.root / "fake-app",
                    f"#!/bin/sh\necho ok > {shlex.quote(str(marker))}\nexit 0\n",
                )
                env = {
                    "PATH": str(self.root) + os.pathsep + os.environ.get("PATH", ""),
                    "XDG_RUNTIME_DIR": short_dir,
                }
                with mock.patch.dict(os.environ, env, clear=False), \
                     mock.patch.object(self.mod, "_systemd_user_bus_has_owner", return_value=False):
                    self.assertFalse(self.mod._systemd_user_reachable(self.mod.launch_env()))
                    self.mod.launch([str(fake_app)], settle_seconds=2.0)
                self.assertEqual(marker.read_text(encoding="utf-8").strip(), "ok")
                self.assertFalse(systemd_called.exists(), "systemd-run must not run when user manager is unreachable")

                # 2. When the private socket is present AND NameHasOwner is True,
                # _systemd_user_reachable returns True.
                with mock.patch.dict(os.environ, env, clear=False), \
                     mock.patch.object(self.mod, "_systemd_user_bus_has_owner", return_value=True):
                    self.assertTrue(self.mod._systemd_user_reachable(self.mod.launch_env()))
            finally:
                srv.close()

        # 3. When _systemd_user_reachable is True and the app exits non-zero
        # printing D-Bus prose on stderr, launch() MUST fail directly and never
        # silently retry/fallback based on stderr text.
        runs = self.root / "runs.log"
        make_executable(
            self.root / "systemd-run",
            """#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
exec "$@"
""",
        )
        bus_err_app = make_executable(
            self.root / "bus-err-app",
            f"#!/bin/sh\necho run >> {shlex.quote(str(runs))}\necho 'Failed to connect to bus: app dbus warning' >&2\nexit 1\n",
        )
        env = {"PATH": str(self.root) + os.pathsep + os.environ.get("PATH", "")}
        with mock.patch.dict(os.environ, env, clear=False), \
             mock.patch.object(self.mod, "_systemd_user_reachable", return_value=True):
            with self.assertRaises(self.mod.LaunchError) as ctx:
                self.mod.launch([str(bus_err_app)], settle_seconds=2.0)
        self.assertIn("Failed to connect to bus: app dbus warning", str(ctx.exception))
        self.assertEqual(runs.read_text(encoding="utf-8").splitlines(), ["run"], "must not retry app on stderr prose")

    def test_launch_post_settle_crash_reported_by_launch_error(self):
        fake_app = make_executable(
            self.root / "late-crash",
            f"""#!{PYTHON_BIN}
import sys, time
time.sleep(0.15)
sys.stderr.write("late crash reason\\n")
sys.exit(7)
""",
        )
        env = {"PATH": str(self.root)}
        with mock.patch.dict(os.environ, env, clear=False):
            self.mod.launch([str(fake_app)], settle_seconds=0.05)
        deadline = time.monotonic() + 1.0
        err = ""
        while not err and time.monotonic() < deadline:
            err = self.mod.launch_error("run")
            if not err:
                time.sleep(0.02)
        self.assertIn("exited with status 7", err)
        self.assertIn("late crash reason", err)

    def test_async_grandchild_stderr_captured_for_open_url_not_running_app(self):
        # Simulate gio open exiting 0 immediately while a forked browser dies
        # shortly after and writes a snap cgroup error to inherited stderr.
        fake_xdg = make_executable(
            self.root / "xdg-open",
            f"""#!{PYTHON_BIN}
import subprocess, sys
subprocess.Popen([{PYTHON_BIN!r}, "-c", "import sys, time; time.sleep(0.06); sys.stderr.write('async snap error\\\\n'); sys.exit(1)"])
sys.exit(0)
""",
        )
        env = {"PATH": str(self.root)}
        with mock.patch.dict(os.environ, env, clear=False):
            self.mod.launch([str(fake_xdg), "https://example.com"], settle_seconds=0.5)
        deadline = time.monotonic() + 1.5
        detail = ""
        while "async snap error" not in detail and time.monotonic() < deadline:
            detail = self.mod.launch_error("open")
            time.sleep(0.02)
        self.assertIn("async snap error", detail)
        # For open_application ("run"), exit code 0 / running process should not
        # treat stderr noise alone as a crash.
        self.assertEqual(self.mod.launch_error("run"), "")

    def test_still_running_process_stderr_does_not_pollute_launch_error(self):
        pid_file = self.root / "slow.pid"
        fake_app = make_executable(
            self.root / "slow-firefox",
            f"""#!{PYTHON_BIN}
import os, sys, time
with open({str(pid_file)!r}, "w") as f:
    f.write(str(os.getpid()))
sys.stderr.write({LD_PRELOAD_NOISE!r} + "\\n")
sys.stderr.write("Gtk-WARNING: theme parsing error\\n")
sys.stderr.flush()
time.sleep(10)
""",
        )
        env = {"PATH": str(self.root)}
        with mock.patch.dict(os.environ, env, clear=False):
            self.mod.launch([str(fake_app)], settle_seconds=0.15)
        deadline = time.monotonic() + 2.0
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.spawned_pids.append(int(pid_file.read_text(encoding="utf-8").strip()))
        # Process is still running (proc.poll() is None): neither open nor run
        # mode may report its startup stderr as a launch error.
        self.assertEqual(self.mod.launch_error("open"), "")
        self.assertEqual(self.mod.launch_error("run"), "")

    def test_exited_zero_with_only_ld_preload_noise_returns_empty_launch_error(self):
        fake_xdg = make_executable(
            self.root / "xdg-open",
            f"#!/bin/sh\nprintf '%s\\n%s\\n' {shlex.quote(LD_PRELOAD_NOISE)} {shlex.quote(LD_PRELOAD_NOISE)} >&2\nexit 0\n",
        )
        env = {"PATH": str(self.root)}
        with mock.patch.dict(os.environ, env, clear=False):
            self.mod.launch([str(fake_xdg), "https://example.com"], settle_seconds=1.0)
        self.assertEqual(self.mod.launch_error("open"), "")
        self.assertEqual(self.mod.launch_error("run"), "")

    def test_nonzero_exit_filters_ld_preload_spam_and_preserves_real_snap_error(self):
        snap_err = "/user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-1.service is not a snap cgroup for tag snap.firefox.firefox"
        # Emit heavy ld.so.preload noise both before and after the real error
        # (>2 KiB total) to verify filtering runs before 500-char truncation.
        spam = "\n".join([LD_PRELOAD_NOISE] * 25)
        fake_xdg = make_executable(
            self.root / "xdg-open",
            f"#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' {shlex.quote(spam)} {shlex.quote(snap_err)} {shlex.quote(spam)} >&2\nexit 4\n",
        )
        env = {"PATH": str(self.root)}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(self.mod.LaunchError) as ctx:
                self.mod.launch([str(fake_xdg), "https://example.com"], settle_seconds=2.0)
        msg = str(ctx.exception)
        self.assertIn("exited with status 4", msg)
        self.assertIn("is not a snap cgroup for tag snap.firefox.firefox", msg)
        self.assertNotIn("cannot be preloaded", msg)

    def test_nonzero_exit_with_only_ld_preload_noise_reports_clean_exit_status(self):
        fake_xdg = make_executable(
            self.root / "xdg-open",
            f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(LD_PRELOAD_NOISE)} >&2\nexit 4\n",
        )
        env = {"PATH": str(self.root)}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(self.mod.LaunchError) as ctx:
                self.mod.launch([str(fake_xdg), "https://example.com"], settle_seconds=2.0)
        self.assertEqual(str(ctx.exception), "xdg-open failed (exited with status 4)")

    def test_journald_stream_sink_captures_errors_without_tmp_file_and_falls_back_when_unreadable(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as short_dir:
            short = Path(short_dir)
            sock_path = short / "journal.sock"
            store_path = short / "journal.jsonl"
            server = FakeJournaldServer(sock_path, store_path)
            try:
                make_executable(
                    self.root / "journalctl",
                    f"""#!{PYTHON_BIN}
import json, sys
tag = None
for i, arg in enumerate(sys.argv[1:]):
    if arg == "-t" and i + 2 <= len(sys.argv[1:]):
        tag = sys.argv[i + 2]
if not tag:
    sys.exit(0)
try:
    with open({str(store_path)!r}, encoding="utf-8") as f:
        for raw in f:
            entry = json.loads(raw)
            if entry["tag"] == tag:
                sys.stdout.write(entry["line"] + "\\n")
except FileNotFoundError:
    pass
""",
                )
                snap_err = "snap-confine: cgroup rejected"
                failing_app = make_executable(
                    self.root / "failing-snap",
                    f"#!/bin/sh\nprintf '%s\\n%s\\n' {shlex.quote(LD_PRELOAD_NOISE)} {shlex.quote(snap_err)} >&2\nexit 4\n",
                )
                long_app = make_executable(
                    self.root / "long-gui",
                    f"""#!{PYTHON_BIN}
import os, signal, sys, time
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
with open({str(self.root / "long.pid")!r}, "w") as f:
    f.write(str(os.getpid()))
sys.stderr.write("Gtk-WARNING: harmless startup log\\n")
sys.stderr.flush()
time.sleep(10)
""",
                )
                env = {"PATH": str(self.root)}
                with mock.patch.dict(os.environ, env, clear=True), \
                     mock.patch.object(self.mod, "JOURNAL_STDOUT_SOCKET", str(sock_path)):
                    self.mod._journal_sink_ready = None
                    # 1. Non-zero exit reads filtered stderr via journald stream.
                    with self.assertRaises(self.mod.LaunchError) as ctx:
                        self.mod.launch([str(failing_app)], settle_seconds=2.0)
                    self.assertIn("exited with status 4", str(ctx.exception))
                    self.assertIn(snap_err, str(ctx.exception))
                    self.assertNotIn("cannot be preloaded", str(ctx.exception))
                    self.assertTrue(self.mod._journal_sink_ready)
                    # Verify 7-line sd_journal_stream_fd protocol header.
                    launch_headers = [h for tag, h in server.headers.items() if tag.startswith("linger-launch-")]
                    self.assertTrue(launch_headers)
                    self.assertEqual(launch_headers[0][1:], ["", "3", "0", "0", "0", "0"])

                    # 2. Long-lived app uses journald stream (no /tmp file retained).
                    self.mod.launch([str(long_app)], settle_seconds=0.15)
                    self.assertIsNone(self.mod.last_launch["stderr_file"])
                    self.assertTrue(self.mod.last_launch["journal_tag"].startswith("linger-launch-"))
                    self.assertEqual(self.mod.launch_error("open"), "")
                    deadline = time.monotonic() + 2.0
                    pid_file = self.root / "long.pid"
                    while not pid_file.exists() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.spawned_pids.append(int(pid_file.read_text(encoding="utf-8").strip()))

                # 3. Unreadable journal (e.g. Storage=none) probes False and
                # falls back to TemporaryFile without losing stderr capture.
                make_executable(self.root / "journalctl", "#!/bin/sh\nexit 0\n")
                with mock.patch.dict(os.environ, env, clear=True), \
                     mock.patch.object(self.mod, "JOURNAL_STDOUT_SOCKET", str(sock_path)), \
                     mock.patch.object(self.mod, "JOURNAL_PROBE_RETRIES", 2), \
                     mock.patch.object(self.mod, "JOURNAL_RETRY_INTERVAL", 0.01):
                    self.mod._journal_sink_ready = None
                    with self.assertRaises(self.mod.LaunchError) as ctx:
                        self.mod.launch([str(failing_app)], settle_seconds=2.0)
                    self.assertFalse(self.mod._journal_sink_ready)
                    self.assertIn(snap_err, str(ctx.exception))
                    self.assertNotIn("cannot be preloaded", str(ctx.exception))
            finally:
                server.close()

    def test_probe_succeeds_without_systemd_run_and_open_checks_xdg_open(self):
        for tool in ("xdotool", "import", "xclip"):
            make_executable(self.root / tool, "#!/bin/sh\necho 1920 1080\n")
        env = {"PATH": str(self.root), "DISPLAY": ":99", "XDG_SESSION_TYPE": "x11"}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(self.mod, "missing", None):
                self.assertEqual(self.mod.native_action("probe", []), b"ready")
            with self.assertRaisesRegex(ValueError, "URL launcher is not installed: xdg-open"):
                self.mod.native_action("open", ["https://example.com"])

    def test_jsonrpc_driver_returns_failed_status_not_unknown_on_launch_error(self):
        snap_err = "/user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-1.service is not a snap cgroup for tag snap.firefox.firefox"
        make_executable(
            self.root / "xdg-open",
            f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(snap_err)} >&2\nexit 4\n",
        )
        driver_path = Path(__file__).with_name("local_linux.py")
        env = os.environ.copy()
        env["PATH"] = str(self.root) + os.pathsep + env.get("PATH", "")
        proc = subprocess.Popen(
            [PYTHON_BIN, "-u", str(driver_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            req = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "action", "arguments": {"command": "open", "args": ["https://example.com"]}},
            }
            proc.stdin.write(json.dumps(req) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            resp = json.loads(line)
            receipt = json.loads(resp["result"]["content"][0]["text"])
            self.assertEqual(receipt["status"], "failed")
            self.assertIn("exited with status 4", receipt["error"])
            self.assertIn("is not a snap cgroup for tag snap.firefox.firefox", receipt["error"])
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            proc.stdin.close()
            proc.stdout.close()
            proc.stderr.close()


if __name__ == "__main__":
    unittest.main()
