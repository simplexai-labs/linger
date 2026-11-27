package app

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilegateway"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/pairedphone"
)

// pairingCodePayload is the JSON a pairing QR code carries; docs/mobile.md
// defines it.
type pairingCodePayload struct {
	Version   int    `json:"v"`
	Name      string `json:"name"`
	HostKey   string `json:"host_key"`
	Invite    string `json:"invite"`
	ExpiresAt string `json:"expires_at"`
	// Relay is the first node, for phones that know only one.
	Relay  *string               `json:"relay"`
	Relays []mobilegateway.Relay `json:"relays"`
	LAN    []string              `json:"lan"`
}

// maxPairingRelays keeps the pairing QR code small enough to render and scan.
const maxPairingRelays = 4

func (a *App) createPhonePairingCode(c *gin.Context) {
	if a.mobileGateway == nil {
		a.writeError(c, http.StatusServiceUnavailable, "MOBILE_UNAVAILABLE", "Phones cannot pair: this deployment has no secret seed")
		return
	}
	principal := currentPrincipal(c)
	invite, err := a.pairedPhones.CreateInvite(c.Request.Context(), principal.Session.AccountID)
	if err != nil {
		a.internalError(c, "create pairing invite", err)
		return
	}
	lan := a.mobileGateway.LANEndpoints()
	payload := pairingCodePayload{
		Version: 1, Name: a.mobileGateway.ComputerName(),
		HostKey:   base64.RawURLEncoding.EncodeToString(a.mobileGateway.PublicKey()),
		Invite:    invite.Token,
		ExpiresAt: invite.ExpiresAt.UTC().Format(time.RFC3339),
		LAN:       lan,
	}
	response := httpapi.PhonePairingCode{
		ComputerName: payload.Name, ExpiresAt: invite.ExpiresAt, HostId: a.mobileGateway.HostID(), LanUrls: lan,
	}
	relays := a.mobileGateway.Relays()
	// The QR code holds only the first few nodes, enough for a first
	// session; the welcome then gives the phone the whole list.
	payload.Relays = relays[:min(len(relays), maxPairingRelays)]
	endpoints := make([]httpapi.MobileRelayEndpoint, 0, len(relays))
	for _, relay := range relays {
		endpoints = append(endpoints, httpapi.MobileRelayEndpoint{Id: relay.ID, Url: relay.URL, Label: relay.Label})
	}
	response.Relays = &endpoints
	if len(relays) > 0 {
		first := relays[0].URL
		payload.Relay = &first
		response.RelayUrl = &first
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		a.internalError(c, "encode pairing code", err)
		return
	}
	response.PairingUri = "linger://pair?d=" + base64.RawURLEncoding.EncodeToString(encoded)
	c.JSON(http.StatusCreated, response)
}

func (a *App) listPairedPhones(c *gin.Context) {
	phones, err := a.pairedPhones.List(c.Request.Context(), currentPrincipal(c).Session.AccountID)
	if err != nil {
		a.internalError(c, "list paired phones", err)
		return
	}
	connected := map[string]bool{}
	if a.mobileGateway != nil {
		connected = a.mobileGateway.Connected()
	}
	items := make([]httpapi.PairedPhone, 0, len(phones))
	for _, phone := range phones {
		item := httpapi.PairedPhone{
			Id: phone.ID, Name: phone.Name, Platform: httpapi.PhonePlatform(phone.Platform),
			Status:   httpapi.PairedPhoneStatusApproved,
			PairedAt: phone.PairedAt, LastSeenAt: phone.LastSeenAt,
			Connected: connected[phone.ID], PushEnabled: phone.PushEnabled,
		}
		if phone.Pending {
			item.Status = httpapi.PairedPhoneStatusPending
			code := phone.ConfirmationCode
			item.ConfirmationCode = &code
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, httpapi.PairedPhoneList{Items: items})
}

func (a *App) removePairedPhone(c *gin.Context) {
	phoneID := c.Param("phoneId")
	err := a.pairedPhones.Remove(c.Request.Context(), currentPrincipal(c).Session.AccountID, phoneID)
	if errors.Is(err, pairedphone.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "PHONE_NOT_FOUND", "No paired phone has this ID")
		return
	}
	if err != nil {
		a.internalError(c, "remove paired phone", err)
		return
	}
	if a.mobileGateway != nil {
		a.mobileGateway.Disconnect(phoneID)
	}
	c.Status(http.StatusNoContent)
}

