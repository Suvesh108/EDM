; EDM Windows NSIS Installer Hooks
; Generates Native Messaging manifests at install time with the real path and real extension IDs,
; writes HKCU registry keys for Chrome, Edge, Brave, and Firefox, and cleans them up on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\edm-nmh.exe" 0 +3
    StrCpy $0 "$INSTDIR\edm-nmh.exe"
    Goto found_nmh
  IfFileExists "$INSTDIR\resources\edm-nmh.exe" 0 +3
    CopyFiles /SILENT "$INSTDIR\resources\edm-nmh.exe" "$INSTDIR\edm-nmh.exe"
    StrCpy $0 "$INSTDIR\edm-nmh.exe"
    Goto found_nmh
  StrCpy $0 "$INSTDIR\edm-nmh.exe"

found_nmh:
  FileOpen $1 "$INSTDIR\com.edm.nmh.json" w
  FileWrite $1 '{\r$\n'
  FileWrite $1 '  "name": "com.edm.nmh",\r$\n'
  FileWrite $1 '  "description": "EDM Native Messaging Host for Edge, Chrome and Brave",\r$\n'
  FileWrite $1 '  "path": "edm-nmh.exe",\r$\n'
  FileWrite $1 '  "type": "stdio",\r$\n'
  FileWrite $1 '  "allowed_origins": [\r$\n'
  FileWrite $1 '    "chrome-extension://ginpdimhcdbojbhemgjedghkeolbcmgj/",\r$\n'
  FileWrite $1 '    "chrome-extension://ebdcbpghekpbgjiclaclbgmdnimeheci/",\r$\n'
  FileWrite $1 '    "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",\r$\n'
  FileWrite $1 '    "chrome-extension://cphjfljhggknldkppchfobogknclmblg/"\r$\n'
  FileWrite $1 '  ]\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

  FileOpen $1 "$INSTDIR\com.edm.nmh.firefox.json" w
  FileWrite $1 '{\r$\n'
  FileWrite $1 '  "name": "com.edm.nmh",\r$\n'
  FileWrite $1 '  "description": "EDM Native Messaging Host for Mozilla Firefox",\r$\n'
  FileWrite $1 '  "path": "edm-nmh.exe",\r$\n'
  FileWrite $1 '  "type": "stdio",\r$\n'
  FileWrite $1 '  "allowed_extensions": [\r$\n'
  FileWrite $1 '    "edm@suvesh.dev"\r$\n'
  FileWrite $1 '  ]\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh" "" "$INSTDIR\com.edm.nmh.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh" "" "$INSTDIR\com.edm.nmh.json"
  WriteRegStr HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh" "" "$INSTDIR\com.edm.nmh.json"
  WriteRegStr HKCU "Software\Mozilla\NativeMessagingHosts\com.edm.nmh" "" "$INSTDIR\com.edm.nmh.firefox.json"

  WriteRegStr HKCU "Software\EDM" "InstallDir" "$INSTDIR"
  IfFileExists "$INSTDIR\EDM.exe" 0 +3
    WriteRegStr HKCU "Software\EDM" "AppPath" "$INSTDIR\EDM.exe"
    Goto done_apppath
  IfFileExists "$INSTDIR\edm-desktop-app.exe" 0 +3
    WriteRegStr HKCU "Software\EDM" "AppPath" "$INSTDIR\edm-desktop-app.exe"
    Goto done_apppath
  WriteRegStr HKCU "Software\EDM" "AppPath" "$INSTDIR\EDM.exe"
done_apppath:
  WriteRegStr HKCU "Software\EDM" "NmhPath" "$INSTDIR\edm-nmh.exe"
  WriteRegStr HKCU "Software\EDM" "Version" "0.0.7"

  WriteRegStr HKCU "Software\Classes\edm" "" "URL:EDM Protocol"
  WriteRegStr HKCU "Software\Classes\edm" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\edm\DefaultIcon" "" "$INSTDIR\EDM.exe,0"
  IfFileExists "$INSTDIR\EDM.exe" 0 +3
    WriteRegStr HKCU "Software\Classes\edm\shell\open\command" "" '"$INSTDIR\EDM.exe" "%1"'
    Goto done_cmd
  IfFileExists "$INSTDIR\edm-desktop-app.exe" 0 +3
    WriteRegStr HKCU "Software\Classes\edm\shell\open\command" "" '"$INSTDIR\edm-desktop-app.exe" "%1"'
    Goto done_cmd
  WriteRegStr HKCU "Software\Classes\edm\shell\open\command" "" '"$INSTDIR\EDM.exe" "%1"'
done_cmd:

  ; Create user-only extension folder %LOCALAPPDATA%\EDM\extension and copy extension if present
  CreateDirectory "$LOCALAPPDATA\EDM\extension"
  IfFileExists "$INSTDIR\extension\*.*" 0 +2
    CopyFiles /SILENT "$INSTDIR\extension\*.*" "$LOCALAPPDATA\EDM\extension"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 1. Terminate running EDM processes to release locks on .exe, .dll, and .db files
  nsExec::Exec 'taskkill /F /IM EDM.exe /T'
  nsExec::Exec 'taskkill /F /IM edm-desktop-app.exe /T'
  nsExec::Exec 'taskkill /F /IM edm-nmh.exe /T'
  Sleep 500

  ; 2. Delete all browser Native Messaging Host registry keys
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh"
  DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\com.edm.nmh"

  ; 3. Delete EDM app, autostart, and protocol handler registry keys
  DeleteRegKey HKCU "Software\Classes\edm"
  DeleteRegKey HKCU "Software\EDM"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "EDM"

  ; 4. Delete generated runtime manifests, logs, and database files in INSTDIR
  Delete /REBOOTOK "$INSTDIR\com.edm.nmh.json"
  Delete /REBOOTOK "$INSTDIR\com.edm.nmh.firefox.json"
  Delete /REBOOTOK "$INSTDIR\edm-nmh.exe"
  Delete /REBOOTOK "$INSTDIR\store.db"
  Delete /REBOOTOK "$INSTDIR\store.db-shm"
  Delete /REBOOTOK "$INSTDIR\store.db-wal"
  Delete /REBOOTOK "$INSTDIR\last_wake.json"
  Delete /REBOOTOK "$INSTDIR\extension.crx"
  Delete /REBOOTOK "$INSTDIR\extension.pem"

  ; 5. Delete runtime subfolders in INSTDIR
  RMDir /r "$INSTDIR\extension"
  RMDir /r "$INSTDIR\tools"
  RMDir /r "$INSTDIR\_up_"
  RMDir /r "$INSTDIR\logs"

  ; 6. Completely remove user data and cache directories
  RMDir /r "$LOCALAPPDATA\EDM"
  RMDir /r "$APPDATA\EDM"
  RMDir /r "$LOCALAPPDATA\com.edm.desktop"
  RMDir /r "$LOCALAPPDATA\EDM_desktop"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Final sweep to ensure absolutely zero leftover files or directories remain
  RMDir /r "$LOCALAPPDATA\EDM"
  RMDir /r "$APPDATA\EDM"
  RMDir /r "$LOCALAPPDATA\com.edm.desktop"
  RMDir /r "$INSTDIR"
!macroend
