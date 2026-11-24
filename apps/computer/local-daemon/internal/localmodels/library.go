package localmodels

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// Defaults for Options left zero.
const (
	defaultProgressInterval      = 2 * time.Second
	defaultStatusTimeout         = 2 * time.Minute
	defaultActionTimeout         = 15 * time.Minute
	defaultEnsurePiTimeout       = 24 * time.Minute
	defaultEnsurePiRetryInterval = 30 * time.Second
	maxEnsurePiRetryInterval     = 5 * time.Minute
	// maxRereadInterval bounds the backoff of status reads after failures.
	maxRereadInterval = time.Minute
	tailPollInterval  = 100 * time.Millisecond
	maxEventLine      = 1 << 20
	// defaultEnsureLoadTimeout bounds how long a Run waits for its model to
	// load before it starts.
	defaultEnsureLoadTimeout = 10 * time.Minute
	// firstReadTimeout bounds the status read a Run waits for when the
	// Library has none yet.
	firstReadTimeout = 5 * time.Second
)

// Options configures a Library.
type Options struct {
	// Tool is nil on a Computer the installer gave no localmodels tool.
	Tool *Tool
	// Environment is the base process environment of every tool call.
	Environment map[string]string
	// JobDirectory holds the output file of each running download or load.
	JobDirectory string
	// ProbeCacheDirectory holds concurrency-probes.json. When empty, New falls
	// back to filepath.Dir(JobDirectory), then Tool.StateDirectory.
	ProbeCacheDirectory string
	// HarnessDirectory holds the on-demand Pi runtime provisioned when a
	// local model is loaded on a Computer without Pi.
	HarnessDirectory string
	// NodePath is an optional local Node executable passed via --node to harness plan.
	NodePath string
	// Publish receives every new snapshot, in order. It is called only from
	// Act and Refresh and the jobs they start.
	Publish func(wire.LocalModelsSnapshot)
	// RuntimeChanged is told that a model was loaded or unloaded, which
	// changes the model list Pi reports.
	RuntimeChanged func()
	// CatalogChanged is told that the downloaded library models the Pi
	// catalog lists changed, including on the first read that finds any.
	CatalogChanged func()
	// ProgressInterval bounds how often job progress is published.
	ProgressInterval      time.Duration
	StatusTimeout         time.Duration
	ActionTimeout         time.Duration
	EnsurePiTimeout       time.Duration
	EnsurePiRetryInterval time.Duration
	// EnsureLoadTimeout bounds EnsureLoaded's wait for one model.
	EnsureLoadTimeout time.Duration
}

// Library runs the localmodels tool for one Computer.
//
// Acknowledgement: an action is refused when the tool refuses it, and the
// tool validates every precondition before it starts work. A download or
// load therefore runs as a child process whose first event line decides the
// answer: a progress or result line means the tool passed validation and
// recorded its job (accepted); an error line before any progress is the
// refusal, with the tool's code and structured fields; an exit without any
// event is TOOL_FAILED. unload, remove and cancel are answered when the tool
// finishes. When the command's expiry passes before the tool decides, the
// Library gives no answer (the requester reports the action as unconfirmed)
// and the outcome reaches the owner only through snapshots.
//
// Jobs outlive the Daemon: the child runs in its own process group and
// writes to a file, not a pipe, so a Daemon restart neither signals it nor
// breaks its output. A restarted Daemon trusts `library status`, which
// reads the job records localmodels keeps on disk, and polls it while a job
// it did not start is running.
type Library struct {
	tool                  *Tool
	environment           map[string]string
	jobDirectory          string
	harnessDirectory      string
	nodePath              string
	publish               func(wire.LocalModelsSnapshot)
	runtimeChanged        func()
	catalogChanged        func()
	progressInterval      time.Duration
	statusTimeout         time.Duration
	actionTimeout         time.Duration
	ensurePiTimeout       time.Duration
	ensurePiRetryInterval time.Duration
	ensureLoadTimeout     time.Duration
	now                   func() time.Time
	healthCheck           func(ctx context.Context, healthURL string) bool
	ctx                   context.Context
	stop                  context.CancelFunc

	// refreshMu serializes status reads so an older read never replaces a
	// newer one.
	refreshMu sync.Mutex
	// publishMu orders updates of current with their Publish calls.
	publishMu sync.Mutex
	// wg counts the goroutines Close waits for. Every Add happens under mu
	// after checking closed, so none races with Close's Wait.
	wg      sync.WaitGroup
	mu      sync.Mutex
	closed  bool
	current *wire.LocalModelsSnapshot
	// loaded identifies the loaded models of the last status read; nil
	// before the first one.
	loaded *string
	// testWaiting and testInstallerBusy let tests order goroutines: they
	// are told when waitLoaded starts and when a lock probe finds the
	// installer busy. Nil outside tests.
	testWaiting       func(id string)
	testInstallerBusy func()
	// catalog identifies the models the Pi catalog lists from the last
	// status read (catalogKey); nil before the first one.
	catalog *string
	// unreadable is whether the last status read failed.
	unreadable   bool
	piExecutable string
	piEnsuring   bool
	piFailures   int
	piRetryAt    time.Time
	jobs         map[string]*job
	probes       map[string]*activeProbe
	probeUnknown map[string]probeFingerprint
	prober       *concurrencyProber
	// causes holds, by model, the cause the last job's error line gave. The
	// tool's status keeps only the code, so each read puts the cause back on
	// a row that still fails with that code.
	causes        map[string]*wire.LocalModelError
	lastProgress  time.Time
	progressTimer *time.Timer
	// progressTimerID tells a timer callback that already fired whether it
	// is still the pending one.
	progressTimerID uint64
	polling         bool
	// changed is closed and replaced whenever current changes; commits
	// counts those changes.
	changed chan struct{}
	commits uint64
	// jobEnded holds, by model, commits at the moment its last supervised
	// job ended; only a later change reflects that job's outcome.
	jobEnded map[string]uint64
	// ensures serializes EnsureLoaded by model ID.
	ensures map[string]*ensureLoad
	// settleOnce starts the one installer lock probe; settledCh closes when
	// it ends.
	settleOnce         sync.Once
	settledCh          chan struct{}
	installerLockWait  time.Duration
	installerLockRetry time.Duration
}

