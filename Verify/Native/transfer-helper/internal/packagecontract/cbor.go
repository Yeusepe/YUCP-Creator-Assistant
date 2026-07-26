package packagecontract

import (
	"bytes"
	"fmt"
	"reflect"

	"github.com/fxamacker/cbor/v2"
)

const (
	maxArrayElements = 100_000
	maxMapPairs      = 100_000
	maxNestedLevels  = 16
)

var (
	packageDecMode = mustPackageDecMode()
	packageEncMode = mustPackageEncMode()
)

// CBOR library API: https://pkg.go.dev/github.com/fxamacker/cbor/v2
func mustPackageDecMode() cbor.DecMode {
	simpleValues, err := cbor.NewSimpleValueRegistryFromDefaults(
		cbor.WithRejectedSimpleValue(cbor.SimpleValue(23)),
	)
	if err != nil {
		panic(fmt.Sprintf("create package CBOR simple-value registry: %v", err))
	}
	mode, err := (cbor.DecOptions{
		DupMapKey:        cbor.DupMapKeyEnforcedAPF,
		IndefLength:      cbor.IndefLengthForbidden,
		Inf:              cbor.InfDecodeForbidden,
		IntDec:           cbor.IntDecConvertSignedOrFail,
		MaxArrayElements: maxArrayElements,
		MaxMapPairs:      maxMapPairs,
		MaxNestedLevels:  maxNestedLevels,
		NaN:              cbor.NaNDecodeForbidden,
		SimpleValues:     simpleValues,
		TagsMd:           cbor.TagsForbidden,
		UTF8:             cbor.UTF8RejectInvalid,
	}).DecMode()
	if err != nil {
		panic(fmt.Sprintf("create package CBOR decoder: %v", err))
	}
	return mode
}

func mustPackageEncMode() cbor.EncMode {
	mode, err := cbor.CoreDetEncOptions().EncMode()
	if err != nil {
		panic(fmt.Sprintf("create package CBOR encoder: %v", err))
	}
	return mode
}

func DecodeCanonical(data []byte) (any, error) {
	var value any
	if err := packageDecMode.Unmarshal(data, &value); err != nil {
		return nil, fmt.Errorf("decode deterministic package CBOR: %w", err)
	}
	if err := validateCBORSubset(value, "CBOR value"); err != nil {
		return nil, err
	}
	canonical, err := packageEncMode.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("re-encode deterministic package CBOR: %w", err)
	}
	if !bytes.Equal(data, canonical) {
		return nil, fmt.Errorf("package contract CBOR is not deterministic RFC 8949 encoding")
	}
	return value, nil
}

func EncodeCanonical(value any) ([]byte, error) {
	if err := validateCBORSubset(value, "CBOR value"); err != nil {
		return nil, err
	}
	data, err := packageEncMode.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode deterministic package CBOR: %w", err)
	}
	return data, nil
}

func validateCBORSubset(value any, path string) error {
	switch typed := value.(type) {
	case nil, bool, int64, string, []byte:
		return nil
	case []any:
		for index, item := range typed {
			if err := validateCBORSubset(item, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
		return nil
	case map[any]any:
		for key, item := range typed {
			switch key.(type) {
			case int64, string:
			default:
				return fmt.Errorf("%s contains an unsupported map key", path)
			}
			if err := validateCBORSubset(item, fmt.Sprintf("%s.%v", path, key)); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("%s contains unsupported CBOR type %s", path, reflect.TypeOf(value))
	}
}

func requireArray(value any, name string) ([]any, error) {
	array, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a CBOR array", name)
	}
	return array, nil
}

func requireMap(value any, name string) (map[any]any, error) {
	mapped, ok := value.(map[any]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a CBOR map", name)
	}
	return mapped, nil
}

func requireBytes(value any, name string, length int) ([]byte, error) {
	data, ok := value.([]byte)
	if !ok || (length >= 0 && len(data) != length) {
		if length >= 0 {
			return nil, fmt.Errorf("%s must be a %d-byte string", name, length)
		}
		return nil, fmt.Errorf("%s must be a byte string", name)
	}
	return append([]byte(nil), data...), nil
}

func requireInt(value any, name string) (int64, error) {
	number, ok := value.(int64)
	if !ok {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return number, nil
}

func requireString(value any, name string) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" {
		return "", fmt.Errorf("%s must be a non-empty text string", name)
	}
	return text, nil
}

func requireExactIntegerLabels(mapped map[any]any, labels []int64, name string) error {
	if len(mapped) != len(labels) {
		return fmt.Errorf("%s contains missing or unknown labels", name)
	}
	allowed := make(map[int64]struct{}, len(labels))
	for _, label := range labels {
		allowed[label] = struct{}{}
	}
	for key := range mapped {
		label, ok := key.(int64)
		if !ok {
			return fmt.Errorf("%s contains a non-integer label", name)
		}
		if _, ok := allowed[label]; !ok {
			return fmt.Errorf("%s contains unknown label %d", name, label)
		}
	}
	return nil
}
