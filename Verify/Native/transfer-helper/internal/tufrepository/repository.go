package tufrepository

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const maxTargetBytes = 256 * 1024 * 1024

type OnlineSigners struct {
	Snapshot  signature.Signer
	Targets   signature.Signer
	Timestamp signature.Signer
}

type Target struct {
	Bytes []byte
	Name  string
}

type PublishedTarget struct {
	Bytes          []byte
	RepositoryPath string
	TargetName     string
}

type Input struct {
	MetadataVersion  int64
	Now              time.Time
	Root             []byte
	Signers          OnlineSigners
	SnapshotExpires  time.Time
	Targets          []Target
	TargetsExpires   time.Time
	TimestampExpires time.Time
}

type Bundle struct {
	MetadataVersion int64
	Root            []byte
	RootVersion     int64
	Snapshot        []byte
	Targets         []byte
	TargetFiles     []PublishedTarget
	Timestamp       []byte
}

func Build(input Input) (*Bundle, error) {
	if input.MetadataVersion < 1 {
		return nil, fmt.Errorf("TUF metadata version must be positive")
	}
	if input.Now.IsZero() {
		return nil, fmt.Errorf("TUF reference time is required")
	}
	now := input.Now.UTC()
	if len(input.Root) < 1 || len(input.Root) > 4*1024*1024 {
		return nil, fmt.Errorf("TUF root length is invalid")
	}
	var rootDecoder metadata.Metadata[metadata.RootType]
	root, err := rootDecoder.FromBytes(input.Root)
	if err != nil {
		return nil, fmt.Errorf("decode TUF root: %w", err)
	}
	if root.Signed.Version < 1 || !root.Signed.ConsistentSnapshot {
		return nil, fmt.Errorf("TUF root must enable consistent snapshots")
	}
	if err := root.VerifyDelegate(metadata.ROOT, root); err != nil {
		return nil, fmt.Errorf("verify TUF root threshold: %w", err)
	}
	if root.Signed.IsExpired(now) {
		return nil, fmt.Errorf("TUF root is expired")
	}
	if err := validateExpiries(input, root.Signed.Expires, now); err != nil {
		return nil, err
	}
	if input.Signers.Targets == nil ||
		input.Signers.Snapshot == nil ||
		input.Signers.Timestamp == nil {
		return nil, fmt.Errorf("all TUF online signers are required")
	}
	if len(input.Targets) < 1 || len(input.Targets) > 100_000 {
		return nil, fmt.Errorf("TUF target count is invalid")
	}

	targets := metadata.Targets(input.TargetsExpires.UTC())
	targets.Signed.Version = input.MetadataVersion
	publishedTargets := make([]PublishedTarget, 0, len(input.Targets))
	seen := make(map[string]struct{}, len(input.Targets))
	for _, target := range input.Targets {
		name, err := safeTargetName(target.Name)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[name]; exists {
			return nil, fmt.Errorf("TUF target name is duplicated: %s", name)
		}
		seen[name] = struct{}{}
		if len(target.Bytes) < 1 || len(target.Bytes) > maxTargetBytes {
			return nil, fmt.Errorf("TUF target length is invalid: %s", name)
		}
		targetInfo, err := metadata.TargetFile().FromBytes(
			name,
			target.Bytes,
			"sha256",
		)
		if err != nil {
			return nil, fmt.Errorf("describe TUF target %s: %w", name, err)
		}
		targets.Signed.Targets[name] = targetInfo
		digest := sha256.Sum256(target.Bytes)
		publishedTargets = append(publishedTargets, PublishedTarget{
			Bytes: append([]byte(nil), target.Bytes...),
			RepositoryPath: path.Join(
				path.Dir(name),
				hex.EncodeToString(digest[:])+"."+path.Base(name),
			),
			TargetName: name,
		})
	}
	if _, err := targets.Sign(input.Signers.Targets); err != nil {
		return nil, fmt.Errorf("sign TUF targets metadata: %w", err)
	}
	if err := root.VerifyDelegate(metadata.TARGETS, targets); err != nil {
		return nil, fmt.Errorf("verify TUF targets role: %w", err)
	}
	targetsBytes, err := targets.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("encode TUF targets metadata: %w", err)
	}

	snapshot := metadata.Snapshot(input.SnapshotExpires.UTC())
	snapshot.Signed.Version = input.MetadataVersion
	snapshot.Signed.Meta["targets.json"] = metaFile(input.MetadataVersion, targetsBytes)
	if _, err := snapshot.Sign(input.Signers.Snapshot); err != nil {
		return nil, fmt.Errorf("sign TUF snapshot metadata: %w", err)
	}
	if err := root.VerifyDelegate(metadata.SNAPSHOT, snapshot); err != nil {
		return nil, fmt.Errorf("verify TUF snapshot role: %w", err)
	}
	snapshotBytes, err := snapshot.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("encode TUF snapshot metadata: %w", err)
	}

	timestamp := metadata.Timestamp(input.TimestampExpires.UTC())
	timestamp.Signed.Version = input.MetadataVersion
	timestamp.Signed.Meta["snapshot.json"] = metaFile(input.MetadataVersion, snapshotBytes)
	if _, err := timestamp.Sign(input.Signers.Timestamp); err != nil {
		return nil, fmt.Errorf("sign TUF timestamp metadata: %w", err)
	}
	if err := root.VerifyDelegate(metadata.TIMESTAMP, timestamp); err != nil {
		return nil, fmt.Errorf("verify TUF timestamp role: %w", err)
	}
	timestampBytes, err := timestamp.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("encode TUF timestamp metadata: %w", err)
	}

	sort.Slice(publishedTargets, func(left, right int) bool {
		return publishedTargets[left].RepositoryPath <
			publishedTargets[right].RepositoryPath
	})
	return &Bundle{
		MetadataVersion: input.MetadataVersion,
		Root:            append([]byte(nil), input.Root...),
		RootVersion:     root.Signed.Version,
		Snapshot:        snapshotBytes,
		Targets:         targetsBytes,
		TargetFiles:     publishedTargets,
		Timestamp:       timestampBytes,
	}, nil
}