type job struct {
	action Action
}

// New returns a Library. Close stops its supervision; jobs keep running.
func New(options Options) *Library {
	ctx, stop := context.WithCancel(context.Background())
	library := &Library{
		tool: options.Tool, environment: options.Environment, jobDirectory: options.JobDirectory,
		harnessDirectory: options.HarnessDirectory, nodePath: options.NodePath,
		publish: options.Publish, runtimeChanged: options.RuntimeChanged, catalogChanged: options.CatalogChanged,
		progressInterval: options.ProgressInterval, statusTimeout: options.StatusTimeout, actionTimeout: options.ActionTimeout,
		ensurePiTimeout: options.EnsurePiTimeout, ensurePiRetryInterval: options.EnsurePiRetryInterval,
		ensureLoadTimeout: options.EnsureLoadTimeout,
		now:               time.Now, healthCheck: gatewayAnswers, ctx: ctx, stop: stop, jobs: make(map[string]*job), probes: make(map[string]*activeProbe), probeUnknown: make(map[string]probeFingerprint),
		causes:            make(map[string]*wire.LocalModelError),
		installerLockWait: defaultInstallerLockWait, installerLockRetry: defaultInstallerLockRetry, settledCh: make(chan struct{}),
		changed: make(chan struct{}), jobEnded: make(map[string]uint64), ensures: make(map[string]*ensureLoad),
	}
	probeCacheDir := options.ProbeCacheDirectory
	if probeCacheDir == "" && options.JobDirectory != "" {
		probeCacheDir = filepath.Dir(options.JobDirectory)
	}
	toolStateDir := ""
	if options.Tool != nil {
		toolStateDir = options.Tool.StateDirectory
	}
	if probeCacheDir == "" {
		probeCacheDir = toolStateDir
	}
	library.prober = newConcurrencyProber(probeCacheDir, toolStateDir)
	if library.ensureLoadTimeout <= 0 {
		library.ensureLoadTimeout = defaultEnsureLoadTimeout
	}
	if library.progressInterval <= 0 {
		library.progressInterval = defaultProgressInterval
	}
	if library.statusTimeout <= 0 {
		library.statusTimeout = defaultStatusTimeout
	}
	if library.actionTimeout <= 0 {
		library.actionTimeout = defaultActionTimeout
	}
	if library.ensurePiTimeout <= 0 {
		library.ensurePiTimeout = defaultEnsurePiTimeout
	}
	if library.ensurePiRetryInterval <= 0 {
		library.ensurePiRetryInterval = defaultEnsurePiRetryInterval
	}
	if library.publish == nil {
		library.publish = func(wire.LocalModelsSnapshot) {}
	}
	if library.runtimeChanged == nil {
		library.runtimeChanged = func() {}
	}
	if library.catalogChanged == nil {
		library.catalogChanged = func() {}
	}
	if library.jobDirectory != "" {
		// Output files of jobs a previous Daemon started are no longer read.
		_ = os.RemoveAll(library.jobDirectory)
	}
	return library
}

// Close stops supervision and polling, and returns only after the Library's
// goroutines have returned, so nothing it started writes into the job
// directory afterwards. Running jobs (the tool's download and load
// processes) continue.
func (l *Library) Close() {
	l.stop()
	l.mu.Lock()
	l.closed = true
	if l.progressTimer != nil {
		l.progressTimer.Stop()
	}
	l.mu.Unlock()
	l.wg.Wait()
}

// track reserves n goroutines for Close to wait for, or reports false once
// the Library is closed.
func (l *Library) track(n int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.wg.Add(n)
	return true
}

// closedRefusal answers an action that arrives after Close.
var closedRefusal = wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "local model supervision has stopped"}

// PiExecutable returns the managed Pi executable provisioned for local
// models, or an empty string when none has been resolved.
func (l *Library) PiExecutable() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.piExecutable
}

// PiProvisionFailed reports whether automatic Pi setup has failed and not yet
// recovered, so Runtime diagnostics can surface an error instead of leaving Pi
// in not_installed indefinitely.
func (l *Library) PiProvisionFailed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.piExecutable == "" && !l.piEnsuring && l.piFailures > 0
}

func (l *Library) scheduleEnsurePi() {
	if l.harnessDirectory == "" || l.tool == nil || !l.tool.installed() {
		return
	}
	l.mu.Lock()
	now := l.now()
	if l.closed || l.ctx.Err() != nil || l.piExecutable != "" || l.piEnsuring || (!l.piRetryAt.IsZero() && now.Before(l.piRetryAt)) {
		l.mu.Unlock()
		return
	}
	l.piEnsuring = true
	l.wg.Add(1)
	l.mu.Unlock()

	go func() {
		defer l.wg.Done()
		ctx, cancel := context.WithTimeout(l.ctx, l.ensurePiTimeout)
		executable, err := l.tool.EnsurePi(ctx, l.environment, l.harnessDirectory, l.nodePath)
		cancel()

		l.mu.Lock()
		l.piEnsuring = false
		if l.closed || l.ctx.Err() != nil {
			l.mu.Unlock()
			return
		}
		if err == nil && executable != "" {
			l.piExecutable = executable
			l.piFailures = 0
			l.piRetryAt = time.Time{}
			l.mu.Unlock()
			slog.Info("local_models.pi_ready", "executable", executable)
			l.runtimeChanged()
			return
		}
		l.piFailures++
		firstFailure := l.piFailures == 1
		backoff := min(l.ensurePiRetryInterval<<min(l.piFailures-1, 4), maxEnsurePiRetryInterval)
		l.piRetryAt = l.now().Add(backoff)
		l.mu.Unlock()
		if err != nil {
			slog.Warn("local_models.pi_install_failed", "error", err, "retry_in", backoff)
		}
		if firstFailure {
			l.runtimeChanged()
		}
	}()
}

