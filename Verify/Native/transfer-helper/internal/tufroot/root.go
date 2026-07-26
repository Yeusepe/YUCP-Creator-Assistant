package tufroot

import (
	"crypto"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"slices"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const (
	maxRootBytes = 4 * 1024 * 1024
	maxRootKeys  = 10
)

type Manifest struct {
	Expires            string   `json:"expires"`
	RootPublicKeys     []string `json:"rootPublicKeys"`
	RootThreshold      int      `json:"rootThreshold"`
	SchemaVersion      int      `json:"schemaVersion"`
	SnapshotPublicKey  string   `json:"snapshotPublicKey"`
	TargetsPublicKey   string   `json:"targetsPublicKey"`
	TimestampPublicKey string   `json:"timestampPublicKey"`
	Version            int64    `json:"version"`
}

func Create(manifest Manifest, now time.Time) ([]byte, error) {
	if now.IsZero() {
		return nil, fmt.Errorf("TUF root reference time is required")
	}
	if manifest.SchemaVersion != 1 ||
		manifest.Version < 1 ||
		len(manifest.RootPublicKeys) < 3 ||
		len(manifest.RootPublicKeys) > maxRootKeys ||
		manifest.RootThreshold < 2 ||
		manifest.RootThreshold > len(manifest.RootPublicKeys) {
		return nil, fmt.Errorf("TUF root manifest policy is invalid")
	}
	expires, err := time.Parse(time.RFC3339, manifest.Expires)
	if err != nil || !expires.After(now.UTC()) {
		return nil, fmt.Errorf("TUF root expiry must be a future RFC 3339 value")
	}

	root := metadata.Root(expires.UTC())
	root.Signed.ConsistentSnapshot = true
	root.Signed.Version = manifest.Version
	seen := make(map[string]string)
	add := func(encoded string, role string) error {
		key, keyID, err := parsePublicKey(encoded)
		if err != nil {
			return fmt.Errorf("TUF %s public key: %w", role, err)
		}
		if existingRole, exists := seen[keyID]; exists {
			return fmt.Errorf("TUF key is reused by %s and %s", existingRole, role)
		}
		seen[keyID] = role
		return root.Signed.AddKey(key, role)
	}
	for _, encoded := range manifest.RootPublicKeys {
		if err := add(encoded, metadata.ROOT); err != nil {
			return nil, err
		}
	}
	for role, encoded := range map[string]string{
		metadata.SNAPSHOT:  manifest.SnapshotPublicKey,
		metadata.TARGETS:   manifest.TargetsPublicKey,
		metadata.TIMESTAMP: manifest.TimestampPublicKey,
	} {
		if err := add(encoded, role); err != nil {
			return nil, err
		}
	}
	root.Signed.Roles[metadata.ROOT].Threshold = manifest.RootThreshold
	if err := validate(root, now.UTC(), false); err != nil {
		return nil, err
	}
	encoded, err := root.ToBytes(false)
	if err != nil {
		return nil, fmt.Errorf("encode unsigned TUF root: %w", err)
	}
	return encoded, nil
}

func AddSignature(rootBytes []byte, seed []byte, now time.Time) ([]byte, bool, error) {
	root, err := decode(rootBytes)
	if err != nil {
		return nil, false, err
	}
	if err := validate(root, now.UTC(), false); err != nil {
		return nil, false, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, false, fmt.Errorf("TUF root signing seed length is invalid")
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	key, err := metadata.KeyFromPublicKey(privateKey.Public())
	if err != nil {
		return nil, false, fmt.Errorf("describe TUF root signing key: %w", err)
	}
	keyID, err := key.ID()
	if err != nil {
		return nil, false, fmt.Errorf("identify TUF root signing key: %w", err)
	}
	if !slices.Contains(root.Signed.Roles[metadata.ROOT].KeyIDs, keyID) {
		return nil, false, fmt.Errorf("TUF root signing key is not authorized")
	}
	for _, existing := range root.Signatures {
		if existing.KeyID == keyID {
			return nil, false, fmt.Errorf("TUF root signing key already signed this version")
		}
	}
	signer, err := signature.LoadSigner(privateKey, crypto.Hash(0))
	if err != nil {
		return nil, false, fmt.Errorf("load TUF root signer: %w", err)
	}
	if _, err := root.Sign(signer); err != nil {
		return nil, false, fmt.Errorf("sign TUF root: %w", err)
	}
	encoded, err := root.ToBytes(false)
	if err != nil {
		return nil, false, fmt.Errorf("encode signed TUF root: %w", err)
	}
	complete := root.VerifyDelegate(metadata.ROOT, root) == nil
	return encoded, complete, nil
}

func Verify(rootBytes []byte, now time.Time) error {
	root, err := decode(rootBytes)
	if err != nil {
		return err
	}
	if err := validate(root, now.UTC(), true); err != nil {
		return err
	}
	return nil
}

func decode(rootBytes []byte) (*metadata.Metadata[metadata.RootType], error) {
	if len(rootBytes) < 1 || len(rootBytes) > maxRootBytes {
		return nil, fmt.Errorf("TUF root length is invalid")
	}
	var decoder metadata.Metadata[metadata.RootType]
	root, err := decoder.FromBytes(rootBytes)
	if err != nil {
		return nil, fmt.Errorf("decode TUF root: %w", err)
	}
	return root, nil
}

func validate(
	root *metadata.Metadata[metadata.RootType],
	now time.Time,
	requireThreshold bool,
) error {
	if now.IsZero() {
		return fmt.Errorf("TUF root reference time is required")
	}
	if root.Signed.Version < 1 ||
		!root.Signed.ConsistentSnapshot ||
		root.Signed.IsExpired(now) ||
		len(root.Signed.Roles) != 4 {
		return fmt.Errorf("TUF root policy is invalid")
	}
	rootRole := root.Signed.Roles[metadata.ROOT]
	if rootRole == nil ||
		len(rootRole.KeyIDs) < 3 ||
		len(rootRole.KeyIDs) > maxRootKeys ||
		rootRole.Threshold < 2 ||
		rootRole.Threshold > len(rootRole.KeyIDs) {
		return fmt.Errorf("TUF root threshold policy is invalid")
	}
	allRoleKeys := make(map[string]string)
	for _, role := range []string{
		metadata.ROOT,
		metadata.TARGETS,
		metadata.SNAPSHOT,
		metadata.TIMESTAMP,
	} {
		roleValue := root.Signed.Roles[role]
		if roleValue == nil {
			return fmt.Errorf("TUF %s role is missing", role)
		}
		if role != metadata.ROOT &&
			(roleValue.Threshold != 1 || len(roleValue.KeyIDs) != 1) {
			return fmt.Errorf("TUF %s role policy is invalid", role)
		}
		for _, keyID := range roleValue.KeyIDs {
			if existingRole, exists := allRoleKeys[keyID]; exists {
				return fmt.Errorf("TUF key is reused by %s and %s", existingRole, role)
			}
			allRoleKeys[keyID] = role
			key := root.Signed.Keys[keyID]
			if key == nil || key.Type != "ed25519" || key.Scheme != "ed25519" {
				return fmt.Errorf("TUF %s role key is invalid", role)
			}
			actualID, err := key.ID()
			if err != nil || actualID != keyID {
				return fmt.Errorf("TUF %s role key identifier is invalid", role)
			}
		}
	}
	if len(root.Signed.Keys) != len(allRoleKeys) {
		return fmt.Errorf("TUF root contains an unassigned key")
	}
	seenSignatures := make(map[string]struct{}, len(root.Signatures))
	for _, value := range root.Signatures {
		if !slices.Contains(rootRole.KeyIDs, value.KeyID) {
			return fmt.Errorf("TUF root contains an unauthorized signature")
		}
		if _, exists := seenSignatures[value.KeyID]; exists {
			return fmt.Errorf("TUF root contains a duplicate signature")
		}
		seenSignatures[value.KeyID] = struct{}{}
	}
	if requireThreshold {
		if err := root.VerifyDelegate(metadata.ROOT, root); err != nil {
			return fmt.Errorf("verify TUF root threshold: %w", err)
		}
	}
	return nil
}

func parsePublicKey(encoded string) (*metadata.Key, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil ||
		len(raw) != ed25519.PublicKeySize ||
		base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return nil, "", fmt.Errorf("key must be canonical base64url Ed25519 public bytes")
	}
	key, err := metadata.KeyFromPublicKey(ed25519.PublicKey(raw))
	if err != nil {
		return nil, "", fmt.Errorf("describe key: %w", err)
	}
	keyID, err := key.ID()
	if err != nil {
		return nil, "", fmt.Errorf("identify key: %w", err)
	}
	return key, keyID, nil
}
