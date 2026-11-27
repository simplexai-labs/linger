package privatefs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateFileRoundTripReplacementAndExclusiveCreation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "identité.json")
	if err := WriteFile(path, []byte("first"), true); err != nil {
		t.Fatal(err)
	}
	if err := CheckPath(path, "file", true); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("overwrite"), true); !errors.Is(err, os.ErrExist) {
		t.Fatalf("exclusive overwrite=%v", err)
	}
	if err := WriteFile(path, []byte("second"), false); err != nil {
		t.Fatal(err)
	}
	data, err := ReadFile(path, 6)
	if err != nil || string(data) != "second" {
		t.Fatalf("data=%q err=%v", data, err)
	}
	if _, err := ReadFile(path, 5); err == nil {
		t.Fatal("size limit ignored")
	}
}
func TestPrivateFileRejectsHardLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "secret")
	link := filepath.Join(root, "alias")
	if err := WriteFile(path, []byte("secret"), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(path, 0); err == nil {
		t.Fatal("hardline credential accepted")
	}
	if err := WriteFile(link, []byte("changed"), false); err == nil {
		t.Fatal("hardlink replacement accepted")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "secret" {
		t.Fatalf("original changed: %q %v", data, err)
	}
}

func TestProtectFileTightensPermissionsAndRejectsUnsafeTargets(t *testing.T) {
	root := t.TempDir()
	if err := EnsureDir(root); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "missing")
	if err := ProtectFile(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing ProtectFile = %v, want ErrNotExist", err)
	}
	if err := ProtectFile(root); err == nil {
		t.Fatal("directory was accepted by ProtectFile")
	}

	path := filepath.Join(root, "legacy.json")
	if err := os.WriteFile(path, []byte("token"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ProtectFile(path); err != nil {
		t.Fatalf("ProtectFile: %v", err)
	}
	if err := CheckPath(path, "file", true); err != nil {
		t.Fatalf("CheckPath after ProtectFile: %v", err)
	}
	if data, err := ReadFile(path, 0); err != nil || string(data) != "token" {
		t.Fatalf("content after ProtectFile = %q, %v", data, err)
	}
	// Idempotent on an already private file.
	if err := ProtectFile(path); err != nil {
		t.Fatalf("second ProtectFile: %v", err)
	}

	// Hard-linked files must be refused.
	hardlink := filepath.Join(root, "hardlink.json")
	if err := os.Link(path, hardlink); err != nil {
		t.Fatal(err)
	}
	if err := ProtectFile(hardlink); err == nil {
		t.Fatal("hardlink accepted by ProtectFile")
	}
	_ = os.Remove(hardlink)

	// Symlinks must be refused without changing the target.
	target := filepath.Join(root, "target.json")
	if err := os.WriteFile(target, []byte("target"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(target, 0o644)
	symlink := filepath.Join(root, "link.json")
	if err := os.Symlink(target, symlink); err == nil {
		if err := ProtectFile(symlink); err == nil {
			t.Fatal("symlink accepted by ProtectFile")
		}
	}
}
