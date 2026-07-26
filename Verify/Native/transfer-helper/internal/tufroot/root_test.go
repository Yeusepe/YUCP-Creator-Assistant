package tufroot

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func TestRootCeremonyRequiresTwoDistinctOfflineSignatures(t *testing.T) {
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	rootSeeds := [][]byte{
		testSeed("root-1"),
		testSeed("root-2"),
		testSeed("root-3"),
	}
	unsigned, err := Create(Manifest{
		Expires:            now.Add(365 * 24 * time.Hour).Format(time.RFC3339),
		RootPublicKeys:     publicKeys(rootSeeds),
		RootThreshold:      2,
		SchemaVersion:      1,
		SnapshotPublicKey:  publicKey(testSeed("snapshot")),
		TargetsPublicKey:   publicKey(testSeed("targets")),
		TimestampPublicKey: publicKey(testSeed("timestamp")),
		Version:            1,
	}, now)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := Verify(unsigned, now); err == nil {
		t.Fatal("Verify() accepted an unsigned root")
	}

	once, complete, err := AddSignature(unsigned, rootSeeds[0], now)
	if err != nil {
		t.Fatalf("first AddSignature() error = %v", err)
	}
	if complete {
		t.Fatal("one root signature satisfied a two-signature threshold")
	}
	if err := Verify(once, now); err == nil {
		t.Fatal("Verify() accepted one root signature")
	}

	twice, complete, err := AddSignature(once, rootSeeds[1], now)
	if err != nil {
		t.Fatalf("second AddSignature() error = %v", err)
	}
	if !complete {
		t.Fatal("two distinct root signatures did not satisfy the threshold")
	}
	if err := Verify(twice, now); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}

	var decoder metadata.Metadata[metadata.RootType]
	root, err := decoder.FromBytes(twice)
	if err != nil {
		t.Fatalf("decode root: %v", err)
	}
	if root.Signed.Roles[metadata.ROOT].Threshold != 2 {
		t.Fatalf("root threshold = %d, want 2", root.Signed.Roles[metadata.ROOT].Threshold)
	}
	if len(root.Signed.Roles[metadata.ROOT].KeyIDs) != 3 {
		t.Fatalf("root key count = %d, want 3", len(root.Signed.Roles[metadata.ROOT].KeyIDs))
	}
}

func TestRootCeremonyRejectsAnUnlistedSignerAndDuplicateRoleKeys(t *testing.T) {
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	rootSeeds := [][]byte{
		testSeed("root-1"),
		testSeed("root-2"),
		testSeed("root-3"),
	}
	manifest := Manifest{
		Expires:            now.Add(365 * 24 * time.Hour).Format(time.RFC3339),
		RootPublicKeys:     publicKeys(rootSeeds),
		RootThreshold:      2,
		SchemaVersion:      1,
		SnapshotPublicKey:  publicKey(testSeed("snapshot")),
		TargetsPublicKey:   publicKey(testSeed("targets")),
		TimestampPublicKey: publicKey(testSeed("timestamp")),
		Version:            1,
	}
	unsigned, err := Create(manifest, now)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, _, err := AddSignature(unsigned, testSeed("unlisted"), now); err == nil {
		t.Fatal("AddSignature() accepted an unlisted root key")
	}

	manifest.TimestampPublicKey = manifest.TargetsPublicKey
	if _, err := Create(manifest, now); err == nil {
		t.Fatal("Create() accepted one key for two online roles")
	}
}

func publicKeys(seeds [][]byte) []string {
	keys := make([]string, 0, len(seeds))
	for _, seed := range seeds {
		keys = append(keys, publicKey(seed))
	}
	return keys
}

func publicKey(seed []byte) string {
	value := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	return base64.RawURLEncoding.EncodeToString(value)
}

func testSeed(name string) []byte {
	value := sha256.Sum256([]byte("YUCP TUF root ceremony test key: " + name))
	return value[:]
}
