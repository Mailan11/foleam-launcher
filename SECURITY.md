# Foleam Launcher 1.2.2: установка и данные

## Что изменилось

- В 1.2.2 отключено создание лишней копии installer.exe в папке foleam-launcher-minecraft-updater. Это была копия текущего установщика, а не скачанный сторонний установщик. Файлы старых версий автоматически не удаляются.
- В настройках указаны источник обновлений, папка сохранения, проверка SHA-256 и необходимость подтверждения установки. Там же доступна ссылка на исходники.
- GUID установки сохранён: он детерминированно связан с appId ru.mailan1.foleam и нужен для совместимости обновления и удаления. Это не случайное имя для маскировки.

- Токены доступа и обновления аккаунтов в accounts.json шифруются через Electron safeStorage (Windows DPAPI). Старые записи переносятся при успешном чтении. Если расшифровка не удалась, чтение завершается ошибкой, а не пустым списком аккаунтов.
- Установщик проверяет запущенный лаунчер через штатный NSIS-плагин, без PowerShell и принудительного завершения приложения.
- Не включается вспомогательный elevate.exe; автоматический запрос повышения прав отключён.
- Открытие внешних ссылок через IPC разрешено только главному окну и только для HTTP/HTTPS без встроенных паролей.

## Куда идут запросы

- Microsoft, Xbox Live, api.minecraftservices.com: вход Microsoft, обновление токенов, профиль и смена скина. Пароль Microsoft не сохраняется в accounts.json.
- Mojang (piston-meta.mojang.com, resources.download.minecraft.net и адреса из манифестов): версии Minecraft и игровые файлы.
- Adoptium: загрузка Java; Forge, NeoForge, Fabric: выбранные загрузчики модов.
- api.modrinth.com и адреса загрузок Modrinth: поиск и установка выбранных модов.
- mc-heads.net: запрос изображения по игровому нику. Сервис видит ник и IP-адрес.
- mailan1.ru: вход Mailan1, каталог стримов, активность игры для функции стримов, проверка обновлений и загрузка установщика.
- Выбранные видеоплатформы и настроенный для стримов прокси: просмотр трансляций. Прокси не делает пользователя анонимным перед его владельцем.
- Ely.by: только при использовании соответствующего входа; GitHub: загрузка authlib-injector для поддерживаемого способа авторизации.

Это обзор кода, не результат полного перехвата сетевого трафика. Подключения игры и сторонних модов определяются также самими модами и игровыми серверами.

## Что означает журнал установки 1.2.0

Папка LocalAppData/Programs является обычным местом установки для текущего пользователя. GUID в реестре нужен для обновления и удаления. В версиях 1.2.0 и 1.2.1 сборщик electron-builder копировал тот же установщик в LocalAppData/foleam-launcher-minecraft-updater/installer.exe; это не доказательство загрузки посторонней программы. В 1.2.2 это копирование отключено.

В версии сборщика, использованной для 1.2.0, PowerShell проверяет доступность Get-CimInstance, политику выполнения и наличие запущенного приложения. Файлы __PSScriptPolicyTest создаются самим PowerShell для проверки политик. В представленном журнале нет командных строк и сетевых адресов: по нему нельзя ни доказать утечку, ни гарантировать полную безопасность.

## Ограничения

Установщик пока не подписан сертификатом Authenticode, поэтому Windows может показывать неизвестного издателя. Не отключайте антивирус или SmartScreen. Скачивайте только с https://mailan1.ru/foleam.html и сравнивайте SHA-256 с опубликованной контрольной суммой. Проверка хеша защищает от повреждения файла, но не заменяет подпись издателя и не защищает от компрометации самого сервера публикации.

Шифрование токенов защищает файл на диске, но не от вредоносного процесса под тем же пользователем Windows. Локальное окно лаунчера пока использует Node.js; полное разделение привилегий интерфейса требует отдельного обновления. Внешние окна входа и стримов изолированы и не получают Node.js.

Папки миров и сборок не удаляются этим обновлением. После переноса зашифрованных аккаунтов на другой компьютер может потребоваться повторный вход. После миграции токенов не используйте старую версию лаунчера с тем же профилем.

Источники: https://www.electron.build/v26/docs/nsis/ ; https://www.electronjs.org/docs/latest/api/safe-storage ; https://learn.microsoft.com/en-us/powershell/scripting/security/app-control/application-control
# Security changes in 1.2.3

- The installer uses `HKCU\Software\Foleam Launcher` for its settings. Existing per-user installations are discovered through the previous key. Known legacy values are removed only after a successful installation at the same location. The Windows uninstall entry retains its stable identifier for upgrade compatibility; an identifier is not evidence of malware.
- The duplicate updater `installer.exe` cache remains disabled. Old cached files are not silently removed from users' computers.
- The installer has explicit desktop/Start-menu shortcut choices and uses the Foleam icon for setup and uninstall. No additional runtime installers are bundled.
- Every launcher IPC handler validates the originating window and top-level frame. The local UI has a Content Security Policy that blocks inline/remote scripts, embedded frames and plugins. Permission requests and webview attachment are denied in the launcher session.
- This is incremental hardening, not a complete security audit. The legacy local renderer still uses Node integration and requires a future isolated preload migration. Downloaded Java and mods execute code: use trusted sources. SHA-256 checks do not protect against compromise of both the update manifest and its hosting server. The installer does not yet have a trusted publisher certificate.
- A browser may show its own generic download icon before or after download; the application cannot force browser download-list branding.

# Foleam Voice in 1.3.0

The optional voice addon is downloaded only on request. Its SHA-256 and size are pinned in the installed launcher's catalog, checked before saving and before opening. It is rendered from the verified package in a separate sandboxed BrowserWindow with Node integration disabled and context isolation enabled. Microphone access is limited to this window and requires confirmation. Camera, file access, additional windows and navigation are not granted. Disabling, removing or closing the addon stops its window and audio session.

The addon uses authenticated Mailan1 sessions and WebRTC. Anyone with an invitation code and an eligible Mailan1 account can join until the room is full or closed. Share links only with intended participants. Peer-to-peer voice can reveal participants' network addresses to each other; TURN availability depends on hosting configuration. No audio is recorded by the room server. Public website invitations use the hosted client; the installed addon uses pinned local client assets.

