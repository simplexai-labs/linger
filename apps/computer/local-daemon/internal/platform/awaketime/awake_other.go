//go:build !windows

package awaketime

import "time"

// On Linux (CLOCK_MONOTONIC) and macOS (mach_absolute_time) Go timers already
// pause during system suspend.
const sleepCountsTowardTimers = false

var processStart = time.Now()

func awakeNow() time.Duration {
	return time.Since(processStart)
}
