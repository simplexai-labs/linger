package privatefs

import (
	"strconv"
	"strings"
)

const (
	localSystemSID       = "S-1-5-18"
	builtinAdminsSID     = "S-1-5-32-544"
	creatorOwnerSID      = "S-1-3-0"
	ownerRightsSID       = "S-1-3-4"
	trustedInstallerSID  = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	ridBuiltinAdmin      = 500
	ridDomainAdmins      = 512
	ridEnterpriseAdmins  = 519
	minDynamicAccountRID = 1000
)

func parseCanonicalUint32(token string) (uint32, bool) {
	if token == "" {
		return 0, false
	}
	if len(token) > 1 && token[0] == '0' {
		return 0, false
	}
	value, err := strconv.ParseUint(token, 10, 32)
	if err != nil {
		return 0, false
	}
	return uint32(value), true
}

// isWindowsBuiltinAdminSID reports whether value is a canonical Windows domain
// or local SAM built-in administrator principal: built-in Administrator
// (RID 500), Domain Admins (RID 512), or Enterprise Admins (RID 519).
func isWindowsBuiltinAdminSID(value string) bool {
	parts := strings.Split(value, "-")
	if len(parts) != 8 || strings.Join(parts[:4], "-") != "S-1-5-21" {
		return false
	}
	for _, part := range parts[4:7] {
		if _, ok := parseCanonicalUint32(part); !ok {
			return false
		}
	}
	rid, ok := parseCanonicalUint32(parts[7])
	if !ok {
		return false
	}
	return rid == ridBuiltinAdmin || rid == ridDomainAdmins || rid == ridEnterpriseAdmins
}

// isEligibleAdminMemberSID reports whether value has the shape of an
// individual or domain/Entra account SID that may be trusted on an ancestor
// when currently listed as a direct member of BUILTIN\Administrators. Broad
// well-known groups (Everyone, Authenticated Users, Users, Domain Users,
// Guest) are always excluded.
func isEligibleAdminMemberSID(value string) bool {
	parts := strings.Split(value, "-")
	if len(parts) != 8 {
		return false
	}
	prefix := strings.Join(parts[:4], "-")
	switch prefix {
	case "S-1-5-21":
		for _, part := range parts[4:7] {
			if _, ok := parseCanonicalUint32(part); !ok {
				return false
			}
		}
		rid, ok := parseCanonicalUint32(parts[7])
		return ok && rid >= minDynamicAccountRID
	case "S-1-12-1":
		for _, part := range parts[4:8] {
			if _, ok := parseCanonicalUint32(part); !ok {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// isTrustedAncestorSID reports whether sid may own or hold replace rights on
// an ancestor directory of a private Windows path.
func isTrustedAncestorSID(
	sid string,
	currentUserSID string,
	adminMemberSIDs map[string]bool,
	sandboxSIDs map[string]bool,
	allowRuleOnlySIDs bool,
) bool {
	if sid == "" {
		return false
	}
	if (currentUserSID != "" && sid == currentUserSID) ||
		sid == localSystemSID ||
		sid == builtinAdminsSID ||
		sid == trustedInstallerSID ||
		isWindowsBuiltinAdminSID(sid) {
		return true
	}
	if adminMemberSIDs != nil && isEligibleAdminMemberSID(sid) && adminMemberSIDs[sid] {
		return true
	}
	if !allowRuleOnlySIDs {
		return false
	}
	if sid == creatorOwnerSID || sid == ownerRightsSID {
		return true
	}
	return sandboxSIDs != nil && sandboxSIDs[sid]
}
