package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

func TestParseManifestRecomputesEverySignedReleaseBinding(t *testing.T) {
	content := []byte("verified delivery\n")
	fileDigest := sha256.Sum256(content)
	commonRoot := testSubtreeRoot(t, "yucp:common-source-tree:v4", []testFile{{
		Bytes:          int64(len(content)),
		Classification: "common",
		Path:           "Assets/Product/file.txt",
		SHA256:         fileDigest,
	}})
	protectedRoot := testSubtreeRoot(t, "yucp:protected-source-tree:v4", nil)
	releaseRoot := testReleaseRoot(t, commonRoot, protectedRoot, []testFile{{
		Bytes:          int64(len(content)),
		Classification: "common",
		Path:           "Assets/Product/file.txt",
		SHA256:         fileDigest,
	}})
	manifestValue := map[string]any{
		"activeContentDigest":        hex.EncodeToString(make([]byte, 32)),
		"activePolicyVersion":        "active-content-policy-v1",
		"chunkAvgKib":                256,
		"commonRoot":                 hex.EncodeToString(commonRoot[:]),
		"normalizationPolicyVersion": "package-normalization-policy-v2",
		"files": []any{map[string]any{
			"bytes":          len(content),
			"chunks":         []any{map[string]any{"id": hex.EncodeToString(fileDigest[:]), "sha256": hex.EncodeToString(fileDigest[:]), "size": len(content)}},
			"classification": "common",
			"normalizedPath": "Assets/Product/file.txt",
			"sha256":         hex.EncodeToString(fileDigest[:]),
		}},
		"packageId": "product-1",
		"bootstrapMedia": []any{map[string]any{
			"bucketName":      "metadata",
			"byteSize":        1024,
			"contentType":     "image/png",
			"kind":            "icon",
			"localPath":       "Documentation~/YUCP/icon.png",
			"objectKey":       "bootstrap-media/product-1/icon.png",
			"providerVersion": "version-icon-1",
			"sha256":          hex.EncodeToString(fileDigest[:]),
		}},
		"packageMetadata": map[string]any{
			"author":      "YUCP",
			"description": "A verified package",
			"packageName": "Product",
			"tagline":     "Verified delivery",
			"version":     "1.0.0",
		},
		"protectedSourceRoot":    hex.EncodeToString(protectedRoot[:]),
		"protectionPolicyDigest": hex.EncodeToString(make([]byte, 32)),
		"protectionPolicyId":     activeProtectionPolicyID,
		"releaseRoot":            hex.EncodeToString(releaseRoot[:]),
		"schemaVersion":          4,
		"storageFormatVersion":   "desync-uncompressed-sha256-v1",
		"version":                "1.0.0",
		"versionId":              "version-1",
		"vpmDependencies": map[string]any{
			"com.yucp.components": ">=0.3.42",
		},
		"vpmRepositories": map[string]any{
			"YUCP Components Listing": "https://vpm.yucp.club/index.json",
		},
	}
	data, err := json.Marshal(manifestValue)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	manifestDigest := sha256.Sum256(data)
	bindingPayload := mustDeliveryCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): releaseRoot[:],
		int64(2): manifestDigest[:],
		int64(3): commonRoot[:],
		int64(4): protectedRoot[:],
	})
	bindingRoot, err := packagecontract.DomainHash("yucp:delivery-binding:v3", bindingPayload)
	if err != nil {
		t.Fatalf("DomainHash(binding) error = %v", err)
	}
	manifest, err := ParseManifest(data, ManifestBinding{
		BindingRoot:    bindingRoot,
		ManifestSHA256: manifestDigest,
		ProductID:      "product-1",
		ReleaseRoot:    releaseRoot,
		VersionID:      "version-1",
	})
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}
	if len(manifest.Files) != 1 ||
		manifest.Files[0].NormalizedPath != "Assets/Product/file.txt" ||
		manifest.ActivePolicyVersion != "active-content-policy-v1" ||
		manifest.NormalizationPolicyVersion != "package-normalization-policy-v2" ||
		len(manifest.BootstrapMedia) != 1 ||
		manifest.BootstrapMedia[0].Kind != "icon" ||
		manifest.PackageMetadata == nil ||
		manifest.PackageMetadata.PackageName != "Product" ||
		manifest.VPMDependencies["com.yucp.components"] != ">=0.3.42" ||
		manifest.VPMRepositories["YUCP Components Listing"] !=
			"https://vpm.yucp.club/index.json" {
		t.Fatalf("ParseManifest() = %#v", manifest)
	}
}

