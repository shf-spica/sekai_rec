@echo off
REM Windows サービス（NSSM 等）から起動するときの補助。
REM NSSM の Application にこの bat のフルパス、Startup directory にリポジトリのルート（このファイルの親の親）を指定。
REM ログで失敗原因を追えるようにする。Python は PATH にある想定（または下の python をフルパスに変更）。

setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"

set PYTHONUNBUFFERED=1
if not defined PRSK_OCR_USE_GPU set PRSK_OCR_USE_GPU=0

set "LOG=%ROOT%\prsk_ocr_service_boot.log"
echo ========== %date% %time% ========== >> "%LOG%"
echo cd=%cd% >> "%LOG%"
where python >> "%LOG%" 2>&1
python -c "import sys; print(sys.version); print(sys.executable)" >> "%LOG%" 2>&1

python -c "import server; print('import server: OK')" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo import server FAILED >> "%LOG%"
  exit /b 1
)

echo starting uvicorn... >> "%LOG%"
python -u -m uvicorn server:app --host 0.0.0.0 --port 8000 >> "%LOG%" 2>&1
echo uvicorn exited errorlevel=%errorlevel% >> "%LOG%"
exit /b %errorlevel%
