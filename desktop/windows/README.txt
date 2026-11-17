Medicus Vitae @VERSION@ for Windows
====================================

A personal MCAT study app: read your books, make flashcards, review them with
FSRS, track the questions you miss, and see where you're weak.

START
-----
1. Move this whole "Medicus Vitae" folder somewhere permanent, such as your
   Documents folder (your study data is kept inside it, in "data").
2. Double-click "Medicus Vitae.exe".
   Windows may say "Windows protected your PC", because the app isn't signed
   by a paid certificate: click "More info", then "Run anyway". It asks once.
3. Your browser opens at http://localhost:8080 and a teal "M" appears in the
   tray (by the clock). Create your account; everything starts empty.

Optional: double-click "Add shortcuts.cmd" to put Medicus Vitae in the Start
menu and on the Desktop. Right-click the tray icon for Start with Windows,
the data folder, the log, Restart and Quit.

YOUR DATA
---------
Everything you add stays on this computer, in the "data" folder here. Back it
up with Settings > Data > Export everything, or by copying "data" while the
app is closed.

UPDATING
--------
Quit Medicus (tray icon > Quit Medicus), download the new version, and copy
its files over this folder, keeping "data". Or move "data" into the new
folder.

SETTINGS
--------
Copy ".env.example" to ".env" in this folder to change the port and other
settings (each one is explained in the file).

Help, source code and new versions: @REPO_URL@
License: MIT (see LICENSE.txt).
