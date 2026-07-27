//go:build !windows

package reconstructor

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

func publishStagingTree(tempPath string, destination string, parent string) error {
	directories := make([]string, 0)
	if err := filepath.WalkDir(tempPath, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("enumerate staging directories: %w", err)
	}
	slices.Reverse(directories)
	for _, directory := range directories {
		if err := syncDirectory(directory); err != nil {
			return err
		}
	}
	if err := os.Rename(tempPath, destination); err != nil {
		return fmt.Errorf("publish verified staging tree: %w", err)
	}
	return syncDirectory(parent)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open directory for synchronization %q: %w", path, err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("synchronize directory %q: %w", path, err)
	}
	return nil
}
