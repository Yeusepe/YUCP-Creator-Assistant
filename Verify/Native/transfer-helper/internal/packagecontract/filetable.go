package packagecontract

import (
	"bytes"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	FileTableShardPurpose  = "file-table-shard-v2"
	maxFileTableShardBytes = 4 * 1024 * 1024
	maxLogicalFileBytes    = 5 * 1024 * 1024 * 1024
	maxNormalizedPathBytes = 1024
	maxPathDepth           = 64
)

type Classification int64

const (
	ClassificationCommon          Classification = 0
	ClassificationProtectedSource Classification = 1
)

type ChunkRecipe struct {
	EncodedLength       int64
	EncodedObjectDigest [32]byte
	FileOffset          int64
	LogicalDigest       [32]byte
	LogicalLength       int64
}

type FileRecipe struct {
	Chunks         []ChunkRecipe
	Classification Classification
	Digest         [32]byte
	Length         int64
	Path           string
}

type FileTableShard struct {
	Files       []FileRecipe
	ReleaseRoot [32]byte
}

func ParseFileTableShard(payload []byte) (FileTableShard, error) {
	if len(payload) == 0 || len(payload) > maxFileTableShardBytes {
		return FileTableShard{}, fmt.Errorf(
			"FileTableShardV2 must contain 1 through %d bytes",
			maxFileTableShardBytes,
		)
	}
	decoded, err := DecodeCanonical(payload)
	if err != nil {
		return FileTableShard{}, err
	}
	shardMap, err := requireMap(decoded, "FileTableShardV2")
	if err != nil {
		return FileTableShard{}, err
	}
	if err := requireExactIntegerLabels(shardMap, []int64{0, 1, 2}, "FileTableShardV2"); err != nil {
		return FileTableShard{}, err
	}
	version, err := requireInt(shardMap[int64(0)], "FileTableShardV2.schemaVersion")
	if err != nil {
		return FileTableShard{}, err
	}
	if version != 2 {
		return FileTableShard{}, fmt.Errorf("FileTableShardV2 schema version is invalid")
	}
	releaseRootBytes, err := requireBytes(shardMap[int64(1)], "FileTableShardV2.releaseRoot", 32)
	if err != nil {
		return FileTableShard{}, err
	}
	var releaseRoot [32]byte
	copy(releaseRoot[:], releaseRootBytes)

	fileValues, err := requireArray(shardMap[int64(2)], "FileTableShardV2.files")
	if err != nil {
		return FileTableShard{}, err
	}
	files := make([]FileRecipe, 0, len(fileValues))
	caseFold := cases.Fold()
	seenPaths := make(map[string]struct{}, len(fileValues))
	var previousPath string
	for index, value := range fileValues {
		file, err := parseFileRecipe(value, index)
		if err != nil {
			return FileTableShard{}, err
		}
		if index > 0 && bytes.Compare([]byte(previousPath), []byte(file.Path)) >= 0 {
			return FileTableShard{}, fmt.Errorf("FileTableShardV2 files are not in strict UTF-8 path order")
		}
		folded := caseFold.String(file.Path)
		if _, exists := seenPaths[folded]; exists {
			return FileTableShard{}, fmt.Errorf(
				"FileTableShardV2 contains a Windows path collision at %q",
				file.Path,
			)
		}
		seenPaths[folded] = struct{}{}
		previousPath = file.Path
		files = append(files, file)
	}
	return FileTableShard{Files: files, ReleaseRoot: releaseRoot}, nil
}

func parseFileRecipe(value any, index int) (FileRecipe, error) {
	name := fmt.Sprintf("FileTableShardV2.files[%d]", index)
	mapped, err := requireMap(value, name)
	if err != nil {
		return FileRecipe{}, err
	}
	if err := requireExactIntegerLabels(mapped, []int64{0, 1, 2, 3, 4}, name); err != nil {
		return FileRecipe{}, err
	}
	normalizedPath, err := requireString(mapped[int64(0)], name+".path")
	if err != nil {
		return FileRecipe{}, err
	}
	if err := validateNormalizedPath(normalizedPath); err != nil {
		return FileRecipe{}, fmt.Errorf("%s.path: %w", name, err)
	}
	length, err := requireInt(mapped[int64(1)], name+".length")
	if err != nil {
		return FileRecipe{}, err
	}
	if length < 0 || length > maxLogicalFileBytes {
		return FileRecipe{}, fmt.Errorf("%s.length is outside the supported range", name)
	}
	digestBytes, err := requireBytes(mapped[int64(2)], name+".digest", 32)
	if err != nil {
		return FileRecipe{}, err
	}
	var digest [32]byte
	copy(digest[:], digestBytes)
	classificationValue, err := requireInt(mapped[int64(3)], name+".classification")
	if err != nil {
		return FileRecipe{}, err
	}
	classification := Classification(classificationValue)
	if classification != ClassificationCommon && classification != ClassificationProtectedSource {
		return FileRecipe{}, fmt.Errorf("%s.classification is unsupported", name)
	}
	chunkValues, err := requireArray(mapped[int64(4)], name+".chunks")
	if err != nil {
		return FileRecipe{}, err
	}
	if len(chunkValues) == 0 {
		return FileRecipe{}, fmt.Errorf("%s.chunks must contain at least one chunk", name)
	}
	chunks := make([]ChunkRecipe, 0, len(chunkValues))
	var expectedOffset int64
	for chunkIndex, chunkValue := range chunkValues {
		chunk, err := parseChunkRecipe(chunkValue, index, chunkIndex)
		if err != nil {
			return FileRecipe{}, err
		}
		if chunk.FileOffset != expectedOffset {
			return FileRecipe{}, fmt.Errorf("%s.chunks are not contiguous", name)
		}
		if chunk.LogicalLength == 0 && length != 0 {
			return FileRecipe{}, fmt.Errorf("%s contains an empty chunk in a nonempty file", name)
		}
		if chunk.LogicalLength > maxLogicalFileBytes-expectedOffset {
			return FileRecipe{}, fmt.Errorf("%s chunk lengths overflow", name)
		}
		expectedOffset += chunk.LogicalLength
		chunks = append(chunks, chunk)
	}
	if expectedOffset != length {
		return FileRecipe{}, fmt.Errorf("%s chunk lengths do not equal the file length", name)
	}
	if length == 0 && len(chunks) != 1 {
		return FileRecipe{}, fmt.Errorf("%s empty file must contain one exact chunk", name)
	}
	return FileRecipe{
		Chunks:         chunks,
		Classification: classification,
		Digest:         digest,
		Length:         length,
		Path:           normalizedPath,
	}, nil
}

