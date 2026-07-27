package packagecontract

import (
	"bytes"
	"fmt"
	"regexp"
	"time"
)

const (
	PackageOperationCapabilityPurpose = "package-operation-capability-v2"
	maxPackageOperationLifetime       = int64(5 * 60)
)

var traceparentPattern = regexp.MustCompile(
	`^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$`,
)

type PackageOperationCapability struct {
	AliasID                     string
	ApprovedActiveContentDigest *[32]byte
	ApprovedPolicyVersion       string
	Audience                    string
	BuyerID                     string
	CapabilityID                string
	DeviceKeyThumbprint         [32]byte
	ExpectedCurrentReleaseRoot  [32]byte
	ExpiresAt                   int64
	IdempotencyKey              string
	IssuedAt                    int64
	Issuer                      string
	NotBefore                   int64
	OneUseNonce                 [32]byte
	Operation                   string
	ProjectIdentity             [32]byte
	ReleaseRoot                 [32]byte
	Traceparent                 string
}

type PackageOperationCapabilityContext struct {
	AliasID                     string
	ApprovedActiveContentDigest []byte
	ApprovedPolicyVersion       string
	Audience                    string
	DeviceKeyThumbprint         []byte
	ExpectedCurrentReleaseRoot  [32]byte
	IdempotencyKey              string
	Issuer                      string
	Now                         time.Time
	Operation                   string
	ProjectIdentity             []byte
	ReleaseRoot                 []byte
	Traceparent                 string
}

func ParsePackageOperationCapability(payload []byte) (PackageOperationCapability, error) {
	decoded, err := DecodeCanonical(payload)
	if err != nil {
		return PackageOperationCapability{}, err
	}
	mapped, err := requireMap(decoded, "PackageOperationCapabilityV2")
	if err != nil {
		return PackageOperationCapability{}, err
	}
	labels := make([]int64, 19)
	for index := range labels {
		labels[index] = int64(index)
	}
	if err := requireExactIntegerLabels(mapped, labels, "PackageOperationCapabilityV2"); err != nil {
		return PackageOperationCapability{}, err
	}
	version, err := requireInt(mapped[int64(0)], "PackageOperationCapabilityV2.schemaVersion")
	if err != nil || version != 2 {
		return PackageOperationCapability{}, fmt.Errorf(
			"PackageOperationCapabilityV2 schema version is invalid",
		)
	}
	capability := PackageOperationCapability{}
	for field, destination := range map[int64]*string{
		1:  &capability.CapabilityID,
		2:  &capability.Issuer,
		3:  &capability.Audience,
		4:  &capability.BuyerID,
		5:  &capability.AliasID,
		8:  &capability.Operation,
		11: &capability.ApprovedPolicyVersion,
		12: &capability.IdempotencyKey,
		18: &capability.Traceparent,
	} {
		if mapped[field] == nil && field == 11 {
			continue
		}
		value, fieldErr := requireString(
			mapped[field],
			fmt.Sprintf("PackageOperationCapabilityV2.%d", field),
		)
		if fieldErr != nil || len([]byte(value)) > 512 {
			return PackageOperationCapability{}, fmt.Errorf(
				"PackageOperationCapabilityV2 text claim %d is invalid",
				field,
			)
		}
		*destination = value
	}
	for field, destination := range map[int64]*[32]byte{
		6:  &capability.ReleaseRoot,
		9:  &capability.ProjectIdentity,
		13: &capability.DeviceKeyThumbprint,
		14: &capability.OneUseNonce,
	} {
		value, fieldErr := requireDigest(
			mapped[field],
			fmt.Sprintf("PackageOperationCapabilityV2.%d", field),
		)
		if fieldErr != nil {
			return PackageOperationCapability{}, fieldErr
		}
		*destination = value
	}
	expectedRoot, err := requireDigest(
		mapped[int64(7)],
		"PackageOperationCapabilityV2.expectedCurrentReleaseRoot",
	)
	if err != nil {
		return PackageOperationCapability{}, err
	}
	capability.ExpectedCurrentReleaseRoot = expectedRoot
	approvalDigest, err := optionalDigest(
		mapped[int64(10)],
		"PackageOperationCapabilityV2.approvedActiveContentDigest",
	)
	if err != nil {
		return PackageOperationCapability{}, err
	}
	capability.ApprovedActiveContentDigest = approvalDigest
	for field, destination := range map[int64]*int64{
		15: &capability.IssuedAt,
		16: &capability.NotBefore,
		17: &capability.ExpiresAt,
	} {
		value, fieldErr := requireInt(
			mapped[field],
			fmt.Sprintf("PackageOperationCapabilityV2.%d", field),
		)
		if fieldErr != nil {
			return PackageOperationCapability{}, fieldErr
		}
		*destination = value
	}
	if err := validatePackageOperationCapability(capability); err != nil {
		return PackageOperationCapability{}, err
	}
	return capability, nil
}

