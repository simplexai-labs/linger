package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

const maxAntigravityContextWindow = 100_000_000

var (
	antigravityProbeUsageWait   = 250 * time.Millisecond
	antigravityProbeUsageSettle = 40 * time.Millisecond
)

// AntigravityProbe is what one ACP session/new tells about the signed-in
// account: whether a session opens and which models it offers.
type AntigravityProbe struct {
	AuthenticationRequired bool
	Models                 ModelList
}

// PrepareAntigravityProtocolProbe creates an empty isolated temporary Gemini
// directory and ACP log path for `agy acp` protocol handshakes without copying
// any user credentials or settings.
func PrepareAntigravityProtocolProbe() ([]string, func(), error) {
	args, _, release, err := prepareAntigravityProbe(nil, false)
	return args, release, err
}

func prepareAntigravityIsolatedDir(baseDir string, env map[string]string, seedCredentials bool) (string, string, error) {
	geminiDir := localworkspace.AntigravityGeminiDir(baseDir)
	appDataDir := localworkspace.AntigravityAppDataDir(baseDir)
	for _, dir := range []string{baseDir, geminiDir, appDataDir} {
		if err := privatefs.EnsureDir(dir); err != nil {
			return "", "", err
		}
	}
	if seedCredentials {
		if err := localworkspace.SeedAntigravityAppDataDir(appDataDir, env); err != nil {
			return "", "", err
		}
	}
	return geminiDir, localworkspace.AntigravityACPLogPath(baseDir), nil
}

func prepareAntigravityProbe(env map[string]string, seedCredentials bool) ([]string, string, func(), error) {
	root, removeRoot, err := localworkspace.PrivateTempRoot("", "linger-antigravity-probe-")
	if err != nil {
		return nil, "", nil, err
	}
	release := func() { _ = removeRoot() }
	geminiDir, logFile, err := prepareAntigravityIsolatedDir(root, env, seedCredentials)
	if err != nil {
		release()
		return nil, "", nil, err
	}
	workDir := filepath.Join(root, "workspace")
	if err := privatefs.EnsureDir(workDir); err != nil {
		release()
		return nil, "", nil, err
	}
	args := []string{"--gemini-dir", geminiDir, "--log-file", logFile}
	return args, workDir, release, nil
}

// ProbeAntigravity opens an empty ACP session inside a temporary isolated
// Gemini directory and removes that directory after `agy acp` exits, so
// probing never persists 0-step conversations or ACP logs under the user's
// ~/.gemini/antigravity-cli store. HOME/USERPROFILE stays unchanged so OS
// keyring auth and GEMINI_API_KEY continue working alongside the copied
// file-based OAuth token and settings.
func ProbeAntigravity(ctx context.Context, inv Invocation) (AntigravityProbe, error) {
	env := invocationEnvironment(inv)
	if localworkspace.AntigravityUserAppDataDir(env) == "" {
		return AntigravityProbe{}, errors.New("Antigravity probe requires HOME")
	}
	probeArgs, workDir, release, err := prepareAntigravityProbe(env, true)
	if err != nil {
		return AntigravityProbe{}, err
	}
	defer release()
	observer := newAntigravityUsageObserver()
	var result AntigravityProbe
	err = withACPProcess(ctx, inv, workDir, probeArgs, observer.handle, func(conn *acpConn) error {
		if _, err := acpInitialize(ctx, conn); err != nil {
			return err
		}
		raw, err := acpOpenSession(ctx, conn, env, func() (json.RawMessage, error) {
			return conn.call(ctx, "session/new", map[string]any{"cwd": workDir, "mcpServers": []any{}})
		})
		if acpNeedsAuth(err) {
			result.AuthenticationRequired = true
			return nil
		}
		if err != nil {
			return err
		}
		var session acpSession
		if json.Unmarshal(raw, &session) != nil || session.SessionID == "" {
			return errors.New("Antigravity session/new returned no session")
		}
		windows := probeAntigravityContextWindows(ctx, conn, env, workDir, observer, session)
		result.Models = antigravityCatalog(session, windows)
		return nil
	})
	return result, err
}

