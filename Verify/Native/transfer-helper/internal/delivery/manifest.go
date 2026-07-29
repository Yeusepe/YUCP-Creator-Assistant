package delivery

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

const (
	StorageFormatVersion                = "desync-uncompressed-sha256-v1"
	SupportedNormalizationPolicyVersion = "package-normalization-policy-v2"
	maxManifestBytes                    = 8 * 1024 * 1024
	maxFiles                            = 100_000
	maxChunks                           = 1_000_000
	maxChunkBytes                       = 1024 * 1024
	maxVPMDependencies                  = 64
	maxVPMRepositories                  = 16
	maxVPMBootstrapMedia                = 42
	maxVPMBootstrapMediaBytes           = 16 * 1024 * 1024
	maxVPMGalleryItems                  = 8
	maxVPMProductLinkItems              = 32
)

var vpmPackageIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,213}$`)
var vpmBootstrapObjectKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

type Chunk struct {
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type File struct {
	Bytes          int64   `json:"bytes"`
	Chunks         []Chunk `json:"chunks"`
	Classification string  `json:"classification"`
	Materializer   string  `json:"materializerType,omitempty"`
	NormalizedPath string  `json:"normalizedPath"`
	SHA256         string  `json:"sha256"`
}

type BootstrapMedia struct {
	BucketName      string `json:"bucketName,omitempty"`
	ByteSize        *int64 `json:"byteSize,omitempty"`
	ContentType     string `json:"contentType,omitempty"`
	Kind            string `json:"kind"`
	Label           string `json:"label,omitempty"`
	LocalPath       string `json:"localPath,omitempty"`
	ObjectKey       string `json:"objectKey,omitempty"`
	Ordinal         *int   `json:"ordinal,omitempty"`
	ProviderVersion string `json:"providerVersion,omitempty"`
	SHA256          string `json:"sha256,omitempty"`
	URL             string `json:"url,omitempty"`
}

type PackageMetadata struct {
	Author      string  `json:"author"`
	Description *string `json:"description,omitempty"`
	PackageName string  `json:"packageName"`
	Tagline     *string `json:"tagline,omitempty"`
	Version     string  `json:"version"`
}

type Manifest struct {
	ActiveContentDigest        string            `json:"activeContentDigest"`
	ActivePolicyVersion        string            `json:"activePolicyVersion"`
	BootstrapMedia             []BootstrapMedia  `json:"bootstrapMedia,omitempty"`
	ChunkAverageKiB            int               `json:"chunkAvgKib"`
	CommonRoot                 string            `json:"commonRoot"`
	Files                      []File            `json:"files"`
	NormalizationPolicyVersion string            `json:"normalizationPolicyVersion"`
	PackageID                  string            `json:"packageId"`
	PackageMetadata            *PackageMetadata  `json:"packageMetadata,omitempty"`
	ProtectedSourceRoot        string            `json:"protectedSourceRoot"`
	ProtectionPolicyDigest     string            `json:"protectionPolicyDigest"`
	ProtectionPolicyID         string            `json:"protectionPolicyId"`
	ReleaseRoot                string            `json:"releaseRoot"`
	SchemaVersion              int               `json:"schemaVersion"`
	StorageFormatVersion       string            `json:"storageFormatVersion"`
	Version                    string            `json:"version"`
	VersionID                  string            `json:"versionId"`
	VPMDependencies            map[string]string `json:"vpmDependencies"`
	VPMRepositories            map[string]string `json:"vpmRepositories"`
}

type ManifestBinding struct {
	BindingRoot    [32]byte
	ManifestSHA256 [32]byte
	ProductID      string
	ReleaseRoot    [32]byte
	VersionID      string
}

func ParseManifest(data []byte, binding ManifestBinding) (Manifest, error) {
	if len(data) == 0 || len(data) > maxManifestBytes {
		return Manifest{}, fmt.Errorf("delivery manifest has an invalid length")
	}
	actualManifestDigest := sha256.Sum256(data)
	if !bytes.Equal(actualManifestDigest[:], binding.ManifestSHA256[:]) {
		return Manifest{}, fmt.Errorf("delivery manifest SHA-256 does not match the install session")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode delivery manifest: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return Manifest{}, fmt.Errorf("delivery manifest contains trailing JSON")
	}
	if manifest.SchemaVersion != 4 ||
		manifest.StorageFormatVersion != StorageFormatVersion ||
		manifest.NormalizationPolicyVersion != SupportedNormalizationPolicyVersion ||
		manifest.ChunkAverageKiB != 256 ||
		manifest.PackageID != binding.ProductID ||
		manifest.VersionID != binding.VersionID ||
		manifest.ReleaseRoot != hex.EncodeToString(binding.ReleaseRoot[:]) ||
		len(manifest.Files) == 0 ||
		len(manifest.Files) > maxFiles ||
		!isDigest(manifest.ActiveContentDigest) ||
		!isDigest(manifest.CommonRoot) ||
		!isDigest(manifest.ProtectedSourceRoot) ||
		!isDigest(manifest.ProtectionPolicyDigest) ||
		!isSafeText(manifest.ActivePolicyVersion, 128) ||
		!isSafeText(manifest.PackageID, 512) ||
		manifest.ProtectionPolicyID != activeProtectionPolicyID ||
		!isSafeText(manifest.Version, 512) ||
		!isSafeText(manifest.VersionID, 128) {
		return Manifest{}, fmt.Errorf("delivery manifest identity is invalid")
	}
	if err := validateVPMBootstrapMetadata(manifest); err != nil {
		return Manifest{}, err
	}
	chunkCount := 0
	var previousPath string
	foldedPaths := make(map[string]struct{}, len(manifest.Files))
	for fileIndex := range manifest.Files {
		file := &manifest.Files[fileIndex]
		if err := validateFile(*file, fileIndex); err != nil {
			return Manifest{}, err
		}
		if fileIndex > 0 && previousPath >= file.NormalizedPath {
			return Manifest{}, fmt.Errorf("delivery manifest files are not in strict UTF-8 order")
		}
		folded := strings.ToUpper(file.NormalizedPath)
		if _, exists := foldedPaths[folded]; exists {
			return Manifest{}, fmt.Errorf("delivery manifest contains a Windows path collision")
		}
		foldedPaths[folded] = struct{}{}
		previousPath = file.NormalizedPath
		chunkCount += len(file.Chunks)
		if chunkCount > maxChunks {
			return Manifest{}, fmt.Errorf("delivery manifest chunk count exceeds its limit")
		}
	}
	commonRoot, err := subtreeRoot(
		"yucp:common-source-tree:v4",
		filterFiles(manifest.Files, "common"),
	)
	if err != nil {
		return Manifest{}, err
	}
	protectedRoot, err := subtreeRoot(
		"yucp:protected-source-tree:v4",
		filterFiles(manifest.Files, "protected"),
	)
	if err != nil {
		return Manifest{}, err
	}
	releaseRoot, err := logicalReleaseRoot(manifest, commonRoot, protectedRoot)
	if err != nil {
		return Manifest{}, err
	}
	if manifest.CommonRoot != hex.EncodeToString(commonRoot[:]) ||
		manifest.ProtectedSourceRoot != hex.EncodeToString(protectedRoot[:]) ||
		!bytes.Equal(releaseRoot[:], binding.ReleaseRoot[:]) {
		return Manifest{}, fmt.Errorf("delivery manifest logical release root is invalid")
	}
	bindingPayload, err := packagecontract.EncodeCanonical(map[any]any{
		int64(0): int64(4),
		int64(1): releaseRoot[:],
		int64(2): actualManifestDigest[:],
		int64(3): commonRoot[:],
		int64(4): protectedRoot[:],
	})
	if err != nil {
		return Manifest{}, fmt.Errorf("encode delivery binding: %w", err)
	}
	bindingRoot, err := packagecontract.DomainHash("yucp:delivery-binding:v3", bindingPayload)
	if err != nil {
		return Manifest{}, fmt.Errorf("compute delivery binding: %w", err)
	}
	if !bytes.Equal(bindingRoot[:], binding.BindingRoot[:]) {
		return Manifest{}, fmt.Errorf("delivery manifest binding root is invalid")
	}
	return manifest, nil
}

func validateFile(file File, index int) error {
	if err := packagecontract.ValidateNormalizedPath(file.NormalizedPath); err != nil {
		return fmt.Errorf("delivery manifest file %d path: %w", index, err)
	}
	if file.Classification != "common" && file.Classification != "protected" {
		return fmt.Errorf("delivery manifest file %d classification is invalid", index)
	}
	if (file.Classification == "common" && file.Materializer != "") ||
		(file.Classification == "protected" && !isSafeText(file.Materializer, 128)) ||
		file.Bytes < 0 ||
		!isDigest(file.SHA256) ||
		len(file.Chunks) == 0 {
		return fmt.Errorf("delivery manifest file %d metadata is invalid", index)
	}
	var total int64
	for chunkIndex, chunk := range file.Chunks {
		if !isDigest(chunk.ID) ||
			!isDigest(chunk.SHA256) ||
			chunk.Size < 0 ||
			chunk.Size > maxChunkBytes ||
			(chunk.Size == 0 && file.Bytes != 0) {
			return fmt.Errorf(
				"delivery manifest file %d chunk %d is invalid",
				index,
				chunkIndex,
			)
		}
		total += chunk.Size
		if total < 0 {
			return fmt.Errorf("delivery manifest file %d chunk length overflow", index)
		}
	}
	if total != file.Bytes ||
		(file.Bytes == 0 &&
			(len(file.Chunks) != 1 ||
				file.Chunks[0].Size != 0 ||
				file.Chunks[0].SHA256 != file.SHA256)) {
		return fmt.Errorf("delivery manifest file %d recipe is invalid", index)
	}
	return nil
}

func validateVPMBootstrapMetadata(manifest Manifest) error {
	if len(manifest.BootstrapMedia) > maxVPMBootstrapMedia {
		return fmt.Errorf("delivery manifest bootstrap media count exceeds its limit")
	}
	mediaRoles := make(map[string]struct{}, len(manifest.BootstrapMedia))
	for _, media := range manifest.BootstrapMedia {
		requiresOrdinal := false
		maximumOrdinal := 0
		switch media.Kind {
		case "icon", "banner":
		case "gallery":
			requiresOrdinal = true
			maximumOrdinal = maxVPMGalleryItems
		case "product-link":
			requiresOrdinal = true
			maximumOrdinal = maxVPMProductLinkItems
		default:
			return fmt.Errorf("delivery manifest bootstrap media kind is invalid")
		}
		if requiresOrdinal {
			if media.Ordinal == nil || *media.Ordinal < 0 || *media.Ordinal >= maximumOrdinal {
				return fmt.Errorf("delivery manifest bootstrap media ordinal is invalid")
			}
		} else if media.Ordinal != nil {
			return fmt.Errorf("delivery manifest bootstrap media ordinal is invalid")
		}
		ordinal := 0
		if media.Ordinal != nil {
			ordinal = *media.Ordinal
		}
		role := fmt.Sprintf("%s:%d", media.Kind, ordinal)
		if _, exists := mediaRoles[role]; exists {
			return fmt.Errorf("delivery manifest bootstrap media role is duplicated")
		}
		mediaRoles[role] = struct{}{}

		hasPayload := media.BucketName != "" ||
			media.ByteSize != nil ||
			media.ContentType != "" ||
			media.LocalPath != "" ||
			media.ObjectKey != "" ||
			media.ProviderVersion != "" ||
			media.SHA256 != ""
		if !hasPayload {
			if media.Kind != "product-link" ||
				!isVPMSafeText(media.Label, 120) ||
				!isPublicHTTPSURL(media.URL) {
				return fmt.Errorf("delivery manifest bootstrap media is invalid")
			}
			continue
		}

		extension := ""
		switch media.ContentType {
		case "image/png":
			extension = "png"
		case "image/jpeg":
			extension = "jpg"
		default:
			return fmt.Errorf("delivery manifest bootstrap media content type is invalid")
		}
		expectedPath := ""
		switch media.Kind {
		case "icon", "banner":
			expectedPath = fmt.Sprintf("Documentation~/YUCP/%s.%s", media.Kind, extension)
		case "gallery":
			expectedPath = fmt.Sprintf("Documentation~/YUCP/gallery/%03d.%s", ordinal, extension)
		case "product-link":
			expectedPath = fmt.Sprintf(
				"Documentation~/YUCP/product-links/%03d.%s",
				ordinal,
				extension,
			)
		}
		if !isVPMSafeText(media.BucketName, 255) ||
			media.ByteSize == nil ||
			*media.ByteSize < 8 ||
			*media.ByteSize > maxVPMBootstrapMediaBytes ||
			media.LocalPath != expectedPath ||
			!isSafeObjectKey(media.ObjectKey) ||
			!isVPMSafeText(media.ProviderVersion, 1_024) ||
			!isDigest(media.SHA256) {
			return fmt.Errorf("delivery manifest bootstrap media is invalid")
		}
		if media.Kind == "product-link" {
			if !isVPMSafeText(media.Label, 120) || !isPublicHTTPSURL(media.URL) {
				return fmt.Errorf("delivery manifest bootstrap media product link is invalid")
			}
		} else if media.Label != "" || media.URL != "" {
			return fmt.Errorf("delivery manifest bootstrap media product link is invalid")
		}
	}
	if manifest.PackageMetadata != nil {
		metadata := manifest.PackageMetadata
		if !isVPMSafeText(metadata.Author, 120) ||
			!isVPMSafeText(metadata.PackageName, 120) ||
			metadata.PackageName == "." ||
			metadata.PackageName == ".." ||
			strings.ContainsAny(metadata.PackageName, `/\`) ||
			!isVPMSafeText(metadata.Version, 128) ||
			!isOptionalVPMSafeText(metadata.Description, 500) ||
			!isOptionalVPMSafeText(metadata.Tagline, 160) {
			return fmt.Errorf("delivery manifest package metadata is invalid")
		}
	}
	if len(manifest.VPMDependencies) > maxVPMDependencies {
		return fmt.Errorf("delivery manifest VPM dependency count exceeds its limit")
	}
	for name, versionRange := range manifest.VPMDependencies {
		if !vpmPackageIDPattern.MatchString(name) || !isVPMSafeText(versionRange, 128) {
			return fmt.Errorf("delivery manifest VPM dependency is invalid")
		}
	}
	if len(manifest.VPMRepositories) > maxVPMRepositories {
		return fmt.Errorf("delivery manifest VPM repository count exceeds its limit")
	}
	for name, value := range manifest.VPMRepositories {
		if !isVPMSafeText(name, 128) || !isVPMSafeText(value, 2_048) {
			return fmt.Errorf("delivery manifest VPM repository is invalid")
		}
		repositoryURL, err := url.Parse(value)
		if err != nil ||
			!repositoryURL.IsAbs() ||
			repositoryURL.Scheme != "https" ||
			repositoryURL.Hostname() == "" ||
			repositoryURL.User != nil ||
			repositoryURL.RawQuery != "" ||
			repositoryURL.ForceQuery ||
			repositoryURL.Fragment != "" ||
			repositoryURL.Opaque != "" {
			return fmt.Errorf("delivery manifest VPM repository URL is invalid")
		}
	}
	return nil
}

func subtreeRoot(purpose string, files []File) ([32]byte, error) {
	payloadFiles := make([]any, 0, len(files))
	for _, file := range files {
		fileValue, err := releaseFileValue(file)
		if err != nil {
			return [32]byte{}, err
		}
		payloadFiles = append(payloadFiles, fileValue)
	}
	payload, err := packagecontract.EncodeCanonical(map[any]any{
		int64(0): int64(4),
		int64(1): payloadFiles,
	})
	if err != nil {
		return [32]byte{}, fmt.Errorf("encode release subtree: %w", err)
	}
	return packagecontract.DomainHash(purpose, payload)
}

func logicalReleaseRoot(
	manifest Manifest,
	commonRoot [32]byte,
	protectedRoot [32]byte,
) ([32]byte, error) {
	payloadFiles := make([]any, 0, len(manifest.Files))
	for _, file := range manifest.Files {
		fileValue, err := releaseFileValue(file)
		if err != nil {
			return [32]byte{}, err
		}
		payloadFiles = append(payloadFiles, fileValue)
	}
	payload, err := packagecontract.EncodeCanonical(map[any]any{
		int64(0): int64(4),
		int64(1): "logical-release-v4",
		int64(2): manifest.PackageID,
		int64(3): manifest.Version,
		int64(4): manifest.VersionID,
		int64(5): payloadFiles,
		int64(6): commonRoot[:],
		int64(7): protectedRoot[:],
	})
	if err != nil {
		return [32]byte{}, fmt.Errorf("encode logical release: %w", err)
	}
	return packagecontract.DomainHash("yucp:logical-release:v4", payload)
}

func releaseFileValue(file File) (map[any]any, error) {
	digest, err := hex.DecodeString(file.SHA256)
	if err != nil {
		return nil, fmt.Errorf("decode release file digest: %w", err)
	}
	return map[any]any{
		int64(0): file.NormalizedPath,
		int64(1): file.Bytes,
		int64(2): digest,
		int64(3): file.Classification,
		int64(4): file.Materializer,
	}, nil
}

func filterFiles(files []File, classification string) []File {
	filtered := make([]File, 0, len(files))
	for _, file := range files {
		if file.Classification == classification {
			filtered = append(filtered, file)
		}
	}
	return filtered
}

func isDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && strings.ToLower(value) == value
}

func isSafeText(value string, max int) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && value == trimmed && len([]byte(value)) <= max
}

func isVPMSafeText(value string, max int) bool {
	if !isSafeText(value, max) {
		return false
	}
	for _, character := range value {
		if character <= 31 || character == 127 {
			return false
		}
	}
	return true
}

func isOptionalVPMSafeText(value *string, max int) bool {
	return value == nil || isVPMSafeText(*value, max)
}

func isSafeObjectKey(value string) bool {
	if len(value) > 1_024 ||
		!vpmBootstrapObjectKeyPattern.MatchString(value) ||
		strings.HasPrefix(value, "/") ||
		strings.Contains(value, "//") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func isPublicHTTPSURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil &&
		parsed.IsAbs() &&
		parsed.Scheme == "https" &&
		parsed.Hostname() != "" &&
		parsed.User == nil
}