func ValidatePackageOperationCapability(
	capability PackageOperationCapability,
	context PackageOperationCapabilityContext,
) error {
	if err := validatePackageOperationCapability(capability); err != nil {
		return err
	}
	now := context.Now.Unix()
	if now < capability.NotBefore || now >= capability.ExpiresAt {
		return fmt.Errorf("PackageOperationCapabilityV2 is not active")
	}
	if capability.AliasID != context.AliasID ||
		capability.ApprovedPolicyVersion != context.ApprovedPolicyVersion ||
		capability.Audience != context.Audience ||
		capability.IdempotencyKey != context.IdempotencyKey ||
		capability.Issuer != context.Issuer ||
		capability.Operation != context.Operation ||
		capability.Traceparent != context.Traceparent ||
		!bytes.Equal(capability.DeviceKeyThumbprint[:], context.DeviceKeyThumbprint) ||
		!bytes.Equal(capability.ProjectIdentity[:], context.ProjectIdentity) ||
		!bytes.Equal(capability.ReleaseRoot[:], context.ReleaseRoot) ||
		!bytes.Equal(
			capability.ExpectedCurrentReleaseRoot[:],
			context.ExpectedCurrentReleaseRoot[:],
		) ||
		!optionalDigestMatches(
			capability.ApprovedActiveContentDigest,
			context.ApprovedActiveContentDigest,
		) {
		return fmt.Errorf("PackageOperationCapabilityV2 binding is invalid")
	}
	return nil
}

func validatePackageOperationCapability(capability PackageOperationCapability) error {
	switch capability.Operation {
	case "install", "preflight", "recover", "repair", "rollback", "uninstall", "update":
	default:
		return fmt.Errorf("PackageOperationCapabilityV2 operation is invalid")
	}
	hasApproval := capability.ApprovedActiveContentDigest != nil ||
		capability.ApprovedPolicyVersion != ""
	if capability.Operation == "preflight" {
		if hasApproval {
			return fmt.Errorf("PackageOperationCapabilityV2 preflight approval is invalid")
		}
	} else if capability.ApprovedActiveContentDigest == nil ||
		capability.ApprovedPolicyVersion == "" {
		return fmt.Errorf("PackageOperationCapabilityV2 approval is required")
	}
	match := traceparentPattern.FindStringSubmatch(capability.Traceparent)
	if match == nil ||
		match[1] == "00000000000000000000000000000000" ||
		match[2] == "0000000000000000" {
		return fmt.Errorf("PackageOperationCapabilityV2 traceparent is invalid")
	}
	if capability.IssuedAt < 0 ||
		capability.NotBefore < capability.IssuedAt ||
		capability.ExpiresAt <= capability.NotBefore ||
		capability.ExpiresAt-capability.IssuedAt > maxPackageOperationLifetime {
		return fmt.Errorf("PackageOperationCapabilityV2 time claims are invalid")
	}
	issuer, err := canonicalOrigin(capability.Issuer)
	if err != nil || issuer != capability.Issuer {
		return fmt.Errorf("PackageOperationCapabilityV2 issuer is invalid")
	}
	audience, err := canonicalOrigin(capability.Audience)
	if err != nil || audience != capability.Audience {
		return fmt.Errorf("PackageOperationCapabilityV2 audience is invalid")
	}
	return nil
}

func optionalDigest(value any, name string) (*[32]byte, error) {
	if value == nil {
		return nil, nil
	}
	digest, err := requireDigest(value, name)
	if err != nil {
		return nil, err
	}
	return &digest, nil
}

func optionalDigestMatches(claim *[32]byte, expected []byte) bool {
	if claim == nil || expected == nil {
		return claim == nil && expected == nil
	}
	return bytes.Equal(claim[:], expected)
}
