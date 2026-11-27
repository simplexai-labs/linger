//go:build windows

package awaketime

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows Go's runtime.nanotime1 reads KUSER_SHARED_DATA.InterruptTime,
// which advances across system sleep and hibernation.
const sleepCountsTowardTimers = true

var (
	kernel32DLL                    = windows.NewLazySystemDLL("kernel32.dll")
	procQueryUnbiasedInterruptTime = kernel32DLL.NewProc("QueryUnbiasedInterruptTime")
	processStart                   = time.Now()
)

func awakeNow() time.Duration {
	if procQueryUnbiasedInterruptTime.Find() == nil {
		var ticks uint64
		if r1, _, _ := procQueryUnbiasedInterruptTime.Call(uintptr(unsafe.Pointer(&ticks))); r1 != 0 {
			// QueryUnbiasedInterruptTime returns 100-nanosecond units since boot
			// excluding time spent in sleep or hibernation.
			const maxTicks = uint64((1<<63 - 1) / 100)
			if ticks <= maxTicks {
				return time.Duration(ticks * 100)
			}
		}
	}
	return time.Since(processStart)
}
