//go:build windows

package guestagent

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maximumDriverOutputBytes = 1024 * 1024

type boundedSensitiveBuffer struct {
	data     []byte
	overflow bool
}

func (buffer *boundedSensitiveBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := maximumDriverOutputBytes - len(buffer.data)
	if len(value) > remaining {
		buffer.overflow = true
		value = value[:max(remaining, 0)]
	}
	buffer.data = append(buffer.data, value...)
	return originalLength, nil
}

func (buffer *boundedSensitiveBuffer) clear() {
	for index := range buffer.data {
		buffer.data[index] = 0
	}
	buffer.data = nil
}

type jobObjectBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

type WindowsJobObjectSupervisor struct {
	childExitTimeout time.Duration
	job              windows.Handle
	killOnJobClose   bool
	mu               sync.Mutex
	used             bool
}

func NewWindowsJobObjectSupervisor() (*WindowsJobObjectSupervisor, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create lifecycle Job Object: %w", err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags =
		windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
			windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("configure lifecycle Job Object: %w", err)
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("assign lifecycle agent to Job Object: %w", err)
	}
	observed := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	if err := windows.QueryInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&observed)),
		uint32(unsafe.Sizeof(observed)),
		nil,
	); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("inspect lifecycle Job Object: %w", err)
	}
	killOnJobClose :=
		observed.BasicLimitInformation.LimitFlags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
	if !killOnJobClose {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("lifecycle Job Object lacks kill-on-close containment")
	}
	// Keep this handle open until the agent process exits. Closing the last handle
	// terminates every remaining child because the agent is also a job member.
	return &WindowsJobObjectSupervisor{
		childExitTimeout: 10 * time.Second,
		job:              job,
		killOnJobClose:   true,
	}, nil
}

func (supervisor *WindowsJobObjectSupervisor) activeProcesses() (uint32, error) {
	accounting := jobObjectBasicAccountingInformation{}
	if err := windows.QueryInformationJobObject(
		supervisor.job,
		windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&accounting)),
		uint32(unsafe.Sizeof(accounting)),
		nil,
	); err != nil {
		return 0, err
	}
	return accounting.ActiveProcesses, nil
}

func (supervisor *WindowsJobObjectSupervisor) Run(
	ctx context.Context,
	command Command,
) (SupervisionResult, error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.used {
		return SupervisionResult{}, fmt.Errorf("lifecycle Job Object supervisor is single-use")
	}
	supervisor.used = true

	child := exec.CommandContext(ctx, command.Executable, command.Arguments...)
	child.Env = append([]string(nil), command.Environment...)
	child.Stdin = nil
	stdout := &boundedSensitiveBuffer{}
	stderr := &boundedSensitiveBuffer{}
	defer stdout.clear()
	defer stderr.clear()
	child.Stdout = stdout
	child.Stderr = stderr
	child.SysProcAttr = &windows.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
	if err := child.Start(); err != nil {
		return SupervisionResult{}, fmt.Errorf("start lifecycle driver: %w", err)
	}
	waitErr := child.Wait()
	exitCode := child.ProcessState.ExitCode()
	if waitErr != nil && exitCode < 0 {
		return SupervisionResult{}, fmt.Errorf("wait for lifecycle driver: %w", waitErr)
	}
	if stdout.overflow || stderr.overflow {
		return SupervisionResult{}, fmt.Errorf("lifecycle driver output exceeded the bounded limit")
	}
	if containsSensitiveValue(stdout.data, command.SensitiveValues) ||
		containsSensitiveValue(stderr.data, command.SensitiveValues) {
		return SupervisionResult{}, fmt.Errorf("lifecycle driver output contained sensitive data")
	}

	deadline := time.Now().Add(supervisor.childExitTimeout)
	allChildrenExited := false
	for time.Now().Before(deadline) {
		active, err := supervisor.activeProcesses()
		if err != nil {
			return SupervisionResult{}, fmt.Errorf("inspect lifecycle Job Object children: %w", err)
		}
		// The guest agent itself remains in the Job Object until process exit.
		if active == 1 {
			allChildrenExited = true
			break
		}
		select {
		case <-ctx.Done():
			return SupervisionResult{
				AllChildrenExited: false,
				ExitCode:          exitCode,
				KillOnJobClose:    supervisor.killOnJobClose,
			}, nil
		case <-time.After(10 * time.Millisecond):
		}
	}
	return SupervisionResult{
		AllChildrenExited: allChildrenExited,
		ExitCode:          exitCode,
		KillOnJobClose:    supervisor.killOnJobClose,
	}, nil
}
