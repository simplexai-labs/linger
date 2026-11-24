package app

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/imchannel"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listIMChannels(c *gin.Context) {
	session := currentPrincipal(c).Session
	result, err := a.imChannels.ListForActor(c.Request.Context(), session.HumanTenantID, session.HumanActorID)
	if err != nil {
		a.internalError(c, "list IM channels", err)
		return
	}
	providers := make([]httpapi.IMChannelProvider, 0, len(result.SupportedProviders))
	for _, p := range result.SupportedProviders {
		providers = append(providers, httpapi.IMChannelProvider(p))
	}
	bindings := make([]httpapi.IMChannelBinding, 0, len(result.Bindings))
	for _, b := range result.Bindings {
		bindings = append(bindings, publicIMChannelBinding(b))
	}
	c.JSON(http.StatusOK, httpapi.IMChannelListResponse{
		Available:          result.Available,
		SupportedProviders: providers,
		Bindings:           bindings,
	})
}

func (a *App) startIMChannelPairing(c *gin.Context) {
	var request httpapi.IMChannelPairingStartRequest
	if err := decodeJSON(c, &request); err != nil && !errors.Is(err, io.EOF) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "IM channel pairing request is invalid")
		return
	}
	session := currentPrincipal(c).Session
	pairing, err := a.imChannels.StartPairing(
		c.Request.Context(),
		session.HumanTenantID,
		session.AccountID,
		session.HumanActorID,
		c.Param("provider"),
	)
	if a.writeIMChannelError(c, "start IM channel pairing", err) {
		return
	}
	c.JSON(http.StatusCreated, publicIMChannelPairing(pairing))
}

func (a *App) getIMChannelPairing(c *gin.Context) {
	session := currentPrincipal(c).Session
	pairing, err := a.imChannels.PollPairing(
		c.Request.Context(),
		session.HumanTenantID,
		session.AccountID,
		session.HumanActorID,
		c.Param("pairingId"),
	)
	if a.writeIMChannelError(c, "poll IM channel pairing", err) {
		return
	}
	c.JSON(http.StatusOK, publicIMChannelPairing(pairing))
}

func (a *App) submitIMChannelPairingVerifyCode(c *gin.Context) {
	var request httpapi.IMChannelPairingVerifyRequest
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "verification code request is invalid")
		return
	}
	session := currentPrincipal(c).Session
	pairing, err := a.imChannels.SubmitPairingVerifyCode(
		c.Request.Context(),
		session.HumanTenantID,
		session.AccountID,
		session.HumanActorID,
		c.Param("pairingId"),
		request.VerifyCode,
	)
	if a.writeIMChannelError(c, "submit IM channel verification code", err) {
		return
	}
	c.JSON(http.StatusOK, publicIMChannelPairing(pairing))
}

func (a *App) updateIMChannel(c *gin.Context) {
	var request httpapi.IMChannelUpdateRequest
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "IM channel update request is invalid")
		return
	}
	session := currentPrincipal(c).Session
	binding, err := a.imChannels.SetEnabled(
		c.Request.Context(),
		session.HumanTenantID,
		session.AccountID,
		session.HumanActorID,
		c.Param("provider"),
		request.Enabled,
	)
	if a.writeIMChannelError(c, "update IM channel", err) {
		return
	}
	c.JSON(http.StatusOK, publicIMChannelBinding(binding))
}

