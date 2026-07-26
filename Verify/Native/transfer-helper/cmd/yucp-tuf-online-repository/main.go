package main

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/yucp/transfer-helper/internal/tufrepository"
	"github.com/yucp/transfer-helper/internal/tufroot"
)

const (
	maxManifestBytes = 4 * 1024 * 1024
	maxTargetBytes   = 256 * 1024 * 1024
)

type manifestTarget struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type targetManifest struct {
	SchemaVersion int              `json:"schemaVersion"`
	Targets       []manifestTarget `json:"targets"`
}

type result struct {
	MetadataVersion int64 `json:"metadataVersion"`
	RootVersion     int64 `json:"rootVersion"`
	SchemaVersion   int   `json:"schemaVersion"`
	TargetCount     int   `json:"targetCount"`
}

func main() {
	output := flag.String("output", "", "absolute repository output directory")
	rootPath := flag.String("root", "", "absolute signed offline root path")
	manifestPath := flag.String("targets-manifest", "", "absolute target manifest path")
	metadataVersion := flag.Int64("metadata-version", 0, "reserved metadata version")
	targetsExpires := flag.String("targets-expires", "", "targets expiry in RFC 3339")
	snapshotExpires := flag.String("snapshot-expires", "", "snapshot expiry in RFC 3339")
	timestampExpires := flag.String("timestamp-expires", "", "timestamp expiry in RFC 3339")
	flag.Parse()
	if flag.NArg() != 0 {
		fatal(fmt.Errorf("unexpected positional arguments"))
	}
	bundle, err := build(buildInput{
		ManifestPath:     *manifestPath,
		MetadataVersion:  *metadataVersion,
		Now:              time.Now().UTC(),
		Output:           *output,
		RootPath:         *rootPath,
		SnapshotExpires:  *snapshotExpires,
		TargetsExpires:   *targetsExpires,
		TimestampExpires: *timestampExpires,
	})
	if err != nil {
		fatal(err)
	}
	if err := bundle.Write(*output); err != nil {
		fatal(err)
	}
	encoded, err := json.Marshal(result{
		MetadataVersion: bundle.MetadataVersion,
		RootVersion:     bundle.RootVersion,
		SchemaVersion:   1,
		TargetCount:     len(bundle.TargetFiles),
	})
	if err != nil {
		fatal(fmt.Errorf("encode TUF publisher result: %w", err))
	}
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}

type buildInput struct {
	ManifestPath     string
	MetadataVersion  int64
	Now              time.Time
	Output           string
	RootPath         string
	SnapshotExpires  string
	TargetsExpires   string
	TimestampExpires string
}

func build(input buildInput) (*tufrepository.Bundle, error) {
	if !filepath.IsAbs(input.Output) ||
		!filepath.IsAbs(input.RootPath) ||
		!filepath.IsAbs(input.ManifestPath) {
		return nil, fmt.Errorf("TUF output, root, and target manifest paths must be absolute")
	}
	rootBytes, err := readBounded(input.RootPath, 4*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("read TUF root: %w", err)
	}
	if err := tufroot.Verify(rootBytes, input.Now); err != nil {
		return nil, fmt.Errorf("verify production TUF root: %w", err)
	}
	manifestBytes, err := readBounded(input.ManifestPath, maxManifestBytes)
	if err != nil {
		return nil, fmt.Errorf("read TUF target manifest: %w", err)
	}
	var manifest targetManifest
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decode TUF target manifest: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return nil, err
	}
	if manifest.SchemaVersion != 1 ||
		len(manifest.Targets) < 1 ||
		len(manifest.Targets) > 100_000 {
		return nil, fmt.Errorf("TUF target manifest is invalid")
	}
	targets := make([]tufrepository.Target, 0, len(manifest.Targets))
	for _, target := range manifest.Targets {
		if !filepath.IsAbs(target.Path) {
			return nil, fmt.Errorf("TUF target source path must be absolute")
		}
		body, err := readBounded(target.Path, maxTargetBytes)
		if err != nil {
			return nil, fmt.Errorf("read TUF target %s: %w", target.Name, err)
		}
		targets = append(targets, tufrepository.Target{
			Bytes: body,
			Name:  target.Name,
		})
	}
	targetsExpiry, err := parseExpiry(input.TargetsExpires, "targets")
	if err != nil {
		return nil, err
	}
	snapshotExpiry, err := parseExpiry(input.SnapshotExpires, "snapshot")
	if err != nil {
		return nil, err
	}
	timestampExpiry, err := parseExpiry(input.TimestampExpires, "timestamp")
	if err != nil {
		return nil, err
	}
	signers, err := onlineSigners(os.Getenv)
	if err != nil {
		return nil, err
	}
	return tufrepository.Build(tufrepository.Input{
		MetadataVersion:  input.MetadataVersion,
		Now:              input.Now,
		Root:             rootBytes,
		Signers:          signers,
		SnapshotExpires:  snapshotExpiry,
		Targets:          targets,
		TargetsExpires:   targetsExpiry,
		TimestampExpires: timestampExpiry,
	})
}

func onlineSigners(getenv func(string) string) (tufrepository.OnlineSigners, error) {
	load := func(role string, variable string) (signature.Signer, error) {
		encoded := getenv(variable)
		seed, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil ||
			len(seed) != ed25519.SeedSize ||
			base64.RawURLEncoding.EncodeToString(seed) != encoded {
			return nil, fmt.Errorf("%s must contain one canonical base64url Ed25519 seed", variable)
		}
		signer, err := signature.LoadSigner(ed25519.NewKeyFromSeed(seed), crypto.Hash(0))
		if err != nil {
			return nil, fmt.Errorf("load TUF %s signer: %w", role, err)
		}
		return signer, nil
	}
	targets, err := load(metadata.TARGETS, "YUCP_TUF_TARGETS_PRIVATE_KEY")
	if err != nil {
		return tufrepository.OnlineSigners{}, err
	}
	snapshot, err := load(metadata.SNAPSHOT, "YUCP_TUF_SNAPSHOT_PRIVATE_KEY")
	if err != nil {
		return tufrepository.OnlineSigners{}, err
	}
	timestamp, err := load(metadata.TIMESTAMP, "YUCP_TUF_TIMESTAMP_PRIVATE_KEY")
	if err != nil {
		return tufrepository.OnlineSigners{}, err
	}
	return tufrepository.OnlineSigners{
		Snapshot:  snapshot,
		Targets:   targets,
		Timestamp: timestamp,
	}, nil
}

func parseExpiry(value string, role string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("TUF %s expiry must use RFC 3339", role)
	}
	return parsed.UTC(), nil
}

func readBounded(name string, maximum int64) ([]byte, error) {
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	limited := io.LimitReader(file, maximum+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(body) < 1 || int64(len(body)) > maximum {
		return nil, fmt.Errorf("file length is invalid")
	}
	return body, nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("TUF target manifest has trailing data")
	}
	return nil
}

func fatal(err error) {
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
