; EDM Windows NSIS Installer Hooks
; Generates Native Messaging manifests at install time with valid paths and extension IDs,
; writes HKCU registry keys for Chrome, Edge, Brave, and Firefox, and cleanly removes everything on uninstall.

!macro NSIS_HOOK_PREINSTALL
  ; Terminate any running EDM processes to prevent locked binaries during install/reinstall
  nsExec::Exec 'taskkill /F /IM EDM.exe /T'
  nsExec::Exec 'taskkill /F /IM edm-desktop-app.exe /T'
  nsExec::Exec 'taskkill /F /IM edm-nmh.exe /T'
  Sleep 300
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\edm-nmh.exe" 0 +3
    StrCpy $0 "$INSTDIR\edm-nmh.exe"
    Goto found_nmh
  IfFileExists "$INSTDIR\resources\edm-nmh.exe" 0 +3
    CopyFiles /SILENT "$INSTDIR\resources\edm-nmh.exe" "$INSTDIR\edm-nmh.exe"
    StrCpy $0 "$INSTDIR\edm-nmh.exe"
    Goto found_nmh
  IfFileExists "$INSTDIR\resources\target\release\edm-nmh.exe" 0 +3
    CopyFiles /SILENT "$INSTDIR\resources\target\release\edm-nmh.exe" "$INSTDIR\edm-nmh.exe"
    StrCpy $0 "$INSTDIR\edm-nmh.exe"
    Goto found_nmh
  IfFileExists "$INSTDIR\_up_\_up_\_up_\target\release\edm-nmh.exe" 0 +3
    CopyFiles /SILENT "$INSTDIR\_up_\_up_\_up_\target\release\edm-nmh.exe" "$INSTDIR\edm-nmh.exe"
    StrCpy $0 "$INSTDIR\edm-nmh.exe"
    Goto found_nmh
  StrCpy $0 "$INSTDIR\edm-nmh.exe"

found_nmh:
  ; Ensure target directories exist
  CreateDirectory "$LOCALAPPDATA\EDM"
  CreateDirectory "$APPDATA\EDM"
  CopyFiles /SILENT "$0" "$LOCALAPPDATA\EDM\edm-nmh.exe"

  ; Ensure WebView2Loader.dll is co-located next to the executables in $INSTDIR
  IfFileExists "$INSTDIR\WebView2Loader.dll" done_webview2 0
  IfFileExists "$INSTDIR\_up_\_up_\_up_\target\release\WebView2Loader.dll" 0 +3
    CopyFiles /SILENT "$INSTDIR\_up_\_up_\_up_\target\release\WebView2Loader.dll" "$INSTDIR\WebView2Loader.dll"
    Goto done_webview2
  IfFileExists "$INSTDIR\resources\WebView2Loader.dll" 0 +3
    CopyFiles /SILENT "$INSTDIR\resources\WebView2Loader.dll" "$INSTDIR\WebView2Loader.dll"
    Goto done_webview2
  IfFileExists "$INSTDIR\resources\target\release\WebView2Loader.dll" 0 +3
    CopyFiles /SILENT "$INSTDIR\resources\target\release\WebView2Loader.dll" "$INSTDIR\WebView2Loader.dll"
    Goto done_webview2
