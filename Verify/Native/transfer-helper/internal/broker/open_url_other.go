//go:build !windows

package broker

import "fmt"

func openExternalURL(_ string) error {
	return fmt.Errorf("package broker browser sign-in is supported on Windows only")
}