// Refresh reads the library now, publishes the snapshot and returns it.
func (l *Library) Refresh(ctx context.Context) wire.LocalModelsSnapshot {
	l.refreshMu.Lock()
	snapshot := l.read(ctx)
	if ctx.Err() != nil {
		// A read cut short by its caller says nothing about the library.
		l.refreshMu.Unlock()
		return snapshot
	}
	if snapshot.Available {
		l.reconcileProbes(&snapshot)
	} else {
		l.cancelAllProbes()
	}
	changed := false
	catalogChanged := false
	hasLoaded := false
	l.mu.Lock()
	if snapshot.Available {
		key := loadedKey(snapshot)
		hasLoaded = key != ""
		changed = l.loaded != nil && *l.loaded != key
		l.loaded = &key
		// The Pi catalog the Daemon reports also lists every downloaded
		// library model, so a finished download or a removal changes it too,
		// as does the first read that finds any.
		catalog := catalogKey(snapshot)
		// A read after a failed one also counts: the Pi catalog fell back to
		// the remembered entries meanwhile.
		catalogChanged = (l.catalog == nil && catalog != "") || (l.catalog != nil && *l.catalog != catalog) || l.unreadable
		l.catalog = &catalog
	}
	l.unreadable = !snapshot.Available
	l.mu.Unlock()
	committed := l.commit(snapshot)
	// localmodels registers a loaded model with Pi and unregisters it on
	// unload; the Runtime diagnostics must be read again to list it.
	if changed {
		l.runtimeChanged()
	}
	if catalogChanged {
		l.catalogChanged()
	}
	l.reconcile(committed)
	l.refreshMu.Unlock()
	if hasLoaded {
		l.scheduleEnsurePi()
	}
	return committed
}

func (l *Library) read(ctx context.Context) wire.LocalModelsSnapshot {
	if l.tool == nil || !l.tool.installed() {
		return unavailable(CodeToolNotInstalled, "", l.now())
	}
	ctx, cancel := context.WithTimeout(ctx, l.statusTimeout)
	defer cancel()
	stdout, exitCode, err := l.runOnce(ctx, Action{Name: ActionRefresh})
	if err != nil || exitCode != 0 {
		slog.Warn("local_models.status_failed", "exit_code", exitCode, "error", err)
		return unavailable(CodeToolFailed, "localmodels did not report its library status", l.now())
	}
	snapshot, err := mapStatus(stdout, l.now())
	if err != nil {
		slog.Warn("local_models.status_invalid", "error", err)
		return unavailable(CodeToolFailed, "localmodels reported a library status outside its contract", l.now())
	}
	l.restoreCauses(&snapshot)
	return snapshot
}

// restoreCauses puts each kept cause back on its failed row, and forgets one
// whose row no longer fails with the code it came with.
func (l *Library) restoreCauses(snapshot *wire.LocalModelsSnapshot) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, cause := range l.causes {
		index := slices.IndexFunc(snapshot.Models, func(model wire.LocalModel) bool { return model.ID == id })
		if index < 0 || snapshot.Models[index].Error == nil || snapshot.Models[index].Error.Code != cause.Code {
			delete(l.causes, id)
			continue
		}
		snapshot.Models[index].Error.Cause, snapshot.Models[index].Error.Path = cause.Cause, cause.Path
	}
}

// loadedKey names the loaded models; a change means Pi's model list changed.
func loadedKey(snapshot wire.LocalModelsSnapshot) string {
	var loaded []string
	for _, model := range snapshot.Models {
		if model.State == "loaded" {
			loaded = append(loaded, model.ID)
		}
	}
	sort.Strings(loaded)
	return strings.Join(loaded, "\x01")
}

func (l *Library) commit(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	l.publishMu.Lock()
	defer l.publishMu.Unlock()
	l.mu.Lock()
	l.current = &snapshot
	l.signalLocked()
	// Progress lines edit current in place; receivers get their own copy
	// cloned before mu is released.
	published := cloneSnapshot(snapshot)
	l.mu.Unlock()
	l.publish(published)
	return cloneSnapshot(published)
}

// Act starts one action and returns the tool's answer: accepted (nil) or
// its refusal. deadline is when the requester stops waiting. When it passes
// before the tool has decided, answered is false: the Daemon does not guess
// an answer, the requester reports the action as unconfirmed, and the
// outcome reaches the owner through the snapshots published once the tool
// decides.
func (l *Library) Act(ctx context.Context, action Action, deadline time.Time) (refusal *wire.LocalModelActionRefusal, answered bool) {
	if l.tool == nil || !l.tool.installed() {
		if action.Name == ActionRefresh {
			l.Refresh(ctx)
		}
		return &wire.LocalModelActionRefusal{Code: CodeToolNotInstalled}, true
	}
	switch action.Name {
	case ActionRefresh:
		if snapshot := l.Refresh(ctx); !snapshot.Available {
			return &wire.LocalModelActionRefusal{Code: snapshot.Reason.Code, Detail: snapshot.Reason.Detail}, true
		}
		return nil, true
	case ActionDownload, ActionLoad:
		l.mu.Lock()
		known := l.current != nil
		l.mu.Unlock()
		if !known {
			// Progress lines update the last snapshot; read one first.
			l.Refresh(ctx)
		}
		if action.Name == ActionLoad && l.needsUnloadBeforeLoad(ctx, action.Model) {
			return l.unloadAndStartJob(ctx, action, deadline)
		}
		return l.startJob(ctx, action, deadline)
	case ActionUnload, ActionRemove, ActionCancel:
		return l.runAction(ctx, action, deadline)
	}
	return &wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "unknown local model action"}, true
}

// runOnce runs a call that prints one JSON document and returns its stdout.
// Output goes to files and a timeout kills only the tool itself: a call may
// start or restart a long-lived server (the local model gateway) that
// inherits its output and process group, and that server must survive.
func (l *Library) runOnce(ctx context.Context, action Action) ([]byte, int, error) {
	output, stderrBytes, exitCode, err := l.tool.runBuffered(ctx, l.environment, l.jobDirectory, "job", maxEventLine, l.tool.arguments(action), nil)
	if exitCode != 0 && len(stderrBytes) > 0 {
		// Local diagnostics only: tool prose can name local paths.
		slog.Debug("local_models.tool_stderr", "action", action.Name, "stderr", string(stderrBytes))
	}
	return output, exitCode, err
}

