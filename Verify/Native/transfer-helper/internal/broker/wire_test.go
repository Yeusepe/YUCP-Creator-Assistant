package broker

import "testing"

func TestValidateProgressAcceptsPersonalizingFileCounts(t *testing.T) {
	event := Progress{
		CompletedBytes: 31_000_000,
		CompletedFiles: 1240,
		Phase:          "personalizing",
		RunID:          "run-1",
		SchemaVersion:  BrokerProtocolSchemaVersion,
		Sequence:       7,
		TotalBytes:     311_000_000,
		TotalFiles:     2518,
	}
	if err := validateProgress(event); err != nil {
		t.Fatalf("validateProgress() error = %v", err)
	}
	event.CompletedFiles = event.TotalFiles + 1
	if err := validateProgress(event); err == nil {
		t.Fatal("validateProgress() accepted more completed files than total")
	}
	event.CompletedFiles = -1
	if err := validateProgress(event); err == nil {
		t.Fatal("validateProgress() accepted a negative file count")
	}
}

func TestValidateProgressKeepsExistingPhases(t *testing.T) {
	for _, phase := range []string{
		"preparing",
		"signing-in",
		"verifying-access",
		"downloading",
		"verifying",
		"assembling",
		"finalizing",
	} {
		event := Progress{
			CompletedBytes: 1,
			Phase:          phase,
			RunID:          "run-1",
			SchemaVersion:  BrokerProtocolSchemaVersion,
			Sequence:       1,
			TotalBytes:     2,
		}
		if err := validateProgress(event); err != nil {
			t.Fatalf("validateProgress(%q) error = %v", phase, err)
		}
	}
}
