@echo off
cd /d C:\Users\황교득\car-alert\car-alert

:: 로그 폴더 만들기
if not exist logs mkdir logs

:: 실행 로그 남기기 (날짜별 파일)
set LOGFILE=logs\car_alert.log
echo [%date% %time%] starting... >> %LOGFILE%

:: node 실행 (표준출력/에러를 로그로)
node app.js run >> %LOGFILE% 2>&1