func parseChunkRecipe(value any, fileIndex int, chunkIndex int) (ChunkRecipe, error) {
	name := fmt.Sprintf("FileTableShardV2.files[%d].chunks[%d]", fileIndex, chunkIndex)
	mapped, err := requireMap(value, name)
	if err != nil {
		return ChunkRecipe{}, err
	}
	if err := requireExactIntegerLabels(mapped, []int64{0, 1, 2, 3, 4}, name); err != nil {
		return ChunkRecipe{}, err
	}
	logicalDigestBytes, err := requireBytes(mapped[int64(0)], name+".logicalDigest", 32)
	if err != nil {
		return ChunkRecipe{}, err
	}
	logicalLength, err := requireInt(mapped[int64(1)], name+".logicalLength")
	if err != nil {
		return ChunkRecipe{}, err
	}
	fileOffset, err := requireInt(mapped[int64(2)], name+".fileOffset")
	if err != nil {
		return ChunkRecipe{}, err
	}
	encodedLength, err := requireInt(mapped[int64(3)], name+".encodedLength")
	if err != nil {
		return ChunkRecipe{}, err
	}
	encodedDigestBytes, err := requireBytes(mapped[int64(4)], name+".encodedObjectDigest", 32)
	if err != nil {
		return ChunkRecipe{}, err
	}
	if logicalLength < 0 || encodedLength < 0 || fileOffset < 0 {
		return ChunkRecipe{}, fmt.Errorf("%s contains a negative length or offset", name)
	}
	if logicalLength > maxLogicalFileBytes || encodedLength > 2*1024*1024 {
		return ChunkRecipe{}, fmt.Errorf("%s exceeds the supported chunk limits", name)
	}
	var logicalDigest [32]byte
	var encodedDigest [32]byte
	copy(logicalDigest[:], logicalDigestBytes)
	copy(encodedDigest[:], encodedDigestBytes)
	return ChunkRecipe{
		EncodedLength:       encodedLength,
		EncodedObjectDigest: encodedDigest,
		FileOffset:          fileOffset,
		LogicalDigest:       logicalDigest,
		LogicalLength:       logicalLength,
	}, nil
}

func validateNormalizedPath(value string) error {
	// Unicode NFC API: https://pkg.go.dev/golang.org/x/text/unicode/norm
	if !utf8.ValidString(value) || !norm.NFC.IsNormalString(value) {
		return fmt.Errorf("path must use valid NFC UTF-8")
	}
	if len([]byte(value)) > maxNormalizedPathBytes {
		return fmt.Errorf("path exceeds %d UTF-8 bytes", maxNormalizedPathBytes)
	}
	if strings.Contains(value, "\\") || strings.HasPrefix(value, "/") || path.Clean(value) != value {
		return fmt.Errorf("path must be a clean relative slash-separated path")
	}
	segments := strings.Split(value, "/")
	if len(segments) == 0 || len(segments) > maxPathDepth {
		return fmt.Errorf("path depth is outside the supported range")
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("path contains an invalid segment")
		}
		if strings.HasSuffix(segment, " ") || strings.HasSuffix(segment, ".") {
			return fmt.Errorf("path contains a Windows-ambiguous segment")
		}
		for _, character := range segment {
			if character < 0x20 || character == 0x7f || strings.ContainsRune(`<>:"|?*`, character) {
				return fmt.Errorf("path contains a Windows-unsafe character")
			}
		}
		base := strings.ToUpper(strings.SplitN(segment, ".", 2)[0])
		if isWindowsReservedName(base) {
			return fmt.Errorf("path contains a Windows reserved device name")
		}
	}
	return nil
}

func ValidateNormalizedPath(value string) error {
	return validateNormalizedPath(value)
}

func isWindowsReservedName(value string) bool {
	switch value {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(value) == 4 {
		prefix := value[:3]
		number := value[3]
		return (prefix == "COM" || prefix == "LPT") && number >= '1' && number <= '9'
	}
	return false
}