// DiscoverAntigravityModels lists the models of the signed-in account.
func DiscoverAntigravityModels(ctx context.Context, inv Invocation) (ModelList, error) {
	probe, err := ProbeAntigravity(ctx, inv)
	if err != nil {
		return ModelList{}, err
	}
	if probe.AuthenticationRequired {
		return ModelList{}, errors.New("Antigravity sign-in is required to list models")
	}
	return probe.Models, nil
}

type antigravitySessionUsage struct {
	latestSize int
	usageSeq   uint64
	cmdSeq     uint64
}

type antigravityUsageObserver struct {
	mu       sync.Mutex
	sessions map[string]*antigravitySessionUsage
	notifyCh chan struct{}
}

func newAntigravityUsageObserver() *antigravityUsageObserver {
	return &antigravityUsageObserver{
		sessions: map[string]*antigravitySessionUsage{},
		notifyCh: make(chan struct{}, 1),
	}
}

func (o *antigravityUsageObserver) sessionLocked(sessionID string) *antigravitySessionUsage {
	state, ok := o.sessions[sessionID]
	if !ok {
		state = &antigravitySessionUsage{}
		o.sessions[sessionID] = state
	}
	return state
}

func (o *antigravityUsageObserver) handle(frame acpFrame) {
	if frame.Method != "session/update" {
		return
	}
	var envelope struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Size          json.RawMessage `json:"size"`
		} `json:"update"`
	}
	if json.Unmarshal(frame.Params, &envelope) != nil || envelope.SessionID == "" {
		return
	}
	switch envelope.Update.SessionUpdate {
	case "usage_update":
		size, ok := parseAntigravityContextWindow(envelope.Update.Size)
		if !ok {
			size = 0
		}
		o.mu.Lock()
		state := o.sessionLocked(envelope.SessionID)
		state.latestSize = size
		state.usageSeq++
		o.mu.Unlock()
		o.signal()
	case "available_commands_update":
		o.mu.Lock()
		state := o.sessionLocked(envelope.SessionID)
		state.cmdSeq++
		o.mu.Unlock()
		o.signal()
	}
}

func (o *antigravityUsageObserver) signal() {
	select {
	case o.notifyCh <- struct{}{}:
	default:
	}
}

func (o *antigravityUsageObserver) snapshot(sessionID string) (usageSeq, cmdSeq uint64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	state, ok := o.sessions[sessionID]
	if !ok {
		return 0, 0
	}
	return state.usageSeq, state.cmdSeq
}

// wait blocks until a new usage_update arrives for sessionID after
// prevUsageSeq, or until totalWait expires or ctx is cancelled. When
// settleAfterCmd > 0, observing available_commands_update for sessionID after
// prevCmdSeq arms a shorter settle window (for model switches where agy omits
// repeated usage_update notifications for an unchanged context size); passing
// settleAfterCmd <= 0 disables early settling after available_commands_update.
// sawCmd reports whether available_commands_update was observed for sessionID
// after prevCmdSeq.
func (o *antigravityUsageObserver) wait(
	ctx context.Context,
	sessionID string,
	prevUsageSeq, prevCmdSeq uint64,
	totalWait, settleAfterCmd time.Duration,
) (size int, gotUsage, sawCmd bool) {
	check := func() (int, bool, bool) {
		o.mu.Lock()
		defer o.mu.Unlock()
		state, ok := o.sessions[sessionID]
		if !ok {
			return 0, false, false
		}
		return state.latestSize, state.usageSeq > prevUsageSeq, state.cmdSeq > prevCmdSeq
	}
	size, gotUsage, sawCmd = check()
	if gotUsage {
		return size, true, sawCmd
	}
	if totalWait <= 0 {
		return 0, false, sawCmd
	}
	totalTimer := time.NewTimer(totalWait)
	defer totalTimer.Stop()
	var settleTimer *time.Timer
	var settleC <-chan time.Time
	armSettle := func() {
		if settleAfterCmd <= 0 || settleTimer != nil {
			return
		}
		settleTimer = time.NewTimer(settleAfterCmd)
		settleC = settleTimer.C
	}
	defer func() {
		if settleTimer != nil {
			settleTimer.Stop()
		}
	}()
	if sawCmd {
		armSettle()
	}
	for {
		select {
		case <-o.notifyCh:
			size, gotUsage, sawCmd = check()
			if gotUsage {
				return size, true, sawCmd
			}
			if sawCmd {
				armSettle()
			}
		case <-settleC:
			size, gotUsage, sawCmd = check()
			if gotUsage {
				return size, true, sawCmd
			}
			return 0, false, sawCmd
		case <-totalTimer.C:
			size, gotUsage, sawCmd = check()
			if gotUsage {
				return size, true, sawCmd
			}
			return 0, false, sawCmd
		case <-ctx.Done():
			size, gotUsage, sawCmd = check()
			if gotUsage {
				return size, true, sawCmd
			}
			return 0, false, sawCmd
		}
	}
}

