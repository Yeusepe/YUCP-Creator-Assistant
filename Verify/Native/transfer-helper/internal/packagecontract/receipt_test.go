package packagecontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"testing"
	"time"
)

func TestParseMaterializationReceiptVerifiesExactRenditionAndOutputTree(t *testing.T) {
	outputDigest := sha256.Sum256([]byte("personalized"))
	treeRoot := testOutputTreeRoot("Assets/Product/protected.png", outputDigest, 12)
	payload := mustInstallCanonical(t, map[any]any{
		int64(0): int64(2),
		int64(1): "receipt-1",
		int64(2): "capability-1",
		int64(3): "creator-1",
		int64(4): "buyer-pseudonym-1",
		int64(5): "hmac-sha256-v1",
		int64(6): "product-1",
		int64(7): bytes.Repeat([]byte{0x11}, 32),
		int64(8): bytes.Repeat([]byte{0x22}, 32),
		int64(9): treeRoot[:],
		int64(10): []any{map[any]any{
			int64(0): "Assets/Product/protected.png",
			int64(1): outputDigest[:],
			int64(2): int64(12),
			int64(3): "attribution-1",
		}},
		int64(11): "grant-1",
		int64(12): "job-1",
		int64(13): int64(3),
		int64(14): map[any]any{
			int64(0): "job-1.zip",
			int64(1): bytes.Repeat([]byte{0x77}, 32),
			int64(2): int64(2048),
		},
		int64(15): "png-dct-qim-v2",
		int64(16): "coupling-server-v2",
		int64(17): "codec-1",
		int64(18): int64(1),
		int64(19): "helper-1",
		int64(20): "runtime-1",
		int64(21): []any{"Assets/Product/protected.png"},
		int64(22): int64(1_800_000_000),
		int64(23): int64(1_800_003_600),
		int64(24): "materializer-1",
		int64(25): "trace-1",
	})
	receipt, err := ParseMaterializationReceipt(payload)
	if err != nil {
		t.Fatalf("ParseMaterializationReceipt() error = %v", err)
	}
	if receipt.ReceiptID != "receipt-1" ||
		receipt.JobID != "job-1" ||
		receipt.Rendition.ObjectBytes != 2048 ||
		len(receipt.OutputFiles) != 1 {
		t.Fatalf("ParseMaterializationReceipt() = %#v", receipt)
	}
	if err := ValidateMaterializationReceipt(receipt, ReceiptValidationContext{
		CreatorID:   "creator-1",
		GrantID:     "grant-1",
		JobID:       "job-1",
		Now:         time.Unix(1_800_000_100, 0),
		ProductID:   "product-1",
		ReleaseRoot: bytes.Repeat([]byte{0x11}, 32),
	}); err != nil {
		t.Fatalf("ValidateMaterializationReceipt() error = %v", err)
	}
}

func testReceiptV3Payload(t *testing.T, outputCount int, schemaVersion int64) []byte {
	t.Helper()
	files := make([]MaterializedFile, 0, outputCount)
	outputValues := make([]any, 0, outputCount)
	createdPaths := make([]any, 0, outputCount)
	for index := 0; index < outputCount; index++ {
		path := fmt.Sprintf("Assets/Product/file-%05d.png", index)
		digest := sha256.Sum256([]byte(path))
		files = append(files, MaterializedFile{
			Bytes:          12,
			NormalizedPath: path,
			SHA256:         digest,
		})
		outputValues = append(outputValues, map[any]any{
			int64(0): path,
			int64(1): digest[:],
			int64(2): int64(12),
			int64(3): "attribution-1",
		})
		createdPaths = append(createdPaths, path)
	}
	treeRoot := outputTreeRoot(files)
	return mustInstallCanonical(t, map[any]any{
		int64(0):  schemaVersion,
		int64(1):  "receipt-1",
		int64(2):  "capability-1",
		int64(3):  "creator-1",
		int64(4):  "buyer-pseudonym-1",
		int64(5):  "hmac-sha256-v1",
		int64(6):  "product-1",
		int64(7):  bytes.Repeat([]byte{0x11}, 32),
		int64(8):  bytes.Repeat([]byte{0x22}, 32),
		int64(9):  treeRoot[:],
		int64(10): outputValues,
		int64(11): "grant-1",
		int64(12): "job-1",
		int64(13): int64(3),
		int64(15): "png-dct-qim-v2",
		int64(16): "coupling-server-v3",
		int64(17): "codec-1",
		int64(18): int64(1),
		int64(19): "helper-1",
		int64(20): "runtime-1",
		int64(21): createdPaths,
		int64(22): int64(1_800_000_000),
		int64(23): int64(1_800_003_600),
		int64(24): "materializer-1",
		int64(25): "trace-1",
	})
}

