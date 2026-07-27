package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/localauthenticode"
)

type artifactPaths []string

func (paths *artifactPaths) String() string {
	return strings.Join(*paths, ",")
}

func (paths *artifactPaths) Set(value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("artifact path is required")
	}
	*paths = append(*paths, trimmed)
	return nil
}

func main() {
	flags := flag.NewFlagSet("yucp-local-authenticode-sign", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var paths artifactPaths
	flags.Var(&paths, "artifact", "Windows PE artifact to sign")
	expectedCertificateSHA256 := flags.String(
		"certificate-sha256",
		"",
		"expected local publisher certificate SHA-256",
	)
	subject := flags.String("subject", "", "local development certificate subject")
	verifyOnly := flags.Bool("verify", false, "verify signed artifacts without changing them")
	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	if flags.NArg() != 0 ||
		strings.TrimSpace(*subject) == "" ||
		len(paths) == 0 ||
		(*verifyOnly && strings.TrimSpace(*expectedCertificateSHA256) == "") ||
		(!*verifyOnly && *expectedCertificateSHA256 != "") {
		fmt.Fprintln(
			os.Stderr,
			"usage: yucp-local-authenticode-sign [--verify --certificate-sha256 <sha256>] --subject <CN> --artifact <path>...",
		)
		os.Exit(2)
	}

	if *verifyOnly {
		for _, artifactPath := range paths {
			if err := localauthenticode.VerifyFile(
				artifactPath,
				*subject,
				*expectedCertificateSHA256,
				time.Now(),
			); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		return
	}

	_, certificate, err := localauthenticode.SignFiles(paths, *subject, time.Now())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	certificateSHA256 := sha256.Sum256(certificate.Raw)
	result, err := json.Marshal(struct {
		CertificateSHA256 string `json:"certificateSha256"`
		Subject           string `json:"subject"`
	}{
		CertificateSHA256: hex.EncodeToString(certificateSHA256[:]),
		Subject:           certificate.Subject.String(),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(result))
}
