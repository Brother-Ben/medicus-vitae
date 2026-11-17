Medicus Vitae is a personal MCAT study app: read your books, make flashcards, review them with FSRS, track the questions you miss, and see where you're weak. Everything stays on your own computer, and every installation starts empty.

## Download

| System | File |
|---|---|
| **Windows 10 or 11** (64-bit) | `Medicus-Vitae-@VERSION@-windows-x64.zip` |
| **Mac with Apple Silicon** (M1 or later, macOS 13.5+) | `Medicus-Vitae-@VERSION@-mac-arm64.dmg` |

### Windows

1. Unzip, and move the **Medicus Vitae** folder somewhere permanent (for example Documents). Your data is kept inside it.
2. Double-click **Medicus Vitae.exe**. If Windows says "Windows protected your PC", click **More info › Run anyway** (the app isn't signed with a paid certificate).
3. Your browser opens at http://localhost:8080. Create your account. Optional: **Add shortcuts.cmd** puts the app in the Start menu and on the Desktop.

### Mac

1. Open the `.dmg` and drag **Medicus Vitae** onto **Applications**.
2. The app isn't signed with a paid Apple certificate, so allow it once. In Terminal, run:
   ```
   xattr -dr com.apple.quarantine "/Applications/Medicus Vitae.app"
   ```
   (or open it, click **Done**, then **System Settings › Privacy & Security › Open Anyway**).
3. Open **Medicus Vitae**. Your browser opens at http://localhost:8080. Create your account. To stop it, press **Quit** in the sidebar.

Updating keeps your data: on Windows, copy the new files over the old folder (keep `data`); on a Mac, replace the app (data is in `~/Library/Application Support/Medicus Vitae`).

See the [README](https://github.com/Brother-Ben/medicus-vitae#readme) for features, AI setup, phones over Tailscale, and Docker.
