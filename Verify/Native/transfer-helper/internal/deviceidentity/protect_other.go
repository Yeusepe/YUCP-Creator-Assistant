//go:build !windows

package deviceidentity

import "fmt"

func protect(_ []byte) ([]byte, error) {
	return nil, fmt.Errorf("secure device identity is supported on Windows only")
}

func unprotect(_ []byte) ([]byte, error) {
	return nil, fmt.Errorf("secure device identity is supported on Windows only")
}
