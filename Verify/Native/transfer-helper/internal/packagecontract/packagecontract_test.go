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