func parseAntigravityContextWindow(raw json.RawMessage) (int, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] < '0' || trimmed[i] > '9' {
			return 0, false
		}
	}
	size, err := strconv.Atoi(trimmed)
	if err != nil || size <= 0 || size > maxAntigravityContextWindow {
		return 0, false
	}
	return size, true
}

func antigravityModelConfigOption(session acpSession) *acpConfigOption {
	for i := range session.ConfigOptions {
		if session.ConfigOptions[i].Category == "model" {
			return &session.ConfigOptions[i]
		}
	}
	for i := range session.ConfigOptions {
		if session.ConfigOptions[i].ID == "model" {
			return &session.ConfigOptions[i]
		}
	}
	return nil
}

type antigravityWindowProber struct {
	conn         *acpConn
	env          map[string]string
	workDir      string
	observer     *antigravityUsageObserver
	seenSessions map[string]struct{}
}

type antigravitySweepResult struct {
	windows       map[string]int
	unresolved    []string
	altAnchor     string
	altAnchorSize int
	candidateAlt  string
}

func probeAntigravityContextWindows(
	ctx context.Context,
	conn *acpConn,
	env map[string]string,
	workDir string,
	observer *antigravityUsageObserver,
	session acpSession,
) map[string]int {
	initialSize, gotNew, _ := observer.wait(ctx, session.SessionID, 0, 0, antigravityProbeUsageWait, 0)
	if !gotNew || initialSize <= 0 {
		return nil
	}
	families := antigravityModelConfigOption(session)
	if families == nil {
		return map[string]int{}
	}
	prober := &antigravityWindowProber{
		conn:         conn,
		env:          env,
		workDir:      workDir,
		observer:     observer,
		seenSessions: map[string]struct{}{session.SessionID: {}},
	}
	sweep := prober.sweepInitialSession(ctx, session.SessionID, families, initialSize)
	if len(sweep.unresolved) > 0 && ctx.Err() == nil {
		prober.resolveDeferred(ctx, initialSize, &sweep)
	}
	return sweep.windows
}

func (p *antigravityWindowProber) switchModel(
	ctx context.Context,
	sessionID, model string,
	settle time.Duration,
) (size int, gotUsage, ok bool) {
	uSeq, cSeq := p.observer.snapshot(sessionID)
	if _, err := p.conn.call(ctx, "session/set_config_option", map[string]any{
		"sessionId": sessionID,
		"configId":  "model",
		"value":     model,
	}); err != nil {
		return 0, false, false
	}
	size, gotUsage, _ = p.observer.wait(ctx, sessionID, uSeq, cSeq, antigravityProbeUsageWait, settle)
	return size, gotUsage, true
}