func readBounded(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, limit))
}

// runAction answers unload, remove and cancel once the tool finishes.
func (l *Library) runAction(ctx context.Context, action Action, deadline time.Time) (*wire.LocalModelActionRefusal, bool) {
	if !l.track(1) {
		refusal := closedRefusal
		return &refusal, true
	}
	answer := newPendingAnswer()
	go func() {
		defer l.wg.Done()
		cancelledProbe := false
		if action.Name == ActionUnload || action.Name == ActionRemove {
			cancelledProbe = l.cancelProbe(action.Model)
		}
		runCtx, cancel := context.WithTimeout(l.ctx, l.actionTimeout)
		defer cancel()
		stdout, exitCode, err := l.runOnce(runCtx, action)
		refusal := documentRefusal(stdout, exitCode, err)
		answer.give(refusal)
		slog.Info("local_models.action_finished", "action", action.Name, "model", action.Model,
			"exit_code", exitCode, "refused", refusal != nil)
		switch {
		case refusal == nil:
			l.Refresh(l.ctx)
			if action.Name != ActionCancel {
				l.runtimeChanged()
			}
		case answer.missed() || cancelledProbe:
			// Nobody heard the refusal, or an active concurrency probe was
			// cancelled before the refused call: refresh so the owner sees
			// accurate state.
			l.Refresh(l.ctx)
		}
	}()
	return answer.await(ctx, deadline)
}

// documentRefusal reads the one result or error document of a JSON call.
func documentRefusal(stdout []byte, exitCode int, err error) *wire.LocalModelActionRefusal {
	if err != nil {
		return &wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "localmodels did not finish"}
	}
	event, ok := parseEvent(bytes.TrimSpace(stdout))
	switch {
	case ok && event.Event == "result" && exitCode == 0:
		return nil
	case ok && event.Event == "error":
		return event.refusal()
	}
	return &wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "localmodels exited without a result"}
}

// pendingAnswer carries the tool's one answer to the requester, who waits
// until its deadline. Whether the answer missed it is recorded, so the side
// that produced the answer knows to make the outcome visible another way.
type pendingAnswer struct {
	answer chan *wire.LocalModelActionRefusal
	late   atomic.Bool
}

func newPendingAnswer() *pendingAnswer {
	return &pendingAnswer{answer: make(chan *wire.LocalModelActionRefusal, 1)}
}

func (p *pendingAnswer) give(refusal *wire.LocalModelActionRefusal) { p.answer <- refusal }

// missed reports whether the requester stopped waiting before the answer.
func (p *pendingAnswer) missed() bool { return p.late.Load() }

func (p *pendingAnswer) await(ctx context.Context, deadline time.Time) (*wire.LocalModelActionRefusal, bool) {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case refusal := <-p.answer:
		return refusal, true
	case <-timer.C:
	case <-ctx.Done():
	}
	p.late.Store(true)
	// An answer given at the same moment still counts.
	select {
	case refusal := <-p.answer:
		return refusal, true
	default:
		return nil, false
	}
}

// unloadAndStartJob resets a stale loaded or health-check-failed model to idle
// before starting action, answering from either an unload refusal or the load's
// first event before deadline.
func (l *Library) unloadAndStartJob(ctx context.Context, action Action, deadline time.Time) (*wire.LocalModelActionRefusal, bool) {
	if !l.track(1) {
		refusal := closedRefusal
		return &refusal, true
	}
	answer := newPendingAnswer()
	go func() {
		defer l.wg.Done()
		unloadCtx, cancel := context.WithTimeout(l.ctx, l.actionTimeout)
		stdout, exitCode, err := l.runOnce(unloadCtx, Action{Name: ActionUnload, Model: action.Model})
		cancel()
		refusal := documentRefusal(stdout, exitCode, err)
		slog.Info("local_models.action_finished", "action", ActionUnload, "model", action.Model,
			"exit_code", exitCode, "refused", refusal != nil, "reason", "reset_before_load")
		if refusal != nil {
			answer.give(refusal)
			if answer.missed() {
				l.Refresh(l.ctx)
			}
			return
		}
		if l.ctx.Err() != nil {
			refusal := closedRefusal
			answer.give(&refusal)
			return
		}
		l.launchJob(action, answer, true)
	}()
	return answer.await(ctx, deadline)
}

// startJob starts a download or load and answers from its first event.
func (l *Library) startJob(ctx context.Context, action Action, deadline time.Time) (*wire.LocalModelActionRefusal, bool) {
	answer := newPendingAnswer()
	l.launchJob(action, answer, false)
	return answer.await(ctx, deadline)
}

// launchJob spawns a download or load child process and supervises it, giving
// the first refusal or acceptance to answer. When refreshOnRefusal is true (a
// reset-unload already changed state on disk), any refusal refreshes the
// snapshot and signals runtimeChanged so the idle state is published.
func (l *Library) launchJob(action Action, answer *pendingAnswer, refreshOnRefusal bool) {
	// tail and superviseJob are reserved before the job starts, so no job
	// starts unsupervised after Close.
	if !l.track(2) {
		refusal := closedRefusal
		answer.give(&refusal)
		return
	}
	output, err := l.jobOutput()
	if err != nil {
		l.wg.Add(-2)
		slog.Warn("local_models.job_output_failed", "error", err)
		answer.give(&wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "the Computer could not start localmodels"})
		if refreshOnRefusal {
			l.Refresh(l.ctx)
			l.runtimeChanged()
		}
		return
	}
	cmd := l.tool.command(l.environment, action)
	cmd.Stdout, cmd.Stderr = output, output
	// Its own process group, outside any job object: the job must outlive
	// this Daemon.
	process.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		l.wg.Add(-2)
		_ = output.Close()
		_ = os.Remove(output.Name())
		slog.Warn("local_models.job_start_failed", "action", action.Name, "error", err)
		answer.give(&wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "the Computer could not start localmodels"})
		if refreshOnRefusal {
			l.Refresh(l.ctx)
			l.runtimeChanged()
		}
		return
	}
	_ = output.Close()
	slog.Info("local_models.job_started", "action", action.Name, "model", action.Model, "pid", cmd.Process.Pid)
	exited := make(chan int, 1)
	go func() {
		_ = cmd.Wait()
		exited <- cmd.ProcessState.ExitCode()
	}()
	events := make(chan libraryEvent, 64)
	ended := make(chan int, 1)
	go func() {
		defer l.wg.Done()
		ended <- l.tail(output.Name(), exited, events)
	}()
	go func() {
		defer l.wg.Done()
		l.superviseJob(action, events, ended, answer, refreshOnRefusal)
	}()
}

