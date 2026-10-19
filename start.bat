@echo off
rem Starts a local web server for Visual Harmonics and opens it in your browser.
rem (Sampled instruments can't load when index.html is opened directly as a file.)
cd /d "%~dp0"
start "" cmd /c "timeout /t 1 >nul & start http://localhost:8000/"
echo Visual Harmonics is running at http://localhost:8000/  - close this window to stop it.
python -m http.server 8000
