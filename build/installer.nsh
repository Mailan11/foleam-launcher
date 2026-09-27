!define INSTALL_REGISTRY_KEY "Software\Foleam Launcher"
!define FOLEAM_LEGACY_KEY "Software\adb3ebbf-4cdc-54cb-b677-3f812cfaaf27"
!include "nsDialogs.nsh"

!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetRegView 64
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R0 == ""
      ReadRegStr $R0 HKCU "${FOLEAM_LEGACY_KEY}" InstallLocation
      ${If} $R0 != ""
      ${AndIf} ${FileExists} "$R0\Foleam Launcher.exe"
        ; Keep the old install directory when upgrading to the readable key.
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$R0"
        ReadRegStr $R1 HKCU "${FOLEAM_LEGACY_KEY}" ShortcutName
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName "$R1"
        ReadRegStr $R1 HKCU "${FOLEAM_LEGACY_KEY}" MenuDirectory
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" MenuDirectory "$R1"
        ReadRegStr $R1 HKCU "${FOLEAM_LEGACY_KEY}" KeepShortcuts
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" KeepShortcuts "$R1"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customPageAfterChangeDir
  Var FoleamDesktop
  Var FoleamMenu
  Var FoleamDesktopState
  Var FoleamMenuState
  Var FoleamOptionsShown
  Page custom FoleamOptionsCreate FoleamOptionsLeave
  Function FoleamOptionsCreate
    !insertmacro MUI_HEADER_TEXT "Компоненты Foleam Launcher" "Выберите ярлыки для текущего пользователя."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Foleam Launcher (обязательно)$\r$\nУстановка без прав администратора."
    Pop $0
    ${NSD_CreateCheckbox} 0 34u 100% 14u "Ярлык на рабочем столе"
    Pop $FoleamDesktop
    ${NSD_CreateCheckbox} 0 56u 100% 14u "Ярлык в меню «Пуск»"
    Pop $FoleamMenu
    ${If} $FoleamOptionsShown != 1
      StrCpy $FoleamDesktopState ${BST_CHECKED}
      StrCpy $FoleamMenuState ${BST_CHECKED}
    ${EndIf}
    ${NSD_SetState} $FoleamDesktop $FoleamDesktopState
    ${NSD_SetState} $FoleamMenu $FoleamMenuState
    ${NSD_CreateLabel} 0 86u 100% 48u "Сторонние программы не устанавливаются. Minecraft, Java и моды загружаются отдельно при использовании лаунчера. Миры и аккаунты сохраняются при обновлении."
    Pop $0
    nsDialogs::Show
  FunctionEnd
  Function FoleamOptionsLeave
    ${NSD_GetState} $FoleamDesktop $FoleamDesktopState
    ${NSD_GetState} $FoleamMenu $FoleamMenuState
    StrCpy $FoleamOptionsShown 1
  FunctionEnd
!macroend

!macro customInstall
  ${If} $FoleamOptionsShown == 1
    ${If} $FoleamDesktopState != ${BST_CHECKED}
      Delete "$newDesktopLink"
    ${EndIf}
    ${If} $FoleamMenuState != ${BST_CHECKED}
      Delete "$newStartMenuLink"
      StrCpy $launchLink "$appExe"
    ${EndIf}
  ${EndIf}
  ; Remove only known old installer values after a successful upgrade.
  ReadRegStr $R0 HKCU "${FOLEAM_LEGACY_KEY}" InstallLocation
  ${If} $R0 == "$INSTDIR"
    DeleteRegValue HKCU "${FOLEAM_LEGACY_KEY}" InstallLocation
    DeleteRegValue HKCU "${FOLEAM_LEGACY_KEY}" ShortcutName
    DeleteRegValue HKCU "${FOLEAM_LEGACY_KEY}" MenuDirectory
    DeleteRegValue HKCU "${FOLEAM_LEGACY_KEY}" KeepShortcuts
    DeleteRegKey /ifempty HKCU "${FOLEAM_LEGACY_KEY}"
  ${EndIf}
!macroend

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