func (l *Library) jobOutput() (*os.File, error) {
	if err := os.MkdirAll(l.jobDirectory, 0o700); err != nil {
		return nil, err
	}
	name := make([]byte, 12)
	if _, err := rand.Read(name); err != nil {
		return nil, err
	}
	return os.OpenFile(filepath.Join(l.jobDirectory, hex.EncodeToString(name)+".jsonl"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
}

// tail reads event lines from the job's output file until the job exits,
// then returns its exit code. It closes events.
func (l *Library) tail(path string, exited <-chan int, events chan<- libraryEvent) int {
	defer close(events)
	defer func() { _ = os.Remove(path) }()
	file, err := os.Open(path)
	if err != nil {
		// The job outlives Close, so do not wait for it past then.
		select {
		case code := <-exited:
			return code
		case <-l.ctx.Done():
			return -1
		}
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	var pending []byte
	drain := func() {
		for {
			chunk, err := reader.ReadBytes('\n')
			pending = append(pending, chunk...)
			if len(pending) > maxEventLine {
				pending = nil
			}
			if err != nil {
				return
			}
			if event, ok := parseEvent(bytes.TrimSpace(pending)); ok {
				events <- event
			}
			pending = nil
		}
	}
	ticker := time.NewTicker(tailPollInterval)
	defer ticker.Stop()
	for {
		drain()
		select {
		case code := <-exited:
			drain()
			if event, ok := parseEvent(bytes.TrimSpace(pending)); ok {
				events <- event
			}
			return code
		case <-l.ctx.Done():
			return -1
		case <-ticker.C:
		}
	}
}

// superviseJob answers the action from its first event, then follows the
// job to its end.
func (l *Library) superviseJob(action Action, events <-chan libraryEvent, ended <-chan int, answer *pendingAnswer, refreshOnRefusal bool) {
	answered := false
	accepted := false
	reply := func(refusal *wire.LocalModelActionRefusal) {
		if !answered {
			answered, accepted = true, refusal == nil
			// Registered before the answer: a caller that waits for the
			// accepted job must find it running.
			if accepted {
				l.mu.Lock()
				if action.Name == ActionLoad {
					l.cancelProbeLocked(action.Model)
					for _, unloadModel := range action.UnloadFirst {
						l.cancelProbeLocked(unloadModel)
					}
				}
				l.jobs[action.Model] = &job{action: action}
				delete(l.causes, action.Model)
				l.mu.Unlock()
			}
			answer.give(refusal)
		}
	}
	var final *libraryEvent
	phase := ""
	for event := range events {
		switch event.Event {
		case "progress":
			reply(nil)
			if event.Phase != phase {
				phase = event.Phase
				if event.Phase == "download" {
					// Publish downloading right away so refreshes do not see the
					// stale absent state while library status runs. Loads wait for
					// phaseStarted so pool reservations and unloads appear atomically.
					l.progress(event)
				}
				l.phaseStarted(event)
			} else {
				l.progress(event)
			}
		case "result":
			reply(nil)
			final = &event
		case "error":
			reply(event.refusal())
			final = &event
		}
	}
	exitCode := <-ended
	if l.ctx.Err() != nil {
		return
	}
	if !answered {
		slog.Warn("local_models.job_without_events", "action", action.Name, "model", action.Model, "exit_code", exitCode)
		reply(&wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "localmodels exited without a result"})
	}
	outcome := "failed"
	if final != nil && final.Event == "result" {
		outcome = "succeeded"
	} else if final != nil {
		outcome = final.Code
	}
	attrs := []any{"action", action.Name, "model", action.Model,
		"exit_code", exitCode, "outcome", outcome, "accepted", accepted}
	if final != nil && final.Event == "error" && strings.TrimSpace(final.Detail) != "" {
		// Local diagnostics only: redacted detail aids debugging gateway registration failures.
		attrs = append(attrs, "detail", redact.Text(clip(strings.TrimSpace(final.Detail), 500)))
	}
	slog.Info("local_models.job_finished", attrs...)
	if !accepted {
		if answer.missed() || refreshOnRefusal {
			// Nobody heard the refusal, or a reset-unload already moved the
			// model to idle; publish a fresh snapshot so state stays current.
			l.Refresh(l.ctx)
			if refreshOnRefusal {
				l.runtimeChanged()
			}
		}
		return
	}
	l.mu.Lock()
	delete(l.jobs, action.Model)
	rotateGatewayAddr := false
	l.jobEnded[action.Model] = l.commits
	if final != nil && final.Event == "error" {
		if cause := final.cause(); cause != nil {
			l.causes[action.Model] = cause
		} else if final.Code == "GATEWAY_REGISTRATION_FAILED" && final.Cause == "" {
			rotateGatewayAddr = true
		}
	}
	l.mu.Unlock()
	if rotateGatewayAddr && l.tool != nil {
		l.tool.rotateUnownedBifrostAddr()
	}
	l.Refresh(l.ctx)
	if action.Name == ActionLoad {
		l.runtimeChanged()
	}
}

// phaseStarted rereads the library when a supervised job enters a phase.
// localmodels records what a phase reserves or frees (pool use and holders,
// the placement, models unloaded first) only in its status, which progress
// lines do not carry; the job's own line is newer than that status, so it is
// applied on top. A failed read keeps the last library with only the line
// applied, and hands the failed observation to reconcile, which rereads
// with backoff until a read succeeds: the job may stay in this phase for
// minutes, so recovery must not wait for its next phase.
func (l *Library) phaseStarted(event libraryEvent) {
	l.refreshMu.Lock()
	snapshot := l.read(l.ctx)
	if l.ctx.Err() != nil {
		l.refreshMu.Unlock()
		return
	}
	if !snapshot.Available {
		l.refreshMu.Unlock()
		l.progress(event)
		l.reconcile(snapshot)
		return
	}
	applyProgress(&snapshot, event)
	l.reconcileProbes(&snapshot)
	l.publishMu.Lock()
	l.mu.Lock()
	key := loadedKey(snapshot)
	changed := l.loaded != nil && *l.loaded != key
	l.loaded = &key
	l.current = &snapshot
	l.signalLocked()
	l.publishThrottledLocked()
	l.mu.Unlock()
	l.publishMu.Unlock()
	l.refreshMu.Unlock()
	// A model unloaded first leaves Pi's catalog.
	if changed {
		l.runtimeChanged()
	}
}

// progress applies a progress line to the current snapshot and publishes
// it, at most once per progress interval; the last line of a burst is
// published when the interval ends.
func (l *Library) progress(event libraryEvent) {
	l.publishMu.Lock()
	defer l.publishMu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.current == nil || !applyProgress(l.current, event) {
		return
	}
	l.signalLocked()
	l.publishThrottledLocked()
}

// publishThrottledLocked publishes current now, or when the progress
// interval since the last publish ends. It runs with publishMu and mu held.
func (l *Library) publishThrottledLocked() {
	wait := l.progressInterval - l.now().Sub(l.lastProgress)
	if wait <= 0 {
		l.publishProgressLocked()
		return
	}
	if l.progressTimer == nil {
		l.progressTimerID++
		id := l.progressTimerID
		l.progressTimer = time.AfterFunc(wait, func() { l.flushProgress(id) })
	}
}

func (l *Library) flushProgress(id uint64) {
	l.publishMu.Lock()
	defer l.publishMu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ctx.Err() != nil || l.current == nil || l.progressTimer == nil || l.progressTimerID != id {
		return
	}
	l.publishProgressLocked()
}

// publishProgressLocked runs with publishMu and mu held.
func (l *Library) publishProgressLocked() {
	if l.progressTimer != nil {
		l.progressTimer.Stop()
		l.progressTimer = nil
	}
	l.lastProgress = l.now()
	snapshot := cloneSnapshot(*l.current)
	l.publish(snapshot)
}

// applyProgress moves the progress line's model into downloading or
// loading. It reports whether the snapshot changed.
func applyProgress(snapshot *wire.LocalModelsSnapshot, event libraryEvent) bool {
	id := event.modelID()
	for index := range snapshot.Models {
		model := &snapshot.Models[index]
		if model.ID != id {
			continue
		}
		switch event.Phase {
		case "download", "verify":
			progress := &wire.LocalModelDownloadProgress{
				Step: event.Phase, DoneBytes: bytesValue(event.Done), TotalBytes: bytesValue(event.Total),
			}
			if event.Phase == "download" {
				rate := bytesValue(event.BytesPerSecond)
				progress.BytesPerSecond = &rate
			}
			model.State, model.Download, model.Endpoint, model.ConcurrencyProbing, model.Error, model.Note = "downloading", progress, nil, nil, nil, nil
		case "load", "warm":
			model.State, model.Download, model.Endpoint, model.ConcurrencyProbing, model.Error, model.Note = "loading", nil, nil, nil, nil, nil
		default:
			return false
		}
		return true
	}
	return false
}

func cloneSnapshot(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return snapshot
	}
	var clone wire.LocalModelsSnapshot
	if json.Unmarshal(encoded, &clone) != nil {
		return snapshot
	}
	return clone
}

// reconcile rereads the library while the last read cannot be trusted to
// be followed by a report of its own: a download or load this Daemon is not
// supervising (one a previous Daemon started) runs, or the read failed. A
// failed read is retried with backoff instead of ending the watch; the loop
// ends only after a successful read with nothing to follow, or on Close.
func (l *Library) reconcile(snapshot wire.LocalModelsSnapshot) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.polling || !l.needsRereadLocked(snapshot) {
		return
	}
	l.polling = true
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		delay := l.progressInterval
		for {
			select {
			case <-l.ctx.Done():
				return
			case <-time.After(delay):
			}
			next := l.Refresh(l.ctx)
			l.mu.Lock()
			if !l.needsRereadLocked(next) {
				l.polling = false
				l.mu.Unlock()
				return
			}
			l.mu.Unlock()
			if next.Available {
				delay = l.progressInterval
			} else {
				delay = min(2*delay, maxRereadInterval)
			}
		}
	}()
}

