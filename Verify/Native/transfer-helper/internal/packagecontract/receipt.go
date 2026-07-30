package packagecontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"time"
)

const (
	MaterializationReceiptPurpose   = "materialization-receipt-v2"
	MaterializationReceiptPurposeV3 = "materialization-receipt-v3"

	maxOutputFilesV2 = 512
	maxOutputFilesV3 = 4096
)

type MaterializedFile struct {
	AttributionID  string
	Bytes          int64
	NormalizedPath string
	SHA256         [32]byte
}

type ExactRendition struct {
	FileIdentifier string
	ObjectBytes    int64
	ObjectSHA256   [32]byte
}

type MaterializationReceipt struct {
	CreatorID      string
	ExpiresAt      int64
	GrantID        string
	IssuedAt       int64
	JobID          string
	OutputFiles    []MaterializedFile
	OutputTreeRoot [32]byte
	ProductID      string
	ReceiptID      string
	ReleaseRoot    [32]byte
	Rendition      ExactRendition
	TraceID        string
}

// HasRendition reports whether the receipt carries an exact rendition object
// (v2 receipts always do; v3 coupled receipts never do).
func (receipt MaterializationReceipt) HasRendition() bool {
	return receipt.Rendition.ObjectBytes > 0
}

type ReceiptValidationContext struct {
	CreatorID   string
	GrantID     string
	JobID       string
	Now         time.Time
	ProductID   string
	ReleaseRoot []byte
}

func ParseMaterializationReceipt(payload []byte) (MaterializationReceipt, error) {
	return parseMaterializationReceipt(payload, false)
}

// ParseMaterializationReceiptV3 parses a materialization-receipt-v3 payload:
// the exact v2 label set minus label 14 (the rendition object), with the
// output-file cap raised to 4096. All other bindings are identical to v2.
func ParseMaterializationReceiptV3(payload []byte) (MaterializationReceipt, error) {
	return parseMaterializationReceipt(payload, true)
}

