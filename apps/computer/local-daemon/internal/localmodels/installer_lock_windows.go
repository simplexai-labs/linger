package localmodels

import "os"

// The installer's home is under the user's profile; ownership is not
// checked on Windows.
func ownedByCurrentUser(os.FileInfo) bool { return true }