func (l *Library) needsRereadLocked(snapshot wire.LocalModelsSnapshot) bool {
	if !snapshot.Available {
		// A missing tool stays missing until the installer changes the
		// Computer config, which restarts the Daemon.
		return snapshot.Reason != nil && snapshot.Reason.Code == CodeToolFailed
	}
	return l.hasAdoptedJobLocked(snapshot)
}

func (l *Library) hasAdoptedJobLocked(snapshot wire.LocalModelsSnapshot) bool {
	for _, model := range snapshot.Models {
		if model.State != "downloading" && model.State != "loading" {
			continue
		}
		if _, probing := l.probes[model.ID]; probing {
			continue
		}
		if _, supervised := l.jobs[model.ID]; !supervised {
			return true
		}
	}
	return false
}

// LocalModelLoadError says why the model a Run names could not be made
// ready. Code carries the decision; the message is for display only.
type LocalModelLoadError struct {
	Code    string
	ModelID string
}

func (e *LocalModelLoadError) Error() string {
	if e.Code == CodeModelNotDownloaded {
		return fmt.Sprintf("local model %s is not downloaded on this Computer", e.ModelID)
	}
	return fmt.Sprintf("local model %s could not be loaded on this Computer (%s)", e.ModelID, e.Code)
}

// EnsureLoaded codes that are not the tool's own.
const (
	CodeModelNotDownloaded = "MODEL_NOT_DOWNLOADED"
	CodeLoadFailed         = "LOAD_FAILED"
	CodeLoadTimeout        = "LOAD_TIMEOUT"
)

