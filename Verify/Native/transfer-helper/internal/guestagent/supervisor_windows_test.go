//go:build windows

package guestagent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const jobObjectHelperVariable = "YUCP_GUEST_AGENT_JOB_OBJECT_HELPER"

func TestWindowsJobObjectSupervisorHelper(t *testing.T) {
	mode := os.Getenv(jobObjectHelperVariable)
	switch mode {
	case "":
		return
	case "grandchild":
		for {
			time.Sleep(time.Hour)
		}
	case "driver-with-grandchild":
		grandchild := exec.Command(os.Args[0], "-test.run=TestWindowsJobObjectSupervisorHelper")
		grandchild.Env = append(
			[]string{jobObjectHelperVariable + "=grandchild"},
			minimalTestEnvironment()...,
		)
		if err := grandchild.Start(); err != nil {
			t.Fatal(err)
		}
		pidPath := os.Getenv("YUCP_GUEST_AGENT_GRANDCHILD_PID_PATH")
		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(grandchild.Process.Pid)), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	case "supervisor-success", "supervisor-kill":
	case "supervisor-secret-scan":
	default:
		t.Fatalf("unknown Job Object helper mode %q", mode)
	}
	supervisor, err := NewWindowsJobObjectSupervisor()
	if err != nil {
		t.Fatal(err)
	}
	supervisor.childExitTimeout = 250 * time.Millisecond
	executable := `C:\Windows\System32\cmd.exe`
	arguments := []string{"/d", "/s", "/c", "exit 0"}
	environment := []string{`SYSTEMROOT=C:\Windows`}
	if mode == "supervisor-kill" {
		executable = os.Args[0]
		arguments = []string{"-test.run=TestWindowsJobObjectSupervisorHelper"}
		environment = append(
			[]string{
				jobObjectHelperVariable + "=driver-with-grandchild",
				"YUCP_GUEST_AGENT_GRANDCHILD_PID_PATH=" +
					os.Getenv("YUCP_GUEST_AGENT_GRANDCHILD_PID_PATH"),
			},
			minimalTestEnvironment()...,
		)
	} else if mode == "supervisor-secret-scan" {
		arguments = []string{"/d", "/s", "/c", "echo " + secretSentinel}
	}
	result, err := supervisor.Run(context.Background(), Command{
		Arguments:   arguments,
		Environment: environment,
		Executable:  executable,
		SensitiveValues: []string{
			secretSentinel,
		},
	})
	if mode == "supervisor-secret-scan" {
		if err == nil || !strings.Contains(err.Error(), "sensitive") {
			t.Fatalf("expected sensitive output rejection, got result=%+v error=%v", result, err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	expectedChildrenExited := mode == "supervisor-success"
	if result.ExitCode != 0 ||
		!result.KillOnJobClose ||
		result.AllChildrenExited != expectedChildrenExited {
		t.Fatalf("unexpected Job Object result: %+v", result)
	}
}

func TestWindowsJobObjectRejectsSensitiveChildOutput(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=TestWindowsJobObjectSupervisorHelper")
	command.Env = append(
		[]string{jobObjectHelperVariable + "=supervisor-secret-scan"},
		minimalTestEnvironment()...,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Job Object helper failed: %v, output=%q", err, output)
	}
	if strings.Contains(string(output), secretSentinel) {
		t.Fatal("Job Object helper output contains the secret sentinel")
	}
}

func TestWindowsJobObjectSupervisorContainsTheProcessTree(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=TestWindowsJobObjectSupervisorHelper")
	command.Env = append(
		[]string{jobObjectHelperVariable + "=supervisor-success"},
		minimalTestEnvironment()...,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Job Object helper failed: %v, output=%q", err, output)
	}
	if strings.Contains(string(output), "PACKAGE_LIFECYCLE_SECRET_SENTINEL") {
		t.Fatal("Job Object helper output contains the secret sentinel")
	}
}

func TestWindowsJobObjectKillsSurvivingGrandchildWhenOwnerExits(t *testing.T) {
	root := t.TempDir()
	pidPath := filepath.Join(root, "grandchild.pid")
	command := exec.Command(os.Args[0], "-test.run=TestWindowsJobObjectSupervisorHelper")
	command.Env = append(
		[]string{
			jobObjectHelperVariable + "=supervisor-kill",
			"YUCP_GUEST_AGENT_GRANDCHILD_PID_PATH=" + pidPath,
		},
		minimalTestEnvironment()...,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Job Object helper failed: %v, output=%q", err, output)
	}
	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.ParseUint(strings.TrimSpace(string(pidBytes)), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	process, err := windows.OpenProcess(
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		uint32(pid),
	)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return
	}
	if err != nil {
		t.Fatalf("open surviving grandchild: %v", err)
	}
	defer windows.CloseHandle(process)
	waitResult, err := windows.WaitForSingleObject(process, 5_000)
	if err != nil {
		t.Fatalf("wait for surviving grandchild termination: %v", err)
	}
	if waitResult != windows.WAIT_OBJECT_0 {
		t.Fatalf("surviving grandchild was not killed, wait result=%d", waitResult)
	}
}

func minimalTestEnvironment() []string {
	names := []string{"COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"}
	result := make([]string, 0, len(names))
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			result = append(result, name+"="+value)
		}
	}
	return result
}
