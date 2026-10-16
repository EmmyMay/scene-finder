; Compile on Windows with scripts/create-installers.mjs after packaging the app.
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppSource
  #error AppSource is required
#endif
#ifndef OutputDirectory
  #error OutputDirectory is required
#endif

[Setup]
AppId={{DDDE3B05-A357-4D65-877F-21D3BB48D778}
AppName=Scene Finder
AppVersion={#AppVersion}
AppPublisher=EmmyMay
AppPublisherURL=https://github.com/EmmyMay/scene-finder
AppSupportURL=https://github.com/EmmyMay/scene-finder/issues
AppUpdatesURL=https://github.com/EmmyMay/scene-finder/releases
DefaultDirName={localappdata}\Programs\Scene Finder
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDirectory}
OutputBaseFilename=Scene-Finder-{#AppVersion}-windows-x64-setup
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\Scene Finder.exe
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
InfoAfterFile=install-notes.txt

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Scene Finder"; Filename: "{app}\Scene Finder.exe"
Name: "{userdesktop}\Scene Finder"; Filename: "{app}\Scene Finder.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Scene Finder.exe"; Description: "Open Scene Finder"; Flags: nowait postinstall skipifsilent