func (a *App) disconnectIMChannel(c *gin.Context) {
	session := currentPrincipal(c).Session
	err := a.imChannels.Disconnect(
		c.Request.Context(),
		session.HumanTenantID,
		session.HumanActorID,
		c.Param("provider"),
	)
	if a.writeIMChannelError(c, "disconnect IM channel", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listInternalIMChannelBindings(c *gin.Context) {
	items, err := a.imChannels.ListEnabledInternal(c.Request.Context())
	if err != nil {
		a.internalError(c, "list internal IM channel bindings", err)
		return
	}
	out := make([]teamhubinternal.InternalIMChannelBinding, 0, len(items))
	for _, item := range items {
		row := teamhubinternal.InternalIMChannelBinding{
			Id:              item.ID,
			TenantId:        item.TenantID,
			AccountId:       item.AccountID,
			HumanActorId:    item.HumanActorID,
			Provider:        teamhubinternal.IMChannelProvider(item.Provider),
			Enabled:         item.Enabled,
			Credentials:     item.Credentials,
			Config:          item.Config,
			AdapterState:    item.AdapterState,
			OutboundRoomSeq: item.OutboundRoomSeq,
			RuntimeStatus:   teamhubinternal.IMChannelRuntimeStatus(item.RuntimeStatus),
		}
		if item.AnotherMeActorID != "" {
			v := item.AnotherMeActorID
			row.AnotherMeActorId = &v
		}
		if item.AnotherMeRoomID != "" {
			v := item.AnotherMeRoomID
			row.AnotherMeRoomId = &v
		}
		if item.OutboundRoomID != "" {
			v := item.OutboundRoomID
			row.OutboundRoomId = &v
		}
		if len(item.PendingCard) > 0 {
			pc := item.PendingCard
			row.PendingCard = &pc
		}
		if item.RuntimeErrorCode != "" {
			v := item.RuntimeErrorCode
			row.RuntimeErrorCode = &v
		}
		if item.CooldownUntil != nil {
			t := *item.CooldownUntil
			row.CooldownUntil = &t
		}
		out = append(out, row)
	}
	c.JSON(http.StatusOK, teamhubinternal.InternalIMChannelBindingList{Bindings: out})
}

func (a *App) reportInternalIMChannelStatus(c *gin.Context) {
	var request teamhubinternal.InternalIMChannelStatusReport
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "IM channel status report is invalid")
		return
	}
	update := imchannel.StatusUpdate{
		CooldownUntil:   request.CooldownUntil,
		OutboundRoomID:  request.OutboundRoomId,
		OutboundRoomSeq: request.OutboundRoomSeq,
	}
	if request.RuntimeStatus != nil {
		v := string(*request.RuntimeStatus)
		update.RuntimeStatus = &v
	}
	if request.RuntimeErrorCode != nil {
		v := *request.RuntimeErrorCode
		update.RuntimeErrorCode = &v
	}
	if request.ClearErrorCode != nil {
		update.ClearErrorCode = *request.ClearErrorCode
	}
	if request.ClearCooldown != nil {
		update.ClearCooldown = *request.ClearCooldown
	}
	if request.AdapterStatePatch != nil {
		update.AdapterStatePatch = *request.AdapterStatePatch
	}
	if request.PendingCard != nil {
		update.PendingCard = *request.PendingCard
	}
	if request.ClearPendingCard != nil {
		update.ClearPendingCard = *request.ClearPendingCard
	}
	if request.TouchInbound != nil {
		update.TouchInbound = *request.TouchInbound
	}
	if request.TouchOutbound != nil {
		update.TouchOutbound = *request.TouchOutbound
	}
	if a.writeIMChannelError(c, "report IM channel status", a.imChannels.ReportStatus(c.Request.Context(), c.Param("bindingId"), update)) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) ingestInternalIMChannelInbound(c *gin.Context) {
	var request teamhubinternal.InternalIMChannelInboundRequest
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "IM channel inbound request is invalid")
		return
	}
	input := imchannel.InboundInput{
		ExternalID:       request.ExternalId,
		SenderExternalID: request.SenderExternalId,
		Text:             request.Text,
	}
	if request.AdapterStatePatch != nil {
		input.AdapterStatePatch = *request.AdapterStatePatch
	}
	result, err := a.imChannels.IngestInbound(c.Request.Context(), c.Param("bindingId"), input)
	if a.writeIMChannelError(c, "ingest IM channel inbound", err) {
		return
	}
	resp := teamhubinternal.InternalIMChannelInboundResponse{
		Accepted: result.Accepted,
		Kind:     teamhubinternal.InternalIMChannelInboundResponseKind(result.Kind),
	}
	if result.RoomID != "" {
		v := result.RoomID
		resp.RoomId = &v
	}
	if result.ReplyHintCode != "" {
		v := result.ReplyHintCode
		resp.ReplyHintCode = &v
	}
	c.JSON(http.StatusOK, resp)
}

