//go:build !windows

package securedata

import "fmt"

func Protect(_ []byte, _ string) ([]byte, error) {
	return nil, fmt.Errorf("secure data protection is supported on Windows only")
}

func Unprotect(_ []byte, _ string) ([]byte, error) {
	return nil, fmt.Errorf("secure data protection is supported on Windows only")
}
