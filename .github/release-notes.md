Duckument is a free app for Windows and Linux for signing PDFs, filling in forms, adding text and shapes, editing the text in a document, and turning a PDF into a Word document (.docx) to edit in Word or DuckWriter.

## Install on Windows

1. Download **Duckument-Setup.exe** below. That one file is all you need.
2. Run it. Windows may say "Windows protected your PC", because the installer isn't code-signed. Click **More info**, then **Run anyway**.
3. Open Duckument from the Start menu, or right-click a PDF and choose **Open with**.

It needs Windows 10 or 11. Nothing is uploaded anywhere: your documents stay on your computer. Duckument only goes online to check for updates, which it then offers to install.

**Coming from Duckument 1.0.0?** Download and run the installer above once; from this version on, Duckument updates itself.

## Install on Linux

1. Download **Duckument-x86_64.AppImage** below.
2. Make it runnable and start it: `chmod +x Duckument-x86_64.AppImage && ./Duckument-x86_64.AppImage`. On Arch, AppImages need `sudo pacman -S fuse2` once.
3. It updates itself, like the Windows version. On Debian or Ubuntu you can install **Duckument-amd64.deb** instead (it doesn't update itself).

Optional extras:

- Reading text in scans: `sudo pacman -S tesseract tesseract-data-eng` (and your language, such as `tesseract-data-nor`).
- Fonts for PDFs that use Arial or Times New Roman: `sudo pacman -S ttf-liberation`.

The "Source code" files below are added by GitHub automatically; you don't need them.
