package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/yucp/transfer-helper/internal/tufroot"
)

const maxCeremonyFileBytes = 4 * 1024 * 1024

type commandResult struct {
	Complete      bool   `json:"complete"`
	Operation     string `json:"operation"`
	RootVersion   int64  `json:"rootVersion"`
	SchemaVersion int    `json:"schemaVersion"`
}

func main() {
	if err := run(os.Args[1:], os.Getenv, os.Stdout, time.Now().UTC()); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(
	args []string,
	getenv func(string) string,
	stdout io.Writer,
	now time.Time,
) error {
	if len(args) < 1 {
		return fmt.Errorf("TUF root operation is required")
	}
	switch args[0] {
	case "create":
		flags := flag.NewFlagSet("create", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		manifestPath := flags.String("manifest", "", "absolute public root manifest path")
		outputPath := flags.String("output", "", "absolute unsigned root output path")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
			return fmt.Errorf("TUF root create arguments are invalid")
		}
		if err := requireAbsolute(*manifestPath, *outputPath); err != nil {
			return err
		}
		manifestBytes, err := readBounded(*manifestPath)
		if err != nil {
			return fmt.Errorf("read TUF root manifest: %w", err)
		}
		var manifest tufroot.Manifest
		decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&manifest); err != nil {
			return fmt.Errorf("decode TUF root manifest: %w", err)
		}
		if err := requireJSONEnd(decoder); err != nil {
			return err
		}
		rootBytes, err := tufroot.Create(manifest, now)
		if err != nil {
			return err
		}
		if err := writeNew(*outputPath, rootBytes); err != nil {
			return err
		}
		return writeResult(stdout, commandResult{
			Complete:      false,
			Operation:     "create",
			RootVersion:   manifest.Version,
			SchemaVersion: 1,
		})
	case "sign":
		flags := flag.NewFlagSet("sign", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		rootPath := flags.String("root", "", "absolute input root path")
		outputPath := flags.String("output", "", "absolute signed root output path")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
			return fmt.Errorf("TUF root sign arguments are invalid")
		}
		if err := requireAbsolute(*rootPath, *outputPath); err != nil {
			return err
		}
		rootBytes, err := readBounded(*rootPath)
		if err != nil {
			return fmt.Errorf("read TUF root: %w", err)
		}
		seed, err := readSeed(getenv("YUCP_TUF_ROOT_PRIVATE_KEY"))
		if err != nil {
			return err
		}
		signed, complete, err := tufroot.AddSignature(rootBytes, seed, now)
		if err != nil {
			return err
		}
		if err := writeNew(*outputPath, signed); err != nil {
			return err
		}
		version, err := rootVersion(signed)
		if err != nil {
			return err
		}
		return writeResult(stdout, commandResult{
			Complete:      complete,
			Operation:     "sign",
			RootVersion:   version,
			SchemaVersion: 1,
		})
	case "verify":
		flags := flag.NewFlagSet("verify", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		rootPath := flags.String("root", "", "absolute signed root path")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
			return fmt.Errorf("TUF root verify arguments are invalid")
		}
		if err := requireAbsolute(*rootPath); err != nil {
			return err
		}
		rootBytes, err := readBounded(*rootPath)
		if err != nil {
			return fmt.Errorf("read TUF root: %w", err)
		}
		if err := tufroot.Verify(rootBytes, now); err != nil {
			return err
		}
		version, err := rootVersion(rootBytes)
		if err != nil {
			return err
		}
		return writeResult(stdout, commandResult{
			Complete:      true,
			Operation:     "verify",
			RootVersion:   version,
			SchemaVersion: 1,
		})
	default:
		return fmt.Errorf("TUF root operation is invalid")
	}
}

func requireAbsolute(values ...string) error {
	for _, value := range values {
		if value == "" || !filepath.IsAbs(value) {
			return fmt.Errorf("TUF root paths must be absolute")
		}
	}
	return nil
}

func readBounded(name string) ([]byte, error) {
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxCeremonyFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) < 1 || len(body) > maxCeremonyFileBytes {
		return nil, fmt.Errorf("TUF ceremony file length is invalid")
	}
	return body, nil
}

func readSeed(encoded string) ([]byte, error) {
	seed, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil ||
		len(seed) != 32 ||
		base64.RawURLEncoding.EncodeToString(seed) != encoded {
		return nil, fmt.Errorf(
			"YUCP_TUF_ROOT_PRIVATE_KEY must contain one canonical base64url Ed25519 seed",
		)
	}
	return seed, nil
}

func rootVersion(rootBytes []byte) (int64, error) {
	var decoder metadata.Metadata[metadata.RootType]
	root, err := decoder.FromBytes(rootBytes)
	if err != nil {
		return 0, fmt.Errorf("decode TUF root result: %w", err)
	}
	return root.Signed.Version, nil
}

func writeNew(name string, body []byte) error {
	directory := filepath.Dir(name)
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("TUF root output directory does not exist")
	}
	temporary, err := os.CreateTemp(directory, ".yucp-tuf-root-*.tmp")
	if err != nil {
		return fmt.Errorf("create TUF root temporary file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure TUF root temporary file: %w", err)
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write TUF root temporary file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("flush TUF root temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close TUF root temporary file: %w", err)
	}
	if err := os.Link(temporaryName, name); err != nil {
		return fmt.Errorf("commit new TUF root file: %w", err)
	}
	if runtime.GOOS != "windows" {
		directoryHandle, err := os.Open(directory)
		if err != nil {
			return fmt.Errorf("open TUF root output directory: %w", err)
		}
		defer directoryHandle.Close()
		if err := directoryHandle.Sync(); err != nil {
			return fmt.Errorf("flush TUF root output directory: %w", err)
		}
	}
	return nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("TUF root manifest has trailing data")
	}
	return nil
}

func writeResult(output io.Writer, result commandResult) error {
	encoder := json.NewEncoder(output)
	if err := encoder.Encode(result); err != nil {
		return fmt.Errorf("write TUF root command result: %w", err)
	}
	return nil
}
