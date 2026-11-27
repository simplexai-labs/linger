//go:build windows

package winprocess

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	// maxCommandLineBytes caps PEB command-line reads to avoid excessive
	// allocations if a process reports a malformed UNICODE_STRING length.
	maxCommandLineBytes = 64 * 1024

	// stillActive is the Win32 STILL_ACTIVE (259) process exit code sentinel.
	stillActive = 259

	afInet                   = 2
	tcpTableOwnerPIDListener = 3
	mibTCPStateListen        = 2
)

var (
	modIPHlpAPI             = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = modIPHlpAPI.NewProc("GetExtendedTcpTable")
)

// ProcessEntry describes one live Windows process captured in a snapshot.
type ProcessEntry struct {
	PID     int    `json:"pid"`
	PPID    int    `json:"ppid"`
	Created string `json:"created"`
	Name    string `json:"name"`
	Command string `json:"command"`
}

// ListenerEntry describes one IPv4 TCP listening socket owned by a process.
type ListenerEntry struct {
	Port    int    `json:"port"`
	PID     int    `json:"pid"`
	Address string `json:"address"`
}

// ProcessSnapshot contains the live process table and optional TCP listeners.
type ProcessSnapshot struct {
	Processes []ProcessEntry  `json:"processes"`
	Listeners []ListenerEntry `json:"listeners,omitempty"`
}

type mibTCPRowOwnerPID struct {
	State      uint32
	LocalAddr  uint32
	LocalPort  uint32
	RemoteAddr uint32
	RemotePort uint32
	OwningPID  uint32
}

// Snapshot enumerates live Windows processes using CreateToolhelp32Snapshot,
// GetProcessTimes, and bounded PEB reads for current-user command lines. When
// includeListeners is true, IPv4 TCP listeners on 127.0.0.1 and 0.0.0.0 are
// also enumerated via GetExtendedTcpTable with 127.0.0.1 taking precedence.
func Snapshot(includeListeners bool) (*ProcessSnapshot, error) {
	processes, err := enumerateProcesses()
	if err != nil {
		return nil, err
	}
	snapshot := &ProcessSnapshot{
		Processes: processes,
	}
	if includeListeners {
		listeners, err := enumerateIPv4Listeners()
		if err != nil {
			return nil, err
		}
		snapshot.Listeners = listeners
	}
	return snapshot, nil
}

func enumerateProcesses() ([]ProcessEntry, error) {
	handle, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("snapshot processes: %w", err)
	}
	defer windows.CloseHandle(handle)

	entry := windows.ProcessEntry32{
		Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{})),
	}
	processes := make([]ProcessEntry, 0, 128)
	for err = windows.Process32First(handle, &entry); err == nil; err = windows.Process32Next(handle, &entry) {
		pid := entry.ProcessID
		created, command, exited := inspectSnapshotProcess(pid)
		if exited {
			continue
		}
		processes = append(processes, ProcessEntry{
			PID:     int(pid),
			PPID:    int(entry.ParentProcessID),
			Created: created,
			Name:    windows.UTF16ToString(entry.ExeFile[:]),
			Command: command,
		})
	}
	if err != nil && !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, fmt.Errorf("iterate processes: %w", err)
	}
	return processes, nil
}

func inspectSnapshotProcess(pid uint32) (string, string, bool) {
	if pid == 0 {
		return "", "", false
	}
	canReadMemory := true
	hasSynchronize := true
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ|windows.SYNCHRONIZE,
		false,
		pid,
	)
	if err != nil {
		canReadMemory = false
		handle, err = windows.OpenProcess(
			windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
			false,
			pid,
		)
		if err != nil {
			hasSynchronize = false
			handle, err = windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
			if err != nil {
				return "", "", false
			}
		}
	}
	defer windows.CloseHandle(handle)

	// Omit exited zombie processes whose handles are still open elsewhere.
	if hasSynchronize {
		if state, waitErr := windows.WaitForSingleObject(handle, 0); waitErr == nil && state == windows.WAIT_OBJECT_0 {
			return "", "", true
		}
	} else {
		var exitCode uint32
		if exitErr := windows.GetExitCodeProcess(handle, &exitCode); exitErr == nil && exitCode != stillActive {
			return "", "", true
		}
	}

	var created, exited, kernel, userTime windows.Filetime
	createdText := ""
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &userTime); err == nil {
		stamp := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
		if stamp > 0 {
			createdText = strconv.FormatUint(stamp, 10)
		}
	}
	if !canReadMemory {
		return createdText, "", false
	}
	return createdText, readProcessCommandLine(handle), false
}

