//go:build windows

package broker

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	shell32          = windows.NewLazySystemDLL("shell32.dll")
	procShellExecute = shell32.NewProc("ShellExecuteW")
)

func openExternalURL(raw string) error {
	operation, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(raw)
	if err != nil {
		return err
	}
	result, _, callErr := procShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(target)),
		0,
		0,
		uintptr(syscall.SW_SHOWNORMAL),
	)
	if result <= 32 {
		return fmt.Errorf("ShellExecuteW failed with code %d: %w", result, callErr)
	}
	return nil
}