func (bundle *Bundle) Write(output string) error {
	if bundle == nil || !filepath.IsAbs(output) {
		return fmt.Errorf("TUF repository output must be absolute")
	}
	for _, target := range bundle.TargetFiles {
		if err := writeFile(
			filepath.Join(output, "targets", filepath.FromSlash(target.RepositoryPath)),
			target.Bytes,
		); err != nil {
			return err
		}
	}
	metadataRoot := filepath.Join(output, "metadata")
	orderedMetadata := []struct {
		bytes []byte
		name  string
	}{
		{bundle.Root, fmt.Sprintf("%d.root.json", bundle.RootVersion)},
		{bundle.Targets, fmt.Sprintf("%d.targets.json", bundle.MetadataVersion)},
		{bundle.Snapshot, fmt.Sprintf("%d.snapshot.json", bundle.MetadataVersion)},
		{bundle.Timestamp, "timestamp.json"},
	}
	for _, file := range orderedMetadata {
		if err := writeFile(filepath.Join(metadataRoot, file.name), file.bytes); err != nil {
			return err
		}
	}
	return nil
}

func metaFile(version int64, data []byte) *metadata.MetaFiles {
	digest := sha256.Sum256(data)
	return &metadata.MetaFiles{
		Hashes: metadata.Hashes{
			"sha256": digest[:],
		},
		Length:  int64(len(data)),
		Version: version,
	}
}

func safeTargetName(value string) (string, error) {
	if value == "" ||
		strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") ||
		strings.HasSuffix(value, "/") {
		return "", fmt.Errorf("TUF target name is invalid")
	}
	cleaned := path.Clean(value)
	if cleaned != value || cleaned == "." || cleaned == ".." ||
		strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("TUF target name is invalid")
	}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == "" || len(segment) > 256 {
			return "", fmt.Errorf("TUF target name is invalid")
		}
	}
	return cleaned, nil
}

func validateExpiries(input Input, rootExpires time.Time, now time.Time) error {
	targetsExpires := input.TargetsExpires.UTC()
	snapshotExpires := input.SnapshotExpires.UTC()
	timestampExpires := input.TimestampExpires.UTC()
	if !timestampExpires.After(now) ||
		!snapshotExpires.After(timestampExpires) ||
		!targetsExpires.After(snapshotExpires) ||
		rootExpires.Before(targetsExpires) {
		return fmt.Errorf("TUF metadata expiry order is invalid")
	}
	return nil
}

func writeFile(name string, data []byte) error {
	if len(data) < 1 {
		return fmt.Errorf("TUF repository file is empty")
	}
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		return fmt.Errorf("create TUF repository directory: %w", err)
	}
	temporary := name + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("write TUF repository temporary file: %w", err)
	}
	if err := os.Rename(temporary, name); err != nil {
		return fmt.Errorf("commit TUF repository file: %w", err)
	}
	return nil
}
