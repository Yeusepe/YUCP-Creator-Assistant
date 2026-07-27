package main

import (
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/yucp/transfer-helper/internal/broker"
	"github.com/yucp/transfer-helper/internal/runtimecontract"
	"github.com/yucp/transfer-helper/internal/tufrepository"
)

const (
	brokerTargetName  = runtimecontract.BrokerTargetName
	helperTargetName  = runtimecontract.HelperTargetName
	runtimeTargetName = runtimecontract.RuntimeTargetName
	trustTargetName   = runtimecontract.TrustTargetName
)

type authority struct {
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

type trustTarget struct {
	MaterializationReceipt authority `json:"materializationReceipt"`
	PackageInstall         authority `json:"packageInstall"`
	SchemaVersion          int       `json:"schemaVersion"`
}

func main() {
	output := flag.String("output", "", "local TUF repository output directory")
	rootPath := flag.String("root", "", "pinned local TUF root path")
	helperPath := flag.String("helper", "", "source-built Windows helper executable")
	brokerPath := flag.String("broker", "", "source-built Windows package broker executable")
	apiBaseURL := flag.String("api-base-url", "", "local YUCP API base URL")
	authBaseURL := flag.String("auth-base-url", "", "local YUCP authorization base URL")
	metadataURL := flag.String("metadata-url", "", "local package TUF metadata URL")
	targetsURL := flag.String("targets-url", "", "local package TUF targets URL")
	metadataVersion := flag.Int64(
		"metadata-version",
		0,
		"monotonic local TUF metadata version",
	)
	installKeyID := flag.String("install-key-id", "", "package install signing key identifier")
	installPublicKey := flag.String("install-public-key", "", "package install Ed25519 public key")
	receiptKeyID := flag.String("receipt-key-id", "", "receipt signing key identifier")
	receiptPublicKey := flag.String("receipt-public-key", "", "receipt Ed25519 public key")
	flag.Parse()
	if flag.NArg() != 0 {
		fatal(fmt.Errorf("unexpected positional arguments"))
	}
	if err := generate(
		*output,
		*rootPath,
		*helperPath,
		*brokerPath,
		*metadataVersion,
		*installKeyID,
		*installPublicKey,
		*receiptKeyID,
		*receiptPublicKey,
		*apiBaseURL,
		*authBaseURL,
		*metadataURL,
		*targetsURL,
	); err != nil {
		fatal(err)
	}
}

func generate(
	output string,
	rootPath string,
	helperPath string,
	brokerPath string,
	metadataVersion int64,
	installKeyID string,
	installPublicKey string,
	receiptKeyID string,
	receiptPublicKey string,
	apiBaseURL string,
	authBaseURL string,
	metadataURL string,
	targetsURL string,
) error {
	if !filepath.IsAbs(output) ||
		!filepath.IsAbs(rootPath) ||
		!filepath.IsAbs(helperPath) ||
		!filepath.IsAbs(brokerPath) {
		return fmt.Errorf("local TUF output, root, helper, and broker paths must be absolute")
	}
	if metadataVersion < 1 {
		return fmt.Errorf("local TUF metadata version must be positive")
	}
	requiredValues := []struct {
		name  string
		value string
	}{
		{"install key identifier", installKeyID},
		{"install public key", installPublicKey},
		{"receipt key identifier", receiptKeyID},
		{"receipt public key", receiptPublicKey},
	}
	for _, required := range requiredValues {
		if required.value == "" {
			return fmt.Errorf("%s is required", required.name)
		}
	}
	publicKeys := []struct {
		name    string
		encoded string
	}{
		{"install public key", installPublicKey},
		{"receipt public key", receiptPublicKey},
	}
	for _, publicKey := range publicKeys {
		decoded, err := base64.RawURLEncoding.DecodeString(publicKey.encoded)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return fmt.Errorf("%s is invalid", publicKey.name)
		}
	}
	rootBytes, err := os.ReadFile(rootPath)
	if err != nil {
		return fmt.Errorf("read pinned local TUF root: %w", err)
	}
	targetBytes, err := json.Marshal(trustTarget{
		MaterializationReceipt: authority{
			KeyID:     receiptKeyID,
			PublicKey: receiptPublicKey,
		},
		PackageInstall: authority{
			KeyID:     installKeyID,
			PublicKey: installPublicKey,
		},
		SchemaVersion: 1,
	})
	if err != nil {
		return fmt.Errorf("encode local package trust target: %w", err)
	}
	helperBytes, err := os.ReadFile(helperPath)
	if err != nil {
		return fmt.Errorf("read source-built helper: %w", err)
	}
	if len(helperBytes) < 1 || len(helperBytes) > 256*1024*1024 {
		return fmt.Errorf("source-built helper length is invalid")
	}
	brokerBytes, err := os.ReadFile(brokerPath)
	if err != nil {
		return fmt.Errorf("read source-built package broker: %w", err)
	}
	if len(brokerBytes) < 1 || len(brokerBytes) > 256*1024*1024 {
		return fmt.Errorf("source-built package broker length is invalid")
	}
	runtimeBytes, err := runtimecontract.Marshal(runtimecontract.Config{
		APIBaseURL:  apiBaseURL,
		AuthBaseURL: authBaseURL,
		MetadataURL: metadataURL,
		PipeName:    broker.DefaultPipeName,
		TargetsURL:  targetsURL,
	})
	if err != nil {
		return fmt.Errorf("build local package runtime descriptor: %w", err)
	}
	snapshotSigner, err := deterministicLocalSigner(metadata.SNAPSHOT)
	if err != nil {
		return err
	}
	targetsSigner, err := deterministicLocalSigner(metadata.TARGETS)
	if err != nil {
		return err
	}
	timestampSigner, err := deterministicLocalSigner(metadata.TIMESTAMP)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	bundle, err := tufrepository.Build(tufrepository.Input{
		MetadataVersion: metadataVersion,
		Now:             now,
		Root:            rootBytes,
		Signers: tufrepository.OnlineSigners{
			Snapshot:  snapshotSigner,
			Targets:   targetsSigner,
			Timestamp: timestampSigner,
		},
		SnapshotExpires: now.Add(7 * 24 * time.Hour),
		Targets: []tufrepository.Target{
			{Bytes: brokerBytes, Name: brokerTargetName},
			{Bytes: helperBytes, Name: helperTargetName},
			{Bytes: runtimeBytes, Name: runtimeTargetName},
			{Bytes: targetBytes, Name: trustTargetName},
		},
		TargetsExpires:   now.Add(30 * 24 * time.Hour),
		TimestampExpires: now.Add(24 * time.Hour),
	})
	if err != nil {
		return fmt.Errorf("build local TUF repository: %w", err)
	}
	if bundle.RootVersion != 1 {
		return fmt.Errorf("pinned local TUF root is not the expected test root")
	}
	return bundle.Write(output)
}

func deterministicLocalSigner(role string) (signature.Signer, error) {
	seed := sha256.Sum256([]byte("YUCP transfer-helper TUF test key: " + role))
	signer, err := signature.LoadSigner(
		ed25519.NewKeyFromSeed(seed[:]),
		crypto.Hash(0),
	)
	if err != nil {
		return nil, fmt.Errorf("load local TUF %s signer: %w", role, err)
	}
	return signer, nil
}

func fatal(err error) {
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