func (p *antigravityWindowProber) openFreshSession(ctx context.Context) (sessionID string, initialSize int, ok bool) {
	if ctx.Err() != nil {
		return "", 0, false
	}
	raw, err := acpOpenSession(ctx, p.conn, p.env, func() (json.RawMessage, error) {
		return p.conn.call(ctx, "session/new", map[string]any{"cwd": p.workDir, "mcpServers": []any{}})
	})
	if err != nil {
		return "", 0, false
	}
	var fresh acpSession
	if json.Unmarshal(raw, &fresh) != nil || fresh.SessionID == "" {
		return "", 0, false
	}
	if _, seen := p.seenSessions[fresh.SessionID]; seen {
		return "", 0, false
	}
	p.seenSessions[fresh.SessionID] = struct{}{}
	size, gotUsage, _ := p.observer.wait(ctx, fresh.SessionID, 0, 0, antigravityProbeUsageWait, 0)
	if !gotUsage || size <= 0 {
		return "", 0, false
	}
	return fresh.SessionID, size, true
}

func (p *antigravityWindowProber) probeModelOnFreshSession(
	ctx context.Context,
	anchor string,
	anchorSize int,
	model string,
) (size int, gotUsage, sessionOK bool) {
	sid, freshSize, ok := p.openFreshSession(ctx)
	if !ok {
		return 0, false, false
	}
	if anchor != "" && freshSize != anchorSize {
		anchorGotSize, anchorGotUsage, switched := p.switchModel(ctx, sid, anchor, 0)
		if !switched || !anchorGotUsage || anchorGotSize != anchorSize {
			return 0, false, false
		}
	}
	size, gotUsage, switched := p.switchModel(ctx, sid, model, 0)
	if !switched {
		return 0, false, true
	}
	return size, gotUsage, true
}

