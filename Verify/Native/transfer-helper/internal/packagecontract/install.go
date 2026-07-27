package packagecontract

import (
	"bytes"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

const (
	DeliveryGrantPurpose    = "delivery-grant-v2"
	InstallSessionPurpose   = "install-session-v2"
	InstallSessionTokenType = "YUCP-InstallSession"
	maxInstallLifetime      = int64(15 * 60)
)

type InstallBootstrap struct {
	Kind   string
	SHA256 [32]byte
	URL    string
}

type InstallSession struct {
	AliasID                string
	AllowedAPIOrigins      []string
	AllowedArtifactOrigins []string
	Audience               string
	BindingRoot            [32]byte
	Bootstrap              InstallBootstrap
	BuyerID                string
	CreatorID              string
	DeviceKeyThumbprint    [32]byte
	ExpiresAt              int64
	IssuedAt               int64
	Issuer                 string
	KeyID                  string
	MaxLifetimeSeconds     int64
	NotBefore              int64
	Operation              string
	ProductID              string
	ReleaseRoot            [32]byte
	SessionID              string
	Version                string
}

type DeliveryGrant struct {
	Audience            string
	BindingRoot         [32]byte
	BuyerID             string
	CreatorID           string
	DeviceKeyThumbprint [32]byte
	ExpiresAt           int64
	GrantID             string
	InstallSessionID    string
	IssuedAt            int64
	Issuer              string
	NotBefore           int64
	ProductID           string
	ReleaseRoot         [32]byte
	Scopes              []string
}

type InstallAuthorizationContext struct {
	AliasID             string
	DeviceKeyThumbprint []byte
	ExpectedReleaseRoot []byte
	Now                 time.Time
	Operation           string
}

func ParseInstallSession(payload []byte) (InstallSession, error) {
	decoded, err := DecodeCanonical(payload)
	if err != nil {
		return InstallSession{}, err
	}
	mapped, err := requireMap(decoded, "InstallSessionV2")
	if err != nil {
		return InstallSession{}, err
	}
	labels := make([]int64, 22)
	for index := range labels {
		labels[index] = int64(index)
	}
	if err := requireExactIntegerLabels(mapped, labels, "InstallSessionV2"); err != nil {
		return InstallSession{}, err
	}
	version, err := requireInt(mapped[int64(0)], "InstallSessionV2.schemaVersion")
	if err != nil || version != 2 {
		return InstallSession{}, fmt.Errorf("InstallSessionV2 schema version is invalid")
	}
	tokenType, err := requireString(mapped[int64(1)], "InstallSessionV2.tokenType")
	if err != nil || tokenType != InstallSessionTokenType {
		return InstallSession{}, fmt.Errorf("InstallSessionV2 token type is invalid")
	}
	bootstrapValues, err := requireArray(mapped[int64(15)], "InstallSessionV2.bootstrap")
	if err != nil || len(bootstrapValues) != 1 {
		return InstallSession{}, fmt.Errorf("InstallSessionV2 must contain one logical-tree bootstrap")
	}
	bootstrapMap, err := requireMap(bootstrapValues[0], "InstallSessionV2.bootstrap[0]")
	if err != nil {
		return InstallSession{}, err
	}
	if err := requireExactIntegerLabels(
		bootstrapMap,
		[]int64{0, 1, 2},
		"InstallSessionV2.bootstrap[0]",
	); err != nil {
		return InstallSession{}, err
	}
	kind, err := requireString(bootstrapMap[int64(0)], "InstallSessionV2.bootstrap[0].kind")
	if err != nil || kind != "logical-tree-manifest-v4" {
		return InstallSession{}, fmt.Errorf("InstallSessionV2 bootstrap kind is unsupported")
	}
	bootstrapURL, err := requireString(
		bootstrapMap[int64(1)],
		"InstallSessionV2.bootstrap[0].url",
	)
	if err != nil {
		return InstallSession{}, err
	}
	bootstrapDigest, err := requireDigest(
		bootstrapMap[int64(2)],
		"InstallSessionV2.bootstrap[0].sha256",
	)
	if err != nil {
		return InstallSession{}, err
	}
	apiOrigins, err := requireStringArray(
		mapped[int64(13)],
		"InstallSessionV2.allowedApiOrigins",
		16,
	)
	if err != nil {
		return InstallSession{}, err
	}
	artifactOrigins, err := requireStringArray(
		mapped[int64(14)],
		"InstallSessionV2.allowedArtifactOrigins",
		16,
	)
	if err != nil {
		return InstallSession{}, err
	}
	session := InstallSession{
		AllowedAPIOrigins:      apiOrigins,
		AllowedArtifactOrigins: artifactOrigins,
		BindingRoot:            [32]byte{},
		Bootstrap: InstallBootstrap{
			Kind:   kind,
			SHA256: bootstrapDigest,
			URL:    bootstrapURL,
		},
		DeviceKeyThumbprint: [32]byte{},
		ReleaseRoot:         [32]byte{},
	}
	for field, destination := range map[int64]*string{
		2:  &session.Issuer,
		3:  &session.Audience,
		4:  &session.KeyID,
		5:  &session.CreatorID,
		6:  &session.BuyerID,
		7:  &session.ProductID,
		8:  &session.Version,
		9:  &session.AliasID,
		19: &session.SessionID,
		21: &session.Operation,
	} {
		value, fieldErr := requireString(mapped[field], fmt.Sprintf("InstallSessionV2.%d", field))
		if fieldErr != nil || len([]byte(value)) > 512 {
			return InstallSession{}, fmt.Errorf("InstallSessionV2 text claim %d is invalid", field)
		}
		*destination = value
	}
	for field, destination := range map[int64]*[32]byte{
		10: &session.ReleaseRoot,
		11: &session.BindingRoot,
		12: &session.DeviceKeyThumbprint,
	} {
		value, fieldErr := requireDigest(mapped[field], fmt.Sprintf("InstallSessionV2.%d", field))
		if fieldErr != nil {
			return InstallSession{}, fieldErr
		}
		*destination = value
	}
	for field, destination := range map[int64]*int64{
		16: &session.IssuedAt,
		17: &session.NotBefore,
		18: &session.ExpiresAt,
		20: &session.MaxLifetimeSeconds,
	} {
		value, fieldErr := requireInt(mapped[field], fmt.Sprintf("InstallSessionV2.%d", field))
		if fieldErr != nil {
			return InstallSession{}, fieldErr
		}
		*destination = value
	}
	if err := validateInstallSession(session); err != nil {
		return InstallSession{}, err
	}
	return session, nil
}

func ParseDeliveryGrant(payload []byte) (DeliveryGrant, error) {
	decoded, err := DecodeCanonical(payload)
	if err != nil {
		return DeliveryGrant{}, err
	}
	mapped, err := requireMap(decoded, "DeliveryGrantV2")
	if err != nil {
		return DeliveryGrant{}, err
	}
	labels := make([]int64, 15)
	for index := range labels {
		labels[index] = int64(index)
	}
	if err := requireExactIntegerLabels(mapped, labels, "DeliveryGrantV2"); err != nil {
		return DeliveryGrant{}, err
	}
	version, err := requireInt(mapped[int64(0)], "DeliveryGrantV2.schemaVersion")
	if err != nil || version != 2 {
		return DeliveryGrant{}, fmt.Errorf("DeliveryGrantV2 schema version is invalid")
	}
	scopes, err := requireStringArray(mapped[int64(13)], "DeliveryGrantV2.scopes", 16)
	if err != nil || len(scopes) == 0 {
		return DeliveryGrant{}, fmt.Errorf("DeliveryGrantV2 scopes are invalid")
	}
	grant := DeliveryGrant{Scopes: scopes}
	for field, destination := range map[int64]*string{
		1:  &grant.GrantID,
		2:  &grant.Issuer,
		3:  &grant.Audience,
		4:  &grant.CreatorID,
		5:  &grant.BuyerID,
		6:  &grant.ProductID,
		14: &grant.InstallSessionID,
	} {
		value, fieldErr := requireString(mapped[field], fmt.Sprintf("DeliveryGrantV2.%d", field))
		if fieldErr != nil || len([]byte(value)) > 512 {
			return DeliveryGrant{}, fmt.Errorf("DeliveryGrantV2 text claim %d is invalid", field)
		}
		*destination = value
	}
	for field, destination := range map[int64]*[32]byte{
		7: &grant.ReleaseRoot,
		8: &grant.BindingRoot,
		9: &grant.DeviceKeyThumbprint,
	} {
		value, fieldErr := requireDigest(mapped[field], fmt.Sprintf("DeliveryGrantV2.%d", field))
		if fieldErr != nil {
			return DeliveryGrant{}, fieldErr
		}
		*destination = value
	}
	for field, destination := range map[int64]*int64{
		10: &grant.IssuedAt,
		11: &grant.NotBefore,
		12: &grant.ExpiresAt,
	} {
		value, fieldErr := requireInt(mapped[field], fmt.Sprintf("DeliveryGrantV2.%d", field))
		if fieldErr != nil {
			return DeliveryGrant{}, fieldErr
		}
		*destination = value
	}
	if err := validateGrant(grant); err != nil {
		return DeliveryGrant{}, err
	}
	return grant, nil
}

func ValidateInstallAuthorization(
	session InstallSession,
	grant DeliveryGrant,
	context InstallAuthorizationContext,
) error {
	now := context.Now.Unix()
	if now < session.NotBefore || now >= session.ExpiresAt ||
		now < grant.NotBefore || now >= grant.ExpiresAt {
		return fmt.Errorf("package install authorization is not active")
	}
	if session.AliasID != context.AliasID ||
		session.Operation != context.Operation ||
		session.SessionID != grant.InstallSessionID ||
		session.Issuer != grant.Issuer ||
		session.Audience != grant.Audience ||
		session.BuyerID != grant.BuyerID ||
		session.CreatorID != grant.CreatorID ||
		session.ProductID != grant.ProductID ||
		!bytes.Equal(session.ReleaseRoot[:], context.ExpectedReleaseRoot) ||
		!bytes.Equal(session.ReleaseRoot[:], grant.ReleaseRoot[:]) ||
		!bytes.Equal(session.BindingRoot[:], grant.BindingRoot[:]) ||
		!bytes.Equal(session.DeviceKeyThumbprint[:], context.DeviceKeyThumbprint) ||
		!bytes.Equal(session.DeviceKeyThumbprint[:], grant.DeviceKeyThumbprint[:]) {
		return fmt.Errorf("package install authorization binding is invalid")
	}
	if session.Operation == "uninstall" {
		if grant.UninstallVersionID() == "" ||
			grant.PackageVersionID() != "" ||
			grant.MaterializationJobID() != "" {
			return fmt.Errorf("package uninstall authorization scope is invalid")
		}
	} else if grant.PackageVersionID() == "" || grant.UninstallVersionID() != "" {
		return fmt.Errorf("package install authorization scope is invalid")
	}
	return nil
}

func (grant DeliveryGrant) MaterializationJobID() string {
	const prefix = "materialization:"
	const suffix = ":read"
	for _, scope := range grant.Scopes {
		if strings.HasPrefix(scope, prefix) && strings.HasSuffix(scope, suffix) {
			return strings.TrimSuffix(strings.TrimPrefix(scope, prefix), suffix)
		}
	}
	return ""
}

func (grant DeliveryGrant) PackageVersionID() string {
	return scopedIdentifier(grant.Scopes, "package:", ":read")
}

func (grant DeliveryGrant) UninstallVersionID() string {
	return scopedIdentifier(grant.Scopes, "package:", ":uninstall")
}

func (grant DeliveryGrant) BoundPackageVersionID() string {
	if versionID := grant.PackageVersionID(); versionID != "" {
		return versionID
	}
	return grant.UninstallVersionID()
}

func scopedIdentifier(scopes []string, prefix string, suffix string) string {
	var identifier string
	for _, scope := range scopes {
		if !strings.HasPrefix(scope, prefix) {
			continue
		}
		if identifier != "" || !strings.HasSuffix(scope, suffix) {
			return ""
		}
		identifier = strings.TrimSuffix(strings.TrimPrefix(scope, prefix), suffix)
		if identifier == "" {
			return ""
		}
	}
	return identifier
}

func validateInstallSession(session InstallSession) error {
	switch session.Operation {
	case "install", "preflight", "recover", "repair", "rollback", "uninstall", "update":
	default:
		return fmt.Errorf("InstallSessionV2 operation is invalid")
	}
	if session.IssuedAt < 0 ||
		session.NotBefore < session.IssuedAt ||
		session.ExpiresAt <= session.NotBefore ||
		session.MaxLifetimeSeconds <= 0 ||
		session.MaxLifetimeSeconds > maxInstallLifetime ||
		session.ExpiresAt-session.IssuedAt > session.MaxLifetimeSeconds {
		return fmt.Errorf("InstallSessionV2 time claims are invalid")
	}
	apiOrigins, err := validateOriginList(session.AllowedAPIOrigins, "InstallSessionV2 API origins")
	if err != nil {
		return err
	}
	artifactOrigins, err := validateOriginList(
		session.AllowedArtifactOrigins,
		"InstallSessionV2 artifact origins",
	)
	if err != nil {
		return err
	}
	issuer, err := canonicalOrigin(session.Issuer)
	if err != nil || issuer != session.Issuer || !contains(apiOrigins, issuer) {
		return fmt.Errorf("InstallSessionV2 issuer is invalid")
	}
	audience, err := canonicalOrigin(session.Audience)
	if err != nil || audience != session.Audience || !contains(artifactOrigins, audience) {
		return fmt.Errorf("InstallSessionV2 audience is invalid")
	}
	bootstrapURL, err := url.Parse(session.Bootstrap.URL)
	if err != nil || bootstrapURL.User != nil || bootstrapURL.Fragment != "" ||
		!contains(append(apiOrigins, artifactOrigins...), bootstrapURL.Scheme+"://"+bootstrapURL.Host) {
		return fmt.Errorf("InstallSessionV2 bootstrap URL is outside allowed origins")
	}
	return nil
}

func validateGrant(grant DeliveryGrant) error {
	if grant.IssuedAt < 0 ||
		grant.NotBefore < grant.IssuedAt ||
		grant.ExpiresAt <= grant.NotBefore ||
		grant.ExpiresAt-grant.IssuedAt > maxInstallLifetime {
		return fmt.Errorf("DeliveryGrantV2 time claims are invalid")
	}
	if _, err := canonicalOrigin(grant.Issuer); err != nil {
		return fmt.Errorf("DeliveryGrantV2 issuer is invalid")
	}
	if _, err := canonicalOrigin(grant.Audience); err != nil {
		return fmt.Errorf("DeliveryGrantV2 audience is invalid")
	}
	for index, scope := range grant.Scopes {
		if scope == "" || len([]byte(scope)) > 512 ||
			(index > 0 && grant.Scopes[index-1] >= scope) {
			return fmt.Errorf("DeliveryGrantV2 scopes are not in strict UTF-8 order")
		}
	}
	return nil
}

func requireDigest(value any, name string) ([32]byte, error) {
	data, err := requireBytes(value, name, 32)
	if err != nil {
		return [32]byte{}, err
	}
	var digest [32]byte
	copy(digest[:], data)
	return digest, nil
}

func requireStringArray(value any, name string, max int) ([]string, error) {
	values, err := requireArray(value, name)
	if err != nil || len(values) == 0 || len(values) > max {
		return nil, fmt.Errorf("%s has an invalid item count", name)
	}
	result := make([]string, len(values))
	for index, item := range values {
		text, itemErr := requireString(item, fmt.Sprintf("%s[%d]", name, index))
		if itemErr != nil || len([]byte(text)) > 2_048 ||
			(index > 0 && result[index-1] >= text) {
			return nil, fmt.Errorf("%s is not in strict UTF-8 order", name)
		}
		result[index] = text
	}
	return result, nil
}

func validateOriginList(values []string, name string) ([]string, error) {
	if len(values) == 0 || len(values) > 16 {
		return nil, fmt.Errorf("%s has an invalid item count", name)
	}
	result := make([]string, len(values))
	for index, value := range values {
		origin, err := canonicalOrigin(value)
		if err != nil || origin != value || (index > 0 && result[index-1] >= origin) {
			return nil, fmt.Errorf("%s is invalid", name)
		}
		result[index] = origin
	}
	return result, nil
}

func canonicalOrigin(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", fmt.Errorf("origin is invalid")
	}
	if parsed.Scheme != "https" &&
		!(parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return "", fmt.Errorf("origin must use HTTPS or loopback HTTP")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
