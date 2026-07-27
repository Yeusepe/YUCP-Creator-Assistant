//go:build windows

package securedata

import (
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const cryptProtectUIForbidden = 0x1

func Protect(plaintext []byte, purpose string) ([]byte, error) {
	entropy, err := purposeEntropy(purpose)
	if err != nil {
		return nil, err
	}
	input := dataBlob(plaintext)
	entropyBlob := dataBlob(entropy)
	var output windows.DataBlob
	if err := windows.CryptProtectData(
		&input,
		nil,
		&entropyBlob,
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

func Unprotect(ciphertext []byte, purpose string) ([]byte, error) {
	entropy, err := purposeEntropy(purpose)
	if err != nil {
		return nil, err
	}
	input := dataBlob(ciphertext)
	entropyBlob := dataBlob(entropy)
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(
		&input,
		nil,
		&entropyBlob,
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

func purposeEntropy(purpose string) ([]byte, error) {
	purpose = strings.TrimSpace(purpose)
	if len(purpose) < 8 || len(purpose) > 128 || strings.ContainsAny(purpose, "\x00\r\n") {
		return nil, fmt.Errorf("secure-data purpose is invalid")
	}
	return []byte("YUCP secure data\x00" + purpose), nil
}

func dataBlob(data []byte) windows.DataBlob {
	if len(data) == 0 {
		return windows.DataBlob{}
	}
	return windows.DataBlob{Data: &data[0], Size: uint32(len(data))}
}