// sweepInitialSession probes models on the initial session and accepts an
// explicit usage_update only while the session is clean; once any switch emits
// no usage_update (deduplicated or delayed), remaining models are deferred so
// a late frame from an earlier switch can never poison a later model.
func (p *antigravityWindowProber) sweepInitialSession(
	ctx context.Context,
	sessionID string,
	families *acpConfigOption,
	initialSize int,
) antigravitySweepResult {
	res := antigravitySweepResult{windows: map[string]int{}}
	seen := map[string]bool{}
	if families.CurrentValue != "" {
		seen[families.CurrentValue] = true
		res.windows[families.CurrentValue] = initialSize
	}
	dirty := false
	for _, opt := range families.Options {
		if opt.Value == "" || seen[opt.Value] {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		seen[opt.Value] = true
		size, gotUsage, ok := p.switchModel(ctx, sessionID, opt.Value, antigravityProbeUsageSettle)
		if !ok {
			continue
		}
		if !gotUsage {
			dirty = true
			res.unresolved = append(res.unresolved, opt.Value)
			continue
		}
		if dirty {
			res.unresolved = append(res.unresolved, opt.Value)
			if size > 0 && size != initialSize && res.candidateAlt == "" {
				res.candidateAlt = opt.Value
			}
			continue
		}
		if size > 0 {
			res.windows[opt.Value] = size
			if res.altAnchor == "" && size != initialSize {
				res.altAnchor = opt.Value
				res.altAnchorSize = size
			}
		}
	}
	return res
}

func (p *antigravityWindowProber) findAlternateAnchor(
	ctx context.Context,
	initialSize int,
	sweep *antigravitySweepResult,
) (probedFromDefault, confirmedInvalid map[string]bool, sessionOK bool) {
	probedFromDefault = map[string]bool{}
	confirmedInvalid = map[string]bool{}
	if sweep.altAnchor != "" {
		return probedFromDefault, confirmedInvalid, true
	}
	candidates := sweep.unresolved
	if sweep.candidateAlt != "" {
		candidates = make([]string, 0, len(sweep.unresolved)+1)
		candidates = append(candidates, sweep.candidateAlt)
		candidates = append(candidates, sweep.unresolved...)
	}
	for _, model := range candidates {
		if ctx.Err() != nil {
			return probedFromDefault, confirmedInvalid, false
		}
		if sweep.windows[model] > 0 || confirmedInvalid[model] || probedFromDefault[model] {
			continue
		}
		probedFromDefault[model] = true
		size, gotUsage, ok := p.probeModelOnFreshSession(ctx, "", 0, model)
		if !ok {
			return probedFromDefault, confirmedInvalid, false
		}
		if !gotUsage {
			continue
		}
		if size <= 0 {
			confirmedInvalid[model] = true
			continue
		}
		sweep.windows[model] = size
		if size != initialSize {
			sweep.altAnchor = model
			sweep.altAnchorSize = size
			break
		}
	}
	return probedFromDefault, confirmedInvalid, true
}

// resolveDeferred verifies deferred models via explicit full-wait probes on
// fresh sessions, using an alternate-size anchor when deduplication suppresses
// an update from the default model.
func (p *antigravityWindowProber) resolveDeferred(
	ctx context.Context,
	initialSize int,
	sweep *antigravitySweepResult,
) {
	probedFromDefault, confirmedInvalid, ok := p.findAlternateAnchor(ctx, initialSize, sweep)
	if !ok {
		return
	}
	for _, model := range sweep.unresolved {
		if ctx.Err() != nil {
			break
		}
		if sweep.windows[model] > 0 || confirmedInvalid[model] {
			continue
		}
		if !probedFromDefault[model] {
			size, gotUsage, ok := p.probeModelOnFreshSession(ctx, "", 0, model)
			if !ok {
				break
			}
			if gotUsage {
				if size > 0 {
					sweep.windows[model] = size
				}
				continue
			}
		}
		if sweep.altAnchor == "" {
			continue
		}
		size, gotUsage, ok := p.probeModelOnFreshSession(ctx, sweep.altAnchor, sweep.altAnchorSize, model)
		if !ok {
			break
		}
		if gotUsage && size > 0 {
			sweep.windows[model] = size
		}
	}
}

// antigravityCatalog turns a session's model selector into the catalog.
// Antigravity selects a model family and a thinking level separately, and
// names each family-and-level pair "<family>-<level>" in availableModels;
// the levels a family offers are the suffixes of its pairs.
func antigravityCatalog(session acpSession, windows map[string]int) ModelList {
	families := antigravityModelConfigOption(session)
	var catalog catalogModels
	if families == nil {
		return catalog.list()
	}
	var pairs []string
	current := ""
	if session.Models != nil {
		for _, model := range session.Models.AvailableModels {
			pairs = append(pairs, model.ModelID)
		}
		current = session.Models.CurrentModelID
	}
	for _, family := range families.Options {
		var efforts effortCatalog
		for _, level := range antigravityLevels {
			if slices.Contains(pairs, family.Value+"-"+level) {
				efforts.add(level, "")
			}
		}
		defaultEffort := ""
		if family.Value == families.CurrentValue {
			defaultEffort, _ = strings.CutPrefix(current, family.Value+"-")
		}
		catalog.add(ModelOption{
			ID: family.Value, Label: family.Name, Provider: "antigravity",
			Default: family.Value == families.CurrentValue, Effort: efforts.support(defaultEffort),
			ContextWindow: windows[family.Value],
		})
	}
	return catalog.list()
}

// antigravityLevels are the product reasoning efforts Antigravity also
// names, in ascending order.
var antigravityLevels = []string{"low", "medium", "high", "xhigh", "max"}

// withACPProcess runs exchange against a fresh `agy acp` in dir, then
// reaps the process tree. ctx bounds the exchange only.
func withACPProcess(ctx context.Context, inv Invocation, dir string, extraArgs []string, handle func(acpFrame), exchange func(*acpConn) error) error {
	proc, err := startACP(inv, dir, nil, handle, extraArgs...)
	if err != nil {
		return err
	}
	exchangeErr := exchange(proc.conn)
	if !proc.stop() && exchangeErr == nil {
		exchangeErr = errors.New("Antigravity probe process did not exit")
	}
	return exchangeErr
}

// invocationEnvironment reads back the environment an Invocation carries.
func invocationEnvironment(inv Invocation) map[string]string {
	env := map[string]string{}
	entries := inv.Env
	if entries == nil {
		entries = os.Environ()
	}
	for _, entry := range entries {
		if key, value, ok := strings.Cut(entry, "="); ok {
			env[key] = value
		}
	}
	return env
}