func TestParseMaterializationReceiptV3AcceptsAbsentRenditionLabel(t *testing.T) {
	for _, schemaVersion := range []int64{2, 3} {
		payload := testReceiptV3Payload(t, 1, schemaVersion)
		receipt, err := ParseMaterializationReceiptV3(payload)
		if err != nil {
			t.Fatalf("ParseMaterializationReceiptV3(version %d) error = %v", schemaVersion, err)
		}
		if receipt.HasRendition() ||
			receipt.Rendition != (ExactRendition{}) ||
			receipt.ReceiptID != "receipt-1" ||
			len(receipt.OutputFiles) != 1 {
			t.Fatalf("ParseMaterializationReceiptV3() = %#v", receipt)
		}
		if err := ValidateMaterializationReceipt(receipt, ReceiptValidationContext{
			CreatorID:   "creator-1",
			GrantID:     "grant-1",
			JobID:       "job-1",
			Now:         time.Unix(1_800_000_100, 0),
			ProductID:   "product-1",
			ReleaseRoot: bytes.Repeat([]byte{0x11}, 32),
		}); err != nil {
			t.Fatalf("ValidateMaterializationReceipt() error = %v", err)
		}
		if _, err := ParseMaterializationReceipt(payload); err == nil {
			t.Fatal("ParseMaterializationReceipt() accepted a payload without label 14")
		}
	}
}

func TestParseMaterializationReceiptV3RejectsPresentRenditionLabel(t *testing.T) {
	digest := sha256.Sum256([]byte("personalized"))
	treeRoot := testOutputTreeRoot("Assets/Product/protected.png", digest, 12)
	payload := mustInstallCanonical(t, map[any]any{
		int64(0): int64(3),
		int64(1): "receipt-1",
		int64(2): "capability-1",
		int64(3): "creator-1",
		int64(4): "buyer-pseudonym-1",
		int64(5): "hmac-sha256-v1",
		int64(6): "product-1",
		int64(7): bytes.Repeat([]byte{0x11}, 32),
		int64(8): bytes.Repeat([]byte{0x22}, 32),
		int64(9): treeRoot[:],
		int64(10): []any{map[any]any{
			int64(0): "Assets/Product/protected.png",
			int64(1): digest[:],
			int64(2): int64(12),
			int64(3): "attribution-1",
		}},
		int64(11): "grant-1",
		int64(12): "job-1",
		int64(13): int64(3),
		int64(14): map[any]any{
			int64(0): "job-1.zip",
			int64(1): bytes.Repeat([]byte{0x77}, 32),
			int64(2): int64(2048),
		},
		int64(15): "png-dct-qim-v2",
		int64(16): "coupling-server-v3",
		int64(17): "codec-1",
		int64(18): int64(1),
		int64(19): "helper-1",
		int64(20): "runtime-1",
		int64(21): []any{"Assets/Product/protected.png"},
		int64(22): int64(1_800_000_000),
		int64(23): int64(1_800_003_600),
		int64(24): "materializer-1",
		int64(25): "trace-1",
	})
	if _, err := ParseMaterializationReceiptV3(payload); err == nil {
		t.Fatal("ParseMaterializationReceiptV3() accepted a payload with label 14")
	}
}

func TestParseMaterializationReceiptV3RaisesOutputFileCap(t *testing.T) {
	payload := testReceiptV3Payload(t, 513, 3)
	receipt, err := ParseMaterializationReceiptV3(payload)
	if err != nil {
		t.Fatalf("ParseMaterializationReceiptV3(513 files) error = %v", err)
	}
	if len(receipt.OutputFiles) != 513 {
		t.Fatalf("output file count = %d; want 513", len(receipt.OutputFiles))
	}
	if _, err := ParseMaterializationReceiptV3(testReceiptV3Payload(t, 4097, 3)); err == nil {
		t.Fatal("ParseMaterializationReceiptV3() accepted 4097 output files")
	}
}

func testOutputTreeRoot(path string, digest [32]byte, size uint64) [32]byte {
	hasher := sha256.New()
	hasher.Write([]byte("yucp:output-tree:v2"))
	for _, field := range [][]byte{
		[]byte(path),
		digest[:],
		binary.BigEndian.AppendUint64(nil, size),
	} {
		hasher.Write(binary.BigEndian.AppendUint64(nil, uint64(len(field))))
		hasher.Write(field)
	}
	var result [32]byte
	copy(result[:], hasher.Sum(nil))
	return result
}
