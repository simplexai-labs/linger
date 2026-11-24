package privatefs

import "testing"

func TestIsWindowsBuiltinAdminSID(t *testing.T) {
	for _, tc := range []struct {
		name string
		sid  string
		want bool
	}{
		{"local built-in Administrator RID 500", "S-1-5-21-3623811015-3361044348-30300820-500", true},
		{"Domain Admins RID 512", "S-1-5-21-3623811015-3361044348-30300820-512", true},
		{"Enterprise Admins RID 519", "S-1-5-21-3623811015-3361044348-30300820-519", true},
		{"zero domain subauthorities RID 500", "S-1-5-21-0-0-0-500", true},
		{"max uint32 subauthorities RID 500", "S-1-5-21-4294967295-4294967295-4294967295-500", true},
		{"Guest RID 501", "S-1-5-21-3623811015-3361044348-30300820-501", false},
		{"Domain Users RID 513", "S-1-5-21-3623811015-3361044348-30300820-513", false},
		{"Domain Guests RID 514", "S-1-5-21-3623811015-3361044348-30300820-514", false},
		{"Domain Computers RID 515", "S-1-5-21-3623811015-3361044348-30300820-515", false},
		{"ordinary user RID 1001", "S-1-5-21-3623811015-3361044348-30300820-1001", false},
		{"Everyone", "S-1-1-0", false},
		{"Authenticated Users", "S-1-5-11", false},
		{"BUILTIN Users", "S-1-5-32-545", false},
		{"extra trailing subauthority", "S-1-5-21-1-2-3-500-1", false},
		{"missing domain subauthority", "S-1-5-21-1-2-500", false},
		{"uint32 overflow", "S-1-5-21-4294967296-2-3-500", false},
		{"leading zero subauthority", "S-1-5-21-01-2-3-500", false},
		{"empty string", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isWindowsBuiltinAdminSID(tc.sid); got != tc.want {
				t.Fatalf("isWindowsBuiltinAdminSID(%q) = %v, want %v", tc.sid, got, tc.want)
			}
		})
	}
}

func TestIsEligibleAdminMemberSID(t *testing.T) {
	for _, tc := range []struct {
		name string
		sid  string
		want bool
	}{
		{"secondary local user RID 1006", "S-1-5-21-3623811015-3361044348-30300820-1006", true},
		{"Entra ID account SID", "S-1-12-1-123456789-234567890-345678901-456789012", true},
		{"Everyone is excluded", "S-1-1-0", false},
		{"Authenticated Users is excluded", "S-1-5-11", false},
		{"BUILTIN Users is excluded", "S-1-5-32-545", false},
		{"Domain Users RID 513 is excluded", "S-1-5-21-1-2-3-513", false},
		{"Guest RID 501 is excluded", "S-1-5-21-1-2-3-501", false},
		{"malformed Entra SID", "S-1-12-1-1-2-3", false},
		{"overflow Entra SID", "S-1-12-1-4294967296-2-3-4", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isEligibleAdminMemberSID(tc.sid); got != tc.want {
				t.Fatalf("isEligibleAdminMemberSID(%q) = %v, want %v", tc.sid, got, tc.want)
			}
		})
	}
}

func TestIsTrustedAncestorSID(t *testing.T) {
	const (
		currentUser = "S-1-5-21-100-200-300-1001"
		builtinAdm  = "S-1-5-21-100-200-300-500"
		domainAdm   = "S-1-5-21-999-888-777-512"
		localAdmMem = "S-1-5-21-100-200-300-1006"
		entraAdmMem = "S-1-12-1-11-22-33-44"
		otherUser   = "S-1-5-21-100-200-300-1007"
		sandboxSID  = "S-1-5-21-1158770811-2547671072-1736395728-473538918"
	)
	// Even if a broken machine listed Everyone or Users in adminMembers, they
	// must never be trusted.
	adminMembers := map[string]bool{
		localAdmMem:    true,
		entraAdmMem:    true,
		"S-1-1-0":      true,
		"S-1-5-11":     true,
		"S-1-5-32-545": true,
	}
	sandbox := map[string]bool{sandboxSID: true}

	for _, tc := range []struct {
		name          string
		sid           string
		allowRuleOnly bool
		want          bool
	}{
		{"current user owner", currentUser, false, true},
		{"SYSTEM", localSystemSID, false, true},
		{"BUILTIN Administrators", builtinAdminsSID, false, true},
		{"TrustedInstaller", trustedInstallerSID, false, true},
		{"built-in Admin RID 500 owner", builtinAdm, false, true},
		{"built-in Admin RID 500 ACE", builtinAdm, true, true},
		{"Domain Admins RID 512", domainAdm, true, true},
		{"direct local admin member owner", localAdmMem, false, true},
		{"direct Entra admin member ACE", entraAdmMem, true, true},
		{"CREATOR OWNER on ACE", creatorOwnerSID, true, true},
		{"CREATOR OWNER as owner rejected", creatorOwnerSID, false, false},
		{"OWNER RIGHTS on ACE", ownerRightsSID, true, true},
		{"Codex sandbox SID on ACE", sandboxSID, true, true},
		{"Codex sandbox SID as owner rejected", sandboxSID, false, false},
		{"non-admin local user rejected", otherUser, true, false},
		{"Everyone rejected even if in adminMembers", "S-1-1-0", true, false},
		{"Authenticated Users rejected even if in adminMembers", "S-1-5-11", true, false},
		{"BUILTIN Users rejected even if in adminMembers", "S-1-5-32-545", true, false},
		{"empty SID rejected", "", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTrustedAncestorSID(tc.sid, currentUser, adminMembers, sandbox, tc.allowRuleOnly); got != tc.want {
				t.Fatalf("isTrustedAncestorSID(%q, allowRuleOnly=%v) = %v, want %v", tc.sid, tc.allowRuleOnly, got, tc.want)
			}
		})
	}
}
