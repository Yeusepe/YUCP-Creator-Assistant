//go:build windows

package deviceidentity

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const cryptProtectUIForbidden = 0x1

var deviceKeyEntropy = []byte("YUCP transfer helper device identity v1")

func protect(plaintext []byte) ([]byte, error) {
	input := dataBlob(plaintext)
	entropy := dataBlob(deviceKeyEntropy)
	var output windows.DataBlob
	if err := windows.CryptProtectData(
		&input,
		nil,
		&entropy,
		0,
		nil,
		cryptProtectUIForbidden,
		&output,
	); err != nil {
		return nil, fmt.Errorf("Windows DPAPI protect: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, output.Size)...), nil
}

func unprotect(ciphertext []byte) ([]byte, error) {
	input := dataBlob(ciphertext)
	entropy := dataBlob(deviceKeyEntropy)
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(
		&input,
		nil,
		&entropy,
		0,
		nil,
		cryptProtectUIForbidden,
		&output,
	); err != nil {
		return nil, fmt.Errorf("Windows DPAPI unprotect: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, output.Size)...), nil
}

func dataBlob(data []byte) windows.DataBlob {
	if len(data) == 0 {
		return windows.DataBlob{}
	}
	return windows.DataBlob{Data: &data[0], Size: uint32(len(data))}
}
