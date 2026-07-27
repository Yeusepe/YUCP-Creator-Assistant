//go:build windows

package broker

import (
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func LaunchURLForClient(identity ClientIdentity, raw string) error {
	if identity.ProcessID == 0 ||
		identity.UserSID == "" ||
		!validBrowserURL(raw) {
		return fmt.Errorf("package broker browser launch request is invalid")
	}
	currentToken := windows.GetCurrentProcessToken()
	currentUser, err := currentToken.GetTokenUser()
	if err == nil &&
		currentUser != nil &&
		currentUser.User.Sid != nil &&
		currentUser.User.Sid.String() == identity.UserSID {
		return openExternalURL(raw)
	}

	process, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		identity.ProcessID,
	)
	if err != nil {
		return fmt.Errorf("open package broker client process: %w", err)
	}
	defer windows.CloseHandle(process)
	var processToken windows.Token
	if err := windows.OpenProcessToken(
		process,
		windows.TOKEN_ASSIGN_PRIMARY|
			windows.TOKEN_DUPLICATE|
			windows.TOKEN_QUERY,
		&processToken,
	); err != nil {
		return fmt.Errorf("open package broker client token: %w", err)
	}
	defer processToken.Close()
	processUser, err := processToken.GetTokenUser()
	if err != nil ||
		processUser == nil ||
		processUser.User.Sid == nil ||
		processUser.User.Sid.String() != identity.UserSID {
		return fmt.Errorf("package broker client process identity changed")
	}
	var primaryToken windows.Token
	if err := windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&primaryToken,
	); err != nil {
		return fmt.Errorf("duplicate package broker client token: %w", err)
	}
	defer primaryToken.Close()
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		return fmt.Errorf("locate Windows system directory: %w", err)
	}
	executable := filepath.Join(systemDirectory, "rundll32.exe")
	commandLine := windows.ComposeCommandLine([]string{
		executable,
		"url.dll,FileProtocolHandler",
		raw,
	})
	executablePointer, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return fmt.Errorf("encode browser launcher path: %w", err)
	}
	commandLinePointer, err := windows.UTF16PtrFromString(commandLine)
	if err != nil {
		return fmt.Errorf("encode browser launcher command: %w", err)
	}
	desktop, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return fmt.Errorf("encode interactive desktop: %w", err)
	}
	startup := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var processInfo windows.ProcessInformation
	if err := windows.CreateProcessAsUser(
		primaryToken,
		executablePointer,
		commandLinePointer,
		nil,
		nil,
		false,
		windows.CREATE_UNICODE_ENVIRONMENT,
		nil,
		nil,
		&startup,
		&processInfo,
	); err != nil {
		return fmt.Errorf("launch browser for package broker client: %w", err)
	}
	defer windows.CloseHandle(processInfo.Process)
	defer windows.CloseHandle(processInfo.Thread)
	return nil
}
