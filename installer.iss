#define MyAppName "Vortex Downloader"
#define MyAppVersion "0.6.9"
#define MyAppPublisher "Suvesh"
#define MyAppURL "https://github.com/Suvesh108/vortex"
#define MyAppExeName "VortexDownloader.exe"

[Setup]
AppId={{D37D0B2E-5A24-4A3C-9C3E-F43A1B309A72}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=release
OutputBaseFilename=VortexDownloader-Setup-v0.6.9
SetupIconFile=vortex.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\VortexDownloader.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "vortex.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\vortex.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\vortex.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Registry]
; Register vortex:// custom URL protocol for browser extensions
Root: HKCU; Subkey: "Software\Classes\vortex"; ValueType: string; ValueName: ""; ValueData: "URL:Vortex Downloader Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\vortex"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\vortex\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\vortex.ico"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\vortex\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey
