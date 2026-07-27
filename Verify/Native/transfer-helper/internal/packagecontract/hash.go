package packagecontract

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"regexp"
)

var hashPurposePattern = regexp.MustCompile(`^yucp:[a-z0-9-]+:v[0-9]+$`)

func DomainHash(purpose string, fields ...[]byte) ([sha256.Size]byte, error) {
	hasher, err := newDomainHasher(purpose)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	for _, field := range fields {
		if err := writeFieldLength(hasher, uint64(len(field))); err != nil {
			return [sha256.Size]byte{}, err
		}
		if _, err := hasher.Write(field); err != nil {
			return [sha256.Size]byte{}, fmt.Errorf("hash package field: %w", err)
		}
	}
	var result [sha256.Size]byte
	copy(result[:], hasher.Sum(nil))
	return result, nil
}

func NewSingleFieldHasher(purpose string, fieldLength uint64) (hash.Hash, error) {
	hasher, err := newDomainHasher(purpose)
	if err != nil {
		return nil, err
	}
	if err := writeFieldLength(hasher, fieldLength); err != nil {
		return nil, err
	}
	return hasher, nil
}

func newDomainHasher(purpose string) (hash.Hash, error) {
	if !hashPurposePattern.MatchString(purpose) {
		return nil, fmt.Errorf("package hash purpose must be a versioned ASCII YUCP purpose")
	}
	hasher := sha256.New()
	if _, err := hasher.Write([]byte(purpose)); err != nil {
		return nil, fmt.Errorf("hash package purpose: %w", err)
	}
	return hasher, nil
}

func writeFieldLength(hasher hash.Hash, length uint64) error {
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], length)
	if _, err := hasher.Write(encoded[:]); err != nil {
		return fmt.Errorf("hash package field length: %w", err)
	}
	return nil
}
