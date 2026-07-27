package packagecontract

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type goldenVector struct {
	CoseSign1Hex string `json:"coseSign1Hex"`
	KeyIDHex     string `json:"keyIdHex"`
	PayloadHex   string `json:"payloadHex"`
	PublicKeyHex string `json:"publicKeyHex"`
	Purpose      string `json:"purpose"`
}

type sharedGoldenVectors struct {
	KeyIDHex     string         `json:"keyIdHex"`
	PublicKeyHex string         `json:"publicKeyHex"`
	Vectors      []goldenVector `json:"vectors"`
}

func TestDomainHashMatchesTypeScriptGoldenValue(t *testing.T) {
	digest, err := DomainHash("yucp:chunk:v2", []byte("abc"))
	if err != nil {
		t.Fatalf("DomainHash() error = %v", err)
	}
	if got, want := hex.EncodeToString(digest[:]), "55667f9928396d23fe784fdaee6e73c5317d775214d770878e7f7d623214db3a"; got != want {
		t.Fatalf("DomainHash() = %s, want %s", got, want)
	}
	if _, err := DomainHash("chunk", []byte("abc")); err == nil {
		t.Fatal("DomainHash() accepted an unversioned purpose")
	}
}

func TestGoldenFileTableShardVerifiesAndParses(t *testing.T) {
	vector := readGoldenVector(t)
	envelope := decodeHex(t, vector.CoseSign1Hex)
	publicKey := ed25519.PublicKey(decodeHex(t, vector.PublicKeyHex))
	keyID := decodeHex(t, vector.KeyIDHex)

	payload, err := VerifySign1(envelope, publicKey, keyID, FileTableShardPurpose)
	if err != nil {
		t.Fatalf("VerifySign1() error = %v", err)
	}
	if got := hex.EncodeToString(payload); got != strings.ToLower(vector.PayloadHex) {
		t.Fatalf("verified payload = %s, want %s", got, vector.PayloadHex)
	}
	shard, err := ParseFileTableShard(payload)
	if err != nil {
		t.Fatalf("ParseFileTableShard() error = %v", err)
	}
	if len(shard.Files) != 1 || shard.Files[0].Path != "Assets/Product/shader.shader" {
		t.Fatalf("parsed shard files = %#v", shard.Files)
	}
	if got := shard.Files[0].Chunks[0].EncodedLength; got != 65_536 {
		t.Fatalf("encoded chunk length = %d, want 65536", got)
	}
}

func TestSign1RejectsCrossPurposeAndNoncanonicalCBOR(t *testing.T) {
	vector := readGoldenVector(t)
	envelope := decodeHex(t, vector.CoseSign1Hex)
	publicKey := ed25519.PublicKey(decodeHex(t, vector.PublicKeyHex))
	keyID := decodeHex(t, vector.KeyIDHex)
	if _, err := VerifySign1(envelope, publicKey, keyID, "delivery-grant-v2"); err == nil {
		t.Fatal("VerifySign1() accepted a cross-purpose signature")
	}
	if _, err := DecodeCanonical([]byte{0x18, 0x01}); err == nil {
		t.Fatal("DecodeCanonical() accepted a noncanonical integer")
	}
}

func TestGoldenPackageOperationCapabilityVerifiesAndParses(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "..",
		"ops", "storage-core", "fixtures", "package-contracts-v2.json",
	))
	if err != nil {
		t.Fatalf("read shared golden vectors: %v", err)
	}
	var fixture sharedGoldenVectors
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode shared golden vectors: %v", err)
	}
	var vector *goldenVector
	for index := range fixture.Vectors {
		if fixture.Vectors[index].Purpose == PackageOperationCapabilityPurpose {
			vector = &fixture.Vectors[index]
			break
		}
	}
	if vector == nil {
		t.Fatal("shared golden vectors do not contain a package operation capability")
	}
	payload, err := VerifySign1(
		decodeHex(t, vector.CoseSign1Hex),
		ed25519.PublicKey(decodeHex(t, fixture.PublicKeyHex)),
		decodeHex(t, fixture.KeyIDHex),
		PackageOperationCapabilityPurpose,
	)
	if err != nil {
		t.Fatalf("VerifySign1() error = %v", err)
	}
	capability, err := ParsePackageOperationCapability(payload)
	if err != nil {
		t.Fatalf("ParsePackageOperationCapability() error = %v", err)
	}
	if capability.Operation != "install" || capability.AliasID != "creator.avatar-tools" {
		t.Fatalf("parsed capability = %#v", capability)
	}
	if capability.ExpectedCurrentReleaseRoot != [32]byte{0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22} {
		t.Fatalf("parsed current release root = %x", capability.ExpectedCurrentReleaseRoot)
	}
}

func TestPackageOperationCapabilityRequiresCurrentReleaseRoot(t *testing.T) {
	payload, err := EncodeCanonical(map[any]any{
		int64(0):  int64(2),
		int64(1):  "operation-capability-1",
		int64(2):  "https://api.example.test",
		int64(3):  "https://api.example.test",
		int64(4):  "buyer-1",
		int64(5):  "creator.avatar-tools",
		int64(6):  make([]byte, 32),
		int64(7):  nil,
		int64(8):  "install",
		int64(9):  make([]byte, 32),
		int64(10): make([]byte, 32),
		int64(11): "active-content-policy-v1",
		int64(12): "install-operation-1",
		int64(13): make([]byte, 32),
		int64(14): make([]byte, 32),
		int64(15): int64(1_000),
		int64(16): int64(1_000),
		int64(17): int64(1_300),
		int64(18): "00-11111111111111111111111111111111-2222222222222222-01",
	})
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	if _, err := ParsePackageOperationCapability(payload); err == nil {
		t.Fatal("ParsePackageOperationCapability() accepted a missing current release root")
	}
}

func readGoldenVector(t *testing.T) goldenVector {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "file-table-shard-v2.json"))
	if err != nil {
		t.Fatalf("read golden vector: %v", err)
	}
	var vector goldenVector
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatalf("decode golden vector: %v", err)
	}
	return vector
}

func decodeHex(t *testing.T, value string) []byte {
	t.Helper()
	data, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("decode hex: %v", err)
	}
	return data
}
