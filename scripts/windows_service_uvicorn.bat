@echo off
REM NSSM を直接使う場合の例（この bat を使わないとき）:
REM   Application  : C:\Path\to\venv\Scripts\python.exe  （フルパス）
REM   Arguments    : -m uvicorn server:app --host 0.0.0.0 --port 8000
REM   Startup dir  : server.py があるフォルダ（リポジトリルート）
REM 1067 のときは「python が違う」「カレントが違う」「ポート占有」が多い。
REM 1064（制御要求処理中に例外）: WinSW 本体か子プロセス起動の失敗。対処の手順:
REM   1) イベントビューア → Windows ログ → アプリケーション（WinSW / .NET のエラーとスタック）
REM   2) 管理者 CMD で start.bat を手動実行（サービスと同じユーザーならより近い）
REM   3) WinSW の <executable> を cmd.exe、<arguments>/c "...\start.bat"</arguments> にすると bat 起因の例外を避けやすい
REM   4) サービスが「グループ MSA 等の制限付きアカウント」のとき WinSW と相性問題あり → Local System で試す
REM
REM 必ず %TEMP% に最初からログを書く（リポジトリに書けない・cd 失敗でも残る）
setlocal
set "T=%TEMP%\prsk_ocr_service_boot.log"
echo.>>"%T%"
echo ========== BOOT %date% %time% ==========>>"%T%"
echo dp0=%~dp0>>"%T%"

REM リポジトリルートを正規パスに（scripts\ の親）
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
echo ROOT=%ROOT%>>"%T%"
if not exist "%ROOT%\server.py" (
  echo ERROR: server.py not under ROOT. Edit bat or move repo.>>"%T%"
  exit /b 1
)

set "LOG=%ROOT%\prsk_ocr_service_boot.log"
echo ----- copy to repo log ----->>"%T%"
type "%T%">>"%LOG%" 2>nul
if errorlevel 1 echo WARN: cannot write "%LOG%" check permissions>>"%T%"

cd /d "%ROOT%"
if errorlevel 1 (
  echo ERROR: cd failed>>"%T%"
  exit /b 1
)
echo cd OK:>>"%T%"
echo %cd%>>"%T%"
echo %cd%>>"%LOG%" 2>nul

set PYTHONUNBUFFERED=1
REM server.py の FileHandler 先（未設定だとリポジトリ直下 prsk_ocr.log → git / ロックで困りやすい）
if not defined PRSK_OCR_LOG_FILE set "PRSK_OCR_LOG_FILE=%TEMP%\prsk_ocr.log"
if not defined PRSK_OCR_USE_GPU set PRSK_OCR_USE_GPU=0

echo ----- python on PATH ----->>"%T%"
where py>>"%T%" 2>&1
where python>>"%T%" 2>&1

set "PYCMD=py -3"
%PYCMD% -c "import sys">nul 2>>"%T%"
if errorlevel 1 set "PYCMD=python"
%PYCMD% -c "import sys">nul 2>>"%T%"
if errorlevel 1 (
  echo ERROR: neither "py -3" nor "python" runs. Install Python or fix PATH.>>"%T%"
  exit /b 1
)
echo Using: %PYCMD%>>"%T%"
echo Using: %PYCMD%>>"%LOG%" 2>nul

echo ----- import server ----->>"%T%"
%PYCMD% -u -c "import server; print('import server: OK')">>"%T%" 2>&1
if errorlevel 1 (
  echo import server FAILED>>"%T%"
  type "%T%">>"%LOG%" 2>nul
  exit /b 1
)

echo ----- uvicorn ----->>"%T%"
REM SSE 等の長寿命接続でも、停止後にこの秒数で強制終了（次回起動でポート占有を防ぐ）
%PYCMD% -u -m uvicorn server:app --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 15>>"%T%" 2>&1
echo uvicorn exit=%errorlevel%>>"%T%"
type "%T%">>"%LOG%" 2>nul
exit /b %errorlevel%
