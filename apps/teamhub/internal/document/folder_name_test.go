package document

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestValidFolderNameCountsCharacters(t *testing.T) {
	t.Parallel()

	han := strings.Repeat("\u6c49", maxFolderNameCharacters)
	if !validFolderName(han) {
		t.Fatal("a folder name of 255 characters must be valid")
	}
	if validFolderName(han + "\u6c49") {
		t.Fatal("a folder name of 256 characters must be rejected")
	}
	if !validFolderName(strings.Repeat("t", maxFolderNameCharacters)) {
		t.Fatal("the ASCII bound must stay 255 characters")
	}
	if validFolderName("") || validFolderName(string([]byte{0xff})) {
		t.Fatal("an empty or invalid UTF-8 name must be rejected")
	}
}

func TestFolderUpdateAcceptsAMoveWithoutARename(t *testing.T) {
	t.Parallel()

	// A move sends no name at all; only a given name is validated, so a Document
	// placement (which never has one) can still be moved.
	if !folderUpdateNameValid("") {
		t.Fatal("a move without a rename must be accepted")
	}
	if !folderUpdateNameValid("Folder") || !folderUpdateNameValid(strings.Repeat("\u6c49", maxFolderNameCharacters)) {
		t.Fatal("a rename within the bound must be accepted")
	}
	if folderUpdateNameValid(strings.Repeat("\u6c49", maxFolderNameCharacters+1)) {
		t.Fatal("a rename past the bound must be rejected")
	}
}

// Every folder path validates before it touches the database, so a zero Service
// shows which unit each one counts in: a name the validator accepts reaches the
// nil pool and panics, and a name it refuses returns ErrInvalidInput first.
func TestFolderPathsCountCharacters(t *testing.T) {
	t.Parallel()

	han := strings.Repeat("\u6c49", maxFolderNameCharacters)
	var service Service
	validation := func(call func(name string) error, name string) (err error) {
		defer func() {
			// Reaching the nil pool means validation let the name through.
			if recovered := recover(); recovered != nil {
				err = nil
			}
		}()
		return call(name)
	}
	cases := []struct {
		name string
		call func(name string) error
	}{
		{"CreateFolder", func(name string) error {
			_, err := service.CreateFolder(context.Background(), CreateFolderInput{
				AccountID: "acct", Name: name,
			})
			return err
		}},
		{"CreateSharedFolder", func(name string) error {
			_, err := service.CreateSharedFolder(context.Background(), SharedFolderInput{
				AccountID: "acct", TenantID: "tenant", Name: name,
			})
			return err
		}},
		{"UpdatePlacement", func(name string) error {
			_, err := service.UpdatePlacement(context.Background(), UpdatePlacementInput{
				AccountID: "acct", PlacementID: "place", Name: name,
			})
			return err
		}},
		{"UpdateSharedFolder", func(name string) error {
			_, err := service.UpdateSharedFolder(context.Background(), UpdateSharedFolderInput{
				AccountID: "acct", TenantID: "tenant", FolderID: "folder", Name: name,
			})
			return err
		}},
	}
	for _, test := range cases {
		// 255 Han characters are 765 bytes: a byte bound refuses them.
		if err := validation(test.call, han); errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s refused a name of %d characters on length", test.name, maxFolderNameCharacters)
		}
		if err := validation(test.call, han+"\u6c49"); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s accepted a name of %d characters", test.name, maxFolderNameCharacters+1)
		}
	}
}