// errLibraryClosed ends an EnsureLoaded that Close interrupted.
var errLibraryClosed = errors.New("local model supervision has stopped")

// ensureLoad serializes EnsureLoaded for one model. turn holds one token
// while a caller works on the model; finishedAt and err, read and written
// only by the token's holder, record how its last load attempt ended.
type ensureLoad struct {
	turn       chan struct{}
	finishedAt time.Time
	err        error
}

// EnsureLoaded loads the library model whose pi_model is piModel when it is
// downloaded but not loaded, and waits until it is loaded. It returns nil
// at once when the last snapshot already shows the model loaded, and nil
// when piModel names no library model or the library cannot be read, so
// the Run proceeds as it would without this check. It never downloads a
// model and never unloads another one to make room: the tool refuses a
// load that does not fit, and that refusal is the error. A caller that
// stops waiting leaves the load running, so the next Run finds the model
// loaded; concurrent callers for one model share one load.
func (l *Library) EnsureLoaded(ctx context.Context, piModel string) error {
	if piModel == "" || l.tool == nil || !l.tool.installed() {
		return nil
	}
	waitedFrom := time.Now()
	// On the path from a person's message to the model's first token: a
	// ready model, or one outside the library, must cost no tool call.
	l.mu.Lock()
	read := l.current != nil
	known := read && l.current.Available
	cached := l.rowLocked(func(model wire.LocalModel) bool { return model.PiModel == piModel })
	l.mu.Unlock()
	if known && cached == nil {
		// pi_model is present while the model is on the Computer, and the
		// installer's stop changes nothing on disk.
		return nil
	}
	if l.settled() {
		if known && cached.State == "loaded" && l.cachedLoadedHealthy(ctx, *cached) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	} else if err := l.awaitSettled(ctx); err != nil {
		// Until the installer's stop has finished, a cached loaded row may be
		// about to be unloaded; read the status after it.
		return err
	}
	l.mu.Lock()
	read = l.current != nil
	known = read && l.current.Available
	l.mu.Unlock()
	if read && !known {
		// The library cannot be read now; reconcile rereads it in the
		// background, and the Run starts as it would without this check.
		return nil
	}
	readCtx := ctx
	if !read {
		// The first read of a Library this Run waits for: a tool that hangs
		// must not hold the Run for the whole status timeout.
		var cancel context.CancelFunc
		readCtx, cancel = context.WithTimeout(ctx, firstReadTimeout)
		defer cancel()
	}
	snapshot := l.Refresh(readCtx)
	if err := ctx.Err(); err != nil {
		return err
	}
	if readCtx.Err() != nil {
		// The read ran out of its budget; a read that finished meanwhile
		// still answers.
		latest := l.Snapshot()
		if latest == nil {
			return nil
		}
		snapshot = *latest
	}
	if !snapshot.Available {
		return nil
	}
	index := slices.IndexFunc(snapshot.Models, func(model wire.LocalModel) bool { return model.PiModel == piModel })
	if index < 0 {
		return nil
	}
	row := snapshot.Models[index]
	if row.State == "loaded" && l.localGatewayHealthy(ctx) {
		return nil
	}
	state := loadState(row)
	if state == "loaded" {
		// The model server answered status, but its local gateway did not;
		// treat it as failed so ensureByID resets and reloads it cleanly.
		state = "failed"
	}
	return l.ensureByID(ctx, row.ID, state, waitedFrom)
}

// ensureByID loads id, last seen in state, unless it is loaded, and waits
// for the outcome. Runs for one model take turns, so they share one load.
// state is loadState of the row; waitedFrom is when the caller started.
func (l *Library) ensureByID(ctx context.Context, id, state string, waitedFrom time.Time) error {
	const event = "local_models.ensure_load"
	if notDownloaded(state) {
		slog.Warn(event, "phase", "failed", "model", id, "code", CodeModelNotDownloaded, "ms", time.Since(waitedFrom).Milliseconds())
		return &LocalModelLoadError{Code: CodeModelNotDownloaded, ModelID: id}
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return errLibraryClosed
	}
	ensure := l.ensures[id]
	if ensure == nil {
		ensure = &ensureLoad{turn: make(chan struct{}, 1)}
		l.ensures[id] = ensure
	}
	l.mu.Unlock()
	select {
	case ensure.turn <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	case <-l.ctx.Done():
		return errLibraryClosed
	}
	defer func() { <-ensure.turn }()
	// A load that finished while this caller waited for its turn failed just
	// now; starting another at once would fail the same way.
	if ensure.finishedAt.After(waitedFrom) && ensure.err != nil {
		return ensure.err
	}
	l.mu.Lock()
	if row := l.rowLocked(func(model wire.LocalModel) bool { return model.ID == id }); row != nil {
		state = loadState(*row)
	}
	if _, running := l.jobs[id]; running && state != "loaded" {
		// A load the Models page just started: wait for it, not a second one.
		state = "loading"
	}
	l.mu.Unlock()
	if state == "loaded" {
		if l.localGatewayHealthy(ctx) {
			return nil
		}
		state = "failed"
	}
	slog.Info(event, "phase", "started", "model", id, "state", state)
	err := l.load(ctx, id, state)
	// Only an outcome of the load itself is shared with queued callers; a
	// caller whose budget ran out left the load running.
	if ctx.Err() == nil && loadCodeOf(err) != CodeLoadTimeout {
		ensure.finishedAt, ensure.err = time.Now(), err
	}
	ms := time.Since(waitedFrom).Milliseconds()
	var loadErr *LocalModelLoadError
	switch {
	case err == nil:
		slog.Info(event, "phase", "succeeded", "model", id, "ms", ms)
	case errors.As(err, &loadErr):
		slog.Warn(event, "phase", "failed", "model", id, "code", loadErr.Code, "ms", ms)
	default:
		slog.Info(event, "phase", "failed", "model", id, "ms", ms, "error", err)
	}
	return err
}