func TestParseManifestRejectsPathEscape(t *testing.T) {
	if _, err := ParseManifest([]byte(`{"schemaVersion":4}`), ManifestBinding{}); err == nil {
		t.Fatal("ParseManifest() accepted an incomplete manifest")
	}
}

func TestValidateVPMBootstrapMetadataRejectsInvalidValues(t *testing.T) {
	tooManyDependencies := make(map[string]string, maxVPMDependencies+1)
	for index := 0; index <= maxVPMDependencies; index++ {
		tooManyDependencies[fmt.Sprintf("com.yucp.package%d", index)] = ">=0.0.0"
	}
	tests := []struct {
		name     string
		manifest Manifest
	}{
		{
			name: "dependency count",
			manifest: Manifest{
				VPMDependencies: tooManyDependencies,
			},
		},
		{
			name: "dependency package identifier",
			manifest: Manifest{
				VPMDependencies: map[string]string{"Com.YUCP.Package": ">=0.0.0"},
			},
		},
		{
			name: "dependency control character",
			manifest: Manifest{
				VPMDependencies: map[string]string{"com.yucp.package": ">=0.0.0\n"},
			},
		},
		{
			name: "repository query",
			manifest: Manifest{
				VPMRepositories: map[string]string{
					"YUCP": "https://vpm.yucp.club/index.json?token=secret",
				},
			},
		},
		{
			name: "repository credentials",
			manifest: Manifest{
				VPMRepositories: map[string]string{
					"YUCP": "https://user:password@vpm.yucp.club/index.json",
				},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateVPMBootstrapMetadata(test.manifest); err == nil {
				t.Fatal("validateVPMBootstrapMetadata() accepted an invalid manifest")
			}
		})
	}
}

type testFile struct {
	Bytes          int64
	Classification string
	Materializer   string
	Path           string
	SHA256         [32]byte
}

func testSubtreeRoot(t *testing.T, purpose string, files []testFile) [32]byte {
	t.Helper()
	payloadFiles := make([]any, 0, len(files))
	for _, file := range files {
		payloadFiles = append(payloadFiles, testFileMap(file))
	}
	payload := mustDeliveryCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): payloadFiles,
	})
	root, err := packagecontract.DomainHash(purpose, payload)
	if err != nil {
		t.Fatalf("DomainHash(%s) error = %v", purpose, err)
	}
	return root
}

func testReleaseRoot(
	t *testing.T,
	commonRoot [32]byte,
	protectedRoot [32]byte,
	files []testFile,
) [32]byte {
	t.Helper()
	payloadFiles := make([]any, 0, len(files))
	for _, file := range files {
		payloadFiles = append(payloadFiles, testFileMap(file))
	}
	payload := mustDeliveryCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): "logical-release-v4",
		int64(2): "product-1",
		int64(3): "1.0.0",
		int64(4): "version-1",
		int64(5): payloadFiles,
		int64(6): commonRoot[:],
		int64(7): protectedRoot[:],
	})
	root, err := packagecontract.DomainHash("yucp:logical-release:v4", payload)
	if err != nil {
		t.Fatalf("DomainHash(release) error = %v", err)
	}
	return root
}

func testFileMap(file testFile) map[any]any {
	return map[any]any{
		int64(0): file.Path,
		int64(1): file.Bytes,
		int64(2): file.SHA256[:],
		int64(3): file.Classification,
		int64(4): file.Materializer,
	}
}

func mustDeliveryCanonical(t *testing.T, value any) []byte {
	t.Helper()
	data, err := packagecontract.EncodeCanonical(value)
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	return data
}
