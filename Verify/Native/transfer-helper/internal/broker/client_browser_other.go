//go:build !windows

package broker

import "fmt"

func LaunchURLForClient(_ ClientIdentity, _ string) error {
	return fmt.Errorf("package broker browser launch is supported on Windows only")
}
