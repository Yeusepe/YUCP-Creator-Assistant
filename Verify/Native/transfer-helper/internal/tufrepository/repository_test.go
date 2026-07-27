package tufrepository

import (
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func TestBuildVerifiesOnlineRolesAndBindsMetadataBytes(t *testing.T) {
	rootBytes, err := os.ReadFile(
		filepath.Join("..", "tufclient", "testdata", "1.root.json"),
	)
	if err != nil {
		t.Fatalf("read test root: %v", err)
	}
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	bundle, err := Build(Input{
		MetadataVersion: 7,
		Now:             now,
		Root:            rootBytes,
		Signers:         localSigners(t),
		SnapshotExpires: now.Add(7 * 24 * time.Hour),
		Targets: []Target{{
			Bytes: []byte("trusted helper bytes"),
			Name:  "helper/windows-amd64/yucp-transfer-helper.exe",
		}},
		TargetsExpires:   now.Add(30 * 24 * time.Hour),
		TimestampExpires: now.Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if bundle.MetadataVersion != 7 || bundle.RootVersion != 1 {
		t.Fatalf(
			"bundle versions = root %d, metadata %d",
			bundle.RootVersion,
			bundle.MetadataVersion,
		)
	}
	var snapshot metadata.Metadata[metadata.SnapshotType]
	parsedSnapshot, err := snapshot.FromBytes(bundle.Snapshot)
	if err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	targetsReference := parsedSnapshot.Signed.Meta["targets.json"]
	if targetsReference == nil {
		t.Fatal("snapshot omitted targets metadata")
	}
	if err := targetsReference.VerifyLengthHashes(bundle.Targets); err != nil {
		t.Fatalf("snapshot targets binding: %v", err)
	}
	var timestamp metadata.Metadata[metadata.TimestampType]
	parsedTimestamp, err := timestamp.FromBytes(bundle.Timestamp)
	if err != nil {
		t.Fatalf("decode timestamp: %v", err)
	}
	snapshotReference := parsedTimestamp.Signed.Meta["snapshot.json"]
	if snapshotReference == nil {
		t.Fatal("timestamp omitted snapshot metadata")
	}
	if err := snapshotReference.VerifyLengthHashes(bundle.Snapshot); err != nil {
		t.Fatalf("timestamp snapshot binding: %v", err)
	}
}

func TestBuildRejectsAnOnlineKeyOutsideTheOfflineRoot(t *testing.T) {
	rootBytes, err := os.ReadFile(
		filepath.Join("..", "tufclient", "testdata", "1.root.json"),
	)
	if err != nil {
		t.Fatalf("read test root: %v", err)
	}
	signers := localSigners(t)
	untrustedSeed := sha256.Sum256([]byte("untrusted targets key"))
	untrusted, err := signature.LoadSigner(
		ed25519.NewKeyFromSeed(untrustedSeed[:]),
		crypto.Hash(0),
	)
	if err != nil {
		t.Fatalf("load untrusted signer: %v", err)
	}
	signers.Targets = untrusted
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	if _, err := Build(Input{
		MetadataVersion: 2,
		Now:             now,
		Root:            rootBytes,
		Signers:         signers,
		SnapshotExpires: now.Add(7 * 24 * time.Hour),
		Targets: []Target{{
			Bytes: []byte("helper"),
			Name:  "helper/windows-amd64/yucp-transfer-helper.exe",
		}},
		TargetsExpires:   now.Add(30 * 24 * time.Hour),
		TimestampExpires: now.Add(24 * time.Hour),
	}); err == nil {
		t.Fatal("Build() accepted an untrusted targets key")
	}
}

func localSigners(t *testing.T) OnlineSigners {
	t.Helper()
	load := func(role string) signature.Signer {
		seed := sha256.Sum256([]byte("YUCP transfer-helper TUF test key: " + role))
		signer, err := signature.LoadSigner(
			ed25519.NewKeyFromSeed(seed[:]),
			crypto.Hash(0),
		)
		if err != nil {
			t.Fatalf("load %s signer: %v", role, err)
		}
		return signer
	}
	return OnlineSigners{
		Snapshot:  load(metadata.SNAPSHOT),
		Targets:   load(metadata.TARGETS),
		Timestamp: load(metadata.TIMESTAMP),
	}
}
