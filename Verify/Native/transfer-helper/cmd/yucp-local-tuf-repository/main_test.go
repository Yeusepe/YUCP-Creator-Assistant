package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yucp/transfer-helper/internal/trust"
	"github.com/yucp/transfer-helper/internal/tufclient"
)

func TestGenerateCreatesUsableRepositoryForPinnedLocalRoot(t *testing.T) {
	rootPath, err := filepath.Abs(
		filepath.Join("..", "..", "internal", "tufclient", "testdata", "1.root.json"),
	)
	if err != nil {
		t.Fatalf("resolve pinned root: %v", err)
	}
	output := filepath.Join(t.TempDir(), "repository")
	helperPath := filepath.Join(t.TempDir(), "yucp-transfer-helper.exe")
	helperBytes := []byte("local trusted helper executable\n")
	if err := os.WriteFile(helperPath, helperBytes, 0o700); err != nil {
		t.Fatalf("write helper fixture: %v", err)
	}
	brokerPath := filepath.Join(t.TempDir(), "yucp-package-broker.exe")
	brokerBytes := []byte("local trusted package broker executable\n")
	if err := os.WriteFile(brokerPath, brokerBytes, 0o700); err != nil {
		t.Fatalf("write broker fixture: %v", err)
	}
	server := httptest.NewServer(http.FileServer(http.Dir(output)))
	defer server.Close()
	installKey := sha256.Sum256([]byte("install public key"))
	receiptKey := sha256.Sum256([]byte("receipt public key"))
	if err := generate(
		output,
		rootPath,
		helperPath,
		brokerPath,
		42,
		"install-key-1",
		base64.RawURLEncoding.EncodeToString(installKey[:]),
		"receipt-key-1",
		base64.RawURLEncoding.EncodeToString(receiptKey[:]),
		server.URL,
		server.URL,
		server.URL+"/metadata",
		server.URL+"/targets",
	); err != nil {
		t.Fatalf("generate() error = %v", err)
	}
	pinnedRoot, err := os.ReadFile(rootPath)
	if err != nil {
		t.Fatalf("read pinned root: %v", err)
	}
	generatedRoot, err := os.ReadFile(filepath.Join(output, "metadata", "1.root.json"))
	if err != nil {
		t.Fatalf("read generated root: %v", err)
	}
	if !bytes.Equal(pinnedRoot, generatedRoot) {
		t.Fatal("generated local repository changed the pinned root")
	}
	for _, name := range []string{"42.targets.json", "42.snapshot.json"} {
		if _, err := os.Stat(filepath.Join(output, "metadata", name)); err != nil {
			t.Fatalf("read versioned metadata %q: %v", name, err)
		}
	}
	destination := filepath.Join(t.TempDir(), trustTargetName)
	if _, err := tufclient.InstallTarget(tufclient.Config{
		LocalMetadataDir:  filepath.Join(t.TempDir(), "metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       pinnedRoot,
	}, trustTargetName, destination); err != nil {
		t.Fatalf("InstallTarget() error = %v", err)
	}
	targetEntries, err := os.ReadDir(filepath.Join(output, "targets"))
	if err != nil || len(targetEntries) != 4 {
		t.Fatalf("local TUF target roots = %v, error = %v", targetEntries, err)
	}
	var trustPath string
	for _, entry := range targetEntries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			trustPath = filepath.Join(output, "targets", entry.Name())
		}
	}
	if trustPath == "" {
		t.Fatal("generated repository has no trust target")
	}
	targetBytes, err := os.ReadFile(trustPath)
	if err != nil {
		t.Fatalf("read generated trust target: %v", err)
	}
	document, err := trust.Parse(targetBytes)
	if err != nil {
		t.Fatalf("trust.Parse() error = %v", err)
	}
	if string(document.PackageInstall.KeyID) != "install-key-1" ||
		string(document.MaterializationReceipt.KeyID) != "receipt-key-1" {
		t.Fatalf("generated trust document = %#v", document)
	}

	helperDestination := filepath.Join(t.TempDir(), "helper.exe")
	if _, err := tufclient.InstallTarget(tufclient.Config{
		LocalMetadataDir:  filepath.Join(t.TempDir(), "helper-metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       pinnedRoot,
	}, helperTargetName, helperDestination); err != nil {
		t.Fatalf("install helper target: %v", err)
	}
	installedHelper, err := os.ReadFile(helperDestination)
	if err != nil {
		t.Fatalf("read installed helper: %v", err)
	}
	if !bytes.Equal(installedHelper, helperBytes) {
		t.Fatal("installed helper differs from the TUF source helper")
	}

	brokerDestination := filepath.Join(t.TempDir(), "broker.exe")
	if _, err := tufclient.InstallTarget(tufclient.Config{
		LocalMetadataDir:  filepath.Join(t.TempDir(), "broker-metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       pinnedRoot,
	}, brokerTargetName, brokerDestination); err != nil {
		t.Fatalf("install broker target: %v", err)
	}
	installedBroker, err := os.ReadFile(brokerDestination)
	if err != nil {
		t.Fatalf("read installed broker: %v", err)
	}
	if !bytes.Equal(installedBroker, brokerBytes) {
		t.Fatal("installed broker differs from the TUF source broker")
	}

	runtimeDestination := filepath.Join(t.TempDir(), "package-runtime.json")
	if _, err := tufclient.InstallTarget(tufclient.Config{
		LocalMetadataDir:  filepath.Join(t.TempDir(), "runtime-metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       pinnedRoot,
	}, runtimeTargetName, runtimeDestination); err != nil {
		t.Fatalf("install runtime descriptor target: %v", err)
	}
	runtimeBytes, err := os.ReadFile(runtimeDestination)
	if err != nil {
		t.Fatalf("read runtime descriptor: %v", err)
	}
	var runtimeDescriptor map[string]any
	if err := json.Unmarshal(runtimeBytes, &runtimeDescriptor); err != nil {
		t.Fatalf("decode runtime descriptor: %v", err)
	}
	if runtimeDescriptor["brokerTarget"] != brokerTargetName ||
		runtimeDescriptor["helperTarget"] != helperTargetName ||
		runtimeDescriptor["metadataUrl"] != server.URL+"/metadata" ||
		runtimeDescriptor["targetsUrl"] != server.URL+"/targets" ||
		runtimeDescriptor["platform"] != "windows-amd64" {
		t.Fatalf("runtime descriptor = %#v", runtimeDescriptor)
	}
}
