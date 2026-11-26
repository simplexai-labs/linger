"""Unit tests for GNOME Overview and active window detection in local_linux.py."""
import importlib.util
import os
import subprocess
import unittest
from unittest import mock


def _load_local_linux():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_linux.py")
    spec = importlib.util.spec_from_file_location("local_linux_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


local_linux = _load_local_linux()


class _FakeVariant:
    def __init__(self, value):
        self._value = value

    def unpack(self):
        return self._value


class _FakeGio:
    class BusType:
        SESSION = "SESSION"

    class DBusCallFlags:
        NO_AUTO_START = 1

    def __init__(self, bus):
        self._bus = bus

    def bus_get_sync(self, bus_type, cancellable):
        assert bus_type == self.BusType.SESSION
        return self._bus


class _FakeGLib:
    @staticmethod
    def Variant(fmt, value):
        return (fmt, value)

    class VariantType:
        @staticmethod
        def new(sig):
            return sig


class GnomeOverviewActiveTests(unittest.TestCase):
    def test_gio_true_direct_and_nested_variant(self):
        for reply in (_FakeVariant((True,)), _FakeVariant((_FakeVariant(True),))):
            bus = mock.Mock()
            bus.call_sync.return_value = reply
            with mock.patch.object(local_linux, "Gio", _FakeGio(bus), create=True), \
                 mock.patch.object(local_linux, "GLib", _FakeGLib, create=True), \
                 mock.patch.object(local_linux.subprocess, "run") as run_mock:
                self.assertTrue(local_linux.gnome_overview_active())
                run_mock.assert_not_called()
                bus.call_sync.assert_called_once_with(
                    "org.gnome.Shell",
                    "/org/gnome/Shell",
                    "org.freedesktop.DBus.Properties",
                    "Get",
                    ("(ss)", ("org.gnome.Shell", "OverviewActive")),
                    "(v)",
                    _FakeGio.DBusCallFlags.NO_AUTO_START,
                    300,
                    None,
                )

    def test_gio_false(self):
        bus = mock.Mock()
        bus.call_sync.return_value = _FakeVariant((False,))
        with mock.patch.object(local_linux, "Gio", _FakeGio(bus), create=True), \
             mock.patch.object(local_linux, "GLib", _FakeGLib, create=True), \
             mock.patch.object(local_linux.subprocess, "run") as run_mock:
            self.assertFalse(local_linux.gnome_overview_active())
            run_mock.assert_not_called()

    def test_gio_service_unknown_or_timeout_returns_false(self):
        for exc in (RuntimeError("GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown"), TimeoutError("timed out")):
            bus = mock.Mock()
            bus.call_sync.side_effect = exc
            with mock.patch.object(local_linux, "Gio", _FakeGio(bus), create=True), \
                 mock.patch.object(local_linux, "GLib", _FakeGLib, create=True), \
                 mock.patch.object(local_linux.subprocess, "run") as run_mock:
                self.assertFalse(local_linux.gnome_overview_active())
                run_mock.assert_not_called()

    def test_missing_gio_returns_false_without_subprocesses(self):
        with mock.patch.object(local_linux, "Gio", None, create=True), \
             mock.patch.object(local_linux, "GLib", None, create=True), \
             mock.patch.object(local_linux.subprocess, "run") as run_mock:
            self.assertFalse(local_linux.gnome_overview_active())
            run_mock.assert_not_called()


class ActiveWindowTests(unittest.TestCase):
    def test_active_window_returns_empty_when_overview_active_even_if_x11_reports_window(self):
        gedit_reply = subprocess.CompletedProcess([], 0, stdout="16777348\n", stderr="")
        with mock.patch.object(local_linux, "gnome_overview_active", return_value=True), \
             mock.patch.object(local_linux.subprocess, "run", return_value=gedit_reply) as run_mock:
            self.assertEqual(local_linux.active_window(), "")
            run_mock.assert_not_called()

    def test_active_window_normalizes_x11_none_and_returns_window_when_overview_inactive(self):
        with mock.patch.object(local_linux, "gnome_overview_active", return_value=False):
            with mock.patch.object(local_linux.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="0\n", stderr="")):
                self.assertEqual(local_linux.active_window(), "")
            with mock.patch.object(local_linux.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="")):
                self.assertEqual(local_linux.active_window(), "")
            with mock.patch.object(local_linux.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="16777348\n", stderr="")):
                self.assertEqual(local_linux.active_window(), "16777348")


if __name__ == "__main__":
    unittest.main()