func parseMaterializationReceipt(payload []byte, v3 bool) (MaterializationReceipt, error) {
	name := "MaterializationReceiptV2"
	maxOutputFiles := maxOutputFilesV2
	if v3 {
		name = "MaterializationReceiptV3"
		maxOutputFiles = maxOutputFilesV3
	}
	decoded, err := DecodeCanonical(payload)
	if err != nil {
		return MaterializationReceipt{}, err
	}
	mapped, err := requireMap(decoded, name)
	if err != nil {
		return MaterializationReceipt{}, err
	}
	labels := make([]int64, 0, 26)
	for label := int64(0); label < 26; label++ {
		if v3 && label == 14 {
			continue
		}
		labels = append(labels, label)
	}
	if err := requireExactIntegerLabels(mapped, labels, name); err != nil {
		return MaterializationReceipt{}, err
	}
	version, err := requireInt(mapped[int64(0)], name+".schemaVersion")
	// ponytail: the v3 wire contract fixes the label set and COSE purpose but
	// not the label-0 value; accept 2 or 3 until the server side settles it.
	if err != nil || (!v3 && version != 2) || (v3 && version != 2 && version != 3) {
		return MaterializationReceipt{}, fmt.Errorf("%s schema version is invalid", name)
	}
	outputValues, err := requireArray(mapped[int64(10)], name+".outputFiles")
	if err != nil || len(outputValues) == 0 || len(outputValues) > maxOutputFiles {
		return MaterializationReceipt{}, fmt.Errorf("%s output file count is invalid", name)
	}
	outputFiles := make([]MaterializedFile, 0, len(outputValues))
	var previousPath string
	for index, value := range outputValues {
		fileMap, fileErr := requireMap(
			value,
			fmt.Sprintf("%s.outputFiles[%d]", name, index),
		)
		if fileErr != nil {
			return MaterializationReceipt{}, fileErr
		}
		if fileErr := requireExactIntegerLabels(
			fileMap,
			[]int64{0, 1, 2, 3},
			fmt.Sprintf("%s.outputFiles[%d]", name, index),
		); fileErr != nil {
			return MaterializationReceipt{}, fileErr
		}
		normalizedPath, fileErr := requireString(
			fileMap[int64(0)],
			fmt.Sprintf("%s.outputFiles[%d].normalizedPath", name, index),
		)
		if fileErr != nil || ValidateNormalizedPath(normalizedPath) != nil ||
			(index > 0 && previousPath >= normalizedPath) {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s output file %d path is invalid",
				name,
				index,
			)
		}
		digest, fileErr := requireDigest(
			fileMap[int64(1)],
			fmt.Sprintf("%s.outputFiles[%d].outputSha256", name, index),
		)
		if fileErr != nil {
			return MaterializationReceipt{}, fileErr
		}
		fileBytes, fileErr := requireInt(
			fileMap[int64(2)],
			fmt.Sprintf("%s.outputFiles[%d].outputBytes", name, index),
		)
		if fileErr != nil || fileBytes < 0 {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s output file %d byte count is invalid",
				name,
				index,
			)
		}
		attributionID, fileErr := requireString(
			fileMap[int64(3)],
			fmt.Sprintf("%s.outputFiles[%d].attributionId", name, index),
		)
		if fileErr != nil || len([]byte(attributionID)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s output file %d attribution is invalid",
				name,
				index,
			)
		}
		outputFiles = append(outputFiles, MaterializedFile{
			AttributionID:  attributionID,
			Bytes:          fileBytes,
			NormalizedPath: normalizedPath,
			SHA256:         digest,
		})
		previousPath = normalizedPath
	}
	createdPaths, err := requireStringArray(
		mapped[int64(21)],
		name+".createdPaths",
		maxOutputFiles,
	)
	if err != nil || len(createdPaths) != len(outputFiles) {
		return MaterializationReceipt{}, fmt.Errorf("%s created paths are invalid", name)
	}
	for index, path := range createdPaths {
		if path != outputFiles[index].NormalizedPath {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s created paths do not match output files",
				name,
			)
		}
	}
	receipt := MaterializationReceipt{OutputFiles: outputFiles}
	if !v3 {
		renditionMap, renditionErr := requireMap(
			mapped[int64(14)],
			name+".rendition",
		)
		if renditionErr != nil {
			return MaterializationReceipt{}, renditionErr
		}
		if renditionErr := requireExactIntegerLabels(
			renditionMap,
			[]int64{0, 1, 2},
			name+".rendition",
		); renditionErr != nil {
			return MaterializationReceipt{}, renditionErr
		}
		renditionFileIdentifier, renditionErr := requireString(
			renditionMap[int64(0)],
			name+".rendition.fileIdentifier",
		)
		if renditionErr != nil || len([]byte(renditionFileIdentifier)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s rendition file identifier is invalid",
				name,
			)
		}
		renditionDigest, renditionErr := requireDigest(
			renditionMap[int64(1)],
			name+".rendition.objectSha256",
		)
		if renditionErr != nil {
			return MaterializationReceipt{}, renditionErr
		}
		renditionBytes, renditionErr := requireInt(
			renditionMap[int64(2)],
			name+".rendition.objectBytes",
		)
		if renditionErr != nil || renditionBytes <= 0 {
			return MaterializationReceipt{}, fmt.Errorf("%s rendition bytes are invalid", name)
		}
		receipt.Rendition = ExactRendition{
			FileIdentifier: renditionFileIdentifier,
			ObjectBytes:    renditionBytes,
			ObjectSHA256:   renditionDigest,
		}
	}
	for field, destination := range map[int64]*string{
		1:  &receipt.ReceiptID,
		3:  &receipt.CreatorID,
		6:  &receipt.ProductID,
		11: &receipt.GrantID,
		12: &receipt.JobID,
		25: &receipt.TraceID,
	} {
		value, fieldErr := requireString(
			mapped[field],
			fmt.Sprintf("%s.%d", name, field),
		)
		if fieldErr != nil || len([]byte(value)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s text claim %d is invalid",
				name,
				field,
			)
		}
		*destination = value
	}
	for field, destination := range map[int64]*[32]byte{
		7: &receipt.ReleaseRoot,
		9: &receipt.OutputTreeRoot,
	} {
		value, fieldErr := requireDigest(
			mapped[field],
			fmt.Sprintf("%s.%d", name, field),
		)
		if fieldErr != nil {
			return MaterializationReceipt{}, fieldErr
		}
		*destination = value
	}
	for field, destination := range map[int64]*int64{
		22: &receipt.IssuedAt,
		23: &receipt.ExpiresAt,
	} {
		value, fieldErr := requireInt(
			mapped[field],
			fmt.Sprintf("%s.%d", name, field),
		)
		if fieldErr != nil {
			return MaterializationReceipt{}, fieldErr
		}
		*destination = value
	}
	for _, field := range []int64{2, 4, 5, 15, 16, 17, 19, 20, 24} {
		value, fieldErr := requireString(
			mapped[field],
			fmt.Sprintf("%s.%d", name, field),
		)
		if fieldErr != nil || len([]byte(value)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s text claim %d is invalid",
				name,
				field,
			)
		}
	}
	for _, field := range []int64{13, 18} {
		value, fieldErr := requireInt(
			mapped[field],
			fmt.Sprintf("%s.%d", name, field),
		)
		if fieldErr != nil || value < 0 {
			return MaterializationReceipt{}, fmt.Errorf(
				"%s integer claim %d is invalid",
				name,
				field,
			)
		}
	}
	if _, err := requireDigest(
		mapped[int64(8)],
		name+".protectedSourceRoot",
	); err != nil {
		return MaterializationReceipt{}, err
	}
	expectedOutputTreeRoot := outputTreeRoot(outputFiles)
	if receipt.IssuedAt < 0 ||
		receipt.ExpiresAt <= receipt.IssuedAt ||
		receipt.ExpiresAt-receipt.IssuedAt > 30*24*60*60 ||
		!bytes.Equal(receipt.OutputTreeRoot[:], expectedOutputTreeRoot[:]) {
		return MaterializationReceipt{}, fmt.Errorf("%s integrity is invalid", name)
	}
	return receipt, nil
}

func ValidateMaterializationReceipt(
	receipt MaterializationReceipt,
	context ReceiptValidationContext,
) error {
	now := context.Now.Unix()
	if receipt.CreatorID != context.CreatorID ||
		receipt.GrantID != context.GrantID ||
		receipt.JobID != context.JobID ||
		receipt.ProductID != context.ProductID ||
		!bytes.Equal(receipt.ReleaseRoot[:], context.ReleaseRoot) ||
		now < receipt.IssuedAt ||
		now >= receipt.ExpiresAt {
		return fmt.Errorf("materialization receipt binding is invalid")
	}
	return nil
}

func outputTreeRoot(files []MaterializedFile) [32]byte {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("yucp:output-tree:v2"))
	for _, file := range files {
		size := binary.BigEndian.AppendUint64(nil, uint64(file.Bytes))
		for _, field := range [][]byte{
			[]byte(file.NormalizedPath),
			file.SHA256[:],
			size,
		} {
			_, _ = hasher.Write(binary.BigEndian.AppendUint64(nil, uint64(len(field))))
			_, _ = hasher.Write(field)
		}
	}
	var result [32]byte
	copy(result[:], hasher.Sum(nil))
	return result
}