// load starts a load of id unless one runs, and waits for its outcome. The
// caller holds id's turn.
func (l *Library) load(ctx context.Context, id, state string) error {
	budget, cancel := context.WithTimeout(ctx, l.ensureLoadTimeout)
	defer cancel()
	// Read before the load starts: a job that ends before Act returns is
	// still observed, and jobs and jobEnded keep earlier changes out.
	l.mu.Lock()
	since := l.commits
	l.mu.Unlock()
	startedJob := false
	switch state {
	case "idle", "failed":
		refusal, answered := l.Act(budget, Action{Name: ActionLoad, Model: id}, l.now().Add(l.actionTimeout))
		if !answered {
			if err := ctx.Err(); err != nil {
				return err
			}
			return &LocalModelLoadError{Code: CodeLoadTimeout, ModelID: id}
		}
		if refusal != nil {
			if l.ctx.Err() != nil {
				return errLibraryClosed
			}
			return &LocalModelLoadError{Code: refusal.Code, ModelID: id}
		}
		startedJob = true
	case "loading":
		// A load this or a previous Daemon started; the Library follows it.
	default:
		return &LocalModelLoadError{Code: CodeModelNotDownloaded, ModelID: id}
	}
	return l.waitLoaded(ctx, budget, id, since, startedJob)
}

// waitLoaded waits until id is loaded or its load has ended otherwise. A
// row that is not loading counts as the outcome only once no supervised job
// for id runs and the snapshot changed after since and after that job ended:
// until then it may predate the job's first status. When requireSettled is
// true (load started a job), a loaded row also waits for settled so a forced
// reload on a dead gateway cannot accept the stale pre-unload loaded row.
func (l *Library) waitLoaded(ctx, budget context.Context, id string, since uint64, requireSettled bool) error {
	if l.testWaiting != nil {
		l.testWaiting(id)
	}
	for {
		l.mu.Lock()
		changed := l.changed
		available := l.current != nil && l.current.Available
		row := l.rowLocked(func(model wire.LocalModel) bool { return model.ID == id })
		_, running := l.jobs[id]
		settled := !running && l.commits > since
		if ended, ok := l.jobEnded[id]; ok && l.commits <= ended {
			settled = false
		}
		l.mu.Unlock()
		if available {
			switch {
			case row != nil && row.State == "loaded" && (!requireSettled || settled):
				return nil
			case !settled || (row != nil && row.State == "loading"):
			case row != nil && row.State == "failed" && row.Error != nil && row.Error.Code != "":
				return &LocalModelLoadError{Code: row.Error.Code, ModelID: id}
			default:
				// Unloaded, cancelled, or gone before it was loaded.
				return &LocalModelLoadError{Code: CodeLoadFailed, ModelID: id}
			}
		}
		select {
		case <-changed:
		case <-budget.Done():
			if err := ctx.Err(); err != nil {
				return err
			}
			return &LocalModelLoadError{Code: CodeLoadTimeout, ModelID: id}
		case <-l.ctx.Done():
			return errLibraryClosed
		}
	}
}

// rowLocked returns a copy of the current snapshot's first row that match
// accepts, or nil. It runs with mu held.
func (l *Library) rowLocked(match func(wire.LocalModel) bool) *wire.LocalModel {
	if l.current == nil {
		return nil
	}
	index := slices.IndexFunc(l.current.Models, match)
	if index < 0 {
		return nil
	}
	row := l.current.Models[index]
	return &row
}

// signalLocked wakes every waitLoaded after current changed. It runs with
// mu held.
func (l *Library) signalLocked() {
	l.commits++
	close(l.changed)
	l.changed = make(chan struct{})
}

// stoppedDownloadCodes mark a failed row as a download that stopped, not a
// failed load; the Web client's downloadStopped applies the same rule.
var stoppedDownloadCodes = []string{"DOWNLOAD_FAILED", "NETWORK_UNAVAILABLE", "DISK_INSUFFICIENT"}

// stateDownloadStopped is loadState's name for a stopped download.
const stateDownloadStopped = "download_stopped"

// loadState is the row's state for loading purposes: a failed row whose
// download stopped holds no complete model to load.
func loadState(row wire.LocalModel) string {
	if row.State == "failed" && row.Error != nil && slices.Contains(stoppedDownloadCodes, row.Error.Code) {
		return stateDownloadStopped
	}
	return row.State
}

// InPiCatalog reports whether the row is a model on this Computer that a Pi
// Run may name: it has a pi_model and is loaded, loading, or downloaded and
// loadable.
func InPiCatalog(row wire.LocalModel) bool {
	if row.PiModel == "" {
		return false
	}
	switch loadState(row) {
	case "idle", "loading", "loaded", "failed":
		return true
	}
	return false
}

// catalogKey names the pi_models InPiCatalog accepts.
func catalogKey(snapshot wire.LocalModelsSnapshot) string {
	var models []string
	for _, model := range snapshot.Models {
		if InPiCatalog(model) {
			models = append(models, model.PiModel)
		}
	}
	sort.Strings(models)
	return strings.Join(models, "\x01")
}

// Snapshot returns a copy of the last library snapshot, or nil before the
// first read.
func (l *Library) Snapshot() *wire.LocalModelsSnapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.current == nil {
		return nil
	}
	snapshot := cloneSnapshot(*l.current)
	return &snapshot
}

func notDownloaded(state string) bool {
	return state == "absent" || state == "downloading" || state == stateDownloadStopped
}

func loadCodeOf(err error) string {
	var loadErr *LocalModelLoadError
	if errors.As(err, &loadErr) {
		return loadErr.Code
	}
	return ""
}