done_webview2:

  ; Ensure BOTH edm-desktop-app.exe and EDM.exe exist in $INSTDIR for seamless compatibility
  IfFileExists "$INSTDIR\edm-desktop-app.exe" 0 +3
    IfFileExists "$INSTDIR\EDM.exe" +2 0
      CopyFiles /SILENT "$INSTDIR\edm-desktop-app.exe" "$INSTDIR\EDM.exe"

  IfFileExists "$INSTDIR\EDM.exe" 0 +3
    IfFileExists "$INSTDIR\edm-desktop-app.exe" +2 0
      CopyFiles /SILENT "$INSTDIR\EDM.exe" "$INSTDIR\edm-desktop-app.exe"

  ; Mirror WebView2Loader.dll into %LOCALAPPDATA%\EDM if INSTDIR is different
  IfFileExists "$INSTDIR\WebView2Loader.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\WebView2Loader.dll" "$LOCALAPPDATA\EDM\WebView2Loader.dll"

  ; 1. Write Chromium manifest in $INSTDIR and $LOCALAPPDATA\EDM with relative path
  FileOpen $1 "$INSTDIR\com.edm.nmh.json" w
  FileWrite $1 '{\r$\n'
  FileWrite $1 '  "name": "com.edm.nmh",\r$\n'
  FileWrite $1 '  "description": "EDM Native Messaging Host for Edge, Chrome and Brave",\r$\n'
  FileWrite $1 '  "path": ".\\\\edm-nmh.exe",\r$\n'
  FileWrite $1 '  "type": "stdio",\r$\n'
  FileWrite $1 '  "allowed_origins": [\r$\n'
  FileWrite $1 '    "chrome-extension://ginpdimhcdbojbhemgjedghkeolbcmgj/",\r$\n'
  FileWrite $1 '    "chrome-extension://ebdcbpghekpbgjiclaclbgmdnimeheci/",\r$\n'
  FileWrite $1 '    "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",\r$\n'
  FileWrite $1 '    "chrome-extension://cphjfljhggknldkppchfobogknclmblg/"\r$\n'
  FileWrite $1 '  ]\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

  FileOpen $1 "$LOCALAPPDATA\EDM\com.edm.nmh.json" w
  FileWrite $1 '{\r$\n'
  FileWrite $1 '  "name": "com.edm.nmh",\r$\n'
  FileWrite $1 '  "description": "EDM Native Messaging Host for Edge, Chrome and Brave",\r$\n'
  FileWrite $1 '  "path": ".\\\\edm-nmh.exe",\r$\n'
  FileWrite $1 '  "type": "stdio",\r$\n'
  FileWrite $1 '  "allowed_origins": [\r$\n'
  FileWrite $1 '    "chrome-extension://ginpdimhcdbojbhemgjedghkeolbcmgj/",\r$\n'
  FileWrite $1 '    "chrome-extension://ebdcbpghekpbgjiclaclbgmdnimeheci/",\r$\n'
  FileWrite $1 '    "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/",\r$\n'
  FileWrite $1 '    "chrome-extension://cphjfljhggknldkppchfobogknclmblg/"\r$\n'
  FileWrite $1 '  ]\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

  ; 2. Write Firefox manifest in $INSTDIR and $LOCALAPPDATA\EDM
  FileOpen $1 "$INSTDIR\com.edm.nmh.firefox.json" w
  FileWrite $1 '{\r$\n'
  FileWrite $1 '  "name": "com.edm.nmh",\r$\n'
  FileWrite $1 '  "description": "EDM Native Messaging Host for Mozilla Firefox",\r$\n'
  FileWrite $1 '  "path": ".\\\\edm-nmh.exe",\r$\n'
  FileWrite $1 '  "type": "stdio",\r$\n'
  FileWrite $1 '  "allowed_extensions": [\r$\n'
  FileWrite $1 '    "edm@suvesh.dev"\r$\n'
  FileWrite $1 '  ]\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

  FileOpen $1 "$LOCALAPPDATA\EDM\com.edm.nmh.firefox.json" w
  FileWrite $1 '{\r$\n'
  FileWrite $1 '  "name": "com.edm.nmh",\r$\n'
  FileWrite $1 '  "description": "EDM Native Messaging Host for Mozilla Firefox",\r$\n'
  FileWrite $1 '  "path": ".\\\\edm-nmh.exe",\r$\n'
  FileWrite $1 '  "type": "stdio",\r$\n'
  FileWrite $1 '  "allowed_extensions": [\r$\n'
  FileWrite $1 '    "edm@suvesh.dev"\r$\n'
  FileWrite $1 '  ]\r$\n'
  FileWrite $1 '}\r$\n'
  FileClose $1

  ; 3. Register Native Messaging Hosts in HKCU
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh" "" "$LOCALAPPDATA\EDM\com.edm.nmh.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh" "" "$LOCALAPPDATA\EDM\com.edm.nmh.json"
  WriteRegStr HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh" "" "$LOCALAPPDATA\EDM\com.edm.nmh.json"
  WriteRegStr HKCU "Software\Mozilla\NativeMessagingHosts\com.edm.nmh" "" "$LOCALAPPDATA\EDM\com.edm.nmh.firefox.json"

  WriteRegStr HKCU "Software\EDM" "InstallDir" "$INSTDIR"
  IfFileExists "$INSTDIR\EDM.exe" 0 +3
    WriteRegStr HKCU "Software\EDM" "AppPath" "$INSTDIR\EDM.exe"
    Goto done_apppath
  IfFileExists "$INSTDIR\edm-desktop-app.exe" 0 +3
    WriteRegStr HKCU "Software\EDM" "AppPath" "$INSTDIR\edm-desktop-app.exe"
    Goto done_apppath
  WriteRegStr HKCU "Software\EDM" "AppPath" "$INSTDIR\EDM.exe"
done_apppath:
  WriteRegStr HKCU "Software\EDM" "NmhPath" "$LOCALAPPDATA\EDM\edm-nmh.exe"
  WriteRegStr HKCU "Software\EDM" "Version" "0.0.8"

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

  ; Provision extension files into %LOCALAPPDATA%\EDM\extension and %APPDATA%\EDM\extension
  CreateDirectory "$LOCALAPPDATA\EDM\extension"
  CreateDirectory "$APPDATA\EDM\extension"
  IfFileExists "$INSTDIR\resources\extension\*.*" 0 +3
    CopyFiles /SILENT "$INSTDIR\resources\extension\*.*" "$LOCALAPPDATA\EDM\extension"
    CopyFiles /SILENT "$INSTDIR\resources\extension\*.*" "$APPDATA\EDM\extension"
  IfFileExists "$INSTDIR\extension\*.*" 0 +3
    CopyFiles /SILENT "$INSTDIR\extension\*.*" "$LOCALAPPDATA\EDM\extension"
    CopyFiles /SILENT "$INSTDIR\extension\*.*" "$APPDATA\EDM\extension"
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
