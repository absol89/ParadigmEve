; Scale the stock Modern UI wizard and its dialog-unit image controls together.
; This keeps electron-builder's assisted installer logic intact while giving the
; ParadigmEve portrait/header artwork materially more screen real estate.
SetFont "Segoe UI" 10

; electron-builder's ${isUpdated} flag covers updater-driven replacement, but a user can also run
; a newer/same-version assisted installer directly over an existing ParadigmEve install. Remember
; that pre-install fact before the old executable is replaced so the first relaunched process owns
; Companion/browser recovery instead of briefly starting ordinary crash recovery and then being
; signalled a second time by the external self-reinstall controller.
!ifndef BUILD_UNINSTALLER
Var ParadigmEveHadExistingInstall
; Agents and scripts also run the silent installer from inside ParadigmEve. CHECK_APP_RUNNING then
; force-closes the very app that started it, and nobody is left to bring the replacement back.
; Remember whether this exact installed executable was running before that close; customInstall
; restores only an app the installer itself closed.
Var ParadigmEveWasRunning
Var ParadigmEveLaunchAfterInstall
!endif

!macro grantSandboxReadAccess
  ClearErrors
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q' $0
  ${If} ${Errors}
    StrCpy $0 2
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 2
    Abort "Windows could not set the folder access needed to start ParadigmEve safely."
  ${EndIf}
!macroend

!macro customInit
  StrCpy $ParadigmEveHadExistingInstall "0"
  StrCpy $ParadigmEveWasRunning "0"
  # initMultiUser has resolved a previous custom install path by this point.
  # Repair an existing install before an update removes its runnable version.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $ParadigmEveHadExistingInstall "1"
    !insertmacro grantSandboxReadAccess
    ${If} ${Silent}
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -ieq '$INSTDIR\${APP_EXECUTABLE_FILENAME}'}).Count -gt 0) { exit 0 } else { exit 1 }"`
      Pop $0
      ${If} $0 == 0
        StrCpy $ParadigmEveWasRunning "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  # Chromium's sandbox needs read and execute access through the app tree.
  # Add one inheritable grant to the final directory without resetting other ACLs.
  !insertmacro grantSandboxReadAccess

  # Persist the exact installer-selected executable path outside the install tree. The external
  # self-reinstall controller survives ParadigmEve shutdown and must relaunch this exact location;
  # assuming LOCALAPPDATA\Programs would strand users who chose a custom directory.
  CreateDirectory "$APPDATA\ParadigmEve"
  ClearErrors
  FileOpen $2 "$APPDATA\ParadigmEve\install-path.txt" w
  ${If} ${Errors}
    Abort "Windows could not record the ParadigmEve installation path."
  ${EndIf}
  FileWrite $2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}$\r$\n"
  FileClose $2

  # The assisted installer used to strand recovery on its final Finish page: by then
  # ParadigmEve had already exited, so losing the external controller left nobody to
  # press Finish or launch the new build. Once files, registry data and shortcuts are
  # installed, an interactive install can safely launch immediately and let the empty
  # customFinishPage below end the wizard without another user action.
  #
  # A silent install launches only when it closed a running ParadigmEve itself. The private
  # updater's quit-and-install handoff (--updated) already decided whether to relaunch, and
  # --force-run is launched by electron-builder's own silent path right after this macro.
  StrCpy $ParadigmEveLaunchAfterInstall "0"
  ${IfNot} ${Silent}
    StrCpy $ParadigmEveLaunchAfterInstall "1"
    # The assisted InstFiles page itself exposes a Close button after successful install even
    # when the stock MUI finish page is removed. Auto-close that page too; otherwise the app is
    # already back but the installer process can remain stranded on "Installation Complete".
    SetAutoClose true
  ${ElseIf} $ParadigmEveWasRunning == "1"
  ${AndIfNot} ${isUpdated}
  ${AndIfNot} ${isForceRun}
    StrCpy $ParadigmEveLaunchAfterInstall "1"
  ${EndIf}
  ${If} $ParadigmEveLaunchAfterInstall == "1"
    # Launching after Finish is presentation, not consent to publish the MCP tunnel. A fresh
    # install therefore starts with no arguments and follows ui.autoConnect=false. An interactive
    # update still restores the owned browser/session, but connection state follows the user's
    # saved auto-connect preference once the replacement process loads config.
    ${if} ${isUpdated}
      StrCpy $1 "--updated --recover-companion-browser"
    ${elseIf} $ParadigmEveHadExistingInstall == "1"
      StrCpy $1 "--recover-companion-browser"
    ${else}
      StrCpy $1 ""
    ${endif}
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  ${EndIf}
!macroend

; electron-builder inserts this macro instead of its stock MUI finish page. It is intentionally
; empty: customInstall has already launched ParadigmEve and SetAutoClose closes the InstFiles
; completion page, so there is no final interactive boundary that can strand a self-update.
!macro customFinishPage
!macroend