func (a *App) listInternalIMChannelOutbound(c *gin.Context) {
	params := contractParams[teamhubinternal.ListInternalIMChannelOutboundParams](c)
	var afterSeq int64
	if params.AfterSeq != nil {
		afterSeq = *params.AfterSeq
	}
	var limit int32 = 50
	if params.Limit != nil {
		limit = int32(*params.Limit)
	}
	page, err := a.imChannels.ListOutbound(c.Request.Context(), c.Param("bindingId"), afterSeq, limit)
	if a.writeIMChannelError(c, "list IM channel outbound", err) {
		return
	}
	items := make([]teamhubinternal.InternalIMChannelOutboundEvent, 0, len(page.Items))
	for _, ev := range page.Items {
		item := teamhubinternal.InternalIMChannelOutboundEvent{
			RoomSeq:   ev.RoomSeq,
			EventType: teamhubinternal.InternalIMChannelOutboundEventEventType(ev.EventType),
		}
		if ev.MessageID != "" {
			v := ev.MessageID
			item.MessageId = &v
		}
		if ev.AuthorActorID != "" {
			v := ev.AuthorActorID
			item.AuthorActorId = &v
		}
		if ev.AuthorKind != "" {
			v := ev.AuthorKind
			item.AuthorKind = &v
		}
		if ev.MessageKind != "" {
			v := ev.MessageKind
			item.MessageKind = &v
		}
		if ev.RawMessage != "" {
			v := ev.RawMessage
			item.RawMessage = &v
		}
		if len(ev.Card) > 0 {
			card := ev.Card
			item.Card = &card
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, teamhubinternal.InternalIMChannelOutboundPage{
		RoomId:           page.RoomID,
		AnotherMeActorId: page.AnotherMeActorID,
		HumanActorId:     page.HumanActorID,
		LatestRoomSeq:    page.LatestRoomSeq,
		HasMore:          page.HasMore,
		Items:            items,
	})
}

func (a *App) writeIMChannelError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, imchannel.ErrUnsupported):
		a.writeError(c, http.StatusBadRequest, "CHANNEL_PROVIDER_UNSUPPORTED", "this IM channel provider is not supported")
	case errors.Is(err, imchannel.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "IM channel request is invalid")
	case errors.Is(err, imchannel.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "CHANNEL_NOT_FOUND", "IM channel or pairing session was not found")
	case errors.Is(err, imchannel.ErrUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "CHANNEL_UNAVAILABLE", "IM channels are not configured in this deployment")
	case errors.Is(err, imchannel.ErrNodeServicesError):
		a.writeError(c, http.StatusServiceUnavailable, "CHANNEL_SUPERVISOR_UNAVAILABLE", "could not reach the IM channel supervisor; try again")
	default:
		a.internalError(c, action, err)
	}
	return true
}

func publicIMChannelBinding(b imchannel.Binding) httpapi.IMChannelBinding {
	out := httpapi.IMChannelBinding{
		Id:            b.ID,
		Provider:      httpapi.IMChannelProvider(b.Provider),
		Enabled:       b.Enabled,
		RuntimeStatus: httpapi.IMChannelRuntimeStatus(b.RuntimeStatus),
		CreatedAt:     b.CreatedAt,
		UpdatedAt:     b.UpdatedAt,
	}
	if b.DisplayLabel != "" {
		v := b.DisplayLabel
		out.DisplayLabel = &v
	}
	if b.RemoteUserID != "" {
		v := b.RemoteUserID
		out.RemoteUserId = &v
	}
	if b.RuntimeErrorCode != "" {
		v := b.RuntimeErrorCode
		out.RuntimeErrorCode = &v
	}
	if b.CooldownUntil != nil {
		t := *b.CooldownUntil
		out.CooldownUntil = &t
	}
	if b.LastInboundAt != nil {
		t := *b.LastInboundAt
		out.LastInboundAt = &t
	}
	if b.LastOutboundAt != nil {
		t := *b.LastOutboundAt
		out.LastOutboundAt = &t
	}
	return out
}

func publicIMChannelPairing(p imchannel.PairingSession) httpapi.IMChannelPairingSession {
	out := httpapi.IMChannelPairingSession{
		PairingId: p.PairingID,
		Provider:  httpapi.IMChannelProvider(p.Provider),
		Status:    httpapi.IMChannelPairingStatus(p.Status),
	}
	if p.QRCodeURL != "" {
		v := p.QRCodeURL
		out.QrCodeUrl = &v
	}
	if p.ErrorCode != "" {
		v := p.ErrorCode
		out.ErrorCode = &v
	}
	if p.Binding != nil {
		b := publicIMChannelBinding(*p.Binding)
		out.Binding = &b
	}
	return out
}
