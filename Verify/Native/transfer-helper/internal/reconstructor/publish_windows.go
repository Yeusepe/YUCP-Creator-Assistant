//go:build windows

package reconstructor

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func publishStagingTree(tempPath string, destination string, _ string) error {
	// MoveFileExW API: https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw
	from, err := windows.UTF16PtrFromString(tempPath)
	if err != nil {
		return fmt.Errorf("encode temporary staging path: %w", err)
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return fmt.Errorf("encode final staging path: %w", err)
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return fmt.Errorf("publish verified staging tree with write-through: %w", err)
	}
	return nil
}
