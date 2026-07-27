package runtimecontract

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
)

const (
	BrokerTargetName  = "broker/windows-amd64/yucp-package-broker.exe"
	HelperTargetName  = "helper/windows-amd64/yucp-transfer-helper.exe"
	Platform          = "windows-amd64"
	RuntimeTargetName = "runtime/windows-amd64/package-runtime.json"
	TrustTargetName   = "package-install-trust.json"
)

type Descriptor struct {
	APIBaseURL    string `json:"apiBaseUrl"`
	AuthBaseURL   string `json:"authBaseUrl"`
	BrokerTarget  string `json:"brokerTarget"`
	HelperTarget  string `json:"helperTarget"`
	MetadataURL   string `json:"metadataUrl"`
	PipeName      string `json:"pipeName"`
	Platform      string `json:"platform"`
	SchemaVersion int    `json:"schemaVersion"`
	TargetsURL    string `json:"targetsUrl"`
	TrustTarget   string `json:"trustTarget"`
}

type Config struct {
	APIBaseURL  string
	AuthBaseURL string
	MetadataURL string
	PipeName    string
	TargetsURL  string
}

func Marshal(config Config) ([]byte, error) {
	value := Descriptor{
		APIBaseURL:    config.APIBaseURL,
		AuthBaseURL:   config.AuthBaseURL,
		BrokerTarget:  BrokerTargetName,
		HelperTarget:  HelperTargetName,
		MetadataURL:   config.MetadataURL,
		PipeName:      config.PipeName,
		Platform:      Platform,
		SchemaVersion: 1,
		TargetsURL:    config.TargetsURL,
		TrustTarget:   TrustTargetName,
	}
	if err := Validate(value); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode package runtime descriptor: %w", err)
	}
	return raw, nil
}

func Parse(raw []byte) (Descriptor, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var value Descriptor
	if err := decoder.Decode(&value); err != nil {
		return Descriptor{}, fmt.Errorf("decode package runtime descriptor: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Descriptor{}, fmt.Errorf("package runtime descriptor contains trailing data")
	}
	if err := Validate(value); err != nil {
		return Descriptor{}, err
	}
	return value, nil
}

func Validate(value Descriptor) error {
	if value.SchemaVersion != 1 ||
		value.Platform != Platform ||
		value.HelperTarget != HelperTargetName ||
		value.BrokerTarget != BrokerTargetName ||
		value.TrustTarget != TrustTargetName ||
		strings.TrimSpace(value.PipeName) == "" {
		return fmt.Errorf("package runtime descriptor is invalid")
	}
	for name, raw := range map[string]string{
		"API":           value.APIBaseURL,
		"authorization": value.AuthBaseURL,
		"metadata":      value.MetadataURL,
		"targets":       value.TargetsURL,
	} {
		if _, err := CanonicalURL(raw); err != nil {
			return fmt.Errorf("package runtime %s URL: %w", name, err)
		}
	}
	return nil
}

func CanonicalURL(raw string) (string, error) {
	if raw != strings.TrimSpace(raw) || strings.HasSuffix(raw, "/") {
		return "", fmt.Errorf("URL is not canonical")
	}
	parsed, err := url.Parse(raw)
	if err != nil ||
		!parsed.IsAbs() ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", fmt.Errorf("URL is invalid")
	}
	if parsed.Scheme != "https" &&
		!(parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return "", fmt.Errorf("URL must use HTTPS")
	}
	if parsed.String() != raw {
		return "", fmt.Errorf("URL is not canonical")
	}
	return raw, nil
}

func isLoopback(host string) bool {
	return strings.EqualFold(host, "localhost") || net.ParseIP(host).IsLoopback()
}
