package tufclient

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const testTargetName = "helper/windows-amd64/yucp-transfer-helper.exe"

type repositoryVersions struct {
	Snapshot  int64
	Targets   int64
	Timestamp int64
}

type repositoryFixture struct {
	Files      map[string][]byte
	Root       []byte
	TargetData []byte
}

type repositoryServer struct {
	files       map[string][]byte
	mu          sync.RWMutex
	targetReads atomic.Int64
}

type transientRepositoryServer struct {
	delegate  http.Handler
	failures  atomic.Int64
	requests  atomic.Int64
	traceSeen atomic.Bool
}

func (server *transientRepositoryServer) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	server.requests.Add(1)
	if request.Header.Get("traceparent") ==
		"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" {
		server.traceSeen.Store(true)
	}
	if server.failures.Add(-1) >= 0 {
		http.Error(
			response,
			"repository is temporarily unavailable",
			http.StatusServiceUnavailable,
		)
		return
	}
	server.delegate.ServeHTTP(response, request)
}

func TestInstallTargetDownloadsAndReusesVerifiedTarget(t *testing.T) {
	fixture := buildRepositoryFixture(t, repositoryVersions{1, 1, 1}, time.Now().Add(time.Hour))
	serverState := &repositoryServer{}
	serverState.setFiles(fixture.Files)
	server := httptest.NewServer(serverState)
	defer server.Close()

	root := t.TempDir()
	destination := filepath.Join(root, "versions", "1.0.0", "yucp-transfer-helper.exe")
	cfg := Config{
		LocalMetadataDir:  filepath.Join(root, "metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       fixture.Root,
	}

	result, err := InstallTarget(cfg, testTargetName, destination)
	if err != nil {
		t.Fatalf("InstallTarget() error = %v", err)
	}
	if result.Cached {
		t.Fatal("InstallTarget() reported a cache hit for the first download")
	}
	if result.Target != testTargetName {
		t.Fatalf("InstallTarget() target = %q, want %q", result.Target, testTargetName)
	}
	if result.ByteLength != int64(len(fixture.TargetData)) {
		t.Fatalf("InstallTarget() byte length = %d, want %d", result.ByteLength, len(fixture.TargetData))
	}
	wantDigest := sha256.Sum256(fixture.TargetData)
	if result.SHA256 != hex.EncodeToString(wantDigest[:]) {
		t.Fatalf("InstallTarget() SHA-256 = %q, want %x", result.SHA256, wantDigest)
	}
	installed, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(installed) != string(fixture.TargetData) {
		t.Fatal("installed helper bytes differ from the trusted target")
	}

	cached, err := InstallTarget(cfg, testTargetName, destination)
	if err != nil {
		t.Fatalf("cached InstallTarget() error = %v", err)
	}
	if !cached.Cached {
		t.Fatal("cached InstallTarget() did not report a cache hit")
	}
	if got := serverState.targetReads.Load(); got != 1 {
		t.Fatalf("target downloads = %d, want 1", got)
	}
}

func TestInstallTargetRetriesTransientRepositoryFailuresWithTraceContext(
	t *testing.T,
) {
	fixture := buildRepositoryFixture(
		t,
		repositoryVersions{1, 1, 1},
		time.Now().Add(time.Hour),
	)
	repository := &repositoryServer{}
	repository.setFiles(fixture.Files)
	transient := &transientRepositoryServer{
		delegate: repository,
	}
	transient.failures.Store(1)
	server := httptest.NewServer(transient)
	defer server.Close()

	root := t.TempDir()
	destination := filepath.Join(root, "versions", "retry", "helper.exe")
	result, err := InstallTarget(Config{
		LocalMetadataDir:  filepath.Join(root, "metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		Traceparent: "00-0123456789abcdef0123456789abcdef-" +
			"0123456789abcdef-01",
		TrustedRoot: fixture.Root,
	}, testTargetName, destination)
	if err != nil {
		t.Fatalf("InstallTarget() error = %v", err)
	}
	if result.Target != testTargetName {
		t.Fatalf("InstallTarget() target = %q, want %q", result.Target, testTargetName)
	}
	if transient.requests.Load() < 2 {
		t.Fatalf(
			"repository requests = %d, want a retry",
			transient.requests.Load(),
		)
	}
	if !transient.traceSeen.Load() {
		t.Fatal("repository request did not preserve traceparent")
	}
}

func TestInstallTargetAtomicallyReplacesAStaleTrustedTarget(t *testing.T) {
	first := buildRepositoryFixtureWithTarget(
		t,
		repositoryVersions{1, 1, 1},
		time.Now().Add(time.Hour),
		[]byte("first trusted helper\n"),
	)
	second := buildRepositoryFixtureWithTarget(
		t,
		repositoryVersions{2, 2, 2},
		time.Now().Add(time.Hour),
		[]byte("second trusted helper\n"),
	)
	serverState := &repositoryServer{}
	serverState.setFiles(first.Files)
	server := httptest.NewServer(serverState)
	defer server.Close()

	root := t.TempDir()
	destination := filepath.Join(root, "current", "yucp-transfer-helper.exe")
	cfg := Config{
		LocalMetadataDir:  filepath.Join(root, "metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       first.Root,
	}
	if _, err := InstallTarget(cfg, testTargetName, destination); err != nil {
		t.Fatalf("initial InstallTarget() error = %v", err)
	}

	serverState.setFiles(second.Files)
	result, err := InstallTarget(cfg, testTargetName, destination)
	if err != nil {
		t.Fatalf("updated InstallTarget() error = %v", err)
	}
	if result.Cached {
		t.Fatal("updated InstallTarget() reported a cache hit")
	}
	installed, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if !bytes.Equal(installed, second.TargetData) {
		t.Fatal("installed helper bytes differ from the updated trusted target")
	}
	if got := serverState.targetReads.Load(); got != 2 {
		t.Fatalf("target downloads = %d, want 2", got)
	}
}

func TestInstallTargetRejectsMetadataRollback(t *testing.T) {
	current := buildRepositoryFixture(t, repositoryVersions{2, 2, 2}, time.Now().Add(time.Hour))
	rollback := buildRepositoryFixture(t, repositoryVersions{1, 1, 1}, time.Now().Add(time.Hour))
	serverState := &repositoryServer{}
	serverState.setFiles(current.Files)
	server := httptest.NewServer(serverState)
	defer server.Close()

	root := t.TempDir()
	cfg := Config{
		LocalMetadataDir:  filepath.Join(root, "metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       current.Root,
	}
	if _, err := InstallTarget(
		cfg,
		testTargetName,
		filepath.Join(root, "versions", "2.0.0", "yucp-transfer-helper.exe"),
	); err != nil {
		t.Fatalf("initial InstallTarget() error = %v", err)
	}

	serverState.setFiles(rollback.Files)
	_, err := InstallTarget(
		cfg,
		testTargetName,
		filepath.Join(root, "versions", "1.0.0", "yucp-transfer-helper.exe"),
	)
	if err == nil {
		t.Fatal("InstallTarget() accepted rolled-back metadata")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "version") {
		t.Fatalf("rollback error = %q, want a version failure", err)
	}
}

func TestInstallTargetRejectsExpiredMetadata(t *testing.T) {
	fixture := buildRepositoryFixture(t, repositoryVersions{1, 1, 1}, time.Now().Add(-time.Hour))
	server := httptest.NewServer(&repositoryServer{files: fixture.Files})
	defer server.Close()

	root := t.TempDir()
	_, err := InstallTarget(Config{
		LocalMetadataDir:  filepath.Join(root, "metadata"),
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		TrustedRoot:       fixture.Root,
	}, testTargetName, filepath.Join(root, "versions", "expired", "helper.exe"))
	if err == nil {
		t.Fatal("InstallTarget() accepted expired metadata")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "expired") {
		t.Fatalf("freeze error = %q, want an expiration failure", err)
	}
}

func TestInstallTargetRejectsUnsafeOriginsAndTargetPaths(t *testing.T) {
	fixture := buildRepositoryFixture(t, repositoryVersions{1, 1, 1}, time.Now().Add(time.Hour))
	root := t.TempDir()
	base := Config{
		LocalMetadataDir:  filepath.Join(root, "metadata"),
		RemoteMetadataURL: "http://packages.example.test/metadata",
		RemoteTargetsURL:  "https://packages.example.test/targets",
		TrustedRoot:       fixture.Root,
	}
	if _, err := InstallTarget(base, testTargetName, filepath.Join(root, "helper.exe")); err == nil {
		t.Fatal("InstallTarget() accepted non-loopback HTTP")
	}

	base.RemoteMetadataURL = "https://packages.example.test/metadata"
	if _, err := InstallTarget(base, "../helper.exe", filepath.Join(root, "helper.exe")); err == nil {
		t.Fatal("InstallTarget() accepted a repository path escape")
	}
}

func TestPinnedRootFixtureMatchesGeneratedTrustRoot(t *testing.T) {
	fixture := buildRepositoryFixture(t, repositoryVersions{1, 1, 1}, time.Now().Add(time.Hour))
	pinned, err := os.ReadFile(filepath.Join("testdata", "1.root.json"))
	if err != nil {
		t.Fatalf("read pinned TUF root: %v\ngenerated root: %s", err, fixture.Root)
	}
	if !bytes.Equal(bytes.TrimSpace(pinned), fixture.Root) {
		t.Fatalf("pinned TUF root differs from the generated trust root\ngenerated root: %s", fixture.Root)
	}
}

func (server *repositoryServer) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.mu.RLock()
	data, ok := server.files[request.URL.Path]
	server.mu.RUnlock()
	if !ok {
		http.NotFound(response, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/targets/") {
		server.targetReads.Add(1)
	}
	response.Header().Set("Content-Type", "application/octet-stream")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(data)
}

func (server *repositoryServer) setFiles(files map[string][]byte) {
	copyOfFiles := make(map[string][]byte, len(files))
	for name, data := range files {
		copyOfFiles[name] = append([]byte(nil), data...)
	}
	server.mu.Lock()
	server.files = copyOfFiles
	server.mu.Unlock()
}

func buildRepositoryFixture(
	t *testing.T,
	versions repositoryVersions,
	roleExpiry time.Time,
) repositoryFixture {
	return buildRepositoryFixtureWithTarget(
		t,
		versions,
		roleExpiry,
		[]byte("verified YUCP transfer helper test executable\n"),
	)
}

func buildRepositoryFixtureWithTarget(
	t *testing.T,
	versions repositoryVersions,
	roleExpiry time.Time,
	targetData []byte,
) repositoryFixture {
	t.Helper()

	rootExpiry := time.Date(2037, time.January, 1, 0, 0, 0, 0, time.UTC)
	root := metadata.Root(rootExpiry)
	root.Signed.ConsistentSnapshot = true
	root.Signed.Version = 1

	privateKeys := map[string]ed25519.PrivateKey{}
	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		privateKey := deterministicTestKey(role)
		privateKeys[role] = privateKey
		publicKey, err := metadata.KeyFromPublicKey(privateKey.Public())
		if err != nil {
			t.Fatalf("KeyFromPublicKey(%s) error = %v", role, err)
		}
		if err := root.Signed.AddKey(publicKey, role); err != nil {
			t.Fatalf("AddKey(%s) error = %v", role, err)
		}
	}

	targetInfo, err := metadata.TargetFile().FromBytes(testTargetName, targetData, "sha256")
	if err != nil {
		t.Fatalf("TargetFile().FromBytes() error = %v", err)
	}
	targets := metadata.Targets(roleExpiry)
	targets.Signed.Version = versions.Targets
	targets.Signed.Targets[testTargetName] = targetInfo

	snapshot := metadata.Snapshot(roleExpiry)
	snapshot.Signed.Version = versions.Snapshot
	snapshot.Signed.Meta["targets.json"] = metadata.MetaFile(versions.Targets)

	timestamp := metadata.Timestamp(roleExpiry)
	timestamp.Signed.Version = versions.Timestamp
	timestamp.Signed.Meta["snapshot.json"] = metadata.MetaFile(versions.Snapshot)

	signMetadata(t, metadata.ROOT, root, privateKeys[metadata.ROOT])
	signMetadata(t, metadata.TARGETS, targets, privateKeys[metadata.TARGETS])
	signMetadata(t, metadata.SNAPSHOT, snapshot, privateKeys[metadata.SNAPSHOT])
	signMetadata(t, metadata.TIMESTAMP, timestamp, privateKeys[metadata.TIMESTAMP])

	rootBytes := metadataBytes(t, root)
	targetsBytes := metadataBytes(t, targets)
	snapshotBytes := metadataBytes(t, snapshot)
	timestampBytes := metadataBytes(t, timestamp)
	targetDigest := sha256.Sum256(targetData)
	targetDirectory := strings.TrimSuffix(testTargetName, filepath.Base(testTargetName))
	targetRemoteName := fmt.Sprintf(
		"%s%s.%s",
		targetDirectory,
		hex.EncodeToString(targetDigest[:]),
		filepath.Base(testTargetName),
	)

	return repositoryFixture{
		Files: map[string][]byte{
			"/metadata/1.root.json": rootBytes,
			fmt.Sprintf("/metadata/%d.snapshot.json", versions.Snapshot): snapshotBytes,
			fmt.Sprintf("/metadata/%d.targets.json", versions.Targets):   targetsBytes,
			"/metadata/timestamp.json":                                   timestampBytes,
			"/targets/" + targetRemoteName:                               targetData,
		},
		Root:       rootBytes,
		TargetData: targetData,
	}
}

func deterministicTestKey(role string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("YUCP transfer-helper TUF test key: " + role))
	return ed25519.NewKeyFromSeed(seed[:])
}

func signMetadata[T metadata.Roles](
	t *testing.T,
	role string,
	value *metadata.Metadata[T],
	privateKey ed25519.PrivateKey,
) {
	t.Helper()
	signer, err := signature.LoadSigner(privateKey, crypto.Hash(0))
	if err != nil {
		t.Fatalf("LoadSigner(%s) error = %v", role, err)
	}
	if _, err := value.Sign(signer); err != nil {
		t.Fatalf("Sign(%s) error = %v", role, err)
	}
}

func metadataBytes[T metadata.Roles](t *testing.T, value *metadata.Metadata[T]) []byte {
	t.Helper()
	data, err := value.ToBytes(false)
	if err != nil {
		t.Fatalf("ToBytes() error = %v", err)
	}
	return data
}