func readProcessCommandLine(handle windows.Handle) string {
	var pbi windows.PROCESS_BASIC_INFORMATION
	if err := windows.NtQueryInformationProcess(
		handle,
		windows.ProcessBasicInformation,
		unsafe.Pointer(&pbi),
		uint32(unsafe.Sizeof(pbi)),
		nil,
	); err != nil || pbi.PebBaseAddress == nil {
		return ""
	}

	var peb windows.PEB
	var bytesRead uintptr
	if err := windows.ReadProcessMemory(
		handle,
		uintptr(unsafe.Pointer(pbi.PebBaseAddress)),
		(*byte)(unsafe.Pointer(&peb)),
		unsafe.Sizeof(peb),
		&bytesRead,
	); err != nil || bytesRead < unsafe.Offsetof(peb.ProcessParameters)+unsafe.Sizeof(peb.ProcessParameters) || peb.ProcessParameters == nil {
		return ""
	}

	var params windows.RTL_USER_PROCESS_PARAMETERS
	// Only read through CommandLine so minimal processes without the extended
	// trailing parameter fields remain readable.
	paramsPrefixSize := unsafe.Offsetof(params.CommandLine) + unsafe.Sizeof(params.CommandLine)
	bytesRead = 0
	if err := windows.ReadProcessMemory(
		handle,
		uintptr(unsafe.Pointer(peb.ProcessParameters)),
		(*byte)(unsafe.Pointer(&params)),
		paramsPrefixSize,
		&bytesRead,
	); err != nil || bytesRead < paramsPrefixSize {
		return ""
	}

	byteLen := int(params.CommandLine.Length)
	if byteLen <= 0 || params.CommandLine.Buffer == nil {
		return ""
	}
	if byteLen > maxCommandLineBytes {
		byteLen = maxCommandLineBytes
	}
	byteLen &^= 1
	if byteLen == 0 {
		return ""
	}

	buf := make([]uint16, byteLen/2)
	bytesRead = 0
	if err := windows.ReadProcessMemory(
		handle,
		uintptr(unsafe.Pointer(params.CommandLine.Buffer)),
		(*byte)(unsafe.Pointer(&buf[0])),
		uintptr(byteLen),
		&bytesRead,
	); err != nil || bytesRead < 2 {
		return ""
	}
	wordCount := int(bytesRead / 2)
	if wordCount > len(buf) {
		wordCount = len(buf)
	}
	return strings.TrimRight(string(utf16.Decode(buf[:wordCount])), "\x00")
}

func enumerateIPv4Listeners() ([]ListenerEntry, error) {
	var size uint32
	r0, _, _ := procGetExtendedTcpTable.Call(
		0,
		uintptr(unsafe.Pointer(&size)),
		0,
		afInet,
		tcpTableOwnerPIDListener,
		0,
	)
	if r0 != uintptr(windows.ERROR_INSUFFICIENT_BUFFER) && r0 != uintptr(windows.NO_ERROR) {
		return nil, fmt.Errorf("size TCP listener table: %w", windows.Errno(r0))
	}
	if size < 4 {
		return []ListenerEntry{}, nil
	}

	var buf []byte
	for attempt := 0; attempt < 4; attempt++ {
		if size > math.MaxUint32-1024 {
			return nil, errors.New("TCP listener table size overflow")
		}
		allocSize := size + 1024
		buf = make([]byte, allocSize)
		currentSize := uint32(len(buf))
		r0, _, _ = procGetExtendedTcpTable.Call(
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&currentSize)),
			0,
			afInet,
			tcpTableOwnerPIDListener,
			0,
		)
		if r0 == uintptr(windows.NO_ERROR) {
			if int(currentSize) <= len(buf) {
				buf = buf[:currentSize]
			}
			break
		}
		if r0 == uintptr(windows.ERROR_INSUFFICIENT_BUFFER) {
			size = currentSize
			continue
		}
		return nil, fmt.Errorf("read TCP listener table: %w", windows.Errno(r0))
	}
	if r0 != uintptr(windows.NO_ERROR) {
		return nil, fmt.Errorf("read TCP listener table: %w", windows.Errno(r0))
	}
	if len(buf) < 4 {
		return []ListenerEntry{}, nil
	}

	numEntries := *(*uint32)(unsafe.Pointer(&buf[0]))
	rowSize := unsafe.Sizeof(mibTCPRowOwnerPID{})
	if uint64(4)+uint64(numEntries)*uint64(rowSize) > uint64(len(buf)) {
		return nil, errors.New("TCP listener table truncated")
	}

	byPort := make(map[int]ListenerEntry)
	for i := uint32(0); i < numEntries; i++ {
		offset := uintptr(4) + uintptr(i)*rowSize
		row := *(*mibTCPRowOwnerPID)(unsafe.Pointer(&buf[offset]))
		if row.State != mibTCPStateListen || row.OwningPID == 0 {
			continue
		}
		address := ipv4ListenerAddress(row.LocalAddr)
		if address == "" {
			continue
		}
		port := int(((row.LocalPort & 0xFF) << 8) | ((row.LocalPort >> 8) & 0xFF))
		if port < 1 || port > 65535 {
			continue
		}
		existing, found := byPort[port]
		// A specific loopback bind takes precedence over an IPv4 wildcard.
		if !found || (address == "127.0.0.1" && existing.Address != "127.0.0.1") {
			byPort[port] = ListenerEntry{
				Port:    port,
				PID:     int(row.OwningPID),
				Address: address,
			}
		}
	}

	listeners := make([]ListenerEntry, 0, len(byPort))
	for _, entry := range byPort {
		listeners = append(listeners, entry)
	}
	sort.Slice(listeners, func(i, j int) bool {
		return listeners[i].Port < listeners[j].Port
	})
	return listeners, nil
}

func ipv4ListenerAddress(addr uint32) string {
	if addr == 0 {
		return "0.0.0.0"
	}
	b0 := byte(addr)
	b1 := byte(addr >> 8)
	b2 := byte(addr >> 16)
	b3 := byte(addr >> 24)
	if b0 == 127 && b1 == 0 && b2 == 0 && b3 == 1 {
		return "127.0.0.1"
	}
	return ""
}