func (a *App) approvePairedPhone(c *gin.Context) {
	phoneID := c.Param("phoneId")
	digest, err := a.pairedPhones.Approve(c.Request.Context(), currentPrincipal(c).Session.AccountID, phoneID)
	if errors.Is(err, pairedphone.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "PHONE_NOT_PENDING", "No phone with this ID is waiting for approval")
		return
	}
	if err != nil {
		a.internalError(c, "approve paired phone", err)
		return
	}
	if a.mobileGateway != nil {
		a.mobileGateway.Approve(phoneID, digest)
	}
	c.Status(http.StatusNoContent)
}

// callingPhone returns the Paired Phone whose device Session made the
// request; a browser Session gets 403 PHONE_ONLY.
func (a *App) callingPhone(c *gin.Context) (string, bool) {
	phoneID, err := a.pairedPhones.PhoneForSession(c.Request.Context(), currentPrincipal(c).Session.ID)
	if errors.Is(err, pairedphone.ErrNotFound) {
		a.writeError(c, http.StatusForbidden, "PHONE_ONLY", "Only a paired phone can manage its push grant")
		return "", false
	}
	if err != nil {
		a.internalError(c, "read calling phone", err)
		return "", false
	}
	return phoneID, true
}

func (a *App) putPhonePushGrant(c *gin.Context) {
	var request httpapi.PhonePushGrantRequest
	if decodeJSON(c, &request) != nil || request.Grant == "" || len(request.Grant) > 2048 || !validPushServiceURL(request.ServiceUrl) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "grant must be 1 to 2048 characters and service_url an https URL")
		return
	}
	// The phone may not choose where TeamHub posts its alerts: only the
	// Push Service this computer trusts receives a grant.
	if strings.TrimRight(request.ServiceUrl, "/") != strings.TrimRight(a.mobilePushServiceURL, "/") {
		a.writeError(c, http.StatusBadRequest, "PUSH_SERVICE_NOT_ALLOWED", "This computer sends alerts only through its own Push Service")
		return
	}
	phoneID, ok := a.callingPhone(c)
	if !ok {
		return
	}
	if err := a.pairedPhones.SetPushGrant(c.Request.Context(), phoneID, request.Grant, request.ServiceUrl); err != nil {
		a.internalError(c, "save push grant", err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) deletePhonePushGrant(c *gin.Context) {
	phoneID, ok := a.callingPhone(c)
	if !ok {
		return
	}
	if err := a.pairedPhones.SetPushGrant(c.Request.Context(), phoneID, "", ""); err != nil {
		a.internalError(c, "clear push grant", err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) putPhonePushPreferences(c *gin.Context) {
	var request httpapi.PhonePushPreferences
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "replies, decisions and when_active are required booleans")
		return
	}
	phoneID, ok := a.callingPhone(c)
	if !ok {
		return
	}
	if err := a.pairedPhones.SetPushPreferences(c.Request.Context(), phoneID, pairedphone.PushPreferences{
		Replies: request.Replies, Decisions: request.Decisions, WhenActive: request.WhenActive,
	}); err != nil {
		a.internalError(c, "save push preferences", err)
		return
	}
	c.Status(http.StatusNoContent)
}

// validPushServiceURL accepts an https origin with an optional path and no
// credentials, query or fragment, because TeamHub will post to it.
func validPushServiceURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && len(raw) <= 512 && parsed.Scheme == "https" && parsed.Host != "" &&
		parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}
