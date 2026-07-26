//go:build !windows

package tufclient

import (
	"fmt"
	"os"
	"path/filepath"
)

func publishTargetAtomically(source string, destination string) error {
	if err := os.Rename(source, destination); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return fmt.Errorf("open helper target directory for synchronization: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("synchronize helper target directory: %w", err)
	}
	return nil
}
