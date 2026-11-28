//go:build !darwin

package localtools

type windowShareWatcher struct{}

func newWindowShareWatcher(string, func(uint32)) *windowShareWatcher { return nil }
func (*windowShareWatcher) watch(uint32)                             {}
func (*windowShareWatcher) stop(uint32)                              {}
func (*windowShareWatcher) close()                                   {}
