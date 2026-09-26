!macro customCheckAppRunning
  ; Native process check: never invoke a shell or forcibly close a running game.
  foleam_check_running:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Close Foleam Launcher before continuing. Your running game will not be stopped automatically." /SD IDCANCEL IDRETRY foleam_check_running
      Quit
    ${EndIf}
!macroend
