package main

import (
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
	subject := flags.String("subject", "", "local development certificate subject")
	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	if flags.NArg() != 0 || strings.TrimSpace(*subject) == "" {
		fmt.Fprintln(os.Stderr, "usage: yucp-local-authenticode-sign --subject <CN> --artifact <path>...")
		os.Exit(2)
	}

	thumbprint, _, err := localauthenticode.SignFiles(paths, *subject, time.Now())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	result, err := json.Marshal(struct {
		Thumbprint string `json:"thumbprint"`
	}{Thumbprint: thumbprint})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(result))
}
