package packagecontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"time"
)

const MaterializationReceiptPurpose = "materialization-receipt-v2"

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

type ReceiptValidationContext struct {
	CreatorID   string
	GrantID     string
	JobID       string
	Now         time.Time
	ProductID   string
	ReleaseRoot []byte
}

func ParseMaterializationReceipt(payload []byte) (MaterializationReceipt, error) {
	decoded, err := DecodeCanonical(payload)
	if err != nil {
		return MaterializationReceipt{}, err
	}
	mapped, err := requireMap(decoded, "MaterializationReceiptV2")
	if err != nil {
		return MaterializationReceipt{}, err
	}
	labels := make([]int64, 26)
	for index := range labels {
		labels[index] = int64(index)
	}
	if err := requireExactIntegerLabels(mapped, labels, "MaterializationReceiptV2"); err != nil {
		return MaterializationReceipt{}, err
	}
	version, err := requireInt(mapped[int64(0)], "MaterializationReceiptV2.schemaVersion")
	if err != nil || version != 2 {
		return MaterializationReceipt{}, fmt.Errorf("MaterializationReceiptV2 schema version is invalid")
	}
	outputValues, err := requireArray(mapped[int64(10)], "MaterializationReceiptV2.outputFiles")
	if err != nil || len(outputValues) == 0 || len(outputValues) > 512 {
		return MaterializationReceipt{}, fmt.Errorf("MaterializationReceiptV2 output file count is invalid")
	}
	outputFiles := make([]MaterializedFile, 0, len(outputValues))
	var previousPath string
	for index, value := range outputValues {
		fileMap, fileErr := requireMap(
			value,
			fmt.Sprintf("MaterializationReceiptV2.outputFiles[%d]", index),
		)
		if fileErr != nil {
			return MaterializationReceipt{}, fileErr
		}
		if fileErr := requireExactIntegerLabels(
			fileMap,
			[]int64{0, 1, 2, 3},
			fmt.Sprintf("MaterializationReceiptV2.outputFiles[%d]", index),
		); fileErr != nil {
			return MaterializationReceipt{}, fileErr
		}
		normalizedPath, fileErr := requireString(
			fileMap[int64(0)],
			fmt.Sprintf("MaterializationReceiptV2.outputFiles[%d].normalizedPath", index),
		)
		if fileErr != nil || ValidateNormalizedPath(normalizedPath) != nil ||
			(index > 0 && previousPath >= normalizedPath) {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 output file %d path is invalid",
				index,
			)
		}
		digest, fileErr := requireDigest(
			fileMap[int64(1)],
			fmt.Sprintf("MaterializationReceiptV2.outputFiles[%d].outputSha256", index),
		)
		if fileErr != nil {
			return MaterializationReceipt{}, fileErr
		}
		fileBytes, fileErr := requireInt(
			fileMap[int64(2)],
			fmt.Sprintf("MaterializationReceiptV2.outputFiles[%d].outputBytes", index),
		)
		if fileErr != nil || fileBytes < 0 {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 output file %d byte count is invalid",
				index,
			)
		}
		attributionID, fileErr := requireString(
			fileMap[int64(3)],
			fmt.Sprintf("MaterializationReceiptV2.outputFiles[%d].attributionId", index),
		)
		if fileErr != nil || len([]byte(attributionID)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 output file %d attribution is invalid",
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
		"MaterializationReceiptV2.createdPaths",
		512,
	)
	if err != nil || len(createdPaths) != len(outputFiles) {
		return MaterializationReceipt{}, fmt.Errorf("MaterializationReceiptV2 created paths are invalid")
	}
	for index, path := range createdPaths {
		if path != outputFiles[index].NormalizedPath {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 created paths do not match output files",
			)
		}
	}
	renditionMap, err := requireMap(
		mapped[int64(14)],
		"MaterializationReceiptV2.rendition",
	)
	if err != nil {
		return MaterializationReceipt{}, err
	}
	if err := requireExactIntegerLabels(
		renditionMap,
		[]int64{0, 1, 2},
		"MaterializationReceiptV2.rendition",
	); err != nil {
		return MaterializationReceipt{}, err
	}
	renditionFileIdentifier, err := requireString(
		renditionMap[int64(0)],
		"MaterializationReceiptV2.rendition.fileIdentifier",
	)
	if err != nil || len([]byte(renditionFileIdentifier)) > 512 {
		return MaterializationReceipt{}, fmt.Errorf(
			"MaterializationReceiptV2 rendition file identifier is invalid",
		)
	}
	renditionDigest, err := requireDigest(
		renditionMap[int64(1)],
		"MaterializationReceiptV2.rendition.objectSha256",
	)
	if err != nil {
		return MaterializationReceipt{}, err
	}
	renditionBytes, err := requireInt(
		renditionMap[int64(2)],
		"MaterializationReceiptV2.rendition.objectBytes",
	)
	if err != nil || renditionBytes <= 0 {
		return MaterializationReceipt{}, fmt.Errorf("MaterializationReceiptV2 rendition bytes are invalid")
	}
	receipt := MaterializationReceipt{
		OutputFiles: outputFiles,
		Rendition: ExactRendition{
			FileIdentifier: renditionFileIdentifier,
			ObjectBytes:    renditionBytes,
			ObjectSHA256:   renditionDigest,
		},
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
			fmt.Sprintf("MaterializationReceiptV2.%d", field),
		)
		if fieldErr != nil || len([]byte(value)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 text claim %d is invalid",
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
			fmt.Sprintf("MaterializationReceiptV2.%d", field),
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
			fmt.Sprintf("MaterializationReceiptV2.%d", field),
		)
		if fieldErr != nil {
			return MaterializationReceipt{}, fieldErr
		}
		*destination = value
	}
	for _, field := range []int64{2, 4, 5, 15, 16, 17, 19, 20, 24} {
		value, fieldErr := requireString(
			mapped[field],
			fmt.Sprintf("MaterializationReceiptV2.%d", field),
		)
		if fieldErr != nil || len([]byte(value)) > 512 {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 text claim %d is invalid",
				field,
			)
		}
	}
	for _, field := range []int64{13, 18} {
		value, fieldErr := requireInt(
			mapped[field],
			fmt.Sprintf("MaterializationReceiptV2.%d", field),
		)
		if fieldErr != nil || value < 0 {
			return MaterializationReceipt{}, fmt.Errorf(
				"MaterializationReceiptV2 integer claim %d is invalid",
				field,
			)
		}
	}
	if _, err := requireDigest(
		mapped[int64(8)],
		"MaterializationReceiptV2.protectedSourceRoot",
	); err != nil {
		return MaterializationReceipt{}, err
	}
	expectedOutputTreeRoot := outputTreeRoot(outputFiles)
	if receipt.IssuedAt < 0 ||
		receipt.ExpiresAt <= receipt.IssuedAt ||
		receipt.ExpiresAt-receipt.IssuedAt > 30*24*60*60 ||
		!bytes.Equal(receipt.OutputTreeRoot[:], expectedOutputTreeRoot[:]) {
		return MaterializationReceipt{}, fmt.Errorf("MaterializationReceiptV2 integrity is invalid")
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
